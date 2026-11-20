import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startHarness, type ApiClient, type Harness } from "../../testing/harness.js";
import { AuditLogModel } from "../../models/auditLog.js";
import { CommandModel } from "../../models/command.js";
import { DeviceModel } from "../../models/device.js";
import { EmergencyModel } from "../../models/emergency.js";
import { EmergencyConfirmationModel } from "../../models/emergencyConfirmation.js";
import { setTtsEngine } from "../../infra/tts.js";
import { config } from "../../config.js";
import { createHash } from "node:crypto";
import { ALL_CLEAR_CHIME, EMERGENCY_CHIMES } from "../emergencies.js";
import { prependChime } from "../../lib/chimes.js";
import { louden } from "../../lib/speechGain.js";
import { fakeEngine, speechWav } from "../../testing/fakeTts.js";

let h: Harness;
let operator: ApiClient;
let staff: ApiClient;

beforeAll(async () => {
  h = await startHarness();
  [operator, staff] = await Promise.all([h.login("operator"), h.login("staff")]);
}, 120_000);
afterAll(() => h.stop());

beforeEach(async () => {
  await Promise.all([DeviceModel.deleteMany({}), CommandModel.deleteMany({}), EmergencyModel.deleteMany({}), EmergencyConfirmationModel.deleteMany({}), AuditLogModel.deleteMany({})]);
});

const rawTrigger = async (client: ApiClient, body: object) => client.request("POST", "/emergencies", { twoFactorCode: await client.code(), ...body });

/** What the console does: a real alert goes through the confirmation step first, a test does not. */
async function trigger(client: ApiClient, body: { testMode?: boolean }) {
  if (body.testMode) return rawTrigger(client, body);
  const step = await client.request("POST", "/emergencies/confirmations", body);
  return step.status === 201 ? rawTrigger(client, { ...body, confirmation: step.body.confirmation }) : step;
}

describe("emergencies", () => {
  it("reaches an online screen with its wording and test settings", async () => {
    const { identity, deviceId } = await h.enrollDevice();
    const dev = h.connectDevice(deviceId, identity);
    await dev.ready;
    await dev.next("session.ready");

    const res = await trigger(operator, { kind: "fire", targets: { devices: [deviceId] }, testMode: true, testVolume: 15 });
    expect(res.status).toBe(201);

    const msg = await dev.next("emergency.set");
    expect(msg.payload).toMatchObject({ emergencyId: res.body.id, kind: "fire", title: "Fire alarm", testMode: true, testVolume: 15 });
    expect(String(msg.payload.instructions).length).toBeGreaterThan(0);
    dev.close();
  });

  it("targets every screen unless told otherwise, and is real unless marked as a test", async () => {
    await h.enrollDevice();
    await h.enrollDevice();
    const res = await trigger(operator, { kind: "power" });
    expect(res.body).toMatchObject({ deviceCount: 2, testMode: false, status: "active" });
  });

  it("an offline screen sounds the alarm on reconnection, and stops once cleared", async () => {
    const { identity, deviceId } = await h.enrollDevice();
    const { body } = await trigger(operator, { kind: "seismic", targets: { devices: [deviceId] } });

    const first = h.connectDevice(deviceId, identity);
    await first.ready;
    const ready = await first.next("session.ready");
    expect((ready.payload.desired.emergency as { emergencyId: string }).emergencyId).toBe(body.id);
    first.close();
    await first.closed;

    expect((await operator.request("DELETE", `/emergencies/${body.id}`)).status).toBe(204);
    // The start was never acknowledged: the clear replaces it, so the screen does not flash an alarm that is over.
    expect((await CommandModel.findOne({ deviceId, type: "emergency.set" }))?.status).toBe("superseded");

    const second = h.connectDevice(deviceId, identity);
    await second.ready;
    const readyAgain = await second.next("session.ready");
    expect(readyAgain.payload.desired.emergency).toBeNull();
    expect((await second.next("emergency.clear")).payload.emergencyId).toBe(body.id);
    second.close();
    expect((await operator.request("DELETE", `/emergencies/${body.id}`)).status).toBe(404);
  });

  it("clearing an old alert leaves a screen that moved on to a newer one alone", async () => {
    const { deviceId } = await h.enrollDevice();
    const older = await trigger(operator, { kind: "fire", targets: { devices: [deviceId] } });
    const newer = await trigger(operator, { kind: "bomb", targets: { devices: [deviceId] } });

    await operator.request("DELETE", `/emergencies/${older.body.id}`);
    const device = await DeviceModel.findOne({ deviceId });
    expect((device?.desired as { emergency: { emergencyId: string } }).emergency.emergencyId).toBe(newer.body.id);
    expect(await CommandModel.countDocuments({ deviceId, type: "emergency.clear" })).toBe(0);
  });

  it("refuses an unknown kind, an out-of-range test volume, unknown fields and targets that reach nobody", async () => {
    await h.enrollDevice();
    expect((await trigger(operator, { kind: "zombies" })).status).toBe(400);
    expect((await trigger(operator, { kind: "fire", testVolume: 101 })).status).toBe(400);
    expect((await trigger(operator, { kind: "fire", targets: { all: true, admin: true } })).status).toBe(400);
    expect((await trigger(operator, { kind: "fire", targets: { groups: ["nobody"] } })).status).toBe(400);
  });

  it("only admins and operators trigger, staff read", async () => {
    await h.enrollDevice();
    expect((await trigger(staff, { kind: "fire" })).status).toBe(403);
    expect((await h.anonymous.request("GET", "/emergencies")).status).toBe(401);
    await trigger(operator, { kind: "fire", testMode: true });
    expect((await staff.request("GET", "/emergencies?status=active")).body.items).toHaveLength(1);
    expect((await staff.request("DELETE", "/emergencies/x")).status).toBe(403);
  });

  it("audits both ends and reports delivery and what the screen reports", async () => {
    const { deviceId } = await h.enrollDevice();
    const { body } = await trigger(operator, { kind: "biohazard", targets: { devices: [deviceId] } });
    expect(await AuditLogModel.countDocuments({ action: "emergency.trigger", targetId: body.id })).toBe(1);

    expect((await operator.request("GET", `/emergencies/${body.id}`)).body.delivery).toEqual([
      { deviceId, name: "Test device", delivery: "pending", showing: false },
    ]);
    await DeviceModel.updateOne({ deviceId }, { $set: { "reported.emergency": body.id } });
    expect((await operator.request("GET", `/emergencies/${body.id}`)).body.delivery[0].showing).toBe(true);

    await operator.request("DELETE", `/emergencies/${body.id}`);
    expect(await AuditLogModel.countDocuments({ action: "emergency.clear", targetId: body.id })).toBe(1);
  });

  describe("two-step confirmation", () => {
    it("refuses a real alert without a confirmation and a test needs none", async () => {
      await h.enrollDevice();
      const res = await rawTrigger(operator, { kind: "fire" });
      expect(res.status).toBe(409);
      expect(await EmergencyModel.countDocuments()).toBe(0);
      expect((await rawTrigger(operator, { kind: "fire", testMode: true })).status).toBe(201);
    });

    it("tells the person how many screens they are about to alert, and the token works once", async () => {
      await h.enrollDevice();
      await h.enrollDevice();
      const step = await operator.request("POST", "/emergencies/confirmations", { kind: "fire" });
      expect(step.body).toMatchObject({ deviceCount: 2, title: "Fire alarm" });
      expect(step.body.confirmation).toEqual(expect.any(String));

      expect((await rawTrigger(operator, { kind: "fire", confirmation: step.body.confirmation })).status).toBe(201);
      expect((await rawTrigger(operator, { kind: "fire", confirmation: step.body.confirmation })).status).toBe(409);
    });

    it("is bound to the alert: another kind, other screens or other wording are refused", async () => {
      const { deviceId } = await h.enrollDevice();
      await h.enrollDevice();
      const step = await operator.request("POST", "/emergencies/confirmations", { kind: "fire", targets: { devices: [deviceId] } });
      const token = step.body.confirmation;
      expect((await rawTrigger(operator, { kind: "bomb", targets: { devices: [deviceId] }, confirmation: token })).status).toBe(409);
      expect((await rawTrigger(operator, { kind: "fire", confirmation: token })).status).toBe(409);
      expect((await rawTrigger(operator, { kind: "fire", targets: { devices: [deviceId] }, instructions: "Other", confirmation: token })).status).toBe(409);
      // None of the failed attempts used it up.
      expect((await rawTrigger(operator, { kind: "fire", targets: { devices: [deviceId] }, confirmation: token })).status).toBe(201);
    });

    it("is bound to the person who asked and expires", async () => {
      await h.enrollDevice();
      const admin = await h.login("admin");
      const step = await operator.request("POST", "/emergencies/confirmations", { kind: "power" });
      expect((await rawTrigger(admin, { kind: "power", confirmation: step.body.confirmation })).status).toBe(409);

      await EmergencyConfirmationModel.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await rawTrigger(operator, { kind: "power", confirmation: step.body.confirmation })).status).toBe(409);
    });

    it("stores only a hash of the token, and a confirmation for nobody is refused up front", async () => {
      await h.enrollDevice();
      const step = await operator.request("POST", "/emergencies/confirmations", { kind: "fire" });
      expect(await EmergencyConfirmationModel.countDocuments({ tokenHash: step.body.confirmation })).toBe(0);
      expect((await operator.request("POST", "/emergencies/confirmations", { kind: "fire", targets: { groups: ["nobody"] } })).status).toBe(400);
      expect((await staff.request("POST", "/emergencies/confirmations", { kind: "fire" })).status).toBe(403);
    });
  });

  describe("end of emergency", () => {
    it("sends the end message with the clear command and keeps it in the record", async () => {
      const { identity, deviceId } = await h.enrollDevice();
      const dev = h.connectDevice(deviceId, identity);
      await dev.ready;
      await dev.next("session.ready");
      const { body } = await trigger(operator, { kind: "fire", targets: { devices: [deviceId] } });
      await dev.next("emergency.set");

      const res = await operator.request("POST", `/emergencies/${body.id}/clear`, { message: "All clear, you may return to the building." });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "cleared", endMessage: "All clear, you may return to the building." });
      const clear = await dev.next("emergency.clear");
      expect(clear.payload).toEqual({ emergencyId: body.id, message: "All clear, you may return to the building." });
      expect(await AuditLogModel.countDocuments({ action: "emergency.clear", "meta.withMessage": true })).toBe(1);
      dev.close();
    });

    it("lets the person choose how long the notice stays, within limits", async () => {
      const { identity, deviceId } = await h.enrollDevice();
      const dev = h.connectDevice(deviceId, identity);
      await dev.ready;
      await dev.next("session.ready");
      const { body } = await trigger(operator, { kind: "fire", targets: { devices: [deviceId] } });
      await dev.next("emergency.set");

      const clear = (extra: object) => operator.request("POST", `/emergencies/${body.id}/clear`, { message: "All clear.", ...extra });
      expect((await clear({ noticeSeconds: 9 })).status).toBe(400);
      expect((await clear({ noticeSeconds: 901 })).status).toBe(400);
      expect((await clear({ noticeSeconds: 30.5 })).status).toBe(400);
      const res = await clear({ noticeSeconds: 300 });
      expect(res.body).toMatchObject({ endMessage: "All clear.", endNoticeSeconds: 300 });
      expect((await dev.next("emergency.clear")).payload).toEqual({ emergencyId: body.id, message: "All clear.", noticeSeconds: 300 });
      dev.close();
    });

    it("sends no duration unless one was chosen, so the screen keeps its default", async () => {
      const { deviceId } = await h.enrollDevice();
      const { body } = await trigger(operator, { kind: "power", targets: { devices: [deviceId] } });
      const res = await operator.request("POST", `/emergencies/${body.id}/clear`, { message: "Over." });
      expect(res.body.endNoticeSeconds).toBeNull();
      const cmd = await CommandModel.findOne({ deviceId, type: "emergency.clear" });
      expect(cmd?.payload).toEqual({ emergencyId: body.id, message: "Over." });
    });

    it("serves the limits for the console", async () => {
      expect((await staff.request("GET", "/emergencies/end-notice")).body).toEqual({ min: 10, max: 900, default: 120 });
    });

    it("keeps working without a message, and bounds it", async () => {
      const { deviceId } = await h.enrollDevice();
      const { body } = await trigger(operator, { kind: "power", targets: { devices: [deviceId] } });
      expect((await operator.request("POST", `/emergencies/${body.id}/clear`, { message: "x".repeat(401) })).status).toBe(400);
      expect((await operator.request("POST", `/emergencies/${body.id}/clear`, {})).status).toBe(200);
      expect((await staff.request("POST", `/emergencies/${body.id}/clear`, {})).status).toBe(403);
    });
  });

  describe("voice", () => {
    afterEach(() => setTtsEngine(undefined));

    it("reads the alert aloud as an urgent broadcast after the alarm is queued", async () => {
      setTtsEngine(fakeEngine());
      const { deviceId } = await h.enrollDevice();
      const { body } = await trigger(operator, { kind: "fire", targets: { devices: [deviceId] }, speak: true });
      expect(body.voice.status).toBe("sent");
      const audio = await CommandModel.findOne({ deviceId, type: "audio.play" });
      expect(audio?.payload).toMatchObject({ urgent: true });
      expect(await CommandModel.countDocuments({ deviceId, type: "emergency.set" })).toBe(1);
    });

    describe("emergency voice", () => {
      afterEach(() => {
        config.TTS_EMERGENCY_VOICE = undefined;
        config.TTS_EMERGENCY_SPEED = 0.9;
      });

      it("reads an alert with the emergency voice, slowly, opening with a repeated attention call", async () => {
        const engine = fakeEngine();
        setTtsEngine(engine);
        config.TTS_EMERGENCY_VOICE = "alloy";
        config.TTS_EMERGENCY_SPEED = 0.85;
        const { deviceId } = await h.enrollDevice();
        await trigger(operator, { kind: "fire", targets: { devices: [deviceId] }, speak: true });
        expect(engine.calls).toHaveLength(1);
        expect(engine.calls[0]).toMatchObject({ voice: "alloy", language: "en", speed: 0.85 });
        expect(engine.calls[0]!.text).toMatch(/^Attention\. Attention\. Fire alarm\. Leave the building/);
      });

      it("a voice chosen for the alert wins over the emergency voice", async () => {
        const engine = fakeEngine();
        setTtsEngine(engine);
        config.TTS_EMERGENCY_VOICE = "alloy";
        const { deviceId } = await h.enrollDevice();
        await trigger(operator, { kind: "fire", targets: { devices: [deviceId] }, speak: true, voice: "nova" });
        expect(engine.calls[0]).toMatchObject({ voice: "nova", speed: 0.9 });
      });

      it("a misspelt emergency voice falls back to the first voice instead of silencing the read-out", async () => {
        const engine = fakeEngine();
        setTtsEngine(engine);
        config.TTS_EMERGENCY_VOICE = "no-such-voice";
        const { deviceId } = await h.enrollDevice();
        const { body } = await trigger(operator, { kind: "fire", targets: { devices: [deviceId] }, speak: true });
        expect(body.voice.status).toBe("sent");
        expect(engine.calls[0]!.voice).toBe("nova");
      });

      it("the all-clear uses the same voice at a natural pace, without the attention call", async () => {
        const engine = fakeEngine();
        setTtsEngine(engine);
        config.TTS_EMERGENCY_VOICE = "alloy";
        const { deviceId } = await h.enrollDevice();
        const { body } = await trigger(operator, { kind: "fire", targets: { devices: [deviceId] } });
        await operator.request("POST", `/emergencies/${body.id}/clear`, { message: "All clear.", speak: true });
        expect(engine.calls[0]).toEqual({ text: "All clear.", voice: "alloy", language: "en", format: "wav" });
      });

      it("tells the console which voice reads emergencies, and ordinary speech never gets a pace", async () => {
        const engine = fakeEngine();
        setTtsEngine(engine);
        expect((await operator.request("GET", "/intercom/voices")).body.emergencyVoice).toBe("nova");
        config.TTS_EMERGENCY_VOICE = "alloy";
        expect((await operator.request("GET", "/intercom/voices")).body.emergencyVoice).toBe("alloy");
        const { deviceId } = await h.enrollDevice();
        await operator.request("POST", "/intercom/speech", { text: "Hello", targets: { devices: [deviceId] } });
        expect(engine.calls[0]).not.toHaveProperty("speed");
      });
    });

    describe("chimes", () => {
      const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
      const heard = async (deviceId: string) => (await CommandModel.findOne({ deviceId, type: "audio.play" }))?.payload as { sha256: string };

      it("opens the read-out of each kind of emergency with a chime of its own", async () => {
        setTtsEngine(fakeEngine({ pcm16: true }));
        const seen = new Set<string>();
        for (const kind of Object.keys(EMERGENCY_CHIMES) as (keyof typeof EMERGENCY_CHIMES)[]) {
          const { deviceId } = await h.enrollDevice();
          await trigger(operator, { kind, targets: { devices: [deviceId] }, speak: true });
          const { sha256 } = await heard(deviceId);
          // The same voice, made louder, with this kind's chime in front, and nothing else, was broadcast.
          expect(sha256, kind).toBe(sha(prependChime(louden(speechWav())!, EMERGENCY_CHIMES[kind])!));
          seen.add(sha256);
        }
        expect(seen.size).toBe(6);
        expect(new Set(Object.values(EMERGENCY_CHIMES)).size).toBe(6);
      });

      it("reads the all-clear after a calm chime, not an alarm chime", async () => {
        setTtsEngine(fakeEngine({ pcm16: true }));
        const { deviceId } = await h.enrollDevice();
        const { body } = await trigger(operator, { kind: "fire", targets: { devices: [deviceId] }, speak: false });
        await operator.request("POST", `/emergencies/${body.id}/clear`, { message: "All clear.", speak: true });
        expect(Object.values(EMERGENCY_CHIMES)).not.toContain(ALL_CLEAR_CHIME);
        expect((await heard(deviceId)).sha256).toBe(sha(prependChime(louden(speechWav())!, ALL_CLEAR_CHIME)!));
      });
    });

    it("a test is not urgent, so quiet hours still apply", async () => {
      setTtsEngine(fakeEngine());
      const { deviceId } = await h.enrollDevice();
      await trigger(operator, { kind: "fire", targets: { devices: [deviceId] }, testMode: true, speak: true });
      expect((await CommandModel.findOne({ deviceId, type: "audio.play" }))?.payload).toMatchObject({ urgent: false });
    });

    it("without a voice engine the alert still goes out and says the voice was unavailable", async () => {
      setTtsEngine(null);
      const { deviceId } = await h.enrollDevice();
      const { status, body } = await trigger(operator, { kind: "fire", targets: { devices: [deviceId] }, speak: true });
      expect(status).toBe(201);
      expect(body.voice.status).toBe("unavailable");
      expect(await CommandModel.countDocuments({ deviceId, type: "emergency.set" })).toBe(1);
    });

    it("an engine that fails does not stop the alert", async () => {
      setTtsEngine({ voices: () => [{ id: "v", label: "V", language: "en" }], synthesize: async () => { throw new Error("engine down"); } });
      const { deviceId } = await h.enrollDevice();
      const { status, body } = await trigger(operator, { kind: "fire", targets: { devices: [deviceId] }, speak: true });
      expect(status).toBe(201);
      expect(body.voice).toEqual({ status: "failed", error: "engine down" });
    });

    it("speaks the end message only to screens that were still sounding", async () => {
      setTtsEngine(fakeEngine());
      const { deviceId } = await h.enrollDevice();
      const { body } = await trigger(operator, { kind: "fire", targets: { devices: [deviceId] } });
      await operator.request("POST", `/emergencies/${body.id}/clear`, { message: "All clear.", speak: true });
      expect(await CommandModel.countDocuments({ deviceId, type: "audio.play" })).toBe(1);
      expect((await EmergencyModel.findOne({ emergencyId: body.id }))?.voiceStatus).toBe("sent");
    });
  });

  it("serves the catalogue", async () => {
    const { body } = await staff.request("GET", "/emergencies/catalogue");
    expect(body.items.map((i: { kind: string }) => i.kind)).toEqual(["fire", "biohazard", "nuclear", "bomb", "seismic", "power"]);
  });
});
