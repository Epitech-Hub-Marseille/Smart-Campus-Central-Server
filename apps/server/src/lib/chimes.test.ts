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

const rms = (samples: Float32Array, from: number, to: number) => Math.sqrt(samples.slice(from, to).reduce((sum, v) => sum + v * v, 0) / (to - from));

describe("chimes", () => {
  it("get louder with the severity, never clip, and are always the same", () => {
    const peaks = Object.fromEntries(CHIME_LEVELS.map((l) => [l, peak(renderChime(l, RATE))]));
    expect(peaks.info!).toBeCloseTo(0.35, 2);
    expect(peaks.important!).toBeCloseTo(0.55, 2);
    expect(peaks.urgent!).toBeCloseTo(0.9, 2);
    expect(peaks.info!).toBeLessThan(peaks.important!);
    expect(peaks.important!).toBeLessThan(peaks.urgent!);
    // The manual ones sit in between, the important one nearly as loud as an urgent one.
    expect(peaks.override!).toBeCloseTo(0.67, 2);
    expect(peaks["important-override"]!).toBeCloseTo(0.88, 2);
    expect(Math.max(...Object.values(peaks))).toBeLessThan(0.95);
    expect(renderChime("urgent", RATE)).toEqual(renderChime("urgent", RATE));
  });

  it("info is two soft blips, a rising fifth: D4 then A4, each with a little third harmonic", () => {
    const chime = renderChime("info", RATE);
    const first = [seconds(0.03), seconds(0.25)] as const;
    const second = [seconds(0.33), seconds(0.55)] as const;
    expect(level(chime, 293.7, ...first)).toBeGreaterThan(level(chime, 293.7, ...second) * 2);
    expect(level(chime, 440, ...second)).toBeGreaterThan(level(chime, 440, ...first) * 2);
    // The third harmonic is there, the fourth is not.
    expect(level(chime, 881, ...first)).toBeGreaterThan(level(chime, 1175, ...first) * 3);
    expect(level(chime, 1320, ...second)).toBeGreaterThan(level(chime, 1100, ...second) * 3);
  });

  it("important is two held E5 tones 0.54 s apart, with a shimmer and bright upper partials", () => {
    const chime = renderChime("important", RATE);
    const held = (t0: number, t1: number) => level(chime, 659.3, seconds(t0), seconds(t1));
    expect(held(0.08, 0.35)).toBeGreaterThan(0.01);
    expect(held(0.62, 0.9)).toBeGreaterThan(0.01);
    // The tone stays steady while held, and there is a gap between the two.
    expect(rms(chime, seconds(0.46), seconds(0.52))).toBeLessThan(rms(chime, seconds(0.2), seconds(0.3)) * 0.3);
    // The side partial 27 Hz above is a real part of the tone, and the bright partial at 1103 Hz rings.
    expect(level(chime, 686.3, seconds(0.08), seconds(0.35))).toBeGreaterThan(level(chime, 760, seconds(0.08), seconds(0.35)) * 4);
    expect(level(chime, 1105, seconds(0.08), seconds(0.35))).toBeGreaterThan(level(chime, 1300, seconds(0.08), seconds(0.35)) * 3);
  });

  it("urgent is a bright stab that drops into a harsh chopped buzz", () => {
    const chime = renderChime("urgent", RATE);
    const stab = [seconds(0.02), seconds(0.19)] as const;
    const buzz = [seconds(0.3), seconds(0.85)] as const;
    expect(level(chime, 1267, ...stab)).toBeGreaterThan(level(chime, 1267, ...buzz) * 2);
    // The buzz is a sawtooth near 235 Hz: its harmonics, 2nd and 6th stressed, reach far up.
    expect(level(chime, 471, ...buzz)).toBeGreaterThan(level(chime, 400, ...buzz) * 4);
    expect(level(chime, 1413, ...buzz)).toBeGreaterThan(level(chime, 1300, ...buzz) * 3);
    expect(level(chime, 3297, ...buzz)).toBeGreaterThan(level(chime, 3180, ...buzz) * 3);
    // Chopped 14 times a second: the level goes up and down within 70 ms.
    const levels = [0, 1, 2, 3].map((n) => rms(chime, seconds(0.5 + n / 56), seconds(0.5 + n / 56 + 0.008)));
    expect(Math.max(...levels)).toBeGreaterThan(Math.min(...levels) * 1.25);
  });

  it("override is two clean beeps on A4, with a gap between them", () => {
    const chime = renderChime("override", RATE);
    expect(level(chime, 440, seconds(0.05), seconds(0.3))).toBeGreaterThan(level(chime, 523, seconds(0.05), seconds(0.3)) * 8);
    expect(level(chime, 440, seconds(0.5), seconds(0.68))).toBeGreaterThan(0.05);
    expect(rms(chime, seconds(0.38), seconds(0.44))).toBeLessThan(rms(chime, seconds(0.1), seconds(0.3)) * 0.1);
  });

  it("important-override runs E5, C5, a bright D#6 dyad, then a low tail", () => {
    const chime = renderChime("important-override", RATE);
    const at = (hz: number, t0: number, t1: number) => level(chime, hz, seconds(t0), seconds(t1));
    expect(at(659.3, 0.03, 0.2)).toBeGreaterThan(at(523.3, 0.03, 0.2) * 3);
    expect(at(523.3, 0.29, 0.38)).toBeGreaterThan(at(659.3, 0.29, 0.38) * 3);
    expect(at(1262, 0.48, 0.74)).toBeGreaterThan(at(523.3, 0.48, 0.74) * 5);
    expect(at(325, 0.85, 1.0)).toBeGreaterThan(at(1262, 0.85, 1.0) * 5);
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
      expect(wav!.samples.length).toBeGreaterThan(20_000);
    }
  });
});

describe("a chime in front of a voice", () => {
  const voice = (rate: number, channels: 1 | 2 = 1) => writeWav({ sampleRate: rate, channels, samples: new Int16Array(rate * channels).fill(1000) });

  it("is the chime, a pause, then the voice untouched, at the voice's own sample rate", () => {
    for (const rate of [24_000, 16_000, 44_100]) {
      const joined = readWav(prependChime(voice(rate), "info" as ChimeLevel)!)!;
      expect(joined.sampleRate).toBe(rate);
      const lead = Math.round(1.3 * rate) + Math.round(0.35 * rate);
      expect(joined.samples.length).toBe(lead + rate);
      expect(joined.samples.slice(lead).every((v) => v === 1000)).toBe(true);
      // The pause is silent.
      expect(joined.samples.slice(Math.round(1.3 * rate), lead).every((v) => v === 0)).toBe(true);
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
