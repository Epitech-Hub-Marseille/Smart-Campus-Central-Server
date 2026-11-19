import type { NextFunction, Request, Response } from "express";
import { config, isConsoleOrigin } from "../config.js";
import { HttpError } from "../lib/errors.js";
import { toPublicUser, type PublicUser, type Role } from "../models/user.js";
import { authenticateKey, publicUserOfKey, recordUse } from "./apiKeys.js";
import { scopeFor } from "./apiKeyScopes.js";
import { resolveSession } from "./sessions.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: PublicUser;
      /** Set when the request was made with an API key rather than a person's session. */
      apiKey?: { keyId: string; name: string };
    }
  }
}

/** Calls per key per minute. A runaway integration should not be able to starve the console. */
const KEY_CALLS_PER_MINUTE = 300;
const windows = new Map<string, { start: number; calls: number }>();
const allowKeyCall = (keyId: string, now = Date.now()) => {
  const w = windows.get(keyId);
  if (!w || now - w.start >= 60_000) {
    windows.set(keyId, { start: now, calls: 1 });
    return true;
  }
  return ++w.calls <= KEY_CALLS_PER_MINUTE;
};

/**
 * Populates req.user from an API key (`Authorization: Bearer scak_…`) or from the session cookie.
 *
 * A key never falls back to the cookie, and is checked against the list of endpoints keys may reach before anything else
 * runs: an endpoint not in that list is closed to every key, whatever its scopes.
 */
export async function attachUser(req: Request, res: Response, next: NextFunction) {
  const header = req.get("authorization");
  if (header) {
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) throw new HttpError(401, "Invalid API key", "invalid_api_key");
    const key = await authenticateKey(match[1]!);
    // Logged from here on, refusals included: what an application tried and was denied is what an administrator wants to see.
    // The path is read now: routers rewrite `req.path` as they hand the request down.
    const path = req.path;
    res.on("finish", () => void recordUse(key.keyId, { method: req.method, path, status: res.statusCode, ip: req.ip }));
    const scope = scopeFor(req.method, path);
    if (!scope) throw new HttpError(403, "API keys cannot use this endpoint", "api_key_forbidden");
    if (!key.scopes.includes(scope)) throw new HttpError(403, `This API key does not have the "${scope}" scope`, "api_key_scope");
    if (!allowKeyCall(key.keyId)) throw new HttpError(429, "Too many requests for this API key");
    req.user = publicUserOfKey(key);
    req.apiKey = { keyId: key.keyId, name: key.name };
    return next();
  }
  const token = req.cookies?.[config.SESSION_COOKIE_NAME];
  if (typeof token === "string") {
    const user = await resolveSession(token);
    if (user) req.user = toPublicUser(user);
  }
  next();
}

/** For endpoints that must be used by a person in the console, never by a key (managing keys, for one). */
export function requireSession(req: Request, _res: Response, next: NextFunction) {
  if (req.apiKey) throw new HttpError(403, "API keys cannot use this endpoint", "api_key_forbidden");
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) throw new HttpError(401, "Not authenticated");
  next();
}

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw new HttpError(401, "Not authenticated");
    if (!roles.includes(req.user.role)) throw new HttpError(403, "Forbidden");
    next();
  };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence in depth on top of SameSite=Lax: state-changing requests that carry an
 * Origin header must come from the app itself.
 */
export function sameOriginGuard(req: Request, _res: Response, next: NextFunction) {
  const origin = req.get("origin");
  if (!SAFE_METHODS.has(req.method) && origin && !isConsoleOrigin(origin)) {
    throw new HttpError(403, "Cross-origin request blocked");
  }
  next();
}

/**
 * Administrators must have two-factor authentication before they use anything but the pages to set it up. Enforced here,
 * not in the console: a console that forgot to ask would otherwise leave the account protected by a password alone.
 */
export function enforceAdminTwoFactor(req: Request, _res: Response, next: NextFunction) {
  const user = req.user;
  const exempt = req.originalUrl.startsWith("/api/auth");
  if (user && !exempt && user.twoFactor.required && !user.twoFactor.enabled) {
    throw new HttpError(403, "Administrators must set up two-factor authentication first.", "two_factor_setup_required");
  }
  next();
}
