import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OpenAiCompatibleTts, parseVoices, setTtsEngine } from "../../infra/tts.js";
import { AnnouncementModel } from "../../models/announcement.js";
import { AssetModel } from "../../models/asset.js";
import { AuditLogModel } from "../../models/auditLog.js";
import { CommandModel } from "../../models/command.js";
import { DeviceModel } from "../../models/device.js";
import { readWav } from "../../lib/wav.js";
import { fakeEngine, tinyWav } from "../../testing/fakeTts.js";
import { startHarness, type ApiClient, type Harness } from "../../testing/harness.js";

let h: Harness;
let operator: ApiClient;
let staff: ApiClient;

beforeAll(async () => {
  h = await startHarness();
  [operator, staff] = await Promise.all([h.login("operator"), h.login("staff")]);
}, 120_000);
afterAll(() => h.stop());

beforeEach(async () => {
  await Promise.all([DeviceModel.deleteMany({}), CommandModel.deleteMany({}), AnnouncementModel.deleteMany({}), AssetModel.deleteMany({}), AuditLogModel.deleteMany({})]);
});
afterEach(() => setTtsEngine(undefined));

describe("voice announcements", () => {
  it("lists the voices with their language, and says when there is no engine", async () => {
    setTtsEngine(fakeEngine());
    const on = await operator.request("GET", "/intercom/voices");
    expect(on.body).toMatchObject({ enabled: true, maxChars: 1000 });
    expect(on.body.voices.map((v: { id: string; language: string }) => `${v.id}:${v.language}`)).toEqual(["nova:fr", "alloy:en"]);

    setTtsEngine(null);
    expect((await operator.request("GET", "/intercom/voices")).body).toMatchObject({ enabled: false, voices: [] });
  });

  it("pre-listening returns audio and stores and sends nothing", async () => {
    const engine = fakeEngine();
    setTtsEngine(engine);
    const { deviceId } = await h.enrollDevice();

    const res = await operator.raw("POST", "/intercom/speech/preview", {
      body: Buffer.from(JSON.stringify({ text: "Bonjour à tous", voice: "nova" })),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString()).toBe("RIFF");

    expect(engine.calls).toEqual([{ text: "Bonjour à tous", voice: "nova", language: "fr" }]);
    expect(await AssetModel.countDocuments()).toBe(0);
    expect(await CommandModel.countDocuments({ deviceId })).toBe(0);
  });

  it("speaking keeps the sound in the library and plays it on the chosen screens", async () => {
    const engine = fakeEngine();
    setTtsEngine(engine);
    const { identity, deviceId } = await h.enrollDevice();
    const dev = h.connectDevice(deviceId, identity);
    await dev.ready;
    await dev.next("session.ready");

    const res = await operator.request("POST", "/intercom/speech", { text: "Closing in ten minutes", voice: "alloy", targets: { devices: [deviceId] } });
    expect(res.status).toBe(201);
    expect(res.body.deviceCount).toBe(1);

    const play = await dev.next("audio.play");
    const asset = await AssetModel.findOne({ assetId: play.payload.assetId });
    expect(asset?.name).toBe("Voice: Closing in ten minutes");
    expect(play.payload).toMatchObject({ sha256: asset?.sha256, urgent: false });
    expect(engine.calls[0]).toMatchObject({ voice: "alloy", language: "en" });
    expect(await AuditLogModel.countDocuments({ action: "intercom.broadcast" })).toBe(1);
    dev.close();
  });

  it("uses the first voice when none is chosen and refuses an unknown one", async () => {
    const engine = fakeEngine();
    setTtsEngine(engine);
    const { deviceId } = await h.enrollDevice();
    await operator.request("POST", "/intercom/speech", { text: "Hello", targets: { devices: [deviceId] } });
    expect(engine.calls[0]!.voice).toBe("nova");
    expect((await operator.request("POST", "/intercom/speech/preview", { text: "Hello", voice: "ghost" })).status).toBe(400);
  });

  it("answers 501 without an engine", async () => {
    setTtsEngine(null);
    const { deviceId } = await h.enrollDevice();
    expect((await operator.request("POST", "/intercom/speech/preview", { text: "Hello" })).status).toBe(501);
    expect((await operator.request("POST", "/intercom/speech", { text: "Hello", targets: { devices: [deviceId] } })).status).toBe(501);
  });

  it("validates the text and the targets, and is closed to staff", async () => {
    setTtsEngine(fakeEngine());
    const { deviceId } = await h.enrollDevice();
    const targets = { devices: [deviceId] };
    expect((await operator.request("POST", "/intercom/speech", { text: "", targets })).status).toBe(400);
    expect((await operator.request("POST", "/intercom/speech", { text: "x".repeat(1001), targets })).status).toBe(400);
    expect((await operator.request("POST", "/intercom/speech", { text: "Hello", targets: { groups: ["nobody"] } })).status).toBe(400);
    expect((await staff.request("POST", "/intercom/speech", { text: "Hello", targets })).status).toBe(403);
    expect((await staff.request("POST", "/intercom/speech/preview", { text: "Hello" })).status).toBe(403);
    expect((await h.anonymous.request("GET", "/intercom/voices")).status).toBe(401);
  });

  it("refuses an engine reply that is not audio", async () => {
    setTtsEngine({ voices: () => [{ id: "v", label: "V", language: "en" }], synthesize: async () => Buffer.from("<html>error page</html>") });
    expect((await operator.request("POST", "/intercom/speech/preview", { text: "Hello" })).status).toBe(502);
  });
});

describe("OpenAI-compatible engine", () => {
  let server: Server;
  let url: string;
  let seen: { path?: string; auth?: string; body?: Record<string, unknown> } = {};
  let mode: "ok" | "error" | "huge" = "ok";

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen = { path: req.url, auth: req.headers.authorization, body: JSON.parse(raw) };
        if (mode === "error") return res.writeHead(500).end("secret internal detail");
        res.writeHead(200, { "content-type": "audio/wav" }).end(mode === "huge" ? Buffer.alloc(2000) : tinyWav());
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
  });
  afterAll(() => void server.close());

  const engine = (maxBytes = 1_000_000) =>
    new OpenAiCompatibleTts({ baseUrl: url, apiKey: "k", model: "m", timeoutMs: 2000, maxBytes, voices: parseVoices("a|A|fr") });

  it("sends the pace only when one is given", async () => {
    mode = "ok";
    await engine().synthesize({ text: "x", voice: "a", language: "fr", speed: 0.85 });
    expect(seen.body).toMatchObject({ speed: 0.85 });
    await engine().synthesize({ text: "x", voice: "a", language: "fr" });
    expect(seen.body).not.toHaveProperty("speed");
  });

  it("posts the text, voice, language and key to /audio/speech", async () => {
    mode = "ok";
    const data = await engine().synthesize({ text: "Salut", voice: "a", language: "fr" });
    expect(data.subarray(0, 4).toString()).toBe("RIFF");
    expect(seen).toMatchObject({ path: "/v1/audio/speech", auth: "Bearer k", body: { model: "m", input: "Salut", voice: "a", language: "fr" } });
  });

  it("reports a refusal without leaking what the engine said", async () => {
    mode = "error";
    await expect(engine().synthesize({ text: "x", voice: "a", language: "fr" })).rejects.toMatchObject({ status: 502, message: expect.not.stringContaining("secret") });
  });

  it("refuses audio larger than the upload limit, and an unreachable engine", async () => {
    mode = "huge";
    await expect(engine(1000).synthesize({ text: "x", voice: "a", language: "fr" })).rejects.toMatchObject({ status: 502 });
    const dead = new OpenAiCompatibleTts({ baseUrl: "http://127.0.0.1:1", model: "m", timeoutMs: 500, maxBytes: 10, voices: parseVoices("a|A|fr") });
    await expect(dead.synthesize({ text: "x", voice: "a", language: "fr" })).rejects.toMatchObject({ status: 502 });
  });
});

describe("parseVoices", () => {
  it("reads id|label|language entries", () => {
    expect(parseVoices(" a|Alpha|FR , b|Beta|en ")).toEqual([
      { id: "a", label: "Alpha", language: "fr" },
      { id: "b", label: "Beta", language: "en" },
    ]);
  });
  it("rejects a malformed or empty list instead of skipping it", () => {
    expect(() => parseVoices("a|Alpha")).toThrow(/id\|label\|language/);
    expect(() => parseVoices(" , ")).toThrow(/at least one/);
  });
});

describe("chimes before a voice", () => {
  const preview = (body: object) =>
    operator.raw("POST", "/intercom/speech/preview", { body: Buffer.from(JSON.stringify(body)), headers: { "content-type": "application/json" } });

  it("asks the engine for a WAV and puts the chosen chime in front of the voice", async () => {
    const engine = fakeEngine({ pcm16: true });
    setTtsEngine(engine);
    const plain = readWav(Buffer.from(await (await preview({ text: "Bonjour", voice: "nova" })).arrayBuffer()))!;
    const urgent = readWav(Buffer.from(await (await preview({ text: "Bonjour", voice: "nova", chime: "critical-buzwarn" })).arrayBuffer()))!;
    expect(engine.calls[1]).toMatchObject({ format: "wav" });
    expect(engine.calls[0]!.format).toBeUndefined();
    expect(urgent.samples.length).toBeGreaterThan(plain.samples.length + 24_000);
    expect(urgent.samples.slice(-plain.samples.length)).toEqual(plain.samples);
  });

  it("speaking with a chime stores the joined sound and sends it to the screens", async () => {
    setTtsEngine(fakeEngine({ pcm16: true }));
    const { deviceId } = await h.enrollDevice();
    const res = await operator.request("POST", "/intercom/speech", { text: "Alerte", voice: "nova", chime: "warning-dadaa", targets: { devices: [deviceId] } });
    expect(res.status).toBe(201);
    const asset = await AssetModel.findOne();
    expect(asset!.size).toBeGreaterThan(2 * 24_000);
    expect((await CommandModel.findOne({ deviceId, type: "audio.play" }))!.payload).toMatchObject({ size: asset!.size });
  });

  it("sends the voice as it is when the engine cannot return a WAV, and refuses an unknown severity", async () => {
    setTtsEngine(fakeEngine());
    const res = await preview({ text: "Bonjour", voice: "nova", chime: "info-dudu" });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).length).toBe(tinyWav().length + "Bonjour".length);
    expect((await preview({ text: "Bonjour", chime: "loud" })).status).toBe(400);
  });

  it("lets the console pre-listen to each chime, for admins and operators only", async () => {
    const ok = await operator.raw("GET", "/intercom/chimes/critical-deeoo");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("audio/wav");
    expect(Buffer.from(await ok.arrayBuffer()).subarray(0, 4).toString()).toBe("RIFF");
    expect((await operator.raw("GET", "/intercom/chimes/deafening")).status).toBe(400);
    const catalogue = (await operator.request("GET", "/intercom/chimes")).body;
    expect(catalogue.groups.map((g: { id: string }) => g.id)).toEqual(["info", "warning", "critical", "manual-override"]);
    expect(catalogue.chimes).toHaveLength(11);
    expect((await staff.raw("GET", "/intercom/chimes")).status).toBe(403);
    expect((await staff.raw("GET", "/intercom/chimes/info-dudu")).status).toBe(403);
  });
});

