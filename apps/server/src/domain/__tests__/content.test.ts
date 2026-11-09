import { createHash } from "node:crypto";
import { signRequest } from "@smartcampus/handshake";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AssetModel } from "../../models/asset.js";
import { AuditLogModel } from "../../models/auditLog.js";
import { CommandModel } from "../../models/command.js";
import { ContentModel } from "../../models/content.js";
import { DeviceModel } from "../../models/device.js";
import { startHarness, type ApiClient, type Harness } from "../../testing/harness.js";

let h: Harness;
let admin: ApiClient;
let operator: ApiClient;
let staff: ApiClient;

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const mp4 = Buffer.concat([Buffer.from("\0\0\0\x20ftypisom", "latin1"), Buffer.alloc(64, 9)]);
const m4a = Buffer.concat([Buffer.from("\0\0\0\x20ftypM4A ", "latin1"), Buffer.alloc(64)]);
const wav = Buffer.concat([Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt ", "latin1"), Buffer.alloc(64)]);

beforeAll(async () => {
  h = await startHarness();
  [admin, operator, staff] = await Promise.all([h.login("admin"), h.login("operator"), h.login("staff")]);
}, 120_000);
afterAll(() => h.stop());

beforeEach(async () => {
  await Promise.all([DeviceModel.deleteMany({}), CommandModel.deleteMany({}), ContentModel.deleteMany({}), AssetModel.deleteMany({}), AuditLogModel.deleteMany({})]);
});

const media = (client: ApiClient, data: Buffer, name = "Poster") =>
  client.raw("POST", `/assets/media?name=${encodeURIComponent(name)}`, { body: data, headers: { "content-type": "application/octet-stream" } });
const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
const slide = (extra: object = {}) => operator.request("POST", "/content", { kind: "text", text: "Open day on Saturday", targets: { all: true }, ...extra });

/** A Faculty screen set to the given mode. */
async function display(mode: "default" | "custom" | "mixed" = "custom", groups: string[] = []) {
  const device = await h.enrollDevice({ type: "display", groups });
  expect((await operator.request("PUT", `/faculty/displays/${device.deviceId}/config`, { mode })).status).toBe(200);
  await CommandModel.deleteMany({ deviceId: device.deviceId });
  return device;
}
const latestPlaylist = async (deviceId: string) => {
  const cmd = await CommandModel.findOne({ deviceId, type: "content.set", status: { $ne: "superseded" } }).sort({ commandId: -1 });
  return (cmd?.payload as { items: { id: string; kind: string; asset?: { assetId: string; sha256: string; size: number; mime: string } }[] } | undefined)?.items;
};

describe("media library", () => {
  it("stores an image or a video with its kind, hash and size taken from the bytes", async () => {
    const image = await (await media(operator, png)).json();
    expect(image).toMatchObject({ kind: "image", mime: "image/png", size: png.length, sha256: createHash("sha256").update(png).digest("hex") });
    expect(await (await media(operator, mp4, "Intro")).json()).toMatchObject({ kind: "video", mime: "video/mp4" });
    expect(await AuditLogModel.countDocuments({ action: "asset.upload", "meta.kind": "image" })).toBe(1);
  });

  it("refuses SVG, scripts, a sound and an empty file, whatever the Content-Type says", async () => {
    expect((await media(operator, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'.padEnd(64)))).status).toBe(415);
    expect((await media(operator, Buffer.from("<script>alert(1)</script>".padEnd(64)))).status).toBe(415);
    expect((await media(operator, wav)).status).toBe(415);
    expect((await media(operator, m4a)).status).toBe(415);
    expect((await media(operator, Buffer.alloc(0))).status).toBe(400);
  });

  it("is closed to staff and anonymous visitors", async () => {
    expect((await media(staff, png)).status).toBe(403);
    expect((await h.anonymous.raw("POST", "/assets/media?name=x", { body: png })).status).toBe(401);
  });

  it("lists sounds by default and media on request, so the sound library is unchanged", async () => {
    await operator.raw("POST", "/assets?name=Bell", { body: wav, headers: { "content-type": "audio/wav" } });
    await media(operator, png);
    await media(operator, mp4, "Intro");
    expect((await operator.request("GET", "/assets")).body.items.map((a: { kind: string }) => a.kind)).toEqual(["audio"]);
    expect((await operator.request("GET", "/assets?kind=image")).body.items).toHaveLength(1);
    expect((await operator.request("GET", "/assets?kind=video")).body.items[0].mime).toBe("video/mp4");
    expect((await operator.request("GET", "/assets?kind=document")).status).toBe(400);
  });
});

describe("content library", () => {
  it("creates, edits and deletes slides of each kind, with an audit trail", async () => {
    const image = await (await media(operator, png)).json();
    const made = await Promise.all([
      slide(),
      slide({ kind: "image", assetId: image.id, text: undefined, fit: "cover", durationSeconds: 20 }),
      slide({ kind: "web", url: "https://example.org/live", refreshSeconds: 60, text: undefined }),
    ]);
    expect(made.map((m) => m.status)).toEqual([201, 201, 201]);
    expect(made[1]!.body).toMatchObject({ kind: "image", assetId: image.id, fit: "cover", durationSeconds: 20, state: "live", displayCount: 0 });

    const id = made[0]!.body.id;
    const edited = await operator.request("PUT", `/content/${id}`, { kind: "text", text: "Open day moved", title: "News", targets: { all: true }, enabled: false });
    expect(edited.body).toMatchObject({ text: "Open day moved", title: "News", enabled: false, state: "paused" });
    expect((await operator.request("DELETE", `/content/${id}`)).status).toBe(204);
    expect((await operator.request("DELETE", `/content/${id}`)).status).toBe(404);
    expect((await operator.request("GET", "/content")).body.items).toHaveLength(2);
    expect(await AuditLogModel.countDocuments({ action: /^content\./ })).toBe(5);
  });

  it("keeps only what applies to the kind, so a slide never carries a stale file or address", async () => {
    const image = await (await media(operator, png)).json();
    const { body } = await slide({ kind: "image", assetId: image.id, text: "ignored", url: "https://example.org", fit: "contain" });
    expect(body).toMatchObject({ kind: "image", text: null, url: null });
    const text = await operator.request("PUT", `/content/${body.id}`, { kind: "text", text: "Now text", assetId: image.id, targets: { all: true } });
    expect(text.body).toMatchObject({ kind: "text", assetId: null });
  });

  it("refuses a slide that lacks what its kind needs, a file of the wrong kind, an unknown file, unsafe addresses and bad times", async () => {
    const image = await (await media(operator, png)).json();
    const video = await (await media(operator, mp4, "Intro")).json();
    const bad = [
      { kind: "image" },
      { kind: "image", assetId: "nope" },
      { kind: "image", assetId: video.id },
      { kind: "video", assetId: image.id },
      { kind: "text", text: undefined },
      { kind: "web", url: "javascript:alert(1)", text: undefined },
      { kind: "web", url: "ftp://example.org/x", text: undefined },
      { durationSeconds: 1 },
      { durationSeconds: 601 },
      { startsAt: hours(3), endsAt: hours(2) },
      { endsAt: hours(-1) },
      { fit: "stretch" },
      { targets: { all: true, admin: true } },
      { unknown: true },
    ];
    for (const extra of bad) expect((await slide(extra)).status, JSON.stringify(extra)).toBe(400);
    expect(await ContentModel.countDocuments()).toBe(0);
  });

  it("is a management tool: staff cannot read or write it", async () => {
    expect((await staff.request("GET", "/content")).status).toBe(403);
    expect((await staff.request("POST", "/content", {})).status).toBe(403);
    expect((await h.anonymous.request("GET", "/content")).status).toBe(401);
  });

  it("says how many Faculty screens a slide reaches, and whether it is live, scheduled or over", async () => {
    await display("custom", ["lobby"]);
    await display("custom");
    await h.enrollDevice({ type: "door", groups: ["lobby"] });
    expect((await slide({ targets: { groups: ["lobby"] } })).body.displayCount).toBe(1);
    expect((await slide({ targets: { all: true } })).body.displayCount).toBe(2);
    expect((await slide({ startsAt: hours(2) })).body.state).toBe("scheduled");
    const over = await slide({ endsAt: hours(1) });
    await ContentModel.updateOne({ contentId: over.body.id }, { $set: { endsAt: new Date(Date.now() - 1000) } });
    expect((await operator.request("GET", `/content/${over.body.id}`)).body.state).toBe("over");
  });

  it("will not delete a file that a slide still uses", async () => {
    const image = await (await media(operator, png)).json();
    const made = await slide({ kind: "image", assetId: image.id, text: undefined });
    expect((await admin.request("DELETE", `/assets/${image.id}`)).status).toBe(409);
    await operator.request("DELETE", `/content/${made.body.id}`);
    expect((await admin.request("DELETE", `/assets/${image.id}`)).status).toBe(204);
  });
});

describe("playlist on the screens", () => {
  it("sends the slides to a screen in custom or mixed mode, with the file reference taken from the library", async () => {
    const image = await (await media(operator, png)).json();
    const { deviceId } = await display("custom");
    const made = await slide({ kind: "image", assetId: image.id, text: undefined, durationSeconds: 25 });

    const items = await latestPlaylist(deviceId);
    expect(items).toHaveLength(1);
    expect(items![0]).toMatchObject({ id: made.body.id, kind: "image", durationSeconds: 25, asset: { assetId: image.id, sha256: image.sha256, size: png.length, mime: "image/png" } });
    expect((await display("mixed")).deviceId).toBeTruthy();
  });

  it("sends nothing to a screen that shows only the information board, and clears it when switched back", async () => {
    const { deviceId } = await display("default");
    await slide();
    expect(await latestPlaylist(deviceId)).toEqual([]);

    await operator.request("PUT", `/faculty/displays/${deviceId}/config`, { mode: "custom" });
    expect(await latestPlaylist(deviceId)).toHaveLength(1);
    await operator.request("PUT", `/faculty/displays/${deviceId}/config`, { mode: "default" });
    expect(await latestPlaylist(deviceId)).toEqual([]);
  });

  it("targets slides like announcements: by group, device or everyone, and never to a door", async () => {
    const lobby = await display("custom", ["lobby"]);
    const other = await display("custom", ["library"]);
    const door = await h.enrollDevice({ type: "door", groups: ["lobby"] });
    await slide({ text: "For the lobby", targets: { groups: ["lobby"] } });
    await slide({ text: "For one screen", targets: { devices: [other.deviceId] } });
    await slide({ text: "For everyone", targets: { all: true } });

    expect(await Promise.all([lobby, other].map(async (d) => (await latestPlaylist(d.deviceId))?.length))).toEqual([2, 2]);
    expect(await CommandModel.countDocuments({ deviceId: door.deviceId, type: "content.set" })).toBe(0);
  });

  it("leaves out paused slides and slides that are over, and updates when one is edited or deleted", async () => {
    const { deviceId } = await display("custom");
    const live = await slide({ text: "Live" });
    const paused = await slide({ text: "Paused", enabled: false });
    const over = await slide({ text: "Over", endsAt: hours(1) });
    await ContentModel.updateOne({ contentId: over.body.id }, { $set: { endsAt: new Date(Date.now() - 1000) } });
    await operator.request("PUT", `/content/${live.body.id}`, { kind: "text", text: "Live", targets: { all: true }, title: "Renamed" });

    const items = await latestPlaylist(deviceId);
    expect(items!.map((i) => i.id)).toEqual([live.body.id]);
    expect((items![0] as { title?: string }).title).toBe("Renamed");
    await operator.request("PUT", `/content/${paused.body.id}`, { kind: "text", text: "Paused", targets: { all: true }, enabled: true });
    expect((await latestPlaylist(deviceId))!.length).toBe(2);
    await operator.request("DELETE", `/content/${live.body.id}`);
    expect((await latestPlaylist(deviceId))!.length).toBe(1);
  });

  it("carries the schedule as absolute times, so the screen applies it by itself", async () => {
    const { deviceId } = await display("custom");
    const start = new Date(Date.now() + 3_600_000);
    const end = new Date(Date.now() + 7_200_000);
    await slide({ startsAt: start.toISOString(), endsAt: end.toISOString() });
    const [item] = (await latestPlaylist(deviceId))! as { startsAt?: number; endsAt?: number }[];
    expect(item).toMatchObject({ startsAt: start.getTime(), endsAt: end.getTime() });
  });

  it("is rebuilt when the screen connects, and not stored in the digital twin", async () => {
    const { identity, deviceId } = await display("custom");
    await slide({ text: "First" });
    await slide({ text: "Second" });
    const dev = h.connectDevice(deviceId, identity);
    await dev.ready;
    const ready = await dev.next("session.ready");
    expect(ready.payload.desired).not.toHaveProperty("content");
    const playlist = await dev.next("content.set");
    expect(playlist.payload.items.map((i) => (i as { text?: string }).text).sort()).toEqual(["First", "Second"]);
    dev.close();
  });

  it("keeps at most the slides a frame can carry", async () => {
    const { deviceId } = await display("custom");
    for (let i = 0; i < 26; i++) await ContentModel.create({ contentId: `c${String(i).padStart(2, "0")}`, kind: "text", text: `Slide ${i}`, targets: { all: true }, createdByName: "x" });
    await slide({ text: "One more" });
    expect((await latestPlaylist(deviceId))!.length).toBe(24);
  });
});

describe("Faculty site settings and logo", () => {
  it("stores the site details and mode, and rebuilds the logo reference from the library", async () => {
    const logo = await (await media(operator, png, "Logo")).json();
    const { deviceId } = await h.enrollDevice({ type: "display" });
    const res = await operator.request("PUT", `/faculty/displays/${deviceId}/config`, {
      mode: "mixed",
      site: {
        name: "Faculty of Engineering",
        subtitle: "Information desk: A101",
        zone: "Building 2",
        assemblyPoint: "Car park A",
        emergencyNumber: "112",
        // The client states a wrong hash and size: the server must not pass them on.
        logo: { assetId: logo.id, sha256: "f".repeat(64), size: 1, mime: "image/png" },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.site).toMatchObject({ name: "Faculty of Engineering", assemblyPoint: "Car park A", emergencyNumber: "112", logo: { assetId: logo.id, sha256: logo.sha256, size: png.length } });
    const sent = await CommandModel.findOne({ deviceId, type: "faculty.config.set" });
    expect((sent?.payload as { config: { site: { logo: { sha256: string } } } }).config.site.logo.sha256).toBe(logo.sha256);
  });

  it("refuses a logo that is not an image of the library, and a file that disappears from under a logo", async () => {
    const video = await (await media(operator, mp4, "Intro")).json();
    const { deviceId } = await h.enrollDevice({ type: "display" });
    const put = (logo: object) => operator.request("PUT", `/faculty/displays/${deviceId}/config`, { site: { logo } });
    expect((await put({ assetId: video.id, sha256: video.sha256, size: mp4.length, mime: "video/mp4" })).status).toBe(400);
    expect((await put({ assetId: "nope", sha256: "a".repeat(64), size: 10, mime: "image/png" })).status).toBe(400);

    const logo = await (await media(operator, png, "Logo")).json();
    expect((await put({ assetId: logo.id, sha256: logo.sha256, size: png.length, mime: "image/png" })).status).toBe(200);
    expect((await admin.request("DELETE", `/assets/${logo.id}`)).status).toBe(409);
  });

  it("keeps the defaults for a screen that was configured before these settings existed", async () => {
    const { deviceId } = await h.enrollDevice({ type: "display" });
    const res = await operator.request("PUT", `/faculty/displays/${deviceId}/config`, { service: "pedagogical" });
    expect(res.body).toMatchObject({ mode: "default", site: { name: "", logo: null } });
  });
});

describe("signed download of slides", () => {
  const path = (id: string) => `/api/assets/${id}/download`;
  const get = (id: string, deviceId: string, signed: ReturnType<typeof signRequest>) =>
    fetch(`${h.origin}${path(id)}`, { headers: { "x-device-id": deviceId, "x-timestamp": signed.timestamp, "x-signature": signed.signature } });

  it("serves a slide's file to the screen whose playlist names it, and to nobody else", async () => {
    const image = await (await media(operator, png)).json();
    const mine = await display("custom");
    const stranger = await display("custom");
    await slide({ kind: "image", assetId: image.id, text: undefined, targets: { devices: [mine.deviceId] } });

    const ok = await get(image.id, mine.deviceId, signRequest(mine.identity.privateKey, "GET", path(image.id)));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("x-content-sha256")).toBe(image.sha256);
    expect(Buffer.from(await ok.arrayBuffer()).equals(png)).toBe(true);
    expect((await get(image.id, stranger.deviceId, signRequest(stranger.identity.privateKey, "GET", path(image.id)))).status).toBe(404);
  });

  it("serves the logo to the screen configured with it", async () => {
    const logo = await (await media(operator, png, "Logo")).json();
    const device = await h.enrollDevice({ type: "display" });
    expect((await get(logo.id, device.deviceId, signRequest(device.identity.privateKey, "GET", path(logo.id)))).status).toBe(404);
    await operator.request("PUT", `/faculty/displays/${device.deviceId}/config`, { site: { logo: { assetId: logo.id, sha256: logo.sha256, size: png.length, mime: "image/png" } } });
    expect((await get(logo.id, device.deviceId, signRequest(device.identity.privateKey, "GET", path(logo.id)))).status).toBe(200);
  });
});
