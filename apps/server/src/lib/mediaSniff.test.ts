import { describe, expect, it } from "vitest";
import { sniffMedia } from "./mediaSniff.js";

const pad = (head: Buffer) => Buffer.concat([head, Buffer.alloc(32)]);

describe("sniffMedia", () => {
  it("recognises the supported images and videos by their first bytes", () => {
    expect(sniffMedia(pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))).toMatchObject({ kind: "image", mime: "image/png" });
    expect(sniffMedia(pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0])))).toMatchObject({ kind: "image", mime: "image/jpeg" });
    expect(sniffMedia(pad(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")))).toMatchObject({ kind: "image", mime: "image/webp" });
    expect(sniffMedia(pad(Buffer.from("GIF89a")))).toMatchObject({ kind: "image", mime: "image/gif" });
    expect(sniffMedia(pad(Buffer.from("\0\0\0\x20ftypisom")))).toMatchObject({ kind: "video", mime: "video/mp4", extension: "mp4" });
    expect(sniffMedia(pad(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))).toMatchObject({ kind: "video", mime: "video/webm" });
  });

  it("leaves audio-only MP4 to the sound library", () => {
    expect(sniffMedia(pad(Buffer.from("\0\0\0\x20ftypM4A ")))).toBeNull();
    expect(sniffMedia(pad(Buffer.from("\0\0\0\x20ftypM4B ")))).toBeNull();
  });

  it("refuses SVG, HTML, scripts, executables, a WAV and truncated input", () => {
    expect(sniffMedia(pad(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')))).toBeNull();
    expect(sniffMedia(pad(Buffer.from("<!doctype html><script>")))).toBeNull();
    expect(sniffMedia(pad(Buffer.from("MZ\x90\0")))).toBeNull();
    expect(sniffMedia(pad(Buffer.from("RIFF\0\0\0\0WAVEfmt ")))).toBeNull();
    expect(sniffMedia(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});
