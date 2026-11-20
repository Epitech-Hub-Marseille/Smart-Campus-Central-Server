import { z } from "zod";
import { assetRef } from "./screens.js";

/**
 * Visual themes for the door units (the phone app) and the Faculty screens.
 *
 * A theme is **tokens** (JSON) that every app understands, and optionally **CSS** that only the web-based Faculty screens
 * apply. The tokens are a small, closed set (colours, a font family from a fixed list, a text scale, a corner radius), so a
 * theme can never be bigger than a frame, and a device that does not know a token ignores it. Emergency alerts keep their colour,
 * wording and alarm; a theme only reaches them through the small `emergency` section below.
 */
export const THEME_LIMITS = { css: 12_000, name: 60, scaleMin: 0.8, scaleMax: 1.4, radiusMax: 32, fontBytes: 2 * 1024 * 1024 } as const;

/**
 * Where an uploaded font file may be used. A device registers each file under a fixed family name, `sc-body`,
 * `sc-heading` or `sc-mono`, and the Faculty screens expose them to the theme CSS as `--font-body`, `--font-heading`
 * and `--font-mono`. Fonts are files in the asset library, never CSS: `@font-face` and `url()` stay refused.
 */
export const THEME_FONT_SLOTS = ["body", "heading", "mono"] as const;
export type ThemeFontSlot = (typeof THEME_FONT_SLOTS)[number];

const slotRecord = <T extends z.ZodType>(value: T) =>
  z.object(Object.fromEntries(THEME_FONT_SLOTS.map((slot) => [slot, value.optional()])) as Record<ThemeFontSlot, z.ZodOptional<T>>).strict();

/** What the console sends: the id of a font in the asset library for each slot. */
const fontChoice = z.string().min(1).max(64);

export const THEME_FONTS = ["system", "sans", "serif", "mono", "condensed"] as const;
export type ThemeFont = (typeof THEME_FONTS)[number];

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a colour like #1d4f9f");

/** The colours a theme may set. Whatever it leaves out keeps the app's own. */
export const THEME_COLORS = ["background", "surface", "text", "muted", "primary", "primaryText", "border", "success", "warning", "danger"] as const;
export type ThemeColor = (typeof THEME_COLORS)[number];

export const themeTokens = z
  .object({
    mode: z.enum(["light", "dark"]).optional(),
    colors: z.object(Object.fromEntries(THEME_COLORS.map((c) => [c, hex.optional()])) as Record<ThemeColor, z.ZodOptional<typeof hex>>).strict().default({}),
    typography: z
      .object({
        fontFamily: z.enum(THEME_FONTS).optional(),
        /** Multiplies every text size; 1 is the app's own. */
        scale: z.number().min(THEME_LIMITS.scaleMin).max(THEME_LIMITS.scaleMax).optional(),
      })
      .strict()
      .default({}),
    shape: z.object({ radius: z.number().int().min(0).max(THEME_LIMITS.radiusMax).optional() }).strict().default({}),
  })
  .strict();
export type ThemeTokens = z.infer<typeof themeTokens>;

/**
 * Why a piece of CSS is refused, or none. The CSS comes from an administrator and runs in a kiosk, so the rules are about
 * what it could reach, not about taste: nothing is loaded from elsewhere (no `url()`, no `@import`), nothing is executed
 * (`expression`, `javascript:`, `-moz-binding`, `behavior`), and it cannot close its own `<style>` element.
 */
export function cssProblems(css: string): string[] {
  const problems: string[] = [];
  // Comments are removed first, so the rules look at what the browser would: a `url(` after a comment is still a `url(`.
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  if (css.length > THEME_LIMITS.css) problems.push(`the CSS is longer than ${THEME_LIMITS.css} characters`);
  if (/[<>]/.test(plain.replace(/(^|[\s,{};])>(?=[\s.#*[:a-zA-Z])/g, "$1 ").replace(/[\s,]>\s/g, " "))) problems.push("the CSS contains < or an unexpected >");
  const forbidden: [RegExp, string][] = [
    [/@import/i, "@import is not allowed (nothing may be loaded from elsewhere)"],
    [/@font-face/i, "@font-face is not allowed, use one of the built-in font families"],
    [/url\s*\(/i, "url() is not allowed (nothing may be loaded from elsewhere)"],
    [/expression\s*\(/i, "expression() is not allowed"],
    [/javascript\s*:/i, "javascript: is not allowed"],
    [/-moz-binding|behavior\s*:/i, "binding and behavior properties are not allowed"],
    [/\\/, "escape sequences are not allowed"],
  ];
  for (const [pattern, message] of forbidden) if (pattern.test(plain)) problems.push(message);
  let depth = 0;
  for (const ch of plain) {
    if (ch === "{") depth++;
    if (ch === "}" && --depth < 0) break;
  }
  if (depth !== 0) problems.push("the braces do not match");
  return problems;
}

/**
 * How an emergency alert may be dressed. Emergencies stay recognisable and readable whatever the theme says, so this is a
 * small, closed set and not CSS: the wording of the alert, its alarm and its white and yellow text are never themed. Its
 * background is the dark colour of its kind unless the theme gives another. A theme can give the alert its fonts, a frame,
 * rounder corners, and dark backgrounds for the page and the panel behind the numbered steps. A background must keep white text readable (contrast of at least EMERGENCY_MIN_CONTRAST).
 * A device that cannot apply any of it, or that finds it invalid, shows the default alert.
 */
export const EMERGENCY_FRAMES = ["stripes", "bar"] as const;
export type EmergencyFrame = (typeof EMERGENCY_FRAMES)[number];

/** WCAG's threshold for large text. The alert's text is large and white. */
export const EMERGENCY_MIN_CONTRAST = 4.5;

/** Contrast ratio of white text on a "#rrggbb" background (WCAG relative luminance). */
export function contrastOnWhite(color: string): number {
  const [red, green, blue] = [1, 3, 5].map((i) => {
    const channel = parseInt(color.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 1.05 / (0.2126 * red + 0.7152 * green + 0.0722 * blue + 0.05);
}

const darkEnough = hex.refine((color) => contrastOnWhite(color) >= EMERGENCY_MIN_CONTRAST, `dark enough for white text (contrast ${EMERGENCY_MIN_CONTRAST}:1)`);

export const emergencyTheme = z
  .object({
    /** Use the theme's font files (body, heading, mono) on the alert. */
    fonts: z.boolean().default(false),
    /** "stripes": yellow and black hazard stripes (the default look). "bar": a plain solid yellow band. */
    frame: z.enum(EMERGENCY_FRAMES).default("stripes"),
    radius: z.number().int().min(0).max(THEME_LIMITS.radiusMax).optional(),
    colors: z.object({ background: darkEnough.optional(), card: darkEnough.optional() }).strict().default({}),
  })
  .strict();
export type EmergencyTheme = z.infer<typeof emergencyTheme>;

/** What a device receives: one resolved theme. `version` rises with every edit, so a device can tell it has the latest. */
export const themeSpec = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().trim().min(1).max(THEME_LIMITS.name),
    version: z.number().int().positive(),
    tokens: themeTokens.default({}),
    /** Font files to download (id, hash, size), as for any other asset. Without one, the app falls back to `fontFamily`. */
    fonts: slotRecord(assetRef).default({}),
    /** For the alerts. A device that finds it invalid ignores this part and keeps the rest of the theme: the default alert. */
    emergency: emergencyTheme.optional().catch(undefined),
    /** For the Faculty screens only. The door app ignores it. */
    css: z.string().max(THEME_LIMITS.css).optional(),
  })
  .superRefine((theme, ctx) => {
    if (theme.css) for (const problem of cssProblems(theme.css)) ctx.addIssue({ code: "custom", path: ["css"], message: problem });
  });
export type ThemeSpec = z.infer<typeof themeSpec>;

/** What the console sends to make or change a theme. */
export const themeInput = z
  .object({
    name: z.string().trim().min(1).max(THEME_LIMITS.name),
    description: z.string().trim().max(200).default(""),
    tokens: themeTokens.default({}),
    fonts: slotRecord(fontChoice).default({}),
    emergency: emergencyTheme.default({}),
    css: z.string().max(THEME_LIMITS.css).default(""),
  })
  .strict()
  .superRefine((theme, ctx) => {
    for (const problem of cssProblems(theme.css)) ctx.addIssue({ code: "custom", path: ["css"], message: problem });
  });
export type ThemeInput = z.infer<typeof themeInput>;
