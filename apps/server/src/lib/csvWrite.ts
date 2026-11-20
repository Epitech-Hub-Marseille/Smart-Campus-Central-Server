/**
 * Writes rows as CSV for a spreadsheet. A text that starts with `=`, `+`, `-` or `@` would be run as a formula by Excel
 * (campus names and message titles come from people), so it is prefixed with an apostrophe-like guard. `;` is the delimiter
 * because a French-locale Excel opens a comma-separated file as a single column.
 */
export type Cell = string | number | boolean | Date | null | undefined;

const DANGEROUS = /^[=+\-@\t\r]/;

function cell(value: Cell): string {
  if (value === null || value === undefined) return "";
  let text = value instanceof Date ? value.toISOString() : typeof value === "string" ? value : String(value);
  // Numbers and booleans are ours; only text can carry a formula.
  if (typeof value === "string" && DANGEROUS.test(text)) text = `'${text}`;
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: readonly string[], rows: readonly (readonly Cell[])[]): string {
  // A byte order mark makes Excel read the accents as UTF-8.
  return `﻿${[headers, ...rows].map((r) => r.map(cell).join(";")).join("\r\n")}\r\n`;
}
