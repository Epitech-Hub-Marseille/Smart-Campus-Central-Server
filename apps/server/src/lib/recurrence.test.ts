import { describe, expect, it } from "vitest";
import { localDay, nextOccurrence, zoneOffsetMs, zonedToUtc } from "./recurrence.js";

const PARIS = "Europe/Paris";
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const at = (s: string) => Date.parse(s);

describe("zones", () => {
  it("knows the offset in winter and summer", () => {
    expect(zoneOffsetMs(at("2026-01-15T12:00:00Z"), PARIS)).toBe(3_600_000);
    expect(zoneOffsetMs(at("2026-07-15T12:00:00Z"), PARIS)).toBe(7_200_000);
  });

  it("converts a wall-clock time to the right instant on both sides of a clock change", () => {
    expect(iso(zonedToUtc(2026, 3, 28, 8, 0, PARIS))).toBe("2026-03-28T07:00:00.000Z");
    expect(iso(zonedToUtc(2026, 3, 29, 8, 0, PARIS))).toBe("2026-03-29T06:00:00.000Z");
    expect(iso(zonedToUtc(2026, 10, 25, 8, 0, PARIS))).toBe("2026-10-25T07:00:00.000Z");
  });

  it("reads the local calendar day, which can differ from the UTC one", () => {
    expect(localDay(at("2026-11-06T23:30:00Z"), PARIS)).toEqual({ y: 2026, m: 11, d: 7 });
    expect(localDay(at("2026-11-07T00:30:00Z"), "America/New_York")).toEqual({ y: 2026, m: 11, d: 6 });
  });
});

describe("nextOccurrence", () => {
  const daily = { type: "daily", time: "08:00" } as const;

  it("is later today when the time has not come yet", () => {
    expect(iso(nextOccurrence(daily, at("2026-11-06T05:00:00Z"), PARIS))).toBe("2026-11-06T07:00:00.000Z");
  });

  it("is tomorrow once the time has passed, and strictly after the given instant", () => {
    expect(iso(nextOccurrence(daily, at("2026-11-06T09:00:00Z"), PARIS))).toBe("2026-11-07T07:00:00.000Z");
    expect(iso(nextOccurrence(daily, at("2026-11-06T07:00:00Z"), PARIS))).toBe("2026-11-07T07:00:00.000Z");
  });

  it("keeps 08:00 local across the spring and autumn clock changes", () => {
    expect(iso(nextOccurrence(daily, at("2026-03-28T07:00:00Z"), PARIS))).toBe("2026-03-29T06:00:00.000Z");
    expect(iso(nextOccurrence(daily, at("2026-10-24T06:00:00Z"), PARIS))).toBe("2026-10-25T07:00:00.000Z");
  });

  it("finds the next chosen weekday, skipping the others", () => {
    const monFri = { type: "weekly", time: "09:30", days: [1, 5] } as const;
    // Saturday 7 November 2026 -> Monday 9 November, 09:30 CET.
    expect(iso(nextOccurrence(monFri, at("2026-11-07T10:00:00Z"), PARIS))).toBe("2026-11-09T08:30:00.000Z");
    // Friday morning before the time: the same day.
    expect(iso(nextOccurrence(monFri, at("2026-11-06T06:00:00Z"), PARIS))).toBe("2026-11-06T08:30:00.000Z");
  });

  it("a single weekday that is today but already past comes back next week", () => {
    const friday = { type: "weekly", time: "09:30", days: [5] } as const;
    expect(iso(nextOccurrence(friday, at("2026-11-06T12:00:00Z"), PARIS))).toBe("2026-11-13T08:30:00.000Z");
  });

  it("has nothing to run without a day", () => {
    expect(nextOccurrence({ type: "weekly", time: "09:30", days: [] }, 0, PARIS)).toBeNull();
  });

  it("uses the campus zone, not the server's", () => {
    expect(iso(nextOccurrence(daily, at("2026-01-10T00:00:00Z"), "America/New_York"))).toBe("2026-01-10T13:00:00.000Z");
  });
});
