/**
 * Crop view (Onshape's Crop view): a view drawn only inside a rectangle or a
 * closed outline drawn on it. Pure: the crop is kept as fractions of the
 * view's width and height (DrawingView.crop), turned here into an outline in
 * the view's own millimetres, and every line of the view is cut to it.
 */
import type { ViewCrop } from "../model/types";

type P2 = [number, number];

/** Points a smooth outline is sampled with between each pair of clicked points. */
export const SMOOTH_STEPS = 8;
/** Most points a clicked outline keeps. */
export const MAX_CROP_POINTS = 60;

/** Is this crop a rectangle (two corners) rather than a clicked outline? */
export const isRectCrop = (c: ViewCrop): c is { a: P2; b: P2 } => "a" in c;

/**
 * The crop's outline in the view's own coordinates (model mm), from the view's
 * bounds [x0, y0, x1, y1]: a rectangle's four corners, the clicked points, or
 * a smooth closed curve through them (Catmull–Rom, sampled).
 */
export function cropOutline(crop: ViewCrop, bounds: readonly number[]): P2[] {
  const [x0, y0, x1, y1] = bounds;
  const at = ([u, v]: P2): P2 => [x0 + u * (x1 - x0), y0 + v * (y1 - y0)];
  if (isRectCrop(crop)) {
    const [ax, ay] = at(crop.a);
    const [bx, by] = at(crop.b);
    return [
      [Math.min(ax, bx), Math.min(ay, by)],
      [Math.max(ax, bx), Math.min(ay, by)],
      [Math.max(ax, bx), Math.max(ay, by)],
      [Math.min(ax, bx), Math.max(ay, by)],
    ];
  }
  const pts = crop.points.map(at);
  return crop.smooth && pts.length >= 3 ? smoothLoop(pts) : pts;
}

/** A closed Catmull–Rom curve through the points, sampled SMOOTH_STEPS times between each pair. */
export function smoothLoop(pts: P2[]): P2[] {
  const n = pts.length;
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    for (let k = 0; k < SMOOTH_STEPS; k++) {
      const t = k / SMOOTH_STEPS;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return out;
}

/** Is a point inside a closed outline (even–odd)? */
export function insideOutline(p: readonly number[], poly: readonly P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Where (0…1 along p→q) the segment crosses the outline's edges. */
function crossings(p: P2, q: P2, poly: readonly P2[]): number[] {
  const out: number[] = [];
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-15) continue;
    const t = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den;
    const u = ((a[0] - p[0]) * dy - (a[1] - p[1]) * dx) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) out.push(t);
  }
  return out.sort((x, y) => x - y);
}

/** A polyline (flat x, y list) cut to the inside of a closed outline: the pieces left. */
export function clipToOutline(line: readonly number[], poly: readonly P2[]): number[][] {
  if (poly.length < 3) return [line.slice()];
  // (A line lying along the crop's edge — a part edge where the crop follows it — counts as inside.)
  const tol = edgeTolerance(poly);
  const pieces: number[][] = [];
  let cur: number[] | null = null;
  const end = () => {
    if (cur && cur.length >= 4) pieces.push(cur);
    cur = null;
  };
  for (let i = 0; i + 3 < line.length; i += 2) {
    const p: P2 = [line[i], line[i + 1]];
    const q: P2 = [line[i + 2], line[i + 3]];
    const ts = [0, ...crossings(p, q, poly), 1];
    for (let k = 0; k + 1 < ts.length; k++) {
      const t0 = ts[k];
      const t1 = ts[k + 1];
      if (t1 - t0 < 1e-12) continue;
      const tm = (t0 + t1) / 2;
      const mid = [p[0] + (q[0] - p[0]) * tm, p[1] + (q[1] - p[1]) * tm];
      if (!insideOutline(mid, poly) && !onOutline(mid, poly, tol)) {
        end();
        continue;
      }
      const a = [p[0] + (q[0] - p[0]) * t0, p[1] + (q[1] - p[1]) * t0];
      const b = [p[0] + (q[0] - p[0]) * t1, p[1] + (q[1] - p[1]) * t1];
      if (!cur) cur = [a[0], a[1]];
      cur.push(b[0], b[1]);
    }
  }
  end();
  return pieces;
}

/** The outline's box: x0, y0, x1, y1. */
export function outlineBox(poly: readonly P2[]): [number, number, number, number] {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Is a dimension (or tag) that measures these points kept by the crop? Yes when any of them is inside. */
export function cropKeeps(points: readonly (readonly number[])[], poly: readonly P2[] | null): boolean {
  if (!poly || poly.length < 3) return true;
  const tol = edgeTolerance(poly);
  return points.some((p) => insideOutline(p, poly) || onOutline(p, poly, tol));
}

/** How near the outline counts as on it: a millionth of its size (at least 1e-9 mm). */
export function edgeTolerance(poly: readonly P2[]): number {
  const [x0, y0, x1, y1] = outlineBox(poly);
  return Math.max(1e-9, Math.hypot(x1 - x0, y1 - y0) * 1e-6);
}

/** Is a point on the outline itself (within `tol`)? */
export function onOutline(p: readonly number[], poly: readonly P2[], tol: number): boolean {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j];
    const [bx, by] = poly[i];
    const L2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * (bx - ax) + (p[1] - ay) * (by - ay)) / L2)) : 0;
    if (Math.hypot(p[0] - (ax + t * (bx - ax)), p[1] - (ay + t * (by - ay))) <= tol) return true;
  }
  return false;
}

/** Fractions of a view's bounds for a point of the view (rounded, as other picks are). */
export function cropRel(bounds: readonly number[], p: readonly number[]): P2 {
  const [x0, y0, x1, y1] = bounds;
  const f = (v: number, lo: number, hi: number) => (hi - lo > 0 ? Math.round(((v - lo) / (hi - lo)) * 1e6) / 1e6 : 0.5);
  return [f(p[0], x0, x1), f(p[1], y0, y1)];
}

/** A crop read from a file (null when it isn't one). */
export function parseCrop(raw: unknown): ViewCrop | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const pair = (v: unknown): P2 | null => (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? [Math.max(-10, Math.min(10, v[0])), Math.max(-10, Math.min(10, v[1]))] : null);
  if ("a" in r || "b" in r) {
    const a = pair(r.a);
    const b = pair(r.b);
    if (!a || !b || Math.abs(a[0] - b[0]) < 1e-6 || Math.abs(a[1] - b[1]) < 1e-6) return null;
    return { a, b };
  }
  if (!Array.isArray(r.points)) return null;
  const points = r.points.slice(0, MAX_CROP_POINTS).map(pair).filter((p): p is P2 => p !== null);
  if (points.length < 3) return null;
  return { points, ...(r.smooth === true ? { smooth: true as const } : {}) };
}

/** A view without its crop (no other change). */
export function withoutCrop<T extends { crop?: ViewCrop }>(v: T): T {
  if (!v.crop) return v;
  const { crop: _old, ...rest } = v;
  return rest as T;
}
