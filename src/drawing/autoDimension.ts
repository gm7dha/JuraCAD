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
import type { ViewProjection } from "../kernel/protocol";
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
  const ends: P2[] = [];
  for (const line of p.visible) if (line.length >= 4) ends.push([line[0], line[1]], [line[line.length - 2], line[line.length - 1]]);
  const seen = (x: number, y: number) => ends.some((q) => Math.abs(q[0] - x) < 1e-4 && Math.abs(q[1] - y) < 1e-4);
  for (let i = 0; i + 1 < p.points.length; i += 2) {
    const [x, y] = [p.points[i], p.points[i + 1]];
    if (onCircle(x, y) || !seen(x, y)) continue;
    if (!out.some((q) => Math.abs(q[0] - x) < 1e-6 && Math.abs(q[1] - y) < 1e-6)) out.push([x, y]);
  }
  return out;
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
export function autoDimensions(projections: Projections, views: string[], existing: Dimension[], scale: number, newId: () => string): Dimension[] {
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

  for (const row of rows) out.push(...baseline(projections[row.view]!, row, existing, scale, newId));
  out.push(...circleSizes(projections, standard, existing, newId));
  return out;
}

export type Side = "above" | "below" | "left" | "right";

/** Which side of a view a row of across ("h") or up-and-down ("v") dimensions goes. */
export function rowSide(view: string, dir: "h" | "v"): Side {
  const side = SIDES[view as ViewKind] ?? { h: "below", v: "right" };
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

/** Points a dimension can use at view coordinate `v` along `dir`, plus the corner they're measured from. */
function baseline(p: ViewProjection, row: Row, existing: Dimension[], scale: number, newId: () => string): Dimension[] {
  const i = row.dir === "h" ? 0 : 1;
  const j = 1 - i;
  const centres = p.circles.filter((c) => c.full && !c.hidden).map((c): P2 => [c.cx, c.cy]);
  const pts = [...outlinePoints(p), ...centres];
  if (!pts.length) return [];
  // The corner: furthest left (then lowest) for widths; lowest (then furthest left) for heights.
  const datum = [...outlinePoints(p)].sort((a, b) => a[i] - b[i] || a[j] - b[j])[0] ?? pts[0];
  const type = row.dir === "h" ? "horizontal" : "vertical";
  const mine = existing.filter((d) => d.view === row.view && d.type === type);
  const taken = (v: number) => mine.some((d) => d.b && same(Math.abs(d.b.at[i] - d.a.at[i]), Math.abs(v - datum[i])));
  const values = row.values.filter((v) => Math.abs(v - datum[i]) > 1e-3 && !taken(v));
  // Keep the overall size if there are too many.
  const chosen = values.length > MAX_PER_ROW ? [...values.slice(0, MAX_PER_ROW - 1), values[values.length - 1]] : values;
  // Shortest nearest the view; carry on outside any dimensions already in that row.
  chosen.sort((a, b) => Math.abs(a - datum[i]) - Math.abs(b - datum[i]));
  const out: Dimension[] = [];
  chosen.forEach((v, n) => {
    // The point at that position nearest the side the dimension goes on (below for widths, right for heights).
    // Which side the row goes on: away from the views next to this one (first-angle layout puts
    // the top view below the front view, and the right view to its left).
    const where = rowSide(row.view, row.dir);
    // The point at that position nearest that side, so extension lines are short.
    const at = pts
      .filter((q) => same(q[i], v))
      .sort((a, b) => (where === "below" ? a[1] - b[1] : where === "above" ? b[1] - a[1] : where === "left" ? a[0] - b[0] : b[0] - a[0]))[0];
    if (!at) return;
    const offset = rowOffset(p, where, datum, at, scale, mine.length + n);
    out.push({ id: newId(), view: row.view, type, a: dimPoint(datum, p), b: dimPoint(at, p), offset });
  });
  return out;
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
      if (has(type, c.r)) continue;
      // Leader pointing away from the middle of the view, so it ends up outside the part.
      const away = Math.atan2(c.cy - mid[1], c.cx - mid[0]);
      const angle = Math.hypot(c.cx - mid[0], c.cy - mid[1]) < 1e-6 ? 45 : Math.round((away * 180) / Math.PI);
      out.push({ id: newId(), view: k, type, a: dimPoint([c.cx, c.cy], p), r: c.r, offset: type === "diameter" ? 8 : 6, angle });
    }
  }
  return out;
}
