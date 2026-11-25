/** What a live announcement sends: 16-bit mono at this rate, the same as the server and the screens expect. */
export const LIVE_SAMPLE_RATE = 16_000;
/** Most bytes the server accepts in one frame of voice. */
export const LIVE_MAX_CHUNK_BYTES = 8_000;

/**
 * Turns what the microphone gives (floats at the sound card's rate, often 44.1 or 48 kHz) into 16 kHz 16-bit samples by averaging
 * the input samples that fall in each output sample, which also acts as the low-pass that keeps high frequencies from folding into
 * the voice. Keeps the remainder between calls so the cut between two blocks does not click.
 */
export class Downsampler {
  private carry = 0;
  private carryCount = 0;
  private position = 0;
  private readonly step: number;

  constructor(inputRate: number, outputRate = LIVE_SAMPLE_RATE) {
    this.step = inputRate / outputRate;
  }

  push(input: Float32Array): Int16Array {
    const out: number[] = [];
    for (let i = 0; i < input.length; i++) {
      this.carry += input[i]!;
      this.carryCount++;
      this.position++;
      if (this.position >= this.step) {
        const mean = this.carry / this.carryCount;
        out.push(Math.max(-32768, Math.min(32767, Math.round(mean * 32767))));
        this.carry = 0;
        this.carryCount = 0;
        this.position -= this.step;
      }
    }
    return Int16Array.from(out);
  }
}

/** Cuts samples into frames the server accepts, as little-endian bytes. */
export function toFrames(samples: Int16Array): ArrayBuffer[] {
  const perFrame = LIVE_MAX_CHUNK_BYTES / 2;
  const frames: ArrayBuffer[] = [];
  for (let at = 0; at < samples.length; at += perFrame) {
    const part = samples.subarray(at, at + perFrame);
    const bytes = new Uint8Array(part.length * 2);
    const view = new DataView(bytes.buffer);
    part.forEach((v, i) => view.setInt16(i * 2, v, true));
    frames.push(bytes.buffer);
  }
  return frames;
}
