import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { recordAudit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { ApiKeyModel, ApiKeyUsageModel } from "../models/apiKey.js";
import type { PublicUser } from "../models/user.js";
import { SCOPE_IDS, type ScopeId } from "./apiKeyScopes.js";

/** Keys live at most this long. A key that never expires is a key nobody remembers to remove. */
export const MAX_LIFETIME_DAYS = 365;
export const DEFAULT_LIFETIME_DAYS = 90;
const KEY_PREFIX = "scak";
const KEY_SHAPE = new RegExp(`^${KEY_PREFIX}_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$`);

type Actor = Pick<PublicUser, "id" | "name">;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

export const keyInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z.array(z.enum(SCOPE_IDS)).min(1).max(SCOPE_IDS.length).transform((s) => [...new Set(s)]),
    expiresInDays: z.number().int().min(1).max(MAX_LIFETIME_DAYS).default(DEFAULT_LIFETIME_DAYS),
  })
  .strict();

/** `scak_<id>_<secret>`: the id finds the record, the secret is checked against its hash. Shown once. */
export async function createKey(input: z.infer<typeof keyInput>, actor: Actor) {
  const keyId = randomBytes(8).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const token = `${KEY_PREFIX}_${keyId}_${secret}`;
  const key = await ApiKeyModel.create({
    keyId,
    name: input.name,
    secretHash: sha(secret),
    prefix: token.slice(0, 13),
    scopes: input.scopes,
    expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000),
    createdById: actor.id,
    createdByName: actor.name,
  });
  await recordAudit(actor, "api-key.create", { type: "api-key", id: keyId }, { name: input.name, scopes: input.scopes, expiresInDays: input.expiresInDays });
  return { key, token };
}

export async function revokeKey(keyId: string, actor: Actor) {
  const key = await ApiKeyModel.findOneAndUpdate({ keyId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date(), revokedByName: actor.name } }, { new: true });
  if (!key) throw new HttpError(404, "Key not found, or already revoked");
  await recordAudit(actor, "api-key.revoke", { type: "api-key", id: keyId }, { name: key.name });
  return key;
}

export interface Authenticated {
  keyId: string;
  name: string;
  scopes: ScopeId[];
}

/** Checks a presented key. Every failure answers the same, so a caller learns nothing about which keys exist. */
export async function authenticateKey(token: string): Promise<Authenticated> {
  const bad = () => new HttpError(401, "Invalid API key", "invalid_api_key");
  // Matched by shape, not split on "_": the secret is base64url and may contain underscores itself.
  const parsed = KEY_SHAPE.exec(token);
  if (!parsed) throw bad();
  const [, keyId, secret] = parsed as unknown as [string, string, string];
  const key = await ApiKeyModel.findOne({ keyId });
  // Compared even when the key is unknown, so the time taken does not say whether the id exists.
  const ok = same(sha(secret), key?.secretHash ?? sha("x"));
  if (!key || !ok || key.revokedAt || key.expiresAt.getTime() <= Date.now()) throw bad();
  return { keyId, name: key.name, scopes: key.scopes as ScopeId[] };
}

/** The user the rest of the app sees for a request made with a key: named after the key, so audit entries say who it was. */
export const publicUserOfKey = (k: Authenticated): PublicUser => ({
  id: `api-key:${k.keyId}`,
  email: null,
  name: `API key: ${k.name}`,
  // Role checks on the endpoints a key may reach are about "may change campus data"; the scope check already ran.
  role: "operator",
  groups: ["operator"],
  twoFactor: { enabled: true, required: false },
});

export async function recordUse(keyId: string, entry: { method: string; path: string; status: number; ip?: string }) {
  try {
    await Promise.all([
      ApiKeyUsageModel.create({ keyId, ...entry }),
      ApiKeyModel.updateOne({ keyId }, { $set: { lastUsedAt: new Date(), lastUsedIp: entry.ip }, $inc: { useCount: 1 } }),
    ]);
  } catch (err) {
    console.error("api key usage write failed", err instanceof Error ? err.message : err);
  }
}

export const keyDto = (k: InstanceType<typeof ApiKeyModel>) => ({
  id: k.keyId,
  name: k.name,
  prefix: k.prefix,
  scopes: k.scopes,
  expiresAt: k.expiresAt,
  state: k.revokedAt ? "revoked" : k.expiresAt.getTime() <= Date.now() ? "expired" : "active",
  revokedAt: k.revokedAt ?? null,
  revokedBy: k.revokedByName ?? null,
  createdBy: k.createdByName,
  createdAt: k.createdAt,
  lastUsedAt: k.lastUsedAt ?? null,
  lastUsedIp: k.lastUsedIp ?? null,
  useCount: k.useCount,
});
