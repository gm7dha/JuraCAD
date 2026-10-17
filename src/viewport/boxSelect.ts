/**
 * Box selection (click and drag on empty space), as in Onshape and most CAD
 * programs: dragging left to right selects what's wholly inside the box
 * ("window"); right to left also takes anything the box touches ("crossing").
 */
import { curvePoints, ellipsePoints, pointPos, radiusOf, splinePath } from "../sketch/ops";
import { ORIGIN_ID, type SketchCurve, type SketchData } from "../sketch/types";

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The box between two corners, whichever way round. */
export function rectOf(ax: number, ay: number, bx: number, by: number): Rect {
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

export const inRect = (r: Rect, x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

/** Does the straight piece from a to b pass through the box? */
export function segmentHitsRect(r: Rect, ax: number, ay: number, bx: number, by: number): boolean {
  if (inRect(r, ax, ay) || inRect(r, bx, by)) return true;
  // Clip the segment against the box (Liang–Barsky).
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const edges: [number, number][] = [
    [-dx, ax - r.x0],
    [dx, r.x1 - ax],
    [-dy, ay - r.y0],
    [dy, r.y1 - ay],
  ];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Is a shape, given as points and line pieces (each x0, y0, x1, y1) on screen,
 * chosen by the box? Window: every point inside. Crossing: any point inside or
 * any piece passing through.
 */
export function shapeInBox(r: Rect, points: ArrayLike<number>, segments: ArrayLike<number>, crossing: boolean): boolean {
  if (points.length < 2) return false;
  if (!crossing) {
    for (let i = 0; i + 1 < points.length; i += 2) if (!inRect(r, points[i], points[i + 1])) return false;
    return true;
  }
  for (let i = 0; i + 1 < points.length; i += 2) if (inRect(r, points[i], points[i + 1])) return true;
  for (let i = 0; i + 3 < segments.length; i += 4) if (segmentHitsRect(r, segments[i], segments[i + 1], segments[i + 2], segments[i + 3])) return true;
  return false;
}

/** A sketch curve as a run of points (arcs and circles as short straight pieces). */
function curvePolyline(s: SketchData, c: SketchCurve): number[] {
  if (c.type === "line") return [...pointPos(s, c.p1), ...pointPos(s, c.p2)];
  if (c.type === "spline") return splinePath(s, c).flat();
  if (c.type === "ellipse") return ellipsePoints(s, c).flat();
  const [cx, cy] = pointPos(s, c.center);
  const r = radiusOf(s, c);
  let a0 = 0;
  let a1 = 2 * Math.PI;
  if (c.type === "arc") {
    const [sx, sy] = pointPos(s, c.start);
    const [ex, ey] = pointPos(s, c.end);
    a0 = Math.atan2(sy - cy, sx - cx);
    a1 = Math.atan2(ey - cy, ex - cx);
    if (a1 <= a0) a1 += 2 * Math.PI;
  }
  const out: number[] = [];
  const n = 32;
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

/** Lines, arcs, circles and loose points of a sketch chosen by a box (in sketch mm). */
export function sketchItemsInBox(s: SketchData, r: Rect, crossing: boolean): string[] {
  const out: string[] = [];
  for (const c of s.curves) {
    const pts = curvePolyline(s, c);
    const segs: number[] = [];
    for (let i = 0; i + 3 < pts.length; i += 2) segs.push(pts[i], pts[i + 1], pts[i + 2], pts[i + 3]);
    if (shapeInBox(r, pts, segs, crossing)) out.push(c.id);
  }
  const onCurves = new Set(s.curves.flatMap(curvePoints));
  for (const p of s.points) {
    if (p.id === ORIGIN_ID || onCurves.has(p.id)) continue;
    if (inRect(r, p.x, p.y)) out.push(p.id);
  }
  return out;
}
