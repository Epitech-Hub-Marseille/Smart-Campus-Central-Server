import { describe, expect, it } from "vitest";
import { CHIME_LEVELS, chimeWav, prependChime, renderChime, type ChimeLevel } from "./chimes.js";
import { readWav, writeWav } from "./wav.js";

const RATE = 24_000;

/** Strength of one frequency in a stretch of samples (Goertzel), so a test can ask "is this note there?". */
function level(samples: Float32Array, hz: number, from = 0, to = samples.length): number {
  const w = (2 * Math.PI * hz) / RATE;
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < to; i++) {
    const s0 = samples[i]! + 2 * Math.cos(w) * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - 2 * Math.cos(w) * s1 * s2) / (to - from);
}
const peak = (samples: Float32Array) => samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const seconds = (t: number) => Math.round(t * RATE);

describe("chimes", () => {
  it("get louder with the severity, never clip, and are always the same", () => {
    const peaks = CHIME_LEVELS.map((l) => peak(renderChime(l, RATE)));
    expect(peaks[0]!).toBeCloseTo(0.25, 2);
    expect(peaks[0]!).toBeLessThan(peaks[1]!);
    expect(peaks[1]!).toBeLessThan(peaks[2]!);
    expect(peaks[2]!).toBeLessThan(0.8);
    expect(renderChime("urgent", RATE)).toEqual(renderChime("urgent", RATE));
  });

  it("info is one pitch struck twice, 0.5 s apart, with the hollow odd harmonics of the reference", () => {
    const chime = renderChime("info", RATE);
    // F#4 and its 3rd and 5th harmonics ring; the pitch between them, a 4th harmonic, does not.
    const fundamental = level(chime, 370);
    expect(level(chime, 1110)).toBeGreaterThan(level(chime, 1480) * 3);
    expect(level(chime, 1849)).toBeGreaterThan(level(chime, 1480) * 2);
    expect(fundamental).toBeGreaterThan(level(chime, 440) * 5);
    // Two strikes: the second one is heard in its own half of the chime.
    const second = seconds(0.55);
    expect(level(chime, 370, second, second + seconds(0.2))).toBeGreaterThan(level(chime, 370, seconds(0.38), seconds(0.5)) * 1.5);
  });

  it("important rises from the low bell (G3 side) to the bright one (G4 side)", () => {
    const chime = renderChime("important", RATE);
    const first = [0, seconds(0.5)] as const;
    const second = [seconds(0.7), seconds(1.1)] as const;
    expect(level(chime, 194, ...first)).toBeGreaterThan(level(chime, 194, ...second));
    expect(level(chime, 1264, ...first)).toBeGreaterThan(level(chime, 1264, ...second) * 2);
    expect(level(chime, 659, ...second)).toBeGreaterThan(level(chime, 659, ...first) * 2);
  });

  it("urgent strikes the bright bell three times, 0.27 s apart", () => {
    const chime = renderChime("urgent", RATE);
    const strike = (n: number) => level(chime, 659, seconds(0.27 * n), seconds(0.27 * n + 0.05));
    // Each strike is a fresh burst on top of the ringing: the first 50 ms of a strike is stronger than the end of the previous one.
    const before = (n: number) => level(chime, 659, seconds(0.27 * n - 0.07), seconds(0.27 * n - 0.02));
    expect(strike(1)).toBeGreaterThan(before(1));
    expect(strike(2)).toBeGreaterThan(before(2));
    expect(strike(0)).toBeGreaterThan(0);
  });

  it("ends without a click", () => {
    for (const l of CHIME_LEVELS) {
      const chime = renderChime(l, RATE);
      expect(Math.abs(chime[chime.length - 1]!)).toBeLessThan(0.001);
    }
  });

  it("can be heard on their own as a WAV", () => {
    for (const l of CHIME_LEVELS) {
      const wav = readWav(chimeWav(l));
      expect(wav).toMatchObject({ sampleRate: 24_000, channels: 1 });
      expect(wav!.samples.length).toBeGreaterThan(24_000);
    }
  });
});

describe("a chime in front of a voice", () => {
  const voice = (rate: number, channels: 1 | 2 = 1) => writeWav({ sampleRate: rate, channels, samples: new Int16Array(rate * channels).fill(1000) });

  it("is the chime, a pause, then the voice untouched, at the voice's own sample rate", () => {
    for (const rate of [24_000, 16_000, 44_100]) {
      const joined = readWav(prependChime(voice(rate), "info" as ChimeLevel)!)!;
      expect(joined.sampleRate).toBe(rate);
      const lead = Math.round(1.2 * rate) + Math.round(0.35 * rate);
      expect(joined.samples.length).toBe(lead + rate);
      expect(joined.samples.slice(lead).every((v) => v === 1000)).toBe(true);
      // The pause is silent.
      expect(joined.samples.slice(Math.round(1.2 * rate), lead).every((v) => v === 0)).toBe(true);
    }
  });

  it("keeps a stereo voice stereo", () => {
    const joined = readWav(prependChime(voice(24_000, 2), "urgent")!)!;
    expect(joined.channels).toBe(2);
    expect(joined.samples[0]).toBe(joined.samples[1]);
  });

  it("reads a streaming WAV whose header does not know its length", () => {
    const wav = voice(24_000);
    wav.writeUInt32LE(0xffffffff, 40);
    wav.writeUInt32LE(0xffffffff, 4);
    expect(readWav(wav)!.samples.length).toBe(24_000);
  });

  it("gives null for anything that is not a 16-bit PCM WAV, so the voice goes out as it is", () => {
    expect(prependChime(Buffer.from("ID3 not wav at all, an mp3 or something else"), "info")).toBeNull();
    const eightBit = voice(24_000);
    eightBit.writeUInt16LE(8, 34);
    expect(prependChime(eightBit, "info")).toBeNull();
    expect(prependChime(Buffer.alloc(10), "info")).toBeNull();
  });
});
