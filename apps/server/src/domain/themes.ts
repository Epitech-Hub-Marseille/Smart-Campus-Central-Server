import { themeInput, themeTokens, type ThemeSpec } from "@smartcampus/protocol";
import { z } from "zod";
import { recordAudit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { ulid } from "@smartcampus/protocol";
import { DeviceModel } from "../models/device.js";
import { ThemeAssignmentModel, ThemeModel } from "../models/theme.js";
import type { PublicUser } from "../models/user.js";
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

const specOf = (theme: ThemeDoc, deviceType: string): ThemeSpec => ({
  id: theme.themeId,
  name: theme.name,
  version: theme.version,
  tokens: themeTokens.parse(theme.tokens ?? {}),
  // CSS is for the web-based Faculty screens; a door unit would only carry bytes it cannot use.
  ...(deviceType === "display" && theme.css && { css: theme.css }),
});

interface Context {
  assignments: Map<string, string>;
  themes: Map<string, ThemeDoc>;
}

async function loadContext(): Promise<Context> {
  const [assignments, themes] = await Promise.all([ThemeAssignmentModel.find(), ThemeModel.find()]);
  return { assignments: new Map(assignments.map((a) => [`${a.scope}:${a.key}`, a.themeId])), themes: new Map(themes.map((t) => [t.themeId, t])) };
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
    const wanted = theme ? specOf(theme, d.type) : null;
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
  const theme = await ThemeModel.create({ themeId: ulid(), ...input, createdByName: actor.name });
  await recordAudit(actor, "theme.create", { type: "theme", id: theme.themeId }, { name: theme.name });
  return theme;
}

export async function updateTheme(themeId: string, input: z.infer<typeof themeInput>, actor: Actor) {
  const theme = await ThemeModel.findOneAndUpdate({ themeId }, { $set: input, $inc: { version: 1 } }, { new: true });
  if (!theme) throw new HttpError(404, "Theme not found");
  await recordAudit(actor, "theme.update", { type: "theme", id: themeId }, { name: theme.name, version: theme.version });
  await notifyThemesChanged();
  return theme;
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
