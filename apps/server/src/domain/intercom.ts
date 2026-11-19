import { ulid } from "@smartcampus/protocol";
import { HttpError } from "../lib/errors.js";
import { sniffAudio } from "../lib/audioSniff.js";
import { prependChime, type ChimeLevel } from "../lib/chimes.js";
import { recordAudit } from "../lib/audit.js";
import { AnnouncementModel } from "../models/announcement.js";
import { config } from "../config.js";
import { requireTts, ttsEngine } from "../infra/tts.js";
import { AssetModel } from "../models/asset.js";
import type { PublicUser } from "../models/user.js";
import { storeAudioAsset } from "./assets.js";
import { enqueueCommand } from "./commands.js";
import { requireTargetDevices, type Targets } from "./targeting.js";

type Actor = Pick<PublicUser, "id" | "name">;

/**
 * A broadcast that reaches a screen minutes late is worse than none ("evacuate now" at 10:40),
 * so audio commands expire quickly instead of waiting an hour for an offline device.
 */
export const AUDIO_COMMAND_TTL_SECONDS = 5 * 60;

/** Plays a stored sound on the chosen devices. Offline devices only get it if they return within the TTL. */
export async function broadcastAudio(
  input: { assetId: string; title?: string; targets: Targets; /** Emergencies only: full volume, ignores quiet hours. */ urgent?: boolean },
  actor: Actor,
) {
  const asset = await AssetModel.findOne({ assetId: input.assetId });
  if (!asset) throw new HttpError(404, "Asset not found");
  const deviceIds = await requireTargetDevices(input.targets);

  const announcement = await AnnouncementModel.create({
    announcementId: ulid(),
    kind: "audio",
    title: input.title ?? asset.name,
    assetId: asset.assetId,
    targets: input.targets,
    deviceIds,
    createdByName: actor.name,
  });

  for (const deviceId of deviceIds) {
    await enqueueCommand(
      deviceId,
      "audio.play",
      {
        announcementId: announcement.announcementId,
        title: announcement.title,
        assetId: asset.assetId,
        sha256: asset.sha256,
        size: asset.size,
        ...(input.urgent && { urgent: true }),
      },
      AUDIO_COMMAND_TTL_SECONDS,
    );
  }
  await recordAudit(actor, "intercom.broadcast", { type: "announcement", id: announcement.announcementId }, {
    assetId: asset.assetId,
    devices: deviceIds.length,
  });
  return announcement;
}

/** Longest text sent to the engine. Spoken announcements are short; this also bounds the cost of a request. */
export const MAX_SPEECH_CHARS = 1000;

export interface SpeechInput {
  text: string;
  /** Voice id from the engine's list. Defaults to its first voice. */
  voice?: string;
  /** Pace, 1 being natural. */
  speed?: number;
  /** A chime played before the voice, by severity. Left out for none. */
  chime?: ChimeLevel;
}

/**
 * The voice that reads emergencies: `TTS_EMERGENCY_VOICE` when the engine really offers it, else the first voice.
 * A typo in the configuration must not silence an emergency read-out, so it falls back instead of failing.
 */
export function emergencyVoiceId(): string | undefined {
  const engine = ttsEngine();
  const wanted = config.TTS_EMERGENCY_VOICE;
  return engine && wanted && engine.voices().some((v) => v.id === wanted) ? wanted : undefined;
}

/** Resolves the chosen voice, and so the language, against what the engine really offers. */
function pickVoice(input: SpeechInput) {
  const engine = requireTts();
  const voices = engine.voices();
  const voice = input.voice ? voices.find((v) => v.id === input.voice) : voices[0];
  if (!voice) throw new HttpError(400, `Unknown voice "${input.voice}"`);
  return { engine, voice };
}

/**
 * The voice with its chime in front. An engine that does not return a 16-bit WAV when asked cannot be joined to a chime
 * without a decoder, so the voice goes out as it is: an announcement without its chime is better than none.
 */
function withChime(spoken: Buffer, level: ChimeLevel): Buffer {
  const joined = prependChime(spoken, level);
  if (!joined) console.warn(`chime "${level}" skipped: the text-to-speech engine did not return a 16-bit WAV`);
  return joined ?? spoken;
}

/** Generates the audio for a text without storing or sending it: the pre-listening step. */
export async function previewSpeech(input: SpeechInput): Promise<{ data: Buffer; mime: string }> {
  const { engine, voice } = pickVoice(input);
  const spoken = await engine.synthesize({
    text: input.text,
    voice: voice.id,
    language: voice.language,
    ...(input.speed !== undefined && { speed: input.speed }),
    ...(input.chime && { format: "wav" as const }),
  });
  const data = input.chime ? withChime(spoken, input.chime) : spoken;
  const format = sniffAudio(data);
  if (!format) throw new HttpError(502, "The text-to-speech engine returned something that is not audio");
  return { data, mime: format.mime };
}

/**
 * Text to voice to speakers: synthesises the text, keeps the result in the sound library (so it can
 * be replayed and is downloadable by the devices like any other sound) and broadcasts it.
 */
export async function speak(
  input: SpeechInput & { title?: string; targets: Targets; urgent?: boolean },
  actor: Actor,
) {
  const { data } = await previewSpeech(input);
  const snippet = input.text.length > 60 ? `${input.text.slice(0, 57)}...` : input.text;
  const title = input.title?.trim() || `Voice: ${snippet}`;
  const asset = await storeAudioAsset(data, title.slice(0, 100), actor);
  return broadcastAudio({ assetId: asset.assetId, title, targets: input.targets, urgent: input.urgent }, actor);
}
