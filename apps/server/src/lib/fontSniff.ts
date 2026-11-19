/** Font containers accepted for themes. The mime and extension come from the bytes, never from the client. */
export interface FontFormat {
  mime: string;
  extension: string;
}

const ascii = (buf: Buffer, text: string) => buf.subarray(0, text.length).toString("latin1") === text;

/**
 * Recognises WOFF2, WOFF, TrueType and OpenType (CFF) from the first four bytes. Anything else is refused,
 * including SVG fonts and font collections (`ttcf`), which a device could not load as one family.
 */
export function sniffFont(buf: Buffer): FontFormat | null {
  if (buf.length < 16) return null;
  if (ascii(buf, "wOF2")) return { mime: "font/woff2", extension: "woff2" };
  if (ascii(buf, "wOFF")) return { mime: "font/woff", extension: "woff" };
  if (ascii(buf, "OTTO")) return { mime: "font/otf", extension: "otf" };
  // TrueType: version 1.0 as a number, or the Apple tag "true".
  if ((buf[0] === 0 && buf[1] === 1 && buf[2] === 0 && buf[3] === 0) || ascii(buf, "true")) return { mime: "font/ttf", extension: "ttf" };
  return null;
}
