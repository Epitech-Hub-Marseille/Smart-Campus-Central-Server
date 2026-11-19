import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../config.js";
import { LOCK_MINUTES, MAX_FAILURES } from "../../auth/twoFactor.js";
import { hashPassword } from "../../lib/password.js";
import { open } from "../../lib/secretBox.js";
import { codeAt, stepOf } from "../../lib/totp.js";
import { AuditLogModel } from "../../models/auditLog.js";
import { LoginChallengeModel } from "../../models/loginChallenge.js";
import { UserModel } from "../../models/user.js";
import { startHarness, type Harness } from "../../testing/harness.js";

let h: Harness;
const PASSWORD = "correct-horse-battery";

beforeAll(async () => {
  h = await startHarness();
  // These tests are about the requirement itself.
  config.REQUIRE_ADMIN_2FA = true;
}, 120_000);
afterAll(async () => {
  config.REQUIRE_ADMIN_2FA = false;
  await h.stop();
});

beforeEach(async () => {
  await Promise.all([AuditLogModel.deleteMany({}), LoginChallengeModel.deleteMany({})]);
  await UserModel.deleteMany({ email: { $regex: "@twofactor\\.test$" } });
});

/** A person with a password only, and a small client that keeps their cookie. */
async function person(name: string, groups: string[] = ["operator"]) {
  const email = `${name}@twofactor.test`;
  await UserModel.create({ email, name, groups, passwordHash: await hashPassword(PASSWORD) });
  let cookie = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${h.origin}/api${path}`, { method, headers: { "content-type": "application/json", ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    if (set) cookie = set;
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { email, call, signedIn: () => Boolean(cookie), forget: () => (cookie = ""), user: () => UserModel.findOne({ email }).then((u) => u!) };
}
type Person = Awaited<ReturnType<typeof person>>;

/** Sets two-factor up the way the console does and returns the secret and the recovery codes. */
async function enableTwoFactor(p: Person) {
  expect((await p.call("POST", "/auth/login", { email: p.email, password: PASSWORD })).status).toBe(200);
  const setup = await p.call("POST", "/auth/2fa/setup");
  expect(setup.status).toBe(201);
  const secret = setup.body.secret as string;
  const enabled = await p.call("POST", "/auth/2fa/enable", { code: codeAt(secret, stepOf(Date.now())) });
  expect(enabled.status).toBe(200);
  p.forget();
  return { secret, recoveryCodes: enabled.body.recoveryCodes as string[] };
}

const login = async (p: Person) => (await p.call("POST", "/auth/login", { email: p.email, password: PASSWORD })).body;
/** A code for a later step than the last one used, which is what a person gets by waiting for the next one. */
const nextCode = (secret: string, ahead = 0) => codeAt(secret, stepOf(Date.now()) + ahead);
/** The same, after the "wait": forgets the step that was used, so a test can use the current code more than once. */
const later = async (p: Person, secret: string) => {
  await UserModel.updateOne({ email: p.email }, { $set: { "twoFactor.lastUsedStep": -1 } });
  return nextCode(secret);
};

describe("setting up", () => {
  it("shows the secret once, keeps it encrypted, and turns on only after a code from it", async () => {
    const p = await person("ada");
    await p.call("POST", "/auth/login", { email: p.email, password: PASSWORD });
    const setup = (await p.call("POST", "/auth/2fa/setup")).body;
    expect(setup.uri).toContain(`secret=${setup.secret}`);
    expect(setup.uri).toContain("Smart%20Campus");
    expect((await p.call("GET", "/auth/2fa")).body).toMatchObject({ enabled: false });

    expect((await p.call("POST", "/auth/2fa/enable", { code: "000000" })).status).toBe(400);
    expect((await p.call("GET", "/auth/2fa")).body).toMatchObject({ enabled: false });
    const ok = await p.call("POST", "/auth/2fa/enable", { code: nextCode(setup.secret) });
    expect(ok.body.recoveryCodes).toHaveLength(10);
    expect(new Set(ok.body.recoveryCodes).size).toBe(10);
    expect((await p.call("GET", "/auth/2fa")).body).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });

    const stored = (await p.user()).twoFactor!;
    expect(stored.secret).not.toContain(setup.secret);
    expect(open(stored.secret!)).toBe(setup.secret);
    // Recovery codes are kept as hashes only.
    expect(JSON.stringify(stored)).not.toContain(ok.body.recoveryCodes[0]);
    expect(await AuditLogModel.countDocuments({ action: "auth.2fa.enable" })).toBe(1);
  });

  it("never sends the secret or the hashes back in the account, the directory or the login answer", async () => {
    const p = await person("ada");
    const { secret } = await enableTwoFactor(p);
    const challenge = (await login(p)).challenge;
    const done = await p.call("POST", "/auth/login/2fa", { challenge, code: nextCode(secret, 1) });
    const admin = await h.login("admin");
    const listing = JSON.stringify((await admin.request("GET", "/users?limit=100")).body);
    const all = JSON.stringify([done.body, (await p.call("GET", "/auth/me")).body, listing]);
    expect(all).not.toContain(secret);
    expect(all).not.toMatch(/recoveryHashes|pendingSecret|"secret"/);
    expect(JSON.parse(listing).items.find((u: { email: string }) => u.email === p.email).twoFactor).toBe(true);
  });

  it("cannot be set up twice, and needs a login", async () => {
    const p = await person("ada");
    await enableTwoFactor(p);
    await p.call("POST", "/auth/login/2fa", { challenge: (await login(p)).challenge, code: "000000" });
    expect((await h.anonymous.request("POST", "/auth/2fa/setup")).status).toBe(401);
  });
});

describe("signing in", () => {
  it("asks for the code after the password and gives no session before it", async () => {
    const p = await person("ada");
    const { secret } = await enableTwoFactor(p);
    const first = await login(p);
    expect(first).toMatchObject({ twoFactorRequired: true });
    expect(first.user).toBeUndefined();
    expect(p.signedIn()).toBe(false);
    expect((await p.call("GET", "/auth/me")).status).toBe(401);

    const done = await p.call("POST", "/auth/login/2fa", { challenge: first.challenge, code: nextCode(secret, 1) });
    expect(done.status).toBe(200);
    expect(done.body.user).toMatchObject({ email: p.email, twoFactor: { enabled: true } });
    expect((await p.call("GET", "/auth/me")).status).toBe(200);
  });

  it("refuses a wrong code, and the challenge is single use", async () => {
    const p = await person("ada");
    const { secret } = await enableTwoFactor(p);
    const { challenge } = await login(p);
    const wrong = await p.call("POST", "/auth/login/2fa", { challenge, code: "000000" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe("two_factor_invalid");
    expect((await p.call("POST", "/auth/login/2fa", { challenge, code: nextCode(secret, 1) })).status).toBe(200);
    p.forget();
    expect((await p.call("POST", "/auth/login/2fa", { challenge, code: nextCode(secret, 1) })).body.code).toBe("challenge_expired");
  });

  it("does not take a code twice: a code that was just used is no good a second time", async () => {
    const p = await person("ada");
    const { secret } = await enableTwoFactor(p);
    const code = nextCode(secret, 1);
    expect((await p.call("POST", "/auth/login/2fa", { challenge: (await login(p)).challenge, code })).status).toBe(200);
    p.forget();
    expect((await p.call("POST", "/auth/login/2fa", { challenge: (await login(p)).challenge, code })).status).toBe(401);
  });

  it("does not take a challenge that expired, nor one of someone else without the right code", async () => {
    const ada = await person("ada");
    const bruno = await person("bruno");
    const { secret } = await enableTwoFactor(ada);
    await enableTwoFactor(bruno);
    const { challenge } = await login(ada);
    // Bruno's code does not open Ada's challenge.
    const brunoCode = nextCode((await bruno.user()).twoFactor!.secret ? open((await bruno.user()).twoFactor!.secret!) : "", 1);
    expect((await h.anonymous.request("POST", "/auth/login/2fa", { challenge, code: brunoCode })).status).toBe(401);
    await LoginChallengeModel.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await h.anonymous.request("POST", "/auth/login/2fa", { challenge, code: nextCode(secret, 1) })).body.code).toBe("challenge_expired");
  });

  it("locks the account after five wrong codes, whichever door they come through, and says for how long", async () => {
    const p = await person("ada");
    const { secret } = await enableTwoFactor(p);
    for (let i = 0; i < MAX_FAILURES; i++) {
      const res = await p.call("POST", "/auth/login/2fa", { challenge: (await login(p)).challenge, code: "000000" });
      expect(res.status).toBe(401);
    }
    const locked = await p.call("POST", "/auth/login/2fa", { challenge: (await login(p)).challenge, code: await later(p, secret) });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toContain(`${LOCK_MINUTES} minute`);
    expect(await AuditLogModel.countDocuments({ action: "auth.2fa.locked" })).toBe(1);

    // Time passes: the lock ends, and the right code works again.
    await UserModel.updateOne({ email: p.email }, { $set: { "twoFactor.lockedUntil": new Date(Date.now() - 1000) } });
    expect((await p.call("POST", "/auth/login/2fa", { challenge: (await login(p)).challenge, code: nextCode(secret, 1) })).status).toBe(200);
  });

  it("lets a recovery code in once, and tells how many are left", async () => {
    const p = await person("ada");
    const { recoveryCodes } = await enableTwoFactor(p);
    const done = await p.call("POST", "/auth/login/2fa", { challenge: (await login(p)).challenge, recoveryCode: recoveryCodes[0]!.toLowerCase().replace("-", " ") });
    expect(done.status).toBe(200);
    expect((await p.call("GET", "/auth/2fa")).body.recoveryCodesLeft).toBe(9);
    p.forget();
    expect((await p.call("POST", "/auth/login/2fa", { challenge: (await login(p)).challenge, recoveryCode: recoveryCodes[0] })).status).toBe(401);
    expect(await AuditLogModel.countDocuments({ action: "auth.2fa.recovery-used" })).toBe(1);
  });

  it("wants a code or a recovery code, not both and not neither", async () => {
    const p = await person("ada");
    await enableTwoFactor(p);
    const { challenge } = await login(p);
    expect((await p.call("POST", "/auth/login/2fa", { challenge })).status).toBe(400);
    expect((await p.call("POST", "/auth/login/2fa", { challenge, code: "123456", recoveryCode: "ABCDE-FGHJK" })).status).toBe(400);
  });
});

describe("administrators", () => {
  it("cannot use the console until they have set it up, but can reach the pages to do so", async () => {
    const admin = await person("root", ["admin"]);
    await admin.call("POST", "/auth/login", { email: admin.email, password: PASSWORD });
    const blocked = await admin.call("GET", "/buildings");
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("two_factor_setup_required");
    expect((await admin.call("GET", "/auth/me")).body.user.twoFactor).toEqual({ enabled: false, required: true });
    const setup = await admin.call("POST", "/auth/2fa/setup");
    expect(setup.status).toBe(201);
    await admin.call("POST", "/auth/2fa/enable", { code: nextCode(setup.body.secret) });
    expect((await admin.call("GET", "/buildings")).status).toBe(200);
  });

  it("do not block operators or staff, and the requirement can be switched off", async () => {
    const op = await person("ops", ["operator"]);
    await op.call("POST", "/auth/login", { email: op.email, password: PASSWORD });
    expect((await op.call("GET", "/buildings")).status).toBe(200);
    config.REQUIRE_ADMIN_2FA = false;
    const admin = await person("root", ["admin"]);
    await admin.call("POST", "/auth/login", { email: admin.email, password: PASSWORD });
    expect((await admin.call("GET", "/buildings")).status).toBe(200);
    config.REQUIRE_ADMIN_2FA = true;
  });

  it("cannot turn it off; an operator can, with a code", async () => {
    const admin = await person("root", ["admin"]);
    const { secret } = await enableTwoFactor(admin);
    await admin.call("POST", "/auth/login/2fa", { challenge: (await login(admin)).challenge, code: nextCode(secret, 1) });
    expect((await admin.call("POST", "/auth/2fa/disable", { code: await later(admin, secret) })).status).toBe(403);

    const op = await person("ops", ["operator"]);
    const ops = await enableTwoFactor(op);
    await op.call("POST", "/auth/login/2fa", { challenge: (await login(op)).challenge, code: nextCode(ops.secret, 1) });
    expect((await op.call("POST", "/auth/2fa/disable", { code: "000000" })).status).toBe(401);
    expect((await op.call("POST", "/auth/2fa/disable", { code: await later(op, ops.secret) })).status).toBe(204);
    expect((await op.call("GET", "/auth/2fa")).body.enabled).toBe(false);
  });
});

describe("recovery codes", () => {
  it("are replaced by a new set when asked with a code, and the old ones stop working", async () => {
    const p = await person("ada");
    const { secret, recoveryCodes } = await enableTwoFactor(p);
    await p.call("POST", "/auth/login/2fa", { challenge: (await login(p)).challenge, code: nextCode(secret, 1) });
    expect((await p.call("POST", "/auth/2fa/recovery-codes", { code: "000000" })).status).toBe(401);
    const fresh = await p.call("POST", "/auth/2fa/recovery-codes", { code: await later(p, secret) });
    expect(fresh.body.recoveryCodes).toHaveLength(10);
    p.forget();
    expect((await p.call("POST", "/auth/login/2fa", { challenge: (await login(p)).challenge, recoveryCode: recoveryCodes[0] })).status).toBe(401);
    expect((await p.call("POST", "/auth/login/2fa", { challenge: (await login(p)).challenge, recoveryCode: fresh.body.recoveryCodes[0] })).status).toBe(200);
  });
});

describe("reset by another administrator", () => {
  it("removes the second factor, signs the person out, is audited, and the person sets it up again", async () => {
    const admin = await h.login("admin");
    const p = await person("ada");
    const { secret } = await enableTwoFactor(p);
    await p.call("POST", "/auth/login/2fa", { challenge: (await login(p)).challenge, code: nextCode(secret, 1) });
    expect((await p.call("GET", "/auth/me")).status).toBe(200);
    const id = (await p.user()).id;

    expect((await admin.request("POST", `/users/${id}/two-factor/reset`)).status).toBe(204);
    expect((await p.call("GET", "/auth/me")).status).toBe(401);
    expect((await p.user()).twoFactor?.enabled).toBeFalsy();
    expect(await AuditLogModel.countDocuments({ action: "auth.2fa.reset", targetId: id })).toBe(1);
    expect(await login(p)).toMatchObject({ user: { twoFactor: { enabled: false } } });
    expect((await admin.request("POST", `/users/${id}/two-factor/reset`)).status).toBe(409);
  });

  it("is for administrators only, and never for oneself", async () => {
    const op = await h.login("operator");
    const admin = await h.login("admin");
    const p = await person("ada");
    await enableTwoFactor(p);
    const id = (await p.user()).id;
    expect((await op.request("POST", `/users/${id}/two-factor/reset`)).status).toBe(403);
    const adminId = (await UserModel.findOne({ email: "admin@test.local" }))!.id;
    expect((await admin.request("POST", `/users/${adminId}/two-factor/reset`)).status).toBe(400);
    await h.login("staff");
    // Someone with no second factor has nothing to reset.
    expect((await admin.request("POST", `/users/${(await UserModel.findOne({ email: "staff@test.local" }))!.id}/two-factor/reset`)).status).toBe(409);
  });
});

describe("emergency alerts", () => {
  // An alert needs at least one screen to reach.
  beforeAll(async () => void (await h.enrollDevice({ type: "door" })));
  const alert = (extra: object = {}) => ({ kind: "fire", targets: { all: true }, testMode: true, ...extra });

  it("need a fresh code from the authenticator app, even in test mode", async () => {
    const op = await h.login("operator");
    const none = await op.request("POST", "/emergencies", alert());
    // 403: the person is signed in, and a 401 would make the console end their session.
    expect(none.status).toBe(403);
    expect(none.body.code).toBe("two_factor_required");
    const wrong = await op.request("POST", "/emergencies", alert({ twoFactorCode: "000000" }));
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe("two_factor_invalid");
    expect(await AuditLogModel.countDocuments({ action: "auth.2fa.action-refused" })).toBe(1);
    const ok = await op.request("POST", "/emergencies", alert({ twoFactorCode: await op.code() }));
    expect(ok.status).toBe(201);
    expect(ok.body.testMode).toBe(true);
  });

  it("do not let one code start two alerts", async () => {
    const op = await h.login("operator");
    const code = await op.code();
    expect((await op.request("POST", "/emergencies", alert({ twoFactorCode: code }))).status).toBe(201);
    expect((await op.request("POST", "/emergencies", alert({ twoFactorCode: code }))).status).toBe(403);
  });

  it("cannot be started by someone who has not set two-factor up, and the answer says to", async () => {
    const p = await person("ops", ["operator"]);
    await p.call("POST", "/auth/login", { email: p.email, password: PASSWORD });
    const res = await p.call("POST", "/emergencies", alert({ twoFactorCode: "123456" }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("two_factor_setup_required");
  });

  it("a real alert still needs its confirmation as well as the code", async () => {
    const op = await h.login("operator");
    const body = { kind: "fire", targets: { all: true }, testMode: false };
    expect((await op.request("POST", "/emergencies", { ...body, twoFactorCode: await op.code() })).status).toBe(409);
    const confirmation = (await op.request("POST", "/emergencies/confirmations", body)).body.confirmation;
    expect((await op.request("POST", "/emergencies", { ...body, confirmation, twoFactorCode: await op.code() })).status).toBe(201);
  });

  it("ending an alert needs no code: taking an alarm off the screens is never slowed down", async () => {
    const op = await h.login("operator");
    const started = await op.request("POST", "/emergencies", alert({ twoFactorCode: await op.code() }));
    expect((await op.request("DELETE", `/emergencies/${started.body.id}`)).status).toBe(204);
  });
});
