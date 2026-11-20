import { createHash, randomBytes } from "node:crypto";
import { EMERGENCY_CATALOGUE, ulid, type EmergencyKind, type PayloadOf } from "@smartcampus/protocol";
import { HttpError } from "../lib/errors.js";
import { recordAudit } from "../lib/audit.js";
import { CommandModel } from "../models/command.js";
import { DeviceModel } from "../models/device.js";
import { EmergencyModel } from "../models/emergency.js";
import { EmergencyConfirmationModel } from "../models/emergencyConfirmation.js";
import { ttsEngine } from "../infra/tts.js";
import type { PublicUser } from "../models/user.js";
import { consoleBus } from "../gateway/consoleBus.js";
import { enqueueCommand } from "./commands.js";
import { config } from "../config.js";
import type { ChimeId } from "../lib/chimes.js";
import { MAX_SPEECH_CHARS, emergencyVoiceId, speak } from "./intercom.js";
import { requireTargetDevices, type Targets } from "./targeting.js";

type Actor = Pick<PublicUser, "id" | "name">;

/** An emergency has no end time of its own, so a screen that is offline keeps its command for a day. */
const EMERGENCY_COMMAND_TTL_SECONDS = 86_400;

export interface EmergencyInput {
  kind: EmergencyKind;
  targets: Targets;
  testMode: boolean;
  testVolume: number;
  /** Replaces the default wording for this alert only. */
  instructions?: string;
  /** Also read the alert aloud on the speakers (needs a voice engine). */
  speak?: boolean;
  voice?: string;
  /** Token from `requestConfirmation`. Required for a real alert, ignored for a test. */
  confirmation?: string;
}

/** How long the second click may take. Short: a confirmation is a decision made a moment ago. */
const CONFIRMATION_TTL_MS = 60_000;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** JSON with sorted keys, so the same alert always has the same fingerprint. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** What the confirmation is bound to: everything that decides what the alert does, except the test settings (tests need none). */
const alertFingerprint = (input: EmergencyInput) =>
  sha256(stable({ kind: input.kind, targets: input.targets, instructions: input.instructions, speak: Boolean(input.speak), voice: input.voice }));

/**
 * First click of a real alert: checks the alert can reach someone and hands out a token for the second
 * click, together with what the person is about to do (how many screens), so they confirm facts.
 */
export async function requestConfirmation(input: EmergencyInput, actor: Actor) {
  const deviceIds = await requireTargetDevices(input.targets);
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS);
  await EmergencyConfirmationModel.create({ tokenHash: sha256(token), userId: actor.id, payloadHash: alertFingerprint(input), expiresAt });
  return { confirmation: token, expiresAt, deviceCount: deviceIds.length, title: EMERGENCY_CATALOGUE[input.kind].title };
}

/** Atomic: a token works once, for its owner, for the alert it was issued for, before it expires. */
async function consumeConfirmation(input: EmergencyInput, actor: Actor): Promise<void> {
  const used = input.confirmation
    ? await EmergencyConfirmationModel.findOneAndUpdate(
        { tokenHash: sha256(input.confirmation), used: false, expiresAt: { $gt: new Date() }, userId: actor.id, payloadHash: alertFingerprint(input) },
        { $set: { used: true } },
      )
    : null;
  if (!used) throw new HttpError(409, "Confirm the alert first: the confirmation is missing, expired, already used or does not match this alert");
}

/**
 * Starts an emergency on every target. It goes into the digital twin as well as the outbox, so a
 * screen that reconnects after its command expired still sounds the alarm. A screen shows one
 * emergency at a time: a newer one replaces an older one.
 */
export async function triggerEmergency(input: EmergencyInput, actor: Actor) {
  if (!input.testMode) await consumeConfirmation(input, actor);
  const deviceIds = await requireTargetDevices(input.targets);
  const info = EMERGENCY_CATALOGUE[input.kind];

  const emergency = await EmergencyModel.create({
    emergencyId: ulid(),
    kind: input.kind,
    title: info.title,
    instructions: input.instructions ?? info.instructions,
    testMode: input.testMode,
    testVolume: input.testVolume,
    targets: input.targets,
    deviceIds,
    startedByName: actor.name,
  });

  const payload: PayloadOf<"emergency.set"> = {
    emergencyId: emergency.emergencyId,
    kind: input.kind,
    title: emergency.title,
    instructions: emergency.instructions,
    testMode: emergency.testMode,
    testVolume: emergency.testVolume,
    startedAt: Date.now(),
  };
  for (const deviceId of deviceIds) await enqueueCommand(deviceId, "emergency.set", payload, EMERGENCY_COMMAND_TTL_SECONDS);

  await recordAudit(actor, "emergency.trigger", { type: "emergency", id: emergency.emergencyId }, {
    kind: input.kind,
    testMode: input.testMode,
    devices: deviceIds.length,
    speak: Boolean(input.speak),
  });
  consoleBus.emit("emergency.changed", { emergencyId: emergency.emergencyId });

  // After the visual alert and the alarm are queued, so a slow or broken voice engine never delays them.
  if (input.speak) {
    // Said twice first: the opening words of an alarm are the ones people miss while a door slams.
    await speakAlert(emergency, `Attention. Attention. ${emergency.title}. ${emergency.instructions}`, { devices: deviceIds }, input.voice, !input.testMode, actor, true, EMERGENCY_CHIMES[emergency.kind]);
  }
  return emergency;
}

/**
 * The chime that goes before the read-out of each kind of emergency, so the kind is recognised before a word is said. They are
 * all different, and the harshest sounds belong to the kinds that need people to move at once.
 */
export const EMERGENCY_CHIMES = {
  fire: "critical-buzwarn",
  bomb: "critical-deeoo",
  nuclear: "important-manual-override",
  biohazard: "manual-override",
  seismic: "warning-dadeda",
  power: "warning-dadac",
} as const satisfies Record<EmergencyKind, ChimeId>;

/** The all-clear is the same for every kind: a calm information chime, nothing that sounds like the alarm that just ended. */
export const ALL_CLEAR_CHIME: ChimeId = "info-doop";

/** Reads text aloud on the speakers and records whether it worked on the emergency. Never throws. */
async function speakAlert(
  emergency: InstanceType<typeof EmergencyModel>,
  text: string,
  targets: Targets,
  voice: string | undefined,
  urgent: boolean,
  actor: Actor,
  /** The start of an alert is read slowly and gravely, the all-clear at a natural pace. */
  grave = true,
  chime?: ChimeId,
): Promise<void> {
  if (!ttsEngine()) {
    emergency.voiceStatus = "unavailable";
  } else {
    try {
      await speak(
        {
          text: text.slice(0, MAX_SPEECH_CHARS),
          // A voice chosen for this alert wins; otherwise the emergency voice, so every alert sounds the same.
          voice: voice ?? emergencyVoiceId(),
          ...(grave && { speed: config.TTS_EMERGENCY_SPEED }),
          ...(chime && { chime }),
          loud: true,
          title: `Emergency: ${emergency.title}`,
          targets,
          urgent,
        },
        actor,
      );
      emergency.voiceStatus = "sent";
      emergency.voiceError = undefined;
    } catch (err) {
      emergency.voiceStatus = "failed";
      emergency.voiceError = err instanceof Error ? err.message.slice(0, 200) : "Unknown error";
    }
  }
  await emergency.save();
}

export interface ClearInput {
  /** Notice shown on the screens once the alarm stops. */
  message?: string;
  /** How long the notice stays on screen. Only meaningful with a message. */
  noticeSeconds?: number;
  speak?: boolean;
  voice?: string;
}

/**
 * Ends an emergency. Only the screens that still show *this* emergency are cleared: one that was
 * since taken over by a newer alert keeps showing it.
 */
export async function clearEmergency(emergencyId: string, actor: Actor, input: ClearInput = {}) {
  const emergency = await EmergencyModel.findOneAndUpdate(
    { emergencyId, status: "active" },
    { $set: { status: "cleared", clearedAt: new Date(), clearedByName: actor.name, ...(input.message && { endMessage: input.message, ...(input.noticeSeconds && { endNoticeSeconds: input.noticeSeconds }) }) } },
    { new: true },
  );
  if (!emergency) throw new HttpError(404, "Active emergency not found");

  const showing = await DeviceModel.find({ deviceId: { $in: emergency.deviceIds }, "desired.emergency.emergencyId": emergencyId }, { deviceId: 1 });
  for (const { deviceId } of showing) {
    await enqueueCommand(deviceId, "emergency.clear", { emergencyId, ...(input.message && { message: input.message, ...(input.noticeSeconds && { noticeSeconds: input.noticeSeconds }) }) }, EMERGENCY_COMMAND_TTL_SECONDS);
  }

  await recordAudit(actor, "emergency.clear", { type: "emergency", id: emergencyId }, {
    kind: emergency.kind,
    devices: showing.length,
    withMessage: Boolean(input.message),
  });
  consoleBus.emit("emergency.changed", { emergencyId });

  // Only the screens that were still sounding hear the all-clear. In a test nothing needs to override quiet hours.
  if (input.speak && input.message && showing.length) {
    await speakAlert(emergency, input.message, { devices: showing.map((d) => d.deviceId) }, input.voice, !emergency.testMode, actor, false, ALL_CLEAR_CHIME);
  }
  return emergency;
}

/**
 * Per device: did the screen acknowledge the start, and does it report showing it right now?
 * `showing` comes from the device's own report, so it is the proof the alarm is on.
 */
export async function deliveryOfEmergency(emergencyId: string, deviceIds: string[]) {
  const commands = await CommandModel.find({ type: "emergency.set", "payload.emergencyId": emergencyId }).lean();
  const byDevice = new Map(commands.map((c) => [c.deviceId, c.status]));
  const devices = await DeviceModel.find({ deviceId: { $in: deviceIds } }, { deviceId: 1, name: 1, reported: 1 }).lean();
  return devices.map((d) => ({
    deviceId: d.deviceId,
    name: d.name || d.deviceId,
    delivery: byDevice.get(d.deviceId) ?? "pending",
    showing: (d.reported as { emergency?: string } | undefined)?.emergency === emergencyId,
  }));
}
