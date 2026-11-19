import { readWav, writeWav, type PcmWav } from "./wav.js";

/**
 * Chimes played before a voice announcement, by severity. They were designed from two reference recordings (spectral analysis
 * of the announcements and the chimes before them), so each severity keeps the character of its example:
 *
 * - info: a soft double "ding", one pitch struck twice 0.5 s apart (F#4 with its 3rd and 5th harmonics, a hollow glassy tone
 *   that dies in about half a second). Quiet: about -12 dBFS at the peak.
 * - important: two bells rising, a deep one (G3 with partials near 724, 891 and 1264 Hz) and then a bright one (G4 with partials
 *   near 658, 927, 1100 and 1979 Hz). About -7 dBFS.
 * - urgent: the bright bell struck three times in a row, then left to ring. About -3 dBFS.
 *
 * A louder chime means a more serious announcement. The chime is generated here, at the sample rate of the voice it precedes,
 * and joined to it, so a door unit or a Faculty screen just plays one file and needs to know nothing about chimes.
 */
export const CHIME_LEVELS = ["info", "important", "urgent"] as const;
export type ChimeLevel = (typeof CHIME_LEVELS)[number];

/** One struck tone: a set of partials (frequency, relative level, seconds to fall by 60 dB) and when it is hit. */
interface Partial {
  hz: number;
  gain: number;
  decay: number;
}
interface Strike {
  at: number;
  partials: Partial[];
  /** Relative loudness of this strike. */
  level: number;
}

const DING: Partial[] = [
  { hz: 370, gain: 1, decay: 0.7 },
  { hz: 740, gain: 0.12, decay: 0.4 },
  { hz: 1110, gain: 0.55, decay: 0.45 },
  { hz: 1849, gain: 0.4, decay: 0.35 },
];
/*
 * The bells of the reference are rough, FM-like tones: next to each main partial there are side partials at a fixed spacing
 * (about 71 Hz around the low bell, 172 Hz around the bright one), which gives them their metallic buzz. The levels below are
 * the ones measured in the recordings, relative to the strongest partial.
 */
const LOW_BELL: Partial[] = [
  { hz: 194, gain: 1, decay: 1.1 },
  { hz: 265, gain: 0.65, decay: 0.9 },
  { hz: 336, gain: 0.09, decay: 0.6 },
  { hz: 582, gain: 0.26, decay: 0.7 },
  { hz: 653, gain: 0.19, decay: 0.7 },
  { hz: 724, gain: 0.46, decay: 0.8 },
  { hz: 795, gain: 0.09, decay: 0.6 },
  { hz: 892, gain: 0.37, decay: 0.8 },
  { hz: 1235, gain: 0.12, decay: 0.6 },
  { hz: 1264, gain: 0.64, decay: 0.8 },
  { hz: 1335, gain: 0.12, decay: 0.6 },
  { hz: 2796, gain: 0.1, decay: 0.4 },
  { hz: 2866, gain: 0.1, decay: 0.4 },
];
const HIGH_BELL: Partial[] = [
  { hz: 392, gain: 0.3, decay: 1.3 },
  { hz: 659, gain: 1, decay: 1.2 },
  { hz: 682, gain: 0.15, decay: 0.8 },
  { hz: 927, gain: 0.3, decay: 1 },
  { hz: 1100, gain: 0.6, decay: 1.1 },
  { hz: 1271, gain: 0.22, decay: 0.9 },
  { hz: 1444, gain: 0.16, decay: 0.8 },
  { hz: 1537, gain: 0.19, decay: 0.8 },
  { hz: 1714, gain: 0.13, decay: 0.7 },
  { hz: 1979, gain: 0.3, decay: 0.8 },
  { hz: 2420, gain: 0.12, decay: 0.5 },
  { hz: 2860, gain: 0.11, decay: 0.5 },
];

interface Design {
  strikes: Strike[];
  /** Length of the chime and of the pause before the voice, in seconds. */
  length: number;
  pause: number;
  /** Peak level, as a share of full scale. */
  peak: number;
}

const DESIGNS: Record<ChimeLevel, Design> = {
  info: { strikes: [{ at: 0, partials: DING, level: 0.85 }, { at: 0.51, partials: DING, level: 1 }], length: 1.2, pause: 0.35, peak: 0.25 },
  important: { strikes: [{ at: 0, partials: LOW_BELL, level: 1 }, { at: 0.66, partials: HIGH_BELL, level: 1 }], length: 1.9, pause: 0.25, peak: 0.45 },
  urgent: { strikes: [0, 0.27, 0.54].map((at, i) => ({ at, partials: HIGH_BELL, level: 0.85 + 0.075 * i })), length: 1.8, pause: 0.2, peak: 0.7 },
};

const ATTACK_SECONDS = 0.004;
/** The short noise burst of a strike, which is what makes a tone sound struck and not played. */
const TRANSIENT_SECONDS = 0.018;

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
  for (const strike of design.strikes) {
    const start = Math.round(strike.at * sampleRate);
    for (let i = 0; start + i < out.length; i++) {
      const t = i / sampleRate;
      const attack = Math.min(1, t / ATTACK_SECONDS);
      let value = 0;
      for (const p of strike.partials) {
        // 60 dB of fall in `decay` seconds: exp(-6.9 t / decay).
        value += p.gain * Math.exp((-6.9 * t) / p.decay) * Math.sin(2 * Math.PI * p.hz * t);
      }
      if (t < TRANSIENT_SECONDS) value += 0.6 * random() * (1 - t / TRANSIENT_SECONDS);
      out[start + i]! += strike.level * attack * value;
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
