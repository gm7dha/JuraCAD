/**
 * Auto dimension: adds the dimensions a drawing usually needs, like Onshape's
 * auto-dimension —
 *  - each direction (left–right, front–back, up–down) is dimensioned once, in
 *    the first standard view that shows it, from one corner (baseline
 *    dimensioning): every step in the outline plus the overall size;
 *  - holes and round bosses: one diameter for each size, and their centres
 *    located from the same corner (in the view where they show as circles);
 *  - fillets (rounded corners): one radius for each size.
 * Points are the views' own corner and centre points, so the dimensions
 * follow the part when it changes. What's already dimensioned isn't repeated.
 */
import type { ViewHole, ViewProjection } from "../kernel/protocol";
import { holeAt, holeOfCircle, matchingHoles } from "./holeCallouts";
import type { Dimension, ViewKind } from "../model/types";
import { dimPoint } from "./dimensions";
import type { Projections } from "./sheet";

type P2 = [number, number];
type Axis = "x" | "y" | "z";
type Dir = "h" | "v";

/** Which world direction (and which way round) each standard view shows across and up the paper. */
const VIEW_AXES: Partial<Record<ViewKind, Record<Dir, { axis: Axis; sign: 1 | -1 }>>> = {
  front: { h: { axis: "x", sign: 1 }, v: { axis: "z", sign: 1 } },
  top: { h: { axis: "x", sign: 1 }, v: { axis: "y", sign: 1 } },
  right: { h: { axis: "y", sign: 1 }, v: { axis: "z", sign: 1 } },
  left: { h: { axis: "y", sign: -1 }, v: { axis: "z", sign: 1 } },
  back: { h: { axis: "x", sign: -1 }, v: { axis: "z", sign: 1 } },
  bottom: { h: { axis: "x", sign: 1 }, v: { axis: "y", sign: -1 } },
};
/** Where each view's rows of dimensions go, clear of the views around it. */
const SIDES: Partial<Record<ViewKind, { h: "above" | "below"; v: "left" | "right" }>> = {
  front: { h: "above", v: "right" },
  top: { h: "below", v: "right" },
  bottom: { h: "above", v: "right" },
  right: { h: "below", v: "left" },
  left: { h: "below", v: "right" },
  back: { h: "below", v: "right" },
};
/** The same for third-angle layouts, where the top view sits above the front view and the right view to its right. */
const SIDES_THIRD: Partial<Record<ViewKind, { h: "above" | "below"; v: "left" | "right" }>> = {
  front: { h: "below", v: "left" },
  top: { h: "above", v: "right" },
  bottom: { h: "below", v: "right" },
  right: { h: "below", v: "right" },
  left: { h: "below", v: "left" },
  back: { h: "below", v: "right" },
};
const ORDER: ViewKind[] = ["front", "top", "right", "left", "back", "bottom"];

/** Gap between the view and the first dimension line, and between rows (paper mm). */
export const FIRST_ROW = 10;
export const ROW_STEP = 7;
/** Most dimensions from one corner in one direction (beyond this it gets cluttered). */
const MAX_PER_ROW = 10;

const EPS = 1e-4;
const key = (v: number) => Math.round(v / EPS) * EPS;
const same = (a: number, b: number) => Math.abs(a - b) < 1e-3;

/** Corner and end points of the outline: snap points that aren't just where a rounded corner starts or ends. */
export function outlinePoints(p: ViewProjection): P2[] {
  const out: P2[] = [];
  const onCircle = (x: number, y: number) => p.circles.some((c) => Math.abs(Math.hypot(x - c.cx, y - c.cy) - c.r) < 1e-4);
  // Only ends of visible lines: hidden (dashed) edges are dimensioned in the view where they show.
  // Ends of straight edges are corners worth dimensioning; ends of curves (a thread's or coil's
  // turns, a spline) only where they reach the edge of the view, for its overall size.
  const [bx0, by0, bx1, by1] = p.bounds ?? [0, 0, 0, 0];
  const onEdge = (x: number, y: number) => Math.min(Math.abs(x - bx0), Math.abs(x - bx1), Math.abs(y - by0), Math.abs(y - by1)) < 1e-4;
  const ends: P2[] = [];
  for (const line of p.visible) {
    if (line.length < 4) continue;
    const straight = line.length === 4;
    for (const q of [[line[0], line[1]], [line[line.length - 2], line[line.length - 1]]] as P2[]) if (straight || onEdge(q[0], q[1])) ends.push(q);
  }
  const seen = (x: number, y: number) => ends.some((q) => Math.abs(q[0] - x) < 1e-4 && Math.abs(q[1] - y) < 1e-4) && !inThread(p, x, y);
  for (let i = 0; i + 1 < p.points.length; i += 2) {
    const [x, y] = [p.points[i], p.points[i + 1]];
    if (onCircle(x, y) || !seen(x, y)) continue;
    if (!out.some((q) => Math.abs(q[0] - x) < 1e-6 && Math.abs(q[1] - y) < 1e-6)) out.push([x, y]);
  }
  return out;
}

/**
 * Is a point part of a modelled thread (its crests and roots), along the
 * length the view's thread marks cover? Those are drawn, but not dimensioned
 * one by one: the thread's size and length say it all.
 */
function inThread(p: ViewProjection, x: number, y: number): boolean {
  for (const m of p.threadMarks ?? []) {
    const l = m.line;
    if (l.length < 4) continue;
    const [ax, ay, bx, by] = [l[0], l[1], l[l.length - 2], l[l.length - 1]];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-6) continue;
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    // Along the mark (strictly inside its length), and within a thread's depth of it either side.
    const along = (x - ax) * ux + (y - ay) * uy;
    const across = Math.abs((x - ax) * -uy + (y - ay) * ux);
    if (along > 1e-3 && along < len - 1e-3 && across < Math.max(1, len * 0.02) + 0.35 * markSpread(p)) return true;
  }
  return false;
}

/** The distance between a view's two outermost parallel thread marks (about a thread's minor diameter), or 0. */
function markSpread(p: ViewProjection): number {
  const mids = (p.threadMarks ?? []).filter((m) => m.line.length >= 4).map((m) => [(m.line[0] + m.line[m.line.length - 2]) / 2, (m.line[1] + m.line[m.line.length - 1]) / 2]);
  let best = 0;
  for (const a of mids) for (const b of mids) best = Math.max(best, Math.hypot(a[0] - b[0], a[1] - b[1]));
  return best;
}

interface Row {
  view: string;
  dir: Dir;
  /** Coordinates (in the view, along `dir`) to dimension from the corner. */
  values: number[];
}

/**
 * The dimensions to add to a drawing. `views` are the drawing's view keys,
 * `scale` the sheet scale (paper mm per model mm), `newId` makes ids.
 */
export function autoDimensions(projections: Projections, views: string[], existing: Dimension[], scale: number, newId: () => string, third = false): Dimension[] {
  const out: Dimension[] = [];
  const standard = ORDER.filter((k) => views.includes(k) && projections[k]?.bounds);
  if (!standard.length) return out;

  // Each world direction goes in the first view that shows it.
  const owner = new Map<Axis, { view: ViewKind; dir: Dir }>();
  for (const k of standard) {
    for (const dir of ["h", "v"] as Dir[]) {
      const a = VIEW_AXES[k]![dir].axis;
      if (!owner.has(a)) owner.set(a, { view: k, dir });
    }
  }

  // World coordinates already covered, per direction (so circle centres aren't repeated in another view).
  const covered = new Map<Axis, Set<number>>([
    ["x", new Set()],
    ["y", new Set()],
    ["z", new Set()],
  ]);
  const world = (k: ViewKind, dir: Dir, v: number) => key(v * VIEW_AXES[k]![dir].sign);
  const rows: Row[] = [];
  for (const [axis, { view, dir }] of owner) {
    const p = projections[view]!;
    const pts = outlinePoints(p);
    const centres = p.circles.filter((c) => c.full && !c.hidden).map((c): P2 => [c.cx, c.cy]);
    const i = dir === "h" ? 0 : 1;
    const values = [...new Set([...pts, ...centres].map((q) => key(q[i])))].sort((a, b) => a - b);
    rows.push({ view, dir, values });
    for (const v of values) covered.get(axis)!.add(world(view, dir, v));
  }
  // Circle centres in other views, along directions dimensioned elsewhere but not at this position.
  for (const k of standard) {
    const p = projections[k]!;
    const centres = p.circles.filter((c) => c.full && !c.hidden);
    if (!centres.length) continue;
    for (const dir of ["h", "v"] as Dir[]) {
      const axis = VIEW_AXES[k]![dir].axis;
      const o = owner.get(axis)!;
      if (o.view === k && o.dir === dir) continue;
      const missing = centres.map((c) => key(dir === "h" ? c.cx : c.cy)).filter((v) => !covered.get(axis)!.has(world(k, dir, v)));
      if (!missing.length) continue;
      rows.push({ view: k, dir, values: [...new Set(missing)].sort((a, b) => a - b) });
      for (const v of missing) covered.get(axis)!.add(world(k, dir, v));
    }
  }

  for (const row of rows) out.push(...baseline(projections[row.view]!, row, existing, scale, newId, third));
  out.push(...circleSizes(projections, standard, existing, newId));
  return out;
}

export type Side = "above" | "below" | "left" | "right";

/** Which side of a view a row of across ("h") or up-and-down ("v") dimensions goes. */
export function rowSide(view: string, dir: "h" | "v", third = false): Side {
  const side = (third ? SIDES_THIRD : SIDES)[view as ViewKind] ?? { h: "below", v: "right" };
  return dir === "h" ? side.h : side.v;
}

/**
 * The offset that puts a dimension between view points a and b on row `row`
 * (0 = nearest) on one side of the view. Lengths are drawn `offset` beyond the
 * furthest point (positive) or before the nearest (negative); vertical
 * dimensions measure "across" leftwards, so for them positive is to the left.
 */
export function rowOffset(p: ViewProjection, side: Side, a: P2, b: P2, scale: number, row: number): number {
  const [x0, y0, x1, y1] = p.bounds ?? [0, 0, 0, 0];
  const gap = FIRST_ROW + row * ROW_STEP;
  if (side === "below") return -((Math.min(a[1], b[1]) - y0) * scale + gap);
  if (side === "above") return (y1 - Math.max(a[1], b[1])) * scale + gap;
  if (side === "left") return (Math.min(a[0], b[0]) - x0) * scale + gap;
  return -((x1 - Math.max(a[0], b[0])) * scale + gap);
}

/**
 * Which style suits a row of positions (distances from the corner, nearest first):
 *  - evenly spaced features (like a row of holes): a chain of the equal gaps, plus the overall size;
 *  - five or more positions: ordinate (one tidy row of numbers);
 *  - otherwise baseline (each from the corner; a single size is just an ordinary dimension).
 */
export function rowStyle(distances: number[]): "baseline" | "chain" | "ordinate" {
  const inner = distances.slice(0, -1);
  if (inner.length >= 3) {
    const gaps = inner.slice(1).map((d, k) => d - inner[k]);
    if (gaps.every((g) => Math.abs(g - gaps[0]) < 1e-3)) return "chain";
  }
  return distances.length >= 5 ? "ordinate" : "baseline";
}

/** One direction's dimensions on a view, measured from its corner, in the style that reads best. */
function baseline(p: ViewProjection, row: Row, existing: Dimension[], scale: number, newId: () => string, third: boolean): Dimension[] {
  const i = row.dir === "h" ? 0 : 1;
  const j = 1 - i;
  const centres = p.circles.filter((c) => c.full && !c.hidden).map((c): P2 => [c.cx, c.cy]);
  const pts = [...outlinePoints(p), ...centres];
  if (!pts.length) return [];
  // The corner: furthest left (then lowest) for widths; lowest (then furthest left) for heights.
  const datum = [...outlinePoints(p)].sort((a, b) => a[i] - b[i] || a[j] - b[j])[0] ?? pts[0];
  const type = row.dir === "h" ? "horizontal" : "vertical";
  // Dimensions already measuring this direction on this view (any style).
  const mine = existing.filter((d) => d.view === row.view && (d.type === type || (d.type === "ordinate" && (d.axis ?? "h") === row.dir)));
  const taken = (v: number) => mine.some((d) => d.b && (same(d.b.at[i], v) || same(d.a.at[i], v)));
  const fresh = row.values.filter((v) => Math.abs(v - datum[i]) > 1e-3 && !taken(v));
  // Keep the overall size if there are too many.
  const chosen = fresh.length > MAX_PER_ROW ? [...fresh.slice(0, MAX_PER_ROW - 1), fresh[fresh.length - 1]] : fresh;
  chosen.sort((a, b) => Math.abs(a - datum[i]) - Math.abs(b - datum[i]));
  if (!chosen.length) return [];
  // Which side the row goes on: away from the views next to this one (first-angle layout puts
  // the top view below the front view and the right view to its left; third-angle the other way).
  const where = rowSide(row.view, row.dir, third);
  // The point at each position nearest that side, so extension lines are short.
  const pointAt = (v: number) =>
    pts.filter((q) => same(q[i], v)).sort((a, b) => (where === "below" ? a[1] - b[1] : where === "above" ? b[1] - a[1] : where === "left" ? a[0] - b[0] : b[0] - a[0]))[0];
  const targets = chosen.map(pointAt).filter((q): q is P2 => !!q);
  // Something already measured here: just add the rest from the corner, so styles don't get mixed up.
  const style = mine.length ? "baseline" : rowStyle(targets.map((q) => Math.abs(q[i] - datum[i])));
  const firstRow = mine.filter((d) => d.type !== "ordinate").length;
  const dim = (a: P2, b: P2, rowNo: number, kind: "length" | "ordinate" = "length"): Dimension => ({
    id: newId(),
    view: row.view,
    type: kind === "ordinate" ? "ordinate" : type,
    a: dimPoint(a, p),
    b: dimPoint(b, p),
    offset: rowOffset(p, where, a, b, scale, rowNo),
    ...(kind === "ordinate" ? { axis: row.dir } : {}),
  });
  if (style === "ordinate") return [datum, ...targets].map((q) => dim(datum, q, firstRow, "ordinate"));
  if (style === "chain") {
    const last = targets[targets.length - 1];
    const links = targets.slice(0, -1).map((q, k) => dim(k === 0 ? datum : targets[k - 1], q, firstRow));
    // The last gap follows from the overall size, so it isn't dimensioned twice.
    return [...links, dim(datum, last, firstRow + 1)];
  }
  // Baseline: shortest nearest the view, each from the corner.
  return targets.map((q, n) => dim(datum, q, firstRow + n));
}

/** Is a callout already describing a hole just like this one (same sizes, so its "N×" covers it)? */
function sameHole(p: ViewProjection, d: Dimension, h: ViewHole): boolean {
  const other = holeAt(p, d.a.at);
  return !!other && matchingHoles(p, other) === matchingHoles(p, h) && same(other.d, h.d) && other.through === h.through && same(other.depth, h.depth) && same(other.cbore?.diameter ?? 0, h.cbore?.diameter ?? 0) && same(other.csk?.diameter ?? 0, h.csk?.diameter ?? 0);
}

/** One diameter for each hole / boss size, and one radius for each rounded-corner size. */
function circleSizes(projections: Projections, views: ViewKind[], existing: Dimension[], newId: () => string): Dimension[] {
  const out: Dimension[] = [];
  const has = (type: "diameter" | "radius", r: number) => [...existing, ...out].some((d) => d.type === type && d.r !== undefined && same(d.r, r));
  for (const k of views) {
    const p = projections[k]!;
    const [x0, y0, x1, y1] = p.bounds!;
    const mid: P2 = [(x0 + x1) / 2, (y0 + y1) / 2];
    for (const c of p.circles) {
      if (c.hidden) continue;
      const type = c.full ? "diameter" : "radius";
      // A drilled hole gets a callout (size, depth, counterbore… and how many) — its counterbore or countersink circle needs nothing more.
      const hole = c.full ? holeOfCircle(p, [c.cx, c.cy], c.r) : null;
      if (hole && !same(hole.d / 2, c.r)) continue;
      if (hole && [...existing, ...out].some((d) => d.callout && d.view === k && d.r !== undefined && same(d.r, c.r) && sameHole(p, d, hole))) continue;
      if (!hole && has(type, c.r)) continue;
      // Leader pointing away from the middle of the view, so it ends up outside the part.
      const away = Math.atan2(c.cy - mid[1], c.cx - mid[0]);
      const angle = Math.hypot(c.cx - mid[0], c.cy - mid[1]) < 1e-6 ? 45 : Math.round((away * 180) / Math.PI);
      out.push({ id: newId(), view: k, type, a: dimPoint([c.cx, c.cy], p), r: c.r, offset: type === "diameter" ? 8 : 6, angle, ...(hole ? { callout: true } : {}) });
    }
  }
  return out;
}
