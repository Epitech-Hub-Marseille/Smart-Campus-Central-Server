import { z } from "zod";
import { PROTOCOL_VERSION } from "./constants.js";
import { EMERGENCY_KINDS } from "./emergency.js";
import { ULID_REGEX } from "./ulid.js";

/** Envelope shared by every message after the handshake. */
const envelope = {
  v: z.literal(PROTOCOL_VERSION),
  /** ULID. Idempotence key: a device never runs the same id twice. */
  id: z.string().regex(ULID_REGEX),
  ts: z.number().int().nonnegative(),
  /** Per-connection, per-direction counter starting at 1. Must strictly increase (anti-replay). */
  seq: z.number().int().positive(),
};

const msg = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({ ...envelope, type: z.literal(type), payload });

const record = z.record(z.string(), z.unknown());

export const ANNOUNCE_PRIORITIES = ["info", "important", "urgent"] as const;

/** Icons a status may use. Devices map each name to a drawable they ship with. */
export const STATUS_ICONS = [
  "check",
  "user",
  "lock",
  "wrench",
  "calendar",
  "clock",
  "alert",
  "info",
  "book",
  "coffee",
  "ban",
  "wifi-off",
] as const;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected a colour like #00a86b");
const hourMinute = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");

/** Machine key of a status, e.g. "free" or "exam-in-progress". */
export const statusKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);

/**
 * A status travels with its label, colour and icon, so a door unit never needs the catalogue and
 * keeps showing the right thing for a status created after it was installed.
 */
export const roomStatusValue = z.object({
  roomId: z.string().min(1).max(64),
  status: statusKey,
  label: z.string().trim().min(1).max(40),
  color: hexColor,
  icon: z.enum(STATUS_ICONS),
  /** When the status was set (ms since epoch). */
  since: z.number().int().nonnegative().optional(),
});

/** Services of the staff directory shown on Faculty screens. */
export const SERVICES = ["pedagogical", "administrative"] as const;
export type Service = (typeof SERVICES)[number];

export const AVAILABILITIES = ["available", "busy", "away", "absent"] as const;
export type Availability = (typeof AVAILABILITIES)[number];

export const DISPLAY_LAYOUTS = ["standard", "compact", "split"] as const;
export const DISPLAY_THEMES = ["dark", "light"] as const;

/** Night sleep and quiet hours share this shape. `from` > `to` means the window crosses midnight. */
export const timeWindow = z.object({
  enabled: z.boolean().default(false),
  from: hourMinute.default("22:00"),
  to: hourMinute.default("06:00"),
});

/** What a door screen shows and how. Every field has a default so a partial config is valid. */
export const displayConfig = z.object({
  layout: z.enum(DISPLAY_LAYOUTS).default("standard"),
  theme: z.enum(DISPLAY_THEMES).default("dark"),
  accentColor: hexColor.default("#00a86b"),
  show: z
    .object({
      roomName: z.boolean().default(true),
      building: z.boolean().default(true),
      floor: z.boolean().default(true),
      capacity: z.boolean().default(true),
      clock: z.boolean().default(true),
      announcements: z.boolean().default(true),
      nextReservation: z.boolean().default(true),
    })
    .default({}),
  sleep: timeWindow.default({}),
});
export type DisplayConfig = z.infer<typeof displayConfig>;

export const FACULTY_SLIDES = ["news", "staff", "reservations"] as const;

/**
 * A file a device downloads over signed HTTPS (never carried in JSON), checked against `sha256` before use.
 * `mime` tells the screen how to show it without trusting the file name.
 */
export const assetRef = z.object({
  assetId: z.string().min(1).max(64),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().positive().max(200 * 1024 * 1024),
  mime: z.string().max(60),
});
export type AssetRef = z.infer<typeof assetRef>;

/** What a Faculty screen shows: the information board, the custom playlist, or both taking turns. */
export const FACULTY_MODES = ["default", "custom", "mixed"] as const;

/**
 * How a Faculty screen looks. `service` filters the staff list (the server also filters what it
 * sends, so the frame stays small). The screen fetches the weather itself from `weather`'s position.
 */
export const facultyConfig = z.object({
  mode: z.enum(FACULTY_MODES).default("default"),
  /** Who the screen belongs to: the header of the board and the details of the emergency screen. */
  site: z
    .object({
      name: z.string().trim().max(80).default(""),
      subtitle: z.string().trim().max(120).default(""),
      /** Building or zone, shown on the emergency screen. */
      zone: z.string().trim().max(60).default(""),
      assemblyPoint: z.string().trim().max(80).default(""),
      emergencyNumber: z.string().trim().max(30).default(""),
      logo: assetRef.nullable().default(null),
    })
    .default({}),
  service: z.enum(["all", ...SERVICES]).default("all"),
  carousel: z
    .object({
      enabled: z.boolean().default(true),
      intervalSeconds: z.number().int().min(5).max(120).default(15),
      slides: z.array(z.enum(FACULTY_SLIDES)).min(1).max(FACULTY_SLIDES.length).default([...FACULTY_SLIDES]),
    })
    .default({}),
  widgets: z
    .object({
      clock: z.boolean().default(true),
      date: z.boolean().default(true),
      weather: z.boolean().default(false),
    })
    .default({}),
  weather: z
    .object({
      label: z.string().trim().max(60).default(""),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    })
    .nullable()
    .default(null),
});
export type FacultyConfig = z.infer<typeof facultyConfig>;

/** One entry of the reservation list. Times are ms since epoch. */
export const reservationItem = z.object({
  id: z.string().min(1).max(64),
  title: z.string().max(100),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  organizer: z.string().max(60).optional(),
});

export const CONTENT_KINDS = ["image", "video", "text", "web"] as const;
export const CONTENT_FIT = ["contain", "cover"] as const;

/** Playlist bounds. Small enough that the worst case fits a frame (see the size test). */
export const CONTENT_LIMITS = { items: 24, text: 400, title: 80, url: 300, durationMin: 3, durationMax: 600 } as const;

/**
 * One slide of the custom playlist. Which fields apply depends on `kind`: media carries an `asset`, text its
 * `text`, a web page its `url`. `startsAt` and `endsAt` are absolute (ms), so a screen applies the schedule by
 * itself, even offline.
 */
export const contentItem = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.enum(CONTENT_KINDS),
    title: z.string().trim().max(CONTENT_LIMITS.title).default(""),
    durationSeconds: z.number().int().min(CONTENT_LIMITS.durationMin).max(CONTENT_LIMITS.durationMax).default(15),
    fit: z.enum(CONTENT_FIT).default("contain"),
    asset: assetRef.optional(),
    text: z.string().trim().max(CONTENT_LIMITS.text).optional(),
    url: z.string().url().max(CONTENT_LIMITS.url).optional(),
    /** Web pages are reloaded this often, so a live page stays live. */
    refreshSeconds: z.number().int().min(10).max(86_400).optional(),
    startsAt: z.number().int().nonnegative().optional(),
    endsAt: z.number().int().nonnegative().optional(),
  })
  .superRefine((item, ctx) => {
    const need = (ok: boolean, path: string, message: string) => ok || ctx.addIssue({ code: "custom", path: [path], message });
    if (item.kind === "image" || item.kind === "video") {
      need(Boolean(item.asset), "asset", `a ${item.kind} needs an asset`);
      need(item.asset?.mime.startsWith(`${item.kind}/`) ?? true, "asset", `the asset is not a ${item.kind}`);
    }
    if (item.kind === "text") need(Boolean(item.text), "text", "a text slide needs a text");
    if (item.kind === "web") need(Boolean(item.url) && /^https?:\/\//i.test(item.url ?? ""), "url", "a web slide needs an http(s) address");
    if (item.startsAt !== undefined && item.endsAt !== undefined) need(item.endsAt > item.startsAt, "endsAt", "endsAt must be after startsAt");
  });
export type ContentItem = z.infer<typeof contentItem>;

// Counts and field lengths are sized so a worst-case snapshot (multi-byte text) still fits in MAX_FRAME_BYTES once
// encrypted and base64-encoded; the size test in protocol.test.ts proves it.
export const FACULTY_LIMITS = { news: 8, staff: 40, reservations: 15 } as const;

// ---- Server -> device ------------------------------------------------------------------

/** Sent first, inside the encrypted channel, once the handshake succeeded. */
export const sessionReady = msg(
  "session.ready",
  z.object({
    /** Full desired state: the device converges on it after any outage. */
    desired: record,
    serverTime: z.number().int(),
    /** Commands about to be replayed right after this message. */
    pendingCommands: z.number().int().nonnegative(),
  }),
);

export const roomStatusSet = msg("room.status.set", roomStatusValue);

/** Static facts about the room a door screen is linked to. */
export const roomInfoSet = msg(
  "room.info.set",
  z.object({
    roomId: z.string().min(1).max(64),
    code: z.string().min(1).max(30),
    name: z.string().max(100),
    building: z.string().max(100),
    floor: z.number().int(),
    capacity: z.number().int().nonnegative().nullable(),
  }),
);

export const displayConfigSet = msg("display.config.set", z.object({ config: displayConfig }));

/** Per-device speaker settings. Audio that arrives inside quiet hours is acknowledged but not played. */
export const audioSettingsSet = msg(
  "audio.settings.set",
  z.object({ volume: z.number().int().min(0).max(100), quietHours: timeWindow }),
);

/** Faculty screen look: carousel, widgets and staff service filter. */
export const facultyConfigSet = msg("faculty.config.set", z.object({ config: facultyConfig }));

/**
 * Everything a Faculty screen rotates through, as one snapshot that replaces the previous one.
 * Items carry their own expiry, so a screen that is offline hides stale news by itself.
 */
export const facultyContentSet = msg(
  "faculty.content.set",
  z.object({
    news: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          title: z.string().max(120),
          text: z.string().max(400),
          priority: z.enum(ANNOUNCE_PRIORITIES),
          publishedAt: z.number().int().nonnegative(),
          expiresAt: z.number().int().optional(),
        }),
      )
      .max(FACULTY_LIMITS.news),
    staff: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          name: z.string().max(80),
          service: z.enum(SERVICES),
          jobTitle: z.string().max(60).optional(),
          availability: z.enum(AVAILABILITIES),
          note: z.string().max(60).optional(),
          /** When the availability stops applying; afterwards the screen shows the person as available. */
          until: z.number().int().optional(),
        }),
      )
      .max(FACULTY_LIMITS.staff),
    reservations: z.array(reservationItem.extend({ room: z.string().max(60) })).max(FACULTY_LIMITS.reservations),
    updatedAt: z.number().int().nonnegative(),
  }),
);

/**
 * The custom playlist of a Faculty screen, as one snapshot that replaces the previous one. Like the Faculty
 * content it is derived data, rebuilt on connection rather than kept in the twin. A screen switches to a new
 * playlist only once every file in it is downloaded and verified, and keeps the old one until then.
 */
export const contentSet = msg("content.set", z.object({ items: z.array(contentItem).max(CONTENT_LIMITS.items), updatedAt: z.number().int().nonnegative() }));

/** Upcoming reservations of the room a door screen is linked to (the screen shows the next one). */
export const reservationsSet = msg(
  "reservations.set",
  z.object({ roomId: z.string().min(1).max(64), items: z.array(reservationItem).max(5) }),
);

export const announceShow = msg(
  "announce.show",
  z.object({
    announcementId: z.string().min(1).max(64),
    title: z.string().max(200).optional(),
    text: z.string().min(1).max(2000),
    priority: z.enum(ANNOUNCE_PRIORITIES).default("info"),
    /** Absolute time (ms since epoch). The device hides the announcement by itself, even offline. */
    expiresAt: z.number().int().optional(),
  }),
);

export const announceClear = msg("announce.clear", z.object({ announcementId: z.string().min(1).max(64) }));

/** Audio never travels in JSON: the device downloads `assetId` over signed HTTPS and checks the hash. */
export const audioPlay = msg(
  "audio.play",
  z.object({
    announcementId: z.string().min(1).max(64),
    title: z.string().max(200).optional(),
    assetId: z.string().min(1).max(64),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().positive(),
    /** Plays at full volume and ignores quiet hours. Only for emergencies. */
    urgent: z.boolean().default(false),
  }),
);

/**
 * An emergency takes over the whole screen and sounds an alarm. It carries its own title and
 * instructions, so a door unit shows the right thing even when it was installed before the wording
 * changed, and keeps showing it through an outage until `emergency.clear`.
 */
export const emergencySet = msg(
  "emergency.set",
  z.object({
    emergencyId: z.string().min(1).max(64),
    kind: z.enum(EMERGENCY_KINDS),
    title: z.string().trim().min(1).max(60),
    instructions: z.string().trim().min(1).max(400),
    /** Test mode: the screen says so and the alarm plays at `testVolume`, and respects quiet hours. */
    testMode: z.boolean().default(false),
    testVolume: z.number().int().min(0).max(100).default(20),
    startedAt: z.number().int().nonnegative(),
  }),
);

/** Bounds of how long the end-of-emergency notice stays on screen. A screen uses its own default (120 s) when none is given. */
export const END_NOTICE_SECONDS = { min: 10, max: 900, default: 120 } as const;

/** `message` is the end-of-emergency notice the screen shows for `noticeSeconds` after the alarm stops. */
export const emergencyClear = msg(
  "emergency.clear",
  z.object({
    emergencyId: z.string().min(1).max(64),
    message: z.string().trim().min(1).max(400).optional(),
    noticeSeconds: z.number().int().min(END_NOTICE_SECONDS.min).max(END_NOTICE_SECONDS.max).optional(),
  }),
);

export const accessAclSync = msg(
  "access.acl.sync",
  z.object({
    rules: z
      .array(
        z.object({
          badgeUid: z.string().min(1).max(64),
          zones: z.array(z.string().max(64)).max(64),
          validFrom: z.number().int().optional(),
          validUntil: z.number().int().optional(),
        }),
      )
      .max(5000),
  }),
);

/** What the server decided about a card that was presented to a reader. */
export const CARD_OUTCOMES = [
  "maintenance",
  "recognised",
  "unknown",
  "disabled",
  "captured",
  "duplicate",
  "already_registered",
  "rate_limited",
] as const;
export type CardOutcome = (typeof CARD_OUTCOMES)[number];

/** What a maintenance menu may do. `status.set` changes the status of the room the terminal is linked to. */
export const MAINTENANCE_ACTIONS = ["status.set", "restart", "revoke"] as const;
export type MaintenanceAction = (typeof MAINTENANCE_ACTIONS)[number];

/** Offered with an accepted card so the menu needs no catalogue of its own. */
export const maintenanceMenu = z.object({
  statuses: z
    .array(z.object({ key: statusKey, label: z.string().max(40), color: hexColor, icon: z.enum(STATUS_ICONS) }))
    .max(50),
  /** Only administrators may take the terminal out of service. */
  canRevoke: z.boolean(),
});

/**
 * Answer to an `event.badge`, never queued: a card result that arrives late would open a maintenance
 * menu for someone who has already walked away. The device opens the menu only when `maintenance` is true.
 */
export const cardResult = msg(
  "card.result",
  z.object({
    /** Id of the `event.badge` this answers. */
    ref: z.string().regex(ULID_REGEX),
    outcome: z.enum(CARD_OUTCOMES),
    maintenance: z.boolean(),
    /** Present when the card belongs to someone, so the reader can greet them. */
    name: z.string().max(100).optional(),
    /** Present when `maintenance` is true. */
    menu: maintenanceMenu.optional(),
  }),
);

/** Answer to a `maintenance.action`. Like `card.result` it is never queued. */
export const maintenanceResult = msg(
  "maintenance.result",
  z.object({ ref: z.string().regex(ULID_REGEX), action: z.enum(MAINTENANCE_ACTIONS), ok: z.boolean(), error: z.string().max(200).optional() }),
);

/**
 * While active, cards presented to this reader are collected for enrolment instead of being treated
 * as logins. The device leaves the mode by itself at `expiresAt`, even when it is offline.
 */
export const registrationModeSet = msg(
  "registration.mode.set",
  z.object({
    sessionId: z.string().min(1).max(64),
    active: z.boolean(),
    expiresAt: z.number().int().optional(),
  }),
);

// ---- Device -> server ------------------------------------------------------------------

export const ack = msg("ack", z.object({ ref: z.string().regex(ULID_REGEX) }));

export const nack = msg(
  "nack",
  z.object({ ref: z.string().regex(ULID_REGEX), reason: z.string().max(200) }),
);

export const stateReport = msg(
  "state.report",
  z.object({ state: record, telemetry: record.optional() }),
);

/** `badgeUid` is the card's serial number as read. The server normalises it, so any hex notation is fine. */
export const eventBadge = msg(
  "event.badge",
  z.object({ badgeUid: z.string().min(1).max(64), at: z.number().int(), granted: z.boolean().optional() }),
);

/**
 * An action chosen in the maintenance menu. The server accepts it only inside the grant it opened
 * with the card (same device, still valid, person still allowed), so a device cannot invent one.
 */
export const maintenanceAction = msg(
  "maintenance.action",
  z.object({ action: z.enum(MAINTENANCE_ACTIONS), status: statusKey.optional() }),
);

// ---- Unions ----------------------------------------------------------------------------

export const serverMessage = z.discriminatedUnion("type", [
  sessionReady,
  roomStatusSet,
  roomInfoSet,
  displayConfigSet,
  facultyConfigSet,
  facultyContentSet,
  contentSet,
  reservationsSet,
  audioSettingsSet,
  announceShow,
  announceClear,
  audioPlay,
  emergencySet,
  emergencyClear,
  accessAclSync,
  cardResult,
  maintenanceResult,
  registrationModeSet,
]);

export const deviceMessage = z.discriminatedUnion("type", [ack, nack, stateReport, eventBadge, maintenanceAction]);

export type ServerMessage = z.infer<typeof serverMessage>;
export type DeviceMessage = z.infer<typeof deviceMessage>;
export type ServerMessageType = ServerMessage["type"];
export type DeviceMessageType = DeviceMessage["type"];

/** Server messages that must be acknowledged by the device and therefore go through the outbox. */
export const COMMAND_TYPES = [
  "room.status.set",
  "room.info.set",
  "display.config.set",
  "faculty.config.set",
  "faculty.content.set",
  "content.set",
  "reservations.set",
  "audio.settings.set",
  "announce.show",
  "announce.clear",
  "audio.play",
  "emergency.set",
  "emergency.clear",
  "access.acl.sync",
  "registration.mode.set",
] as const satisfies readonly ServerMessageType[];
export type CommandType = (typeof COMMAND_TYPES)[number];

export const isCommandType = (t: string): t is CommandType => (COMMAND_TYPES as readonly string[]).includes(t);

/** Payload type of a message type, e.g. `PayloadOf<"room.status.set">`. */
export type PayloadOf<T extends ServerMessageType | DeviceMessageType> = Extract<
  ServerMessage | DeviceMessage,
  { type: T }
>["payload"];
