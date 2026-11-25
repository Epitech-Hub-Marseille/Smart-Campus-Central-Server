import { LIVE_MAX_CHUNK_BYTES, type CallState } from "@smartcampus/protocol";
import { registry } from "../gateway/registry.js";
import { AttemptLimiter } from "../gateway/rateLimit.js";
import { recordAudit } from "../lib/audit.js";
import { DeviceModel } from "../models/device.js";
import { RoomModel } from "../models/room.js";

/** A call nobody answers stops ringing after this long. */
export const RING_MS = 30_000;
/** A call is cut after this long, so a forgotten one does not keep two microphones open. */
export const MAX_CALL_MS = 10 * 60_000;

/** A terminal may start 6 calls a minute: a finger on the button must not ring another room for ever. */
const limiter = new AttemptLimiter(6, 60_000);

interface Call {
  callId: string;
  caller: string;
  callee: string;
  callerName: string;
  calleeName: string;
  state: "ringing" | "active";
  ringTimer: NodeJS.Timeout;
  maxTimer?: NodeJS.Timeout;
}

const calls = new Map<string, Call>();
const callOf = (deviceId: string) => [...calls.values()].find((c) => c.caller === deviceId || c.callee === deviceId);

/** What a person at a door knows a terminal by: its room, else the name it was given. */
async function nameOf(deviceId: string): Promise<string> {
  const device = await DeviceModel.findOne({ deviceId }, { name: 1, room: 1 });
  const room = device?.room ? await RoomModel.findById(device.room, { name: 1 }) : null;
  return room?.name || device?.name || deviceId;
}

/** The other door terminals, for the list a person picks from. */
export async function listPeers(deviceId: string) {
  const devices = await DeviceModel.find({ status: "active", type: "door", deviceId: { $ne: deviceId } }, { deviceId: 1, name: 1, room: 1 });
  const peers = await Promise.all(devices.map(async (d) => ({ id: d.deviceId, name: await nameOf(d.deviceId), online: registry.isOnline(d.deviceId) })));
  return peers.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

const send = (deviceId: string, fn: (conn: NonNullable<ReturnType<typeof registry.get>>) => unknown) => {
  const conn = registry.get(deviceId);
  if (!conn?.open) return;
  try {
    fn(conn);
  } catch {
    /* a socket that broke mid-send is handled by its own close */
  }
};

const tell = (deviceId: string, call: Call, state: CallState) =>
  send(deviceId, (c) => c.send("call.state", { callId: call.callId, state, peer: deviceId === call.caller ? call.calleeName : call.callerName }));

function finish(call: Call, state: CallState) {
  if (!calls.delete(call.callId)) return;
  clearTimeout(call.ringTimer);
  clearTimeout(call.maxTimer);
  tell(call.caller, call, state);
  tell(call.callee, call, state);
}

export interface CallResult {
  ok: boolean;
  /** Why the call did not start: one of the states a screen can word. */
  state?: CallState;
}

/**
 * `caller` rings `target`. Refused when the target is not an active door terminal, is offline, or either side is already on a
 * call. The callee's microphone stays closed until it accepts: nobody can open a room's microphone from outside.
 */
export async function startCall(caller: string, target: string, callId: string, now = Date.now()): Promise<CallResult> {
  if (caller === target || !limiter.allow(caller, now)) return { ok: false, state: "unavailable" };
  const device = await DeviceModel.findOne({ deviceId: target, status: "active", type: "door" }, { _id: 1 });
  if (!device || !registry.get(target)?.open) return { ok: false, state: "unavailable" };
  if (callOf(caller) || callOf(target)) return { ok: false, state: "busy" };

  const [callerName, calleeName] = await Promise.all([nameOf(caller), nameOf(target)]);
  // Another call may have started while the names were looked up.
  if (callOf(caller) || callOf(target)) return { ok: false, state: "busy" };
  const call: Call = { callId, caller, callee: target, callerName, calleeName, state: "ringing", ringTimer: setTimeout(() => finish(call, "timeout"), RING_MS) };
  calls.set(callId, call);
  tell(caller, call, "ringing");
  send(target, (c) => c.send("call.incoming", { callId, from: callerName }));
  return { ok: true };
}

/** The called terminal accepts or declines. Anything from another terminal, or for a call that is not ringing, is ignored. */
export async function answerCall(deviceId: string, callId: string, accept: boolean): Promise<void> {
  const call = calls.get(callId);
  if (!call || call.callee !== deviceId || call.state !== "ringing") return;
  if (!accept) return finish(call, "declined");
  clearTimeout(call.ringTimer);
  call.state = "active";
  call.maxTimer = setTimeout(() => finish(call, "ended"), MAX_CALL_MS);
  tell(call.caller, call, "active");
  tell(call.callee, call, "active");
  await recordAudit(null, "intercom.call", { type: "device", id: call.caller }, { from: call.callerName, to: call.calleeName });
}

/** Either side hangs up (or the caller cancels while it rings). */
export function hangUp(deviceId: string, callId: string): void {
  const call = calls.get(callId);
  if (call && (call.caller === deviceId || call.callee === deviceId)) finish(call, "ended");
}

/** Passes one side's voice to the other. Only during an active call, only whole 16-bit samples of a sane size. */
export function relayCallAudio(deviceId: string, callId: string, pcm: Buffer): boolean {
  const call = calls.get(callId);
  if (!call || call.state !== "active" || (call.caller !== deviceId && call.callee !== deviceId)) return false;
  if (pcm.length === 0 || pcm.length > LIVE_MAX_CHUNK_BYTES || pcm.length % 2 !== 0) return false;
  const data = pcm.toString("base64");
  send(deviceId === call.caller ? call.callee : call.caller, (c) => c.send("call.audio", { callId, data }));
  return true;
}

/** A terminal dropped: its call ends, and the other side is told. */
export function dropCallsOf(deviceId: string): void {
  const call = callOf(deviceId);
  if (call) finish(call, "ended");
}

/** True while this terminal is ringing or on a call. */
export const inCall = (deviceId: string) => callOf(deviceId) !== undefined;
