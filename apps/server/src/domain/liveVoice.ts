import { LIVE_MAX_CHUNK_BYTES, LIVE_MAX_SECONDS, LIVE_SAMPLE_RATE, ulid } from "@smartcampus/protocol";
import { registry } from "../gateway/registry.js";
import { HttpError } from "../lib/errors.js";
import { recordAudit } from "../lib/audit.js";
import { renderChime } from "../lib/chimes.js";
import { resolveTargetDevices, type Targets } from "./targeting.js";

/** The chime that opens every live announcement: the same "manual override" beeps whoever speaks. */
export const LIVE_CHIME = "manual-override" as const;

/** A microphone that goes quiet this long without ending is cut, so a dropped link cannot hold the screens. */
const IDLE_MS = 5_000;

export interface LiveSource {
  /** `console`: a person speaking from the web console. `device`: someone at a door terminal, identified by their card. */
  kind: "console" | "device";
  /** The user id for the console, the device id for a terminal: only one announcement per source at a time. */
  id: string;
  /** Who is speaking, as the screens show it. */
  name: string;
  /** Who is accountable in the audit log. */
  actor: { id: string; name: string };
}

interface Session {
  streamId: string;
  source: LiveSource;
  /** Connections that were online when the announcement began. A screen that comes back mid-sentence does not join it. */
  targets: string[];
  maxTimer: NodeJS.Timeout;
  idleTimer: NodeJS.Timeout;
  onEnd?: () => void;
}

const sessions = new Map<string, Session>();

/** The chime and the pause after it, as the first audio of the stream: cut into chunks the size a microphone's would be. */
export function chimeChunks(): Buffer[] {
  const samples = renderChime(LIVE_CHIME, LIVE_SAMPLE_RATE);
  const pause = Math.round(0.2 * LIVE_SAMPLE_RATE);
  const pcm = Buffer.alloc((samples.length + pause) * 2);
  samples.forEach((v, i) => pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2));
  const chunks: Buffer[] = [];
  for (let at = 0; at < pcm.length; at += LIVE_MAX_CHUNK_BYTES) chunks.push(pcm.subarray(at, at + LIVE_MAX_CHUNK_BYTES));
  return chunks;
}

const sessionOf = (source: LiveSource) => [...sessions.values()].find((s) => s.source.kind === source.kind && s.source.id === source.id);

/** True while someone is speaking. */
export const liveActive = () => sessions.size > 0;

/** The stream a source has on the air, if any. */
export const liveStreamOf = (source: Pick<LiveSource, "kind" | "id">) => sessionOf(source as LiveSource)?.streamId;

/**
 * Opens a live announcement to the screens in `targets` that are online, except the one speaking: that terminal must not play
 * its own microphone back or it would feed on itself (the loop that makes a speaker howl).
 */
export async function startLive(source: LiveSource, targets: Targets, streamId: string = ulid(), onEnd?: () => void): Promise<{ streamId: string; deviceCount: number }> {
  if (sessionOf(source)) throw new HttpError(409, "You are already on the air");
  if (sessions.size > 0) throw new HttpError(409, "Another announcement is on the air. Try again when it ends");

  const wanted = (await resolveTargetDevices(targets)).filter((id) => !(source.kind === "device" && id === source.id));
  const online = wanted.filter((id) => registry.get(id)?.open);
  if (online.length === 0) throw new HttpError(400, "No screen is online to hear it");
  // Another request may have got in while the targets were resolved.
  if (sessions.size > 0) throw new HttpError(409, "Another announcement is on the air. Try again when it ends");

  const session: Session = {
    streamId,
    source,
    targets: online,
    maxTimer: setTimeout(() => endLive(streamId), LIVE_MAX_SECONDS * 1000),
    idleTimer: setTimeout(() => endLive(streamId), IDLE_MS),
    onEnd,
  };
  sessions.set(streamId, session);

  fan(session, (conn) => conn.send("live.start", { streamId, sampleRate: LIVE_SAMPLE_RATE, from: source.name }));
  for (const chunk of chimeChunks()) fan(session, (conn) => conn.send("live.chunk", { streamId, data: chunk.toString("base64") }));
  await recordAudit(source.actor, "live.announce", { type: source.kind, id: source.id }, { devices: online.length });
  return { streamId, deviceCount: online.length };
}

/** Passes a slice of the speaker's voice on. Anything that is not whole 16-bit samples of a sane size is dropped. */
export function pushLive(streamId: string, pcm: Buffer): boolean {
  const session = sessions.get(streamId);
  if (!session) return false;
  if (pcm.length === 0 || pcm.length > LIVE_MAX_CHUNK_BYTES || pcm.length % 2 !== 0) return false;
  session.idleTimer.refresh();
  const data = pcm.toString("base64");
  fan(session, (conn) => conn.send("live.chunk", { streamId, data }));
  return true;
}

/** Ends an announcement: the screens are told so they stop waiting for more. Safe to call twice. */
export function endLive(streamId: string): void {
  const session = sessions.get(streamId);
  if (!session) return;
  sessions.delete(streamId);
  clearTimeout(session.maxTimer);
  clearTimeout(session.idleTimer);
  fan(session, (conn) => conn.send("live.end", { streamId }));
  session.onEnd?.();
}

/** Sends to each target that is still connected; a screen that dropped is skipped, it never stops the others. */
function fan(session: Session, send: (conn: NonNullable<ReturnType<typeof registry.get>>) => unknown) {
  for (const id of session.targets) {
    const conn = registry.get(id);
    if (!conn?.open) continue;
    try {
      send(conn);
    } catch {
      /* a socket that broke mid-send is handled by its own close */
    }
  }
}
