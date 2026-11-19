import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238, HMAC-SHA1, 30 seconds, 6 digits): what every authenticator app speaks.
 * Written on node:crypto so a security feature does not hang on one more dependency.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;
const DIGITS = 6;
/** Codes from one step before or after are accepted, because phone and server clocks are never the same. */
const WINDOW = 1;

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.toUpperCase().replace(/[\s=-]/g, "")) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 160 bits, the size RFC 4226 recommends. */
export const generateSecret = (): string => base32Encode(randomBytes(20));

export const stepOf = (ms: number): number => Math.floor(ms / 1000 / STEP_SECONDS);

/** The code of one time step. */
export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Checks a code. Returns the step it belongs to, so the caller can refuse that step (and every earlier one) from then
 * on: a code that was just used, or one someone watched over a shoulder, must not work a second time.
 */
export function verifyCode(secret: string, code: string, nowMs: number, lastUsedStep = -1): { ok: true; step: number } | { ok: false } {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return { ok: false };
  const now = stepOf(nowMs);
  let found: number | null = null;
  // Every step in the window is compared, so the time taken does not say which one matched.
  for (let step = now - WINDOW; step <= now + WINDOW; step++) {
    if (same(codeAt(secret, step), clean) && step > lastUsedStep) found = step;
  }
  return found === null ? { ok: false } : { ok: true, step: found };
}

export const otpauthUri = (secret: string, account: string, issuer: string): string =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
