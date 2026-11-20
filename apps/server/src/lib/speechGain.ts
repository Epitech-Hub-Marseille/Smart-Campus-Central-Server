import { readWav, writeWav } from "./wav.js";

/** The loudness an emergency read-out is brought to: a clear, forceful voice (about -15 dBFS RMS), and never louder than this peak. */
const TARGET_RMS = 0.18;
const CEILING = 0.97;
/** A very quiet recording is not raised without limit: that would only lift the noise. */
const MAX_GAIN = 8;

/**
 * Makes a spoken WAV louder for an emergency. Text-to-speech engines return speech at a polite level, and a read-out has to
 * be heard over a corridor and, on the doors, over the alarm. The gain brings the average level to a fixed target, and a
 * soft limiter (tanh) rounds the peaks that the gain would push past the ceiling instead of clipping them hard, so the
 * voice stays clean. Returns null when the audio is not a 16-bit PCM WAV, so the caller can send it unchanged.
 */
export function louden(voice: Buffer): Buffer | null {
  const wav = readWav(voice);
  if (!wav || wav.samples.length === 0) return null;
  let sum = 0;
  for (const s of wav.samples) sum += (s / 32768) ** 2;
  const rms = Math.sqrt(sum / wav.samples.length);
  if (rms < 1e-4) return voice; // silence stays silence
  const gain = Math.min(MAX_GAIN, TARGET_RMS / rms);
  const out = new Int16Array(wav.samples.length);
  for (let i = 0; i < out.length; i++) {
    const x = (wav.samples[i]! / 32768) * gain;
    out[i] = Math.round(CEILING * Math.tanh(x / CEILING) * 32767);
  }
  return writeWav({ sampleRate: wav.sampleRate, channels: wav.channels, samples: out });
}
