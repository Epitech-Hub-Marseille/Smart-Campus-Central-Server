import { THEME_FONT_SLOTS, THEME_LIMITS, type ThemeFontSlot } from "@smartcampus/protocol";
import { unzipSync } from "fflate";
import { HttpError } from "./errors.js";

/** Largest .zip the server reads, and the most entries it looks at. A theme is a few files and a few fonts. */
export const BUNDLE_LIMITS = { zipBytes: 8 * 1024 * 1024, entries: 32, textBytes: 256 * 1024 } as const;

const FONT_EXTENSIONS = /\.(woff2|woff|ttf|otf)$/i;

/** What a theme bundle holds, read but not yet trusted: the theme is validated by the caller with the same schema as the console. */
export interface ThemeBundle {
  /** `theme.json` as parsed. The font slots are still names here, not ids. */
  theme: Record<string, unknown>;
  /** CSS from the `.css` file of the bundle, when `theme.json` has none of its own. */
  css: string | null;
  /** Font files by slot, with the name they will have in the font library. */
  fonts: { slot: ThemeFontSlot; name: string; data: Buffer }[];
}

const baseName = (path: string) => path.split("/").pop() ?? path;
const withoutExtension = (name: string) => name.replace(/\.[^.]+$/, "");

/** Junk that archive tools add: folders, `__MACOSX`, dot files. */
const isIgnored = (path: string) => path.endsWith("/") || path.split("/").some((part) => part === "__MACOSX" || part.startsWith("."));

/**
 * Reads a theme bundle: a .zip with `theme.json` (name, description, tokens, optional `css`, optional `fontNames`
 * that maps a slot to a font file) and the font files it names, in any folder. Nothing is written to disk, so a path
 * inside the archive can never point outside of anything; names are only compared.
 *
 * Zip bombs: the size an entry declares is checked before it is inflated, and the inflater stops at that size (a header
 * that lies about it gets a truncated file, which then fails the format check), so memory stays below the limits here.
 */
export function readThemeBundle(zip: Buffer): ThemeBundle {
  if (zip.length === 0) throw new HttpError(400, "The file is empty");
  if (zip.length > BUNDLE_LIMITS.zipBytes) throw new HttpError(413, `A theme bundle may be at most ${BUNDLE_LIMITS.zipBytes / 1024 / 1024} MB`);

  let entries = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(zip), {
      filter: ({ name, originalSize }) => {
        if (isIgnored(name)) return false;
        if (++entries > BUNDLE_LIMITS.entries) throw new HttpError(400, `A theme bundle holds at most ${BUNDLE_LIMITS.entries} files`);
        const limit = FONT_EXTENSIONS.test(name) ? THEME_LIMITS.fontBytes : BUNDLE_LIMITS.textBytes;
        if (originalSize > limit) throw new HttpError(413, `${baseName(name)} is larger than ${limit / 1024} KB once unpacked`);
        return true;
      },
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "That is not a valid .zip file");
  }

  const byBase = new Map(Object.entries(files).map(([path, data]) => [baseName(path), Buffer.from(data)]));
  const themeFile = byBase.get("theme.json");
  if (!themeFile) throw new HttpError(400, "The bundle has no theme.json");

  let theme: Record<string, unknown>;
  try {
    theme = JSON.parse(themeFile.toString("utf8"));
  } catch {
    throw new HttpError(400, "theme.json is not valid JSON");
  }
  if (typeof theme !== "object" || theme === null || Array.isArray(theme)) throw new HttpError(400, "theme.json must be a JSON object");

  const cssName = [...byBase.keys()].find((name) => name.toLowerCase().endsWith(".css"));
  return { theme, css: cssName ? byBase.get(cssName)!.toString("utf8") : null, fonts: fontsOf(theme.fontNames, byBase) };
}

/** Matches each `fontNames` entry to a file of the bundle, by file name with or without its extension. */
function fontsOf(fontNames: unknown, byBase: Map<string, Buffer>): ThemeBundle["fonts"] {
  if (fontNames === undefined) return [];
  if (typeof fontNames !== "object" || fontNames === null || Array.isArray(fontNames)) throw new HttpError(400, "fontNames must map a slot to a file name");
  const fontFiles = [...byBase.entries()].filter(([name]) => FONT_EXTENSIONS.test(name));
  const fonts: ThemeBundle["fonts"] = [];
  for (const [slot, wanted] of Object.entries(fontNames)) {
    if (!(THEME_FONT_SLOTS as readonly string[]).includes(slot)) throw new HttpError(400, `Unknown font slot "${slot}". Use ${THEME_FONT_SLOTS.join(", ")}`);
    if (typeof wanted !== "string" || !wanted) throw new HttpError(400, `fontNames.${slot} must be a file name`);
    const match = fontFiles.find(([name]) => name === wanted || withoutExtension(name) === withoutExtension(wanted));
    if (!match) throw new HttpError(400, `The font "${wanted}" (${slot}) is not in the bundle`);
    fonts.push({ slot: slot as ThemeFontSlot, name: withoutExtension(match[0]), data: match[1] });
  }
  return fonts;
}
