import { z } from "zod";

/**
 * Visual themes for the door units (the phone app) and the Faculty screens.
 *
 * A theme is **tokens** (JSON) that every app understands, and optionally **CSS** that only the web-based Faculty screens
 * apply. The tokens are a small, closed set (colours, a font family from a fixed list, a text scale, a corner radius), so a
 * theme can never be bigger than a frame, and a device that does not know a token ignores it. What a theme cannot touch:
 * emergency alerts, which always look the same.
 */
export const THEME_LIMITS = { css: 12_000, name: 60, scaleMin: 0.8, scaleMax: 1.4, radiusMax: 32 } as const;

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

/** What a device receives: one resolved theme. `version` rises with every edit, so a device can tell it has the latest. */
export const themeSpec = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().trim().min(1).max(THEME_LIMITS.name),
    version: z.number().int().positive(),
    tokens: themeTokens.default({}),
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
    css: z.string().max(THEME_LIMITS.css).default(""),
  })
  .strict()
  .superRefine((theme, ctx) => {
    for (const problem of cssProblems(theme.css)) ctx.addIssue({ code: "custom", path: ["css"], message: problem });
  });
export type ThemeInput = z.infer<typeof themeInput>;
