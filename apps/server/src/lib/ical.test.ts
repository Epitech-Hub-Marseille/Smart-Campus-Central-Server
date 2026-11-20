import { describe, expect, it } from "vitest";
import { parseIcal, unescapeText } from "./ical.js";

const wrap = (...events: string[]) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:my - MAR \r\n${events.map((e) => `BEGIN:VEVENT\r\n${e}\r\nEND:VEVENT`).join("\r\n")}\r\nEND:VCALENDAR\r\n`;

describe("parseIcal", () => {
  it("reads a UTC event with its escaped text and folded lines", () => {
    const { events, name } = parseIcal(
      wrap("SUMMARY:[G-CPE-110] Bootstrap - Setting Up\r\nUID:10693\r\nDTSTART;VALUE=DATE-TIME:20261026T130000Z\r\nDTEND;VALUE=DATE-TIME:20261026T160000Z\r\nLOCATION:Réunion 1-2 D\\, Réunion 1-2 G\r\nDESCRIPTION:Work on the key aspect\\nIn the end\\, you should\r\n  have a start"),
    );
    expect(name).toBe("my - MAR");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      uid: "10693",
      summary: "[G-CPE-110] Bootstrap - Setting Up",
      location: "Réunion 1-2 D, Réunion 1-2 G",
      description: "Work on the key aspect\nIn the end, you should have a start",
      allDay: false,
      cancelled: false,
    });
    expect(events[0]!.start.toISOString()).toBe("2026-10-26T13:00:00.000Z");
    expect(events[0]!.end.toISOString()).toBe("2026-10-26T16:00:00.000Z");
  });

  it("places a local time in its zone, summer and winter", () => {
    const { events } = parseIcal(
      wrap(
        "UID:a\r\nSUMMARY:s\r\nDTSTART;TZID=Europe/Paris:20260715T090000\r\nDTEND;TZID=Europe/Paris:20260715T100000",
        "UID:b\r\nSUMMARY:w\r\nDTSTART;TZID=Europe/Paris:20261215T090000\r\nDTEND;TZID=Europe/Paris:20261215T100000",
        "UID:c\r\nSUMMARY:floating\r\nDTSTART:20261215T090000\r\nDURATION:PT45M",
      ),
      "Europe/Paris",
    );
    expect(events.map((e) => e.start.toISOString())).toEqual(["2026-07-15T07:00:00.000Z", "2026-12-15T08:00:00.000Z", "2026-12-15T08:00:00.000Z"]);
    expect(events[2]!.end.toISOString()).toBe("2026-12-15T08:45:00.000Z");
  });

  it("reads a whole-day event, a cancelled event and the organiser and attendees", () => {
    const { events } = parseIcal(
      wrap(
        'UID:d\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20261101\r\nDTEND;VALUE=DATE:20261102\r\nSTATUS:CANCELLED\r\nORGANIZER;CN="Doe, Jane":mailto:Jane.Doe@epitech.eu\r\nATTENDEE;CN=Sam Roe;ROLE=REQ-PARTICIPANT:mailto:sam.roe@epitech.eu\r\nATTENDEE:mailto:nobody@example.org',
      ),
      "Europe/Paris",
    );
    expect(events[0]).toMatchObject({ allDay: true, cancelled: true });
    expect(events[0]!.start.toISOString()).toBe("2026-10-31T23:00:00.000Z");
    expect(events[0]!.people).toEqual([
      { name: "Doe, Jane", email: "jane.doe@epitech.eu", role: "organizer" },
      { name: "Sam Roe", email: "sam.roe@epitech.eu", role: "attendee" },
      { name: "nobody", email: "nobody@example.org", role: "attendee" },
    ]);
  });

  it("skips what it cannot use and still gives the rest", () => {
    const { events, skipped } = parseIcal(
      wrap("UID:ok\r\nSUMMARY:ok\r\nDTSTART:20261026T093000Z\r\nDTEND:20261026T100000Z", "SUMMARY:no uid\r\nDTSTART:20261026T093000Z", "UID:r\r\nDTSTART:20261026T093000Z\r\nRRULE:FREQ=DAILY", "UID:bad\r\nDTSTART:soon", "UID:back\r\nDTSTART:20261026T100000Z\r\nDTEND:20261026T093000Z"),
    );
    expect(events.map((e) => e.uid)).toEqual(["ok"]);
    expect(skipped.map((s) => [s.uid, s.reason])).toEqual([
      ["(none)", "no UID"],
      ["r", "recurring events are not supported"],
      ["bad", "no readable start"],
      ["back", "the end is not after the start"],
    ]);
  });

  it("unescapes text", () => {
    expect(unescapeText("a\\, b\; c\\\\ d\\ne")).toBe("a, b; c\\ d\ne");
  });
});
