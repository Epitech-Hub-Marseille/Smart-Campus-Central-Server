import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { epitechMy } from "./epitechMy.js";
import { PortalError } from "../types.js";

const FEED = "https://my.epitech.eu/api/events/calendar/00000000-0000-4000-8000-000000000000?campus=MAR";

const calendar = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:Epitech/My
X-WR-CALNAME:my - MAR
BEGIN:VEVENT
SUMMARY:[G-CPE-110] Bootstrap - Setting Up
UID:10693
DTSTART;VALUE=DATE-TIME:20261026T130000Z
DTEND;VALUE=DATE-TIME:20261026T160000Z
DESCRIPTION:Contact jane.doe@epitech.eu for the project.
LOCATION:Pédagogie 1-8\\, Réunion 1-2 D
END:VEVENT
BEGIN:VEVENT
SUMMARY:[Réservation de salles] Intervenants devfest
UID:27274
DTSTART;VALUE=DATE-TIME:20261112T130000Z
DTEND;VALUE=DATE-TIME:20261112T180000Z
LOCATION:
END:VEVENT
BEGIN:VEVENT
SUMMARY:Next year
UID:99
DTSTART;VALUE=DATE-TIME:20270512T130000Z
DTEND;VALUE=DATE-TIME:20270512T180000Z
END:VEVENT
END:VCALENDAR
`;

const serve = (body: string, init: ResponseInit = { status: 200 }) => (async () => new Response(body, init)) as unknown as typeof fetch;
const context = (fetchImpl: typeof fetch) => ({ fetch: fetchImpl, timezone: "Europe/Paris" });
const window = { from: new Date("2026-10-26T00:00:00Z"), to: new Date("2026-11-30T00:00:00Z") };

describe("the Epitech MY plugin", () => {
  it("accepts only an https my.epitech.eu link", () => {
    expect(epitechMy.parseConfig({ feedUrl: FEED }).feedUrl).toBe(FEED);
    for (const feedUrl of ["http://my.epitech.eu/x", "https://evil.example/api/events/calendar/x", "https://my.epitech.eu.evil.example/x", "not a url"]) {
      expect(() => epitechMy.parseConfig({ feedUrl }), feedUrl).toThrow(ZodError);
    }
  });

  it("returns the events of the window with their rooms, module and the people it can find", async () => {
    const events = await epitechMy.fetchEvents({ feedUrl: FEED }, window, context(serve(calendar)));
    expect(events.map((e) => e.externalId)).toEqual(["10693", "27274"]);
    expect(events[0]).toMatchObject({
      title: "[G-CPE-110] Bootstrap - Setting Up",
      category: "G-CPE-110",
      locations: ["Pédagogie 1-8", "Réunion 1-2 D"],
      people: [{ name: "Jane Doe", email: "jane.doe@epitech.eu", role: "attendee" }],
    });
    expect(events[1]).toMatchObject({ locations: [], people: [], category: "Réservation de salles" });
  });

  it("explains a refusal or a wrong answer without ever repeating the link", async () => {
    for (const [fetchImpl, message] of [
      [serve("", { status: 404 }), /refused the request \(404\)/],
      [serve("", { status: 500 }), /answered 500/],
      [serve("", { status: 302, headers: { location: "https://elsewhere.example/" } }), /redirected/],
      [serve("<html>login</html>"), /did not return a calendar/],
      [(async () => { throw new Error(`connect ECONNREFUSED ${FEED}`); }) as unknown as typeof fetch, /could not be reached/],
    ] as const) {
      const error = await epitechMy.fetchEvents({ feedUrl: FEED }, window, context(fetchImpl)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PortalError);
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toContain("00000000");
    }
  });
});
