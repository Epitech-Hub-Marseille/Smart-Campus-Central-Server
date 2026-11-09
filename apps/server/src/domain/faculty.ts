import { FACULTY_LIMITS, facultyConfig, type FacultyConfig, type PayloadOf, type Service } from "@smartcampus/protocol";
import { recordAudit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { DeviceModel } from "../models/device.js";
import { NewsModel } from "../models/news.js";
import { ReservationModel } from "../models/reservation.js";
import { UserModel } from "../models/user.js";
import type { PublicUser } from "../models/user.js";
import { AssetModel } from "../models/asset.js";
import { assetRefOf } from "./assets.js";
import { enqueueCommand } from "./commands.js";
import { notifyContentChanged, pushContent } from "./content.js";

type Actor = Pick<PublicUser, "id" | "name">;

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
    staff: staff.map((u) => effectiveAvailability(u, now)),
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

/** A status with a time limit that has passed means the person is available again. */
export function effectiveAvailability(
  user: { _id: unknown; name: string; jobTitle?: string | null; service?: string | null; availability?: { status: string; note?: string | null; until?: Date | null } | null },
  now = new Date(),
) {
  const a = user.availability;
  const lapsed = Boolean(a?.until && a.until.getTime() <= now.getTime());
  const status = !a || lapsed ? "available" : a.status;
  return {
    id: String(user._id),
    name: cut(user.name, 80),
    service: user.service as Service,
    ...(user.jobTitle && { jobTitle: cut(user.jobTitle, 60) }),
    availability: status as PayloadOf<"faculty.content.set">["staff"][number]["availability"],
    ...(a && !lapsed && a.note && { note: cut(a.note, 60) }),
    ...(a && !lapsed && a.until && status !== "available" && { until: a.until.getTime() }),
  };
}

const activeDisplays = () => DeviceModel.find({ type: "display", status: "active" }, { deviceId: 1, desired: 1 });

const configOf = (desired: unknown): FacultyConfig => {
  const stored = (desired as { facultyConfig?: unknown } | undefined)?.facultyConfig;
  const parsed = facultyConfig.safeParse(stored ?? {});
  return parsed.success ? parsed.data : facultyConfig.parse({});
};

/** Current look of a display (defaults when it never had one). */
export async function currentFacultyConfig(deviceId: string): Promise<FacultyConfig> {
  const device = await DeviceModel.findOne({ deviceId }, { desired: 1 });
  return configOf(device?.desired);
}

/**
 * Sends the current content to Faculty screens (all of them, or the given ones). The snapshot is
 * built once per service filter. It is not stored in the digital twin: it is derived data and too big
 * for `session.ready`, so it is rebuilt when the screen connects instead (`refreshFacultyOnConnect`).
 */
export async function pushFacultyContent(deviceIds?: string[]): Promise<number> {
  const displays = (await activeDisplays()).filter((d) => !deviceIds || deviceIds.includes(d.deviceId));
  const cache = new Map<string, FacultyContent>();
  const now = new Date();
  for (const d of displays) {
    const service = configOf(d.desired).service;
    if (!cache.has(service)) cache.set(service, await buildFacultyContent(service, now));
    await enqueueCommand(d.deviceId, "faculty.content.set", cache.get(service), CONTENT_TTL_SECONDS);
  }
  return displays.length;
}

/** Content changed somewhere (news, availability, reservation, directory): tell the screens, never fail the caller. */
export async function notifyFacultyChanged(): Promise<void> {
  try {
    await pushFacultyContent();
    // A slide may have ended or begun since the last push.
    await notifyContentChanged();
  } catch (err) {
    console.error("faculty push failed", err instanceof Error ? err.message : err);
  }
}

/** Before the connection replays its commands: a Faculty screen that reconnects gets fresh content. */
export async function refreshFacultyOnConnect(deviceId: string): Promise<void> {
  const device = await DeviceModel.findOne({ deviceId, type: "display", status: "active" }, { _id: 1 });
  if (device) {
    await pushFacultyContent([deviceId]);
    await pushContent([deviceId]);
  }
}

export async function setFacultyConfig(deviceId: string, config: FacultyConfig, actor: Actor): Promise<void> {
  const device = await DeviceModel.findOne({ deviceId, status: "active" }, { type: 1 });
  if (!device) throw new HttpError(404, "Active device not found");
  if (device.type !== "display") throw new HttpError(400, "Only Faculty displays have a Faculty configuration");
  // The logo is a file of the library: its hash and size come from the stored record, never from the request.
  if (config.site.logo) {
    const logo = await AssetModel.findOne({ assetId: config.site.logo.assetId, kind: "image" });
    if (!logo) throw new HttpError(400, "The logo must be an image from the library");
    config = { ...config, site: { ...config.site, logo: assetRefOf(logo) } };
  }
  await enqueueCommand(deviceId, "faculty.config.set", { config });
  // The service filter may have changed, so the staff list changes with it, and the mode decides whether a playlist is sent.
  await pushFacultyContent([deviceId]);
  await pushContent([deviceId]);
  await recordAudit(actor, "faculty.config.set", { type: "device", id: deviceId }, { service: config.service, slides: config.carousel.slides.length });
}
