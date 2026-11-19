/** A PCM WAV file read into samples. Only 16-bit PCM is handled: it is what text-to-speech engines return for "wav". */
export interface PcmWav {
  sampleRate: number;
  channels: number;
  /** Interleaved samples. */
  samples: Int16Array;
}

const ascii = (buf: Buffer, offset: number, length: number) => buf.toString("latin1", offset, offset + length);

/**
 * Reads a RIFF/WAVE buffer, or returns null when it is anything else (another format, 8 or 24 bits, compressed). Streaming
 * engines write 0 or 0xFFFFFFFF as the length of the data chunk because they do not know it yet, so a data chunk that claims
 * more than the file holds is read up to the end of the file.
 */
export function readWav(buf: Buffer): PcmWav | null {
  if (buf.length < 44 || ascii(buf, 0, 4) !== "RIFF" || ascii(buf, 8, 4) !== "WAVE") return null;
  let format: { channels: number; sampleRate: number; bits: number; tag: number } | null = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = ascii(buf, offset, 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      format = { tag: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!format || format.tag !== 1 || format.bits !== 16 || format.channels < 1 || format.channels > 2) return null;
      const available = buf.length - body;
      const length = size === 0 || size > available ? available : size;
      const evenLength = length - (length % (2 * format.channels));
      const samples = new Int16Array(evenLength / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(body + i * 2);
      return { sampleRate: format.sampleRate, channels: format.channels, samples };
    }
    // Chunks are padded to an even size.
    offset = body + size + (size % 2);
  }
  return null;
}

/** Writes 16-bit PCM as a WAV file with an honest header. */
export function writeWav({ sampleRate, channels, samples }: PcmWav): Buffer {
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVEfmt ", 8, "latin1");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "latin1");
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i]!, 44 + i * 2);
  return out;
}
