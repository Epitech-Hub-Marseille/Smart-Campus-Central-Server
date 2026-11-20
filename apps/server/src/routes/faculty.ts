import { AVAILABILITIES, FACULTY_LIMITS, ANNOUNCE_PRIORITIES, SCENE_LAYOUTS, SERVICES, TILE_KINDS, TILE_LIMITS, facultyConfig, facultyConfigPatch, mergeConfigPatches, ulid } from "@smartcampus/protocol";
import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { currentEventsFor, type CurrentEvent } from "../domain/eventAvailability.js";
import { applyScreenChange, buildFacultyContent, effectiveAvailability, notifyFacultyChanged } from "../domain/faculty.js";
import {
  BUILTIN_SCENES,
  DEFAULT_SCOPE,
  clearScopeConfig,
  clearScopePlaylist,
  createGroup,
  deleteGroup,
  describeScope,
  effectivePlaylist,
  groupInput,
  layersOf,
  loadContext,
  mergedPatch,
  setScopeConfig,
  setScopePlaylist,
  updateGroup,
  type ScopeRef,
} from "../domain/screens.js";
import { SCREEN_SCOPES } from "../models/screenLayer.js";
import { recordAudit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { objectId } from "../lib/http.js";
import { DeviceModel } from "../models/device.js";
import { NewsModel, newsDto } from "../models/news.js";
import { UserModel, type UserDoc } from "../models/user.js";
import { registry } from "../gateway/registry.js";

/** Faculty screens: news feed, staff availability and how each screen looks. */
export const facultyRouter = Router();
facultyRouter.use(requireAuth);

const canWrite = requireRole("admin", "operator");

// ---- News -------------------------------------------------------------------------------

const newsInput = z.object({
  title: z.string().trim().min(1).max(120),
  // The screen shows at most this much, so the form refuses more instead of cutting it silently.
  text: z.string().trim().max(400).default(""),
  priority: z.enum(ANNOUNCE_PRIORITIES).default("info"),
  publishedAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
});

facultyRouter.get("/news", async (_req, res) => {
  const items = await NewsModel.find().sort({ publishedAt: -1 }).limit(100);
  res.json({ items: items.map(newsDto), screenLimit: FACULTY_LIMITS.news });
});

facultyRouter.post("/news", canWrite, async (req, res) => {
  const input = newsInput.parse(req.body);
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) throw new HttpError(400, "expiresAt must be in the future");
  const news = await NewsModel.create({
    newsId: ulid(),
    title: input.title,
    text: input.text,
    priority: input.priority,
    ...(input.publishedAt && { publishedAt: input.publishedAt }),
    ...(input.expiresAt && { expiresAt: input.expiresAt }),
    createdByName: req.user!.name,
  });
  await recordAudit(req.user!, "faculty.news.create", { type: "news", id: news.newsId }, { priority: news.priority });
  await notifyFacultyChanged();
  res.status(201).json(newsDto(news));
});

facultyRouter.put("/news/:id", canWrite, async (req, res) => {
  const input = newsInput.parse(req.body);
  const set: Record<string, unknown> = { title: input.title, text: input.text, priority: input.priority };
  if (input.publishedAt) set.publishedAt = input.publishedAt;
  if (input.expiresAt) set.expiresAt = input.expiresAt;
  // null removes the expiry, undefined leaves it alone.
  const news = await NewsModel.findOneAndUpdate(
    { newsId: String(req.params.id) },
    { $set: set, ...(input.expiresAt === null && { $unset: { expiresAt: 1 } }) },
    { new: true },
  );
  if (!news) throw new HttpError(404, "News not found");
  await recordAudit(req.user!, "faculty.news.update", { type: "news", id: news.newsId });
  await notifyFacultyChanged();
  res.json(newsDto(news));
});

facultyRouter.delete("/news/:id", canWrite, async (req, res) => {
  const news = await NewsModel.findOneAndDelete({ newsId: String(req.params.id) });
  if (!news) throw new HttpError(404, "News not found");
  await recordAudit(req.user!, "faculty.news.delete", { type: "news", id: news.newsId });
  await notifyFacultyChanged();
  res.status(204).end();
});

// ---- Staff availability -------------------------------------------------------------------

const staffDto = (u: UserDoc, event?: CurrentEvent) => {
  const effective = effectiveAvailability(u, new Date(), event);
  return {
    id: u.id,
    name: u.name,
    jobTitle: u.jobTitle ?? "",
    service: u.service ?? null,
    availability: effective.availability,
    note: effective.note ?? "",
    until: effective.until ? new Date(effective.until) : null,
    updatedAt: u.availability?.updatedAt ?? null,
  };
};

facultyRouter.get("/staff", async (req, res) => {
  const { service } = z.object({ service: z.enum(SERVICES).optional() }).parse(req.query);
  const users = await UserModel.find({ disabled: false, service: service ?? { $in: [...SERVICES] } }).sort({ name: 1 }).limit(500);
  const events = await currentEventsFor(users.map((u) => u.id));
  res.json({ items: users.map((u) => staffDto(u, events.get(u.id))), screenLimit: FACULTY_LIMITS.staff });
});

const availabilityInput = z.object({
  status: z.enum(AVAILABILITIES),
  note: z.string().trim().max(60).default(""),
  // When it stops applying. Without it, the status stays until changed.
  until: z.coerce.date().nullable().optional(),
});

async function setAvailability(user: UserDoc, input: z.infer<typeof availabilityInput>) {
  if (!user.service) throw new HttpError(409, "This person is not listed on the Faculty screens. Ask an administrator to assign a service.");
  if (input.until && input.until.getTime() <= Date.now()) throw new HttpError(400, "until must be in the future");
  // "Available" needs no note: keeping it would show stale text on the screens. Said while in an event of a portal, it is the
  // person overriding the automatic "busy", and lasts until the event ends.
  const available = input.status === "available";
  const event = available ? (await currentEventsFor([user.id])).get(user.id) : undefined;
  user.set("availability", {
    status: input.status,
    note: available ? "" : input.note,
    ...(!available && input.until && { until: input.until }),
    ...(event && { until: event.end }),
    updatedAt: new Date(),
  });
  await user.save();
  await notifyFacultyChanged();
  return staffDto(user);
}

/** Everyone signed in updates their own availability. */
facultyRouter.put("/availability/me", async (req, res) => {
  const user = await UserModel.findById(req.user!.id);
  if (!user) throw new HttpError(404, "User not found");
  res.json(await setAvailability(user, availabilityInput.parse(req.body)));
});

facultyRouter.get("/availability/me", async (req, res) => {
  const user = await UserModel.findById(req.user!.id);
  if (!user) throw new HttpError(404, "User not found");
  res.json({ listed: Boolean(user.service), ...(user.service && staffDto(user, (await currentEventsFor([user.id])).get(user.id))) });
});

/** An admin or operator can set it for someone (a visitor at the desk, someone who forgot). */
facultyRouter.put("/availability/:userId", canWrite, async (req, res) => {
  const user = await UserModel.findById(objectId(req.params.userId));
  if (!user) throw new HttpError(404, "User not found");
  const result = await setAvailability(user, availabilityInput.parse(req.body));
  await recordAudit(req.user!, "faculty.availability.set", { type: "user", id: user.id }, { status: result.availability });
  res.json(result);
});

// ---- Screens, groups and what they show ------------------------------------------------------

/** What the console needs to draw the carousel editor: the layouts and the kinds of tile, as data. */
facultyRouter.get("/tile-kinds", canWrite, (_req, res) => {
  res.json({ kinds: TILE_KINDS, layouts: SCENE_LAYOUTS, limits: TILE_LIMITS, defaults: facultyConfig.parse({}) });
});

/** The screens, the groups they are in and whether each level has its own settings or playlist. */
facultyRouter.get("/screens", canWrite, async (_req, res) => {
  const [displays, ctx] = await Promise.all([DeviceModel.find({ type: "display", status: "active" }).sort({ name: 1 }), loadContext()]);
  const has = (scope: string, key: string) => {
    const layer = ctx.layers.get(`${scope}:${key}`);
    return { config: Object.keys(layer?.config ?? {}).length > 0, playlist: Boolean(layer?.scenes) };
  };
  res.json({
    default: has("default", "-"),
    groups: ctx.groups.map((g) => ({ ...g, ...{ own: has("group", g.id) } })),
    displays: displays.map((d) => {
      const group = ctx.groups.find((g) => g.members.includes(d.deviceId));
      return { id: d.deviceId, name: d.name || d.deviceId, online: registry.isOnline(d.deviceId), groupId: group?.id ?? null, own: has("device", d.deviceId) };
    }),
  });
});

facultyRouter.post("/groups", canWrite, async (req, res) => {
  const { group, affected } = await createGroup(groupInput.parse(req.body), req.user!);
  await applyScreenChange(affected);
  res.status(201).json({ id: group.groupId, name: group.name, description: group.description, members: group.members });
});

facultyRouter.put("/groups/:id", canWrite, async (req, res) => {
  const { group, affected } = await updateGroup(String(req.params.id), groupInput.parse(req.body), req.user!);
  await applyScreenChange(affected);
  res.json({ id: group.groupId, name: group.name, description: group.description, members: group.members });
});

facultyRouter.delete("/groups/:id", canWrite, async (req, res) => {
  const members = await deleteGroup(String(req.params.id), req.user!);
  await applyScreenChange(members);
  res.status(204).end();
});

const scopeOf = (req: { params: Record<string, string | string[] | undefined> }): ScopeRef => {
  const scope = z.enum(SCREEN_SCOPES).parse(req.params.scope);
  const key = z.string().min(1).max(64).parse(req.params.key);
  return scope === "default" ? DEFAULT_SCOPE : { scope, key };
};

/**
 * One level of the hierarchy, with what it inherits from the levels above, so the console can show a field as
 * "inherited" or "set here". The key of the default level is "-".
 */
facultyRouter.get("/scopes/:scope/:key", canWrite, async (req, res) => {
  const ref = scopeOf(req);
  const where = await describeScope(ref);
  const ctx = await loadContext();
  const own = ctx.layers.get(`${ref.scope}:${ref.key}`) ?? { config: {}, scenes: null };

  // The levels above this one: for a group, the default; for a screen, its group (if any) then the default.
  const device = ref.scope === "device" ? layersOf(ctx, ref.key) : null;
  const above =
    ref.scope === "default"
      ? { config: [] as Record<string, unknown>[], scenes: [] as { from: "group" | "default"; scenes: unknown }[] }
      : ref.scope === "group"
        ? { config: [ctx.layers.get("default:-")?.config ?? {}], scenes: [{ from: "default" as const, scenes: ctx.layers.get("default:-")?.scenes ?? null }] }
        : { config: [device!.default.config, device!.group?.config ?? {}], scenes: [{ from: "group" as const, scenes: device!.group?.scenes ?? null }, { from: "default" as const, scenes: device!.default.scenes }] };
  const inheritedScenes = above.scenes.find((s) => s.scenes);

  res.json({
    scope: ref.scope,
    key: ref.key,
    name: where.name,
    screens: where.deviceIds === "all" ? null : where.deviceIds.length,
    group: device?.group ? { id: device.group.id, name: device.group.name } : null,
    config: own.config,
    scenes: own.scenes,
    inherited: {
      config: mergeConfigPatches(above.config),
      scenes: inheritedScenes ? { from: inheritedScenes.from, items: inheritedScenes.scenes } : { from: "builtin", items: BUILTIN_SCENES },
    },
    // What this level's screens would show, for the preview.
    effective: ref.scope === "device" ? { config: mergedPatch(device!), playlist: effectivePlaylist(device!) } : null,
  });
});

facultyRouter.put("/scopes/:scope/:key/config", canWrite, async (req, res) => {
  const ref = scopeOf(req);
  const affected = await setScopeConfig(ref, facultyConfigPatch.parse(req.body), req.user!);
  await applyScreenChange(affected);
  res.status(204).end();
});

facultyRouter.delete("/scopes/:scope/:key/config", canWrite, async (req, res) => {
  await applyScreenChange(await clearScopeConfig(scopeOf(req), req.user!));
  res.status(204).end();
});

facultyRouter.put("/scopes/:scope/:key/playlist", canWrite, async (req, res) => {
  await applyScreenChange(await setScopePlaylist(scopeOf(req), req.body, req.user!));
  res.status(204).end();
});

facultyRouter.delete("/scopes/:scope/:key/playlist", canWrite, async (req, res) => {
  await applyScreenChange(await clearScopePlaylist(scopeOf(req), req.user!));
  res.status(204).end();
});

/** What a screen with this service filter would show now (console preview). */
facultyRouter.get("/preview", canWrite, async (req, res) => {
  const { service } = z.object({ service: z.enum(["all", ...SERVICES]).default("all") }).parse(req.query);
  res.json(await buildFacultyContent(service));
});
