/**
 * A drawing sheet worked out as simple shapes — lines and text in sheet
 * millimetres (from the bottom-left corner, y up). The screen, the SVG file
 * and the PDF file are all drawn from this one list, so they always match.
 *
 * Layout follows ISO first-angle projection (as used in the UK and Europe):
 * the view from the top goes below the front view, the view from the right
 * goes to its left.
 */
import type { ViewProjection } from "../kernel/protocol";
import type { Drawing, SheetSize, ViewKind } from "../model/types";
import { drawDimension, measureDim, resolveDim } from "./dimensions";

export type LineStyle = "border" | "visible" | "hidden" | "thin";

export type Prim =
  | { kind: "path"; points: number[]; closed?: boolean; fill?: boolean; style: LineStyle }
  | { kind: "text"; x: number; y: number; text: string; size: number; anchor: "start" | "middle" | "end"; bold?: boolean; rotate?: number };

export const SHEETS: Record<SheetSize, [number, number]> = { A4: [297, 210], A3: [420, 297], A2: [594, 420] };

/** Standard drawing scales, biggest first (2 = 2:1, 0.5 = 1:2). */
export const STANDARD_SCALES = [10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01];

export function scaleLabel(s: number): string {
  if (s >= 1) return `${Math.round(s * 100) / 100}:1`;
  return `1:${Math.round((1 / s) * 100) / 100}`;
}

/** Line widths (mm) and dash patterns for each style. */
export const LINE_STYLES: Record<LineStyle, { width: number; dash?: [number, number] }> = {
  border: { width: 0.7 },
  visible: { width: 0.5 },
  hidden: { width: 0.25, dash: [3, 1.5] },
  thin: { width: 0.25 },
};

const MARGIN = 10;
const TITLE_W = 180;
const TITLE_H = 36;
/** Space between views on the paper (mm). */
const GAP = 15;

export interface PlacedView {
  id: string;
  kind: ViewKind;
  /** Where the middle of the view is on the sheet. */
  centre: [number, number];
  /** The view's outline on the sheet: x0, y0, x1, y1. */
  box: [number, number, number, number];
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
}

export interface SheetLayout {
  size: [number, number];
  scale: number;
  /** True when even the smallest scale doesn't fit (the views may run off the sheet). */
  tooBig: boolean;
  views: PlacedView[];
  dims: PlacedDim[];
  prims: Prim[];
}

export interface SheetInfo {
  /** The design's name. */
  designName: string;
  /** What's drawn (the part's name). */
  subject: string;
  /** Date shown in the title block, e.g. "14/10/2026". */
  date: string;
}

const sizeOf = (p: ViewProjection | undefined): [number, number] => (p?.bounds ? [p.bounds[2] - p.bounds[0], p.bounds[3] - p.bounds[1]] : [0, 0]);
const centreOf = (p: ViewProjection | undefined): [number, number] =>
  p?.bounds ? [(p.bounds[0] + p.bounds[2]) / 2, (p.bounds[1] + p.bounds[3]) / 2] : [0, 0];

/** The area views may use: the frame, minus a strip above the title block. */
function viewArea(size: [number, number]): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: MARGIN + 5, y0: MARGIN + TITLE_H + 5, x1: size[0] - MARGIN - 5, y1: size[1] - MARGIN - 5 };
}

/** Width and height the arrangement needs on paper at a scale. */
function needed(projections: Partial<Record<ViewKind, ViewProjection>>, kinds: Set<ViewKind>, s: number): { w: number; h: number; cols: number[]; rows: number[]; iso: [number, number] } {
  const size = (k: ViewKind) => (kinds.has(k) ? sizeOf(projections[k]).map((v) => v * s) : [0, 0]);
  const [fw, fh] = size("front");
  const cols = [size("right")[0], fw, size("left")[0], size("back")[0]];
  const rows = [size("bottom")[1], fh, size("top")[1]];
  const iso = size("iso") as [number, number];
  const used = (list: number[]) => list.filter((v) => v > 0);
  const gridW = used(cols).reduce((a, b) => a + b, 0) + GAP * Math.max(0, used(cols).length - 1);
  const gridH = used(rows).reduce((a, b) => a + b, 0) + GAP * Math.max(0, used(rows).length - 1);
  const w = gridW + (iso[0] > 0 ? (gridW > 0 ? GAP : 0) + iso[0] : 0);
  const h = Math.max(gridH, iso[1]);
  return { w, h, cols, rows, iso };
}

/** The biggest standard scale at which all the views fit on the sheet. */
export function fitScale(projections: Partial<Record<ViewKind, ViewProjection>>, kinds: ViewKind[], sheet: SheetSize): { scale: number; fits: boolean } {
  const area = viewArea(SHEETS[sheet]);
  const set = new Set(kinds);
  for (const s of STANDARD_SCALES) {
    const n = needed(projections, set, s);
    if (n.w <= area.x1 - area.x0 && n.h <= area.y1 - area.y0) return { scale: s, fits: true };
  }
  return { scale: STANDARD_SCALES[STANDARD_SCALES.length - 1], fits: false };
}

/** Work out where everything goes on the sheet. */
export function layoutSheet(drawing: Drawing, projections: Partial<Record<ViewKind, ViewProjection>>, info: SheetInfo): SheetLayout {
  const size = SHEETS[drawing.sheet];
  const kinds = drawing.views.map((v) => v.kind).filter((k) => projections[k]?.bounds);
  const auto = fitScale(projections, kinds, drawing.sheet);
  const scale = drawing.scale ?? auto.scale;
  const area = viewArea(size);
  const n = needed(projections, new Set(kinds), scale);

  // Automatic places: the grid of aligned views centred in the area, the 3D view to its right.
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
  const autoCentre: Record<ViewKind, [number, number]> = {
    right: [colX[0], rowY[1]],
    front: [colX[1], rowY[1]],
    left: [colX[2], rowY[1]],
    back: [colX[3], rowY[1]],
    bottom: [colX[1], rowY[0]],
    top: [colX[1], rowY[2]],
    iso: [(gridRight > left ? gridRight + GAP : left) + n.iso[0] / 2, top - n.iso[1] / 2],
  };

  // Views the user moved keep their place — but views lined up with the front view stay lined up with it.
  const placedAt = (k: ViewKind) => drawing.views.find((v) => v.kind === k)?.at;
  const front: [number, number] = placedAt("front") ?? autoCentre.front;
  const dx = front[0] - autoCentre.front[0];
  const dy = front[1] - autoCentre.front[1];
  const centreFor = (k: ViewKind): [number, number] => {
    const at = placedAt(k);
    if (k === "front") return front;
    if (k === "iso") return at ?? [autoCentre.iso[0], autoCentre.iso[1]];
    if (k === "top" || k === "bottom") return [front[0], at ? at[1] : autoCentre[k][1] + dy];
    return [at ? at[0] : autoCentre[k][0] + dx, front[1]];
  };

  const prims: Prim[] = [];
  const views: PlacedView[] = [];
  for (const v of drawing.views) {
    const p = projections[v.kind];
    if (!p?.bounds) continue;
    const centre = centreFor(v.kind);
    const [cx, cy] = centreOf(p);
    const map = (line: number[]) => line.map((val, i) => (i % 2 === 0 ? centre[0] + (val - cx) * scale : centre[1] + (val - cy) * scale));
    for (const line of drawing.hiddenLines ? p.hidden : []) prims.push({ kind: "path", points: map(line), style: "hidden" });
    for (const line of p.visible) prims.push({ kind: "path", points: map(line), style: "visible" });
    const [w, h] = sizeOf(p).map((d) => d * scale);
    views.push({ id: v.id, kind: v.kind, centre, box: [centre[0] - w / 2, centre[1] - h / 2, centre[0] + w / 2, centre[1] + h / 2] });
  }

  // Dimensions, on the views they belong to.
  const dims: PlacedDim[] = [];
  for (const dim of drawing.dimensions ?? []) {
    const view = views.find((v) => v.kind === dim.view);
    const p = projections[dim.view];
    if (!view || !p) continue;
    const resolved = resolveDim(dim, p);
    const at = ([x, y]: [number, number]) => toSheet(view, p, scale, x, y);
    const drawn = drawDimension(dim, resolved, at, measureDim(dim, resolved));
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
      rad: (resolved.r ?? 0) * scale,
    });
  }

  prims.push(...frameAndTitle(size, drawing, scale, info));
  return { size, scale, tooBig: !drawing.scale && !auto.fits, views, dims, prims };
}

/** Where a point of a view (in its own mm) lands on the sheet. */
export function toSheet(view: PlacedView, projection: ViewProjection, scale: number, x: number, y: number): [number, number] {
  const [cx, cy] = centreOf(projection);
  return [view.centre[0] + (x - cx) * scale, view.centre[1] + (y - cy) * scale];
}

const rect = (x0: number, y0: number, x1: number, y1: number, style: LineStyle): Prim => ({ kind: "path", points: [x0, y0, x1, y0, x1, y1, x0, y1], closed: true, style });
const line = (x0: number, y0: number, x1: number, y1: number, style: LineStyle = "thin"): Prim => ({ kind: "path", points: [x0, y0, x1, y1], style });

function circle(cx: number, cy: number, r: number, style: LineStyle): Prim {
  const points: number[] = [];
  for (let i = 0; i < 36; i++) points.push(cx + r * Math.cos((i / 36) * 2 * Math.PI), cy + r * Math.sin((i / 36) * 2 * Math.PI));
  return { kind: "path", points, closed: true, style };
}

/** The border, the title block and the first-angle projection symbol. */
function frameAndTitle(size: [number, number], drawing: Drawing, scale: number, info: SheetInfo): Prim[] {
  const [W, H] = size;
  const out: Prim[] = [rect(MARGIN, MARGIN, W - MARGIN, H - MARGIN, "border")];
  const x0 = W - MARGIN - TITLE_W;
  const x1 = W - MARGIN;
  const y0 = MARGIN;
  out.push(rect(x0, y0, x1, y0 + TITLE_H, "border"));
  out.push(line(x0, y0 + 12, x1, y0 + 12), line(x0, y0 + 24, x1, y0 + 24));
  const label = (x: number, y: number, text: string): Prim => ({ kind: "text", x: x + 1.5, y: y - 3, text, size: 2.2, anchor: "start" });
  const value = (x: number, y: number, text: string, size = 3.5, bold = false): Prim => ({ kind: "text", x: x + 1.5, y: y + 2.5, text, size, anchor: "start", bold });

  // Top row: the title.
  out.push(label(x0, y0 + 36, "TITLE"), value(x0, y0 + 24.5, drawing.title.title || info.subject, 5, true));
  // Middle row: design and material.
  out.push(line(x0 + 100, y0 + 12, x0 + 100, y0 + 24));
  out.push(label(x0, y0 + 24, "DESIGN"), value(x0, y0 + 13.5, info.designName));
  out.push(label(x0 + 100, y0 + 24, "MATERIAL"), value(x0 + 100, y0 + 13.5, drawing.title.material ?? ""));
  // Bottom row: drawn by, date, scale, sheet, units, projection.
  const cells: [number, string, string][] = [
    [0, "DRAWN BY", drawing.title.drawnBy ?? ""],
    [50, "DATE", info.date],
    [80, "SCALE", scaleLabel(scale)],
    [102, "SHEET", drawing.sheet],
    [120, "UNITS", "mm"],
    [138, "PROJECTION", ""],
  ];
  for (const [dx, l, v] of cells) {
    if (dx > 0) out.push(line(x0 + dx, y0, x0 + dx, y0 + 12));
    out.push(label(x0 + dx, y0 + 12, l), value(x0 + dx, y0 + 1.5, v, 3.2));
  }
  // First-angle symbol: the end view (circles) to the left of the side view (cone).
  const sx = x0 + 145;
  const sy = y0 + 5;
  out.push(circle(sx + 4, sy, 3.5, "thin"), circle(sx + 4, sy, 1.75, "thin"));
  out.push({ kind: "path", points: [sx + 11, sy - 1.75, sx + 22, sy - 3.5, sx + 22, sy + 3.5, sx + 11, sy + 1.75], closed: true, style: "thin" });

  // Notes, just above the title block.
  const notes = (drawing.title.notes ?? "").split("\n").filter((l) => l.trim()).slice(0, 8);
  notes.forEach((t, i) => out.push({ kind: "text", x: x0, y: y0 + TITLE_H + 4 + (notes.length - 1 - i) * 4.5, text: t, size: 3, anchor: "start" }));
  if (notes.length) out.push({ kind: "text", x: x0, y: y0 + TITLE_H + 4 + notes.length * 4.5, text: "NOTES", size: 3, anchor: "start", bold: true });
  return out;
}
