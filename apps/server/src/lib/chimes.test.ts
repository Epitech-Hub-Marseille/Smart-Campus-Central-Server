import { describe, expect, it } from "vitest";
import { CHIME_IDS, CHIME_GROUPS, CHIME_PITCH, CHIME_SLOWDOWN, chimeCatalogue, chimeWav, prependChime, renderChime, type ChimeId } from "./chimes.js";
import { readWav, writeWav } from "./wav.js";

const RECORDED = 44_100;

/** Strength of one frequency in a stretch of samples (Goertzel), so a test can ask "is this note there?". */
function level(samples: Float32Array, hz: number, rate: number, from = 0, to = samples.length): number {
  const w = (2 * Math.PI * hz) / rate;
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
const at = (seconds: number, rate = RECORDED) => Math.round(seconds * rate);
const groupOf = (id: ChimeId) => chimeCatalogue().chimes.find((c) => c.id === id)!.group;

describe("the chimes", () => {
  it("all play: mono, a second or so long, not clipping and not cut off", () => {
    for (const id of CHIME_IDS) {
      const wav = readWav(chimeWav(id))!;
      expect(wav, id).toMatchObject({ sampleRate: RECORDED, channels: 1 });
      const seconds = wav.samples.length / RECORDED;
      expect(seconds, id).toBeGreaterThan(0.7);
      expect(seconds, id).toBeLessThan(1.6);
      const samples = renderChime(id, RECORDED);
      expect(peak(samples), id).toBeGreaterThan(0.25);
      expect(peak(samples), id).toBeLessThan(1);
      expect(samples.every((v) => Number.isFinite(v)), id).toBe(true);
      expect(Math.abs(samples[samples.length - 1]!), id).toBeLessThan(0.001);
    }
  });

  it("are quiet for information, louder for a warning, loudest when critical", () => {
    const peaks = (group: string) => CHIME_IDS.filter((id) => groupOf(id) === group).map((id) => peak(renderChime(id, RECORDED)));
    expect(Math.max(...peaks("info"))).toBeLessThan(Math.min(...peaks("warning")));
    expect(Math.max(...peaks("warning"))).toBeLessThan(Math.min(...peaks("critical")));
  });

  it("keep the character of their reference but are not copies: the same notes, one semitone higher", () => {
    expect(CHIME_PITCH).toBeCloseTo(1.0595, 3);
    expect(CHIME_SLOWDOWN).toBe(1.04);
    // [chime, reference pitch, window]: the moved pitch is strong, the reference's own pitch is not.
    const cases: [ChimeId, number, number, number][] = [
      ["info-dudu", 369, 0.05, 0.45],
      ["manual-override", 393, 0, 0.35],
      ["warning-dadac", 658, 0.05, 0.5],
      ["critical-buzwarn", 471, 0.05, 0.5],
      ["critical-deeoo", 1267, 0.03, 0.2],
      ["warning-dadeda", 505, 0.05, 0.45],
    ];
    for (const [id, hz, from, to] of cases) {
      const s = renderChime(id, RECORDED);
      const moved = level(s, hz * CHIME_PITCH, RECORDED, at(from), at(to));
      expect(moved, `${id} moved`).toBeGreaterThan(level(s, hz, RECORDED, at(from), at(to)) * 2.5);
    }
  });

  it("are the same at any rate of voice, with the same pitch, and never fold high partials back as noise", () => {
    for (const rate of [24_000, 16_000, 22_050]) {
      const s = renderChime("info-dudu", rate);
      const from = at(0.05, rate);
      const to = at(0.45, rate);
      expect(level(s, 369 * CHIME_PITCH, rate, from, to)).toBeGreaterThan(level(s, 369, rate, from, to) * 2.5);
      expect(s.every((v) => Number.isFinite(v))).toBe(true);
    }
    // At 16 kHz the buzz has partials the rate cannot carry: none is allowed to fold below, so nothing sits above 0.45 of the rate.
    const buzz = renderChime("critical-buzwarn", 16_000);
    expect(level(buzz, 7500, 16_000, 2000, 12_000)).toBeLessThan(level(buzz, 499, 16_000, 2000, 12_000) * 0.2);
  });

  it("are always the same", () => {
    expect(renderChime("warning-dadab", 24_000)).toEqual(renderChime("warning-dadab", 24_000));
  });

  it("are listed for the console by group, with a name each", () => {
    const { groups, chimes } = chimeCatalogue();
    expect(groups.map((g) => g.id)).toEqual(CHIME_GROUPS.map((g) => g.id));
    expect(chimes).toHaveLength(CHIME_IDS.length);
    expect(chimes.every((c) => c.label.length > 0 && groups.some((g) => g.id === c.group))).toBe(true);
  });
});

describe("a chime in front of a voice", () => {
  const voice = (rate: number, channels: 1 | 2 = 1) => writeWav({ sampleRate: rate, channels, samples: new Int16Array(rate * channels).fill(1000) });

  it("is the chime, a pause, then the voice untouched, at the voice's own sample rate", () => {
    for (const rate of [24_000, 16_000, 44_100]) {
      const joined = readWav(prependChime(voice(rate), "info-dudu")!)!;
      expect(joined.sampleRate).toBe(rate);
      const chimeLength = renderChime("info-dudu", rate).length;
      const lead = chimeLength + Math.round(0.35 * rate);
      expect(joined.samples.length).toBe(lead + rate);
      expect(joined.samples.slice(lead).every((v) => v === 1000)).toBe(true);
      expect(joined.samples.slice(chimeLength, lead).every((v) => v === 0)).toBe(true);
    }
  });

  it("pauses less before the more urgent sounds", () => {
    const lead = (id: ChimeId) => readWav(prependChime(voice(24_000), id)!)!.samples.length - 24_000 - renderChime(id, 24_000).length;
    expect(lead("critical-deeoo")).toBeLessThan(lead("warning-dadaa"));
    expect(lead("warning-dadaa")).toBeLessThan(lead("info-bloop"));
  });

  it("keeps a stereo voice stereo", () => {
    const joined = readWav(prependChime(voice(24_000, 2), "critical-buzwarn")!)!;
    expect(joined.channels).toBe(2);
    expect(joined.samples[1000]).toBe(joined.samples[1001]);
  });

  it("reads a streaming WAV whose header does not know its length", () => {
    const wav = voice(24_000);
    wav.writeUInt32LE(0xffffffff, 40);
    wav.writeUInt32LE(0xffffffff, 4);
    expect(readWav(wav)!.samples.length).toBe(24_000);
  });

  it("gives null for anything that is not a 16-bit PCM WAV, or for a chime that does not exist, so the voice goes out as it is", () => {
    expect(prependChime(Buffer.from("ID3 not wav at all, an mp3 or something else"), "info-dudu")).toBeNull();
    const eightBit = voice(24_000);
    eightBit.writeUInt16LE(8, 34);
    expect(prependChime(eightBit, "info-dudu")).toBeNull();
    expect(prependChime(Buffer.alloc(10), "info-dudu")).toBeNull();
    expect(prependChime(voice(24_000), "urgent")).toBeNull();
  });
});
