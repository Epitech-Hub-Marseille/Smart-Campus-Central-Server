import { z } from "zod";
import { parseIcal } from "../../lib/ical.js";
import { fetchText } from "../http.js";
import { PortalError, type PortalEvent, type PortalPerson, type PortalPlugin } from "../types.js";

/**
 * Epitech "MY": the calendar export of the platform, an iCalendar file at
 * `https://my.epitech.eu/api/events/calendar/<token>?campus=<CAMPUS>`. The token in the address is the whole key, so the address
 * is a secret: kept encrypted, never returned, and the plugin only ever talks to `my.epitech.eu`.
 *
 * What the file carries is the title, the time, the room(s) and a description. It names no teachers or students, so the plugin
 * reads people from the file when it has them (organiser and attendee lines, or an email in the text) and otherwise returns none.
 */
const HOST = "my.epitech.eu";

const config = z.object({
  feedUrl: z
    .string()
    .trim()
    .url()
    .refine((u) => URL.canParse(u) && new URL(u).protocol === "https:" && new URL(u).hostname === HOST, `The address must be an https://${HOST}/ link`),
});
type Config = z.infer<typeof config>;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** "jane.doe" is "Jane Doe": enough to show someone whose email is all an event says about them. */
const nameFromEmail = (email: string) =>
  email
    .split("@")[0]!
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join(" ");

/** "[G-CPE-110] Kick-off - Setting Up" belongs to the module G-CPE-110. */
const moduleOf = (title: string) => /^\[([^\]]+)\]/.exec(title)?.[1]?.trim() ?? "";

export const epitechMy: PortalPlugin<Config> = {
  id: "epitech-my",
  label: "Epitech MY",
  description: "Events of the Epitech MY platform, from its calendar export link.",
  fields: [{ key: "feedUrl", label: "Calendar link", type: "url", secret: true, required: true, help: `The https://${HOST}/api/events/calendar/… link of the campus. Anyone with it can read the calendar, so it is stored encrypted.` }],
  parseConfig: (raw) => config.parse(raw),

  async fetchEvents({ feedUrl }, { from, to }, { fetch, timezone }) {
    const text = await fetchText(feedUrl, fetch);
    if (!text.includes("BEGIN:VCALENDAR")) throw new PortalError("The portal did not return a calendar: check the link");
    const out: PortalEvent[] = [];
    for (const e of parseIcal(text, timezone).events) {
      // The export holds the whole year: only what touches the window is worth keeping.
      if (e.end <= from || e.start >= to) continue;
      const people = new Map<string, PortalPerson>();
      const add = (p: PortalPerson) => people.set((p.email ?? p.name).toLowerCase(), p);
      for (const p of e.people) add(p);
      for (const email of `${e.summary}\n${e.description}`.match(EMAIL) ?? []) if (!people.has(email.toLowerCase())) add({ name: nameFromEmail(email), email: email.toLowerCase(), role: "attendee" });
      out.push({
        externalId: e.uid,
        title: e.summary || "(untitled)",
        description: e.description,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        cancelled: e.cancelled,
        locations: e.location.split(",").map((l) => l.trim()).filter(Boolean),
        people: [...people.values()],
        category: moduleOf(e.summary),
      });
    }
    return out;
  },
};
