/**
 * Dimensions on drawing views: finding their points again after the part
 * changes, measuring, and drawing them (extension lines, arrows, the number).
 * Sizes on paper follow ISO 129 roughly: 3.5 mm text, 3 mm arrows.
 */
import type { ViewProjection } from "../kernel/protocol";
import type { Dimension, DimPoint } from "../model/types";
import type { Prim } from "./sheet";

type P2 = [number, number];

export const TEXT_SIZE = 3.5;
const ARROW = 3;
const GAP = 1;
const OVERSHOOT = 2;

const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** "40", "12.5", "0.25" (up to 2 decimal places, no trailing zeros). */
export function formatSize(v: number): string {
  const r = Math.round(v * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

function boundsOf(p: ViewProjection): [number, number, number, number] {
  return p.bounds ?? [0, 0, 1, 1];
}

/** A point on a view, remembered both where it is and as a fraction across the view. */
export function dimPoint(at: P2, p: ViewProjection): DimPoint {
  const [x0, y0, x1, y1] = boundsOf(p);
  const fx = x1 > x0 ? (at[0] - x0) / (x1 - x0) : 0.5;
  const fy = y1 > y0 ? (at[1] - y0) / (y1 - y0) : 0.5;
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return { at: [r(at[0]), r(at[1])], rel: [r(fx), r(fy)] };
}

/** Points a dimension can snap to: ends of edges and centres of circles (each once). */
export function snapPoints(p: ViewProjection): P2[] {
  const out: P2[] = [];
  const add = (x: number, y: number) => {
    if (!out.some((q) => Math.abs(q[0] - x) < 1e-6 && Math.abs(q[1] - y) < 1e-6)) out.push([x, y]);
  };
  for (let i = 0; i + 1 < p.points.length; i += 2) add(p.points[i], p.points[i + 1]);
  for (const c of p.circles) add(c.cx, c.cy);
  return out;
}

function findPoint(want: DimPoint, p: ViewProjection): { at: P2; found: boolean } {
  const pts = snapPoints(p);
  const exact = pts.find((q) => dist(q, want.at) < 1e-6);
  if (exact) return { at: exact, found: true };
  const [x0, y0, x1, y1] = boundsOf(p);
  const expected: P2 = [x0 + want.rel[0] * (x1 - x0), y0 + want.rel[1] * (y1 - y0)];
  const size = Math.hypot(x1 - x0, y1 - y0);
  let best: P2 | null = null;
  let bestD = Math.max(0.2 * size, 0.5);
  for (const q of pts) {
    const d = dist(q, expected);
    if (d < bestD) {
      best = q;
      bestD = d;
    }
  }
  return best ? { at: best, found: true } : { at: want.at, found: false };
}

function findCircle(want: DimPoint, r: number, p: ViewProjection): { at: P2; r: number; found: boolean } {
  const exact = p.circles.find((c) => dist([c.cx, c.cy], want.at) < 1e-6 && Math.abs(c.r - r) < 1e-6);
  if (exact) return { at: [exact.cx, exact.cy], r: exact.r, found: true };
  const [x0, y0, x1, y1] = boundsOf(p);
  const expected: P2 = [x0 + want.rel[0] * (x1 - x0), y0 + want.rel[1] * (y1 - y0)];
  const size = Math.hypot(x1 - x0, y1 - y0);
  let best: { at: P2; r: number } | null = null;
  let bestScore = Math.max(0.2 * size, 0.5);
  for (const c of p.circles) {
    const score = dist([c.cx, c.cy], expected) + Math.abs(c.r - r) * 0.5;
    if (score < bestScore) {
      best = { at: [c.cx, c.cy], r: c.r };
      bestScore = score;
    }
  }
  return best ? { ...best, found: true } : { at: want.at, r, found: false };
}

export interface ResolvedDim {
  a: P2;
  b?: P2;
  r?: number;
  /** False when what it measured can't be found any more (it's drawn where it was). */
  found: boolean;
}

/** Where a dimension's points are on the view as the part is now. */
export function resolveDim(dim: Dimension, p: ViewProjection): ResolvedDim {
  if (dim.type === "diameter" || dim.type === "radius") {
    const c = findCircle(dim.a, dim.r ?? 0, p);
    return { a: c.at, r: c.r, found: c.found };
  }
  const a = findPoint(dim.a, p);
  const b = dim.b ? findPoint(dim.b, p) : a;
  return { a: a.at, b: b.at, found: a.found && b.found };
}

/** The size a dimension shows (mm). */
export function measureDim(dim: Dimension, r: ResolvedDim): number {
  const b = r.b ?? r.a;
  switch (dim.type) {
    case "horizontal":
      return Math.abs(b[0] - r.a[0]);
    case "vertical":
      return Math.abs(b[1] - r.a[1]);
    case "aligned":
      return dist(r.a, b);
    case "diameter":
      return 2 * (r.r ?? 0);
    case "radius":
      return r.r ?? 0;
  }
}

export function dimLabel(dim: Dimension, value: number): string {
  return dim.type === "diameter" ? `Ø${formatSize(value)}` : dim.type === "radius" ? `R${formatSize(value)}` : formatSize(value);
}

/** A filled arrowhead with its tip at `tip`, pointing along `dir`. */
function arrow(tip: P2, dir: P2): Prim {
  const l = Math.hypot(dir[0], dir[1]) || 1;
  const u: P2 = [dir[0] / l, dir[1] / l];
  const back: P2 = [tip[0] - u[0] * ARROW, tip[1] - u[1] * ARROW];
  const w = ARROW / 6;
  return { kind: "path", points: [tip[0], tip[1], back[0] - u[1] * w, back[1] + u[0] * w, back[0] + u[1] * w, back[1] - u[0] * w], closed: true, fill: true, style: "thin" };
}

/** Text angle that reads left to right (or bottom to top). */
function readable(angle: number): number {
  let a = angle;
  while (a > 90) a -= 180;
  while (a <= -90) a += 180;
  return a;
}

export interface DimDrawing {
  prims: Prim[];
  /** Where the number sits on the sheet (for picking and dragging). */
  label: P2;
}

/**
 * Draw a dimension on the sheet. `at` turns a view point into sheet
 * millimetres; `value` is what it measures.
 */
export function drawDimension(dim: Dimension, r: ResolvedDim, at: (p: P2) => P2, value: number): DimDrawing {
  const text = dimLabel(dim, value);
  const prims: Prim[] = [];
  if (dim.type === "diameter" || dim.type === "radius") {
    const c = at(r.a);
    const edge = at([r.a[0] + (r.r ?? 0), r.a[1]]);
    const rad = dist(c, edge);
    const ang = ((dim.angle ?? 45) * Math.PI) / 180;
    const u: P2 = [Math.cos(ang), Math.sin(ang)];
    const onCircle: P2 = [c[0] + u[0] * rad, c[1] + u[1] * rad];
    const out = Math.max(dim.offset, 2);
    const elbow: P2 = [onCircle[0] + u[0] * out, onCircle[1] + u[1] * out];
    const side = u[0] >= 0 ? 1 : -1;
    const shoulder = 2 + text.length * TEXT_SIZE * 0.55;
    const end: P2 = [elbow[0] + side * shoulder, elbow[1]];
    const start: P2 = dim.type === "diameter" ? [c[0] - u[0] * rad, c[1] - u[1] * rad] : c;
    prims.push({ kind: "path", points: [start[0], start[1], elbow[0], elbow[1], end[0], end[1]], style: "thin" });
    prims.push(arrow(onCircle, [-u[0], -u[1]]));
    if (dim.type === "diameter") prims.push(arrow(start, u));
    const label: P2 = [(elbow[0] + end[0]) / 2, elbow[1] + 1];
    prims.push({ kind: "text", x: label[0], y: label[1], text, size: TEXT_SIZE, anchor: "middle" });
    return { prims, label };
  }

  const pa = at(r.a);
  const pb = at(r.b ?? r.a);
  // Direction the dimension line runs along, and the way extension lines go.
  let along: P2;
  let across: P2;
  if (dim.type === "horizontal") {
    along = [1, 0];
    across = [0, 1];
  } else if (dim.type === "vertical") {
    along = [0, 1];
    across = [-1, 0];
  } else {
    const d = dist(pa, pb) || 1;
    along = [(pb[0] - pa[0]) / d, (pb[1] - pa[1]) / d];
    across = [-along[1], along[0]];
  }
  const h = (p: P2) => p[0] * across[0] + p[1] * across[1];
  // The line sits `offset` beyond the furthest point (or before the nearest, if negative).
  const base = dim.offset >= 0 ? Math.max(h(pa), h(pb)) + dim.offset : Math.min(h(pa), h(pb)) + dim.offset;
  const onLine = (p: P2): P2 => [p[0] + across[0] * (base - h(p)), p[1] + across[1] * (base - h(p))];
  const la = onLine(pa);
  const lb = onLine(pb);
  const sign = Math.sign(dim.offset) || 1;
  for (const [p, q] of [
    [pa, la],
    [pb, lb],
  ] as [P2, P2][]) {
    const len = dist(p, q);
    if (len < GAP) continue;
    const s: P2 = [p[0] + across[0] * sign * GAP, p[1] + across[1] * sign * GAP];
    const e: P2 = [q[0] + across[0] * sign * OVERSHOOT, q[1] + across[1] * sign * OVERSHOOT];
    prims.push({ kind: "path", points: [s[0], s[1], e[0], e[1]], style: "thin" });
  }
  prims.push({ kind: "path", points: [la[0], la[1], lb[0], lb[1]], style: "thin" });
  const dir: P2 = [lb[0] - la[0], lb[1] - la[1]];
  if (Math.hypot(dir[0], dir[1]) > 2 * ARROW) {
    prims.push(arrow(la, [-dir[0], -dir[1]]), arrow(lb, dir));
  } else {
    // Too short for arrows inside: point them in from outside.
    prims.push(arrow(la, dir), arrow(lb, [-dir[0], -dir[1]]));
  }
  const angle = readable((Math.atan2(along[1], along[0]) * 180) / Math.PI);
  const mid: P2 = [(la[0] + lb[0]) / 2, (la[1] + lb[1]) / 2];
  const rad = (angle * Math.PI) / 180;
  // "Above" the line, as you'd read the text.
  const up: P2 = [-Math.sin(rad), Math.cos(rad)];
  const label: P2 = [mid[0] + up[0] * 1.2, mid[1] + up[1] * 1.2];
  prims.push({ kind: "text", x: label[0], y: label[1], text, size: TEXT_SIZE, anchor: "middle", ...(angle !== 0 ? { rotate: angle } : {}) });
  return { prims, label };
}

/**
 * Which kind of length dimension, and how far out, for points a and b (sheet
 * mm) and where the pointer is: above or below them gives a horizontal one,
 * beside them a vertical one, and in between a slanted (aligned) one.
 */
export function placeLength(a: P2, b: P2, cursor: P2): { type: "horizontal" | "vertical" | "aligned"; offset: number } {
  const minX = Math.min(a[0], b[0]);
  const maxX = Math.max(a[0], b[0]);
  const minY = Math.min(a[1], b[1]);
  const maxY = Math.max(a[1], b[1]);
  const flatX = maxX - minX < 1e-6;
  const flatY = maxY - minY < 1e-6;
  const horizontal = () => ({ type: "horizontal" as const, offset: cursor[1] >= maxY ? cursor[1] - maxY : cursor[1] < minY ? cursor[1] - minY : 8 });
  // Vertical dimension lines are measured with "across" pointing left (−x).
  const vertical = () => ({ type: "vertical" as const, offset: cursor[0] <= minX ? minX - cursor[0] : cursor[0] > maxX ? maxX - cursor[0] : 8 });
  if (flatY && !flatX) return horizontal();
  if (flatX && !flatY) return vertical();
  const outY = cursor[1] > maxY ? cursor[1] - maxY : cursor[1] < minY ? minY - cursor[1] : 0;
  const outX = cursor[0] > maxX ? cursor[0] - maxX : cursor[0] < minX ? minX - cursor[0] : 0;
  if (outY > 0 || outX > 0) return outY >= outX ? horizontal() : vertical();
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const across: P2 = [-(b[1] - a[1]) / d, (b[0] - a[0]) / d];
  const h = (p: P2) => p[0] * across[0] + p[1] * across[1];
  const t = h(cursor) - Math.max(h(a), h(b));
  return { type: "aligned", offset: t >= 0 ? t : h(cursor) - Math.min(h(a), h(b)) };
}

/** New offset (and leader angle for circles) when a dimension's number is dragged to `cursor` (sheet mm). */
export function dragDimension(dim: Dimension, a: P2, b: P2 | null, rad: number, cursor: P2): { offset: number; angle?: number } {
  if (dim.type === "diameter" || dim.type === "radius") {
    const angle = (Math.atan2(cursor[1] - a[1], cursor[0] - a[0]) * 180) / Math.PI;
    return { offset: Math.max(2, Math.round((dist(cursor, a) - rad) * 10) / 10), angle: Math.round(angle) };
  }
  const q = b ?? a;
  const r = (v: number) => Math.round(v * 10) / 10;
  if (dim.type === "horizontal") {
    const minY = Math.min(a[1], q[1]);
    const maxY = Math.max(a[1], q[1]);
    return { offset: r(cursor[1] >= (minY + maxY) / 2 ? cursor[1] - maxY : cursor[1] - minY) };
  }
  if (dim.type === "vertical") {
    const minX = Math.min(a[0], q[0]);
    const maxX = Math.max(a[0], q[0]);
    return { offset: r(cursor[0] <= (minX + maxX) / 2 ? minX - cursor[0] : maxX - cursor[0]) };
  }
  const d = dist(a, q) || 1;
  const across: P2 = [-(q[1] - a[1]) / d, (q[0] - a[0]) / d];
  return { offset: r(cursor[0] * across[0] + cursor[1] * across[1] - (a[0] * across[0] + a[1] * across[1])) };
}
