import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditLogModel } from "../../models/auditLog.js";
import { CommandModel } from "../../models/command.js";
import { DeviceModel } from "../../models/device.js";
import { ThemeAssignmentModel, ThemeModel } from "../../models/theme.js";
import { startHarness, type ApiClient, type Harness } from "../../testing/harness.js";

let h: Harness;
let admin: ApiClient;
let operator: ApiClient;
let staff: ApiClient;

beforeAll(async () => {
  h = await startHarness();
  [admin, operator, staff] = await Promise.all([h.login("admin"), h.login("operator"), h.login("staff")]);
}, 120_000);
afterAll(() => h.stop());

beforeEach(async () => {
  await Promise.all([DeviceModel.deleteMany({}), CommandModel.deleteMany({}), ThemeModel.deleteMany({}), ThemeAssignmentModel.deleteMany({}), AuditLogModel.deleteMany({})]);
});

const tokens = (primary = "#1d4f9f") => ({ mode: "dark", colors: { background: "#101828", primary }, typography: { fontFamily: "sans", scale: 1.1 }, shape: { radius: 12 } });
const theme = async (name = "Night", extra: object = {}) => (await operator.request("POST", "/themes", { name, tokens: tokens(), css: ".card { border-radius: 8px }", ...extra })).body as { id: string; version: number };
const assign = (scope: string, key: string, themeId: string | null) => operator.request("PUT", "/themes/assignments", { scope, key, themeId });
const latest = async (deviceId: string) => (await CommandModel.findOne({ deviceId, type: "theme.set", status: { $ne: "superseded" } }).sort({ commandId: -1 }))?.payload as { theme: null | { id: string; version: number; css?: string; tokens: any } } | undefined;
const count = (deviceId: string) => CommandModel.countDocuments({ deviceId, type: "theme.set" });

describe("making themes", () => {
  it("is for admins and operators, and is validated against the schema", async () => {
    const ok = await operator.request("POST", "/themes", { name: "Night", tokens: tokens(), css: "a { color: red }" });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ name: "Night", version: 1, tokens: { colors: { primary: "#1d4f9f" } } });
    expect((await staff.request("POST", "/themes", { name: "x" })).status).toBe(403);
    expect((await h.anonymous.request("GET", "/themes")).status).toBe(401);
    const bad = (body: object) => operator.request("POST", "/themes", { name: "Bad", ...body });
    expect((await bad({ tokens: { colors: { primary: "blue" } } })).status).toBe(400);
    expect((await bad({ tokens: { colors: { sparkle: "#ffffff" } } })).status).toBe(400);
    expect((await bad({ tokens: { typography: { scale: 9 } } })).status).toBe(400);
    expect((await bad({ css: "@import 'https://evil.example/x.css';" })).status).toBe(400);
    expect((await bad({ css: "a { background: url(https://evil.example/x) }" })).status).toBe(400);
    expect((await bad({ css: ".a { color: red" })).status).toBe(400);
    expect((await bad({ name: "Night" })).status).toBe(409);
    expect(await AuditLogModel.countDocuments({ action: "theme.create" })).toBe(1);
  });

  it("tells the console what a theme can hold", async () => {
    const schema = (await operator.request("GET", "/themes/schema")).body;
    expect(schema.colors).toContain("primary");
    expect(schema.fonts).toEqual(["system", "sans", "serif", "mono", "condensed"]);
    expect(schema.limits.css).toBe(12000);
  });

  it("rises in version with each edit, and cannot be deleted while it is used", async () => {
    const t = await theme();
    expect((await operator.request("PUT", `/themes/${t.id}`, { name: "Night", tokens: tokens("#ff0000") })).body).toMatchObject({ version: 2, tokens: { colors: { primary: "#ff0000" } } });
    const door = await h.enrollDevice({ type: "door" });
    await assign("device", door.deviceId, t.id);
    const refused = await operator.request("DELETE", `/themes/${t.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("device");
    await assign("device", door.deviceId, null);
    expect((await operator.request("DELETE", `/themes/${t.id}`)).status).toBe(204);
  });
});

describe("assigning themes", () => {
  it("a device's own theme wins over its group's, which wins over the default of its kind, and otherwise it keeps its own look", async () => {
    const [base, groupTheme, own] = [await theme("Base"), await theme("Group"), await theme("Own")];
    const door = await h.enrollDevice({ type: "door", groups: ["building-a"] });
    expect(await latest(door.deviceId)).toBeUndefined();

    await assign("default", "door", base.id);
    expect((await latest(door.deviceId))?.theme?.id).toBe(base.id);
    await assign("group", "building-a", groupTheme.id);
    expect((await latest(door.deviceId))?.theme?.id).toBe(groupTheme.id);
    await assign("device", door.deviceId, own.id);
    expect((await latest(door.deviceId))?.theme?.id).toBe(own.id);

    // Taking them away one by one walks back up the list, and the last one sends the device back to its own look.
    await assign("device", door.deviceId, null);
    expect((await latest(door.deviceId))?.theme?.id).toBe(groupTheme.id);
    await assign("group", "building-a", null);
    expect((await latest(door.deviceId))?.theme?.id).toBe(base.id);
    await assign("default", "door", null);
    expect((await latest(door.deviceId))?.theme).toBeNull();
  });

  it("is the same whatever order the groups come in: the first in alphabetical order wins", async () => {
    const [a, b] = [await theme("A"), await theme("B")];
    const door = await h.enrollDevice({ type: "door", groups: ["zeta", "alpha"] });
    await assign("group", "zeta", b.id);
    await assign("group", "alpha", a.id);
    expect((await latest(door.deviceId))?.theme?.id).toBe(a.id);
    expect((await operator.request("GET", `/themes/resolve/${door.deviceId}`)).body).toMatchObject({ from: "group", via: "alpha", theme: { name: "A" } });
  });

  it("a default is per kind of device, and only doors and Faculty screens wear a theme", async () => {
    const t = await theme();
    const door = await h.enrollDevice({ type: "door" });
    const display = await h.enrollDevice({ type: "display" });
    const reader = await h.enrollDevice({ type: "access" });
    await assign("default", "display", t.id);
    expect((await latest(display.deviceId))?.theme?.id).toBe(t.id);
    expect(await latest(door.deviceId)).toBeUndefined();
    expect((await assign("default", "access", t.id)).status).toBe(400);
    expect((await assign("device", reader.deviceId, t.id)).status).toBe(404);
    expect((await assign("device", "nope", t.id)).status).toBe(404);
    expect((await assign("default", "door", "unknown")).status).toBe(400);
    expect((await staff.request("PUT", "/themes/assignments", { scope: "default", key: "door", themeId: t.id })).status).toBe(403);
  });

  it("sends the CSS to a Faculty screen and not to a door unit, which cannot use it", async () => {
    const t = await theme("Both", { css: ".card { gap: 1rem }" });
    const door = await h.enrollDevice({ type: "door" });
    const display = await h.enrollDevice({ type: "display" });
    await assign("default", "door", t.id);
    await assign("default", "display", t.id);
    expect((await latest(display.deviceId))?.theme?.css).toBe(".card { gap: 1rem }");
    expect((await latest(door.deviceId))?.theme?.css).toBeUndefined();
    expect((await latest(door.deviceId))?.theme?.tokens.colors.primary).toBe("#1d4f9f");
  });

  it("an edit reaches the devices that wear the theme, and only those, and says nothing to the rest", async () => {
    const [mine, other] = [await theme("Mine"), await theme("Other")];
    const wears = await h.enrollDevice({ type: "door" });
    const doesNot = await h.enrollDevice({ type: "door" });
    await assign("device", wears.deviceId, mine.id);
    await assign("device", doesNot.deviceId, other.id);
    const before = [await count(wears.deviceId), await count(doesNot.deviceId)];
    await operator.request("PUT", `/themes/${mine.id}`, { name: "Mine", tokens: tokens("#00aa66") });
    expect((await latest(wears.deviceId))?.theme).toMatchObject({ id: mine.id, version: 2 });
    expect(await count(wears.deviceId)).toBe(before[0]! + 1);
    expect(await count(doesNot.deviceId)).toBe(before[1]);
    // Setting the same assignment again changes nothing, so nothing is sent.
    await assign("device", wears.deviceId, mine.id);
    expect(await count(wears.deviceId)).toBe(before[0]! + 1);
  });

  it("is part of the digital twin, so a device that was offline gets it with the desired state", async () => {
    const t = await theme();
    const door = await h.enrollDevice({ type: "door" });
    await assign("default", "door", t.id);
    const dev = h.connectDevice(door.deviceId, door.identity);
    await dev.ready;
    const ready = await dev.next("session.ready");
    expect((ready.payload.desired.theme as { id: string }).id).toBe(t.id);
    dev.close();
  });

  it("a device that joins after the default was set is told when it connects", async () => {
    const t = await theme();
    await assign("default", "door", t.id);
    const door = await h.enrollDevice({ type: "door" });
    expect(await latest(door.deviceId)).toBeUndefined();
    const dev = h.connectDevice(door.deviceId, door.identity);
    await dev.ready;
    expect((await dev.next("session.ready")).payload.desired.theme).toMatchObject({ id: t.id });
    dev.close();
  });

  it("lists the assignments with the names of the themes", async () => {
    const t = await theme("Night");
    await assign("default", "display", t.id);
    expect((await operator.request("GET", "/themes/assignments")).body.items).toEqual([{ scope: "default", key: "display", themeId: t.id, themeName: "Night" }]);
    expect(await AuditLogModel.countDocuments({ action: "theme.assign" })).toBe(1);
  });
});
