/**
 * A drawing sheet worked out as simple shapes — lines and text in sheet
 * millimetres (from the bottom-left corner, y up). The screen, the SVG file
 * and the PDF file are all drawn from this one list, so they always match.
 *
 * Layout follows ISO first-angle projection (as used in the UK and Europe):
 * the view from the top goes below the front view, the view from the right
 * goes to its left — or, when the drawing asks for it, third-angle (US/ANSI):
 * the top view above the front, the right view to its right.
 */
import { clipOut, cutsOn, removed, SHORT_GAP, squeeze, unsqueeze } from "./shorten";
import { lengthNumber, lengthUnit } from "../model/units";
import type { ViewProjection } from "../kernel/protocol";
import type { Dimension, Drawing, SectionCut, SheetSize, ViewKind } from "../model/types";
import { centreLines, centreMarks, hatchLines, placeBalloons } from "./annotations";
import { holeRows, holeTableView, type HoleRow } from "./holeTable";
import { projectPoint } from "./cameras";
import { fromRel, sectionGeometry, sectionTitle, viewKey } from "./sections";
import { drawDimension, measureDim, resolveDim, type DimStyle } from "./dimensions";
import { calloutText, threadSymbols, type TapSize } from "./holeCallouts";
import { symbolPrims } from "./symbols";
import { clipToCircle } from "./details";
import { textWidth } from "./export";

/** "centre" is the long-and-short dashed line for centre lines and cutting planes. */
export type LineStyle = "border" | "visible" | "hidden" | "thin" | "centre";

export type Prim =
  | { kind: "path"; points: number[]; closed?: boolean; fill?: boolean; style: LineStyle }
  | { kind: "text"; x: number; y: number; text: string; size: number; anchor: "start" | "middle" | "end"; bold?: boolean; rotate?: number };

export const SHEETS: Record<SheetSize, [number, number]> = {
  A4: [297, 210],
  A3: [420, 297],
  A2: [594, 420],
  A1: [841, 594],
  A0: [1189, 841],
  "ANSI A": [279.4, 215.9],
  "ANSI B": [431.8, 279.4],
  "ANSI C": [558.8, 431.8],
  "ANSI D": [863.6, 558.8],
  "ANSI E": [1117.6, 863.6],
};

/** Standard drawing scales, biggest first (2 = 2:1, 0.5 = 1:2). */
export const STANDARD_SCALES = [100, 50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001];

export function scaleLabel(s: number): string {
  if (s >= 1) return `${Math.round(s * 100) / 100}:1`;
  return `1:${Math.round((1 / s) * 100) / 100}`;
}

/** Line widths (mm) and dash patterns for each style. */
export const LINE_STYLES: Record<LineStyle, { width: number; dash?: number[] }> = {
  border: { width: 0.7 },
  visible: { width: 0.5 },
  hidden: { width: 0.25, dash: [3, 1.5] },
  thin: { width: 0.25 },
  centre: { width: 0.25, dash: [6, 1.5, 1, 1.5] },
};

/** Spacing of section hatching on paper (mm). */
export const HATCH_SPACING = 2.5;
/** Balloon size on paper (mm). */
export const BALLOON_RADIUS = 4;

const MARGIN = 10;
const TITLE_W = 180;
const TITLE_H = 36;
/** Space between views on the paper (mm). */
const GAP = 15;

export interface PlacedView {
  id: string;
  kind: ViewKind;
  /** Its key in the projections: the kind, or "section:<id>". */
  key: string;
  /** Where the middle of the view is on the sheet. */
  centre: [number, number];
  /** The view's outline on the sheet: x0, y0, x1, y1. */
  box: [number, number, number, number];
  /** The scale it's drawn at: its own, that of the view it's taken from (details, sections), or the sheet's. Detail views are drawn `zoom` times this. */
  scale: number;
}

export interface PlacedDim {
  id: string;
  /** Where its number is on the sheet. */
  label: [number, number];
  /** False when what it measured can't be found any more. */
  found: boolean;
  /** Its shapes' range in `prims` (for highlighting). */
  from: number;
  to: number;
  /** What it measures, on the sheet: its points (or circle centre) and circle radius. */
  a: [number, number];
  b: [number, number] | null;
  rad: number;
  /** Angles: the second edge's ends on the sheet. */
  cd?: [[number, number], [number, number]];
  /** Lengths, diameters and radii: which way their arrows are drawn. */
  arrows?: "inside" | "outside";
}

export interface SheetLayout {
  size: [number, number];
  scale: number;
  /** True when even the smallest scale doesn't fit (the views may run off the sheet). */
  tooBig: boolean;
  /** At a chosen sheet scale: the views (keys) that run off the paper or onto the title block; missing when none do. */
  offSheet?: string[];
  /** True when that's because of a view drawn at its own scale (they'd fit at the sheet's). */
  ownTooBig?: boolean;
  views: PlacedView[];
  dims: PlacedDim[];
  /** Notes: where each one's text sits (sheet mm), for picking and dragging. */
  notes: { id: string; box: [number, number, number, number] }[];
  /** The hole table's outline (sheet mm: x0, y0, x1, y1), for dragging; and true when it's taller than the room for it. */
  holeTable?: { box: [number, number, number, number]; tall: boolean };
  prims: Prim[];
}

/** Text size and line spacing of notes (paper mm). */
export const SHEET_NOTE_SIZE = 3.5;
export const SHEET_NOTE_LINE = 5.5;

export interface BomLine {
  item: number;
  name: string;
  quantity: number;
  /** The part (for balloons). */
  partId?: string;
  /** Part number and description, when the part has them. */
  number?: string;
  description?: string;
  /** What one weighs, written out (e.g. "12.5 g"), when known. */
  weight?: string;
}

export interface SheetInfo {
  /** Parts list for assembly drawings (shown above the title block). */
  bom?: BomLine[];
  /** The design's name. */
  designName: string;
  /** What's drawn (the part's name). */
  subject: string;
  /** Date shown in the title block, e.g. "14/10/2026". */
  date: string;
  /** Assembly drawings: a spot on one copy of each listed part (model mm), for numbered balloons. */
  balloons?: { item: number; at: [number, number, number] }[];
  /** Tapped hole sizes in the design, so hole callouts can name the thread. */
  taps?: TapSize[];
  /** Which sheet this is and how many the drawing has (the title block then says "1 OF 3"). */
  sheetNo?: number;
  sheetCount?: number;
}

/** A view's size on paper at scale 1 (detail views are drawn `zoom` times bigger). */
const sizeOf = (p: ViewProjection | undefined): [number, number] => {
  const z = p?.zoom ?? 1;
  return p?.bounds ? [(p.bounds[2] - p.bounds[0]) * z, (p.bounds[3] - p.bounds[1]) * z] : [0, 0];
};
/** A view's size on paper at scale `s`, less any bands taken out to shorten it (each leaving a small gap). */
function paperSize(p: ViewProjection | undefined, s: number): [number, number] {
  const [w, h] = sizeOf(p);
  if (!p?.shorten?.length) return [w * s, h * s];
  const z = p.zoom ?? 1;
  return ([0, 1] as const).map((axis) => {
    const bands = cutsOn(p.shorten, axis);
    return ((axis === 0 ? w : h) / z - removed(bands)) * s * z + bands.length * SHORT_GAP;
  }) as [number, number];
}

/** Squeezes a view's coordinate along one axis (for shortened views; otherwise as it is). */
function squeezer(p: ViewProjection, scale: number): { x: (v: number) => number; y: (v: number) => number; bands: [{ from: number; to: number }[], { from: number; to: number }[]]; g: number } {
  const g = SHORT_GAP / (scale * (p.zoom ?? 1));
  const bx = cutsOn(p.shorten, 0);
  const by = cutsOn(p.shorten, 1);
  return { x: (v) => squeeze(v, bx, g), y: (v) => squeeze(v, by, g), bands: [bx, by], g };
}

/** The middle of a view, as drawn (after any shortening). */
function drawnCentre(p: ViewProjection | undefined, scale: number): [number, number] {
  if (!p?.bounds) return [0, 0];
  const q = squeezer(p, scale);
  return [(q.x(p.bounds[0]) + q.x(p.bounds[2])) / 2, (q.y(p.bounds[1]) + q.y(p.bounds[3])) / 2];
}

/** A polyline with the bands of a shortened view taken out: the pieces left. */
function clipped(p: ViewProjection, line: number[]): number[][] {
  // Detail views: kept inside their circle.
  const c = p.clipCircle;
  const lines = c ? clipToCircle(line, [c[0], c[1]], c[2]) : [line];
  if (!p.shorten?.length) return lines;
  return lines.flatMap((l) => clipOut(l, 0, cutsOn(p.shorten, 0))).flatMap((piece) => clipOut(piece, 1, cutsOn(p.shorten, 1)));
}

/** Break lines either side of each band taken out of a shortened view (a zigzag across the view). */
function breakSymbols(p: ViewProjection, scale: number, at: (x: number, y: number) => [number, number], box: [number, number, number, number]): Prim[] {
  const out: Prim[] = [];
  const q = squeezer(p, scale);
  const zig = (u: number, lo: number, hi: number, across: boolean): Prim => {
    const mid = (lo + hi) / 2;
    const pts = [lo - 2, u, mid - 2, u, mid - 1, u + 1.5, mid + 1, u - 1.5, mid + 2, u, hi + 2, u];
    const flat: number[] = [];
    for (let i = 0; i < pts.length; i += 2) flat.push(...(across ? [pts[i + 1], pts[i]] : [pts[i], pts[i + 1]]));
    return { kind: "path", points: flat, style: "thin" };
  };
  for (const b of q.bands[0]) {
    const xa = at(b.from, 0)[0];
    for (const x of [xa, xa + SHORT_GAP]) out.push(zig(x, box[1], box[3], true));
  }
  for (const b of q.bands[1]) {
    const ya = at(0, b.from)[1];
    for (const y of [ya, ya + SHORT_GAP]) out.push(zig(y, box[0], box[2], false));
  }
  return out;
}

/** The area views may use: the frame, minus a strip above the title block. */
const BOM_ROW = 6;
const NOTE_LINE = 4.5;

function notesOf(drawing: Drawing): string[] {
  return (drawing.title.notes ?? "").split("\n").filter((l) => l.trim()).slice(0, 8);
}

/**
 * Height kept free at the bottom for the title block, parts list and notes
 * (and the hole table, with `holes` rows, unless it's been dragged elsewhere;
 * on a sheet of `size` a long one wraps into columns — see holeTableShape).
 */
export function bottomReserve(
  drawing: (Pick<Drawing, "title"> & Partial<Pick<Drawing, "revisions" | "holeTableAt">>) | null,
  bom: BomLine[] | undefined,
  holes = 0,
  size?: [number, number],
): number {
  const notes = drawing ? notesOf(drawing as Drawing).length : 0;
  const revs = drawing?.revisions?.length ?? 0;
  const table = holes && !drawing?.holeTableAt ? holeTableShape(holes, size).h + 3 : 0;
  return (
    TITLE_H +
    (bom?.length ? (bom.length + 1) * BOM_ROW + 3 : 0) +
    table +
    (revs ? (revs + 1) * BOM_ROW + 3 : 0) +
    (notes ? (notes + 1) * NOTE_LINE + 3 : 0)
  );
}

/** Width of each column of a hole table that's wrapped into columns (paper mm). */
export const HOLE_BLOCK_W = 70;

/**
 * How a hole table with `n` holes is laid out. Short tables are one column
 * across the title block's width (as they always were). One taller than half
 * the room above the title block is wrapped into narrower columns side by
 * side, each with its own heading, so the views keep their room; it's only
 * allowed to grow taller once the columns fill the sheet's width.
 */
export function holeTableShape(n: number, size?: [number, number]): { columns: number; rows: number; w: number; h: number; tall: boolean } {
  const single = { columns: 1, rows: n, w: TITLE_W, h: (n + 1) * BOM_ROW, tall: false };
  if (!size || n <= 0) return single;
  const room = (size[1] - 2 * MARGIN - TITLE_H) / 2;
  if (single.h + 3 <= room) return single;
  const most = Math.max(1, Math.floor((room - 3) / BOM_ROW) - 1);
  const maxColumns = Math.max(1, Math.floor((size[0] - 2 * MARGIN) / HOLE_BLOCK_W));
  const columns = Math.min(maxColumns, Math.ceil(n / most));
  const rows = Math.ceil(n / columns);
  return { columns, rows, w: columns * HOLE_BLOCK_W, h: (rows + 1) * BOM_ROW, tall: rows > most };
}

function viewArea(size: [number, number], reserve = TITLE_H): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: MARGIN + 5, y0: MARGIN + reserve + 5, x1: size[0] - MARGIN - 5, y1: size[1] - MARGIN - 5 };
}

/** A drawing's views' lines, by view key (see viewKey). */
export type Projections = Partial<Record<string, ViewProjection>>;

const isSectionKey = (k: string) => k.startsWith("section:");
const isDetailKey = (k: string) => k.startsWith("detail:");
/** Views placed freely in the side column, with their names underneath. */
const isLabelled = (k: string) => isSectionKey(k) || isDetailKey(k) || k === "flat";

/**
 * A view's scale when the sheet's is `s`: its own (`own`), or — for a detail,
 * or a section without its own — that of the view it's taken from (`parent`),
 * or the sheet's. (Detail views are then drawn `zoom` times bigger.)
 */
function scaleIn(k: string, s: number, own: Record<string, number>, parent: Record<string, string>): number {
  return own[k] ?? (parent[k] !== undefined ? (own[parent[k]] ?? s) : s);
}

/** Width and height the arrangement needs on paper at a scale. */
function needed(
  projections: Projections,
  keys: string[],
  s: number,
  maxH = Infinity,
  third = false,
  sideGap = 0,
  own: Record<string, number> = {},
  parent: Record<string, string> = {},
): { w: number; h: number; cols: number[]; rows: number[]; side: { key: string; w: number; h: number; x: number; y: number }[] } {
  const shown = new Set(keys);
  // (Views with their own scale stay that size whatever the sheet's scale.)
  const size = (k: string) => (shown.has(k) ? paperSize(projections[k], scaleIn(k, s, own, parent)) : [0, 0]);
  const [fw, fh] = size("front");
  // Columns left to right and rows top to bottom (see GRID).
  const g = third ? GRID.third : GRID.first;
  // The front's column and row: as wide and tall as the front — or, once views have scales of their own
  // (so the top may be wider than the front, say), as the widest view above or below it and the tallest beside it.
  const mixed = Object.keys(own).length > 0;
  const frontW = mixed ? Math.max(fw, ...g.rows.map((k) => size(k)[0])) : fw;
  const frontH = mixed ? Math.max(fh, ...g.cols.map((k) => size(k)[1])) : fh;
  const cols = g.cols.map((k) => (k === "front" ? frontW : size(k)[0]));
  const rows = g.rows.map((k) => (k === "front" ? frontH : size(k)[1]));
  const differs = (k: string) => !isDetailKey(k) && Math.abs(scaleIn(k, s, own, parent) - s) > 1e-9;
  const used = (list: number[]) => list.filter((v) => v > 0);
  const gridW = used(cols).reduce((a, b) => a + b, 0) + GAP * Math.max(0, used(cols).length - 1);
  // (Room under the lowest row for a "SCALE 2:1" note when a lined-up view has its own scale.)
  const noted = [...g.rows, ...g.cols].some((k) => shown.has(k) && differs(k));
  const gridH = used(rows).reduce((a, b) => a + b, 0) + GAP * Math.max(0, used(rows).length - 1) + (noted && used(rows).length ? LABEL_ROOM : 0);
  // The 3D view and the section views share a column to the right, one above another (sections with room for their names).
  const side = ["iso", ...keys.filter(isLabelled)]
    .map((key) => {
      const [w, h] = size(key);
      return { key, w, h: h > 0 && (isLabelled(key) || differs(key)) ? h + labelRoom(key, projections[key]) : h };
    })
    .filter((x) => x.w > 0);
  // One above another, starting a new column beside it when the next wouldn't fit under the last.
  const columns: { items: typeof side; w: number; h: number }[] = [];
  for (const item of side) {
    const col = columns[columns.length - 1];
    if (col && col.h + GAP + item.h <= Math.max(maxH, gridH)) {
      col.items.push(item);
      col.h += GAP + item.h;
      col.w = Math.max(col.w, item.w);
    } else columns.push({ items: [item], w: item.w, h: item.h });
  }
  const placed: { key: string; w: number; h: number; x: number; y: number }[] = [];
  let cx = 0;
  for (const col of columns) {
    let cy = 0;
    for (const item of col.items) {
      placed.push({ ...item, x: cx, y: cy });
      cy += item.h + GAP;
    }
    cx += col.w + GAP;
  }
  const sideW = columns.length ? cx - GAP : 0;
  const sideH = Math.max(0, ...columns.map((c) => c.h));
  // (`sideGap`: extra room between the lined-up views and the side column, for dimensions there.)
  const w = gridW + (sideW > 0 ? (gridW > 0 ? GAP + sideGap : 0) + sideW : 0);
  const h = Math.max(gridH, sideH);
  return { w, h, cols, rows, side: placed };
}

/**
 * Where the six standard views go around the front view: columns left to
 * right, rows top to bottom. First-angle: each view goes on the far side of
 * the front view from where it's seen; third-angle: on the near side.
 */
const GRID = {
  first: { cols: ["right", "front", "left", "back"], rows: ["bottom", "front", "top"] },
  third: { cols: ["left", "front", "right", "back"], rows: ["top", "front", "bottom"] },
} as const;

/** Room under a section view for its name (mm). */
const LABEL_ROOM = 8;
/** Room under a labelled view: its name, and for a flat pattern a line per bend. */
const labelRoom = (key: string, p: ViewProjection | undefined) => LABEL_ROOM + (key === "flat" ? BEND_LINE_H * (p?.bends?.length ?? 0) : 0);
const BEND_LINE_H = 4;

/** The biggest standard scale at which all the views fit on the sheet. */
export function fitScale(
  projections: Projections,
  keys: string[],
  sheet: SheetSize,
  reserve = TITLE_H,
  third = false,
  sideGap = 0,
  own: Record<string, number> = {},
  parent: Record<string, string> = {},
): { scale: number; fits: boolean } {
  const area = viewArea(SHEETS[sheet], reserve);
  for (const s of STANDARD_SCALES) {
    const n = needed(projections, keys, s, area.y1 - area.y0, third, sideGap, own, parent);
    if (n.w <= area.x1 - area.x0 && n.h <= area.y1 - area.y0) return { scale: s, fits: true };
  }
  return { scale: STANDARD_SCALES[STANDARD_SCALES.length - 1], fits: false };
}

/** Keys of a drawing's views, in order. */
export function drawingViewKeys(drawing: Pick<Drawing, "views">): string[] {
  return drawing.views.map(viewKey);
}

/** Work out where everything goes on the sheet. */
export function layoutSheet(drawing: Drawing, projections: Projections, info: SheetInfo): SheetLayout {
  // Room kept for dimensions beside the 3D column, and one scale smaller, when Fit to sheet
  // or Auto dimension decided so (see planFit); old drawings have neither and lay out as before.
  // (A chosen scale ignores it: the room was worked out for Fit to sheet.)
  const gap = drawing.scale === undefined ? Math.min(MAX_SIDE_GAP, Math.max(0, drawing.fit?.gap ?? 0)) : 0;
  return layoutAt(drawing, projections, info, gap).layout;
}

/**
 * Dragging a view's corner to resize it: the standard scale nearest to making
 * that corner (at `corner` on the sheet now, with the view at scale `now`)
 * reach the pointer, measured out from the view's middle.
 */
export function resizedScale(now: number, centre: [number, number], corner: [number, number], cursor: [number, number]): number {
  const r0 = Math.hypot(corner[0] - centre[0], corner[1] - centre[1]);
  const r1 = Math.hypot(cursor[0] - centre[0], cursor[1] - centre[1]);
  if (!(r0 > 1e-9) || !(now > 0)) return now;
  const want = Math.max((now * r1) / r0, 1e-9);
  const off = (s: number) => Math.abs(Math.log(s / want));
  return STANDARD_SCALES.reduce((best, s) => (off(s) < off(best) ? s : best));
}

/**
 * Is a placed view (with the room for its name or "SCALE" note under it)
 * inside the border, off the title block and the tables above it, and clear
 * of every other view?
 */
export function viewClear(l: Pick<SheetLayout, "size" | "views" | "prims">, key: string, reserve = TITLE_H): boolean {
  const v = l.views.find((x) => x.key === key);
  if (!v) return true;
  if (!viewOnPaper(l, key, reserve)) return false;
  const [x0, y0, x1, y1] = withName(l, v);
  return l.views.every((o) => o.key === key || o.box[2] <= x0 || o.box[0] >= x1 || o.box[3] <= y0 || o.box[1] >= y1);
}

/** A placed view's outline with the room for its name or "SCALE" note under it, when it has one. */
function withName(l: Pick<SheetLayout, "prims">, v: PlacedView): [number, number, number, number] {
  const named = l.prims.some((p) => p.kind === "text" && Math.abs(p.x - v.centre[0]) < 1e-9 && Math.abs(p.y - (v.box[1] - 6)) < 1e-9);
  return [v.box[0], v.box[1] - (named ? LABEL_ROOM : 0), v.box[2], v.box[3]];
}

/** Is a placed view (with its name or note) inside the border and off the title block and the tables above it? */
export function viewOnPaper(l: Pick<SheetLayout, "size" | "views" | "prims">, key: string, reserve = TITLE_H): boolean {
  const v = l.views.find((x) => x.key === key);
  if (!v) return true;
  const [W, H] = l.size;
  const [x0, y0, x1, y1] = withName(l, v);
  const e = 1e-6;
  if (x0 < MARGIN - e || y0 < MARGIN - e || x1 > W - MARGIN + e || y1 > H - MARGIN + e) return false;
  return !(x1 > W - MARGIN - TITLE_W && y0 < MARGIN + reserve - e);
}

/**
 * What to say when, at a chosen sheet scale, views run off the paper or onto
 * the title block (`l.offSheet`): naming the view and its scale when it's one
 * at a scale of its own, else about the sheet's scale. Null when all's well.
 * `name` gives a view's name ("3D", "Front", "Section A"…).
 */
export function offSheetMessage(l: Pick<SheetLayout, "offSheet" | "views" | "scale">, name: (v: PlacedView) => string): string | null {
  const off = (l.offSheet ?? []).map((k) => l.views.find((v) => v.key === k)).filter((v): v is PlacedView => !!v);
  if (!off.length) return null;
  const own = off.filter((v) => Math.abs(v.scale - l.scale) > 1e-9 && v.kind !== "detail");
  if (own.length === off.length && own.length === 1) {
    const v = own[0];
    return `The ${name(v)} view runs off the sheet at ${scaleLabel(v.scale)}. Click it and choose a smaller scale, or choose a bigger sheet.`;
  }
  if (own.length === off.length) return `Some views run off the sheet at their own scales (${own.map((v) => `${name(v)} ${scaleLabel(v.scale)}`).join(", ")}). Click each and choose a smaller scale, or choose a bigger sheet.`;
  return `The views run off the sheet at ${scaleLabel(l.scale)}. Choose a smaller scale (or Fit to sheet), drag them into the free space, or choose a bigger sheet.`;
}

/**
 * Give a view its own scale (`scale`; undefined = the sheet's). A view moved
 * by hand keeps its place unless, at its new size, it would run into another
 * view or off the paper — then it goes back to its automatic place (beside the
 * others, where the layout keeps it clear of them).
 */
export function scaleView(drawing: Drawing, viewId: string, scale: number | undefined, projections: Projections, info: SheetInfo): Drawing {
  const views = drawing.views.map((v) => {
    if (v.id !== viewId) return v;
    const { scale: _old, ...rest } = v;
    return scale ? { ...rest, scale } : rest;
  });
  const next: Drawing = { ...drawing, views };
  const view = views.find((v) => v.id === viewId);
  if (!view?.at) return next;
  const gap = next.scale === undefined ? Math.min(MAX_SIDE_GAP, Math.max(0, next.fit?.gap ?? 0)) : 0;
  const { layout, reserve } = layoutAt(next, projections, info, gap);
  if (viewClear(layout, viewKey(view), reserve)) return next;
  return { ...next, views: views.map((v) => (v.id === viewId ? (({ at: _at, ...rest }) => rest)(v) : v)) };
}

/** Most extra room kept beside the 3D column for dimensions (paper mm). */
export const MAX_SIDE_GAP = 40;

/**
 * Decide how "Fit to sheet" makes room for the drawing's dimensions — run when
 * the user asks (Auto dimension, Arrange, or choosing Fit to sheet), never
 * while dragging, and kept on the drawing (`fit`) so the sheet doesn't change
 * by itself. In order: nothing; more room beside the 3D column (up to
 * MAX_SIDE_GAP); that and one scale smaller; just one scale smaller. The first
 * that keeps every dimension inside the border and clear of the other views
 * wins; if none does, nothing changes. `remake` makes the dimensions again for
 * a scale (Auto dimension's rows are spaced for the scale they're made at).
 */
export function fitDrawing(drawing: Drawing, projections: Projections, info: SheetInfo, remake?: (scale: number) => Dimension[]): Drawing {
  const { fit: _old, ...plain } = drawing;
  const scaleOf = (d: Drawing) => layoutSheet({ ...d, dimensions: [] }, projections, info).scale;
  const at = (d: Drawing): Drawing => (remake ? { ...d, dimensions: remake(scaleOf(d)) } : d);
  const first = at(plain);
  if (drawing.scale !== undefined || !first.dimensions?.length) return first;
  const base = layoutAt(first, projections, info);
  if (dimsClear(base.layout, first, base.reserve)) return first;
  const gap = Math.min(MAX_SIDE_GAP, sideOverhang(base.layout, first));
  const tries: NonNullable<Drawing["fit"]>[] = [...(gap > 0 ? [{ gap }, { gap, down: true as const }] : []), { down: true as const }];
  const step = (d: Drawing) => STANDARD_SCALES.indexOf(scaleOf(d)) - STANDARD_SCALES.indexOf(base.layout.scale);
  for (const fit of tries) {
    // Never more than one scale smaller than without the room.
    if (step({ ...plain, fit }) > 1) continue;
    const d = at({ ...plain, fit });
    if (dimsClear(layoutSheet(d, projections, info), d, base.reserve)) return d;
  }
  return first;
}

const LINED_UP = new Set<string>(["front", "top", "right", "left", "back", "bottom"]);

/** Every point a dimension's shapes take up on the sheet (numbers by the corners of their boxes). */
function dimPoints(l: SheetLayout, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  for (const p of l.prims.slice(from, to)) {
    if (p.kind === "path") {
      for (let i = 0; i + 1 < p.points.length; i += 2) out.push([p.points[i], p.points[i + 1]]);
      continue;
    }
    const w = textWidth(p.text, p.size);
    const x0 = p.anchor === "middle" ? -w / 2 : p.anchor === "end" ? -w : 0;
    const a = ((p.rotate ?? 0) * Math.PI) / 180;
    for (const [u, v] of [[x0, 0], [x0 + w, 0], [x0, p.size * 0.75], [x0 + w, p.size * 0.75]]) out.push([p.x + u * Math.cos(a) - v * Math.sin(a), p.y + u * Math.sin(a) + v * Math.cos(a)]);
  }
  return out;
}

/**
 * How far the lined-up views' dimensions reach past the right of those views
 * (paper mm, with a little room), when there's a column of other views
 * (3D, sections, details) placed automatically beside them; else 0.
 */
function sideOverhang(l: SheetLayout, drawing: Pick<Drawing, "dimensions" | "views">): number {
  const grid = l.views.filter((v) => LINED_UP.has(v.key));
  const side = l.views.some((v) => !LINED_UP.has(v.key) && !drawing.views.find((x) => viewKey(x) === v.key)?.at);
  if (!grid.length || !side || !drawing.dimensions?.length) return 0;
  const right = Math.max(...grid.map((v) => v.box[2]));
  const owner = new Map(drawing.dimensions.map((d) => [d.id, d.view]));
  let reach = right;
  for (const dim of l.dims) if (LINED_UP.has(owner.get(dim.id) ?? "")) for (const [x] of dimPoints(l, dim.from, dim.to)) reach = Math.max(reach, x);
  return reach > right + 1e-6 ? Math.ceil(reach - right + 3) : 0;
}

/**
 * Do all the dimensions sit on the paper inside the border, off the title
 * block (and the tables above it), and clear of views other than their own?
 */
export function dimsClear(l: SheetLayout, drawing: Pick<Drawing, "dimensions">, reserve = TITLE_H): boolean {
  const [W, H] = l.size;
  const owner = new Map((drawing.dimensions ?? []).map((d) => [d.id, d.view]));
  const out = (x: number, y: number) => x < MARGIN || x > W - MARGIN || y < MARGIN || y > H - MARGIN || (x > W - MARGIN - TITLE_W && y < MARGIN + reserve);
  for (const dim of l.dims) {
    const others = l.views.filter((v) => v.key !== owner.get(dim.id)).map((v) => v.box);
    const bad = (x: number, y: number) => out(x, y) || others.some((b) => x > b[0] + 0.5 && x < b[2] - 0.5 && y > b[1] + 0.5 && y < b[3] - 0.5);
    if (dimPoints(l, dim.from, dim.to).some(([x, y]) => bad(x, y))) return false;
  }
  return true;
}

function layoutAt(drawing: Drawing, projections: Projections, info: SheetInfo, sideGap = 0): { layout: SheetLayout; reserve: number } {
  const size = SHEETS[drawing.sheet];
  const keys = drawingViewKeys(drawing).filter((k) => projections[k]?.bounds);
  // Hole table: the holes on one view, tagged, with a table above the title block.
  const holeKey = drawing.holeTable ? holeTableView(drawing, projections) : null;
  const holes = holeKey ? holeRows(projections[holeKey]!) : [];
  const reserve = bottomReserve(drawing, info.bom, holes.length, size);
  const third = drawing.projection === "third";
  // Views drawn at their own scale.
  const own: Record<string, number> = {};
  for (const v of drawing.views) if (v.scale && v.kind !== "detail") own[viewKey(v)] = v.scale;
  // Details are drawn at the scale of the view they're taken from (times their enlargement); sections too, unless they have their own.
  const parent: Record<string, string> = {};
  for (const x of drawing.details ?? []) parent[`detail:${x.id}`] = x.host;
  for (const x of drawing.sections ?? []) parent[`section:${x.id}`] = x.host;
  const fitted = fitScale(projections, keys, drawing.sheet, reserve, third, sideGap, own, parent);
  // (When every view has its own scale, the sheet's is what would fit them all at one scale — not just the biggest there is.)
  const allOwn = keys.length > 0 && keys.every((k) => own[k] !== undefined || (parent[k] !== undefined && own[parent[k]] !== undefined));
  const auto = allOwn ? { scale: fitScale(projections, keys, drawing.sheet, reserve, third, sideGap).scale, fits: fitted.fits } : fitted;
  // (Fit to sheet can be asked to go one scale smaller, to make room for dimensions.)
  const stepped = drawing.fit?.down ? (STANDARD_SCALES[STANDARD_SCALES.indexOf(auto.scale) + 1] ?? auto.scale) : auto.scale;
  const scale = drawing.scale ?? stepped;
  const area = viewArea(size, reserve);
  const n = needed(projections, keys, scale, area.y1 - area.y0, third, sideGap, own, parent);
  const scaleOf = (k: string) => scaleIn(k, scale, own, parent);
  const differs = (k: string) => !isDetailKey(k) && Math.abs(scaleOf(k) - scale) > 1e-9;

  // Automatic places: the grid of aligned views centred in the area, the 3D and section views to its right.
  const left = area.x0 + Math.max(0, (area.x1 - area.x0 - n.w) / 2);
  const top = area.y1 - Math.max(0, (area.y1 - area.y0 - n.h) / 2);
  const colX: number[] = [];
  let x = left;
  n.cols.forEach((w, i) => {
    colX[i] = x + w / 2;
    if (w > 0) x += w + GAP;
  });
  const gridRight = x - (n.cols.some((w) => w > 0) ? GAP : 0);
  const rowY: number[] = [];
  let y = top;
  n.rows.forEach((h, i) => {
    rowY[i] = y - h / 2;
    if (h > 0) y -= h + GAP;
  });
  const autoCentre: Record<string, [number, number]> = {};
  const grid = third ? GRID.third : GRID.first;
  grid.cols.forEach((k, i) => (autoCentre[k] = [colX[i], rowY[1]]));
  grid.rows.forEach((k, i) => (autoCentre[k] = [colX[1], rowY[i]]));
  const sideX = gridRight > left ? gridRight + GAP + sideGap : left;
  for (const item of n.side) {
    const viewH = isLabelled(item.key) || differs(item.key) ? item.h - labelRoom(item.key, projections[item.key]) : item.h;
    autoCentre[item.key] = [sideX + item.x + item.w / 2, top - item.y - viewH / 2];
  }

  // Views the user moved keep their place — but views lined up with the front view stay lined up with it.
  const placedAt = (k: string) => drawing.views.find((v) => viewKey(v) === k)?.at;
  const front: [number, number] = placedAt("front") ?? autoCentre.front;
  const dx = front[0] - autoCentre.front[0];
  const dy = front[1] - autoCentre.front[1];
  const centreFor = (k: string): [number, number] => {
    const at = placedAt(k);
    if (k === "front") return front;
    if (k === "iso" || isLabelled(k)) return at ?? [autoCentre[k][0], autoCentre[k][1]];
    if (k === "top" || k === "bottom") return [front[0], at ? at[1] : autoCentre[k][1] + dy];
    return [at ? at[0] : autoCentre[k][0] + dx, front[1]];
  };

  const prims: Prim[] = [];
  const views: PlacedView[] = [];
  for (const v of drawing.views) {
    const key = viewKey(v);
    const p = projections[key];
    if (!p?.bounds) continue;
    const centre = centreFor(key);
    const sc = scaleOf(key);
    // Detail views are drawn bigger than the rest.
    const vs = sc * (p.zoom ?? 1);
    const at = (x: number, y: number) => toSheet({ centre }, p, sc, x, y);
    const map = (line: number[]) => {
      const out: number[] = [];
      for (let i = 0; i + 1 < line.length; i += 2) out.push(...at(line[i], line[i + 1]));
      return out;
    };
    // Shortened views: the bands taken out aren't drawn.
    const draw = (line: number[], style: LineStyle) => {
      for (const piece of clipped(p, line)) prims.push({ kind: "path", points: map(piece), style });
    };
    if (p.cutFaces) {
      // (Spaced evenly on paper, so a detail view drawn bigger isn't hatched more coarsely.)
      for (const seg of hatchLines(p.cutFaces, HATCH_SPACING / vs)) draw(seg, "thin");
    }
    for (const line of drawing.hiddenLines ? p.hidden : []) draw(line, "hidden");
    for (const line of p.visible) draw(line, "visible");
    for (const line of p.breakLines ?? []) draw(line, "thin");
    if (drawing.centreLines !== false) {
      for (const seg of [...centreMarks(p, vs), ...centreLines(p, vs)]) draw(seg, "centre");
    }
    // Threads on rods and in holes (Thread features, fasteners), drawn the standard way.
    if (drawing.threadSymbols !== false) {
      for (const m of p.threadMarks ?? []) if (!m.hidden || drawing.hiddenLines) draw(m.line, m.hidden ? "hidden" : "thin");
    }
    // Tapped holes: the thread drawn the standard way.
    if (drawing.threadSymbols !== false && info.taps?.length) {
      const t = threadSymbols(p, info.taps);
      for (const arc of t.endOn) draw(arc, "thin");
      // From the side they're inside the part, so shown with the hidden lines.
      if (drawing.hiddenLines) for (const seg of t.side) draw(seg, "hidden");
    }
    const [w, h] = paperSize(p, sc);
    const box: PlacedView["box"] = [centre[0] - w / 2, centre[1] - h / 2, centre[0] + w / 2, centre[1] + h / 2];
    if (p.shorten?.length) prims.push(...breakSymbols(p, sc, at, box));
    // A view at its own scale says so underneath (in its name, for views that have one).
    const ownNote = differs(key) ? `SCALE ${scaleLabel(sc)}` : null;
    if (ownNote && !isLabelled(key)) prims.push({ kind: "text", x: centre[0], y: box[1] - 6, text: ownNote, size: 3.5, anchor: "middle", bold: true });
    const named = (name: string) => (ownNote ? `${name}  ${ownNote}` : name);
    if (v.kind === "flat") {
      // Bend lines, numbered, and a list of the bends under the view's name.
      prims.push({ kind: "text", x: centre[0], y: box[1] - 6, text: named("FLAT PATTERN"), size: 3.5, anchor: "middle", bold: true });
      (p.bends ?? []).forEach((b, i) => {
        const [x0, y0, x1, y1] = map([...b.line]) as [number, number, number, number];
        prims.push({ kind: "path", points: [x0, y0, x1, y1], style: "centre" });
        // Its number just past one end of the line.
        const L = Math.hypot(x1 - x0, y1 - y0) || 1;
        prims.push({ kind: "text", x: x1 + ((x1 - x0) / L) * 2, y: y1 + ((y1 - y0) / L) * 2 - 1, text: `B${i + 1}`, size: 2.5, anchor: "start" });
        prims.push({
          kind: "text",
          x: centre[0],
          y: box[1] - 6 - BEND_LINE_H * (i + 1),
          text: `B${i + 1}: ${b.up ? "UP" : "DOWN"} ${Math.round(b.angle * 10) / 10}°  R${lengthNumber(b.radius)}`,
          size: 2.5,
          anchor: "middle",
        });
      });
    }
    const cut = v.kind === "section" ? drawing.sections?.find((c) => c.id === v.section) : undefined;
    if (cut) prims.push({ kind: "text", x: centre[0], y: box[1] - 6, text: named(sectionTitle(cut)), size: 3.5, anchor: "middle", bold: true });
    const detail = v.kind === "detail" ? drawing.details?.find((x) => x.id === v.detail) : undefined;
    if (detail) {
      // The detail's circle, and its name with its own scale.
      prims.push(circle(centre[0], centre[1], (w + h) / 4, "thin"));
      prims.push({ kind: "text", x: centre[0], y: box[1] - 6, text: `DETAIL ${detail.letter} (${scaleLabel(vs)})`, size: 3.5, anchor: "middle", bold: true });
    }
    views.push({ id: v.id, kind: v.kind, key, centre, box, scale: sc });
  }

  // Where each section is cut, on the view its line was drawn on.
  for (const cut of drawing.sections ?? []) {
    if (!views.some((v) => v.key === `section:${cut.id}`)) continue;
    const host = views.find((v) => v.key === cut.host);
    const hp = projections[cut.host];
    if (host && hp?.bounds) prims.push(...cuttingPlane(host, hp, host.scale, cut));
  }

  // Where each detail comes from: a circle on its host view, with its letter.
  for (const detail of drawing.details ?? []) {
    if (!views.some((v) => v.key === `detail:${detail.id}`)) continue;
    const host = views.find((v) => v.key === detail.host);
    const hp = projections[detail.host];
    if (!host || !hp?.bounds) continue;
    const [x0, y0, x1, y1] = hp.bounds;
    const [px, py] = toSheet(host, hp, host.scale, x0 + detail.centre[0] * (x1 - x0), y0 + detail.centre[1] * (y1 - y0));
    const r = detail.radius * host.scale;
    prims.push(circle(px, py, r, "thin"));
    prims.push({ kind: "text", x: px + r * 0.75 + 1.5, y: py + r * 0.75 + 1.5, text: detail.letter, size: 3.5, anchor: "start", bold: true });
  }

  // Balloons: the parts list's item numbers, pointing at the parts.
  if (info.balloons?.length && drawing.balloons !== false) {
    const host = views.find((v) => v.kind === "iso") ?? views.find((v) => v.kind === "front") ?? views.find((v) => v.kind !== "section");
    if (host) prims.push(...balloonPrims(host, projections[host.key]!, host.scale, info.balloons));
  }

  // Hole tags next to each hole on the hole table's view.
  const holeHost = holeKey ? views.find((v) => v.key === holeKey) : undefined;
  if (holeHost) {
    for (const h of holes) {
      const [x, y] = toSheet(holeHost, projections[holeKey!]!, holeHost.scale, h.at[0], h.at[1]);
      const r = (h.diameter / 2) * holeHost.scale;
      prims.push({ kind: "text", x: x + r * 0.7 + 0.8, y: y + r * 0.7 + 0.8, text: h.tag, size: 2.5, anchor: "start" });
    }
  }

  // Dimensions, on the views they belong to.
  const dims: PlacedDim[] = [];
  for (const dim of drawing.dimensions ?? []) {
    const view = views.find((v) => v.key === dim.view);
    const p = projections[dim.view];
    if (!view || !p) continue;
    const resolved = resolveDim(dim, p);
    const at = ([x, y]: [number, number]) => toSheet(view, p, view.scale, x, y);
    const drawn = drawDimension(dim, resolved, at, measureDim(dim, resolved), dim.callout ? calloutText(p, resolved.a, info.taps ?? [], { ...dimStyle(drawing), ...(dim.places !== undefined ? { places: dim.places } : {}) }) : null, dimStyle(drawing));
    const from = prims.length;
    prims.push(...drawn.prims);
    dims.push({
      id: dim.id,
      label: drawn.label,
      found: resolved.found,
      from,
      to: prims.length,
      a: at(resolved.a),
      b: resolved.b ? at(resolved.b) : null,
      rad: (resolved.r ?? 0) * view.scale * (p.zoom ?? 1),
      ...(resolved.c && resolved.d ? { cd: [at(resolved.c), at(resolved.d)] as [[number, number], [number, number]] } : {}),
      ...(drawn.arrows ? { arrows: drawn.arrows } : {}),
    });
  }

  // Notes: lines of text from their top-left corner.
  const notes: SheetLayout["notes"] = [];
  for (const note of drawing.notes ?? []) {
    if (note.symbol) {
      const drawn = symbolPrims(note, note.symbol);
      prims.push(...drawn.prims);
      notes.push({ id: note.id, box: drawn.box });
      continue;
    }
    const lines = note.text.split("\n");
    const [x, y] = note.at;
    lines.forEach((line, i) => {
      if (line.trim()) prims.push({ kind: "text", x, y: y - SHEET_NOTE_SIZE - i * SHEET_NOTE_LINE, text: line, size: SHEET_NOTE_SIZE, anchor: "start" });
    });
    const w = Math.max(4, ...lines.map((l) => l.length * SHEET_NOTE_SIZE * 0.55));
    const h = SHEET_NOTE_SIZE + (lines.length - 1) * SHEET_NOTE_LINE + 1;
    notes.push({ id: note.id, box: [x, y - h, x + w, y] });
  }

  const frame = frameAndTitle(size, drawing, scale, info, holeHost ? holes : []);
  prims.push(...frame.prims);
  const tooBig = !drawing.scale && !auto.fits;
  // (Would they fit if every view were at the sheet's scale? Then it's a view's own scale that's too big.)
  const ownTooBig = tooBig && Object.keys(own).length > 0 && fitScale(projections, keys, drawing.sheet, reserve, third, sideGap).fits;
  // (At a chosen scale nothing is shrunk to fit: say which views don't.)
  const offSheet = drawing.scale !== undefined ? views.filter((v) => !viewOnPaper({ size, views, prims }, v.key, reserve)).map((v) => v.key) : [];
  return {
    layout: { size, scale, tooBig, ...(ownTooBig ? { ownTooBig } : {}), ...(offSheet.length ? { offSheet } : {}), views, dims, notes, ...(frame.holeTable ? { holeTable: frame.holeTable } : {}), prims },
    reserve,
  };
}

/** The cutting line across a view, with arrows showing which way the section looks, and its letters. */
export function cuttingPlane(host: PlacedView, p: ViewProjection, scale: number, cut: SectionCut): Prim[] {
  const a0 = fromRel(p.bounds!, cut.a);
  const b0 = fromRel(p.bounds!, cut.b);
  const geo = sectionGeometry(cut.host, a0, b0, cut.flip);
  if (!geo) return [];
  const [x0, y0] = toSheet(host, p, scale, a0[0], a0[1]);
  const [x1, y1] = toSheet(host, p, scale, b0[0], b0[1]);
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  const d: [number, number] = [(x1 - x0) / len, (y1 - y0) / len];
  const ll = Math.hypot(geo.look[0], geo.look[1]) || 1;
  const look: [number, number] = [geo.look[0] / ll, geo.look[1] / ll];
  if (cut.aux) return viewArrow([(x0 + x1) / 2, (y0 + y1) / 2], look, cut.letter);
  const over = 5;
  const a: [number, number] = [x0 - d[0] * over, y0 - d[1] * over];
  const z: [number, number] = [x1 + d[0] * over, y1 + d[1] * over];
  const out: Prim[] = [line(a[0], a[1], z[0], z[1], "centre")];
  for (const [end, sign] of [[a, 1], [z, -1]] as const) {
    // A short thick piece at each end, and an arrow off it.
    out.push({ kind: "path", points: [end[0], end[1], end[0] + d[0] * 4 * sign, end[1] + d[1] * 4 * sign], style: "visible" });
    const tip: [number, number] = [end[0] + look[0] * 7, end[1] + look[1] * 7];
    out.push(line(end[0], end[1], tip[0], tip[1]));
    out.push({
      kind: "path",
      points: [tip[0], tip[1], tip[0] - look[0] * 2.5 + d[0] * 0.9, tip[1] - look[1] * 2.5 + d[1] * 0.9, tip[0] - look[0] * 2.5 - d[0] * 0.9, tip[1] - look[1] * 2.5 - d[1] * 0.9],
      closed: true,
      fill: true,
      style: "thin",
    });
    // The letter just beyond the arrow, a little outward along the line (text baseline sits ~1.2 below its middle).
    out.push({ kind: "text", x: tip[0] + look[0] * 2.5 - d[0] * 2.5 * sign, y: tip[1] + look[1] * 2.5 - d[1] * 2.5 * sign - 1.2, text: cut.letter, size: 3.5, anchor: "middle", bold: true });
  }
  return out;
}

/**
 * An auxiliary view's arrow: pointing at the middle of the line it looks
 * square-on to, from the side it's seen from, with its letter at the tail.
 */
export function viewArrow(mid: [number, number], look: [number, number], letter: string): Prim[] {
  const tip: [number, number] = [mid[0] - look[0] * 3, mid[1] - look[1] * 3];
  const tail: [number, number] = [mid[0] - look[0] * 15, mid[1] - look[1] * 15];
  const side: [number, number] = [-look[1], look[0]];
  return [
    line(tail[0], tail[1], tip[0], tip[1]),
    {
      kind: "path",
      points: [tip[0], tip[1], tip[0] - look[0] * 2.5 + side[0] * 0.9, tip[1] - look[1] * 2.5 + side[1] * 0.9, tip[0] - look[0] * 2.5 - side[0] * 0.9, tip[1] - look[1] * 2.5 - side[1] * 0.9],
      closed: true,
      fill: true,
      style: "thin",
    },
    { kind: "text", x: tail[0] - look[0] * 3, y: tail[1] - look[1] * 3 - 1.2, text: letter, size: 3.5, anchor: "middle", bold: true },
  ];
}

/** Numbered balloons around a view, with leader lines to the parts. */
function balloonPrims(host: PlacedView, p: ViewProjection, scale: number, balloons: NonNullable<SheetInfo["balloons"]>): Prim[] {
  const targets = balloons.map((b) => {
    const [x, y] = projectPoint(host.kind, b.at);
    return toSheet(host, p, scale, x, y);
  });
  const spots = placeBalloons(host.box, targets, BALLOON_RADIUS);
  const out: Prim[] = [];
  balloons.forEach((b, i) => {
    const [bx, by] = spots[i];
    const [tx, ty] = targets[i];
    const l = Math.hypot(tx - bx, ty - by) || 1;
    out.push(circle(bx, by, BALLOON_RADIUS, "thin"));
    out.push({ kind: "text", x: bx, y: by - 1.25, text: String(b.item), size: 3.5, anchor: "middle" });
    out.push(line(bx + ((tx - bx) / l) * BALLOON_RADIUS, by + ((ty - by) / l) * BALLOON_RADIUS, tx, ty));
    out.push({ ...circle(tx, ty, 0.6, "thin"), fill: true });
  });
  return out;
}

/** How a drawing's dimensions read (decimal places, both units). */
export function dimStyle(d: Pick<Drawing, "places" | "dualUnits" | "dimArrows">): DimStyle {
  return { ...(d.places !== undefined ? { places: d.places } : {}), ...(d.dualUnits ? { dual: true } : {}), ...(d.dimArrows ? { arrows: d.dimArrows } : {}) };
}

/** Where a point of a view (in its own mm) lands on the sheet. */
export function toSheet(view: Pick<PlacedView, "centre">, projection: ViewProjection, scale: number, x: number, y: number): [number, number] {
  const [cx, cy] = drawnCentre(projection, scale);
  const s = scale * (projection.zoom ?? 1);
  if (!projection.shorten?.length) return [view.centre[0] + (x - cx) * s, view.centre[1] + (y - cy) * s];
  const q = squeezer(projection, scale);
  return [view.centre[0] + (q.x(x) - cx) * s, view.centre[1] + (q.y(y) - cy) * s];
}

/** The other way: the point on the view (its own coordinates, the real part) under a point on the sheet. */
export function fromSheet(view: Pick<PlacedView, "centre">, projection: ViewProjection, scale: number, sx: number, sy: number): [number, number] {
  const [cx, cy] = drawnCentre(projection, scale);
  const s = scale * (projection.zoom ?? 1);
  const u = cx + (sx - view.centre[0]) / s;
  const v = cy + (sy - view.centre[1]) / s;
  if (!projection.shorten?.length) return [u, v];
  const q = squeezer(projection, scale);
  return [unsqueeze(u, q.bands[0], q.g), unsqueeze(v, q.bands[1], q.g)];
}

const rect = (x0: number, y0: number, x1: number, y1: number, style: LineStyle): Prim => ({ kind: "path", points: [x0, y0, x1, y0, x1, y1, x0, y1], closed: true, style });
const line = (x0: number, y0: number, x1: number, y1: number, style: LineStyle = "thin"): Prim => ({ kind: "path", points: [x0, y0, x1, y1], style });

function circle(cx: number, cy: number, r: number, style: LineStyle): Extract<Prim, { kind: "path" }> {
  const points: number[] = [];
  for (let i = 0; i < 36; i++) points.push(cx + r * Math.cos((i / 36) * 2 * Math.PI), cy + r * Math.sin((i / 36) * 2 * Math.PI));
  return { kind: "path", points, closed: true, style };
}

/** Text size that keeps `text` within `width` mm (at most `size`, at least 1.5). */
export function fitSize(text: string, width: number, size: number, bold = false): number {
  const w = textWidth(text, size) * (bold ? 1.08 : 1);
  return w <= width || w === 0 ? size : Math.max(1.5, Math.floor(((size * width) / w) * 10) / 10);
}

/**
 * The projection symbol: a truncated cone, narrow end on the left, seen from
 * the side and end-on (two circles). First-angle has the circles to the right
 * of the cone, third-angle to its left (ISO 128 / ASME Y14.3).
 * (x, y) is the left end of the symbol's middle line; it's 22 mm long.
 */
export function projectionSymbol(x: number, y: number, third: boolean): Prim[] {
  const ends = third ? x + 4 : x + 18;
  const cone = third ? x + 11 : x;
  return [
    circle(ends, y, 3.5, "thin"),
    circle(ends, y, 1.75, "thin"),
    { kind: "path", points: [cone, y - 1.75, cone + 11, y - 3.5, cone + 11, y + 3.5, cone, y + 1.75], closed: true, style: "thin" },
  ];
}

/** The border, the title block and the projection symbol. */
function frameAndTitle(size: [number, number], drawing: Drawing, scale: number, info: SheetInfo, holes: HoleRow[] = []): { prims: Prim[]; holeTable?: SheetLayout["holeTable"] } {
  const [W, H] = size;
  const out: Prim[] = [rect(MARGIN, MARGIN, W - MARGIN, H - MARGIN, "border")];
  const x0 = W - MARGIN - TITLE_W;
  const x1 = W - MARGIN;
  const y0 = MARGIN;
  out.push(rect(x0, y0, x1, y0 + TITLE_H, "border"));
  out.push(line(x0, y0 + 12, x1, y0 + 12), line(x0, y0 + 24, x1, y0 + 24));
  const label = (x: number, y: number, text: string, w = TITLE_W): Prim => ({ kind: "text", x: x + 1.5, y: y - 3, text, size: fitSize(text, w - 3, 2.2), anchor: "start" });
  // A value in a cell `w` wide: made smaller if it's too long to fit.
  const value = (x: number, y: number, text: string, w: number, size = 3.5, bold = false): Prim => ({ kind: "text", x: x + 1.5, y: y + 2.5, text, size: fitSize(text, w - 3, size, bold), anchor: "start", bold });
  const row = (y: number, cells: [number, string, string][], size: number, bold = false) =>
    cells.forEach(([dx, l, v], i) => {
      const w = (cells[i + 1]?.[0] ?? TITLE_W) - dx;
      if (dx > 0) out.push(line(x0 + dx, y, x0 + dx, y + 12));
      out.push(label(x0 + dx, y + 12, l, w), value(x0 + dx, y + (size > 4 ? 0.5 : 1.5), v, w, size, bold));
    });
  const t = drawing.title;
  // Top row: the title, the part number and the latest revision.
  row(y0 + 24, [
    [0, "TITLE", t.title || info.subject],
    [118, "PART NO.", t.partNumber ?? ""],
    [158, "REV", drawing.revisions?.[drawing.revisions.length - 1]?.rev ?? ""],
  ], 5, true);
  // Middle row: design, material, company.
  row(y0 + 12, [
    [0, "DESIGN", info.designName],
    [64, "MATERIAL", t.material ?? ""],
    [118, "COMPANY", t.company ?? ""],
  ], 3.5);
  // Bottom row: drawn by, date, scale, sheet, units, projection.
  row(y0, [
    [0, "DRAWN BY", t.drawnBy ?? ""],
    [50, "DATE", info.date],
    [80, "SCALE", scaleLabel(scale)],
    // A drawing with several sheets numbers them; the paper size moves into the label.
    (info.sheetCount ?? 1) > 1 ? [102, `SHEET ${drawing.sheet}`, `${info.sheetNo ?? 1} OF ${info.sheetCount}`] : [102, "SHEET", drawing.sheet],
    [120, "UNITS", lengthUnit()],
    [138, "PROJECTION", ""],
  ], 3.2);
  out.push(...projectionSymbol(x0 + 145, y0 + 5, drawing.projection === "third"));

  // Notes, just above the title block.
  // Parts list (assemblies), just above the title block: item, part, quantity — and part number,
  // description and weight each when any part has them.
  let top = y0 + TITLE_H;
  const bom = info.bom ?? [];
  if (bom.length) {
    const rows = [...bom].reverse();
    const h = (rows.length + 1) * BOM_ROW;
    out.push(rect(x0, top, x1, top + h, "border"));
    for (let i = 1; i <= rows.length; i++) out.push(line(x0, top + i * BOM_ROW, x1, top + i * BOM_ROW));
    // Columns from the left: item, [part number], part, [description]; from the right: quantity, [weight].
    const numberW = bom.some((r) => r.number) ? 30 : 0;
    const weightW = bom.some((r) => r.weight) ? 22 : 0;
    const partX = x0 + 15 + numberW;
    const qtyX = x1 - 20;
    const weightX = qtyX - weightW;
    const descW = bom.some((r) => r.description) ? Math.max(0, Math.min(55, (weightX - partX) / 2)) : 0;
    const descX = weightX - descW;
    const walls = [x0 + 15, qtyX, ...(numberW ? [partX] : []), ...(weightW ? [weightX] : []), ...(descW ? [descX] : [])];
    out.push(...walls.map((x) => line(x, top, x, top + h)));
    const cell = (x: number, w: number, y: number, text: string, anchor: "start" | "middle") =>
      out.push({ kind: "text", x: anchor === "middle" ? x + w / 2 : x + 2, y, text, size: fitSize(text, w - 3, 3), anchor });
    rows.forEach((r, i) => {
      const y = top + i * BOM_ROW + 1.8;
      out.push({ kind: "text", x: x0 + 7.5, y, text: String(r.item), size: 3, anchor: "middle" });
      if (numberW && r.number) cell(x0 + 15, numberW, y, r.number, "start");
      cell(partX, descX - partX, y, r.name, "start");
      if (descW && r.description) cell(descX, descW, y, r.description, "start");
      if (weightW && r.weight) cell(weightX, weightW, y, r.weight, "middle");
      out.push({ kind: "text", x: x1 - 10, y, text: String(r.quantity), size: 3, anchor: "middle" });
    });
    const hy = top + rows.length * BOM_ROW + 1.8;
    const head = (x: number, text: string, anchor: "start" | "middle" = "start") => out.push({ kind: "text", x, y: hy, text, size: 2.5, anchor, bold: true });
    head(x0 + 7.5, "ITEM", "middle");
    if (numberW) head(x0 + 17, "PART NO.");
    head(partX + 2, "PART");
    if (descW) head(descX + 2, "DESCRIPTION");
    if (weightW) head(weightX + weightW / 2, "WEIGHT EACH", "middle");
    head(x1 - 10, "QTY", "middle");
    top += h;
  }

  // Hole table, above that (unless it's been dragged elsewhere): tag, position from the corner, size.
  let holeTable: SheetLayout["holeTable"];
  if (holes.length) {
    const shape = holeTableShape(holes.length, size);
    // (Where its top-left corner was dragged to.)
    const at = drawing.holeTableAt;
    const left = at ? at[0] : x1 - shape.w;
    const bottom = at ? at[1] - shape.h : top;
    out.push(...holeTablePrims(holes, shape, left, bottom));
    holeTable = { box: [left, bottom, left + shape.w, bottom + shape.h], tall: shape.tall };
    if (!at) top += shape.h;
  }

  // Revisions, above that: letter, what changed, date (newest at the top).
  const revs = drawing.revisions ?? [];
  if (revs.length) {
    const h = (revs.length + 1) * BOM_ROW;
    const cols = [x0 + 15, x1 - 25];
    out.push(rect(x0, top, x1, top + h, "border"));
    for (let i = 1; i <= revs.length; i++) out.push(line(x0, top + i * BOM_ROW, x1, top + i * BOM_ROW));
    for (const cx of cols) out.push(line(cx, top, cx, top + h));
    revs.forEach((r, i) => {
      const y = top + i * BOM_ROW + 1.8;
      out.push({ kind: "text", x: x0 + 7.5, y, text: r.rev, size: 3, anchor: "middle" });
      out.push({ kind: "text", x: cols[0] + 2, y, text: r.description, size: fitSize(r.description, cols[1] - cols[0] - 3, 3), anchor: "start" });
      out.push({ kind: "text", x: (cols[1] + x1) / 2, y, text: r.date, size: 3, anchor: "middle" });
    });
    const hy = top + revs.length * BOM_ROW + 1.8;
    out.push({ kind: "text", x: x0 + 7.5, y: hy, text: "REV", size: 2.5, anchor: "middle", bold: true });
    out.push({ kind: "text", x: cols[0] + 2, y: hy, text: "DESCRIPTION", size: 2.5, anchor: "start", bold: true });
    out.push({ kind: "text", x: (cols[1] + x1) / 2, y: hy, text: "DATE", size: 2.5, anchor: "middle", bold: true });
    top += h;
  }

  // Notes, above that.
  const notes = notesOf(drawing);
  notes.forEach((t, i) => out.push({ kind: "text", x: x0, y: top + 4 + (notes.length - 1 - i) * NOTE_LINE, text: t, size: 3, anchor: "start" }));
  if (notes.length) out.push({ kind: "text", x: x0, y: top + 4 + notes.length * NOTE_LINE, text: "NOTES", size: 3, anchor: "start", bold: true });
  return { prims: out, ...(holeTable ? { holeTable } : {}) };
}

/**
 * The hole table's lines and text, from its bottom-left corner: one column
 * across the title block's width, or wrapped into narrower columns (each
 * with its heading), filled left to right.
 */
function holeTablePrims(holes: HoleRow[], shape: ReturnType<typeof holeTableShape>, left: number, bottom: number): Prim[] {
  const out: Prim[] = [];
  const blockW = shape.columns === 1 ? shape.w : HOLE_BLOCK_W;
  // Column edges in a block: one column keeps its old proportions; wrapped ones are narrower.
  const edges = shape.columns === 1 ? [15, 50, 85] : [12, 30, 48];
  const h = (shape.rows + 1) * BOM_ROW;
  const top = bottom + h;
  for (let c = 0; c < shape.columns; c++) {
    const rows = holes.slice(c * shape.rows, (c + 1) * shape.rows);
    if (!rows.length) break;
    const x0 = left + c * blockW;
    const x1 = x0 + blockW;
    const cols = edges.map((e) => x0 + e);
    out.push(rect(x0, bottom, x1, top, "border"));
    // The heading at the top, then the holes in order down each column.
    for (let i = 1; i <= shape.rows; i++) out.push(line(x0, bottom + i * BOM_ROW, x1, bottom + i * BOM_ROW));
    for (const cx of cols) out.push(line(cx, bottom, cx, top));
    const mids = [(x0 + cols[0]) / 2, (cols[0] + cols[1]) / 2, (cols[1] + cols[2]) / 2, (cols[2] + x1) / 2];
    const room = [cols[0] - x0, cols[1] - cols[0], cols[2] - cols[1], x1 - cols[2]].map((w) => w - 1.5);
    const cell = (i: number, y: number, text: string, bold = false): Prim => ({ kind: "text", x: mids[i], y, text, size: fitSize(text, room[i], bold ? 2.5 : 3, bold), anchor: "middle", ...(bold ? { bold } : {}) });
    // (Bottom row first; a short last column leaves its bottom rows blank.)
    [...rows].reverse().forEach((r, j) => {
      const y = bottom + (shape.rows - rows.length + j) * BOM_ROW + 1.8;
      out.push(cell(0, y, r.tag), cell(1, y, lengthNumber(r.x)), cell(2, y, lengthNumber(r.y)), cell(3, y, `Ø${lengthNumber(r.diameter)}`));
    });
    const hy = top - BOM_ROW + 1.8;
    out.push(cell(0, hy, "HOLE", true), cell(1, hy, "X", true), cell(2, hy, "Y", true), cell(3, hy, "SIZE", true));
  }
  return out;
}
