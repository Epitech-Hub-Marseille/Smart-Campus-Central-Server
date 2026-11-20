import { createHash } from "node:crypto";
import { ulid } from "@smartcampus/protocol";
import { config } from "../config.js";
import { getPlugin } from "../integrations/registry.js";
import { PortalError, type PortalEvent, type PortalPerson, type PortalPlugin } from "../integrations/types.js";
import { HttpError } from "../lib/errors.js";
import { recordAudit } from "../lib/audit.js";
import { zonedToUtc } from "../lib/ical.js";
import { open, seal } from "../lib/secretBox.js";
import { CampusEventModel } from "../models/campusEvent.js";
import { IntegrationModel, type IntegrationDoc } from "../models/integration.js";
import { BuildingModel } from "../models/building.js";
import { ReservationModel } from "../models/reservation.js";
import { RoomModel, type RoomType } from "../models/room.js";
import { UserModel } from "../models/user.js";
import type { PublicUser } from "../models/user.js";
import { notifyFacultyChanged } from "./faculty.js";
import { refreshAllDoorReservations } from "./reservations.js";

type Actor = Pick<PublicUser, "id" | "name">;

/** An event that names more people than this is a class list, not the staff who run it: nobody is registered from it. */
export const MAX_REGISTERED_PER_EVENT = 10;
/** A read that has not finished after this long is considered dead, and another may start. */
const LOCK_MS = 5 * 60_000;
/** The title of a reservation, as the reservation model and the screens take it. */
const TITLE_MAX = 100;

export interface SyncSummary {
  fetched: number;
  created: number;
  updated: number;
  cancelled: number;
  removed: number;
  reservations: number;
  linkedPeople: number;
  registeredPeople: number;
  createdRooms: number;
  /** Places the portal named that match no room: the first thing to fix with an alias. */
  unmatchedLocations: string[];
}

// ---- Settings ----------------------------------------------------------------------------------

/** The settings of an integration as the plugin wants them: the plain ones and the opened secrets. */
function openConfig(doc: IntegrationDoc, plugin: PortalPlugin): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(doc.config as Record<string, unknown>) };
  for (const field of plugin.fields.filter((f) => f.secret)) {
    const sealed = (doc.secrets as Record<string, string> | undefined)?.[field.key];
    if (sealed) out[field.key] = open(sealed);
  }
  return out;
}

/** Splits what the console sent into plain and secret settings, validating all of it with the plugin. Secrets left out are kept. */
export function splitConfig(plugin: PortalPlugin, input: Record<string, unknown>, existing?: IntegrationDoc) {
  const merged: Record<string, unknown> = { ...(existing ? openConfig(existing, plugin) : {}) };
  for (const [key, value] of Object.entries(input)) if (value !== undefined && value !== "") merged[key] = value;
  // Throws a ZodError (answered 400) when the settings are not valid for the plugin.
  plugin.parseConfig(merged);
  const plain: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  for (const field of plugin.fields) {
    const value = merged[field.key];
    if (value === undefined) continue;
    if (field.secret) secrets[field.key] = seal(String(value));
    else plain[field.key] = value;
  }
  return { plain, secrets };
}

export const integrationDto = (doc: IntegrationDoc) => {
  const plugin = getPlugin(doc.plugin);
  const secretKeys = Object.keys((doc.secrets as Record<string, unknown>) ?? {});
  return {
    id: doc.integrationId,
    plugin: doc.plugin,
    pluginLabel: plugin?.label ?? doc.plugin,
    name: doc.name,
    enabled: doc.enabled,
    // Secrets are never returned: only which ones are set.
    config: doc.config ?? {},
    secretsSet: secretKeys,
    intervalMinutes: doc.intervalMinutes,
    horizonDays: doc.horizonDays,
    autoRegister: doc.autoRegister,
    registerService: doc.registerService ?? null,
    roomAliases: (doc.roomAliases as Record<string, string>) ?? {},
    ignoredPlaces: doc.ignoredPlaces ?? [],
    autoCreateRooms: doc.autoCreateRooms,
    autoCreateBuildingId: doc.autoCreateBuilding ? String(doc.autoCreateBuilding) : null,
    autoCreateFloor: doc.autoCreateFloor,
    lastSyncAt: doc.lastSyncAt ?? null,
    nextSyncAt: doc.nextSyncAt ?? null,
    lastStatus: doc.lastStatus,
    lastError: doc.lastError ?? null,
    lastSummary: doc.lastSummary ?? null,
  };
};

// ---- Matching ----------------------------------------------------------------------------------

/** "Pédagogie  1-8" and "pedagogie 1-8" are the same place. */
export const normalise = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** Start of the day of `now` in the campus time zone, as an instant. */
export function startOfCampusDay(now: Date, zone = config.CAMPUS_TIMEZONE): Date {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(now);
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return new Date(zonedToUtc(n("year"), n("month"), n("day"), 0, 0, 0, zone));
}

/** Where a portal says an event is, when it is not a room: a video call or another site. Never matched, created or reported. */
const REMOTE = /\b(distanciel|a distance|à distance|remote|online|en ligne|visio|teams|zoom|meet)\b/i;

/** The kind of room a place most likely is, from the words the campus uses. Only a first guess: it can be changed in the rooms page. */
export function guessRoomType(place: string): RoomType {
  const p = normalise(place);
  if (/\b(reunion|meeting|conference)\b/.test(p)) return "meeting";
  if (/\b(bureau|office|corner|box)\b/.test(p)) return "office";
  if (/\b(amphi|amphitheatre|lecture)\b/.test(p)) return "lecture_hall";
  if (/\b(labo|laboratoire|lab)\b/.test(p)) return "lab";
  if (/\b(salle|pedagogie|classroom|hub)\b/.test(p)) return "classroom";
  return "other";
}

/** The rooms of the campus by the normalised name and code, so a place the portal names finds its room. A name two rooms share matches neither. */
async function roomIndex() {
  const byName = new Map<string, string | null>();
  const ids = new Set<string>();
  for (const room of await RoomModel.find({}, { code: 1, name: 1 })) {
    ids.add(String(room._id));
    for (const key of [room.code, room.name].filter((k): k is string => Boolean(k)).map(normalise)) {
      byName.set(key, byName.has(key) && byName.get(key) !== String(room._id) ? null : String(room._id));
    }
  }
  return { byName, ids };
}
type RoomIndex = Awaited<ReturnType<typeof roomIndex>>;

type Resolution = { kind: "room"; roomId: string; via: "name" | "alias" } | { kind: "ignored" } | { kind: "none" };

/** What a place of the portal is here: ignored, a room (by alias first, then by name or code) or nothing yet. */
function resolvePlace(doc: IntegrationDoc, rooms: RoomIndex, place: string): Resolution {
  const key = normalise(place);
  if (REMOTE.test(place) || (doc.ignoredPlaces ?? []).some((p) => normalise(p) === key)) return { kind: "ignored" };
  for (const [alias, target] of Object.entries((doc.roomAliases as Record<string, string>) ?? {})) {
    if (normalise(alias) !== key) continue;
    // An alias names its room by id (set from the console) or by code or name (typed by hand).
    const roomId = rooms.ids.has(target) ? target : rooms.byName.get(normalise(target));
    if (roomId) return { kind: "room", roomId, via: "alias" };
  }
  const roomId = rooms.byName.get(key);
  return roomId ? { kind: "room", roomId, via: "name" } : { kind: "none" };
}

/**
 * Makes the room of a place that has none, in the building the integration was told to use, and remembers it in the index. A
 * code the building already has (the portal wrote the same place with other accents, say) is that room, not a new one.
 */
async function createRoomFor(doc: IntegrationDoc, rooms: RoomIndex, place: string, asked = false): Promise<string | null> {
  // `asked`: a person chose to create this one, which works even when the integration does not create rooms by itself.
  if ((!asked && !doc.autoCreateRooms) || !doc.autoCreateBuilding || !(await BuildingModel.exists({ _id: doc.autoCreateBuilding }))) return null;
  const code = place.slice(0, 30).trim();
  const existing = await RoomModel.findOne({ building: doc.autoCreateBuilding, code });
  let room = existing;
  if (!room) {
    room = await RoomModel.create({ building: doc.autoCreateBuilding, code, name: place.slice(0, 100), floor: doc.autoCreateFloor, type: guessRoomType(place) });
    await recordAudit(null, "room.create", { type: "room", id: String(room._id) }, { code, source: `integration:${doc.integrationId}` });
  }
  const id = String(room._id);
  rooms.ids.add(id);
  rooms.byName.set(normalise(place), id);
  return existing ? null : id;
}

const contentHash = (e: PortalEvent, roomIds: string[]) =>
  createHash("sha256")
    .update(JSON.stringify([e.title, e.description, e.start.getTime(), e.end.getTime(), e.allDay, e.cancelled, e.category, e.locations, roomIds, e.people.map((p) => [p.name, p.email, p.role])]))
    .digest("hex");

interface LinkedPerson extends PortalPerson {
  userId?: string;
}

/**
 * Finds the account of each person an event names: by email first, then by an exact name that only one account has. A person
 * with an email and no account is registered when the integration allows it (without a password or any way to sign in, listed
 * on the Faculty screens under the integration's service) so the event can carry their name.
 */
async function linkPeople(people: PortalPerson[], doc: IntegrationDoc, counts: { linked: number; registered: number }): Promise<LinkedPerson[]> {
  const mayRegister = doc.autoRegister && people.length <= MAX_REGISTERED_PER_EVENT;
  const out: LinkedPerson[] = [];
  for (const person of people) {
    let user = person.email ? await UserModel.findOne({ email: person.email.toLowerCase() }) : null;
    if (!user) {
      const sameName = await UserModel.find({ disabled: false }, { name: 1 }).collation({ locale: "en", strength: 1 }).where({ name: person.name }).limit(2);
      if (sameName.length === 1) user = sameName[0]!;
    }
    if (!user && person.email && mayRegister) {
      user = await UserModel.create({ email: person.email.toLowerCase(), name: person.name, groups: [], ...(doc.registerService && { service: doc.registerService }), source: `integration:${doc.integrationId}` }).catch(() => UserModel.findOne({ email: person.email!.toLowerCase() }));
      if (user && user.source === `integration:${doc.integrationId}` && Date.now() - (user.createdAt as Date).getTime() < 60_000) counts.registered++;
    } else if (user) counts.linked++;
    out.push({ ...person, ...(user && { userId: String(user._id) }) });
  }
  return out;
}

// ---- Reading a portal --------------------------------------------------------------------------

export interface SyncDeps {
  fetch?: typeof fetch;
  now?: Date;
}

/**
 * Reads one integration now and brings the campus in step with it: events stored, rooms and people matched, a reservation
 * for each event in a room (the doors and Faculty screens already show reservations), and the people it names shown as busy
 * for the length of the event. An event that disappears from the portal is cancelled. A failure is kept on the integration and
 * answered, and nothing already stored is touched.
 */
export async function syncIntegration(integrationId: string, actor: Actor | null, deps: SyncDeps = {}): Promise<SyncSummary> {
  const now = deps.now ?? new Date();
  const claimed = await IntegrationModel.findOneAndUpdate(
    { integrationId, $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: null }, { lockedUntil: { $lt: now } }] },
    { lockedUntil: new Date(now.getTime() + LOCK_MS) },
    { new: true },
  );
  if (!claimed) {
    if (!(await IntegrationModel.exists({ integrationId }))) throw new HttpError(404, "Integration not found");
    throw new HttpError(409, "This integration is already being read");
  }
  const plugin = getPlugin(claimed.plugin);
  const nextSyncAt = new Date(now.getTime() + claimed.intervalMinutes * 60_000);
  try {
    if (!plugin) throw new PortalError(`The plugin "${claimed.plugin}" is not installed`);
    const from = startOfCampusDay(now);
    const to = new Date(from.getTime() + claimed.horizonDays * 86_400_000);
    const events = await plugin.fetchEvents(plugin.parseConfig(openConfig(claimed, plugin)), { from, to }, { fetch: deps.fetch ?? fetch, timezone: config.CAMPUS_TIMEZONE });
    const summary = await apply(claimed, events, { from, to }, now);
    await IntegrationModel.updateOne({ integrationId }, { lastSyncAt: now, nextSyncAt, lastStatus: "ok", $unset: { lastError: 1, lockedUntil: 1 }, lastSummary: summary });
    await recordAudit(actor, "integration.sync", { type: "integration", id: integrationId }, { ...summary, unmatchedLocations: summary.unmatchedLocations.length });
    return summary;
  } catch (err) {
    // Only what a plugin says on purpose is shown; anything else is logged and shown as a plain failure, so no secret leaks.
    const message = err instanceof PortalError ? err.message : "The portal could not be read";
    if (!(err instanceof PortalError)) console.error(`integration ${integrationId} failed`, err instanceof Error ? err.message : err);
    await IntegrationModel.updateOne({ integrationId }, { lastSyncAt: now, nextSyncAt, lastStatus: "error", lastError: message, $unset: { lockedUntil: 1 } });
    throw err instanceof PortalError ? new HttpError(502, message) : err;
  }
}

async function apply(doc: IntegrationDoc, events: PortalEvent[], window: { from: Date; to: Date }, now: Date): Promise<SyncSummary> {
  const summary: SyncSummary = { fetched: events.length, created: 0, updated: 0, cancelled: 0, removed: 0, reservations: 0, linkedPeople: 0, registeredPeople: 0, createdRooms: 0, unmatchedLocations: [] };
  const rooms = await roomIndex();
  const unmatched = new Set<string>();
  const counts = { linked: 0, registered: 0 };
  const seen = new Set<string>();
  const touchedRooms = new Set<string>();

  for (const e of events) {
    if (seen.has(e.externalId)) continue;
    seen.add(e.externalId);
    const roomIds = new Set<string>();
    for (const place of e.locations) {
      let found = resolvePlace(doc, rooms, place);
      if (found.kind === "none") {
        const created = await createRoomFor(doc, rooms, place);
        if (created) summary.createdRooms++;
        found = resolvePlace(doc, rooms, place);
      }
      if (found.kind === "room") roomIds.add(found.roomId);
      else if (found.kind === "none") unmatched.add(place);
    }
    const hash = contentHash(e, [...roomIds].sort());
    const stored = await CampusEventModel.findOne({ integration: doc._id, externalId: e.externalId });
    const status = e.cancelled ? "cancelled" : "active";
    if (stored && stored.contentHash === hash && stored.status === status) {
      await mirrorReservations(doc, stored, now, touchedRooms);
      continue;
    }
    const people = await linkPeople(e.people, doc, counts);
    const fields = {
      title: e.title,
      description: e.description,
      category: e.category,
      start: e.start,
      end: e.end,
      allDay: e.allDay,
      status,
      locations: e.locations,
      rooms: [...roomIds],
      people: people.map((p) => ({ name: p.name, email: p.email ?? undefined, role: p.role, ...(p.userId && { userId: p.userId }) })),
      contentHash: hash,
    };
    const saved = stored ?? new CampusEventModel({ integration: doc._id, externalId: e.externalId });
    saved.set(fields);
    await saved.save();
    if (stored) summary.updated++;
    else summary.created++;
    await mirrorReservations(doc, saved, now, touchedRooms);
  }

  // What the portal no longer lists, inside the window, is cancelled; what ended before today is dropped.
  const gone = await CampusEventModel.find({ integration: doc._id, status: "active", end: { $gt: window.from }, start: { $lt: window.to }, externalId: { $nin: [...seen] } });
  for (const event of gone) {
    event.status = "cancelled";
    await event.save();
    summary.cancelled++;
    await mirrorReservations(doc, event, now, touchedRooms);
  }
  const old = await CampusEventModel.find({ integration: doc._id, end: { $lte: window.from } }, { _id: 1, externalId: 1 });
  for (const event of old) {
    await cancelReservationsOf(doc, event.externalId, [], touchedRooms);
    await event.deleteOne();
    summary.removed++;
  }

  summary.linkedPeople = counts.linked;
  summary.registeredPeople = counts.registered;
  summary.reservations = await ReservationModel.countDocuments({ source: `integration:${doc.integrationId}`, status: "active", end: { $gt: now } });
  summary.unmatchedLocations = [...unmatched].sort().slice(0, 50);

  if (summary.created + summary.updated + summary.cancelled + summary.removed + summary.createdRooms > 0 || touchedRooms.size > 0) {
    await refreshAllDoorReservations().catch((err) => console.error("door refresh failed", err instanceof Error ? err.message : err));
    await notifyFacultyChanged();
  }
  return summary;
}

// ---- Reservations ------------------------------------------------------------------------------

const keyOf = (doc: IntegrationDoc, externalId: string, roomId: string) => `${doc.integrationId}:${externalId}:${roomId}`;

/**
 * One reservation per room of an active, timed event, under the name of the first person of the event who has an account (or the
 * integration's name when none), so a door shows who is in the room. The portal is the truth: these are written without the
 * conflict check a person's booking gets, and follow every change of the event.
 */
async function mirrorReservations(doc: IntegrationDoc, event: InstanceType<typeof CampusEventModel>, now: Date, touchedRooms: Set<string>) {
  const rooms = event.status === "active" && !event.allDay ? event.rooms.map(String) : [];
  const organizer = event.people.find((p) => p.userId && p.role === "organizer") ?? event.people.find((p) => p.userId);
  const user = organizer?.userId ? await UserModel.findById(organizer.userId, { name: 1 }) : null;
  for (const roomId of rooms) {
    const fields = {
      room: roomId,
      title: event.title.slice(0, TITLE_MAX),
      start: event.start,
      end: event.end,
      organizerId: user ? String(user._id) : `integration:${doc.integrationId}`,
      organizerName: user?.name ?? doc.name,
      status: "active" as const,
      source: `integration:${doc.integrationId}`,
    };
    const key = keyOf(doc, event.externalId, roomId);
    const existing = await ReservationModel.findOne({ externalKey: key });
    if (!existing) {
      await ReservationModel.create({ ...fields, reservationId: ulid(), externalKey: key });
      touchedRooms.add(roomId);
    } else if (existing.status !== "active" || existing.title !== fields.title || existing.start.getTime() !== fields.start.getTime() || existing.end.getTime() !== fields.end.getTime() || existing.organizerName !== fields.organizerName) {
      existing.set({ ...fields, cancelledByName: undefined });
      await existing.save();
      touchedRooms.add(roomId);
    }
  }
  await cancelReservationsOf(doc, event.externalId, rooms, touchedRooms);
}

/** Cancels the reservations of an event for every room but `keep`: the event moved, was cancelled or is gone. */
async function cancelReservationsOf(doc: IntegrationDoc, externalId: string, keep: string[], touchedRooms: Set<string>) {
  const stale = await ReservationModel.find({ source: `integration:${doc.integrationId}`, status: "active", externalKey: { $regex: `^${doc.integrationId}:${externalId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:` }, room: { $nin: keep } });
  for (const r of stale) {
    r.status = "cancelled";
    r.cancelledByName = doc.name;
    await r.save();
    touchedRooms.add(String(r.room));
  }
}

// ---- Busy status -------------------------------------------------------------------------------

/** What was busy at the last look: the screens are told only when it changes, so the timer costs nothing the rest of the time. */
let lastBusySignature: string | null = null;

/** Called by the timer: when someone has just started or finished an event, the screens show it. */
export async function refreshEventAvailability(now = new Date()): Promise<boolean> {
  const events = await CampusEventModel.find({ status: "active", allDay: { $ne: true }, start: { $lte: now }, end: { $gt: now }, "people.userId": { $exists: true } }, { people: 1 });
  const signature = events.flatMap((e) => e.people.filter((p) => p.userId).map((p) => `${p.userId}:${e._id}`)).sort().join("|");
  const changed = lastBusySignature !== null && signature !== lastBusySignature;
  lastBusySignature = signature;
  if (changed) await notifyFacultyChanged();
  return changed;
}

// ---- The timer ---------------------------------------------------------------------------------

/** Reads every enabled integration that is due. One failing portal does not stop the others. */
export async function runDueIntegrations(now = new Date(), deps: SyncDeps = {}): Promise<number> {
  const due = await IntegrationModel.find({ enabled: true, $or: [{ nextSyncAt: { $exists: false } }, { nextSyncAt: null }, { nextSyncAt: { $lte: now } }] }, { integrationId: 1 });
  let ran = 0;
  for (const { integrationId } of due) {
    try {
      await syncIntegration(integrationId, null, { ...deps, now });
      ran++;
    } catch (err) {
      // Already recorded on the integration (lastError); a lock held by another run is not a failure.
      if (!(err instanceof HttpError) || err.status !== 409) console.error(`integration ${integrationId}:`, err instanceof Error ? err.message : err);
    }
  }
  return ran;
}

// ---- Places: which room is a place of the portal ---------------------------------------------

export interface PlaceRow {
  place: string;
  events: number;
  state: "room" | "ignored" | "none";
  roomId: string | null;
  via: "name" | "alias" | null;
}

/** Every place the stored events of this integration name, and what each one is here, for the console to let someone settle the ones that are not. */
export async function placesOf(doc: IntegrationDoc): Promise<PlaceRow[]> {
  const counts = new Map<string, number>();
  for (const e of await CampusEventModel.find({ integration: doc._id, end: { $gt: startOfCampusDay(new Date()) } }, { locations: 1 })) {
    for (const place of e.locations) counts.set(place, (counts.get(place) ?? 0) + 1);
  }
  const rooms = await roomIndex();
  return [...counts]
    .map(([place, events]): PlaceRow => {
      const found = resolvePlace(doc, rooms, place);
      return { place, events, state: found.kind, roomId: found.kind === "room" ? found.roomId : null, via: found.kind === "room" ? found.via : null };
    })
    .sort((a, b) => Number(a.state === "none") === Number(b.state === "none") ? b.events - a.events : a.state === "none" ? -1 : 1);
}

export type PlaceChoice = { action: "room"; roomId: string } | { action: "create" } | { action: "ignore" } | { action: "clear" };

/**
 * Settles one place: it is a given room, it gets a room of its own (in the building the integration is set to create in), it is
 * not a room at all, or the choice is taken back. The stored events are then matched again at once, with no new reading of the
 * portal, so the doors and screens follow.
 */
export async function setPlace(doc: IntegrationDoc, place: string, choice: PlaceChoice, actor: Actor): Promise<PlaceRow[]> {
  const key = normalise(place);
  const aliases = Object.fromEntries(Object.entries((doc.roomAliases as Record<string, string>) ?? {}).filter(([alias]) => normalise(alias) !== key));
  const ignored = (doc.ignoredPlaces ?? []).filter((p) => normalise(p) !== key);
  if (choice.action === "room") {
    if (!(await RoomModel.exists({ _id: choice.roomId }))) throw new HttpError(404, "Room not found");
    aliases[place] = choice.roomId;
  } else if (choice.action === "ignore") ignored.push(place);
  else if (choice.action === "create") {
    if (!doc.autoCreateBuilding) throw new HttpError(409, "Choose the building new rooms go in first");
    const rooms = await roomIndex();
    await createRoomFor(doc, rooms, place, true);
    if (resolvePlace(doc, rooms, place).kind === "none") throw new HttpError(409, "The room could not be created");
  }
  doc.set({ roomAliases: aliases, ignoredPlaces: ignored });
  doc.markModified("roomAliases");
  await doc.save();
  await recordAudit(actor, "integration.place", { type: "integration", id: doc.integrationId }, { place, action: choice.action });
  await rematch(doc);
  return placesOf(doc);
}

/** Matches the stored events again with what is now known about places, and brings their reservations in step. */
export async function rematch(doc: IntegrationDoc, now = new Date()): Promise<number> {
  const rooms = await roomIndex();
  const touched = new Set<string>();
  let changed = 0;
  for (const event of await CampusEventModel.find({ integration: doc._id, end: { $gt: startOfCampusDay(now) } })) {
    const roomIds = new Set<string>();
    for (const place of event.locations) {
      const found = resolvePlace(doc, rooms, place);
      if (found.kind === "room") roomIds.add(found.roomId);
    }
    const next = [...roomIds].sort();
    const same = next.join() === event.rooms.map(String).sort().join();
    if (!same) {
      const portalView: PortalEvent = { externalId: event.externalId, title: event.title, description: event.description ?? "", start: event.start, end: event.end, allDay: Boolean(event.allDay), cancelled: event.status === "cancelled", category: event.category ?? "", locations: event.locations, people: event.people.map((p) => ({ name: p.name, email: p.email ?? null, role: p.role as PortalPerson["role"] })) };
      event.set({ rooms: next, contentHash: contentHash(portalView, next) });
      await event.save();
      changed++;
    }
    await mirrorReservations(doc, event, now, touched);
  }
  if (changed > 0 || touched.size > 0) {
    await refreshAllDoorReservations().catch((err) => console.error("door refresh failed", err instanceof Error ? err.message : err));
    await notifyFacultyChanged();
  }
  return changed;
}
