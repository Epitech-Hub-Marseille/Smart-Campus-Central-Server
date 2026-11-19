import { z } from "zod";

/**
 * Faculty screens: layouts, tile kinds and scenes.
 *
 * A screen rotates through *scenes*. A scene has a layout (one tile, two side by side, a big tile and a
 * side one, a grid...) and one tile per slot. A tile shows one *kind* of content: the news board, a
 * photo, a live stream... Kinds are described here, as data, in `TILE_KINDS`. The console builds its forms
 * from these descriptions and the server validates against them, so adding a kind means adding one entry
 * (and a renderer on the screen). A screen that does not know a kind skips the tile instead of failing.
 */

// ---- Assets ----------------------------------------------------------------------------

/** How the console and the server name a library file: only its id. Hash and size come from the stored record. */
export const assetPointer = z.object({ assetId: z.string().min(1).max(64) });

/** What a screen receives: enough to download the file over HTTPS and verify it. */
export const assetRef = z.object({
  assetId: z.string().min(1).max(64),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().positive().max(200 * 1024 * 1024),
  mime: z.string().max(60),
});
export type AssetRef = z.infer<typeof assetRef>;

// ---- Layouts ---------------------------------------------------------------------------

/** One tile slot as CSS grid lines: [row start, column start, row end, column end]. */
export type TilePlace = readonly [number, number, number, number];

export interface SceneLayoutDef {
  label: string;
  /** CSS grid template, shared by the console preview and the screens. */
  columns: string;
  rows: string;
  tiles: readonly TilePlace[];
}

export const SCENE_LAYOUTS = {
  full: { label: "Full screen", columns: "1fr", rows: "1fr", tiles: [[1, 1, 2, 2]] },
  columns: { label: "Two columns", columns: "1fr 1fr", rows: "1fr", tiles: [[1, 1, 2, 2], [1, 2, 2, 3]] },
  rows: { label: "Two rows", columns: "1fr", rows: "1fr 1fr", tiles: [[1, 1, 2, 2], [2, 1, 3, 2]] },
  focus: { label: "Main and side", columns: "2fr 1fr", rows: "1fr", tiles: [[1, 1, 2, 2], [1, 2, 2, 3]] },
  "focus-split": { label: "Main and two side", columns: "2fr 1fr", rows: "1fr 1fr", tiles: [[1, 1, 3, 2], [1, 2, 2, 3], [2, 2, 3, 3]] },
  quad: { label: "Four tiles", columns: "1fr 1fr", rows: "1fr 1fr", tiles: [[1, 1, 2, 2], [1, 2, 2, 3], [2, 1, 3, 2], [2, 2, 3, 3]] },
} as const satisfies Record<string, SceneLayoutDef>;
export type SceneLayoutId = keyof typeof SCENE_LAYOUTS;
export const SCENE_LAYOUT_IDS = Object.keys(SCENE_LAYOUTS) as [SceneLayoutId, ...SceneLayoutId[]];

// ---- Tile kinds ------------------------------------------------------------------------

export type FieldType = "text" | "longtext" | "url" | "number" | "boolean" | "select" | "asset";

/** One setting of a kind, in the words the console needs to draw a field for it. */
export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  help?: string;
  max?: number;
  min?: number;
  options?: readonly { value: string; label: string }[];
  /** For `asset`: which files of the library can be picked. */
  accept?: "image" | "video";
  default?: string | number | boolean;
}

export interface TileKindDef {
  kind: string;
  label: string;
  description: string;
  group: "board" | "media" | "live";
  /** Makes sound unless `muted`. At most one tile of a scene may be heard. */
  audible: boolean;
  fields: readonly FieldDef[];
}

export const TILE_LIMITS = { scenes: 12, tiles: 24, text: 300, name: 60, url: 300, label: 60, durationMin: 3, durationMax: 600 } as const;

const FIT = [
  { value: "contain", label: "Fit inside" },
  { value: "cover", label: "Fill the tile" },
] as const;

const httpUrl = z
  .string()
  .trim()
  .url()
  .max(TILE_LIMITS.url)
  .refine((u) => /^https?:\/\//i.test(u), "must be an http(s) address");

/** Video id of a YouTube address (watch, share, live or embed form), or the id itself. */
export function parseYoutubeId(input: string): string | null {
  const value = input.trim();
  if (/^[\w-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\.|^m\./, "");
    let id: string | null = null;
    if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0] ?? null;
    else if (host === "youtube.com" || host === "youtube-nocookie.com") {
      id = url.searchParams.get("v") ?? /^\/(?:live|embed|shorts)\/([\w-]{11})/.exec(url.pathname)?.[1] ?? null;
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Settings schemas of every kind, built once for what the console sends (`assetPointer`) and once for what a screen receives (`assetRef`). */
const settingsFor = <A extends z.ZodType>(asset: A) =>
  ({
    news: z.object({}),
    staff: z.object({}),
    reservations: z.object({}),
    image: z.object({ asset, fit: z.enum(["contain", "cover"]).default("contain") }),
    video: z.object({ asset, fit: z.enum(["contain", "cover"]).default("contain"), muted: z.boolean().default(true), loop: z.boolean().default(true) }),
    text: z.object({ text: z.string().trim().min(1).max(TILE_LIMITS.text), align: z.enum(["left", "center"]).default("center") }),
    web: z.object({ url: httpUrl, refreshSeconds: z.number().int().min(10).max(86_400).default(300) }),
    radio: z.object({ url: httpUrl, label: z.string().trim().max(TILE_LIMITS.label).default(""), muted: z.boolean().default(false) }),
    stream: z.object({
      url: httpUrl,
      format: z.enum(["auto", "hls", "mp4", "mjpeg"]).default("auto"),
      label: z.string().trim().max(TILE_LIMITS.label).default(""),
      muted: z.boolean().default(true),
    }),
    youtube: z
      .object({
        // A video or a live; the console accepts any YouTube address and stores the id.
        video: z.preprocess((v) => (typeof v === "string" ? (parseYoutubeId(v) ?? v) : v), z.string().regex(/^[\w-]{11}$/, "not a YouTube video address")),
        muted: z.boolean().default(true),
      }),
  }) as const;

const authoringSettings = settingsFor(assetPointer);
const wireSettings = settingsFor(assetRef);

export const TILE_KINDS: readonly TileKindDef[] = [
  { kind: "news", label: "News", description: "The campus news feed and important notices.", group: "board", audible: false, fields: [] },
  { kind: "staff", label: "Staff availability", description: "Who is available, busy or away. Follows the screen's service filter.", group: "board", audible: false, fields: [] },
  { kind: "reservations", label: "Room reservations", description: "What is booked in the next hours.", group: "board", audible: false, fields: [] },
  {
    kind: "image",
    label: "Image",
    description: "A picture from the media library.",
    group: "media",
    audible: false,
    fields: [
      { key: "asset", label: "Image", type: "asset", accept: "image", required: true },
      { key: "fit", label: "Fit", type: "select", options: FIT, default: "contain" },
    ],
  },
  {
    kind: "video",
    label: "Video",
    description: "A video from the media library.",
    group: "media",
    audible: true,
    fields: [
      { key: "asset", label: "Video", type: "asset", accept: "video", required: true },
      { key: "fit", label: "Fit", type: "select", options: FIT, default: "contain" },
      { key: "muted", label: "Muted", type: "boolean", default: true },
      { key: "loop", label: "Loop", type: "boolean", default: true },
    ],
  },
  {
    kind: "text",
    label: "Text",
    description: "A short message.",
    group: "media",
    audible: false,
    fields: [
      { key: "text", label: "Text", type: "longtext", required: true, max: TILE_LIMITS.text },
      { key: "align", label: "Alignment", type: "select", options: [{ value: "center", label: "Centered" }, { value: "left", label: "Left" }], default: "center" },
    ],
  },
  {
    kind: "web",
    label: "Web page",
    description: "A live web page, reloaded regularly.",
    group: "live",
    audible: false,
    fields: [
      { key: "url", label: "Address", type: "url", required: true, max: TILE_LIMITS.url },
      { key: "refreshSeconds", label: "Reload every (seconds)", type: "number", min: 10, max: 86_400, default: 300 },
    ],
  },
  {
    kind: "radio",
    label: "Live radio",
    description: "An audio stream (Icecast, SHAOUTcast or any HTTP audio stream).",
    group: "live",
    audible: true,
    fields: [
      { key: "url", label: "Stream address", type: "url", required: true, max: TILE_LIMITS.url },
      { key: "label", label: "Station name", type: "text", max: TILE_LIMITS.label },
      { key: "muted", label: "Muted", type: "boolean", default: false },
    ],
  },
  {
    kind: "stream",
    label: "Live video stream",
    description: "A video stream that is not on YouTube: HLS (.m3u8), a live MP4 or an MJPEG camera.",
    group: "live",
    audible: true,
    fields: [
      { key: "url", label: "Stream address", type: "url", required: true, max: TILE_LIMITS.url },
      {
        key: "format",
        label: "Format",
        type: "select",
        options: [
          { value: "auto", label: "Detect" },
          { value: "hls", label: "HLS (.m3u8)" },
          { value: "mp4", label: "MP4" },
          { value: "mjpeg", label: "MJPEG" },
        ],
        default: "auto",
      },
      { key: "label", label: "Caption", type: "text", max: TILE_LIMITS.label },
      { key: "muted", label: "Muted", type: "boolean", default: true },
    ],
  },
  {
    kind: "youtube",
    label: "YouTube",
    description: "A YouTube video or live stream. Paste any YouTube address.",
    group: "live",
    audible: true,
    fields: [
      { key: "video", label: "YouTube address or video id", type: "text", required: true, max: TILE_LIMITS.url },
      { key: "muted", label: "Muted", type: "boolean", default: true },
    ],
  },
];

export const tileKindDef = (kind: string) => TILE_KINDS.find((k) => k.kind === kind);

type KindName = keyof typeof authoringSettings;
const isKnown = (kind: string): kind is KindName => kind in authoringSettings;

/** Validates tile settings the way the console sends them (assets named by id). Unknown kind: refused. */
export function parseTileSettings(kind: string, settings: unknown): { ok: true; settings: Record<string, unknown> } | { ok: false; error: string } {
  if (!isKnown(kind)) return { ok: false, error: `unknown tile kind "${kind}"` };
  const parsed = authoringSettings[kind].safeParse(settings ?? {});
  return parsed.success ? { ok: true, settings: parsed.data as Record<string, unknown> } : { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || kind}: ${i.message}`).join("; ") };
}

// ---- Scenes ----------------------------------------------------------------------------

const sceneBase = {
  id: z.string().min(1).max(64),
  name: z.string().trim().max(TILE_LIMITS.name).default(""),
  layout: z.enum(SCENE_LAYOUT_IDS),
  durationSeconds: z.number().int().min(TILE_LIMITS.durationMin).max(TILE_LIMITS.durationMax).default(15),
  /** Absolute times (ms), so a screen applies the schedule by itself, even offline. */
  startsAt: z.number().int().nonnegative().optional(),
  endsAt: z.number().int().nonnegative().optional(),
};

/** Rules every scene follows, whoever sends it. `settingsOf` says how to read a tile's settings. */
function checkScene(scene: { layout: SceneLayoutId; tiles: { kind: string; settings: Record<string, unknown> }[]; startsAt?: number; endsAt?: number }, ctx: z.RefinementCtx) {
  const slots = SCENE_LAYOUTS[scene.layout].tiles.length;
  if (scene.tiles.length !== slots) ctx.addIssue({ code: "custom", path: ["tiles"], message: `layout "${scene.layout}" has ${slots} tile${slots === 1 ? "" : "s"}` });
  if (scene.startsAt !== undefined && scene.endsAt !== undefined && scene.endsAt <= scene.startsAt) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "endsAt must be after startsAt" });
  // Two things talking at once is noise: one audible tile per scene, the rest must be muted.
  const heard = scene.tiles.filter((t) => {
    const def = tileKindDef(t.kind);
    if (!def?.audible) return false;
    const muted = t.settings.muted ?? def.fields.find((f) => f.key === "muted")?.default;
    return muted !== true;
  });
  if (heard.length > 1) ctx.addIssue({ code: "custom", path: ["tiles"], message: "only one tile of a scene can play sound, mute the others" });
}

/** A scene as the console sends it and as it is stored. */
export const sceneInput = z
  .object({
    ...sceneBase,
    tiles: z
      .array(
        z.object({ id: z.string().min(1).max(64), kind: z.string().min(1).max(30), settings: z.record(z.string(), z.unknown()).default({}) }).superRefine((tile, ctx) => {
          const parsed = parseTileSettings(tile.kind, tile.settings);
          if (!parsed.ok) ctx.addIssue({ code: "custom", path: ["settings"], message: parsed.error });
        }),
      )
      .min(1)
      .max(4),
  })
  .transform((scene) => ({
    ...scene,
    // Defaults filled in, so what is stored and sent is complete.
    tiles: scene.tiles.map((t) => {
      const parsed = parseTileSettings(t.kind, t.settings);
      return { ...t, settings: parsed.ok ? parsed.settings : t.settings };
    }),
  }))
  .superRefine(checkScene);
export type SceneInput = z.infer<typeof sceneInput>;

/**
 * A scene as a screen receives it. A kind this screen version does not know is passed through as it is
 * (the screen skips it), which is what lets the server add kinds before every screen is updated.
 */
export const wireScene = z
  .object({
    ...sceneBase,
    tiles: z
      .array(
        z
          .object({ id: z.string().min(1).max(64), kind: z.string().min(1).max(30), settings: z.record(z.string(), z.unknown()).default({}) })
          .superRefine((tile, ctx) => {
            if (!isKnown(tile.kind)) return;
            const parsed = wireSettings[tile.kind].safeParse(tile.settings);
            if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: ["settings", ...issue.path] });
            else if (tile.kind === "image" || tile.kind === "video") {
              const mime = (parsed.data as { asset: { mime: string } }).asset.mime;
              if (!mime.startsWith(`${tile.kind}/`)) ctx.addIssue({ code: "custom", path: ["settings", "asset"], message: `the file is not a ${tile.kind}` });
            }
          }),
      )
      .min(1)
      .max(4),
  })
  .superRefine(checkScene);
export type WireScene = z.infer<typeof wireScene>;

// ---- Layered configuration -------------------------------------------------------------

const SERVICE_FILTER = ["all", "pedagogical", "administrative"] as const;

/**
 * What a layer (the default, a group of screens, one screen) overrides. Everything is optional: a missing
 * field is inherited from the layer above, so a screen's own value always wins over its group's.
 */
export const facultyConfigPatch = z
  .object({
    site: z
      .object({
        name: z.string().trim().max(80),
        subtitle: z.string().trim().max(120),
        zone: z.string().trim().max(60),
        assemblyPoint: z.string().trim().max(80),
        emergencyNumber: z.string().trim().max(30),
        /** `null` means "no logo", which is different from not saying anything. */
        logo: assetPointer.nullable(),
      })
      .partial(),
    service: z.enum(SERVICE_FILTER),
    carousel: z.object({ enabled: z.boolean() }).partial(),
    widgets: z.object({ clock: z.boolean(), date: z.boolean(), weather: z.boolean() }).partial(),
    weather: z.object({ label: z.string().trim().max(60), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).nullable(),
  })
  .partial()
  .strict();
export type FacultyConfigPatch = z.infer<typeof facultyConfigPatch>;

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Layers from the least specific to the most specific; the last one that says something wins, field by field. */
export function mergeConfigPatches(layers: readonly (Record<string, unknown> | null | undefined)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const apply = (target: Record<string, unknown>, patch: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      // Weather and the logo are whole values: a screen with its own position does not mix with its group's.
      if (isPlain(value) && key !== "weather" && key !== "logo") apply((target[key] = isPlain(target[key]) ? { ...(target[key] as object) } : {}) as Record<string, unknown>, value);
      else target[key] = value;
    }
  };
  for (const layer of layers) if (layer) apply(out, layer);
  return out;
}

/** True when `patch` sets the field at `path` (e.g. ["site", "logo"]), which is how the console knows what is inherited. */
export function patchHas(patch: Record<string, unknown> | null | undefined, path: readonly string[]): boolean {
  let node: unknown = patch;
  for (const key of path) {
    if (!isPlain(node) || !(key in node) || node[key] === undefined) return false;
    node = node[key];
  }
  return true;
}
