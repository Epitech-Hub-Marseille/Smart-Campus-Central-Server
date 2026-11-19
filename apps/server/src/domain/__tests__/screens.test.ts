import { createHash } from "node:crypto";
import { signRequest } from "@smartcampus/handshake";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AssetModel } from "../../models/asset.js";
import { AuditLogModel } from "../../models/auditLog.js";
import { CommandModel } from "../../models/command.js";
import { DeviceModel } from "../../models/device.js";
import { ScreenGroupModel } from "../../models/screenGroup.js";
import { ScreenLayerModel } from "../../models/screenLayer.js";
import { startHarness, type ApiClient, type Harness } from "../../testing/harness.js";

let h: Harness;
let operator: ApiClient;
let staff: ApiClient;

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const png2 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 8)]);
const mp4 = Buffer.concat([Buffer.from("\0\0\0\x20ftypisom", "latin1"), Buffer.alloc(64, 9)]);

beforeAll(async () => {
  h = await startHarness();
  [operator, staff] = await Promise.all([h.login("operator"), h.login("staff")]);
}, 120_000);
afterAll(() => h.stop());

beforeEach(async () => {
  await Promise.all([DeviceModel.deleteMany({}), CommandModel.deleteMany({}), AssetModel.deleteMany({}), AuditLogModel.deleteMany({}), ScreenGroupModel.deleteMany({}), ScreenLayerModel.deleteMany({})]);
});

const upload = (client: ApiClient, data: Buffer, name = "Poster", folder = "") =>
  client.raw("POST", `/assets/media?name=${encodeURIComponent(name)}&folder=${encodeURIComponent(folder)}`, { body: data, headers: { "content-type": "application/octet-stream" } });
const asset = async (data = png, name = "Poster") => (await (await upload(operator, data, name)).json()) as { id: string; sha256: string; kind: string };
const display = () => h.enrollDevice({ type: "display" });
const scene = (id: string, tiles: object[], extra: object = {}) => ({ id, name: id, layout: tiles.length === 2 ? "columns" : "full", tiles, ...extra });
const tile = (kind: string, settings: object = {}, id = `${kind}-${Math.random().toString(36).slice(2, 7)}`) => ({ id, kind, settings });
const latest = async (deviceId: string, type: string) => (await CommandModel.findOne({ deviceId, type, status: { $ne: "superseded" } }).sort({ commandId: -1 }))?.payload as any;
const scopeUrl = (scope: string, key = "-") => `/faculty/scopes/${scope}/${key}`;

describe("media library", () => {
  it("lists images and videos together, with folders, and renames or moves a file", async () => {
    const a = await (await upload(operator, png, "Logo", "Logos")).json();
    await upload(operator, mp4, "Intro");
    const list = (await operator.request("GET", "/assets?kind=media")).body;
    expect(list.items.map((i: { kind: string }) => i.kind).sort()).toEqual(["image", "video"]);
    expect(list.folders).toEqual(["Logos"]);

    const renamed = await operator.request("PATCH", `/assets/${a.id}`, { name: "Campus logo", folder: "Branding" });
    expect(renamed.body).toMatchObject({ name: "Campus logo", folder: "Branding" });
    expect((await staff.request("PATCH", `/assets/${a.id}`, { name: "x" })).status).toBe(403);
    expect((await operator.request("PATCH", `/assets/${a.id}`, { hack: 1 })).status).toBe(400);
  });

  it("replaces the content of a file, keeps its id, and refuses another kind", async () => {
    const a = await asset();
    const replaced = await operator.raw("PUT", `/assets/${a.id}/file`, { body: png2, headers: { "content-type": "application/octet-stream" } });
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({ id: a.id, sha256: createHash("sha256").update(png2).digest("hex") });
    expect((await operator.raw("PUT", `/assets/${a.id}/file`, { body: mp4, headers: { "content-type": "application/octet-stream" } })).status).toBe(409);
    expect((await operator.raw("PUT", `/assets/${a.id}/file`, { body: Buffer.from("<script>x</script>".padEnd(64)), headers: { "content-type": "application/octet-stream" } })).status).toBe(415);
  });
});

describe("groups", () => {
  it("are managed by admins and operators; a screen belongs to one group at most", async () => {
    const [a, b] = [await display(), await display()];
    const g1 = await operator.request("POST", "/faculty/groups", { name: "Building A", members: [a.deviceId, b.deviceId] });
    expect(g1.status).toBe(201);
    const g2 = await operator.request("POST", "/faculty/groups", { name: "Lobby", members: [b.deviceId] });
    expect(g2.status).toBe(201);
    const screens = (await operator.request("GET", "/faculty/screens")).body;
    expect(screens.groups.find((g: { name: string }) => g.name === "Building A").members).toEqual([a.deviceId]);
    expect(screens.displays.find((d: { id: string }) => d.id === b.deviceId).groupId).toBe(g2.body.id);
    expect((await staff.request("POST", "/faculty/groups", { name: "X" })).status).toBe(403);
    expect((await operator.request("POST", "/faculty/groups", { name: "Building A" })).status).toBe(409);
  });

  it("only take active Faculty screens", async () => {
    const door = await h.enrollDevice({ type: "door" });
    expect((await operator.request("POST", "/faculty/groups", { name: "Doors", members: [door.deviceId] })).status).toBe(400);
    expect((await operator.request("POST", "/faculty/groups", { name: "Ghost", members: ["nope"] })).status).toBe(400);
  });

  it("deleting a group sends its screens back to the default look and playlist", async () => {
    const a = await display();
    const g = (await operator.request("POST", "/faculty/groups", { name: "Building A", members: [a.deviceId] })).body;
    await operator.request("PUT", `${scopeUrl("group", g.id)}/config`, { site: { name: "Building A" } });
    expect((await latest(a.deviceId, "faculty.config.set")).config.site.name).toBe("Building A");
    expect((await operator.request("DELETE", `/faculty/groups/${g.id}`)).status).toBe(204);
    expect((await latest(a.deviceId, "faculty.config.set")).config.site.name).toBe("");
    expect(await ScreenLayerModel.countDocuments({ scope: "group", key: g.id })).toBe(0);
  });
});

describe("layered settings", () => {
  it("a screen's own value wins over its group's, which wins over the default, field by field", async () => {
    const a = await display();
    const b = await display();
    const g = (await operator.request("POST", "/faculty/groups", { name: "Building A", members: [a.deviceId, b.deviceId] })).body;
    await operator.request("PUT", `${scopeUrl("default")}/config`, { site: { name: "Campus", subtitle: "EPITECH" }, widgets: { clock: true, weather: false } });
    await operator.request("PUT", `${scopeUrl("group", g.id)}/config`, { site: { name: "Building A" }, widgets: { weather: true } });
    await operator.request("PUT", `${scopeUrl("device", a.deviceId)}/config`, { site: { name: "Reception" } });

    const forA = (await latest(a.deviceId, "faculty.config.set")).config;
    const forB = (await latest(b.deviceId, "faculty.config.set")).config;
    expect(forA).toMatchObject({ site: { name: "Reception", subtitle: "EPITECH" }, widgets: { clock: true, weather: true } });
    expect(forB).toMatchObject({ site: { name: "Building A", subtitle: "EPITECH" }, widgets: { weather: true } });

    // Changing the group later does not touch the field a screen set itself.
    await operator.request("PUT", `${scopeUrl("group", g.id)}/config`, { site: { name: "Building A (new)" } });
    expect((await latest(a.deviceId, "faculty.config.set")).config.site.name).toBe("Reception");
    expect((await latest(b.deviceId, "faculty.config.set")).config.site.name).toBe("Building A (new)");
  });

  it("shows, for the console, what a level sets and what it inherits", async () => {
    const a = await display();
    const g = (await operator.request("POST", "/faculty/groups", { name: "Building A", members: [a.deviceId] })).body;
    await operator.request("PUT", `${scopeUrl("default")}/config`, { site: { subtitle: "EPITECH" } });
    await operator.request("PUT", `${scopeUrl("group", g.id)}/config`, { site: { name: "Building A" } });
    const view = (await operator.request("GET", scopeUrl("device", a.deviceId))).body;
    expect(view).toMatchObject({ scope: "device", config: {}, scenes: null, group: { id: g.id }, inherited: { config: { site: { name: "Building A", subtitle: "EPITECH" } } } });
    expect(view.inherited.scenes.from).toBe("builtin");
  });

  it("resets one level to inheriting", async () => {
    const a = await display();
    await operator.request("PUT", `${scopeUrl("default")}/config`, { site: { name: "Campus" } });
    await operator.request("PUT", `${scopeUrl("device", a.deviceId)}/config`, { site: { name: "Own" } });
    await operator.request("DELETE", `${scopeUrl("device", a.deviceId)}/config`);
    expect((await latest(a.deviceId, "faculty.config.set")).config.site.name).toBe("Campus");
  });

  it("validates patches and permissions, and checks the logo is an image of the library", async () => {
    const a = await display();
    const img = await asset();
    const video = await asset(mp4, "Intro");
    expect((await operator.request("PUT", `${scopeUrl("device", a.deviceId)}/config`, { site: { logo: { assetId: img.id } } })).status).toBe(204);
    // What the screen receives carries the hash and size of the stored file, not what the request said.
    expect((await latest(a.deviceId, "faculty.config.set")).config.site.logo).toMatchObject({ assetId: img.id, sha256: img.sha256, mime: "image/png" });
    expect((await operator.request("PUT", `${scopeUrl("device", a.deviceId)}/config`, { site: { logo: { assetId: video.id } } })).status).toBe(400);
    expect((await operator.request("PUT", `${scopeUrl("device", a.deviceId)}/config`, { site: { logo: { assetId: "nope" } } })).status).toBe(400);
    expect((await operator.request("PUT", `${scopeUrl("device", a.deviceId)}/config`, { mode: "custom" })).status).toBe(400);
    expect((await staff.request("PUT", `${scopeUrl("device", a.deviceId)}/config`, {})).status).toBe(403);
    expect((await operator.request("GET", "/faculty/scopes/planet/x")).status).toBe(400);
  });
});

describe("playlists", () => {
  it("fall back to the built-in board, and the most specific playlist replaces the others whole", async () => {
    const a = await display();
    const b = await display();
    const g = (await operator.request("POST", "/faculty/groups", { name: "Building A", members: [a.deviceId, b.deviceId] })).body;
    expect((await latest(a.deviceId, "carousel.set")).scenes.map((s: { id: string }) => s.id)).toEqual(["builtin-news", "builtin-staff", "builtin-reservations"]);

    await operator.request("PUT", `${scopeUrl("default")}/playlist`, { scenes: [scene("d1", [tile("text", { text: "Campus-wide" })])] });
    expect((await latest(a.deviceId, "carousel.set")).scenes.map((s: { id: string }) => s.id)).toEqual(["d1"]);

    await operator.request("PUT", `${scopeUrl("group", g.id)}/playlist`, { scenes: [scene("g1", [tile("news")])] });
    expect((await latest(b.deviceId, "carousel.set")).scenes.map((s: { id: string }) => s.id)).toEqual(["g1"]);

    await operator.request("PUT", `${scopeUrl("device", a.deviceId)}/playlist`, { scenes: [scene("a1", [tile("staff")])] });
    expect((await latest(a.deviceId, "carousel.set")).scenes.map((s: { id: string }) => s.id)).toEqual(["a1"]);
    expect((await latest(b.deviceId, "carousel.set")).scenes.map((s: { id: string }) => s.id)).toEqual(["g1"]);

    // Clearing the screen's own playlist hands the decision back to its group.
    await operator.request("DELETE", `${scopeUrl("device", a.deviceId)}/playlist`);
    expect((await latest(a.deviceId, "carousel.set")).scenes.map((s: { id: string }) => s.id)).toEqual(["g1"]);
  });

  it("send every library file as a full reference taken from the stored record", async () => {
    const a = await display();
    const img = await asset();
    const vid = await asset(mp4, "Intro");
    const res = await operator.request("PUT", `${scopeUrl("device", a.deviceId)}/playlist`, {
      scenes: [scene("s", [tile("image", { asset: { assetId: img.id, sha256: "f".repeat(64), size: 1 } }), tile("video", { asset: { assetId: vid.id } })])],
    });
    expect(res.status).toBe(204);
    const sent = (await latest(a.deviceId, "carousel.set")).scenes[0].tiles;
    expect(sent[0].settings.asset).toMatchObject({ assetId: img.id, sha256: img.sha256, mime: "image/png" });
    expect(sent[1].settings.asset).toMatchObject({ assetId: vid.id, mime: "video/mp4" });
  });

  it("support live kinds, and normalise a YouTube address to its id", async () => {
    const a = await display();
    const res = await operator.request("PUT", `${scopeUrl("device", a.deviceId)}/playlist`, {
      scenes: [
        scene("live", [tile("youtube", { video: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }), tile("radio", { url: "https://radio.example.org/live.mp3", label: "Campus radio" })]),
        scene("cam", [tile("stream", { url: "https://cam.example.org/live.m3u8", format: "hls" })]),
      ],
    });
    expect(res.status).toBe(204);
    const sent = (await latest(a.deviceId, "carousel.set")).scenes;
    expect(sent[0].tiles[0].settings).toMatchObject({ video: "dQw4w9WgXcQ", muted: true });
    expect(sent[1].tiles[0].settings).toMatchObject({ format: "hls" });
  });

  it("refuse what the screens could not show", async () => {
    const a = await display();
    const img = await asset();
    const put = (scenes: object[]) => operator.request("PUT", `${scopeUrl("device", a.deviceId)}/playlist`, { scenes });
    expect((await put([scene("x", [tile("hologram")])])).status).toBe(400);
    expect((await put([scene("x", [tile("image")])])).status).toBe(400);
    expect((await put([scene("x", [tile("video", { asset: { assetId: img.id } })])])).status).toBe(400);
    expect((await put([scene("x", [tile("image", { asset: { assetId: "nope" } })])])).status).toBe(400);
    expect((await put([scene("x", [tile("web", { url: "javascript:alert(1)" })])])).status).toBe(400);
    expect((await put([scene("x", [tile("news")]), scene("x", [tile("staff")])])).status).toBe(400);
    expect((await put([{ ...scene("x", [tile("news"), tile("staff")]), layout: "full" }])).status).toBe(400);
    expect((await staff.request("PUT", `${scopeUrl("device", a.deviceId)}/playlist`, { scenes: [] })).status).toBe(403);
  });

  it("do not send a paused or finished scene", async () => {
    const a = await display();
    await operator.request("PUT", `${scopeUrl("device", a.deviceId)}/playlist`, {
      scenes: [scene("on", [tile("news")]), scene("paused", [tile("staff")], { enabled: false }), scene("over", [tile("news")], { startsAt: 1000, endsAt: 2000 })],
    });
    expect((await latest(a.deviceId, "carousel.set")).scenes.map((s: { id: string }) => s.id)).toEqual(["on"]);
  });

  it("a screen connecting gets its look and carousel, a door gets nothing", async () => {
    const door = await h.enrollDevice({ type: "door" });
    const a = await display();
    await operator.request("PUT", `${scopeUrl("default")}/config`, { site: { name: "Campus" } });
    const dev = h.connectDevice(a.deviceId, a.identity);
    await dev.ready;
    await dev.next("session.ready");
    expect((await dev.next("faculty.config.set")).payload.config.site.name).toBe("Campus");
    expect((await dev.next("carousel.set")).payload.scenes).toHaveLength(3);
    dev.close();
    expect(await CommandModel.countDocuments({ deviceId: door.deviceId, type: { $in: ["carousel.set", "faculty.config.set"] } })).toBe(0);
  });
});

describe("files in use", () => {
  it("cannot be deleted while a screen shows them, and the answer says where", async () => {
    const a = await display();
    const img = await asset();
    await operator.request("PUT", `${scopeUrl("device", a.deviceId)}/playlist`, { scenes: [scene("s", [tile("image", { asset: { assetId: img.id } })])] });
    const usage = (await operator.request("GET", `/assets/${img.id}/usage`)).body.items;
    expect(usage).toEqual([expect.objectContaining({ scope: "device", key: a.deviceId, as: "tile" })]);
    const blocked = await operator.request("DELETE", `/assets/${img.id}`);
    expect(blocked.status).toBe(409);
    await operator.request("DELETE", `${scopeUrl("device", a.deviceId)}/playlist`);
    expect((await operator.request("DELETE", `/assets/${img.id}`)).status).toBe(204);
  });

  it("a logo counts as use, and replacing a file sends screens the new hash", async () => {
    const a = await display();
    const img = await asset();
    await operator.request("PUT", `${scopeUrl("device", a.deviceId)}/config`, { site: { logo: { assetId: img.id } } });
    expect((await operator.request("DELETE", `/assets/${img.id}`)).status).toBe(409);
    expect((await operator.request("GET", `/assets/${img.id}/usage`)).body.items[0]).toMatchObject({ as: "logo" });

    const replaced = await (await operator.raw("PUT", `/assets/${img.id}/file`, { body: png2, headers: { "content-type": "application/octet-stream" } })).json();
    expect((await latest(a.deviceId, "faculty.config.set")).config.site.logo.sha256).toBe(replaced.sha256);
  });

  it("a screen may download only what its carousel or logo names", async () => {
    const a = await display();
    const shown = await asset();
    const other = await asset(png2, "Other");
    await operator.request("PUT", `${scopeUrl("device", a.deviceId)}/playlist`, { scenes: [scene("s", [tile("image", { asset: { assetId: shown.id } })])] });
    const download = (id: string) => {
      const path = `/api/assets/${id}/download`;
      const signed = signRequest(a.identity.privateKey, "GET", path);
      return h.anonymous.raw("GET", `/assets/${id}/download`, { headers: { "x-device-id": a.deviceId, "x-timestamp": signed.timestamp, "x-signature": signed.signature } });
    };
    expect((await download(shown.id)).status).toBe(200);
    expect((await download(other.id)).status).toBe(404);
  });
});
