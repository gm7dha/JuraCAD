/**
 * Tables on a drawing sheet from a CSV file (Onshape's "Insert table from
 * CSV"): reading the file, and checking a saved table. A table is a note
 * (DrawingNote.table), so it's placed, dragged and deleted like one.
 */

/** Most rows and columns a table keeps, and the most characters in a cell. */
export const MAX_TABLE_ROWS = 60;
export const MAX_TABLE_COLUMNS = 12;
export const MAX_CELL = 80;

/** Plain-English trouble reading a CSV file. */
export class CsvError extends Error {}

/**
 * Read CSV text (commas, or semicolons / tabs when the first line has more of
 * those; "quoted" cells may hold commas, line breaks and "" for a quote).
 * Empty lines are skipped; trailing empty cells dropped. Throws CsvError.
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const first = src.split("\n", 1)[0] ?? "";
  const count = (c: string) => first.split(c).length - 1;
  const sep = count(";") > count(",") && count(";") >= count("\t") ? ";" : count("\t") > count(",") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(cell);
    cell = "";
    while (row.length && !row[row.length - 1].trim()) row.pop();
    if (row.length) rows.push(row.map((c) => c.trim().slice(0, MAX_CELL)));
    row = [];
  };
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (ch === '"') quoted = false;
      else cell += ch === "\n" ? " " : ch;
      i++;
      continue;
    }
    if (ch === '"' && !cell.trim()) {
      quoted = true;
      cell = "";
    } else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") endRow();
    else cell += ch;
    i++;
  }
  if (cell || row.length) endRow();
  if (!rows.length) throw new CsvError("That file has nothing in it to put in a table.");
  if (rows.length > MAX_TABLE_ROWS) throw new CsvError(`That table has ${rows.length} rows; a drawing table can have up to ${MAX_TABLE_ROWS}.`);
  const cols = Math.max(...rows.map((r) => r.length));
  if (cols > MAX_TABLE_COLUMNS) throw new CsvError(`That table has ${cols} columns; a drawing table can have up to ${MAX_TABLE_COLUMNS}.`);
  return rows;
}

/** A saved table (null when it isn't one): rows of strings, within the limits. */
export function parseTable(raw: unknown): string[][] | null {
  if (!Array.isArray(raw)) return null;
  const rows = raw
    .slice(0, MAX_TABLE_ROWS)
    .filter((r): r is unknown[] => Array.isArray(r))
    .map((r) => r.slice(0, MAX_TABLE_COLUMNS).map((c) => (typeof c === "string" ? c.slice(0, MAX_CELL) : typeof c === "number" && Number.isFinite(c) ? String(c) : "")));
  return rows.length ? rows : null;
}
