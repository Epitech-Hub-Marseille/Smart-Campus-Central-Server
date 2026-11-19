import { readWav, writeWav, type PcmWav } from "./wav.js";

/**
 * Chimes played before a voice announcement, by severity. They were designed from the reference sounds in
 * `docs/inspiration/chimes` (measured pitch, partials, rhythm and level of each), as new sounds with the same character:
 *
 * - info: two soft sine blips, a rising fifth ("doo-oop"), each with a little third harmonic and a gentle fall. Quiet, about -9 dBFS.
 * - important (the "warning" family): two held "da-da" tones on E5, 0.54 s apart, with the shimmer of a 27 Hz side partial and
 *   bright upper partials. About -5 dBFS.
 * - urgent (the "critical" family): a bright stab that drops into a harsh buzz, "dee-BUZZ": a sawtooth near 235 Hz, chopped
 *   14 times a second. About -1 dBFS.
 * - override ("manual override"): two clean beeps on A4, a pure tone with its third harmonic. About -3.5 dBFS.
 * - important-override ("important manual override"): a busy figure of bells, E5, C5, a bright dyad, then a low tail. About -1 dBFS.
 *
 * A louder chime means a more serious announcement. The chime is generated here, at the sample rate of the voice it precedes,
 * and joined to it, so a door unit or a Faculty screen just plays one file and needs to know nothing about chimes.
 */
export const CHIME_LEVELS = ["info", "important", "urgent", "override", "important-override"] as const;
export type ChimeLevel = (typeof CHIME_LEVELS)[number];

/** One tone of a note: a frequency in Hz and its level relative to the strongest. */
interface Partial {
  hz: number;
  gain: number;
}

/** A tone that starts at `at`, is held for `hold` seconds and fades out over `release`. */
interface Note {
  at: number;
  hold: number;
  partials: Partial[];
  /** Level of the note in the chime. */
  level?: number;
  /** Seconds to rise to full level. */
  attack?: number;
  /** Seconds to fall by 60 dB while held; left out, the level stays steady. */
  decay?: number;
  release?: number;
  /** Chops the note in level `hz` times a second, `depth` between 0 and 1. */
  chop?: { hz: number; depth: number };
  /** Share of soft noise (breath) mixed in, between 0 and 1. */
  breath?: number;
}

interface Design {
  notes: Note[];
  /** Length of the chime and of the pause before the voice, in seconds. */
  length: number;
  pause: number;
  /** Peak level, as a share of full scale. */
  peak: number;
}

/** A tone and the 3rd harmonic that gives the reference blips their rounded, slightly hollow sound. */
const soft = (hz: number): Partial[] => [
  { hz, gain: 1 },
  { hz: hz * 2, gain: 0.08 },
  { hz: hz * 3, gain: 0.45 },
];

/**
 * The tone of the "da-da" warning: E5 with the bright partials measured in the reference (1103, 1710, 1978 and 932 Hz) and
 * the side partials about 27 Hz either side that make it shimmer.
 */
const shimmer = (hz: number): Partial[] => [
  { hz, gain: 1 },
  { hz: hz - 27, gain: 0.17 },
  { hz: hz + 27, gain: 0.22 },
  { hz: hz - 55, gain: 0.1 },
  { hz: hz + 60, gain: 0.14 },
  { hz: hz * 1.676, gain: 0.36 },
  { hz: hz * 1.41, gain: 0.12 },
  { hz: hz * 2.6, gain: 0.21 },
  { hz: hz * 3.01, gain: 0.15 },
];

/** A harsh sawtooth: every harmonic of `hz` up to 8 kHz, weaker as they climb, with the 2nd and 6th stressed as in the reference. */
function sawtooth(hz: number): Partial[] {
  const partials: Partial[] = [];
  for (let k = 1; k * hz < 8000; k++) partials.push({ hz: hz * k, gain: (1 / k) * (k === 2 || k === 6 ? 2.2 : 1) });
  return partials;
}

/** The bright stab at the start of the critical sound, from the measured partials 1267, 1250, 895, 733 and 654 Hz. */
const STAB: Partial[] = [
  { hz: 1267, gain: 1 },
  { hz: 1250, gain: 0.8 },
  { hz: 895, gain: 0.72 },
  { hz: 733, gain: 0.33 },
  { hz: 654, gain: 0.2 },
  { hz: 266, gain: 0.35 },
];

const DESIGNS: Record<ChimeLevel, Design> = {
  info: {
    notes: [
      { at: 0, hold: 0.12, partials: soft(293.7), attack: 0.012, decay: 0.45, release: 0.2, breath: 0.03 },
      { at: 0.3, hold: 0.12, partials: soft(440), attack: 0.012, decay: 0.55, release: 0.45, breath: 0.03, level: 0.9 },
    ],
    length: 1.3,
    pause: 0.35,
    peak: 0.35,
  },
  important: {
    notes: [
      { at: 0, hold: 0.4, partials: shimmer(659.3), attack: 0.03, release: 0.1 },
      { at: 0.54, hold: 0.4, partials: shimmer(659.3), attack: 0.03, release: 0.2, level: 1.05 },
    ],
    length: 1.3,
    pause: 0.25,
    peak: 0.55,
  },
  urgent: {
    notes: [
      { at: 0, hold: 0.2, partials: STAB, attack: 0.004, release: 0.05 },
      { at: 0.22, hold: 0.68, partials: sawtooth(235.5), attack: 0.01, decay: 3, release: 0.12, chop: { hz: 14, depth: 0.35 } },
    ],
    length: 1.1,
    pause: 0.15,
    peak: 0.9,
  },
  override: {
    notes: [
      { at: 0, hold: 0.34, partials: soft(440), attack: 0.006, release: 0.02 },
      { at: 0.46, hold: 0.24, partials: soft(440), attack: 0.006, release: 0.02 },
    ],
    length: 0.9,
    pause: 0.25,
    peak: 0.67,
  },
  "important-override": {
    notes: [
      { at: 0, hold: 0.22, partials: shimmer(659.3), attack: 0.01, release: 0.04 },
      { at: 0.27, hold: 0.13, partials: shimmer(523.3), attack: 0.01, release: 0.04 },
      {
        at: 0.45,
        hold: 0.32,
        partials: [
          { hz: 1262, gain: 1 },
          { hz: 1235, gain: 0.26 },
          { hz: 1290, gain: 0.26 },
          { hz: 892, gain: 0.74 },
          { hz: 659, gain: 0.54 },
        ],
        attack: 0.008,
        release: 0.05,
        chop: { hz: 27, depth: 0.2 },
      },
      { at: 0.82, hold: 0.2, partials: [...soft(325), ...soft(217).map((p) => ({ ...p, gain: p.gain * 0.5 }))], attack: 0.01, decay: 0.8, release: 0.2, level: 0.8 },
    ],
    length: 1.4,
    pause: 0.2,
    peak: 0.88,
  },
};

/** A fixed noise source: chimes must sound the same every time, and tests must be able to compare them. */
function noise(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x80000000 - 1;
  };
}

/** The chime as mono samples in [-1, 1] at [sampleRate], without the pause that follows it. */
export function renderChime(level: ChimeLevel, sampleRate: number): Float32Array {
  const design = DESIGNS[level];
  const out = new Float32Array(Math.round(design.length * sampleRate));
  const random = noise(level.length * 7919);
  for (const note of design.notes) {
    const start = Math.round(note.at * sampleRate);
    const attack = note.attack ?? 0.005;
    const release = note.release ?? 0.05;
    const total = note.hold + release;
    const strongest = note.partials.reduce((m, p) => m + p.gain, 0) || 1;
    for (let i = 0; start + i < out.length && i / sampleRate < total; i++) {
      const t = i / sampleRate;
      let envelope = Math.min(1, t / attack);
      if (note.decay) envelope *= Math.exp((-6.9 * t) / note.decay);
      if (t > note.hold) envelope *= Math.max(0, 1 - (t - note.hold) / release);
      if (note.chop) envelope *= 1 - note.chop.depth / 2 + (note.chop.depth / 2) * Math.sin(2 * Math.PI * note.chop.hz * t);
      let value = 0;
      for (const p of note.partials) value += p.gain * Math.sin(2 * Math.PI * p.hz * t);
      value /= strongest;
      if (note.breath) value += note.breath * random();
      out[start + i]! += (note.level ?? 1) * envelope * value;
    }
  }
  // Fade the end so the chime never ends on a click.
  const fade = Math.round(0.03 * sampleRate);
  for (let i = 0; i < fade && i < out.length; i++) out[out.length - 1 - i]! *= i / fade;
  let max = 0;
  for (const v of out) max = Math.max(max, Math.abs(v));
  const scale = max > 0 ? design.peak / max : 0;
  for (let i = 0; i < out.length; i++) out[i]! *= scale;
  return out;
}

const toPcm = (value: number) => Math.max(-32768, Math.min(32767, Math.round(value * 32767)));

/** The chime on its own, as a WAV file, to pre-listen. */
export function chimeWav(level: ChimeLevel, sampleRate = 24_000): Buffer {
  const samples = Int16Array.from(renderChime(level, sampleRate), toPcm);
  return writeWav({ sampleRate, channels: 1, samples });
}

/**
 * Puts the chime in front of a spoken WAV: the chime, a short pause, then the voice, all at the voice's own sample rate and
 * channel count. Returns null when the voice is not a 16-bit PCM WAV, so the caller can send the voice as it is.
 */
export function prependChime(voice: Buffer, level: ChimeLevel): Buffer | null {
  const speech: PcmWav | null = readWav(voice);
  if (!speech) return null;
  const chime = renderChime(level, speech.sampleRate);
  const pause = Math.round(DESIGNS[level].pause * speech.sampleRate);
  const frames = chime.length + pause;
  const samples = new Int16Array(frames * speech.channels + speech.samples.length);
  for (let i = 0; i < chime.length; i++) for (let c = 0; c < speech.channels; c++) samples[i * speech.channels + c] = toPcm(chime[i]!);
  samples.set(speech.samples, frames * speech.channels);
  return writeWav({ sampleRate: speech.sampleRate, channels: speech.channels, samples });
}
