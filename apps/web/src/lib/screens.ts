import { Cctv, CalendarDays, Film, Globe, Image as ImageIcon, Newspaper, Puzzle, Radio, Type, UserCheck, Youtube, type LucideIcon } from "lucide-react";
import type { FieldDef, Scene, Tile, TileKindDef } from "@/lib/types";

/** Icons by kind. A kind the console has no icon for (a new one from the server) still works with a generic one. */
const KIND_ICONS: Record<string, LucideIcon> = {
  news: Newspaper,
  staff: UserCheck,
  reservations: CalendarDays,
  image: ImageIcon,
  video: Film,
  text: Type,
  web: Globe,
  radio: Radio,
  stream: Cctv,
  youtube: Youtube,
};
export const kindIcon = (kind: string): LucideIcon => KIND_ICONS[kind] ?? Puzzle;

export const GROUP_LABEL: Record<TileKindDef["group"], string> = { board: "Information board", media: "Media", live: "Live" };

/**
 * A random id for a scene or tile. `crypto.randomUUID` only exists in secure contexts (https or localhost), so the console opened
 * over plain http on a LAN address threw here and editing a carousel did nothing. `getRandomValues` has no such limit.
 */
export function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Settings a new tile of this kind starts with: the defaults of its fields. */
export function defaultSettings(def: TileKindDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of def.fields) if (f.default !== undefined) out[f.key] = f.default;
  return out;
}

export const newTile = (def: TileKindDef): Tile => ({ id: newId(), kind: def.kind, settings: defaultSettings(def) });

/** Does the tile have everything its kind requires? Used to enable "Save"; the server stays the judge. */
export function missingFields(def: TileKindDef | undefined, tile: Tile): FieldDef[] {
  if (!def) return [];
  return def.fields.filter((f) => f.required && !tile.settings[f.key] && tile.settings[f.key] !== 0);
}

/** A tile that makes sound: an audible kind that is not muted. */
export function isHeard(def: TileKindDef | undefined, tile: Tile): boolean {
  if (!def?.audible) return false;
  const muted = tile.settings.muted ?? def.fields.find((f) => f.key === "muted")?.default;
  return muted !== true;
}

export const cloneScenes = (scenes: Scene[]): Scene[] => scenes.map((s) => ({ ...s, id: newId(), tiles: s.tiles.map((t) => ({ ...t, id: newId(), settings: structuredClone(t.settings) })) }));

// ---- Paths into a settings patch ("site.logo"), so inheritance can be shown and reset per field ----

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function getPath(obj: unknown, path: readonly string[]): unknown {
  let node = obj;
  for (const key of path) {
    if (!isObj(node)) return undefined;
    node = node[key];
  }
  return node;
}

export const hasPath = (obj: unknown, path: readonly string[]) => getPath(obj, path) !== undefined;

export function setPath<T extends object>(obj: T, path: readonly string[], value: unknown): T {
  const [head, ...rest] = path;
  if (head === undefined) return obj;
  const next = { ...obj } as Obj;
  const child = (obj as Obj)[head];
  next[head] = rest.length ? setPath(isObj(child) ? child : {}, rest, value) : value;
  return next as T;
}

/** Removes the field, and the objects it leaves empty, so a level that sets nothing sends `{}`. */
export function unsetPath<T extends object>(obj: T, path: readonly string[]): T {
  const [head, ...rest] = path;
  if (head === undefined || !(head in obj)) return obj;
  const next = { ...obj } as Obj;
  if (rest.length === 0) delete next[head];
  else {
    const existing = (obj as Obj)[head];
    const child = unsetPath(isObj(existing) ? existing : {}, rest);
    if (Object.keys(child).length === 0) delete next[head];
    else next[head] = child;
  }
  return next as T;
}
