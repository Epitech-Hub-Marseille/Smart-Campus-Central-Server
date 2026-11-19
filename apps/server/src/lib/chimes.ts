import { readFileSync } from "node:fs";
import { readWav, writeWav, type PcmWav } from "./wav.js";

/**
 * Chimes played before a voice announcement. They are synthesised from measurements of the reference sounds the campus chose
 * in `docs/inspiration/chimes` (`tools/chime-analysis.py` measures them): for each sound, the tracks of its partials (pitch and
 * level over time), its overall loudness and its peak level, in `assets/chimes/*.json`. The synthesiser plays those tracks as
 * sine waves, so a chime keeps the character of its reference (soft blips for information, held "da-da" tones for a warning, a
 * stab and a buzz for a critical message, beeps for a manual override, the roughness of each tone and the rhythm), but it is
 * not a copy: every chime is moved to its own pitch (a different step for each group) and played 4% slower, and no recording is kept
 * or played. To keep them clear, only the strongest partials are played, with their pitch smoothed.
 *
 * A chime is built at the sample rate of the voice it precedes and joined to it on the server, so a door unit or a Faculty
 * screen just plays one file and needs to know nothing about chimes.
 */
export const CHIME_GROUPS = [
  { id: "info", label: "Information" },
  { id: "warning", label: "Warning" },
  { id: "critical", label: "Critical" },
  { id: "manual-override", label: "Manual override" },
] as const;
export type ChimeGroup = (typeof CHIME_GROUPS)[number]["id"];

interface ChimeSpec {
  id: string;
  group: ChimeGroup;
  label: string;
  /** Seconds of silence between the chime and the voice: shorter for the more urgent sounds. */
  pause: number;
}

const CATALOGUE = [
  { id: "info-bloop", group: "info", label: "Bloop", pause: 0.35 },
  { id: "info-doop", group: "info", label: "Doop", pause: 0.35 },
  { id: "info-dudu", group: "info", label: "Dudu", pause: 0.35 },
  { id: "warning-dadaa", group: "warning", label: "Da-da (A)", pause: 0.25 },
  { id: "warning-dadab", group: "warning", label: "Da-da (B)", pause: 0.25 },
  { id: "warning-dadac", group: "warning", label: "Da-da (C)", pause: 0.25 },
  { id: "warning-dadeda", group: "warning", label: "Da-de-da", pause: 0.25 },
  { id: "critical-buzwarn", group: "critical", label: "Buzz warning", pause: 0.15 },
  { id: "critical-deeoo", group: "critical", label: "Dee-oo", pause: 0.15 },
  { id: "manual-override", group: "manual-override", label: "Manual override", pause: 0.2 },
  { id: "important-manual-override", group: "manual-override", label: "Important manual override", pause: 0.2 },
] as const satisfies readonly ChimeSpec[];

export const CHIME_IDS = CATALOGUE.map((c) => c.id) as [(typeof CATALOGUE)[number]["id"], ...(typeof CATALOGUE)[number]["id"][]];
export type ChimeId = (typeof CATALOGUE)[number]["id"];

/** What the console offers: every chime with its group and name. */
export const chimeCatalogue = () => ({ groups: CHIME_GROUPS, chimes: CATALOGUE.map(({ id, group, label }) => ({ id, group, label })) });

const specOf = (id: string): ChimeSpec | undefined => CATALOGUE.find((c) => c.id === id);

/**
 * What makes a chime its own and not a copy: each group is moved up by its own number of semitones (information a minor third,
 * warning a whole tone, critical a semitone, manual override a fourth) and every chime is played 4% slower.
 */
export const CHIME_SEMITONES: Record<ChimeGroup, number> = { info: 3, warning: 2, critical: 1, "manual-override": 5 };
export const CHIME_SLOWDOWN = 1.04;
export const chimePitch = (id: ChimeId) => 2 ** (CHIME_SEMITONES[specOf(id)!.group] / 12);

/** A clear chime plays few partials, each loud enough to be heard: the strongest ones, none under this share of the strongest. */
const MAX_TRACKS = 14;
const MIN_LEVEL = 0.1;
/** Seconds a partial takes to reach its level when it starts. */
const PARTIAL_RISE = 0.008;

/** One sine wave over time: breakpoints of [seconds, hertz, level]. */
type Track = [number, number, number][];

interface Measured {
  duration: number;
  /** Peak level of the reference, as a share of full scale. */
  peak: number;
  /** Overall loudness of the reference every 10 ms (RMS). */
  loudness: number[];
  tracks: Track[];
}

const measurements = new Map<string, Measured>();

/** The measurements of a chime, read once from `assets/chimes` (next to `src` or `dist`, so it works from both). */
function measured(id: ChimeId): Measured {
  const cached = measurements.get(id);
  if (cached) return cached;
  const data = clarify(JSON.parse(readFileSync(new URL(`../../assets/chimes/${id}.json`, import.meta.url), "utf8")) as Measured);
  measurements.set(id, data);
  return data;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!;

/**
 * Keeps what makes the sound clear: the strongest partials only, without the faint ones that blur it, and each partial's pitch
 * smoothed over five breakpoints, which removes the small jumps the measurement leaves on a steady tone (a held note then
 * sounds held and not wobbly) while a real glide, which is slow, stays.
 */
function clarify(data: Measured): Measured {
  const weight = (track: Track) => track.reduce((sum, [, , level]) => sum + level * level, 0);
  const loudest = Math.max(...data.tracks.map((t) => Math.max(...t.map((point) => point[2]))));
  const strongest = [...data.tracks]
    .filter((t) => Math.max(...t.map((point) => point[2])) >= loudest * MIN_LEVEL)
    .sort((a, b) => weight(b) - weight(a))
    .slice(0, MAX_TRACKS);
  const tracks = strongest.map((track) =>
    track.map(([time, hz, level], i): [number, number, number] => {
      const around = track.slice(Math.max(0, i - 2), i + 3).map((point) => point[1]);
      return [time, median(around), level];
    }),
  );
  return { ...data, tracks };
}

/** Linear interpolation of a breakpoint list [time, ...values] at `t`, held at both ends. */
function at(points: Track, t: number): [number, number] {
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid]![0] <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo]!;
  const b = points[hi]!;
  const span = b[0] - a[0];
  const k = span > 0 ? Math.min(1, Math.max(0, (t - a[0]) / span)) : 0;
  return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

const LOUDNESS_STEP = 0.01;

/** The chime as mono samples in [-1, 1] at [sampleRate], without the pause that follows it. */
export function renderChime(id: ChimeId, sampleRate: number): Float32Array {
  const data = measured(id);
  const out = new Float32Array(Math.round((data.duration * CHIME_SLOWDOWN + 0.05) * sampleRate));
  // A partial above what the rate can carry would fold back into the sound as noise, so it is left out.
  const limit = sampleRate * 0.45;
  const pitch = chimePitch(id);
  for (const track of data.tracks) {
    const first = Math.max(0, Math.floor(track[0]![0] * CHIME_SLOWDOWN * sampleRate));
    const last = Math.min(out.length - 1, Math.ceil(track[track.length - 1]![0] * CHIME_SLOWDOWN * sampleRate));
    let phase = 0;
    for (let i = first; i <= last; i++) {
      const time = i / sampleRate / CHIME_SLOWDOWN;
      const [hz, level] = at(track, time);
      const frequency = hz * pitch;
      phase += (2 * Math.PI * frequency) / sampleRate;
      // A partial that starts at full level is a click: each one rises over a few milliseconds.
      const rise = Math.min(1, (time - track[0]![0]) / PARTIAL_RISE);
      if (frequency < limit) out[i]! += rise * level * Math.sin(phase);
    }
  }
  shapeLoudness(out, data.loudness, sampleRate);
  // Fade the end so the chime never ends on a click.
  const fade = Math.round(0.03 * sampleRate);
  for (let i = 0; i < fade && i < out.length; i++) out[out.length - 1 - i]! *= i / fade;
  let max = 0;
  for (const v of out) max = Math.max(max, Math.abs(v));
  const scale = max > 0 ? data.peak / max : 0;
  for (let i = 0; i < out.length; i++) out[i]! *= scale;
  return out;
}

/**
 * Gives the synthesised chime the attack and fall of the reference: the sine waves alone are too smooth where the original
 * strikes or fades, so each 10 ms of the chime is brought towards the loudness the reference had at that moment. It may turn a
 * part down a long way, which is what brings back the silence between two beeps, but never turn one up by more than 2.2.
 */
function shapeLoudness(out: Float32Array, target: number[], sampleRate: number): void {
  const step = Math.round(LOUDNESS_STEP * sampleRate);
  const frames = Math.floor(out.length / step);
  const gains: number[] = [];
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * step; i < (f + 1) * step; i++) sum += out[i]! * out[i]!;
    const mine = Math.sqrt(sum / step) + 1e-9;
    const position = f / CHIME_SLOWDOWN;
    const lower = Math.min(target.length - 1, Math.floor(position));
    const upper = Math.min(target.length - 1, lower + 1);
    const wanted = target[lower]! + (target[upper]! - target[lower]!) * (position - lower);
    gains.push(Math.min(2.2, Math.max(0.03, wanted / mine)));
  }
  // Smooth over 5 frames, then spread between the centres of the frames.
  const smooth = gains.map((_, f) => {
    let total = 0;
    let count = 0;
    for (let k = f - 2; k <= f + 2; k++) {
      total += gains[Math.min(gains.length - 1, Math.max(0, k))]!;
      count++;
    }
    return total / count;
  });
  for (let i = 0; i < out.length; i++) {
    const position = i / step - 0.5;
    const lower = Math.min(smooth.length - 1, Math.max(0, Math.floor(position)));
    const upper = Math.min(smooth.length - 1, lower + 1);
    const k = Math.min(1, Math.max(0, position - lower));
    out[i]! *= smooth[lower]! + (smooth[upper]! - smooth[lower]!) * k;
  }
}

const toPcm = (value: number) => Math.max(-32768, Math.min(32767, Math.round(value * 32767)));

/** The chime on its own, as a WAV file, to pre-listen. */
export function chimeWav(id: ChimeId, sampleRate = 44_100): Buffer {
  const samples = Int16Array.from(renderChime(id, sampleRate), toPcm);
  return writeWav({ sampleRate, channels: 1, samples });
}

/**
 * Puts the chime in front of a spoken WAV: the chime, a short pause, then the voice, all at the voice's own sample rate and
 * channel count. Returns null when the voice is not a 16-bit PCM WAV or the chime is unknown (a value saved by an older
 * version, say), so the caller can send the voice as it is.
 */
export function prependChime(voice: Buffer, id: string): Buffer | null {
  const spec = specOf(id);
  const speech: PcmWav | null = spec ? readWav(voice) : null;
  if (!spec || !speech) return null;
  const chime = renderChime(spec.id as ChimeId, speech.sampleRate);
  const pause = Math.round(spec.pause * speech.sampleRate);
  const frames = chime.length + pause;
  const samples = new Int16Array(frames * speech.channels + speech.samples.length);
  for (let i = 0; i < chime.length; i++) for (let c = 0; c < speech.channels; c++) samples[i * speech.channels + c] = toPcm(chime[i]!);
  samples.set(speech.samples, frames * speech.channels);
  return writeWav({ sampleRate: speech.sampleRate, channels: speech.channels, samples });
}
