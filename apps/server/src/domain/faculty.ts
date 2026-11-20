import { FACULTY_LIMITS, type FacultyConfig, type PayloadOf, type Service } from "@smartcampus/protocol";
import { DeviceModel } from "../models/device.js";
import { NewsModel } from "../models/news.js";
import { ReservationModel } from "../models/reservation.js";
import { UserModel } from "../models/user.js";
import { enqueueCommand } from "./commands.js";
import { currentEventsFor, type CurrentEvent } from "./eventAvailability.js";
import { pushCarousel, pushScreenConfig, resolveScreens } from "./screens.js";

/** A snapshot is rebuilt whenever something changes and on every connection, so a day without news is the longest it must outlive. */
const CONTENT_TTL_SECONDS = 86_400;

/** Reservations on the Faculty screens: what is happening in the next day. */
const RESERVATION_WINDOW_MS = 24 * 3_600_000;

const PRIORITY_RANK: Record<string, number> = { urgent: 0, important: 1, info: 2 };

/** The schema counts UTF-16 units, as `slice` does, so cutting here can never produce an invalid frame. */
const cut = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);

export type FacultyContent = PayloadOf<"faculty.content.set">;

/**
 * What a Faculty screen shows right now, limited to what fits in a frame. `service` narrows the staff
 * list for screens dedicated to one service. Expired news and lapsed availabilities are left out.
 */
export async function buildFacultyContent(service: FacultyConfig["service"], now = new Date()): Promise<FacultyContent> {
  const [news, staff, reservations] = await Promise.all([
    NewsModel.find({ publishedAt: { $lte: now }, $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: now } }] })
      .sort({ publishedAt: -1 })
      .limit(100),
    UserModel.find({ disabled: false, service: service === "all" ? { $in: ["pedagogical", "administrative"] } : service }).sort({ name: 1 }).limit(FACULTY_LIMITS.staff),
    ReservationModel.find({ status: "active", end: { $gt: now }, start: { $lt: new Date(now.getTime() + RESERVATION_WINDOW_MS) } })
      .sort({ start: 1 })
      .limit(FACULTY_LIMITS.reservations)
      .populate<{ room: { code: string; name?: string; building?: { name: string } } }>({ path: "room", select: "code name building", populate: { path: "building", select: "name" } }),
  ]);

  // Whoever is in an event of a portal shows as busy for its length, unless they said otherwise themselves.
  const events = await currentEventsFor(staff.map((u) => String(u._id)), now);
  return {
    news: news
      .sort((a, b) => (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2) || b.publishedAt.getTime() - a.publishedAt.getTime())
      .slice(0, FACULTY_LIMITS.news)
      .map((n) => ({
        id: n.newsId,
        title: cut(n.title, 120),
        text: cut(n.text, 400),
        priority: n.priority,
        publishedAt: n.publishedAt.getTime(),
        ...(n.expiresAt && { expiresAt: n.expiresAt.getTime() }),
      })),
    staff: staff.map((u) => effectiveAvailability(u, now, events.get(String(u._id)))),
    reservations: reservations.map((r) => ({
      id: r.reservationId,
      // The room code, as the board shows it ("A101"): room codes already carry their building.
      room: cut(r.room?.code ?? "", 60),
      title: cut(r.title, 100),
      start: r.start.getTime(),
      end: r.end.getTime(),
      organizer: cut(r.organizerName, 60),
    })),
    updatedAt: now.getTime(),
  };
}

/**
 * What a person shows on the screens. What they (or an administrator) set wins: a status with a time limit that has passed means
 * it no longer counts. Without one, being in an event of a portal shows them as busy until it ends. An "available" that has an end
 * time is the person saying they are free in spite of the event, until it is over.
 */
export function effectiveAvailability(
  user: { _id: unknown; name: string; jobTitle?: string | null; service?: string | null; availability?: { status: string; note?: string | null; until?: Date | null } | null },
  now = new Date(),
  event?: CurrentEvent,
) {
  const a = user.availability;
  const lapsed = Boolean(a?.until && a.until.getTime() <= now.getTime());
  const said = a && !lapsed && (a.status !== "available" || Boolean(a.until));
  const common = { id: String(user._id), name: cut(user.name, 80), service: user.service as Service, ...(user.jobTitle && { jobTitle: cut(user.jobTitle, 60) }) };
  if (!said && event) {
    return { ...common, availability: "busy" as PayloadOf<"faculty.content.set">["staff"][number]["availability"], note: cut(event.title, 60), until: event.end.getTime() };
  }
  const status = !a || lapsed ? "available" : a.status;
  return {
    ...common,
    availability: status as PayloadOf<"faculty.content.set">["staff"][number]["availability"],
    ...(a && !lapsed && a.note && { note: cut(a.note, 60) }),
    ...(a && !lapsed && a.until && status !== "available" && { until: a.until.getTime() }),
  };
}

/**
 * Sends the current content to Faculty screens (all of them, or the given ones). The snapshot is
 * built once per service filter. It is not stored in the digital twin: it is derived data and too big
 * for `session.ready`, so it is rebuilt when the screen connects instead (`refreshFacultyOnConnect`).
 */
export async function pushFacultyContent(deviceIds?: string[]): Promise<number> {
  const screens = await resolveScreens(deviceIds);
  const cache = new Map<string, FacultyContent>();
  const now = new Date();
  for (const s of screens) {
    const service = s.config.service;
    if (!cache.has(service)) cache.set(service, await buildFacultyContent(service, now));
    await enqueueCommand(s.deviceId, "faculty.content.set", cache.get(service), CONTENT_TTL_SECONDS);
  }
  return screens.length;
}

/** Look, carousel and board content of the given screens (all when none is named): what a settings or playlist change needs. */
export async function applyScreenChange(deviceIds?: string[]): Promise<void> {
  await pushScreenConfig(deviceIds);
  // The service filter may have changed, so the staff list changes with it.
  await pushFacultyContent(deviceIds);
  await pushCarousel(deviceIds);
}

/** Content changed somewhere (news, availability, reservation, directory): tell the screens, never fail the caller. */
export async function notifyFacultyChanged(): Promise<void> {
  try {
    await pushFacultyContent();
    // A scene may have ended or begun since the last push.
    await pushCarousel();
  } catch (err) {
    console.error("faculty push failed", err instanceof Error ? err.message : err);
  }
}

/** Before the connection replays its commands: a Faculty screen that reconnects gets its look and fresh content. */
export async function refreshFacultyOnConnect(deviceId: string): Promise<void> {
  const device = await DeviceModel.findOne({ deviceId, type: "display", status: "active" }, { _id: 1 });
  if (device) await applyScreenChange([deviceId]);
}
