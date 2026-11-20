import { describe, expect, it } from "vitest";
import { louden } from "./speechGain.js";
import { readWav, writeWav } from "./wav.js";

const tone = (amplitude: number, seconds = 0.5, rate = 16_000) =>
  writeWav({ sampleRate: rate, channels: 1, samples: Int16Array.from({ length: seconds * rate }, (_, i) => Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 220 * i) / rate))) });
const rms = (b: Buffer) => {
  const { samples } = readWav(b)!;
  return Math.sqrt(samples.reduce((n, s) => n + (s / 32768) ** 2, 0) / samples.length);
};
const peak = (b: Buffer) => readWav(b)!.samples.reduce((m, s) => Math.max(m, Math.abs(s)), 0) / 32768;

describe("louden", () => {
  it("raises a quiet voice to a forceful level without passing the ceiling", () => {
    const quiet = tone(0.1);
    const loud = louden(quiet)!;
    expect(rms(loud)).toBeGreaterThan(rms(quiet) * 1.8);
    expect(peak(loud)).toBeLessThanOrEqual(0.97);
  });

  it("rounds the peaks of an already loud voice instead of clipping them", () => {
    const loud = louden(tone(0.95))!;
    expect(peak(loud)).toBeLessThanOrEqual(0.97);
    // A hard clip would hold the peak for several samples in a row; the soft limiter does not flatten the wave.
    const { samples } = readWav(loud)!;
    const top = Math.max(...Array.from(samples.slice(0, 2000)).map(Math.abs));
    expect(samples.slice(0, 2000).filter((s) => Math.abs(s) === top).length).toBeLessThan(40);
  });

  it("keeps the format and the length, leaves silence alone, and refuses what is not 16-bit WAV", () => {
    const input = tone(0.1);
    const out = louden(input)!;
    expect(readWav(out)).toMatchObject({ sampleRate: 16_000, channels: 1 });
    expect(readWav(out)!.samples.length).toBe(readWav(input)!.samples.length);
    const silent = tone(0);
    expect(louden(silent)).toBe(silent);
    expect(louden(Buffer.from("not audio"))).toBeNull();
  });

  it("does not lift a nearly silent recording without limit", () => {
    expect(peak(louden(tone(0.002))!)).toBeLessThan(0.05);
  });
});
