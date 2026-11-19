import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, codeAt, generateSecret, otpauthUri, stepOf, verifyCode } from "./totp.js";

// RFC 6238, appendix B: the secret is the ASCII string "12345678901234567890" and the reference codes have 8 digits.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("totp", () => {
  it("gives the codes of the RFC 6238 test vectors (last six digits)", () => {
    for (const [seconds, code] of [
      [59, "287082"],
      [1111111109, "081804"],
      [1234567890, "005924"],
      [2000000000, "279037"],
    ] as const) {
      expect(codeAt(RFC_SECRET, stepOf(seconds * 1000))).toBe(code);
    }
  });

  it("round-trips base32 and makes secrets of 160 bits", () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(secret))).toBe(secret);
    expect(base32Decode("JBSWY3DPEHPK3PXP").toString("hex")).toBe("48656c6c6f21deadbeef");
    expect(() => base32Decode("not base32!")).toThrow();
    expect(generateSecret()).not.toBe(generateSecret());
  });

  it("accepts the code of the previous, current and next step, and nothing further away", () => {
    const now = 1_700_000_000_000;
    const step = stepOf(now);
    for (const s of [step - 1, step, step + 1]) expect(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, s), now)).toEqual({ ok: true, step: s });
    expect(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, step - 2), now).ok).toBe(false);
    expect(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, step + 2), now).ok).toBe(false);
  });

  it("never accepts a step that was already used, or an earlier one", () => {
    const now = 1_700_000_000_000;
    const step = stepOf(now);
    expect(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, step), now, step).ok).toBe(false);
    expect(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, step - 1), now, step).ok).toBe(false);
    expect(verifyCode(RFC_SECRET, codeAt(RFC_SECRET, step + 1), now, step)).toEqual({ ok: true, step: step + 1 });
  });

  it("refuses anything that is not six digits, and ignores spaces", () => {
    const now = 1_700_000_000_000;
    const code = codeAt(RFC_SECRET, stepOf(now));
    expect(verifyCode(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now).ok).toBe(true);
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34"]) expect(verifyCode(RFC_SECRET, bad, now).ok).toBe(false);
  });

  it("builds the address an authenticator app scans", () => {
    const uri = otpauthUri("ABC234", "ada@campus.test", "Smart Campus");
    expect(uri).toBe("otpauth://totp/Smart%20Campus:ada%40campus.test?secret=ABC234&issuer=Smart%20Campus&algorithm=SHA1&digits=6&period=30");
  });
});
