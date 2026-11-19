import { describe, expect, it } from "vitest";
import { CONTENT_LIMITS, FACULTY_LIMITS, facultyConfig, EMERGENCY_CATALOGUE, EMERGENCY_KINDS, MAX_FRAME_BYTES, buildMessage, displayConfig, handshakeMessages, isUlid, parseDeviceMessage, parseServerMessage, ulid } from "./index.js";

describe("ulid", () => {
  it("is 26 Crockford chars and sortable by time", () => {
    const a = ulid(1_000_000);
    const b = ulid(2_000_000);
    expect(isUlid(a)).toBe(true);
    expect(a < b).toBe(true);
  });
  it("does not collide", () => {
    expect(new Set(Array.from({ length: 5000 }, () => ulid())).size).toBe(5000);
  });
});

const occupied = { roomId: "B2-104", status: "occupied", label: "Occupied", color: "#f5a524", icon: "user" } as const;

describe("messages", () => {
  it("round-trips a server command", () => {
    const msg = buildMessage({ type: "room.status.set", payload: occupied }, 1);
    const parsed = parseServerMessage(JSON.stringify(msg));
    expect(parsed).toEqual({ ok: true, message: msg });
  });

  it("round-trips device messages", () => {
    const ack = buildMessage({ type: "ack", payload: { ref: ulid() } }, 3);
    expect(parseDeviceMessage(JSON.stringify(ack)).ok).toBe(true);
  });

  it("keeps the given id when replaying a command", () => {
    const id = ulid();
    expect(buildMessage({ type: "ack", payload: { ref: ulid() }, id }, 1).id).toBe(id);
  });

  it("rejects unknown types, bad payloads, wrong version and bad ids", () => {
    const ok = buildMessage({ type: "room.status.set", payload: { ...occupied, status: "free" } }, 1);
    expect(parseServerMessage(JSON.stringify({ ...ok, type: "nope" })).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ ...ok, payload: { ...occupied, status: "Not A Key" } })).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ ...ok, v: 2 })).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ ...ok, id: "x" })).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ ...ok, seq: 0 })).ok).toBe(false);
  });

  it("does not accept a message in the wrong direction", () => {
    const ack = buildMessage({ type: "ack", payload: { ref: ulid() } }, 1);
    expect(parseServerMessage(JSON.stringify(ack)).ok).toBe(false);
    const cmd = buildMessage({ type: "room.status.set", payload: { ...occupied, status: "free" } }, 1);
    expect(parseDeviceMessage(JSON.stringify(cmd)).ok).toBe(false);
  });

  it("rejects invalid JSON and oversized frames", () => {
    expect(parseDeviceMessage("{nope").ok).toBe(false);
    expect(parseDeviceMessage("x".repeat(MAX_FRAME_BYTES + 1)).ok).toBe(false);
  });

  it("audio.play carries a hash and size, not audio", () => {
    const bad = buildMessage({ type: "audio.play", payload: { announcementId: "n", assetId: "a", sha256: "zz", size: 10 } }, 1);
    expect(parseServerMessage(JSON.stringify(bad)).ok).toBe(false);
  });

  it("a status needs a hex colour and a known icon", () => {
    const parse = (over: object) =>
      parseServerMessage(JSON.stringify(buildMessage({ type: "room.status.set", payload: { ...occupied, ...over } }, 1))).ok;
    expect(parse({})).toBe(true);
    expect(parse({ color: "red" })).toBe(false);
    expect(parse({ icon: "skull" })).toBe(false);
    expect(parse({ label: "" })).toBe(false);
  });

  it("announcements use info, important and urgent", () => {
    const parse = (priority: string) =>
      parseServerMessage(JSON.stringify(buildMessage({ type: "announce.show", payload: { announcementId: "a", text: "x", priority } } as never, 1))).ok;
    expect(parse("urgent")).toBe(true);
    expect(parse("high")).toBe(false);
  });

  it("emergencies need a known kind and a bounded test volume", () => {
    const base = { emergencyId: "e1", kind: "fire", title: "Fire alarm", instructions: "Leave.", startedAt: 1 };
    const parse = (over: object) =>
      parseServerMessage(JSON.stringify(buildMessage({ type: "emergency.set", payload: { ...base, ...over } } as never, 1)));
    const ok = parse({});
    expect(ok.ok && ok.message.payload).toMatchObject({ testMode: false, testVolume: 20 });
    expect(parse({ kind: "zombies" }).ok).toBe(false);
    expect(parse({ testVolume: 101 }).ok).toBe(false);
    expect(parse({ instructions: "" }).ok).toBe(false);
  });

  it("every emergency kind has wording and a colour", () => {
    for (const kind of EMERGENCY_KINDS) {
      const info = EMERGENCY_CATALOGUE[kind];
      expect(info.title.length).toBeGreaterThan(0);
      expect(info.instructions.length).toBeLessThanOrEqual(400);
      expect(info.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("audio settings bound the volume", () => {
    const quietHours = { enabled: true, from: "22:00", to: "06:00" };
    const parse = (volume: number) =>
      parseServerMessage(JSON.stringify(buildMessage({ type: "audio.settings.set", payload: { volume, quietHours } }, 1))).ok;
    expect(parse(0)).toBe(true);
    expect(parse(100)).toBe(true);
    expect(parse(101)).toBe(false);
    expect(parse(-1)).toBe(false);
  });
});

describe("handshake messages", () => {
  const b64 = (n: number) => Buffer.alloc(n, 1).toString("base64");
  it("validate sizes", () => {
    const good = { type: "hello", v: 1, deviceId: ulid(), nonceA: b64(32), ephA: b64(65) };
    expect(handshakeMessages.hello.safeParse(good).success).toBe(true);
    expect(handshakeMessages.hello.safeParse({ ...good, nonceA: b64(16) }).success).toBe(false);
    expect(handshakeMessages.hello.safeParse({ ...good, ephA: b64(33) }).success).toBe(false);
  });
});

describe("display config", () => {
  it("fills every default from an empty object", () => {
    const config = displayConfig.parse({});
    expect(config).toMatchObject({ layout: "standard", theme: "dark", accentColor: "#00a86b" });
    expect(config.show.clock).toBe(true);
    expect(config.sleep).toEqual({ enabled: false, from: "22:00", to: "06:00" });
  });

  it("rejects an unknown layout, a bad colour and a bad time", () => {
    expect(displayConfig.safeParse({ layout: "grid" }).success).toBe(false);
    expect(displayConfig.safeParse({ accentColor: "green" }).success).toBe(false);
    expect(displayConfig.safeParse({ sleep: { from: "25:00" } }).success).toBe(false);
  });
});

describe("faculty and reservation messages", () => {
  const longText = (n: number) => "é".repeat(n);

  it("fills in the faculty config defaults", () => {
    const config = facultyConfig.parse({});
    expect(config).toMatchObject({ service: "all", carousel: { enabled: true, intervalSeconds: 15 }, widgets: { weather: false }, weather: null });
    expect(config.carousel.slides).toEqual(["news", "staff", "reservations"]);
  });

  it("rejects a carousel that is too fast or has no slide, and a weather position off the globe", () => {
    expect(facultyConfig.safeParse({ carousel: { intervalSeconds: 1 } }).success).toBe(false);
    expect(facultyConfig.safeParse({ carousel: { slides: [] } }).success).toBe(false);
    expect(facultyConfig.safeParse({ weather: { latitude: 91, longitude: 0 } }).success).toBe(false);
  });

  it("a snapshot at every limit still fits in a frame, even with multi-byte text and after encryption overhead", () => {
    const now = Date.now();
    const payload = {
      news: Array.from({ length: FACULTY_LIMITS.news }, (_, i) => ({
        id: ulid(), title: longText(120), text: longText(400), priority: "info" as const, publishedAt: now + i, expiresAt: now,
      })),
      staff: Array.from({ length: FACULTY_LIMITS.staff }, () => ({
        id: ulid(), name: longText(80), service: "pedagogical" as const, jobTitle: longText(60), availability: "busy" as const, note: longText(60), until: now,
      })),
      reservations: Array.from({ length: FACULTY_LIMITS.reservations }, () => ({
        id: ulid(), room: longText(60), title: longText(100), start: now, end: now, organizer: longText(60),
      })),
      updatedAt: now,
    };
    const frame = JSON.stringify(buildMessage({ type: "faculty.content.set", payload }, 1));
    expect(parseServerMessage(frame).ok).toBe(true);
    // 4/3 for base64 of the ciphertext, plus the envelope around it.
    expect(Math.ceil(Buffer.byteLength(frame) * (4 / 3)) + 512).toBeLessThan(MAX_FRAME_BYTES);
  });

  it("refuses a snapshot above the limits", () => {
    const tooMany = { news: [], staff: [], reservations: Array.from({ length: FACULTY_LIMITS.reservations + 1 }, () => ({ id: "r", room: "A", title: "t", start: 1, end: 2 })), updatedAt: 1 };
    expect(parseServerMessage(JSON.stringify(buildMessage({ type: "faculty.content.set", payload: tooMany }, 1))).ok).toBe(false);
  });

  it("keeps emergency.clear without a message valid and bounds the message", () => {
    const base = { emergencyId: "e1" };
    expect(parseServerMessage(JSON.stringify(buildMessage({ type: "emergency.clear", payload: base }, 1))).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify(buildMessage({ type: "emergency.clear", payload: { ...base, message: "All clear." } }, 1))).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify(buildMessage({ type: "emergency.clear", payload: { ...base, message: "x".repeat(401) } }, 1))).ok).toBe(false);
  });

  it("bounds how long the end notice stays on screen", () => {
    const clear = (noticeSeconds: number) => parseServerMessage(JSON.stringify(buildMessage({ type: "emergency.clear", payload: { emergencyId: "e1", message: "Over.", noticeSeconds } }, 1))).ok;
    expect([clear(10), clear(900), clear(300)]).toEqual([true, true, true]);
    expect([clear(9), clear(901), clear(12.5)]).toEqual([false, false, false]);
  });

  it("audio.play is not urgent by default", () => {
    const frame = JSON.stringify(buildMessage({ type: "audio.play", payload: { announcementId: "n", assetId: "a", sha256: "a".repeat(64), size: 1 } as never }, 1));
    const parsed = parseServerMessage(frame);
    expect(parsed.ok && parsed.message.type === "audio.play" && parsed.message.payload.urgent).toBe(false);
  });

  it("a display config saved before reservations existed still validates and shows the next reservation", () => {
    expect(displayConfig.parse({ show: { roomName: false } }).show).toMatchObject({ roomName: false, nextReservation: true });
  });

  it("limits a door's reservation list to five", () => {
    const items = (n: number) => Array.from({ length: n }, () => ({ id: "r", title: "t", start: 1, end: 2 }));
    expect(parseServerMessage(JSON.stringify(buildMessage({ type: "reservations.set", payload: { roomId: "x", items: items(5) } }, 1))).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify(buildMessage({ type: "reservations.set", payload: { roomId: "x", items: items(6) } }, 1))).ok).toBe(false);
  });
});

describe("custom content", () => {
  const sha = "a".repeat(64);
  const asset = (mime: string) => ({ assetId: "asset1", sha256: sha, size: 1000, mime });
  const parse = (item: object) => parseServerMessage(JSON.stringify(buildMessage({ type: "content.set", payload: { items: [item], updatedAt: 1 } } as never, 1)));

  it("accepts each kind with what it needs and fills in the defaults", () => {
    expect(parse({ id: "1", kind: "image", asset: asset("image/png") }).ok).toBe(true);
    expect(parse({ id: "2", kind: "video", asset: asset("video/mp4"), durationSeconds: 60, fit: "cover" }).ok).toBe(true);
    expect(parse({ id: "3", kind: "text", text: "Open day on Saturday" }).ok).toBe(true);
    expect(parse({ id: "4", kind: "web", url: "https://example.org/live", refreshSeconds: 60 }).ok).toBe(true);
    const parsed = parse({ id: "1", kind: "image", asset: asset("image/png") });
    expect(parsed.ok && parsed.message.type === "content.set" && parsed.message.payload.items[0]).toMatchObject({ durationSeconds: 15, fit: "contain", title: "" });
  });

  it("refuses a slide that lacks what its kind needs, or that carries the wrong kind of file", () => {
    expect(parse({ id: "1", kind: "image" }).ok).toBe(false);
    expect(parse({ id: "1", kind: "image", asset: asset("video/mp4") }).ok).toBe(false);
    expect(parse({ id: "1", kind: "video", asset: asset("image/png") }).ok).toBe(false);
    expect(parse({ id: "1", kind: "text" }).ok).toBe(false);
    expect(parse({ id: "1", kind: "web" }).ok).toBe(false);
  });

  it("refuses addresses that are not http(s), a bad hash, silly durations and a window that ends before it starts", () => {
    expect(parse({ id: "1", kind: "web", url: "javascript:alert(1)" }).ok).toBe(false);
    expect(parse({ id: "1", kind: "web", url: "file:///etc/passwd" }).ok).toBe(false);
    expect(parse({ id: "1", kind: "image", asset: { ...asset("image/png"), sha256: "xyz" } }).ok).toBe(false);
    expect(parse({ id: "1", kind: "text", text: "x", durationSeconds: 1 }).ok).toBe(false);
    expect(parse({ id: "1", kind: "text", text: "x", durationSeconds: 601 }).ok).toBe(false);
    expect(parse({ id: "1", kind: "text", text: "x", startsAt: 2000, endsAt: 1000 }).ok).toBe(false);
  });

  it("a full playlist of the longest items still fits a frame", () => {
    const longText = "é".repeat(CONTENT_LIMITS.text);
    const items = Array.from({ length: CONTENT_LIMITS.items }, (_, i) =>
      i % 2 ? { id: ulid(), kind: "text" as const, title: "é".repeat(CONTENT_LIMITS.title), text: longText, startsAt: 1, endsAt: 2 } : { id: ulid(), kind: "web" as const, title: "é".repeat(CONTENT_LIMITS.title), url: `https://example.org/${"a".repeat(CONTENT_LIMITS.url - 21)}`, refreshSeconds: 60 },
    );
    const frame = JSON.stringify(buildMessage({ type: "content.set", payload: { items, updatedAt: Date.now() } }, 1));
    expect(parseServerMessage(frame).ok).toBe(true);
    expect(Buffer.byteLength(frame) + 512).toBeLessThan(MAX_FRAME_BYTES);
    const tooMany = [...items, items[0]!];
    expect(parseServerMessage(JSON.stringify(buildMessage({ type: "content.set", payload: { items: tooMany, updatedAt: 1 } } as never, 1))).ok).toBe(false);
  });

  it("the faculty config carries a mode and the details of the site, with safe defaults", () => {
    const config = facultyConfig.parse({});
    expect(config).toMatchObject({ mode: "default", site: { name: "", subtitle: "", zone: "", assemblyPoint: "", emergencyNumber: "", logo: null } });
    expect(facultyConfig.parse({ mode: "mixed", site: { name: "Faculty of Engineering", logo: asset("image/png") } }).site.logo?.assetId).toBe("asset1");
    expect(facultyConfig.safeParse({ mode: "slideshow" }).success).toBe(false);
    expect(facultyConfig.safeParse({ site: { logo: { ...asset("image/png"), sha256: "bad" } } }).success).toBe(false);
  });
});
