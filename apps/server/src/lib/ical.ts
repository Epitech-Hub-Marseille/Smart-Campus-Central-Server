/**
 * A small iCalendar (RFC 5545) reader: what a portal's calendar export needs and nothing more. It reads events, with their
 * start and end (UTC, a local time in a named zone, or a whole day), location, description, organiser and attendees. It does not
 * expand recurrence rules (`RRULE`): an event that has one is reported in `skipped`, never guessed at.
 */

export interface IcalPerson {
  name: string;
  email: string | null;
  role: "organizer" | "attendee";
}

export interface IcalEvent {
  uid: string;
  summary: string;
  description: string;
  location: string;
  start: Date;
  end: Date;
  allDay: boolean;
  cancelled: boolean;
  people: IcalPerson[];
}

export interface IcalResult {
  name: string;
  events: IcalEvent[];
  /** Events that could not be used, with the reason: a calendar with one odd event still gives all the others. */
  skipped: { uid: string; reason: string }[];
}

interface Line {
  name: string;
  params: Map<string, string>;
  value: string;
}

/** Joins the folded lines (a line that starts with a space or a tab continues the previous one). */
const unfold = (text: string): string[] => text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");

/** Splits `NAME;PARAM=a;PARAM2="b;c":value`, honouring the quotes around a parameter value. */
function parseLine(raw: string): Line | null {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 1) return null;
  const head = raw.slice(0, colon);
  const parts: string[] = [];
  let current = "";
  inQuotes = false;
  for (const c of head) {
    if (c === '"') inQuotes = !inQuotes;
    if (c === ";" && !inQuotes) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  parts.push(current);
  const params = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq > 0) params.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1).replace(/^"|"$/g, ""));
  }
  return { name: parts[0]!.toUpperCase(), params, value: raw.slice(colon + 1) };
}

/** Text values escape backslash, comma, semicolon and newline. */
export const unescapeText = (value: string) => value.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));

/** The offset of a time zone from UTC at an instant, in milliseconds (positive east of Greenwich). */
function zoneOffset(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(instant));
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(instant / 1000) * 1000;
}

/** A wall-clock time in a zone, as the instant it is. Settled in two steps so the hour of a clock change comes out right. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = guess - zoneOffset(guess, zone);
  return guess - zoneOffset(first, zone);
}

const isZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** `20261026T093000Z`, `20261026T093000` (a local time) or `20261026` (a whole day). `defaultZone` is where local times are. */
function parseDate(line: Line, defaultZone: string): { at: Date; allDay: boolean } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(line.value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (m[4] === undefined) return { at: new Date(zonedToUtc(y, mo, d, 0, 0, 0, defaultZone)), allDay: true };
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6])];
  if (m[7]) return { at: new Date(Date.UTC(y, mo - 1, d, h, mi, s)), allDay: false };
  const tzid = line.params.get("TZID");
  return { at: new Date(zonedToUtc(y, mo, d, h, mi, s, tzid && isZone(tzid) ? tzid : defaultZone)), allDay: false };
}

const mailOf = (value: string) => {
  const m = /^mailto:(.+)$/i.exec(value.trim());
  return m ? m[1]!.trim().toLowerCase() : null;
};

function personOf(line: Line, role: IcalPerson["role"]): IcalPerson | null {
  const email = mailOf(line.value);
  const name = (line.params.get("CN") ?? "").trim();
  if (!name && !email) return null;
  return { name: name || email!.split("@")[0]!, email, role };
}

export function parseIcal(text: string, defaultZone = "UTC"): IcalResult {
  const result: IcalResult = { name: "", events: [], skipped: [] };
  let current: Line[] | null = null;
  for (const raw of unfold(text)) {
    if (!raw) continue;
    if (raw === "BEGIN:VEVENT") current = [];
    else if (raw === "END:VEVENT" && current) {
      const event = toEvent(current, defaultZone);
      if ("reason" in event) result.skipped.push(event);
      else result.events.push(event);
      current = null;
    } else {
      const line = parseLine(raw);
      if (!line) continue;
      if (current) current.push(line);
      else if (line.name === "X-WR-CALNAME") result.name = unescapeText(line.value).trim();
    }
  }
  return result;
}

function toEvent(lines: Line[], zone: string): IcalEvent | { uid: string; reason: string } {
  const first = (name: string) => lines.find((l) => l.name === name);
  const uid = first("UID")?.value.trim() ?? "";
  if (!uid) return { uid: "(none)", reason: "no UID" };
  if (first("RRULE")) return { uid, reason: "recurring events are not supported" };
  const startLine = first("DTSTART");
  const start = startLine && parseDate(startLine, zone);
  if (!start) return { uid, reason: "no readable start" };
  const endLine = first("DTEND");
  const durationLine = first("DURATION");
  let end = endLine ? parseDate(endLine, zone)?.at : undefined;
  if (!end && durationLine) {
    const d = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(durationLine.value.trim());
    if (d) end = new Date(start.at.getTime() + (Number(d[1] ?? 0) * 86_400 + Number(d[2] ?? 0) * 3_600 + Number(d[3] ?? 0) * 60 + Number(d[4] ?? 0)) * 1000);
  }
  // A whole-day event with no end lasts that day; a timed one with no end is a point, shown as a minute.
  end ??= new Date(start.at.getTime() + (start.allDay ? 86_400_000 : 60_000));
  if (end.getTime() <= start.at.getTime()) return { uid, reason: "the end is not after the start" };

  const people: IcalPerson[] = [];
  for (const l of lines) {
    const p = l.name === "ORGANIZER" ? personOf(l, "organizer") : l.name === "ATTENDEE" ? personOf(l, "attendee") : null;
    if (p) people.push(p);
  }
  return {
    uid,
    summary: unescapeText(first("SUMMARY")?.value ?? "").trim(),
    description: unescapeText(first("DESCRIPTION")?.value ?? "").trim(),
    location: unescapeText(first("LOCATION")?.value ?? "").trim(),
    start: start.at,
    end,
    allDay: start.allDay,
    cancelled: first("STATUS")?.value.trim().toUpperCase() === "CANCELLED",
    people,
  };
}
