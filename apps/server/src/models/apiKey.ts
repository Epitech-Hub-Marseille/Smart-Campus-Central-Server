import { Schema, model } from "mongoose";

/**
 * A key for another application to use the official API. Only the hash of the secret is stored: the key is shown once, when
 * it is created, and cannot be shown again. `scopes` are the whole of what it may do; there is no "all".
 */
const apiKeySchema = new Schema(
  {
    // The public half of the key, also its name in logs and in the Authorization header.
    keyId: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true },
    // SHA-256 of the secret half (256 random bits, so a fast hash is enough).
    secretHash: { type: String, required: true },
    // First characters of the whole key, so a person can tell keys apart in a list without it being usable.
    prefix: { type: String, required: true },
    scopes: { type: [String], required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
    revokedByName: { type: String },
    createdById: { type: String, required: true },
    createdByName: { type: String, required: true },
    lastUsedAt: { type: Date },
    lastUsedIp: { type: String },
    useCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const ApiKeyModel = model("ApiKey", apiKeySchema);

/** One line per call a key made, so an administrator can see what an application did and when. Old lines delete themselves. */
const apiKeyUsageSchema = new Schema({
  keyId: { type: String, required: true, index: true },
  at: { type: Date, default: () => new Date(), index: { expireAfterSeconds: 90 * 86_400 } },
  method: { type: String, required: true },
  // The path without its query string: a query can carry names and search terms.
  path: { type: String, required: true },
  status: { type: Number, required: true },
  ip: { type: String },
});

export const ApiKeyUsageModel = model("ApiKeyUsage", apiKeyUsageSchema);
