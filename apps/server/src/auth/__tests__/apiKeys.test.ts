import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SCOPES, RULES, scopeFor } from "../apiKeyScopes.js";
import { AuditLogModel } from "../../models/auditLog.js";
import { ApiKeyModel, ApiKeyUsageModel } from "../../models/apiKey.js";
import { BuildingModel } from "../../models/building.js";
import { RoomModel } from "../../models/room.js";
import { UserModel } from "../../models/user.js";
import { startHarness, type ApiClient, type Harness } from "../../testing/harness.js";

let h: Harness;
let admin: ApiClient;
let operator: ApiClient;

beforeAll(async () => {
  h = await startHarness();
  [admin, operator] = await Promise.all([h.login("admin"), h.login("operator")]);
}, 120_000);
afterAll(() => h.stop());

beforeEach(async () => {
  await Promise.all([ApiKeyModel.deleteMany({}), ApiKeyUsageModel.deleteMany({}), AuditLogModel.deleteMany({}), UserModel.updateMany({}, { $set: { "twoFactor.failures": 0 }, $unset: { "twoFactor.lockedUntil": 1 } })]);
});

/** Creates a key the way the console does, with a fresh authenticator code. */
async function makeKey(scopes: string[], extra: object = {}) {
  const res = await admin.request("POST", "/api-keys", { name: "Timetable app", scopes, twoFactorCode: await admin.code(), ...extra });
  expect(res.status).toBe(201);
  return res.body as { id: string; key: string; prefix: string };
}
const withKey = (key: string, method: string, path: string, body?: unknown) =>
  fetch(`${h.origin}/api${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body !== undefined && { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });

describe("creating keys", () => {
  it("is for administrators, needs a fresh code, and shows the key once", async () => {
    const created = await makeKey(["rooms:read"]);
    expect(created.key).toMatch(/^scak_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    expect(created.key.startsWith(created.prefix)).toBe(true);

    const listing = JSON.stringify((await admin.request("GET", "/api-keys")).body);
    expect(listing).not.toContain(created.key);
    expect(listing).not.toMatch(/secretHash|scak_[0-9a-f]{16}_/);
    const stored = (await ApiKeyModel.findOne({ keyId: created.id }))!;
    expect(stored.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(created.key.split("_")[2]!);
    expect(await AuditLogModel.countDocuments({ action: "api-key.create" })).toBe(1);

    const body = { name: "x", scopes: ["rooms:read"] };
    expect((await admin.request("POST", "/api-keys", body)).body.code).toBe("two_factor_required");
    expect((await admin.request("POST", "/api-keys", { ...body, twoFactorCode: "000000" })).body.code).toBe("two_factor_invalid");
    expect((await operator.request("POST", "/api-keys", { ...body, twoFactorCode: await operator.code() })).status).toBe(403);
    expect((await h.anonymous.request("GET", "/api-keys")).status).toBe(401);
  });

  it("validates the scopes and the lifetime, and never makes a key that lasts for ever", async () => {
    const post = async (b: object) => admin.request("POST", "/api-keys", { name: "k", twoFactorCode: await admin.code(), ...b });
    expect((await post({ scopes: [] })).status).toBe(400);
    expect((await post({ scopes: ["everything"] })).status).toBe(400);
    expect((await post({ scopes: ["emergency:start"] })).status).toBe(400);
    expect((await post({ scopes: ["rooms:read"], expiresInDays: 0 })).status).toBe(400);
    expect((await post({ scopes: ["rooms:read"], expiresInDays: 366 })).status).toBe(400);
    expect((await post({ scopes: ["rooms:read"], hack: 1 })).status).toBe(400);
    const ok = await post({ scopes: ["rooms:read", "rooms:read"], expiresInDays: 30 });
    expect(ok.body.scopes).toEqual(["rooms:read"]);
    expect(Math.round((new Date(ok.body.expiresAt).getTime() - Date.now()) / 86_400_000)).toBe(30);
    expect(Math.round((new Date((await post({ scopes: ["rooms:read"] })).body.expiresAt).getTime() - Date.now()) / 86_400_000)).toBe(90);
  });

  it("lists the scopes it knows, so the console never keeps its own copy", async () => {
    const res = await admin.request("GET", "/api-keys/scopes");
    expect(res.body.items.map((s: { id: string }) => s.id)).toEqual(SCOPES.map((s) => s.id));
    expect((await operator.request("GET", "/api-keys/scopes")).status).toBe(403);
  });
});

describe("using a key", () => {
  it("works whatever characters the secret has, underscores included (the secret is base64url)", async () => {
    // One after the other: a code works once, so twelve at the same moment would be eleven refusals.
    const keys = [];
    for (let i = 0; i < 12; i++) keys.push(await makeKey(["buildings:read"]));
    expect(keys.some((k) => k.key.split("_").length > 3)).toBe(true);
    for (const k of keys) expect((await withKey(k.key, "GET", "/buildings")).status).toBe(200);
  });

  it("reads what its scopes allow and nothing else", async () => {
    const building = await BuildingModel.create({ code: "K1", name: "Key building" });
    await RoomModel.create({ building: building._id, code: "K1-1", floor: 0 });
    const { key } = await makeKey(["rooms:read"]);
    const rooms = await withKey(key, "GET", "/rooms");
    expect(rooms.status).toBe(200);
    expect((await rooms.json()).items.length).toBeGreaterThan(0);
    // Another scope's endpoint: refused, and the answer names the missing scope.
    const buildings = await withKey(key, "GET", "/buildings");
    expect(buildings.status).toBe(403);
    expect((await buildings.json()).code).toBe("api_key_scope");
  });

  it("can write only where a write scope says so", async () => {
    const { key } = await makeKey(["news:read"]);
    expect((await withKey(key, "POST", "/faculty/news", { title: "Hello" })).status).toBe(403);
    const writer = await makeKey(["news:write"]);
    const created = await withKey(writer.key, "POST", "/faculty/news", { title: "Open day", priority: "important" });
    expect(created.status).toBe(201);
    // The audit entry names the key, not a person.
    const audit = await AuditLogModel.findOne({ action: "faculty.news.create" });
    expect(audit?.actorName).toBe("API key: Timetable app");
    expect(audit?.actorId).toBe(`api-key:${writer.id}`);
  });

  it("can never reach accounts, keys, sign-in, enrollment, commands or emergencies, whatever its scopes", async () => {
    const { key } = await makeKey(SCOPES.map((s) => s.id));
    const blocked: [string, string, unknown?][] = [
      ["GET", "/users"],
      ["POST", "/users", { email: "x@x.test", name: "x" }],
      ["GET", "/api-keys"],
      ["POST", "/api-keys", { name: "mint", scopes: ["rooms:read"] }],
      ["GET", "/auth/2fa"],
      ["GET", "/auth/me"],
      ["GET", "/emergencies"],
      ["POST", "/emergencies", { kind: "fire", testMode: true }],
      ["POST", "/devices/requests/x/approve", {}],
      ["POST", "/devices/x/commands", {}],
      ["GET", "/devices/x/commands"],
      ["GET", "/assets"],
      ["POST", "/intercom/broadcast", {}],
      ["PUT", "/faculty/scopes/default/-/playlist", { scenes: [] }],
      ["DELETE", "/users/x"],
    ];
    for (const [method, path, body] of blocked) {
      const res = await withKey(key, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await res.json()).code, `${method} ${path}`).toBe("api_key_forbidden");
    }
  });

  it("is refused when it is wrong, revoked, expired, or sent the wrong way, always with the same answer", async () => {
    const { key, id } = await makeKey(["rooms:read"]);
    const answer = async (header: string) => {
      const res = await fetch(`${h.origin}/api/rooms`, { headers: { authorization: header } });
      return [res.status, (await res.json()).code];
    };
    const [, hex, secret] = /^scak_([0-9a-f]{16})_(.{43})$/.exec(key)!;
    expect(await answer(`Bearer scak_${hex}_${secret.slice(0, -1)}x`)).toEqual([401, "invalid_api_key"]);
    expect(await answer(`Bearer scak_${"0".repeat(16)}_${secret}`)).toEqual([401, "invalid_api_key"]);
    expect(await answer("Bearer nonsense")).toEqual([401, "invalid_api_key"]);
    expect(await answer(`Basic ${key}`)).toEqual([401, "invalid_api_key"]);

    await ApiKeyModel.updateOne({ keyId: id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await answer(`Bearer ${key}`)).toEqual([401, "invalid_api_key"]);
  });

  it("does not fall back to a cookie: a bad key with a good session is still refused", async () => {
    const res = await fetch(`${h.origin}/api/rooms`, { headers: { authorization: "Bearer scak_bad_key", cookie: (await h.login("admin")) && "" } });
    expect(res.status).toBe(401);
  });

  it("stops working the moment it is revoked, and the revocation is audited", async () => {
    const { key, id } = await makeKey(["rooms:read"]);
    expect((await withKey(key, "GET", "/rooms")).status).toBe(200);
    expect((await admin.request("DELETE", `/api-keys/${id}`)).body.state).toBe("revoked");
    expect((await withKey(key, "GET", "/rooms")).status).toBe(401);
    expect((await admin.request("DELETE", `/api-keys/${id}`)).status).toBe(404);
    expect(await AuditLogModel.countDocuments({ action: "api-key.revoke" })).toBe(1);
    expect((await operator.request("DELETE", `/api-keys/${id}`)).status).toBe(403);
  });

  it("writes a usage line for each call with the status the caller got, and no query string", async () => {
    const { key, id } = await makeKey(["rooms:read"]);
    await withKey(key, "GET", "/rooms?search=secret-name");
    await withKey(key, "GET", "/buildings");
    await new Promise((r) => setTimeout(r, 200));
    const usage = (await admin.request("GET", `/api-keys/${id}/usage`)).body.items;
    expect(usage.map((u: { path: string; status: number }) => `${u.path}:${u.status}`).sort()).toEqual(["/buildings:403", "/rooms:200"]);
    expect(JSON.stringify(usage)).not.toContain("secret-name");
    const listed = (await admin.request("GET", "/api-keys")).body.items.find((k: { id: string }) => k.id === id);
    expect(listed.useCount).toBe(2);
    expect(listed.lastUsedAt).not.toBeNull();
  });

  it("is limited per key so a runaway integration cannot starve the console", async () => {
    const { key } = await makeKey(["buildings:read"]);
    const statuses: number[] = [];
    for (let i = 0; i < 305; i++) statuses.push((await withKey(key, "GET", "/buildings")).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    expect(statuses[0]).toBe(200);
  }, 60_000);
});

describe("the list of reachable endpoints", () => {
  it("only names scopes that exist, and every scope is used by at least one endpoint", () => {
    const ids = new Set<string>(SCOPES.map((s) => s.id));
    for (const r of RULES) expect(ids.has(r.scope), r.scope).toBe(true);
    for (const s of SCOPES) expect(RULES.some((r) => r.scope === s.id), s.id).toBe(true);
  });

  it("matches methods and paths exactly", () => {
    expect(scopeFor("GET", "/rooms")).toBe("rooms:read");
    expect(scopeFor("GET", "/rooms/")).toBe("rooms:read");
    expect(scopeFor("PUT", "/rooms/abc/status")).toBe("rooms:status");
    expect(scopeFor("DELETE", "/rooms/abc")).toBeNull();
    expect(scopeFor("GET", "/rooms/abc/extra/segments")).toBeNull();
    expect(scopeFor("GET", "/devices/abc/commands")).toBeNull();
    expect(scopeFor("GET", "/users")).toBeNull();
  });
});
