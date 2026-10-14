/**
 * A drawing sheet worked out as simple shapes — lines and text in sheet
 * millimetres (from the bottom-left corner, y up). The screen, the SVG file
 * and the PDF file are all drawn from this one list, so they always match.
 *
 * Layout follows ISO first-angle projection (as used in the UK and Europe):
 * the view from the top goes below the front view, the view from the right
 * goes to its left.
 */
import { lengthUnit } from "../model/units";
import type { ViewProjection } from "../kernel/protocol";
import type { Drawing, SectionCut, SheetSize, ViewKind } from "../model/types";
import { centreLines, centreMarks, hatchLines, placeBalloons } from "./annotations";
import { projectPoint } from "./cameras";
import { fromRel, sectionGeometry, viewKey } from "./sections";
import { drawDimension, measureDim, resolveDim } from "./dimensions";

/** "centre" is the long-and-short dashed line for centre lines and cutting planes. */
export type LineStyle = "border" | "visible" | "hidden" | "thin" | "centre";

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
  /** Notes: where each one's text sits (sheet mm), for picking and dragging. */
  notes: { id: string; box: [number, number, number, number] }[];
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
}

/** A view's size on paper at scale 1 (detail views are drawn `zoom` times bigger). */
const sizeOf = (p: ViewProjection | undefined): [number, number] => {
  const z = p?.zoom ?? 1;
  return p?.bounds ? [(p.bounds[2] - p.bounds[0]) * z, (p.bounds[3] - p.bounds[1]) * z] : [0, 0];
};
const centreOf = (p: ViewProjection | undefined): [number, number] =>
  p?.bounds ? [(p.bounds[0] + p.bounds[2]) / 2, (p.bounds[1] + p.bounds[3]) / 2] : [0, 0];

/** The area views may use: the frame, minus a strip above the title block. */
const BOM_ROW = 6;
const NOTE_LINE = 4.5;

function notesOf(drawing: Drawing): string[] {
  return (drawing.title.notes ?? "").split("\n").filter((l) => l.trim()).slice(0, 8);
}

/** Height kept free at the bottom for the title block, parts list and notes. */
export function bottomReserve(drawing: Pick<Drawing, "title"> | null, bom: BomLine[] | undefined): number {
  const notes = drawing ? notesOf(drawing as Drawing).length : 0;
  return TITLE_H + (bom?.length ? (bom.length + 1) * BOM_ROW + 3 : 0) + (notes ? (notes + 1) * NOTE_LINE + 3 : 0);
}

function viewArea(size: [number, number], reserve = TITLE_H): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: MARGIN + 5, y0: MARGIN + reserve + 5, x1: size[0] - MARGIN - 5, y1: size[1] - MARGIN - 5 };
}

/** A drawing's views' lines, by view key (see viewKey). */
export type Projections = Partial<Record<string, ViewProjection>>;

const isSectionKey = (k: string) => k.startsWith("section:");
const isDetailKey = (k: string) => k.startsWith("detail:");
/** Views placed freely in the side column, with their names underneath. */
const isLabelled = (k: string) => isSectionKey(k) || isDetailKey(k);

/** Width and height the arrangement needs on paper at a scale. */
function needed(
  projections: Projections,
  keys: string[],
  s: number,
): { w: number; h: number; cols: number[]; rows: number[]; side: { key: string; w: number; h: number }[] } {
  const shown = new Set(keys);
  const size = (k: string) => (shown.has(k) ? sizeOf(projections[k]).map((v) => v * s) : [0, 0]);
  const [fw, fh] = size("front");
  const cols = [size("right")[0], fw, size("left")[0], size("back")[0]];
  const rows = [size("bottom")[1], fh, size("top")[1]];
  const used = (list: number[]) => list.filter((v) => v > 0);
  const gridW = used(cols).reduce((a, b) => a + b, 0) + GAP * Math.max(0, used(cols).length - 1);
  const gridH = used(rows).reduce((a, b) => a + b, 0) + GAP * Math.max(0, used(rows).length - 1);
  // The 3D view and the section views share a column to the right, one above another (sections with room for their names).
  const side = ["iso", ...keys.filter(isLabelled)]
    .map((key) => {
      const [w, h] = size(key);
      return { key, w, h: h > 0 && isLabelled(key) ? h + LABEL_ROOM : h };
    })
    .filter((x) => x.w > 0);
  const sideW = Math.max(0, ...side.map((x) => x.w));
  const sideH = side.reduce((t, x) => t + x.h, 0) + GAP * Math.max(0, side.length - 1);
  const w = gridW + (sideW > 0 ? (gridW > 0 ? GAP : 0) + sideW : 0);
  const h = Math.max(gridH, sideH);
  return { w, h, cols, rows, side };
}

/** Room under a section view for its name (mm). */
const LABEL_ROOM = 8;

/** The biggest standard scale at which all the views fit on the sheet. */
export function fitScale(projections: Projections, keys: string[], sheet: SheetSize, reserve = TITLE_H): { scale: number; fits: boolean } {
  const area = viewArea(SHEETS[sheet], reserve);
  for (const s of STANDARD_SCALES) {
    const n = needed(projections, keys, s);
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
  const size = SHEETS[drawing.sheet];
  const keys = drawingViewKeys(drawing).filter((k) => projections[k]?.bounds);
  const reserve = bottomReserve(drawing, info.bom);
  const auto = fitScale(projections, keys, drawing.sheet, reserve);
  const scale = drawing.scale ?? auto.scale;
  const area = viewArea(size, reserve);
  const n = needed(projections, keys, scale);

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
  const autoCentre: Record<string, [number, number]> = {
    right: [colX[0], rowY[1]],
    front: [colX[1], rowY[1]],
    left: [colX[2], rowY[1]],
    back: [colX[3], rowY[1]],
    bottom: [colX[1], rowY[0]],
    top: [colX[1], rowY[2]],
  };
  const sideX = gridRight > left ? gridRight + GAP : left;
  let sideY = top;
  for (const item of n.side) {
    const viewH = isLabelled(item.key) ? item.h - LABEL_ROOM : item.h;
    autoCentre[item.key] = [sideX + item.w / 2, sideY - viewH / 2];
    sideY -= item.h + GAP;
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
    const [cx, cy] = centreOf(p);
    // Detail views are drawn bigger than the rest.
    const vs = scale * (p.zoom ?? 1);
    const map = (line: number[]) => line.map((val, i) => (i % 2 === 0 ? centre[0] + (val - cx) * vs : centre[1] + (val - cy) * vs));
    if (v.kind === "section" && p.cutFaces) {
      for (const seg of hatchLines(p.cutFaces, HATCH_SPACING / scale)) prims.push({ kind: "path", points: map(seg), style: "thin" });
    }
    for (const line of drawing.hiddenLines ? p.hidden : []) prims.push({ kind: "path", points: map(line), style: "hidden" });
    for (const line of p.visible) prims.push({ kind: "path", points: map(line), style: "visible" });
    if (drawing.centreLines !== false) {
      for (const seg of [...centreMarks(p, vs), ...centreLines(p, vs)]) prims.push({ kind: "path", points: map(seg), style: "centre" });
    }
    const [w, h] = sizeOf(p).map((d) => d * scale);
    const box: PlacedView["box"] = [centre[0] - w / 2, centre[1] - h / 2, centre[0] + w / 2, centre[1] + h / 2];
    const cut = v.kind === "section" ? drawing.sections?.find((c) => c.id === v.section) : undefined;
    if (cut) prims.push({ kind: "text", x: centre[0], y: box[1] - 6, text: `SECTION ${cut.letter}-${cut.letter}`, size: 3.5, anchor: "middle", bold: true });
    const detail = v.kind === "detail" ? drawing.details?.find((x) => x.id === v.detail) : undefined;
    if (detail) {
      // The detail's circle, and its name with its own scale.
      prims.push(circle(centre[0], centre[1], (w + h) / 4, "thin"));
      prims.push({ kind: "text", x: centre[0], y: box[1] - 6, text: `DETAIL ${detail.letter} (${scaleLabel(vs)})`, size: 3.5, anchor: "middle", bold: true });
    }
    views.push({ id: v.id, kind: v.kind, key, centre, box });
  }

  // Where each section is cut, on the view its line was drawn on.
  for (const cut of drawing.sections ?? []) {
    if (!views.some((v) => v.key === `section:${cut.id}`)) continue;
    const host = views.find((v) => v.key === cut.host);
    const hp = projections[cut.host];
    if (host && hp?.bounds) prims.push(...cuttingPlane(host, hp, scale, cut));
  }

  // Where each detail comes from: a circle on its host view, with its letter.
  for (const detail of drawing.details ?? []) {
    if (!views.some((v) => v.key === `detail:${detail.id}`)) continue;
    const host = views.find((v) => v.key === detail.host);
    const hp = projections[detail.host];
    if (!host || !hp?.bounds) continue;
    const [x0, y0, x1, y1] = hp.bounds;
    const [px, py] = toSheet(host, hp, scale, x0 + detail.centre[0] * (x1 - x0), y0 + detail.centre[1] * (y1 - y0));
    const r = detail.radius * scale;
    prims.push(circle(px, py, r, "thin"));
    prims.push({ kind: "text", x: px + r * 0.75 + 1.5, y: py + r * 0.75 + 1.5, text: detail.letter, size: 3.5, anchor: "start", bold: true });
  }

  // Balloons: the parts list's item numbers, pointing at the parts.
  if (info.balloons?.length && drawing.balloons !== false) {
    const host = views.find((v) => v.kind === "iso") ?? views.find((v) => v.kind === "front") ?? views.find((v) => v.kind !== "section");
    if (host) prims.push(...balloonPrims(host, projections[host.key]!, scale, info.balloons));
  }

  // Dimensions, on the views they belong to.
  const dims: PlacedDim[] = [];
  for (const dim of drawing.dimensions ?? []) {
    const view = views.find((v) => v.key === dim.view);
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
      rad: (resolved.r ?? 0) * scale * (p.zoom ?? 1),
    });
  }

  // Notes: lines of text from their top-left corner.
  const notes: SheetLayout["notes"] = [];
  for (const note of drawing.notes ?? []) {
    const lines = note.text.split("\n");
    const [x, y] = note.at;
    lines.forEach((line, i) => {
      if (line.trim()) prims.push({ kind: "text", x, y: y - SHEET_NOTE_SIZE - i * SHEET_NOTE_LINE, text: line, size: SHEET_NOTE_SIZE, anchor: "start" });
    });
    const w = Math.max(4, ...lines.map((l) => l.length * SHEET_NOTE_SIZE * 0.55));
    const h = SHEET_NOTE_SIZE + (lines.length - 1) * SHEET_NOTE_LINE + 1;
    notes.push({ id: note.id, box: [x, y - h, x + w, y] });
  }

  prims.push(...frameAndTitle(size, drawing, scale, info));
  return { size, scale, tooBig: !drawing.scale && !auto.fits, views, dims, notes, prims };
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

/** Where a point of a view (in its own mm) lands on the sheet. */
export function toSheet(view: PlacedView, projection: ViewProjection, scale: number, x: number, y: number): [number, number] {
  const [cx, cy] = centreOf(projection);
  const s = scale * (projection.zoom ?? 1);
  return [view.centre[0] + (x - cx) * s, view.centre[1] + (y - cy) * s];
}

const rect = (x0: number, y0: number, x1: number, y1: number, style: LineStyle): Prim => ({ kind: "path", points: [x0, y0, x1, y0, x1, y1, x0, y1], closed: true, style });
const line = (x0: number, y0: number, x1: number, y1: number, style: LineStyle = "thin"): Prim => ({ kind: "path", points: [x0, y0, x1, y1], style });

function circle(cx: number, cy: number, r: number, style: LineStyle): Extract<Prim, { kind: "path" }> {
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
    [120, "UNITS", lengthUnit()],
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
  // Parts list (assemblies), just above the title block: item, part, quantity.
  let top = y0 + TITLE_H;
  const bom = info.bom ?? [];
  if (bom.length) {
    const rows = [...bom].reverse();
    const h = (rows.length + 1) * BOM_ROW;
    out.push(rect(x0, top, x1, top + h, "border"));
    for (let i = 1; i <= rows.length; i++) out.push(line(x0, top + i * BOM_ROW, x1, top + i * BOM_ROW));
    out.push(line(x0 + 15, top, x0 + 15, top + h), line(x1 - 20, top, x1 - 20, top + h));
    rows.forEach((r, i) => {
      const y = top + i * BOM_ROW + 1.8;
      out.push({ kind: "text", x: x0 + 7.5, y, text: String(r.item), size: 3, anchor: "middle" });
      out.push({ kind: "text", x: x0 + 17, y, text: r.name, size: 3, anchor: "start" });
      out.push({ kind: "text", x: x1 - 10, y, text: String(r.quantity), size: 3, anchor: "middle" });
    });
    const hy = top + rows.length * BOM_ROW + 1.8;
    out.push({ kind: "text", x: x0 + 7.5, y: hy, text: "ITEM", size: 2.5, anchor: "middle", bold: true });
    out.push({ kind: "text", x: x0 + 17, y: hy, text: "PART", size: 2.5, anchor: "start", bold: true });
    out.push({ kind: "text", x: x1 - 10, y: hy, text: "QTY", size: 2.5, anchor: "middle", bold: true });
    top += h;
  }

  // Notes, above that.
  const notes = notesOf(drawing);
  notes.forEach((t, i) => out.push({ kind: "text", x: x0, y: top + 4 + (notes.length - 1 - i) * NOTE_LINE, text: t, size: 3, anchor: "start" }));
  if (notes.length) out.push({ kind: "text", x: x0, y: top + 4 + notes.length * NOTE_LINE, text: "NOTES", size: 3, anchor: "start", bold: true });
  return out;
}
