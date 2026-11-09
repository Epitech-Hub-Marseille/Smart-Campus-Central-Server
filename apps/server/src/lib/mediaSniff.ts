/** Image and video containers accepted for the content library. The kind and mime come from the bytes, never from the client. */
export interface MediaFormat {
  kind: "image" | "video";
  mime: string;
  extension: string;
}

const ascii = (buf: Buffer, text: string, offset = 0) => buf.subarray(offset, offset + text.length).toString("latin1") === text;
const startsWith = (buf: Buffer, bytes: number[]) => bytes.every((b, i) => buf[i] === b);

/** Brands of an MP4 that carry audio only (M4A, M4B): those belong in the sound library, not here. */
const AUDIO_BRANDS = new Set(["M4A ", "M4B ", "M4P ", "F4A "]);

/**
 * Recognises PNG, JPEG, WebP, GIF, MP4 and WebM from the first bytes. SVG is refused on purpose: it can carry
 * scripts. WebM cannot be told from audio-only WebM without parsing it, so on this endpoint it counts as video.
 */
export function sniffMedia(buf: Buffer): MediaFormat | null {
  if (buf.length < 16) return null;
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", mime: "image/png", extension: "png" };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg", extension: "jpg" };
  if (ascii(buf, "RIFF") && ascii(buf, "WEBP", 8)) return { kind: "image", mime: "image/webp", extension: "webp" };
  if (ascii(buf, "GIF87a") || ascii(buf, "GIF89a")) return { kind: "image", mime: "image/gif", extension: "gif" };
  if (ascii(buf, "ftyp", 4) && !AUDIO_BRANDS.has(buf.subarray(8, 12).toString("latin1"))) return { kind: "video", mime: "video/mp4", extension: "mp4" };
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: "video", mime: "video/webm", extension: "webm" };
  return null;
}
