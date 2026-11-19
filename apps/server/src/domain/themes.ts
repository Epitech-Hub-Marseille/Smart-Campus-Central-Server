import { THEME_FONT_SLOTS, emergencyTheme, themeInput, type EmergencyTheme, themeTokens, type ThemeFontSlot, type ThemeSpec } from "@smartcampus/protocol";
import { z } from "zod";
import { recordAudit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { sniffFont } from "../lib/fontSniff.js";
import { readThemeBundle } from "../lib/themeBundle.js";
import { ulid } from "@smartcampus/protocol";
import { AssetModel } from "../models/asset.js";
import { DeviceModel } from "../models/device.js";
import { ThemeAssignmentModel, ThemeModel } from "../models/theme.js";
import type { PublicUser } from "../models/user.js";
import { assetRefOf, ensureFontAsset } from "./assets.js";
import { enqueueCommand } from "./commands.js";

type Actor = Pick<PublicUser, "id" | "name">;
type ThemeDoc = InstanceType<typeof ThemeModel>;

/** Kinds of device that wear a theme. Readers have no screen. */
export const THEMED_TYPES = ["door", "display"] as const;

export const assignmentInput = z
  .object({
    scope: z.enum(["default", "group", "device"]),
    key: z.string().trim().min(1).max(64),
    // null takes the assignment away.
    themeId: z.string().min(1).max(64).nullable(),
  })
  .strict();

type FontIds = Partial<Record<ThemeFontSlot, string>>;
const fontIdsOf = (theme: { fonts?: unknown }) => (theme.fonts ?? {}) as FontIds;

/** The font files of a theme as devices receive them, taken from the stored records. A font that no longer exists is left out. */
const fontRefsOf = (theme: ThemeDoc, fonts: Map<string, ReturnType<typeof assetRefOf>>): ThemeSpec["fonts"] => {
  const ids = fontIdsOf(theme);
  const refs: ThemeSpec["fonts"] = {};
  for (const slot of THEME_FONT_SLOTS) {
    const ref = ids[slot] && fonts.get(ids[slot]);
    if (ref) refs[slot] = ref;
  }
  return refs;
};

/** The alert settings to send: nothing when they are the defaults, so a theme that does not dress alerts says nothing about them. */
function alertOf(theme: ThemeDoc): { emergency?: EmergencyTheme } {
  const settings = emergencyTheme.parse(theme.emergency ?? {});
  const dressed = settings.fonts || settings.frame !== "stripes" || settings.radius !== undefined || Object.keys(settings.colors).length > 0;
  return dressed ? { emergency: settings } : {};
}

const specOf = (theme: ThemeDoc, deviceType: string, fonts: Map<string, ReturnType<typeof assetRefOf>>): ThemeSpec => ({
  id: theme.themeId,
  name: theme.name,
  version: theme.version,
  tokens: themeTokens.parse(theme.tokens ?? {}),
  fonts: fontRefsOf(theme, fonts),
  ...alertOf(theme),
  // CSS is for the web-based Faculty screens; a door unit would only carry bytes it cannot use.
  ...(deviceType === "display" && theme.css && { css: theme.css }),
});

interface Context {
  assignments: Map<string, string>;
  themes: Map<string, ThemeDoc>;
  fonts: Map<string, ReturnType<typeof assetRefOf>>;
}

async function loadContext(): Promise<Context> {
  const [assignments, themes] = await Promise.all([ThemeAssignmentModel.find(), ThemeModel.find()]);
  const fontIds = [...new Set(themes.flatMap((t) => Object.values(fontIdsOf(t))))];
  const fontAssets = await AssetModel.find({ assetId: { $in: fontIds }, kind: "font" });
  return {
    assignments: new Map(assignments.map((a) => [`${a.scope}:${a.key}`, a.themeId])),
    themes: new Map(themes.map((t) => [t.themeId, t])),
    fonts: new Map(fontAssets.map((a) => [a.assetId, assetRefOf(a)])),
  };
}

/** A theme may only name fonts that exist in the library, so a typo or a sound file is refused at save, not on a wall screen. */
async function assertFontsExist(input: { fonts: FontIds }): Promise<void> {
  const ids = [...new Set(Object.values(input.fonts))];
  if (ids.length === 0) return;
  const found = await AssetModel.countDocuments({ assetId: { $in: ids }, kind: "font" });
  if (found !== ids.length) throw new HttpError(400, "A font of this theme is not in the font library");
}

/** Names of the themes that use a font, so the library can refuse to delete it. */
export async function themesUsingAsset(assetId: string): Promise<string[]> {
  const themes = await ThemeModel.find({ $or: THEME_FONT_SLOTS.map((slot) => ({ [`fonts.${slot}`]: assetId })) }, { name: 1 });
  return themes.map((t) => `theme ${t.name}`);
}

export type ThemeSource = "device" | "group" | "default" | "none";

/** Which theme a device wears and why. */
export function resolveFor(device: { deviceId: string; type: string; groups: string[] }, ctx: Context): { theme: ThemeDoc | null; from: ThemeSource; via?: string } {
  const pick = (scope: string, key: string) => {
    const id = ctx.assignments.get(`${scope}:${key}`);
    return id ? (ctx.themes.get(id) ?? null) : null;
  };
  const own = pick("device", device.deviceId);
  if (own) return { theme: own, from: "device" };
  for (const group of [...device.groups].sort()) {
    const t = pick("group", group);
    if (t) return { theme: t, from: "group", via: group };
  }
  const base = pick("default", device.type);
  return base ? { theme: base, from: "default" } : { theme: null, from: "none" };
}

/**
 * Sends each door unit and Faculty screen the theme it should wear, but only when that differs from what it was last
 * told, so a change to one theme does not wake every screen on the campus.
 */
export async function pushThemes(deviceIds?: string[]): Promise<number> {
  const [devices, ctx] = await Promise.all([
    DeviceModel.find({ type: { $in: THEMED_TYPES }, status: "active", ...(deviceIds && { deviceId: { $in: deviceIds } }) }),
    loadContext(),
  ]);
  let sent = 0;
  for (const d of devices) {
    const { theme } = resolveFor(d, ctx);
    const wanted = theme ? specOf(theme, d.type, ctx.fonts) : null;
    const current = (d.desired as { theme?: { id?: string; version?: number } | null } | undefined)?.theme ?? null;
    if ((wanted?.id ?? null) === (current?.id ?? null) && (wanted?.version ?? null) === (current?.version ?? null)) continue;
    await enqueueCommand(d.deviceId, "theme.set", { theme: wanted });
    sent++;
  }
  return sent;
}

/** A change that touches themes: tell the devices, never fail the caller (the change is saved). */
export async function notifyThemesChanged(deviceIds?: string[]): Promise<void> {
  try {
    await pushThemes(deviceIds);
  } catch (err) {
    console.error("theme push failed", err instanceof Error ? err.message : err);
  }
}

export async function createTheme(input: z.infer<typeof themeInput>, actor: Actor) {
  await assertFontsExist(input);
  const theme = await ThemeModel.create({ themeId: ulid(), ...input, createdByName: actor.name });
  await recordAudit(actor, "theme.create", { type: "theme", id: theme.themeId }, { name: theme.name });
  return theme;
}

export async function updateTheme(themeId: string, input: z.infer<typeof themeInput>, actor: Actor) {
  await assertFontsExist(input);
  const theme = await ThemeModel.findOneAndUpdate({ themeId }, { $set: input, $inc: { version: 1 } }, { new: true });
  if (!theme) throw new HttpError(404, "Theme not found");
  await recordAudit(actor, "theme.update", { type: "theme", id: themeId }, { name: theme.name, version: theme.version });
  await notifyThemesChanged();
  return theme;
}

/**
 * Creates a theme from a .zip bundle (see `lib/themeBundle.ts`) and puts its fonts in the library, so a theme and
 * everything it needs arrive in one upload. Everything is checked before anything is stored: a bundle with a bad
 * colour, bad CSS or a file that is not a font changes nothing. With `replace`, a theme of the same name becomes a
 * new version of itself (the way to ship a fix); without it a taken name is refused.
 */
export async function importThemeBundle(zip: Buffer, actor: Actor, replace: boolean) {
  const bundle = readThemeBundle(zip);
  for (const font of bundle.fonts) if (!sniffFont(font.data)) throw new HttpError(415, `${font.name} is not a WOFF2, WOFF, TTF or OTF font`);

  const { name, description, tokens, css, emergency } = bundle.theme;
  const draft = { name, description, tokens, emergency, css: typeof css === "string" ? css : (bundle.css ?? "") };
  // The fonts do not have ids yet: a placeholder lets the same schema judge everything else first.
  const placeholders = Object.fromEntries(bundle.fonts.map((f) => [f.slot, "pending"]));
  themeInput.parse({ ...draft, fonts: placeholders });

  const stored = [];
  for (const font of bundle.fonts) stored.push({ ...font, ...(await ensureFontAsset(font.data, font.name, actor)) });
  const input = themeInput.parse({ ...draft, fonts: Object.fromEntries(stored.map((f) => [f.slot, f.asset.assetId])) });

  const existing = replace ? await ThemeModel.findOne({ name: input.name }) : null;
  const theme = existing ? await updateTheme(existing.themeId, input, actor) : await createTheme(input, actor);
  return { theme, created: !existing, fonts: stored.map((f) => ({ slot: f.slot, name: f.asset.name, reused: f.reused })) };
}

/** A theme that is assigned cannot go: the screens that wear it would change under whoever deleted it. */
export async function deleteTheme(themeId: string, actor: Actor) {
  const used = await ThemeAssignmentModel.find({ themeId });
  if (used.length) throw new HttpError(409, `This theme is used by ${used.map((a) => (a.scope === "default" ? `all ${a.key}s` : `${a.scope} ${a.key}`)).join(", ")}. Take it off first.`);
  const theme = await ThemeModel.findOneAndDelete({ themeId });
  if (!theme) throw new HttpError(404, "Theme not found");
  await recordAudit(actor, "theme.delete", { type: "theme", id: themeId }, { name: theme.name });
}

/** Where a device ends up after an assignment changes: one device, the devices of a group, or every device of a kind. */
async function affected(scope: string, key: string): Promise<string[] | undefined> {
  if (scope === "device") return [key];
  if (scope === "group") return (await DeviceModel.find({ groups: key }, { deviceId: 1 })).map((d) => d.deviceId);
  return undefined;
}

export async function setAssignment(input: z.infer<typeof assignmentInput>, actor: Actor) {
  const { scope, key, themeId } = input;
  if (scope === "default" && !(THEMED_TYPES as readonly string[]).includes(key)) throw new HttpError(400, `A default is set for "door" or "display"`);
  if (scope === "device" && !(await DeviceModel.exists({ deviceId: key, type: { $in: THEMED_TYPES }, status: "active" }))) throw new HttpError(404, "Door unit or Faculty screen not found");
  if (themeId && !(await ThemeModel.exists({ themeId }))) throw new HttpError(400, "Unknown theme");
  if (themeId) await ThemeAssignmentModel.updateOne({ scope, key }, { $set: { themeId } }, { upsert: true });
  else await ThemeAssignmentModel.deleteOne({ scope, key });
  await recordAudit(actor, "theme.assign", { type: "theme", id: themeId ?? "none" }, { scope, key });
  await notifyThemesChanged(await affected(scope, key));
}

export const themeDto = (t: ThemeDoc) => ({
  id: t.themeId,
  name: t.name,
  description: t.description ?? "",
  tokens: t.tokens ?? {},
  fonts: fontIdsOf(t),
  emergency: t.emergency ?? {},
  css: t.css ?? "",
  version: t.version,
  createdBy: t.createdByName,
  updatedAt: t.updatedAt,
});

export async function resolveForDevice(deviceId: string) {
  const device = await DeviceModel.findOne({ deviceId, type: { $in: THEMED_TYPES }, status: "active" });
  if (!device) throw new HttpError(404, "Door unit or Faculty screen not found");
  const resolved = resolveFor(device, await loadContext());
  return { theme: resolved.theme ? themeDto(resolved.theme) : null, from: resolved.from, via: resolved.via ?? null };
}
