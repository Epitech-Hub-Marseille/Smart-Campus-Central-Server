import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AssetModel } from "../../models/asset.js";
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
  await Promise.all([DeviceModel.deleteMany({}), CommandModel.deleteMany({}), ThemeModel.deleteMany({}), ThemeAssignmentModel.deleteMany({}), AssetModel.deleteMany({}), AuditLogModel.deleteMany({})]);
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

describe("fonts", () => {
  const woff2 = Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(40, 1)]);
  const uploadFont = (client: ApiClient, data: Buffer, name = "Display") =>
    client.raw("POST", `/assets/font?name=${encodeURIComponent(name)}`, { body: data, headers: { "content-type": "application/octet-stream" } });
  const font = async (name = "Display") => (await (await uploadFont(operator, woff2, name)).json()) as { id: string; sha256: string; size: number };

  it("accepts font files judged by their bytes, for admins and operators only", async () => {
    const ok = await uploadFont(operator, woff2);
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ kind: "font", mime: "font/woff2", size: woff2.length });
    expect((await uploadFont(operator, Buffer.concat([Buffer.from("OTTO"), Buffer.alloc(40)]))).status).toBe(201);
    expect((await uploadFont(operator, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).status).toBe(415);
    expect((await uploadFont(operator, Buffer.concat([Buffer.from("ttcf"), Buffer.alloc(40)]))).status).toBe(415);
    expect((await uploadFont(operator, Buffer.concat([woff2, Buffer.alloc(2 * 1024 * 1024)]))).status).toBe(413);
    expect((await uploadFont(staff, woff2)).status).toBe(403);
    expect((await operator.request("GET", "/assets?kind=font")).body.items).toHaveLength(2);
    expect((await operator.request("GET", "/assets")).body.items).toHaveLength(0);
  });

  it("is sent to devices as a verified reference, and a door unit may download it", async () => {
    const f = await font();
    const t = await theme("Branded", { fonts: { heading: f.id } });
    expect(t).toMatchObject({ fonts: { heading: f.id } });
    const door = await h.enrollDevice({ type: "door" });
    expect((await latest(door.deviceId))?.theme).toBeUndefined();
    await assign("device", door.deviceId, t.id);
    expect((await latest(door.deviceId))?.theme).toMatchObject({ fonts: { heading: { assetId: f.id, sha256: f.sha256, size: f.size, mime: "font/woff2" } } });
    const other = await h.enrollDevice({ type: "door" });
    const { wasAssetSentTo } = await import("../assets.js");
    expect(await wasAssetSentTo(door.deviceId, f.id)).toBeTruthy();
    expect(await wasAssetSentTo(other.deviceId, f.id)).toBeFalsy();
  });

  it("refuses an id that is not a font, and a font that a theme uses cannot be deleted", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
    const image = await (await operator.raw("POST", "/assets/media?name=Logo", { body: png, headers: { "content-type": "application/octet-stream" } })).json();
    expect((await operator.request("POST", "/themes", { name: "Bad", fonts: { body: image.id } })).status).toBe(400);
    expect((await operator.request("POST", "/themes", { name: "Bad", fonts: { body: "missing" } })).status).toBe(400);
    expect((await operator.request("POST", "/themes", { name: "Bad", fonts: { sparkle: image.id } })).status).toBe(400);

    const f = await font();
    await theme("Branded", { fonts: { body: f.id } });
    const refused = await operator.request("DELETE", `/assets/${f.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("Branded");
    expect((await operator.raw("PUT", `/assets/${f.id}/file`, { body: woff2, headers: { "content-type": "application/octet-stream" } })).status).toBe(400);
  });
});

describe("theme bundles", () => {
  const woff2 = Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(40, 7)]);
  const manifest = (extra: object = {}) => ({ name: "Brand", tokens: tokens(), fontNames: { heading: "display-font" }, ...extra });
  const bundle = (files: Record<string, Uint8Array | string | object>) =>
    Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, value instanceof Uint8Array ? value : strToU8(typeof value === "string" ? value : JSON.stringify(value))]))));
  const send = (client: ApiClient, zip: Buffer, query = "") => client.raw("POST", `/themes/import${query}`, { body: zip, headers: { "content-type": "application/zip" } });
  const valid = () => bundle({ "theme.json": manifest(), "fonts/display-font.woff2": woff2, "brand.css": ".card { gap: 1rem }" });

  it("makes the theme and puts its fonts in the library, in one upload", async () => {
    const res = await send(operator, valid());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ created: true, theme: { name: "Brand", css: ".card { gap: 1rem }" }, fonts: [{ slot: "heading", name: "display-font", reused: false }] });
    expect(body.theme.fonts.heading).toBeTruthy();
    const library = (await operator.request("GET", "/assets?kind=font")).body.items;
    expect(library).toHaveLength(1);
    expect(library[0].id).toBe(body.theme.fonts.heading);
    expect(await AuditLogModel.countDocuments({ action: "theme.create" })).toBe(1);
  });

  it("takes the CSS of theme.json over the one of the .css file, and works without fonts", async () => {
    const zip = bundle({ "theme.json": { name: "Plain", tokens: tokens(), css: "a { color: red }" }, "other.css": "b { color: blue }" });
    expect((await (await send(operator, zip)).json()).theme.css).toBe("a { color: red }");
  });

  it("stores a font once: importing again reuses it, and the same name is refused unless replace is asked for", async () => {
    await send(operator, valid());
    const again = await send(operator, valid());
    expect(again.status).toBe(409);
    const replaced = await send(operator, valid(), "?replace=1");
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({ created: false, theme: { version: 2 }, fonts: [{ reused: true }] });
    expect((await operator.request("GET", "/assets?kind=font")).body.items).toHaveLength(1);
  });

  it("changes nothing when anything in the bundle is wrong", async () => {
    const bad = async (zip: Buffer, status: number) => expect((await send(operator, zip)).status).toBe(status);
    await bad(Buffer.from("not a zip at all"), 400);
    await bad(bundle({ "readme.txt": "hi" }), 400);
    await bad(bundle({ "theme.json": "{nope" }), 400);
    await bad(bundle({ "theme.json": manifest({ tokens: { colors: { primary: "blue" } } }), "display-font.woff2": woff2 }), 400);
    await bad(bundle({ "theme.json": manifest({ css: "a { background: url(https://evil.example/x) }" }), "display-font.woff2": woff2 }), 400);
    await bad(bundle({ "theme.json": manifest() }), 400);
    await bad(bundle({ "theme.json": manifest({ fontNames: { sparkle: "display-font" } }), "display-font.woff2": woff2 }), 400);
    await bad(bundle({ "theme.json": manifest(), "display-font.woff2": Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>") }), 415);
    await bad(bundle({ "theme.json": manifest(), "display-font.woff2": new Uint8Array(2 * 1024 * 1024 + 1) }), 413);
    await bad(bundle(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}.txt`, "x"]))), 400);
    expect(await ThemeModel.countDocuments()).toBe(0);
    expect(await AssetModel.countDocuments()).toBe(0);
  });

  it("is for admins and operators only, and ignores archive junk and folders", async () => {
    expect((await send(staff, valid())).status).toBe(403);
    expect((await send(h.anonymous, valid())).status).toBe(401);
    const noisy = bundle({ "__MACOSX/._theme.json": "junk", ".DS_Store": "junk", "theme.json": manifest(), "Brand/fonts/display-font.woff2": woff2 });
    expect((await send(operator, noisy)).status).toBe(201);
  });
});

describe("emergency theming", () => {
  const dressed = { fonts: true, frame: "bar", radius: 2, colors: { background: "#001070", card: "#0a1a8a" } };

  it("keeps a closed, validated set, and refuses a background white text could not be read on", async () => {
    const make = (emergency: object) => operator.request("POST", "/themes", { name: `T${Math.random()}`, tokens: tokens(), emergency });
    const ok = await make(dressed);
    expect(ok.status).toBe(201);
    expect(ok.body.emergency).toMatchObject(dressed);
    expect((await make({ colors: { background: "#ffffff" } })).status).toBe(400);
    expect((await make({ colors: { accent: "#000000" } })).status).toBe(400);
    expect((await make({ frame: "disco" })).status).toBe(400);
    expect((await make({ css: "a { display: none }" })).status).toBe(400);
    expect((await operator.request("GET", "/themes/schema")).body).toMatchObject({ emergencyFrames: ["stripes", "bar"], emergencyMinContrast: 4.5 });
  });

  it("is sent to the devices that wear the theme, and nothing about alerts is sent when the theme has none", async () => {
    const plain = await theme("Plain");
    const branded = await theme("Branded", { emergency: dressed });
    const door = await h.enrollDevice({ type: "door" });
    await assign("device", door.deviceId, plain.id);
    expect(((await latest(door.deviceId))?.theme as any).emergency).toBeUndefined();
    await assign("device", door.deviceId, branded.id);
    expect(((await latest(door.deviceId))?.theme as any).emergency).toMatchObject(dressed);
  });

  it("comes with a theme bundle", async () => {
    const zip = Buffer.from(zipSync({ "theme.json": strToU8(JSON.stringify({ name: "Bundle", tokens: tokens(), emergency: dressed })) }));
    const res = await operator.raw("POST", "/themes/import", { body: zip, headers: { "content-type": "application/zip" } });
    expect(res.status).toBe(201);
    expect((await res.json()).theme.emergency).toMatchObject(dressed);
    const bad = Buffer.from(zipSync({ "theme.json": strToU8(JSON.stringify({ name: "Bad", tokens: tokens(), emergency: { colors: { background: "#ffffff" } } })) }));
    expect((await operator.raw("POST", "/themes/import", { body: bad, headers: { "content-type": "application/zip" } })).status).toBe(400);
  });
});

