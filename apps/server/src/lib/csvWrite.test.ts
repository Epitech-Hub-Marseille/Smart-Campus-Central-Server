import { describe, expect, it } from "vitest";
import { parseTable } from "./csv.js";
import { toCsv } from "./csvWrite.js";

describe("toCsv", () => {
  it("quotes delimiters, quotes and newlines, and can be read back by the importer's parser", () => {
    const text = toCsv(["name", "note"], [["Room; A", 'say "hi"\nthere'], ["B", null]]);
    const { rows } = parseTable(text);
    expect(rows.map((r) => r.data)).toEqual([
      { name: "Room; A", note: 'say "hi"\nthere' },
      { name: "B", note: "" },
    ]);
  });

  it("starts with a byte order mark and uses CRLF", () => {
    const text = toCsv(["a"], [["x"]]);
    expect(text.startsWith("﻿a\r\n")).toBe(true);
    expect(text.endsWith("x\r\n")).toBe(true);
  });

  it("defuses text that a spreadsheet would run as a formula, but leaves numbers alone", () => {
    const text = toCsv(["v"], [['=HYPERLINK("http://evil")'], ["+1"], ["@SUM(A1)"], [-5], ["ok"]]);
    const lines = text.split("\r\n");
    expect(lines[1]).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(lines[2]).toBe("'+1");
    expect(lines[3]).toBe("'@SUM(A1)");
    expect(lines[4]).toBe("-5");
    expect(lines[5]).toBe("ok");
  });

  it("writes dates as ISO strings and booleans as text", () => {
    expect(toCsv(["d", "b"], [[new Date("2026-11-20T10:00:00Z"), true]])).toContain("2026-11-20T10:00:00.000Z;true");
  });
});
