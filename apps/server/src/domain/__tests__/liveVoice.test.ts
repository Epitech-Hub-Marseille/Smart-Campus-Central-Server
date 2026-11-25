import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LIVE_MAX_CHUNK_BYTES, LIVE_SAMPLE_RATE } from "@smartcampus/protocol";
import { WebSocket } from "ws";
import { startHarness, type ApiClient, type Harness } from "../../testing/harness.js";
import { AuditLogModel } from "../../models/auditLog.js";
import { CommandModel } from "../../models/command.js";
import { DeviceModel } from "../../models/device.js";
import { UserModel } from "../../models/user.js";
import type { TestDevice } from "../../gateway/__tests__/testDevice.js";
import { chimeChunks, liveActive } from "../liveVoice.js";

let h: Harness;
let admin: ApiClient;
let staff: ApiClient;

beforeAll(async () => {
  h = await startHarness();
  [admin, staff] = await Promise.all([h.login("admin"), h.login("staff")]);
}, 120_000);
afterAll(() => h.stop());

beforeEach(async () => {
  await Promise.all([DeviceModel.deleteMany({}), CommandModel.deleteMany({}), AuditLogModel.deleteMany({}), UserModel.deleteMany({ cardUid: { $exists: true } })]);
});

const OPERATOR = { name: "Olga Operator", email: "olga@campus.test", password: "correct-horse-battery", groups: ["operator"], cardUid: "04B33C2D" };
const STUDENT = { name: "Sam Student", cardUid: "04A22B1C" };

async function online(type: "door" | "display" = "display") {
  const { identity, deviceId } = await h.enrollDevice({ type });
  const dev: TestDevice = h.connectDevice(deviceId, identity);
  await dev.ready;
  await dev.next("session.ready");
  return { dev, deviceId };
}

const pcm = (samples = 800) => Buffer.alloc(samples * 2, 1);

/** The console's microphone: a socket on /ws/live with the session cookie and a way to read its answers. */
async function micSocket(client: ApiClient) {
  const ws = new WebSocket(`${h.origin.replace("http", "ws")}/ws/live`, { headers: { cookie: client.cookie ?? "" } });
  const answers: any[] = [];
  const waiting: Array<() => void> = [];
  ws.on("message", (d, binary) => {
    if (!binary) answers.push(JSON.parse(d.toString()));
    waiting.splice(0).forEach((w) => w());
  });
  ws.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
  });
  const answer = async (type: string) => {
    for (let i = 0; i < 50; i++) {
      const at = answers.findIndex((a) => a.type === type);
      if (at >= 0) return answers.splice(at, 1)[0];
      await new Promise<void>((r) => (waiting.push(r), setTimeout(r, 100)));
    }
    throw new Error(`no ${type}`);
  };
  return { ws, answer };
}

/** Every chunk a screen got up to `live.end`, in order. */
async function heard(dev: TestDevice) {
  const start = await dev.next("live.start");
  const chunks: Buffer[] = [];
  let end = false;
  while (!end) {
    const next = dev.inbox.find((m) => m.type === "live.chunk" || m.type === "live.end");
    if (!next) {
      await new Promise((r) => setTimeout(r, 25));
      continue;
    }
    dev.inbox.splice(dev.inbox.indexOf(next), 1);
    if (next.type === "live.end") end = true;
    else if (next.type === "live.chunk") chunks.push(Buffer.from(next.payload.data, "base64"));
  }
  return { start, chunks };
}

describe("the opening chime", () => {
  it("is the manual override chime as 16 kHz PCM in chunks a screen can take", () => {
    const chunks = chimeChunks();
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(LIVE_MAX_CHUNK_BYTES);
      expect(c.length % 2).toBe(0);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0) / 2;
    expect(total / LIVE_SAMPLE_RATE).toBeGreaterThan(0.5);
    expect(total / LIVE_SAMPLE_RATE).toBeLessThan(2);
    expect(Math.max(...chunks.flatMap((c) => Array.from({ length: c.length / 2 }, (_, i) => Math.abs(c.readInt16LE(i * 2)))))).toBeGreaterThan(5000);
  });
});

describe("announcement from the console microphone", () => {
  it("reaches the chosen screens: the chime first, then the voice, then the end", async () => {
    const a = await online();
    const b = await online("door");
    const mic = await micSocket(admin);

    mic.ws.send(JSON.stringify({ type: "start", targets: { devices: [a.deviceId] } }));
    expect(await mic.answer("started")).toMatchObject({ deviceCount: 1 });
    const voice = pcm(1600);
    mic.ws.send(voice);
    mic.ws.send(JSON.stringify({ type: "end" }));
    await mic.answer("ended");

    const { start, chunks } = await heard(a.dev);
    expect(start.payload).toMatchObject({ sampleRate: 16000, from: "Test admin" });
    const chime = chimeChunks();
    expect(chunks.slice(0, chime.length).every((c, i) => c.equals(chime[i]!))).toBe(true);
    expect(chunks[chunks.length - 1]!.equals(voice)).toBe(true);
    expect(b.dev.inbox.some((m) => m.type === "live.start")).toBe(false);
    expect(await AuditLogModel.countDocuments({ action: "live.announce", actorName: "Test admin" })).toBe(1);
    mic.ws.close();
    a.dev.close();
    b.dev.close();
  });

  it("is refused to staff, and when nobody is online or another announcement is on the air", async () => {
    await expect(micSocket(staff)).rejects.toThrow(/401/);

    const mic = await micSocket(admin);
    mic.ws.send(JSON.stringify({ type: "start", targets: { all: true } }));
    expect((await mic.answer("error")).error).toMatch(/No active screen|No screen is online/);

    const a = await online();
    mic.ws.send(JSON.stringify({ type: "start", targets: { devices: [a.deviceId] } }));
    await mic.answer("started");
    const second = await micSocket(await h.login("operator"));
    second.ws.send(JSON.stringify({ type: "start", targets: { devices: [a.deviceId] } }));
    expect((await second.answer("error")).error).toMatch(/on the air/);

    mic.ws.close();
    await heard(a.dev);
    expect(liveActive()).toBe(false);
    second.ws.close();
    a.dev.close();
  });

  it("drops frames that are not whole samples or are too big, and ends when the socket closes", async () => {
    const a = await online();
    const mic = await micSocket(admin);
    mic.ws.send(JSON.stringify({ type: "start", targets: { devices: [a.deviceId] } }));
    await mic.answer("started");
    mic.ws.send(Buffer.alloc(3));
    mic.ws.send(Buffer.alloc(LIVE_MAX_CHUNK_BYTES + 2));
    mic.ws.send(pcm(100));
    mic.ws.close();

    const { chunks } = await heard(a.dev);
    const chime = chimeChunks().length;
    expect(chunks.length).toBe(chime + 1);
    a.dev.close();
  });
});

describe("announcement from a door terminal", () => {
  async function terminalOf(person?: Record<string, unknown>) {
    if (person) await admin.request("POST", "/users", person);
    const t = await online("door");
    return t;
  }
  const tap = async (t: { dev: TestDevice }, badgeUid: string) => {
    t.dev.send("event.badge", { badgeUid, at: Date.now() });
    return (await t.dev.next("card.result")).payload;
  };

  it("needs a card first, and a student's card does not do", async () => {
    await admin.request("POST", "/students", STUDENT);
    const t = await terminalOf();
    const listener = await online();

    const ref = t.dev.send("live.start", {});
    expect((await t.dev.next("intercom.result")).payload).toMatchObject({ ref: ref.id, kind: "announce", ok: false });
    expect(await tap(t, STUDENT.cardUid)).toMatchObject({ outcome: "recognised" });
    t.dev.send("live.start", {});
    expect((await t.dev.next("intercom.result")).payload.ok).toBe(false);
    expect(listener.dev.inbox.some((m) => m.type === "live.start")).toBe(false);
    t.dev.close();
    listener.dev.close();
  });

  it("is offered with the operator's card, reaches every other screen and never plays back on the emitter", async () => {
    const t = await terminalOf(OPERATOR);
    const other = await online("door");
    const display = await online();

    const card = await tap(t, OPERATOR.cardUid);
    expect(card.menu).toMatchObject({ canAnnounce: true });

    const ref = t.dev.send("live.start", {});
    expect((await t.dev.next("intercom.result")).payload).toMatchObject({ ref: ref.id, ok: true, deviceCount: 2 });
    const voice = pcm(400);
    t.dev.send("live.chunk", { data: voice.toString("base64") });
    t.dev.send("live.end", {});

    for (const listener of [other, display]) {
      const { start, chunks } = await heard(listener.dev);
      expect(start.payload).toMatchObject({ streamId: ref.id, from: "Olga Operator" });
      expect(chunks[chunks.length - 1]!.equals(voice)).toBe(true);
    }
    // The terminal only hears the server saying its own announcement is over, never the audio.
    await t.dev.next("live.end");
    expect(t.dev.inbox.some((m) => m.type === "live.start" || m.type === "live.chunk")).toBe(false);
    expect(await AuditLogModel.countDocuments({ action: "live.announce", actorName: "Olga Operator" })).toBe(1);
    for (const x of [t, other, display]) x.dev.close();
  });

  it("stops when the terminal drops, and when the card's owner is disabled", async () => {
    const t = await terminalOf(OPERATOR);
    const listener = await online();
    await tap(t, OPERATOR.cardUid);
    t.dev.send("live.start", {});
    await t.dev.next("intercom.result");
    t.dev.close();
    await heard(listener.dev);
    expect(liveActive()).toBe(false);

    const again = await online("door");
    await tap(again, OPERATOR.cardUid);
    await UserModel.updateOne({ email: OPERATOR.email }, { disabled: true });
    again.dev.send("live.start", {});
    expect((await again.dev.next("intercom.result")).payload.ok).toBe(false);
    again.dev.close();
    listener.dev.close();
  });
});

describe("calls between door terminals", () => {
  const callOn = (from: { dev: TestDevice }, target: string) => from.dev.send("call.request", { target });

  it("lists the other doors with whether they are online", async () => {
    const a = await online("door");
    const b = await online("door");
    await online(); // a Faculty screen is not a door
    const off = await h.enrollDevice({ type: "door" });
    a.dev.send("call.list", {});
    const { peers } = (await a.dev.next("call.directory")).payload;
    expect(peers.map((p) => p.id).sort()).toEqual([b.deviceId, off.deviceId].sort());
    expect(peers.find((p) => p.id === b.deviceId)!.online).toBe(true);
    expect(peers.find((p) => p.id === off.deviceId)!.online).toBe(false);
    a.dev.close();
    b.dev.close();
  });

  it("rings the other door, which must accept before any voice flows, then carries both ways", async () => {
    const a = await online("door");
    const b = await online("door");
    const call = callOn(a, b.deviceId);
    expect((await a.dev.next("call.state")).payload).toMatchObject({ callId: call.id, state: "ringing" });
    expect((await b.dev.next("call.incoming")).payload).toMatchObject({ callId: call.id });

    // Voice sent before the answer goes nowhere.
    a.dev.send("call.audio", { callId: call.id, data: pcm(100).toString("base64") });
    b.dev.send("call.answer", { callId: call.id, accept: true });
    expect((await a.dev.next("call.state")).payload.state).toBe("active");
    expect((await b.dev.next("call.state")).payload.state).toBe("active");
    expect(b.dev.inbox.some((m) => m.type === "call.audio")).toBe(false);

    const toB = pcm(200);
    const toA = pcm(300);
    a.dev.send("call.audio", { callId: call.id, data: toB.toString("base64") });
    b.dev.send("call.audio", { callId: call.id, data: toA.toString("base64") });
    expect(Buffer.from((await b.dev.next("call.audio")).payload.data, "base64").equals(toB)).toBe(true);
    expect(Buffer.from((await a.dev.next("call.audio")).payload.data, "base64").equals(toA)).toBe(true);
    // Never echoed back to the one speaking.
    expect(a.dev.inbox.some((m) => m.type === "call.audio") || b.dev.inbox.some((m) => m.type === "call.audio")).toBe(false);

    a.dev.send("call.hangup", { callId: call.id });
    expect((await a.dev.next("call.state")).payload.state).toBe("ended");
    expect((await b.dev.next("call.state")).payload.state).toBe("ended");
    expect(await AuditLogModel.countDocuments({ action: "intercom.call" })).toBe(1);
    a.dev.close();
    b.dev.close();
  });

  it("is declined, refused when the target is offline or busy or not a door, and a stranger cannot answer or hang up", async () => {
    const a = await online("door");
    const b = await online("door");
    const c = await online("door");
    const display = await online();
    const off = await h.enrollDevice({ type: "door" });

    const declined = callOn(a, b.deviceId);
    await b.dev.next("call.incoming");
    c.dev.send("call.answer", { callId: declined.id, accept: true }); // not the callee
    c.dev.send("call.hangup", { callId: declined.id });
    b.dev.send("call.answer", { callId: declined.id, accept: false });
    await a.dev.next("call.state"); // ringing
    expect((await a.dev.next("call.state")).payload.state).toBe("declined");
    expect((await b.dev.next("call.state")).payload.state).toBe("declined");

    for (const target of [off.deviceId, display.deviceId, a.deviceId]) {
      callOn(a, target);
      expect((await a.dev.next("call.state")).payload.state).toBe("unavailable");
    }

    const first = callOn(a, b.deviceId);
    await b.dev.next("call.incoming");
    callOn(c, b.deviceId);
    expect((await c.dev.next("call.state")).payload.state).toBe("busy");
    a.dev.send("call.hangup", { callId: first.id });
    expect((await b.dev.next("call.state")).payload.state).toBe("ended");
    for (const x of [a, b, c, display]) x.dev.close();
  });

  it("ends when one side drops", async () => {
    const a = await online("door");
    const b = await online("door");
    const call = callOn(a, b.deviceId);
    await b.dev.next("call.incoming");
    b.dev.send("call.answer", { callId: call.id, accept: true });
    await b.dev.next("call.state"); // active
    a.dev.close();
    expect((await b.dev.next("call.state")).payload.state).toBe("ended");
    b.dev.close();
  });
});
