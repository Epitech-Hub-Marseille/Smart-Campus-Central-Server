import type { TtsEngine, Voice } from "../infra/tts.js";

/** A minimal valid WAV file: what a real engine would return, small enough for tests. */
export function tinyWav(): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  return header;
}

export const FAKE_VOICES: Voice[] = [
  { id: "nova", label: "Nova", language: "fr" },
  { id: "alloy", label: "Alloy", language: "en" },
];

/** Records what it was asked to say, so a test can check the text and the voice that reached the engine. */
export function fakeEngine(): TtsEngine & { calls: { text: string; voice: string; language: string; speed?: number }[] } {
  const calls: { text: string; voice: string; language: string; speed?: number }[] = [];
  return {
    calls,
    voices: () => FAKE_VOICES,
    async synthesize(request) {
      calls.push(request);
      // Different text gives different bytes, as with a real engine, so each announcement is its own asset.
      return Buffer.concat([tinyWav(), Buffer.from(request.text)]);
    },
  };
}
