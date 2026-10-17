/**
 * What's under the pointer in a sketch, and drawing aids (horizontal /
 * vertical inference). All distances are in sketch millimetres; callers
 * convert their pixel tolerances using the current zoom.
 */
import { curvePoints, ellipsePoints, pointPos, radiusOf, splinePath } from "./ops";
import { ORIGIN_ID, type SketchCurve, type SketchData } from "./types";

export type Hit = { kind: "point"; id: string } | { kind: "curve"; id: string };

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Is angle `a` within the anticlockwise sweep from `a0` to `a1`? */
export function angleWithin(a: number, a0: number, a1: number): boolean {
  const twoPi = 2 * Math.PI;
  const norm = (x: number) => ((x % twoPi) + twoPi) % twoPi;
  const sweep = norm(a1 - a0) || twoPi;
  return norm(a - a0) <= sweep + 1e-12;
}

export function distToCurve(s: SketchData, c: SketchCurve, x: number, y: number): number {
  if (c.type === "line") {
    const [ax, ay] = pointPos(s, c.p1);
    const [bx, by] = pointPos(s, c.p2);
    return distToSegment(x, y, ax, ay, bx, by);
  }
  if (c.type === "spline" || c.type === "ellipse") {
    const pts = c.type === "spline" ? splinePath(s, c) : ellipsePoints(s, c);
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, distToSegment(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
    return best;
  }
  const [cx, cy] = pointPos(s, c.center);
  const r = radiusOf(s, c);
  if (c.type === "circle") return Math.abs(Math.hypot(x - cx, y - cy) - r);
  const [sx, sy] = pointPos(s, c.start);
  const [ex, ey] = pointPos(s, c.end);
  const a = Math.atan2(y - cy, x - cx);
  if (angleWithin(a, Math.atan2(sy - cy, sx - cx), Math.atan2(ey - cy, ex - cx))) return Math.abs(Math.hypot(x - cx, y - cy) - r);
  return Math.min(Math.hypot(x - sx, y - sy), Math.hypot(x - ex, y - ey));
}

export interface HitOptions {
  /** Ignore these points/curves (e.g. the line being drawn). */
  ignore?: Set<string>;
  /** Include the sketch origin as a point. */
  origin?: boolean;
}

/** Nearest point within `pointTol`, else nearest curve within `curveTol`. */
export function hitTest(s: SketchData, x: number, y: number, pointTol: number, curveTol: number, opts: HitOptions = {}): Hit | null {
  const ignore = opts.ignore ?? new Set<string>();
  let best: Hit | null = null;
  let bestD = pointTol;
  const candidates: [string, number, number][] = s.points.map((p) => [p.id, p.x, p.y]);
  if (opts.origin !== false) candidates.push([ORIGIN_ID, 0, 0]);
  for (const [id, px, py] of candidates) {
    if (ignore.has(id)) continue;
    const d = Math.hypot(px - x, py - y);
    if (d <= bestD) {
      bestD = d;
      best = { kind: "point", id };
    }
  }
  if (best) return best;
  bestD = curveTol;
  for (const c of s.curves) {
    if (ignore.has(c.id)) continue;
    const d = distToCurve(s, c, x, y);
    if (d <= bestD) {
      bestD = d;
      best = { kind: "curve", id: c.id };
    }
  }
  return best;
}

/** Points that belong to a curve or are free-standing (for selecting points in a box later). */
export const allCurvePoints = (s: SketchData) => new Set(s.curves.flatMap(curvePoints));

/**
 * While drawing a line from (ax, ay), snap the far end to horizontal or
 * vertical when it's within a few degrees, like Onshape.
 */
export function inferOrientation(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  degrees = 4,
): { x: number; y: number; orientation: "horizontal" | "vertical" | null } {
  const dx = bx - ax;
  const dy = by - ay;
  if (Math.hypot(dx, dy) < 1e-9) return { x: bx, y: by, orientation: null };
  const angle = (Math.abs(Math.atan2(dy, dx)) * 180) / Math.PI;
  if (angle < degrees || angle > 180 - degrees) return { x: bx, y: ay, orientation: "horizontal" };
  if (Math.abs(angle - 90) < degrees) return { x: ax, y: by, orientation: "vertical" };
  return { x: bx, y: by, orientation: null };
}

/**
 * Line up with points the pointer has passed over (and the origin), like
 * Onshape: within `tol` of a point's x the pointer snaps straight above or
 * below it, within `tol` of its y it snaps level with it. Returns where to
 * put the point, and which points it lined up with.
 */
export function alignWith(
  s: SketchData,
  x: number,
  y: number,
  acquired: string[],
  tol: number,
): { x: number; y: number; alongX?: string; alongY?: string } {
  let bestX: { id: string; d: number; v: number } | null = null;
  let bestY: { id: string; d: number; v: number } | null = null;
  for (const id of [...acquired, ORIGIN_ID]) {
    if (id !== ORIGIN_ID && !s.points.some((p) => p.id === id)) continue;
    const [px, py] = pointPos(s, id);
    // Not when the pointer is right on the point itself.
    if (Math.hypot(px - x, py - y) < tol) continue;
    const dx = Math.abs(px - x);
    const dy = Math.abs(py - y);
    if (dx < tol && (!bestX || dx < bestX.d)) bestX = { id, d: dx, v: px };
    if (dy < tol && (!bestY || dy < bestY.d)) bestY = { id, d: dy, v: py };
  }
  return { x: bestX ? bestX.v : x, y: bestY ? bestY.v : y, ...(bestX ? { alongX: bestX.id } : {}), ...(bestY ? { alongY: bestY.id } : {}) };
}
