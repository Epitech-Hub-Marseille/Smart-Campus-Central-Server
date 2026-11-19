import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { resolveExternalUser } from "../auth/identity.js";
import { requireAuth } from "../auth/middleware.js";
import { azureProvider } from "../auth/providers/azure.js";
import { verifyCredentials } from "../auth/providers/local.js";
import { completeReset, requestReset } from "../auth/passwordReset.js";
import { beginSetup, completeChallenge, disable, enable, hasTwoFactor, regenerateRecoveryCodes, startChallenge } from "../auth/twoFactor.js";
import { endSession, sessionPolicy, startSession } from "../auth/sessions.js";
import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import { passwordSchema } from "../lib/http.js";
import { UserModel, toPublicUser } from "../models/user.js";

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: config.LOGIN_RATE_LIMIT,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many login attempts, try again later" },
});

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(256),
});

/** Which login methods the frontend should offer. */
authRouter.get("/providers", (_req, res) => {
  res.json({ local: true, azure: azureProvider.enabled });
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user, session: sessionPolicy });
});

authRouter.post("/login", loginLimiter, async (req, res) => {
  const { email, password } = credentials.parse(req.body);
  const user = await verifyCredentials(email, password);
  if (!user) throw new HttpError(401, "Invalid email or password");

  // With a second factor on, the password is only the first half: no session yet, just a token to come back with the code.
  if (hasTwoFactor(user)) {
    res.json({ twoFactorRequired: true, challenge: await startChallenge(user) });
    return;
  }
  await startSession(req, res, user, "local");
  res.json({ user: toPublicUser(user), session: sessionPolicy });
});

const secondFactorLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: config.LOGIN_RATE_LIMIT * 2,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many attempts, try again later" },
});

const codeInput = z.object({ code: z.string().trim().min(6).max(8) });

/** The second half of the sign-in: the challenge from the password step and a code (or a recovery code). */
authRouter.post("/login/2fa", secondFactorLimiter, async (req, res) => {
  const input = z
    .object({ challenge: z.string().min(20).max(200), code: z.string().trim().min(6).max(8).optional(), recoveryCode: z.string().trim().min(8).max(20).optional() })
    .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), "send a code or a recovery code")
    .parse(req.body);
  const user = await completeChallenge(input.challenge, input);
  await startSession(req, res, user, "local");
  res.json({ user: toPublicUser(user), session: sessionPolicy });
});

// ---- Managing one's own second factor --------------------------------------------------------

const me = async (req: { user?: { id: string } }) => {
  const user = await UserModel.findById(req.user!.id);
  if (!user) throw new HttpError(401, "Not authenticated");
  return user;
};

authRouter.get("/2fa", requireAuth, async (req, res) => {
  const user = await me(req);
  res.json({ enabled: hasTwoFactor(user), required: toPublicUser(user).twoFactor.required, enabledAt: user.twoFactor?.enabledAt ?? null, recoveryCodesLeft: user.twoFactor?.recoveryHashes?.length ?? 0 });
});

authRouter.post("/2fa/setup", requireAuth, secondFactorLimiter, async (req, res) => {
  res.status(201).json(await beginSetup(await me(req)));
});

authRouter.post("/2fa/enable", requireAuth, secondFactorLimiter, async (req, res) => {
  const { code } = codeInput.parse(req.body);
  res.json({ recoveryCodes: await enable(await me(req), code) });
});

authRouter.post("/2fa/disable", requireAuth, secondFactorLimiter, async (req, res) => {
  const { code } = codeInput.parse(req.body);
  await disable(await me(req), code);
  res.status(204).end();
});

authRouter.post("/2fa/recovery-codes", requireAuth, secondFactorLimiter, async (req, res) => {
  const { code } = codeInput.parse(req.body);
  res.json({ recoveryCodes: await regenerateRecoveryCodes(await me(req), code) });
});

const resetLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests, try again later" },
});

/** Always answers 204, whether or not the email exists. The mail is sent in the background. */
authRouter.post("/forgot-password", resetLimiter, (req, res) => {
  const { email } = z.object({ email: z.string().email() }).parse(req.body);
  requestReset(email).catch((err) => console.error("Password reset failed", err));
  res.status(204).end();
});

authRouter.post("/reset-password", resetLimiter, async (req, res) => {
  const { token, password } = z
    .object({ token: z.string().min(10).max(200), password: passwordSchema })
    .parse(req.body);
  await completeReset(token, password);
  res.status(204).end();
});

authRouter.post("/logout", async (req, res) => {
  await endSession(req, res);
  res.status(204).end();
});

// --- Microsoft Azure SSO (scaffold, see auth/providers/azure.ts) -------------------------

authRouter.get("/azure/login", async (req, res) => {
  res.redirect(await azureProvider.getAuthorizationUrl(req, res));
});

authRouter.get("/azure/callback", async (req, res) => {
  const profile = await azureProvider.handleCallback(req, res);
  const user = await resolveExternalUser(profile, { autoProvision: config.AZURE_AUTO_PROVISION });
  await startSession(req, res, user, "azure");
  res.redirect(config.APP_URL);
});
