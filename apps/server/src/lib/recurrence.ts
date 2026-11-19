/**
 * Calendar maths for schedules, in the campus time zone. Pure functions, no clock and no database,
 * so the daylight-saving cases can be tested.
 */

export interface RecurringTrigger {
  type: "daily" | "weekly";
  /** Local wall-clock time, "HH:MM". */
  time: string;
  /** Weekly only: 0 = Sunday ... 6 = Saturday. */
  days?: number[];
}

/** Offset of `timeZone` from UTC at `at`, in milliseconds (positive east of Greenwich). */
export function zoneOffsetMs(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The instant at which the wall clock of `timeZone` reads y-m-d h:m. */
export function zonedToUtc(y: number, m: number, d: number, h: number, min: number, timeZone: string): number {
  const naive = Date.UTC(y, m - 1, d, h, min);
  // The offset depends on the instant we are looking for, so settle it in two passes (covers DST changes).
  const first = naive - zoneOffsetMs(naive, timeZone);
  return naive - zoneOffsetMs(first, timeZone);
}

/** Calendar day (y, m, d) of an instant in `timeZone`. */
export function localDay(at: number, timeZone: string): { y: number; m: number; d: number } {
  const offset = zoneOffsetMs(at, timeZone);
  const date = new Date(at + offset);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

const parseTime = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return { h: h!, m: m! };
};

/** First occurrence strictly after `after` (ms), or null when the trigger has no valid day. */
export function nextOccurrence(trigger: RecurringTrigger, after: number, timeZone: string): number | null {
  const days = trigger.type === "weekly" ? new Set(trigger.days ?? []) : null;
  if (days && days.size === 0) return null;
  const { h, m } = parseTime(trigger.time);
  const start = localDay(after, timeZone);

  // A week and a day always contain a match; the extra day covers "today, but already past".
  for (let i = 0; i <= 8; i++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    if (days && !days.has(day.getUTCDay())) continue;
    const at = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, m, timeZone);
    if (at > after) return at;
  }
  return null;
}
