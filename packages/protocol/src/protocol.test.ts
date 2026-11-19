import { describe, expect, it } from "vitest";
import { THEME_LIMITS, cssProblems, themeInput, themeSpec, FACULTY_LIMITS, SCENE_LAYOUTS, TILE_KINDS, TILE_LIMITS, facultyConfig, facultyConfigPatch, mergeConfigPatches, parseYoutubeId, patchHas, sceneInput, EMERGENCY_CATALOGUE, EMERGENCY_KINDS, MAX_FRAME_BYTES, buildMessage, displayConfig, handshakeMessages, isUlid, parseDeviceMessage, parseServerMessage, ulid } from "./index.js";

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
    expect(config).toMatchObject({ service: "all", carousel: { enabled: true }, widgets: { weather: false }, weather: null });
  });

  it("rejects a weather position off the globe", () => {
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

describe("screens: scenes, tiles and layered config", () => {
  const sha = "a".repeat(64);
  const pointer = (id = "asset1") => ({ assetId: id });
  const ref = (mime: string) => ({ assetId: "asset1", sha256: sha, size: 1000, mime });
  const tile = (kind: string, settings: object = {}, id = `t-${kind}`) => ({ id, kind, settings });
  const scene = (layout: string, tiles: object[], extra: object = {}) => ({ id: "s1", layout, tiles, ...extra });
  const parseScene = (s: object) => sceneInput.safeParse(s);
  const carousel = (scenes: object[]) => parseServerMessage(JSON.stringify(buildMessage({ type: "carousel.set", payload: { scenes, updatedAt: 1 } } as never, 1)));

  it("has a layout slot count that matches each layout and a description for every kind", () => {
    for (const layout of Object.values(SCENE_LAYOUTS)) expect(layout.tiles.length).toBeGreaterThan(0);
    expect(new Set(TILE_KINDS.map((k) => k.kind)).size).toBe(TILE_KINDS.length);
    for (const kind of ["news", "staff", "reservations", "image", "video", "text", "web", "radio", "stream", "youtube"]) expect(TILE_KINDS.some((k) => k.kind === kind)).toBe(true);
  });

  it("accepts each kind with what it needs and fills in the defaults", () => {
    expect(parseScene(scene("full", [tile("news")])).success).toBe(true);
    expect(parseScene(scene("full", [tile("image", { asset: pointer() })])).success).toBe(true);
    const video = parseScene(scene("full", [tile("video", { asset: pointer() })]));
    expect(video.success && video.data.tiles[0]?.settings).toMatchObject({ fit: "contain", muted: true, loop: true });
    expect(parseScene(scene("full", [tile("radio", { url: "https://radio.example.org/live.mp3", label: "Campus radio" })])).success).toBe(true);
    expect(parseScene(scene("full", [tile("stream", { url: "https://cam.example.org/live.m3u8", format: "hls" })])).success).toBe(true);
    expect(parseScene(scene("full", [tile("web", { url: "https://example.org/live" })])).success).toBe(true);
    expect(parseScene(scene("full", [tile("text", { text: "Open day on Saturday" })])).success).toBe(true);
  });

  it("refuses a tile that lacks what its kind needs, an unknown kind, or an address that is not http(s)", () => {
    expect(parseScene(scene("full", [tile("image")])).success).toBe(false);
    expect(parseScene(scene("full", [tile("text")])).success).toBe(false);
    expect(parseScene(scene("full", [tile("hologram")])).success).toBe(false);
    expect(parseScene(scene("full", [tile("web", { url: "javascript:alert(1)" })])).success).toBe(false);
    expect(parseScene(scene("full", [tile("stream", { url: "file:///etc/passwd" })])).success).toBe(false);
    expect(parseScene(scene("full", [tile("radio", { url: "rtsp://x/y" })])).success).toBe(false);
  });

  it("needs exactly as many tiles as the layout has slots", () => {
    expect(parseScene(scene("full", [tile("news"), tile("staff", {}, "t2")])).success).toBe(false);
    expect(parseScene(scene("columns", [tile("news")])).success).toBe(false);
    expect(parseScene(scene("quad", [tile("news", {}, "a"), tile("staff", {}, "b"), tile("reservations", {}, "c"), tile("text", { text: "hi" }, "d")])).success).toBe(true);
  });

  it("takes a YouTube address in any form and keeps the id", () => {
    expect(parseYoutubeId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseYoutubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3")).toBe("dQw4w9WgXcQ");
    expect(parseYoutubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseYoutubeId("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseYoutubeId("https://evil.example/watch?v=dQw4w9WgXcQ")).toBeNull();
    const parsed = parseScene(scene("full", [tile("youtube", { video: "https://youtu.be/dQw4w9WgXcQ" })]));
    expect(parsed.success && parsed.data.tiles[0]?.settings).toMatchObject({ video: "dQw4w9WgXcQ", muted: true });
    expect(parseScene(scene("full", [tile("youtube", { video: "https://example.org" })])).success).toBe(false);
  });

  it("lets only one tile of a scene make sound", () => {
    const radio = (id: string, muted?: boolean) => tile("radio", { url: "https://r.example.org/a", ...(muted !== undefined && { muted }) }, id);
    expect(parseScene(scene("columns", [radio("a"), radio("b")])).success).toBe(false);
    expect(parseScene(scene("columns", [radio("a"), radio("b", true)])).success).toBe(true);
    // A video is muted unless said otherwise, so a video beside a radio is fine.
    expect(parseScene(scene("columns", [radio("a"), tile("video", { asset: pointer() }, "v")])).success).toBe(true);
    expect(parseScene(scene("columns", [radio("a"), tile("video", { asset: pointer(), muted: false }, "v")])).success).toBe(false);
  });

  it("refuses a window that ends before it starts and silly durations", () => {
    expect(parseScene(scene("full", [tile("news")], { startsAt: 2000, endsAt: 1000 })).success).toBe(false);
    expect(parseScene(scene("full", [tile("news")], { durationSeconds: 1 })).success).toBe(false);
    expect(parseScene(scene("full", [tile("news")], { durationSeconds: 601 })).success).toBe(false);
  });

  it("a screen gets assets as full references, checks their type, and skips a kind it does not know", () => {
    expect(carousel([scene("full", [tile("image", { asset: ref("image/png") })])]).ok).toBe(true);
    expect(carousel([scene("full", [tile("image", { asset: ref("video/mp4") })])]).ok).toBe(false);
    expect(carousel([scene("full", [tile("image", { asset: { ...ref("image/png"), sha256: "xyz" } })])]).ok).toBe(false);
    expect(carousel([scene("full", [tile("hologram", { anything: true })])]).ok).toBe(true);
  });

  it("a full carousel of the longest tiles still fits a frame", () => {
    const text = "é".repeat(TILE_LIMITS.text);
    const quad = (n: number) =>
      scene("quad", [
        tile("text", { text }, `${n}a`),
        tile("web", { url: `https://example.org/${"a".repeat(TILE_LIMITS.url - 21)}` }, `${n}b`),
        tile("image", { asset: ref("image/png") }, `${n}c`),
        tile("stream", { url: `https://example.org/${"a".repeat(TILE_LIMITS.url - 21)}`, label: "é".repeat(TILE_LIMITS.label) }, `${n}d`),
      ], { id: ulid(), name: "é".repeat(TILE_LIMITS.name), startsAt: 1, endsAt: 2 });
    const scenes = Array.from({ length: TILE_LIMITS.tiles / 4 }, (_, i) => quad(i));
    const frame = JSON.stringify(buildMessage({ type: "carousel.set", payload: { scenes, updatedAt: Date.now() } } as never, 1));
    expect(parseServerMessage(frame).ok).toBe(true);
    expect(Buffer.byteLength(frame) + 512).toBeLessThan(MAX_FRAME_BYTES);
    expect(carousel([...scenes, quad(99)]).ok).toBe(false);
    expect(carousel(Array.from({ length: TILE_LIMITS.scenes + 1 }, (_, i) => scene("full", [tile("news")], { id: String(i) }))).ok).toBe(false);
  });

  it("the faculty config has the details of the site and safe defaults", () => {
    const config = facultyConfig.parse({});
    expect(config).toMatchObject({ site: { name: "", subtitle: "", zone: "", assemblyPoint: "", emergencyNumber: "", logo: null } });
    expect(facultyConfig.parse({ site: { name: "Faculty of Engineering", logo: ref("image/png") } }).site.logo?.assetId).toBe("asset1");
    expect(facultyConfig.safeParse({ site: { logo: { ...ref("image/png"), sha256: "bad" } } }).success).toBe(false);
  });

  it("a screen's own settings win over its group's, which win over the default, field by field", () => {
    const base = { site: { name: "Campus", subtitle: "EPITECH", logo: pointer("default-logo") }, widgets: { clock: true, weather: false }, service: "all" };
    const group = { site: { name: "Building A" }, widgets: { weather: true } };
    const own = { site: { logo: null }, service: "pedagogical" };
    const merged = mergeConfigPatches([base, group, own]);
    expect(merged).toEqual({
      site: { name: "Building A", subtitle: "EPITECH", logo: null },
      widgets: { clock: true, weather: true },
      service: "pedagogical",
    });
    // Saying nothing inherits, saying null overrides.
    expect(mergeConfigPatches([base, {}])).toEqual(base);
    expect(patchHas(own, ["site", "logo"])).toBe(true);
    expect(patchHas(own, ["site", "name"])).toBe(false);
  });

  it("a layer cannot carry fields the config does not have, or a hash it invented", () => {
    expect(facultyConfigPatch.safeParse({ service: "pedagogical", site: { name: "A" } }).success).toBe(true);
    expect(facultyConfigPatch.safeParse({ mode: "custom" }).success).toBe(false);
    expect(facultyConfigPatch.safeParse({ site: { logo: { assetId: "x", sha256: "y" } } }).success).toBe(true);
    expect(facultyConfigPatch.parse({ site: { logo: { assetId: "x", sha256: "y" } } }).site?.logo).toEqual({ assetId: "x" });
    expect(facultyConfigPatch.safeParse({ weather: { latitude: 95, longitude: 0, label: "" } }).success).toBe(false);
  });
});

describe("themes", () => {
  const spec = (extra: object = {}) => ({ id: "t1", name: "Night", version: 1, tokens: { mode: "dark", colors: { background: "#101828", primary: "#4f8cff" }, typography: { fontFamily: "sans", scale: 1.1 }, shape: { radius: 12 } }, ...extra });
  const send = (theme: unknown) => parseServerMessage(JSON.stringify(buildMessage({ type: "theme.set", payload: { theme } } as never, 1)));

  it("is a command, and null takes a device back to its own look", () => {
    expect(send(spec()).ok).toBe(true);
    expect(send(null).ok).toBe(true);
    expect(send({ ...spec(), version: 0 }).ok).toBe(false);
  });

  it("takes any of the colours, only as six-digit hex, and nothing that is not a token", () => {
    expect(themeSpec.safeParse(spec({ tokens: { colors: { text: "#fff" } } })).success).toBe(false);
    expect(themeSpec.safeParse(spec({ tokens: { colors: { text: "red" } } })).success).toBe(false);
    expect(themeSpec.safeParse(spec({ tokens: { colors: { sparkle: "#ffffff" } } })).success).toBe(false);
    expect(themeSpec.safeParse(spec({ tokens: { surprise: true } })).success).toBe(false);
    expect(themeSpec.safeParse(spec({ tokens: { colors: { text: "#FFFFFF" } } })).success).toBe(true);
  });

  it("keeps the text scale, the radius and the font to sensible bounds", () => {
    const tokens = (t: object) => spec({ tokens: t });
    expect(themeSpec.safeParse(tokens({ typography: { scale: 0.5 } })).success).toBe(false);
    expect(themeSpec.safeParse(tokens({ typography: { scale: 3 } })).success).toBe(false);
    expect(themeSpec.safeParse(tokens({ typography: { fontFamily: "Comic Sans" } })).success).toBe(false);
    expect(themeSpec.safeParse(tokens({ shape: { radius: THEME_LIMITS.radiusMax + 1 } })).success).toBe(false);
    expect(themeSpec.safeParse(tokens({ shape: { radius: 1.5 } })).success).toBe(false);
    expect(themeSpec.parse({ id: "x", name: "Empty", version: 1 }).tokens).toEqual({ colors: {}, typography: {}, shape: {} });
  });

  it("accepts ordinary CSS and refuses what could load or run something", () => {
    expect(cssProblems(".card > h2 { color: #123456; border-radius: 4px } /* note */ @media (min-width: 40rem) { .x { gap: 1rem } }")).toEqual([]);
    for (const bad of [
      "@import 'https://evil.example/x.css';",
      "body { background: url(https://evil.example/x.png) }",
      "body { background: /* hidden */ url(x) }",
      "body { background: u\\72l(x) }",
      "a { width: expression(alert(1)) }",
      "a { background: javascript:alert(1) }",
      "a { -moz-binding: x }",
      "a { color: red } </style><script>alert(1)</script>",
      "@font-face { font-family: x }",
      "a { content: '\\75rl' }",
      ".a { color: red",
      "}",
    ]) {
      expect(cssProblems(bad).length, bad).toBeGreaterThan(0);
    }
    expect(cssProblems("a{}".repeat(THEME_LIMITS.css)).length).toBeGreaterThan(0);
  });

  it("applies the CSS rules to what a device receives as well as to what the console sends", () => {
    expect(send(spec({ css: "a { color: red }" })).ok).toBe(true);
    expect(send(spec({ css: "a { background: url(x) }" })).ok).toBe(false);
    expect(themeInput.safeParse({ name: "x", css: "@import 'x'" }).success).toBe(false);
    expect(themeInput.safeParse({ name: "x", tokens: {}, css: "", extra: 1 }).success).toBe(false);
  });

  it("a theme at its limits still fits a frame", () => {
    const frame = JSON.stringify(buildMessage({ type: "theme.set", payload: { theme: spec({ name: "é".repeat(THEME_LIMITS.name), css: "a{color:red}".repeat(THEME_LIMITS.css / 12) }) } } as never, 1));
    expect(parseServerMessage(frame).ok).toBe(true);
    expect(Buffer.byteLength(frame) + 512).toBeLessThan(MAX_FRAME_BYTES);
  });
});
