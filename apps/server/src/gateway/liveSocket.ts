import { LIVE_MAX_CHUNK_BYTES } from "@smartcampus/protocol";
import type { RawData, WebSocket } from "ws";
import { z } from "zod";
import { endLive, pushLive, startLive } from "../domain/liveVoice.js";
import { targetsInput } from "../domain/targeting.js";
import { HttpError } from "../lib/errors.js";
import type { PublicUser } from "../models/user.js";

/** The largest frame the console may send: a chunk of voice, or a small JSON command. */
export const LIVE_SOCKET_MAX_PAYLOAD = LIVE_MAX_CHUNK_BYTES + 1024;

const command = z.discriminatedUnion("type", [z.object({ type: z.literal("start"), targets: targetsInput }), z.object({ type: z.literal("end") })]);

/**
 * Console microphone (/ws/live): the person speaking sends a `start` with the screens to reach, then binary frames of 16-bit mono
 * PCM at 16 kHz, then `end`. Only the voice goes this way; the same session cookie as the rest of the console authorises it.
 */
export function handleLiveSocket(ws: WebSocket, user: PublicUser): void {
  const send = (msg: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  let streamId: string | undefined;
  let starting = false;

  const stop = () => {
    if (streamId) endLive(streamId);
    streamId = undefined;
  };

  async function onText(text: string) {
    let parsed;
    try {
      parsed = command.safeParse(JSON.parse(text));
    } catch {
      parsed = undefined;
    }
    if (!parsed?.success) return void send({ type: "error", error: "Invalid command" });
    if (parsed.data.type === "end") {
      stop();
      return void send({ type: "ended" });
    }
    if (streamId || starting) return void send({ type: "error", error: "Already on the air" });
    starting = true;
    try {
      const started = await startLive(
        { kind: "console", id: user.id, name: user.name, actor: { id: user.id, name: user.name } },
        parsed.data.targets,
        undefined,
        () => {
          // Cut by the server (time limit or silence): the console learns it is off the air.
          streamId = undefined;
          send({ type: "ended" });
        },
      );
      streamId = started.streamId;
      send({ type: "started", deviceCount: started.deviceCount });
    } catch (err) {
      send({ type: "error", error: err instanceof HttpError ? err.message : "Could not start the announcement" });
    } finally {
      starting = false;
    }
  }

  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (streamId) pushLive(streamId, buf);
      return;
    }
    void onText(data.toString("utf8"));
  });
  ws.on("error", () => {});
  ws.on("close", stop);
}
