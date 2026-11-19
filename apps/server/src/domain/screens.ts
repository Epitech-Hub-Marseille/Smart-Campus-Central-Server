import {
  TILE_LIMITS,
  facultyConfig,
  facultyConfigPatch,
  mergeConfigPatches,
  sceneInput,
  ulid,
  type FacultyConfig,
  type FacultyConfigPatch,
  type PayloadOf,
  type SceneInput,
} from "@smartcampus/protocol";
import { z } from "zod";
import { recordAudit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { AssetModel } from "../models/asset.js";
import { DeviceModel } from "../models/device.js";
import { ScreenGroupModel } from "../models/screenGroup.js";
import { ScreenLayerModel, type ScreenScope } from "../models/screenLayer.js";
import type { PublicUser } from "../models/user.js";
import { assetRefOf } from "./assets.js";
import { enqueueCommand } from "./commands.js";

type Actor = Pick<PublicUser, "id" | "name">;

/** A carousel is rebuilt on every change and every connection; this is only how long an unread one is kept. */
const CAROUSEL_TTL_SECONDS = 86_400;

export interface ScopeRef {
  scope: ScreenScope;
  key: string;
}
export const DEFAULT_SCOPE: ScopeRef = { scope: "default", key: "-" };

/**
 * What a screen shows when nobody has made a playlist: the information board, one page after the other. It is
 * code, not data, so a fresh install works and "reset to default" always has somewhere to go back to.
 */
export const BUILTIN_SCENES: SceneInput[] = (["news", "staff", "reservations"] as const).map((kind) => ({
  id: `builtin-${kind}`,
  name: kind === "news" ? "News" : kind === "staff" ? "Staff" : "Reservations",
  layout: "full",
  durationSeconds: 15,
  enabled: true,
  tiles: [{ id: `builtin-${kind}-tile`, kind, settings: {} }],
}));

// ---- Reading the layers -------------------------------------------------------------------

export interface Layers {
  default: { config: FacultyConfigPatch; scenes: SceneInput[] | null };
  group: { id: string; name: string; config: FacultyConfigPatch; scenes: SceneInput[] | null } | null;
  device: { config: FacultyConfigPatch; scenes: SceneInput[] | null };
}

/** Everything needed to resolve any number of screens with a fixed number of queries. */
export interface ScreenContext {
  layers: Map<string, { config: FacultyConfigPatch; scenes: SceneInput[] | null }>;
  groups: { id: string; name: string; description: string; members: string[] }[];
}

const layerKey = (scope: ScreenScope, key: string) => `${scope}:${key}`;

export async function loadContext(): Promise<ScreenContext> {
  const [layers, groups] = await Promise.all([ScreenLayerModel.find(), ScreenGroupModel.find().sort({ name: 1 })]);
  return {
    layers: new Map(layers.map((l) => [layerKey(l.scope, l.key), { config: (l.config ?? {}) as FacultyConfigPatch, scenes: (l.scenes ?? null) as SceneInput[] | null }])),
    groups: groups.map((g) => ({ id: g.groupId, name: g.name, description: g.description ?? "", members: g.members })),
  };
}

const EMPTY = { config: {}, scenes: null } as const;

export function layersOf(ctx: ScreenContext, deviceId: string): Layers {
  const group = ctx.groups.find((g) => g.members.includes(deviceId));
  return {
    default: ctx.layers.get(layerKey("default", "-")) ?? EMPTY,
    group: group ? { id: group.id, name: group.name, ...(ctx.layers.get(layerKey("group", group.id)) ?? EMPTY) } : null,
    device: ctx.layers.get(layerKey("device", deviceId)) ?? EMPTY,
  };
}

export type PlaylistSource = "device" | "group" | "default" | "builtin";

/** The playlist that applies, and the level it comes from: the most specific level that has one. */
export function effectivePlaylist(layers: Layers): { scenes: SceneInput[]; from: PlaylistSource } {
  if (layers.device.scenes) return { scenes: layers.device.scenes, from: "device" };
  if (layers.group?.scenes) return { scenes: layers.group.scenes, from: "group" };
  if (layers.default.scenes) return { scenes: layers.default.scenes, from: "default" };
  return { scenes: BUILTIN_SCENES, from: "builtin" };
}

export const mergedPatch = (layers: Layers): FacultyConfigPatch =>
  mergeConfigPatches([layers.default.config, layers.group?.config, layers.device.config]) as FacultyConfigPatch;

// ---- Turning layers into what a screen receives ------------------------------------------------

type AssetDoc = InstanceType<typeof AssetModel>;

const assetIdsOf = (scenes: SceneInput[]) =>
  scenes.flatMap((s) => s.tiles.map((t) => (t.settings.asset as { assetId?: string } | undefined)?.assetId)).filter((id): id is string => Boolean(id));

async function assetMap(ids: string[]): Promise<Map<string, AssetDoc>> {
  if (ids.length === 0) return new Map();
  return new Map((await AssetModel.find({ assetId: { $in: [...new Set(ids)] } })).map((a) => [a.assetId, a]));
}

/** The config a screen is sent: layers merged, defaults filled in, and the logo as a full reference. */
export function toFacultyConfig(patch: FacultyConfigPatch, assets: Map<string, AssetDoc>): FacultyConfig {
  const { site, ...rest } = patch;
  const logoAsset = site?.logo ? assets.get(site.logo.assetId) : undefined;
  return facultyConfig.parse({ ...rest, site: { ...site, logo: logoAsset ? assetRefOf(logoAsset) : null } });
}

type WireScenes = PayloadOf<"carousel.set">["scenes"];

/**
 * The scenes a screen is sent: the enabled ones that are not over, with every library file replaced by its
 * full reference taken from the stored record. A scene whose file is gone is left out rather than sent broken.
 */
export function toWireScenes(scenes: SceneInput[], assets: Map<string, AssetDoc>, now = new Date()): WireScenes {
  const out: WireScenes = [];
  let tiles = 0;
  for (const scene of scenes) {
    if (!scene.enabled) continue;
    if (scene.endsAt !== undefined && scene.endsAt <= now.getTime()) continue;
    let complete = true;
    const wireTiles = scene.tiles.map((tile) => {
      const pointer = tile.settings.asset as { assetId: string } | undefined;
      if (!pointer) return tile;
      const asset = assets.get(pointer.assetId);
      if (!asset || asset.kind !== tile.kind) complete = false;
      return { ...tile, settings: { ...tile.settings, asset: asset ? assetRefOf(asset) : pointer } };
    });
    if (!complete) continue;
    // The frame has room for this many; the editor refuses more, this is the safety net for stored data.
    if (out.length >= TILE_LIMITS.scenes || tiles + wireTiles.length > TILE_LIMITS.tiles) break;
    tiles += wireTiles.length;
    const { enabled: _enabled, ...wire } = scene;
    out.push({ ...wire, tiles: wireTiles } as WireScenes[number]);
  }
  return out;
}

export interface ResolvedScreen {
  deviceId: string;
  config: FacultyConfig;
  scenes: WireScenes;
  playlistFrom: PlaylistSource;
}

/** Resolves the given displays (all active ones when none is named). */
export async function resolveScreens(deviceIds?: string[], now = new Date()): Promise<ResolvedScreen[]> {
  const displays = (await DeviceModel.find({ type: "display", status: "active", ...(deviceIds && { deviceId: { $in: deviceIds } }) }, { deviceId: 1 })).map((d) => d.deviceId);
  if (displays.length === 0) return [];
  const ctx = await loadContext();
  const resolved = displays.map((deviceId) => {
    const layers = layersOf(ctx, deviceId);
    return { deviceId, layers, playlist: effectivePlaylist(layers), patch: mergedPatch(layers) };
  });
  const logoIds = resolved.map((r) => r.patch.site?.logo?.assetId).filter((id): id is string => Boolean(id));
  const assets = await assetMap([...logoIds, ...resolved.flatMap((r) => assetIdsOf(r.playlist.scenes))]);
  return resolved.map((r) => ({
    deviceId: r.deviceId,
    config: toFacultyConfig(r.patch, assets),
    scenes: toWireScenes(r.playlist.scenes, assets, now),
    playlistFrom: r.playlist.from,
  }));
}

/** Sends each Faculty screen its look (settings of all levels merged). */
export async function pushScreenConfig(deviceIds?: string[]): Promise<number> {
  const screens = await resolveScreens(deviceIds);
  for (const s of screens) await enqueueCommand(s.deviceId, "faculty.config.set", { config: s.config });
  return screens.length;
}

/**
 * Sends each Faculty screen its carousel. A screen set to a playlist that is empty gets an empty one, so it
 * downloads nothing and a later playlist replaces it cleanly.
 */
export async function pushCarousel(deviceIds?: string[]): Promise<number> {
  const now = new Date();
  const screens = await resolveScreens(deviceIds, now);
  for (const s of screens) await enqueueCommand(s.deviceId, "carousel.set", { scenes: s.scenes, updatedAt: now.getTime() }, CAROUSEL_TTL_SECONDS);
  return screens.length;
}

// ---- Editing ---------------------------------------------------------------------------------

export const playlistInput = z
  .object({ scenes: z.array(sceneInput).max(TILE_LIMITS.scenes) })
  .strict()
  .superRefine((p, ctx) => {
    const tiles = p.scenes.reduce((n, s) => n + s.tiles.length, 0);
    if (tiles > TILE_LIMITS.tiles) ctx.addIssue({ code: "custom", path: ["scenes"], message: `at most ${TILE_LIMITS.tiles} tiles in a playlist (it has ${tiles})` });
    const ids = new Set<string>();
    for (const [i, s] of p.scenes.entries()) {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", path: ["scenes", i, "id"], message: "scene ids must be unique" });
      ids.add(s.id);
    }
  });

/** Where a scope lives, and what to tell people it is called. Throws 404 when the group or screen does not exist. */
export async function describeScope(ref: ScopeRef): Promise<{ name: string; deviceIds: string[] | "all" }> {
  if (ref.scope === "default") return { name: "All screens", deviceIds: "all" };
  if (ref.scope === "group") {
    const group = await ScreenGroupModel.findOne({ groupId: ref.key });
    if (!group) throw new HttpError(404, "Group not found");
    return { name: group.name, deviceIds: group.members };
  }
  const device = await DeviceModel.findOne({ deviceId: ref.key, type: "display", status: "active" }, { name: 1 });
  if (!device) throw new HttpError(404, "Faculty screen not found");
  return { name: device.name || ref.key, deviceIds: [ref.key] };
}

const reach = (d: { deviceIds: string[] | "all" }) => (d.deviceIds === "all" ? undefined : d.deviceIds);

async function checkAssets(ids: string[], expect: Map<string, "image" | "video">) {
  const found = await assetMap(ids);
  for (const id of ids) {
    const asset = found.get(id);
    if (!asset) throw new HttpError(400, "A file of the selection is not in the library any more");
    const want = expect.get(id);
    if (want && asset.kind !== want) throw new HttpError(400, `"${asset.name}" is not ${want === "image" ? "an image" : "a video"}`);
  }
}

export async function setScopeConfig(ref: ScopeRef, patch: FacultyConfigPatch, actor: Actor): Promise<string[] | undefined> {
  const where = await describeScope(ref);
  const parsed = facultyConfigPatch.parse(patch);
  if (parsed.site?.logo) await checkAssets([parsed.site.logo.assetId], new Map([[parsed.site.logo.assetId, "image"]]));
  await ScreenLayerModel.updateOne({ scope: ref.scope, key: ref.key }, { $set: { config: parsed } }, { upsert: true });
  await recordAudit(actor, "faculty.config.set", { type: "screen", id: `${ref.scope}:${ref.key}` }, { scope: ref.scope, name: where.name, fields: Object.keys(parsed) });
  return reach(where);
}

export async function setScopePlaylist(ref: ScopeRef, input: unknown, actor: Actor): Promise<string[] | undefined> {
  const where = await describeScope(ref);
  const { scenes } = playlistInput.parse(input);
  const wanted = new Map<string, "image" | "video">();
  for (const s of scenes) for (const t of s.tiles) {
    const id = (t.settings.asset as { assetId?: string } | undefined)?.assetId;
    if (id) wanted.set(id, t.kind as "image" | "video");
  }
  await checkAssets([...wanted.keys()], wanted);
  await ScreenLayerModel.updateOne({ scope: ref.scope, key: ref.key }, { $set: { scenes } }, { upsert: true });
  await recordAudit(actor, "faculty.playlist.set", { type: "screen", id: `${ref.scope}:${ref.key}` }, { scope: ref.scope, name: where.name, scenes: scenes.length });
  return reach(where);
}

/** Back to inheriting: the level above decides again. */
export async function clearScopePlaylist(ref: ScopeRef, actor: Actor): Promise<string[] | undefined> {
  const where = await describeScope(ref);
  await ScreenLayerModel.updateOne({ scope: ref.scope, key: ref.key }, { $set: { scenes: null } });
  await recordAudit(actor, "faculty.playlist.clear", { type: "screen", id: `${ref.scope}:${ref.key}` }, { scope: ref.scope, name: where.name });
  return reach(where);
}

export async function clearScopeConfig(ref: ScopeRef, actor: Actor): Promise<string[] | undefined> {
  const where = await describeScope(ref);
  await ScreenLayerModel.updateOne({ scope: ref.scope, key: ref.key }, { $set: { config: {} } });
  await recordAudit(actor, "faculty.config.clear", { type: "screen", id: `${ref.scope}:${ref.key}` }, { scope: ref.scope, name: where.name });
  return reach(where);
}

// ---- Groups -----------------------------------------------------------------------------------

export const groupInput = z
  .object({
    name: z.string().trim().min(1).max(60),
    description: z.string().trim().max(200).default(""),
    members: z.array(z.string().min(1).max(64)).max(200).default([]),
  })
  .strict();
export type GroupInput = z.infer<typeof groupInput>;

async function checkMembers(members: string[]) {
  const unique = [...new Set(members)];
  const found = await DeviceModel.countDocuments({ deviceId: { $in: unique }, type: "display", status: "active" });
  if (found !== unique.length) throw new HttpError(400, "Only active Faculty screens can join a group");
  return unique;
}

/** A screen is in one group at most: joining one leaves the previous. Returns the screens whose group changed. */
async function takeMembers(members: string[], intoGroupId: string): Promise<void> {
  if (members.length) await ScreenGroupModel.updateMany({ groupId: { $ne: intoGroupId }, members: { $in: members } }, { $pull: { members: { $in: members } } });
}

export async function createGroup(input: GroupInput, actor: Actor) {
  const members = await checkMembers(input.members);
  const groupId = ulid();
  await takeMembers(members, groupId);
  const group = await ScreenGroupModel.create({ groupId, name: input.name, description: input.description, members });
  await recordAudit(actor, "faculty.group.create", { type: "screen-group", id: groupId }, { name: input.name, members: members.length });
  return { group, affected: members };
}

export async function updateGroup(groupId: string, input: GroupInput, actor: Actor) {
  const previous = await ScreenGroupModel.findOne({ groupId });
  if (!previous) throw new HttpError(404, "Group not found");
  const members = await checkMembers(input.members);
  await takeMembers(members, groupId);
  const before = [...previous.members];
  previous.set({ name: input.name, description: input.description, members });
  await previous.save();
  await recordAudit(actor, "faculty.group.update", { type: "screen-group", id: groupId }, { name: input.name, members: members.length });
  // Screens that joined or left see a different look and playlist.
  return { group: previous, affected: [...new Set([...members, ...before])] };
}

export async function deleteGroup(groupId: string, actor: Actor): Promise<string[]> {
  const group = await ScreenGroupModel.findOneAndDelete({ groupId });
  if (!group) throw new HttpError(404, "Group not found");
  await ScreenLayerModel.deleteOne({ scope: "group", key: groupId });
  await recordAudit(actor, "faculty.group.delete", { type: "screen-group", id: groupId }, { name: group.name });
  return group.members;
}

// ---- Library files in use ----------------------------------------------------------------------

export interface AssetUse {
  scope: ScreenScope;
  key: string;
  name: string;
  as: "logo" | "tile";
}

/** Where a library file is used. Deleting a file that is in use would leave screens with a hole. */
export async function assetUsage(assetId: string): Promise<AssetUse[]> {
  const layers = await ScreenLayerModel.find({ $or: [{ "config.site.logo.assetId": assetId }, { "scenes.tiles.settings.asset.assetId": assetId }] });
  if (layers.length === 0) return [];
  const [groups, devices] = await Promise.all([
    ScreenGroupModel.find({ groupId: { $in: layers.filter((l) => l.scope === "group").map((l) => l.key) } }),
    DeviceModel.find({ deviceId: { $in: layers.filter((l) => l.scope === "device").map((l) => l.key) } }, { deviceId: 1, name: 1 }),
  ]);
  const nameOf = (l: { scope: string; key: string }) =>
    l.scope === "default" ? "All screens" : l.scope === "group" ? (groups.find((g) => g.groupId === l.key)?.name ?? l.key) : (devices.find((d) => d.deviceId === l.key)?.name || l.key);
  return layers.flatMap((l) => {
    const uses: AssetUse[] = [];
    const base = { scope: l.scope, key: l.key, name: nameOf(l) };
    if ((l.config as FacultyConfigPatch | undefined)?.site?.logo?.assetId === assetId) uses.push({ ...base, as: "logo" });
    if (assetIdsOf((l.scenes ?? []) as SceneInput[]).includes(assetId)) uses.push({ ...base, as: "tile" });
    return uses;
  });
}

export const isAssetInUse = async (assetId: string) => (await assetUsage(assetId)).length > 0;

/** A library file changed (replaced): every screen that shows it gets the new hash. */
export async function pushForAsset(assetId: string): Promise<void> {
  const uses = await assetUsage(assetId);
  if (uses.length === 0) return;
  const all = uses.some((u) => u.scope === "default");
  const members = new Set<string>();
  const groups = await ScreenGroupModel.find({ groupId: { $in: uses.filter((u) => u.scope === "group").map((u) => u.key) } });
  for (const g of groups) for (const m of g.members) members.add(m);
  for (const u of uses) if (u.scope === "device") members.add(u.key);
  const ids = all ? undefined : [...members];
  await pushScreenConfig(ids);
  await pushCarousel(ids);
}
