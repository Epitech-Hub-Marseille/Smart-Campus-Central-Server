export type Role = "admin" | "operator" | "staff";

export const ROLE_LABEL: Record<Role, string> = { admin: "Admin", operator: "Operator", staff: "Staff" };

/** A person can belong to several groups, e.g. a student who is also an operator. */
export type Group = "admin" | "operator" | "student";
export const GROUPS: Group[] = ["admin", "operator", "student"];
export const GROUP_LABEL: Record<Group, string> = { admin: "Administrator", operator: "Operator", student: "Student" };

export const ROOM_TYPES = ["classroom", "lecture_hall", "lab", "office", "meeting", "other"] as const;
export type RoomType = (typeof ROOM_TYPES)[number];
export const ROOM_TYPE_LABEL: Record<RoomType, string> = {
  classroom: "Classroom",
  lecture_hall: "Lecture hall",
  lab: "Lab",
  office: "Office",
  meeting: "Meeting room",
  other: "Other",
};

export interface Building {
  id: string;
  code: string;
  name: string;
  address: string;
  roomCount?: number;
}

export interface Room {
  id: string;
  /** Key of a RoomStatusDef. */
  status: string;
  statusSince: string | null;
  code: string;
  name: string;
  floor: number;
  capacity: number | null;
  type: RoomType;
  building: { id: string; code: string; name: string };
}

/** Mirrors SERVICES and AVAILABILITIES of @smartcampus/protocol. */
export const SERVICES = ["pedagogical", "administrative"] as const;
export type Service = (typeof SERVICES)[number];
export const SERVICE_LABEL: Record<Service, string> = { pedagogical: "Pedagogical", administrative: "Administrative" };

export const AVAILABILITIES = ["available", "busy", "away", "absent"] as const;
export type Availability = (typeof AVAILABILITIES)[number];
export const AVAILABILITY_LABEL: Record<Availability, string> = { available: "Available", busy: "Busy", away: "Away", absent: "Absent" };
/** Status dots. Chosen per meaning, like the room statuses: they are data, not chrome. */
export const AVAILABILITY_COLOR: Record<Availability, string> = { available: "#00a86b", busy: "#e5484d", away: "#f5a524", absent: "#8a9a92" };

export interface StaffMember {
  id: string;
  email: string | null;
  name: string;
  role: Role;
  groups: Group[];
  cardUid: string | null;
  department: string;
  /** Faculty directory: set to appear on the Faculty screens. */
  service: Service | null;
  jobTitle: string;
  phone: string;
  disabled: boolean;
  hasPassword: boolean;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export interface ImportResult {
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  errors: { line: number; message: string }[];
}

export const floorLabel = (f: number) => (f === 0 ? "Ground floor" : f < 0 ? `Basement ${-f}` : `Floor ${f}`);

export const DEVICE_TYPES = ["door", "display", "access"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];
export const DEVICE_TYPE_LABEL: Record<DeviceType, string> = {
  door: "Door unit",
  display: "Faculty display",
  access: "Access unit",
};

export interface Device {
  id: string;
  type: DeviceType;
  name: string;
  status: "active" | "revoked" | "pending" | "denied";
  fingerprint: string;
  /** Mongo id of the room this device is assigned to. */
  room: string | null;
  groups: string[];
  desired: Record<string, unknown>;
  reported: Record<string, unknown>;
  telemetry: Record<string, unknown>;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
}

/** A device asking to be connected, waiting for an admin or operator to approve or deny it. */
export interface EnrollmentRequest {
  id: string;
  type: DeviceType;
  name: string;
  fingerprint: string;
  ip: string | null;
  userAgent: string | null;
  requestedAt: string;
  expiresAt: string | null;
}

export interface DeviceCommand {
  id: string;
  type: string;
  payload: unknown;
  status: "pending" | "sent" | "acked" | "nacked" | "superseded";
  attempts: number;
  nackReason: string | null;
  createdAt: string;
  ackedAt: string | null;
}

export const formatFingerprint = (fp: string) => (fp.toUpperCase().match(/.{1,4}/g) ?? []).join(" ");

/** Where the device state differs from what was asked: the digital twin has not converged. */
export function computeDrift(d: Pick<Device, "desired" | "reported">): { key: string; desired: unknown; reported: unknown }[] {
  const drift: { key: string; desired: unknown; reported: unknown }[] = [];
  const desiredRoom = (d.desired.roomStatus as { status?: string } | undefined)?.status;
  if (desiredRoom !== undefined && desiredRoom !== d.reported.roomStatus) {
    drift.push({ key: "roomStatus", desired: desiredRoom, reported: d.reported.roomStatus });
  }
  if (d.desired.displayConfig !== undefined && JSON.stringify(d.desired.displayConfig) !== JSON.stringify(d.reported.displayConfig)) {
    drift.push({ key: "displayConfig", desired: d.desired.displayConfig, reported: d.reported.displayConfig });
  }
  return drift;
}

export const timeLeft = (iso: string | null): string => {
  if (!iso) return "";
  const m = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  return m <= 0 ? "expiring" : m < 60 ? `${m} min left` : `${Math.round(m / 60)} h left`;
};

export const timeAgo = (iso: string | null): string => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
};

// ---- Room statuses, announcements, audio, display config ----------------------------------

/** Mirrors STATUS_ICONS of @smartcampus/protocol (the package uses node:crypto, so the browser cannot import it). */
export const STATUS_ICONS = ["check", "user", "lock", "wrench", "calendar", "clock", "alert", "info", "book", "coffee", "ban", "wifi-off"] as const;
export type StatusIconName = (typeof STATUS_ICONS)[number];

export interface RoomStatusDef {
  key: string;
  label: string;
  color: string;
  icon: StatusIconName;
  builtIn: boolean;
}

export interface StatusChange {
  id: string;
  from: string;
  to: string;
  label: string;
  color: string;
  by: string;
  at: string;
}

export const ANNOUNCE_PRIORITIES = ["info", "important", "urgent"] as const;
export type AnnouncePriority = (typeof ANNOUNCE_PRIORITIES)[number];
export const PRIORITY_LABEL: Record<AnnouncePriority, string> = { info: "Info", important: "Important", urgent: "Urgent" };

export interface Targets {
  all?: boolean;
  devices?: string[];
  groups?: string[];
  buildings?: string[];
  floors?: { building: string; floor: number }[];
}

export interface Announcement {
  id: string;
  kind: "text" | "audio";
  assetId: string | null;
  title: string;
  text: string;
  priority: AnnouncePriority;
  targets: Targets;
  deviceCount: number;
  expiresAt: string | null;
  state: "active" | "expired" | "cancelled";
  createdBy: string;
  createdAt: string;
}

export interface Asset {
  id: string;
  name: string;
  kind: "audio" | "image" | "video";
  mime: string;
  size: number;
  sha256: string;
  /** One level of folders in the media library ("" is the root). */
  folder: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Image of a library file; `sha256` in the address makes the browser fetch it again after a replacement. */
export const assetUrl = (a: Pick<Asset, "id" | "sha256">) => `/api/assets/${a.id}/file?v=${a.sha256.slice(0, 8)}`;

export interface TimeWindow {
  enabled: boolean;
  from: string;
  to: string;
}

export interface DisplayConfig {
  layout: "standard" | "compact" | "split";
  theme: "dark" | "light";
  accentColor: string;
  show: { roomName: boolean; building: boolean; floor: boolean; capacity: boolean; clock: boolean; announcements: boolean; nextReservation: boolean };
  sleep: TimeWindow;
}

export const DEFAULT_DISPLAY_CONFIG: DisplayConfig = {
  layout: "standard",
  theme: "dark",
  accentColor: "#00a86b",
  show: { roomName: true, building: true, floor: true, capacity: true, clock: true, announcements: true, nextReservation: true },
  sleep: { enabled: false, from: "22:00", to: "06:00" },
};

export interface AudioSettings {
  volume: number;
  quietHours: TimeWindow;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = { volume: 80, quietHours: { enabled: false, from: "22:00", to: "06:00" } };

/** True when `now` falls in the window; a window whose start is after its end crosses midnight. */
export function isInWindow(w: TimeWindow, now: Date = new Date()): boolean {
  if (!w.enabled) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const from = toMinutes(w.from);
  const to = toMinutes(w.to);
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

export const formatBytes = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

// ---- Emergency alerts -----------------------------------------------------------------------

/** Mirrors EMERGENCY_KINDS of @smartcampus/protocol. Wording and colours come from GET /emergencies/catalogue. */
export const EMERGENCY_KINDS = ["fire", "biohazard", "nuclear", "bomb", "seismic", "power"] as const;
export type EmergencyKind = (typeof EMERGENCY_KINDS)[number];

export interface EmergencyInfo {
  kind: EmergencyKind;
  title: string;
  instructions: string;
  color: string;
  loud: boolean;
}

export interface Emergency {
  id: string;
  kind: EmergencyKind;
  title: string;
  instructions: string;
  testMode: boolean;
  testVolume: number;
  targets: Targets;
  deviceCount: number;
  status: "active" | "cleared";
  startedBy: string;
  startedAt: string;
  clearedBy: string | null;
  clearedAt: string | null;
  endMessage: string | null;
  endNoticeSeconds: number | null;
  voice: { status: "none" | "sent" | "failed" | "unavailable"; error: string | null };
}

/** Answer of the first step of a real alert. */
export interface EmergencyConfirmation {
  confirmation: string;
  expiresAt: string;
  deviceCount: number;
  title: string;
}

export interface EmergencyDelivery {
  deviceId: string;
  name: string;
  delivery: "pending" | "sent" | "acked" | "nacked" | "superseded";
  /** True when the screen itself reports showing this alert. */
  showing: boolean;
}

export interface RegistrationSession {
  id: string;
  deviceId: string;
  status: "active" | "closed";
  expiresAt: string;
  cards: { cardUid: string; scannedAt: string; ownerName: string | null }[];
}

/** Card serial numbers read as one hex string are easier to compare in pairs: 04 A2 2B 1C. */
export const formatCardUid = (uid: string) => (uid.match(/.{1,2}/g) ?? []).join(" ");

// ---- Voice, templates, schedules ---------------------------------------------------------------

export interface Voice {
  id: string;
  label: string;
  language: string;
}

export interface VoiceCatalogue {
  enabled: boolean;
  maxChars: number;
  voices: Voice[];
  /** Voice that reads emergencies aloud. */
  emergencyVoice: string | null;
}

/** "fr" -> "French", in the browser's language. */
export const languageName = (code: string) => new Intl.DisplayNames(undefined, { type: "language" }).of(code) ?? code;

export interface AnnouncementTemplate {
  id: string;
  name: string;
  kind: "text" | "voice";
  title: string;
  text: string;
  priority: AnnouncePriority;
  voice: string;
  createdBy: string;
  updatedAt: string;
}

export type ScheduleTrigger =
  | { type: "once"; at: string }
  | { type: "daily"; time: string }
  | { type: "weekly"; time: string; days: number[] }
  | { type: "status"; status: string; roomId?: string };

export interface Schedule {
  id: string;
  name: string;
  content: { kind: "text" | "voice"; title: string; text: string; priority: AnnouncePriority; voice: string; expiresAfterMinutes?: number };
  trigger: ScheduleTrigger;
  targets: Targets | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  runCount: number;
  createdBy: string;
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function describeTrigger(t: ScheduleTrigger, statusLabel: (key: string) => string = (k) => k): string {
  if (t.type === "once") return `Once, ${new Date(t.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
  if (t.type === "daily") return `Every day at ${t.time}`;
  if (t.type === "weekly") return `${t.days.map((d) => WEEKDAYS[d]!.slice(0, 3)).join(", ")} at ${t.time}`;
  return `When ${t.roomId ? "that room" : "a room"} becomes "${statusLabel(t.status)}"`;
}

// ---- Faculty and reservations ----------------------------------------------------------------

export interface NewsItem {
  id: string;
  title: string;
  text: string;
  priority: AnnouncePriority;
  publishedAt: string;
  expiresAt: string | null;
  expired: boolean;
  createdBy: string;
}

export interface StaffAvailability {
  id: string;
  name: string;
  jobTitle: string;
  service: Service | null;
  availability: Availability;
  note: string;
  until: string | null;
  updatedAt: string | null;
}

export interface Reservation {
  id: string;
  roomId: string;
  room: { code: string; name: string; building: string } | null;
  title: string;
  start: string;
  end: string;
  organizerId: string;
  organizer: string;
  status: "active" | "cancelled";
}

/** Value for an `<input type="datetime-local">` (local time, no zone) from a date. */
export const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

// ---- Faculty screens: groups, levels, scenes ------------------------------------------------------

export interface AssetPointer {
  assetId: string;
}

/** What a level of the hierarchy sets. A missing field is inherited from the level above. */
export interface FacultyConfigPatch {
  site?: { name?: string; subtitle?: string; zone?: string; assemblyPoint?: string; emergencyNumber?: string; logo?: AssetPointer | null };
  service?: "all" | Service;
  carousel?: { enabled?: boolean };
  widgets?: { clock?: boolean; date?: boolean; weather?: boolean };
  weather?: { label: string; latitude: number; longitude: number } | null;
}

export interface FacultyDefaults {
  site: { name: string; subtitle: string; zone: string; assemblyPoint: string; emergencyNumber: string; logo: null };
  service: "all" | Service;
  carousel: { enabled: boolean };
  widgets: { clock: boolean; date: boolean; weather: boolean };
  weather: null;
}

export type FieldType = "text" | "longtext" | "url" | "number" | "boolean" | "select" | "asset";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  help?: string;
  max?: number;
  min?: number;
  options?: { value: string; label: string }[];
  accept?: "image" | "video";
  default?: string | number | boolean;
}

export interface TileKindDef {
  kind: string;
  label: string;
  description: string;
  group: "board" | "media" | "live";
  audible: boolean;
  fields: FieldDef[];
}

export interface LayoutDef {
  label: string;
  columns: string;
  rows: string;
  /** Grid lines per tile: [row start, column start, row end, column end]. */
  tiles: [number, number, number, number][];
}

export interface TileKinds {
  kinds: TileKindDef[];
  layouts: Record<string, LayoutDef>;
  limits: { scenes: number; tiles: number };
  defaults: FacultyDefaults;
}

export interface Tile {
  id: string;
  kind: string;
  settings: Record<string, unknown>;
}

export interface Scene {
  id: string;
  name: string;
  layout: string;
  durationSeconds: number;
  enabled: boolean;
  startsAt?: number;
  endsAt?: number;
  tiles: Tile[];
}

export type ScopeKind = "default" | "group" | "device";

export interface ScreenGroup {
  id: string;
  name: string;
  description: string;
  members: string[];
  own: { config: boolean; playlist: boolean };
}

export interface ScreenSummary {
  id: string;
  name: string;
  online: boolean;
  groupId: string | null;
  own: { config: boolean; playlist: boolean };
}

export interface ScreensOverview {
  default: { config: boolean; playlist: boolean };
  groups: ScreenGroup[];
  displays: ScreenSummary[];
}

export type PlaylistSource = "device" | "group" | "default" | "builtin";

/** One level, with what it sets and what it inherits from above. */
export interface ScopeView {
  scope: ScopeKind;
  key: string;
  name: string;
  screens: number | null;
  group: { id: string; name: string } | null;
  config: FacultyConfigPatch;
  scenes: Scene[] | null;
  inherited: { config: FacultyConfigPatch; scenes: { from: PlaylistSource; items: Scene[] } };
}

export interface AssetUse {
  scope: ScopeKind;
  key: string;
  name: string;
  as: "logo" | "tile";
}
