import { readWav, writeWav, type PcmWav } from "./wav.js";

/**
 * Chimes played before a voice announcement. Each one is composed here as a few clean notes and played by a small additive
 * synthesiser (sine partials with an attack, a decay and a release). The notes were read off the reference sounds the campus
 * chose in `docs/inspiration/chimes`: how many notes, the intervals between them, their length and rhythm, whether the tone is
 * soft, bell-like, buzzing or a pure beep. They keep that character (soft blips for information, held "da-da" bells for a
 * warning, a buzz and a two-tone siren for a critical message, beeps for a manual override) but they are not copies: every chime
 * sits on its own pitches and is shaped by hand, and nothing of any recording is stored or played.
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

/** The loudest sample of each group, as a share of full scale: quiet for information, loudest when critical. */
const GROUP_PEAK: Record<ChimeGroup, number> = { info: 0.4, warning: 0.62, critical: 0.88, "manual-override": 0.75 };

/** Seconds a note takes to reach its level when it starts, and to fade out when it ends: neither is allowed to click. */
const ATTACK = 0.008;
const RELEASE = 0.05;

/** [ratio to the note's pitch, level] of each partial. */
type Partials = readonly (readonly [number, number])[];

interface Note {
  /** Seconds from the start of the chime, and how long the note sounds. */
  at: number;
  length: number;
  hz: number;
  partials: Partials;
  /** Time constant of the fall in seconds (a struck bell); absent for a held tone. */
  decay?: number;
  /** Buzz: [rate in hertz, depth 0..1] of the amplitude modulation. */
  buzz?: readonly [number, number];
}

// Tones. A soft one is a fundamental with a third harmonic; a bell has the uneven partials of a struck metal bar; a buzz is a
// rich, saw-like spectrum; a beep is a pure sine.
const SOFT: Partials = [[1, 1], [3, 0.4], [2, 0.12]];
const BELL: Partials = [[1, 1], [1.67, 0.5], [1.41, 0.3], [0.6, 0.28], [1.93, 0.22], [2.33, 0.18]];
const SAW: Partials = [[1, 1], [2, 0.45], [3, 0.5], [4, 0.2], [5, 0.12]];
const SIREN: Partials = [[1, 1], [2, 0.14], [3, 0.06]];
const BEEP: Partials = [[1, 1], [2, 0.03]];

const soft = (at: number, length: number, hz: number, decay = 0.3): Note => ({ at, length, hz, partials: SOFT, decay });
const bell = (at: number, length: number, hz: number): Note => ({ at, length, hz, partials: BELL, decay: 0.45 });
const beep = (at: number, length: number, hz: number): Note => ({ at, length, hz, partials: BEEP });

/**
 * The compositions. Pitches are chosen by ear relative to each reference: information keeps its soft contour a little higher,
 * the warning bell is moved to F#5 with a fresh rhythm, the critical sounds sit on their own notes, the override beeps are on A.
 */
const COMPOSITIONS: Record<ChimeId, Note[]> = {
  // A round note that falls to a low one, with a short bright blip on it.
  "info-bloop": [soft(0, 0.52, 698, 0.32), { ...soft(0.56, 0.2, 392, 0.12), partials: [[1, 1], [3, 0.8], [1.67, 0.25]] }],
  // A low note that steps up a fifth and says it twice.
  "info-doop": [soft(0, 0.3, 247, 0.22), soft(0.33, 0.17, 370, 0.12), soft(0.5, 0.3, 370, 0.2)],
  // The same soft note twice, the second a little higher.
  "info-dudu": [soft(0, 0.5, 415, 0.3), soft(0.55, 0.34, 440, 0.22)],
  // Long, short, long on the same bell.
  "warning-dadaa": [bell(0, 0.54, 740), bell(0.57, 0.2, 740), bell(0.77, 0.38, 740)],
  // Two even bells.
  "warning-dadab": [bell(0, 0.5, 740), bell(0.57, 0.55, 740)],
  // Short, short, long.
  "warning-dadac": [bell(0, 0.23, 740), bell(0.26, 0.3, 740), bell(0.57, 0.57, 740)],
  // A bell that steps down a tone and rings with a low companion.
  "warning-dadeda": [
    { at: 0, length: 0.42, hz: 554, partials: [[1, 1], [2.7, 0.12], [0.7, 0.1]], decay: 0.4 },
    { at: 0.46, length: 0.55, hz: 494, partials: [[1, 1], [0.58, 0.64], [1.1, 0.48], [2.15, 0.39]], decay: 0.5 },
  ],
  // One held, rough tone with a fast buzz.
  "critical-buzwarn": [{ at: 0, length: 0.95, hz: 440, partials: SAW, buzz: [30, 0.45] }],
  // High-low siren: a high note then a low one a fourth under.
  "critical-deeoo": [
    { at: 0, length: 0.3, hz: 1319, partials: SIREN },
    { at: 0.3, length: 0.42, hz: 932, partials: SIREN },
  ],
  // Two beeps, the second shorter.
  "manual-override": [beep(0, 0.3, 440), beep(0.46, 0.2, 440)],
  // Two falling beeps, then a held pair a fifth apart.
  "important-manual-override": [
    beep(0, 0.27, 740),
    beep(0.27, 0.28, 554),
    { at: 0.55, length: 0.63, hz: 1397, partials: BEEP },
    { at: 0.55, length: 0.63, hz: 988, partials: [[1, 1], [2, 0.5]] },
  ],
};

/** The chime as mono samples in [-1, 1] at [sampleRate], without the pause that follows it. */
export function renderChime(id: ChimeId, sampleRate: number): Float32Array {
  const notes = COMPOSITIONS[id];
  const end = Math.max(...notes.map((n) => n.at + n.length));
  const out = new Float32Array(Math.round((end + 0.05) * sampleRate));
  // A partial above what the rate can carry would fold back into the sound as noise, so it is left out.
  const limit = sampleRate * 0.45;
  for (const note of notes) {
    const first = Math.round(note.at * sampleRate);
    const count = Math.round(note.length * sampleRate);
    for (const [ratio, level] of note.partials) {
      const frequency = note.hz * ratio;
      if (frequency >= limit) continue;
      const step = (2 * Math.PI * frequency) / sampleRate;
      for (let k = 0; k < count && first + k < out.length; k++) {
        const t = k / sampleRate;
        let gain = Math.min(1, t / ATTACK) * Math.min(1, (note.length - t) / RELEASE);
        if (note.decay) gain *= Math.exp(-t / note.decay);
        if (note.buzz) gain *= 1 - note.buzz[1] * (0.5 - 0.5 * Math.cos(2 * Math.PI * note.buzz[0] * t));
        out[first + k]! += level * gain * Math.sin(step * k);
      }
    }
  }
  let max = 0;
  for (const v of out) max = Math.max(max, Math.abs(v));
  const scale = max > 0 ? GROUP_PEAK[specOf(id)!.group] / max : 0;
  for (let i = 0; i < out.length; i++) out[i]! *= scale;
  return out;
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
