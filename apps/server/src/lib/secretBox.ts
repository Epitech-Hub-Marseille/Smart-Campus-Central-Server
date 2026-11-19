import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";

/**
 * Encrypts a secret that has to be read back (a two-factor secret: the server must recompute codes from it). AES-256-GCM
 * with a random nonce per value; the key is a mounted secret, never kept next to the data it protects.
 */
function key(): Buffer {
  if (config.TWO_FACTOR_KEY) return Buffer.from(config.TWO_FACTOR_KEY, "base64");
  // Development and tests only: config refuses to start in production without a key.
  return createHash("sha256").update("smartcampus-development-two-factor-key").digest();
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${data.toString("base64")}`;
}

export function open(sealed: string): string {
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("unknown secret format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}
