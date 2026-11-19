import {
  CONTENT_FIT,
  CONTENT_KINDS,
  CONTENT_LIMITS,
  facultyConfig,
  ulid,
  type ContentItem,
  type PayloadOf,
} from "@smartcampus/protocol";
import { z } from "zod";
import { HttpError } from "../lib/errors.js";
import { recordAudit } from "../lib/audit.js";
import { AssetModel } from "../models/asset.js";
import { ContentModel } from "../models/content.js";
import { DeviceModel } from "../models/device.js";
import type { PublicUser } from "../models/user.js";
import { assetRefOf } from "./assets.js";
import { enqueueCommand } from "./commands.js";
import { resolveTargetDevices, targetsInput, type Targets } from "./targeting.js";

type Actor = Pick<PublicUser, "id" | "name">;

/** A playlist is rebuilt on every change and on every connection; this is only how long an unread one is kept. */
const PLAYLIST_TTL_SECONDS = 86_400;

export const contentInput = z
  .object({
    kind: z.enum(CONTENT_KINDS),
    title: z.string().trim().max(CONTENT_LIMITS.title).default(""),
    text: z.string().trim().min(1).max(CONTENT_LIMITS.text).optional(),
    url: z.string().trim().url().max(CONTENT_LIMITS.url).optional(),
    refreshSeconds: z.number().int().min(10).max(86_400).optional(),
    assetId: z.string().min(1).max(64).optional(),
    durationSeconds: z.number().int().min(CONTENT_LIMITS.durationMin).max(CONTENT_LIMITS.durationMax).default(15),
    fit: z.enum(CONTENT_FIT).default("contain"),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().optional(),
    targets: targetsInput,
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((c, ctx) => {
    const need = (ok: boolean, path: string, message: string) => ok || ctx.addIssue({ code: "custom", path: [path], message });
    if (c.kind === "image" || c.kind === "video") need(Boolean(c.assetId), "assetId", `a ${c.kind} needs a file from the library`);
    if (c.kind === "text") need(Boolean(c.text), "text", "a text slide needs a text");
    if (c.kind === "web") need(/^https?:\/\//i.test(c.url ?? ""), "url", "a web slide needs an http(s) address");
    if (c.startsAt && c.endsAt) need(c.endsAt > c.startsAt, "endsAt", "endsAt must be after startsAt");
  });
export type ContentInput = z.infer<typeof contentInput>;

/** Keeps only what applies to the kind, so a text slide never carries a stale file and the other way round. */
async function fieldsOf(input: ContentInput) {
  if (input.endsAt && input.endsAt.getTime() <= Date.now()) throw new HttpError(400, "endsAt must be in the future");
  if (input.kind === "image" || input.kind === "video") {
    const asset = await AssetModel.findOne({ assetId: input.assetId });
    if (!asset) throw new HttpError(400, "Unknown file");
    if (asset.kind !== input.kind) throw new HttpError(400, `That file is not ${input.kind === "image" ? "an image" : "a video"}`);
  }
  const media = input.kind === "image" || input.kind === "video";
  return {
    kind: input.kind,
    title: input.title,
    durationSeconds: input.durationSeconds,
    fit: input.fit,
    targets: input.targets,
    enabled: input.enabled,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    assetId: media ? input.assetId : null,
    text: input.kind === "text" ? input.text : null,
    url: input.kind === "web" ? input.url : null,
    refreshSeconds: input.kind === "web" ? (input.refreshSeconds ?? null) : null,
  };
}

export async function createContent(input: ContentInput, actor: Actor) {
  const content = await ContentModel.create({ contentId: ulid(), ...(await fieldsOf(input)), createdByName: actor.name });
  await recordAudit(actor, "content.create", { type: "content", id: content.contentId }, { kind: content.kind, title: content.title });
  await notifyContentChanged();
  return content;
}

export async function updateContent(contentId: string, input: ContentInput, actor: Actor) {
  const content = await ContentModel.findOneAndUpdate({ contentId }, { $set: await fieldsOf(input) }, { new: true });
  if (!content) throw new HttpError(404, "Content not found");
  await recordAudit(actor, "content.update", { type: "content", id: contentId }, { enabled: content.enabled });
  await notifyContentChanged();
  return content;
}

export async function deleteContent(contentId: string, actor: Actor) {
  const content = await ContentModel.findOneAndDelete({ contentId });
  if (!content) throw new HttpError(404, "Content not found");
  await recordAudit(actor, "content.delete", { type: "content", id: contentId }, { title: content.title });
  await notifyContentChanged();
}

/** Is the file used by a slide or by a screen's logo? Deleting it would leave screens with a missing file. */
export async function isAssetInUse(assetId: string): Promise<boolean> {
  return Boolean((await ContentModel.exists({ assetId })) || (await DeviceModel.exists({ "desired.facultyConfig.site.logo.assetId": assetId })));
}

type Slide = PayloadOf<"content.set">["items"][number];

function toSlide(c: InstanceType<typeof ContentModel>, assets: Map<string, InstanceType<typeof AssetModel>>): Slide | null {
  const base = {
    id: c.contentId,
    kind: c.kind,
    title: c.title,
    durationSeconds: c.durationSeconds,
    fit: c.fit,
    ...(c.startsAt && { startsAt: c.startsAt.getTime() }),
    ...(c.endsAt && { endsAt: c.endsAt.getTime() }),
  };
  if (c.kind === "image" || c.kind === "video") {
    const asset = c.assetId ? assets.get(c.assetId) : undefined;
    return asset ? ({ ...base, asset: assetRefOf(asset) } as ContentItem) : null;
  }
  if (c.kind === "text") return c.text ? ({ ...base, text: c.text } as ContentItem) : null;
  return c.url ? ({ ...base, url: c.url, ...(c.refreshSeconds && { refreshSeconds: c.refreshSeconds }) } as ContentItem) : null;
}

const modeOf = (desired: unknown) => {
  const parsed = facultyConfig.safeParse((desired as { facultyConfig?: unknown } | undefined)?.facultyConfig ?? {});
  return parsed.success ? parsed.data.mode : "default";
};

/**
 * Sends each Faculty screen its playlist: the enabled slides that are not over and that target it. A screen
 * set to show only the information board gets an empty one, so it downloads nothing and a switch back clears it.
 */
export async function pushContent(deviceIds?: string[]): Promise<number> {
  const displays = (await DeviceModel.find({ type: "display", status: "active" }, { deviceId: 1, desired: 1 })).filter(
    (d) => !deviceIds || deviceIds.includes(d.deviceId),
  );
  if (displays.length === 0) return 0;

  const now = new Date();
  const slides = await ContentModel.find({ enabled: true, $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gt: now } }] }).sort({ createdAt: 1 });
  const assets = new Map((await AssetModel.find({ assetId: { $in: slides.map((s) => s.assetId).filter(Boolean) as string[] } })).map((a) => [a.assetId, a]));
  const reach = new Map<string, Set<string>>();
  for (const slide of slides) reach.set(slide.contentId, new Set(await resolveTargetDevices(slide.targets as Targets)));

  for (const d of displays) {
    const items =
      modeOf(d.desired) === "default"
        ? []
        : slides
            .filter((s) => reach.get(s.contentId)?.has(d.deviceId))
            .map((s) => toSlide(s, assets))
            .filter((s): s is Slide => s !== null)
            .slice(0, CONTENT_LIMITS.items);
    await enqueueCommand(d.deviceId, "content.set", { items, updatedAt: now.getTime() }, PLAYLIST_TTL_SECONDS);
  }
  return displays.length;
}

/** Content changed: tell the screens, never fail the caller (the change is already saved). */
export async function notifyContentChanged(): Promise<void> {
  try {
    await pushContent();
  } catch (err) {
    console.error("content push failed", err instanceof Error ? err.message : err);
  }
}

/** How many Faculty screens a slide reaches, for the console. */
export async function displaysReachedBy(targets: Targets): Promise<number> {
  const ids = await resolveTargetDevices(targets);
  return DeviceModel.countDocuments({ deviceId: { $in: ids }, type: "display" });
}
