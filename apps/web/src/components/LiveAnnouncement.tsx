import { Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ErrorText } from "@/components/Field";
import { emptyTargetState, TargetPicker, toTargets, type TargetState } from "@/components/TargetPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Downsampler, toFrames } from "@/lib/pcm";

type Phase = "idle" | "connecting" | "live";

const liveUrl = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/live`;

/** The longest announcement, matching the server: the microphone is closed at that point whatever happens. */
const MAX_SECONDS = 180;

/**
 * Speak to the chosen screens straight from this computer's microphone. The screens play the "manual override" chime first,
 * then your voice live. The microphone is only open between "Go live" and "Stop", and a tab that is closed ends it.
 */
export function LiveAnnouncement() {
  const [targets, setTargets] = useState<TargetState>(emptyTargetState());
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const stopRef = useRef<() => void>(() => {});

  // Leaving the page must not leave the microphone open.
  useEffect(() => () => stopRef.current(), []);

  useEffect(() => {
    if (phase !== "live") return;
    setSeconds(0);
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  async function start() {
    const chosen = toTargets(targets);
    if (!chosen) return setError("Choose where to announce");
    setError(null);
    setNotice(null);
    setPhase("connecting");

    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let socket: WebSocket | undefined;
    let ended = false;
    const finish = (message?: string) => {
      if (ended) return;
      ended = true;
      stream?.getTracks().forEach((t) => t.stop());
      void context?.close().catch(() => {});
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "end" }));
        socket.close();
      }
      stopRef.current = () => {};
      setPhase("idle");
      if (message) setNotice(message);
    };
    stopRef.current = () => finish();

    try {
      // Echo cancellation and noise suppression matter here: the screens are in the same building as the speaker.
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      socket = new WebSocket(liveUrl());
      socket.binaryType = "arraybuffer";
      const opened = socket;
      await new Promise<void>((resolve, reject) => {
        opened.onopen = () => resolve();
        opened.onerror = () => reject(new Error("Could not reach the server"));
      });
      const answer = new Promise<{ deviceCount: number }>((resolve, reject) => {
        opened.onmessage = (event) => {
          const msg = JSON.parse(String(event.data));
          if (msg.type === "started") resolve(msg);
          else if (msg.type === "error") reject(new Error(msg.error));
          else if (msg.type === "ended") finish("The announcement ended.");
        };
        opened.onclose = () => {
          reject(new Error("The connection closed"));
          finish();
        };
      });
      opened.send(JSON.stringify({ type: "start", targets: chosen }));
      const started = await answer;

      context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const down = new Downsampler(context.sampleRate);
      // Deprecated but the one thing every browser still runs without a separate worker file; the work per block is small.
      const processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        if (opened.readyState !== WebSocket.OPEN) return;
        for (const frame of toFrames(down.push(e.inputBuffer.getChannelData(0)))) opened.send(frame);
      };
      const mute = context.createGain();
      mute.gain.value = 0; // the processor needs an output to run, and nothing of the microphone may come out of this computer
      source.connect(processor);
      processor.connect(mute);
      mute.connect(context.destination);
      setPhase("live");
      setNotice(`On air on ${started.deviceCount} screen${started.deviceCount === 1 ? "" : "s"}.`);
      setTimeout(() => finish("The time limit was reached."), MAX_SECONDS * 1000);
    } catch (e) {
      finish();
      setError(e instanceof DOMException && e.name === "NotAllowedError" ? "The browser refused access to the microphone." : e instanceof Error ? e.message : "Could not start");
    }
  }

  const live = phase === "live";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Live announcement</CardTitle>
        <CardDescription>Speak through your microphone. The screens play the manual override chime, then your voice as you say it.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <TargetPicker value={targets} onChange={setTargets} />
        <ErrorText>{error}</ErrorText>
        {notice && (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        )}
        <div className="flex items-center gap-3">
          {live ? (
            <Button type="button" variant="destructive" onClick={() => stopRef.current()}>
              <Square /> Stop
            </Button>
          ) : (
            <Button type="button" disabled={phase === "connecting"} onClick={() => void start()}>
              <Mic /> {phase === "connecting" ? "Connecting…" : "Go live"}
            </Button>
          )}
          {live && (
            <span className="flex items-center gap-2 text-sm" aria-live="off">
              <span className="size-2 animate-pulse rounded-full bg-destructive" aria-hidden /> On air {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
