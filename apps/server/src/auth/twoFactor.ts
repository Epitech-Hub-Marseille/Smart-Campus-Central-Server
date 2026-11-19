import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { recordAudit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { open, seal } from "../lib/secretBox.js";
import { generateSecret, otpauthUri, verifyCode } from "../lib/totp.js";
import { LoginChallengeModel } from "../models/loginChallenge.js";
import { UserModel, toPublicUser, type UserDoc } from "../models/user.js";
import { revokeUserSessions } from "./sessions.js";

/** Wrong codes in a row before the account stops accepting any for a while. */
export const MAX_FAILURES = 5;
export const LOCK_MINUTES = 15;
const CHALLENGE_MINUTES = 5;
const CHALLENGE_ATTEMPTS = 5;
const RECOVERY_CODES = 10;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const equalHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

/** Ten characters from an alphabet without look-alikes: about 50 bits, written down once and used once. */
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newRecoveryCode(): string {
  const bytes = randomBytes(10);
  const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join("");
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}
const normalizeRecovery = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

const actorOf = (user: UserDoc) => ({ id: user.id, name: user.name });

export const hasTwoFactor = (user: UserDoc) => Boolean(user.twoFactor?.enabled && user.twoFactor.secret);

// ---- Setting up --------------------------------------------------------------------------------

/** Starts (or restarts) the setup: a new secret that only counts once a code made from it is proven. */
export async function beginSetup(user: UserDoc): Promise<{ secret: string; uri: string }> {
  if (hasTwoFactor(user)) throw new HttpError(409, "Two-factor authentication is already on. Turn it off first to set it up again.");
  const secret = generateSecret();
  user.set("twoFactor.pendingSecret", seal(secret));
  await user.save();
  return { secret, uri: otpauthUri(secret, user.email ?? user.name, config.TWO_FACTOR_ISSUER) };
}

/** Turns it on once the person shows a code from the new secret. Returns the recovery codes, shown this one time. */
export async function enable(user: UserDoc, code: string): Promise<string[]> {
  const pending = user.twoFactor?.pendingSecret;
  if (!pending) throw new HttpError(409, "Start the setup first");
  assertNotLocked(user);
  const checked = verifyCode(open(pending), code, Date.now());
  if (!checked.ok) {
    await registerFailure(user);
    throw new HttpError(400, "That code is not right. Check the time of your phone and try the next code.");
  }
  const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
  user.set("twoFactor", {
    enabled: true,
    enabledAt: new Date(),
    secret: pending,
    lastUsedStep: checked.step,
    recoveryHashes: codes.map((c) => sha(normalizeRecovery(c))),
    failures: 0,
  });
  await user.save();
  await recordAudit(actorOf(user), "auth.2fa.enable", { type: "user", id: user.id });
  return codes;
}

// ---- Checking a code ---------------------------------------------------------------------------

function assertNotLocked(user: UserDoc) {
  const until = user.twoFactor?.lockedUntil;
  if (until && until.getTime() > Date.now()) {
    const minutes = Math.ceil((until.getTime() - Date.now()) / 60_000);
    throw new HttpError(429, `Too many wrong codes. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, "two_factor_locked");
  }
}

async function registerFailure(user: UserDoc) {
  const failures = (user.twoFactor?.failures ?? 0) + 1;
  const lock = failures >= MAX_FAILURES;
  // Atomic: two guesses at the same moment both count. Locking starts the count again, so it is a set, not an increment.
  await UserModel.updateOne(
    { _id: user._id },
    lock ? { $set: { "twoFactor.failures": 0, "twoFactor.lockedUntil": new Date(Date.now() + LOCK_MINUTES * 60_000) } } : { $inc: { "twoFactor.failures": 1 } },
  );
  if (lock) await recordAudit(actorOf(user), "auth.2fa.locked", { type: "user", id: user.id }, { minutes: LOCK_MINUTES });
}

/**
 * Checks an authenticator code. A code works once (its step becomes the floor), wrong ones are counted, and after
 * MAX_FAILURES the account refuses codes for LOCK_MINUTES, whichever door they come through.
 */
export async function checkCode(user: UserDoc, code: string): Promise<boolean> {
  if (!hasTwoFactor(user)) return false;
  assertNotLocked(user);
  const checked = verifyCode(open(user.twoFactor!.secret!), code, Date.now(), user.twoFactor!.lastUsedStep ?? -1);
  if (!checked.ok) {
    await registerFailure(user);
    return false;
  }
  // Only moves forward, and only if nobody used a later step meanwhile: the same code cannot win a race against itself.
  const updated = await UserModel.updateOne({ _id: user._id, "twoFactor.lastUsedStep": { $lt: checked.step } }, { $set: { "twoFactor.lastUsedStep": checked.step, "twoFactor.failures": 0 } });
  return updated.modifiedCount === 1;
}

/** A recovery code, for someone who lost the phone. It works once and is removed. */
export async function checkRecoveryCode(user: UserDoc, code: string): Promise<boolean> {
  if (!hasTwoFactor(user)) return false;
  assertNotLocked(user);
  const hash = sha(normalizeRecovery(code));
  const match = (user.twoFactor!.recoveryHashes ?? []).find((h) => equalHex(h, hash));
  if (!match) {
    await registerFailure(user);
    return false;
  }
  const done = await UserModel.updateOne({ _id: user._id, "twoFactor.recoveryHashes": match }, { $pull: { "twoFactor.recoveryHashes": match }, $set: { "twoFactor.failures": 0 } });
  if (done.modifiedCount === 1) await recordAudit(actorOf(user), "auth.2fa.recovery-used", { type: "user", id: user.id }, { left: (user.twoFactor!.recoveryHashes?.length ?? 1) - 1 });
  return done.modifiedCount === 1;
}

// ---- Login -------------------------------------------------------------------------------------

/** After the password: hands the client a token to come back with the code. It is not a session. */
export async function startChallenge(user: UserDoc): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await LoginChallengeModel.create({ tokenHash: sha(token), userId: user._id, expiresAt: new Date(Date.now() + CHALLENGE_MINUTES * 60_000) });
  return token;
}

/** Exchanges a challenge and a code for the user, who may then be given a session. */
export async function completeChallenge(token: string, input: { code?: string; recoveryCode?: string }): Promise<UserDoc> {
  const challenge = await LoginChallengeModel.findOneAndUpdate({ tokenHash: sha(token), expiresAt: { $gt: new Date() } }, { $inc: { attempts: 1 } }, { new: true });
  if (!challenge) throw new HttpError(401, "This sign-in expired. Enter your password again.", "challenge_expired");
  if (challenge.attempts > CHALLENGE_ATTEMPTS) {
    await challenge.deleteOne();
    throw new HttpError(401, "Too many wrong codes for this sign-in. Enter your password again.", "challenge_expired");
  }
  const user = await UserModel.findById(challenge.userId);
  if (!user || user.disabled || !hasTwoFactor(user)) throw new HttpError(401, "This sign-in expired. Enter your password again.", "challenge_expired");

  const ok = input.code ? await checkCode(user, input.code) : input.recoveryCode ? await checkRecoveryCode(user, input.recoveryCode) : false;
  if (!ok) throw new HttpError(401, "That code is not right.", "two_factor_invalid");
  await challenge.deleteOne();
  return user;
}

// ---- Managing ----------------------------------------------------------------------------------

/** A code from the phone is needed to change anything about the second factor, so a stolen session cannot weaken it. */
async function assertCode(user: UserDoc, code: string) {
  if (!(await checkCode(user, code))) throw new HttpError(401, "That code is not right.", "two_factor_invalid");
}

export async function disable(user: UserDoc, code: string): Promise<void> {
  if (!hasTwoFactor(user)) return;
  if (toPublicUser(user).twoFactor.required) throw new HttpError(403, "Administrators must keep two-factor authentication on.");
  await assertCode(user, code);
  user.set("twoFactor", undefined);
  await user.save();
  await recordAudit(actorOf(user), "auth.2fa.disable", { type: "user", id: user.id });
}

export async function regenerateRecoveryCodes(user: UserDoc, code: string): Promise<string[]> {
  if (!hasTwoFactor(user)) throw new HttpError(409, "Two-factor authentication is not on");
  await assertCode(user, code);
  const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
  await UserModel.updateOne({ _id: user._id }, { $set: { "twoFactor.recoveryHashes": codes.map((c) => sha(normalizeRecovery(c))) } });
  await recordAudit(actorOf(user), "auth.2fa.recovery-regenerated", { type: "user", id: user.id });
  return codes;
}

/** Another administrator removes someone's second factor (lost phone and recovery codes). They sign in again and set it up anew. */
export async function resetByAdmin(actor: { id: string; name: string }, target: UserDoc): Promise<void> {
  if (actor.id === target.id) throw new HttpError(400, "Ask another administrator to reset your two-factor authentication.");
  if (!target.twoFactor?.enabled && !target.twoFactor?.pendingSecret) throw new HttpError(409, "This person has no two-factor authentication to reset");
  target.set("twoFactor", undefined);
  await target.save();
  // Whoever held the old second factor, or a session started with it, is signed out.
  await revokeUserSessions(target._id);
  await LoginChallengeModel.deleteMany({ userId: target._id });
  await recordAudit(actor, "auth.2fa.reset", { type: "user", id: target.id }, { by: "administrator" });
}

// ---- Using it for an action --------------------------------------------------------------------

/**
 * A fresh code for a sensitive action (starting an emergency): whoever holds a session but not the phone cannot do it.
 * A person without two-factor cannot do it at all, which is the point of requiring it.
 */
export async function requireCodeFor(user: UserDoc, action: string, code: string | undefined): Promise<void> {
  // 403, not 401: the person is signed in. The console reads a 401 as "the session ended" and signs them out.
  if (!hasTwoFactor(user)) throw new HttpError(403, `Turn on two-factor authentication to ${action}.`, "two_factor_setup_required");
  if (!code) throw new HttpError(403, `Enter a code from your authenticator app to ${action}.`, "two_factor_required");
  if (!(await checkCode(user, code))) {
    await recordAudit(actorOf(user), "auth.2fa.action-refused", { type: "user", id: user.id }, { action });
    throw new HttpError(403, "That code is not right.", "two_factor_invalid");
  }
}
