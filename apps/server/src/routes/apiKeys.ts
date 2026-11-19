import { Router } from "express";
import { z } from "zod";
import { SCOPES } from "../auth/apiKeyScopes.js";
import { MAX_LIFETIME_DAYS, DEFAULT_LIFETIME_DAYS, createKey, keyDto, keyInput, revokeKey } from "../auth/apiKeys.js";
import { requireAuth, requireRole, requireSession } from "../auth/middleware.js";
import { requireCodeFor } from "../auth/twoFactor.js";
import { HttpError } from "../lib/errors.js";
import { pagination } from "../lib/http.js";
import { ApiKeyModel, ApiKeyUsageModel } from "../models/apiKey.js";
import { UserModel } from "../models/user.js";

/**
 * Keys for other applications to use the API. Administrators only, and only from a signed-in session: a key can never create
 * or revoke keys, so a leaked one cannot mint another.
 */
export const apiKeysRouter = Router();
apiKeysRouter.use(requireAuth, requireSession, requireRole("admin"));

apiKeysRouter.get("/scopes", (_req, res) => {
  res.json({ items: SCOPES, maxLifetimeDays: MAX_LIFETIME_DAYS, defaultLifetimeDays: DEFAULT_LIFETIME_DAYS });
});

apiKeysRouter.get("/", async (_req, res) => {
  const keys = await ApiKeyModel.find().sort({ createdAt: -1 }).limit(200);
  res.json({ items: keys.map(keyDto) });
});

/**
 * Creating a key hands out access that outlives the session, so it asks for a fresh authenticator code. The key is in the
 * answer once; only its hash is kept.
 */
apiKeysRouter.post("/", async (req, res) => {
  const { twoFactorCode, ...input } = keyInput.extend({ twoFactorCode: z.string().trim().max(8).optional() }).parse(req.body);
  const user = await UserModel.findById(req.user!.id);
  if (!user) throw new HttpError(401, "Not authenticated");
  await requireCodeFor(user, "create an API key", twoFactorCode);
  const { key, token } = await createKey(keyInput.parse(input), req.user!);
  res.status(201).json({ ...keyDto(key), key: token });
});

apiKeysRouter.delete("/:id", async (req, res) => {
  res.json(keyDto(await revokeKey(String(req.params.id), req.user!)));
});

apiKeysRouter.get("/:id/usage", async (req, res) => {
  const { page, limit } = pagination.parse(req.query);
  const filter = { keyId: String(req.params.id) };
  const [items, total] = await Promise.all([ApiKeyUsageModel.find(filter).sort({ at: -1 }).skip((page - 1) * limit).limit(limit), ApiKeyUsageModel.countDocuments(filter)]);
  res.json({ items: items.map((u) => ({ at: u.at, method: u.method, path: u.path, status: u.status, ip: u.ip ?? null })), total, page, limit });
});
