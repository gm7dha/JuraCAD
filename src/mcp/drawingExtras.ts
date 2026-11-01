/**
 * More of Claude's drawing tools: sheets (add one — of the same part, or of
 * another part or assembly — and remove one), notes and drawing symbols
 * (datum, geometric tolerance frame, surface finish), and deleting a
 * dimension or a note. The same pure drawing edits as the app's drawing tab
 * (src/drawing), so what Claude makes opens there just the same.
 */
import { putNote, removeDimension, removeNote, updateDrawing } from "../drawing/drawing";
import { addPage, addedSheetMessage, changePage, pageIds, pageOf, removePage } from "../drawing/pages";
import { SHEETS, toSheet } from "../drawing/sheet";
import { GDT_CHARACTERISTICS, nextDatumLetter } from "../drawing/symbols";
import { newId } from "../model/document";
import type { Drawing, DrawingNote, DrawingSymbol, GdtCharacteristic } from "../model/types";
import { amount, bool, InputError, list, noExtras, object, oneOf, text } from "./args";
import { assembliesOf } from "./assemblyTools";
import { commitDrawing, DRAWING_REF, findDrawing, pageIdFor, SHEET_REF, sheetLines, sheetOf, sourceFrom, viewKeyFor, viewName, viewPoint } from "./drawingTools";
import type { Session } from "./session";
import { say, type ToolDef } from "./toolKit";

type P2 = [number, number];
const round1 = (v: number) => Math.round(v * 10) / 10;

/** The name of the part or assembly a sheet draws (null for none). */
function bareName(s: Session, src: Drawing["source"] | undefined): string | null {
  if (!src) return null;
  if (src.kind === "assembly") return assembliesOf(s.doc).find((a) => a.id === src.id)?.name ?? "?";
  return s.buildAll().parts.find((p) => p.id === src.id)?.name ?? "?";
}
const sourceName = (s: Session, src: Drawing["source"] | undefined) => (src ? `${src.kind} "${bareName(s, src)}"` : "nothing chosen yet");

const CHARACTERISTICS = GDT_CHARACTERISTICS.map((c) => c.key);
/** Words Claude may use for a characteristic (any capitals, spaces or underscores). */
const characteristicOf = (raw: unknown, where: string): GdtCharacteristic => {
  const v = typeof raw === "string" ? raw.trim().toLowerCase().replace(/[\s_-]+/g, "") : "";
  const hit = GDT_CHARACTERISTICS.find((c) => c.key.toLowerCase() === v || c.label.toLowerCase().replace(/[\s_-]+/g, "") === v);
  if (!hit) throw new InputError(`${where} must be one of ${CHARACTERISTICS.map((c) => `"${c}"`).join(", ")} (got ${JSON.stringify(raw)}).`);
  return hit.key;
};

/** A drawing symbol as Claude describes it. */
function symbolOf(raw: unknown, notes: DrawingNote[]): DrawingSymbol {
  const o = object(raw, "symbol");
  const kind = oneOf(o.kind, ["datum", "gdt", "finish"] as const, "symbol.kind");
  if (kind === "datum") {
    noExtras(o, ["kind", "letter"], "symbol (datum)");
    const letter = o.letter === undefined ? nextDatumLetter(notes) : text(o.letter, "symbol.letter").toUpperCase();
    if (!/^[A-Z]{1,2}$/.test(letter)) throw new InputError('symbol.letter should be a capital letter, e.g. "A".');
    if (notes.some((n) => n.symbol?.kind === "datum" && n.symbol.letter === letter)) throw new InputError(`There's already a datum ${letter} on this drawing. Choose another letter (or leave "letter" out for the next free one).`);
    return { kind: "datum", letter };
  }
  if (kind === "finish") {
    noExtras(o, ["kind", "ra", "machined"], "symbol (finish)");
    const ra = o.ra === undefined ? "3.2" : String(typeof o.ra === "number" ? o.ra : text(o.ra, "symbol.ra"));
    if (!/^\d+(\.\d+)?$/.test(ra)) throw new InputError('symbol.ra is the roughness in µm, e.g. 3.2 or 0.8.');
    return { kind: "finish", ra, ...(bool(o.machined, "symbol.machined") ? { machined: true } : {}) };
  }
  noExtras(o, ["kind", "characteristic", "tolerance", "diameter", "datums"], "symbol (gdt)");
  const characteristic = characteristicOf(o.characteristic, "symbol.characteristic");
  const tol = o.tolerance === undefined ? "0.1" : String(typeof o.tolerance === "number" ? o.tolerance : text(o.tolerance, "symbol.tolerance"));
  if (!/^\d+(\.\d+)?$/.test(tol)) throw new InputError("symbol.tolerance is the tolerance zone's size in mm, e.g. 0.05.");
  const wantsDatums = GDT_CHARACTERISTICS.find((c) => c.key === characteristic)!.datums;
  const datums = list(o.datums, "symbol.datums", { allowEmpty: true }).map((d, i) => text(d, `symbol.datums[${i}]`).toUpperCase());
  if (datums.length > 3) throw new InputError("symbol.datums: at most three (primary, secondary, tertiary).");
  if (!wantsDatums && datums.length) throw new InputError(`${characteristic} is a form tolerance: it isn't measured from datums, so leave "datums" out.`);
  return { kind: "fcf", characteristic, tolerance: tol, ...(bool(o.diameter, "symbol.diameter") ? { diameter: true } : {}), datums };
}

export const DRAWING_EXTRA_TOOLS: ToolDef[] = [
  {
    name: "add_sheet",
    title: "Add a sheet to a drawing",
    description:
      'Add a sheet after the last one, the same paper size as sheet 1. With "part" or "assembly" it draws that, starting with the usual views (front, top, right, 3D) and its own title and part number (a sheet of the drawing\'s own part shares sheet 1\'s title block); without, it\'s an empty sheet of the drawing\'s part — add views with edit_drawing {"sheet": n, "views": […]}. Every tool takes "sheet" to work on it.',
    inputSchema: { type: "object", properties: { drawing: DRAWING_REF, part: { type: "string" }, assembly: { type: "string" } } },
    run: async (s, a) => {
      noExtras(a, ["drawing", "part", "assembly"], "add_sheet");
      const d = findDrawing(s, a.drawing);
      if (pageIds(d).length >= 50) throw new InputError(`${d.name} already has 50 sheets: that's the most.`);
      const source = sourceFrom(s, a) ?? undefined;
      const id = newId("pg");
      const changed = addPage(d, id, pageIds(d)[0], source);
      const n = pageIds(changed).length;
      const sh = await commitDrawing(s, updateDrawing(s.doc, d.id, () => changed), changed, id, `add sheet ${n}`);
      return say(addedSheetMessage(d, n, source, bareName(s, source)).replace(/ in the panel on the left| under Title block/, ""), ...sheetLines(s, changed, sh));
    },
  },
  {
    name: "remove_sheet",
    title: "Remove a sheet from a drawing",
    description: 'Remove a sheet ("sheet": its number) and everything on it. The sheets after it move up one. A drawing keeps at least one sheet (delete the whole drawing in the app instead).',
    destructive: true,
    inputSchema: { type: "object", properties: { drawing: DRAWING_REF, sheet: SHEET_REF }, required: ["sheet"] },
    run: async (s, a) => {
      noExtras(a, ["drawing", "sheet"], "remove_sheet");
      const d = findDrawing(s, a.drawing);
      if (a.sheet === undefined) throw new InputError("sheet: say which sheet to remove (1, 2…).");
      const pageId = pageIdFor(d, a.sheet);
      if (pageIds(d).length === 1) throw new InputError(`${d.name} has only one sheet, and a drawing keeps at least one. Nothing was changed.`);
      const changed = removePage(d, pageId);
      const first = pageIds(changed)[0];
      await commitDrawing(s, updateDrawing(s.doc, d.id, () => changed), changed, first, `remove sheet ${a.sheet}`);
      const left = pageIds(changed).length;
      return say(`Removed sheet ${a.sheet} of ${d.name}; it has ${left} sheet${left === 1 ? "" : "s"} now.`, ...pageIds(changed).map((id, i) => `- Sheet ${i + 1}: ${sourceName(s, pageOf(changed, id).source)}, ${pageOf(changed, id).views.length} views`));
    },
  },
  {
    name: "add_drawing_note",
    title: "Add a note or symbol to a drawing",
    description:
      `Add a note or a drawing symbol to a sheet. "text": a note (several lines with \\n). "symbol": {"kind": "datum", "letter": "A"} (a datum feature symbol; letter default the next free one), {"kind": "gdt", "characteristic": one of ${CHARACTERISTICS.join(", ")}, "tolerance": 0.05, "diameter": true for a round zone, "datums": ["A", "B"]} (a geometric tolerance frame), or {"kind": "finish", "ra": 1.6, "machined": true} (a surface finish mark). "pointing_at": {"view": "front", "point": [x, y, z]} draws a leader to that point (a model point seen from the view, or [across, up] in the view's own mm; symbols usually have one). "at": [x, y] where it goes, in sheet mm from the paper's bottom-left corner (its top-left corner for a note); default a little up and right of what it points at, or bottom-left of the sheet. Weld symbols aren't in JuraCAD yet.`,
    inputSchema: {
      type: "object",
      properties: { drawing: DRAWING_REF, sheet: SHEET_REF, text: { type: "string" }, symbol: { type: "object" }, pointing_at: { type: "object" }, at: { type: "array", items: {} } },
    },
    run: async (s, a) => {
      noExtras(a, ["drawing", "sheet", "text", "symbol", "pointing_at", "at"], "add_drawing_note");
      const d = findDrawing(s, a.drawing);
      const pageId = pageIdFor(d, a.sheet);
      if ((a.text === undefined) === (a.symbol === undefined)) throw new InputError('Give either "text" (a note) or "symbol" (a datum, gdt or finish symbol).');
      const allNotes = pageIds(d).flatMap((id) => pageOf(d, id).notes ?? []);
      const symbol = a.symbol === undefined ? undefined : symbolOf(a.symbol, allNotes);
      const words = a.text === undefined ? "" : text(a.text, "text").slice(0, 2000);
      const page = pageOf(d, pageId);
      const [W, H] = SHEETS[page.sheet];
      let leader: P2 | undefined;
      if (a.pointing_at !== undefined) {
        const o = object(a.pointing_at, "pointing_at");
        noExtras(o, ["view", "point"], "pointing_at");
        const sh = await sheetOf(s, d, pageId);
        const key = viewKeyFor(sh.page, o.view, "pointing_at.view");
        const placed = sh.layout.views.find((v) => v.key === key);
        const p = sh.projections[key];
        if (!placed || !p?.bounds) throw new InputError(`pointing_at: ${viewName(sh.page, key)} has nothing drawn on it.`);
        if (key === "iso") throw new InputError("pointing_at: give a point on a flat view (front, top, a side…), not the 3D view.");
        const q = viewPoint(sh.page, key, sh.projections, o.point, s, "pointing_at.point");
        const at = toSheet(placed, p, placed.scale, q[0], q[1]);
        const [x0, y0, x1, y1] = placed.box;
        if (at[0] < x0 - 1 || at[0] > x1 + 1 || at[1] < y0 - 1 || at[1] > y1 + 1) throw new InputError(`pointing_at: (${q.map(round1).join(", ")}) is outside ${viewName(sh.page, key)} (describe_drawing gives its extent). Point at something on the view.`);
        leader = [round1(at[0]), round1(at[1])];
      }
      let at: P2;
      if (a.at !== undefined) {
        if (!Array.isArray(a.at) || a.at.length !== 2) throw new InputError("at should be [x, y] in sheet mm from the paper's bottom-left corner, e.g. [20, 40].");
        at = [round1(amount(a.at[0], "at[0]", s.scope()).value), round1(amount(a.at[1], "at[1]", s.scope()).value)];
      } else if (leader) at = [round1(Math.min(W - 30, leader[0] + 12)), round1(Math.min(H - 10, leader[1] + 12))];
      else at = [20, 20 + 5 * Math.max(1, words.split("\n").length)];
      if (at[0] < 0 || at[0] > W || at[1] < 0 || at[1] > H) throw new InputError(`at (${at.join(", ")}) is off the paper: ${page.sheet} is ${W} × ${H} mm.`);
      const note: DrawingNote = { id: newId("nt"), at, text: words, ...(symbol ? { symbol } : {}), ...(leader ? { leader } : {}) };
      const changed = changePage(d, pageId, (p) => putNote(p, note));
      const sh = await commitDrawing(s, updateDrawing(s.doc, d.id, () => changed), changed, pageId, "add it");
      const n = (sh.page.notes ?? []).length;
      return say(`Added ${symbol ? (symbol.kind === "fcf" ? "a geometric tolerance frame" : symbol.kind === "datum" ? `datum ${symbol.letter}` : "a surface finish mark") : "a note"} (N${n}) at (${at.join(", ")})${leader ? `, its leader pointing to (${leader.join(", ")})` : ""}.`, "Look at the sheet with view_drawing.");
    },
  },
  {
    name: "delete_drawing_item",
    title: "Delete a dimension or note from a drawing",
    description: 'Delete dimensions and notes/symbols from a sheet, by the numbers describe_drawing gives them: "dimensions": ["D2", "D5"] and/or "notes": ["N1"]. The others keep their places (their numbers close up).',
    destructive: true,
    inputSchema: { type: "object", properties: { drawing: DRAWING_REF, sheet: SHEET_REF, dimensions: { type: "array", items: { type: "string" } }, notes: { type: "array", items: { type: "string" } } } },
    run: async (s, a) => {
      noExtras(a, ["drawing", "sheet", "dimensions", "notes"], "delete_drawing_item");
      const d = findDrawing(s, a.drawing);
      const pageId = pageIdFor(d, a.sheet);
      const page = pageOf(d, pageId);
      if (a.dimensions === undefined && a.notes === undefined) throw new InputError('Give "dimensions" (e.g. ["D2"]) and/or "notes" (e.g. ["N1"]) — describe_drawing numbers them.');
      const pick = <T extends { id: string }>(raw: unknown, items: T[], letter: "D" | "N", where: string): T[] =>
        list(raw, where, { allowEmpty: true }).map((r, i) => {
          const m = typeof r === "string" ? new RegExp(`^\\s*${letter}?(\\d+)\\s*$`, "i").exec(r) : typeof r === "number" ? [String(r), String(r)] : null;
          const n = m ? Number(m[1]) : NaN;
          if (!(n >= 1 && n <= items.length)) throw new InputError(`${where}[${i}]: ${JSON.stringify(r)} isn't one of this sheet's ${where} (${items.length ? `${letter}1 to ${letter}${items.length}` : "it has none"}). describe_drawing numbers them.`);
          return items[n - 1];
        });
      const dims = pick(a.dimensions, page.dimensions ?? [], "D", "dimensions");
      const notes = pick(a.notes, page.notes ?? [], "N", "notes");
      if (!dims.length && !notes.length) throw new InputError("Nothing to delete: the lists are empty.");
      const changed = changePage(d, pageId, (p) => notes.reduce((acc, x) => removeNote(acc, x.id), dims.reduce((acc, x) => removeDimension(acc, x.id), p)));
      const sh = await commitDrawing(s, updateDrawing(s.doc, d.id, () => changed), changed, pageId, "delete them");
      const parts = [dims.length && `${dims.length} dimension${dims.length === 1 ? "" : "s"}`, notes.length && `${notes.length} note${notes.length === 1 ? "" : "s"}`].filter(Boolean);
      return say(`Deleted ${parts.join(" and ")} from ${d.name}${pageIds(d).length > 1 ? `, sheet ${pageIds(d).indexOf(pageId) + 1}` : ""}.`, ...sheetLines(s, changed, sh));
    },
  },
];
