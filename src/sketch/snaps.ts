/**
 * Where the pointer snaps to while drawing or dragging in a sketch, like
 * Onshape: points (ends, centres, the origin), the middles of lines, part
 * edges shown in the sketch, lining up with points passed over, and onto
 * lines and curves. Also the small markers shown while hovering: a line's
 * middle, a circle's or arc's centre.
 */
import { alignWith, distToCurve, hitTest, type Hit } from "./hit";
import { isFaceEdge, isRefId, linkEdge, linkPoint, parseRefId, refSketch, type RefEdge } from "./links";
import { curveById, ellipsePoints, joinPoints, nearestOnPath, pointPos, radiusOf, sketchId, splinePath, type EditResult, type Placed, type Snap } from "./ops";
import { solveSketch } from "./solver";
import { ORIGIN_ID, type SketchCurve, type SketchData } from "./types";

type P2 = [number, number];

export interface SnapOptions {
  /** How close (mm) the pointer must be to a point, or a line's middle, to snap to it. */
  pointTol: number;
  /** How close (mm) to a line or curve to snap onto it. */
  curveTol: number;
  /** Points the pointer has passed over, most recent first (to line up with). Circle centres here snap from further away. */
  acquired?: string[];
  /** Part edges shown in the sketch. */
  refs?: RefEdge[];
  /** Points and curves to leave out (e.g. what's being dragged). */
  ignore?: Set<string>;
}

export interface SnapResult {
  /** Where the point goes and what it attaches to. */
  placed: Placed;
  /** What's under the pointer (to highlight): a sketch id, or a part edge's stand-in id ("ref:…"). */
  hover: Hit | null;
  /** Markers to show: the middle of the line, or the centre of the circle or arc, under the pointer. */
  hints: P2[];
}

/** A line's middle, or a circle's, arc's or ellipse's centre: the marker shown while hovering it. */
export function hintFor(s: SketchData, c: SketchCurve): P2 | null {
  try {
    if (c.type === "line") {
      const a = pointPos(s, c.p1), b = pointPos(s, c.p2);
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    }
    if (c.type === "circle" || c.type === "arc" || c.type === "ellipse") return pointPos(s, c.center);
  } catch {
    // refers to something that no longer exists
  }
  return null;
}

/** The nearest place on a curve to (x, y). */
function onCurve(s: SketchData, c: SketchCurve, x: number, y: number): P2 {
  if (c.type === "line") {
    const [ax, ay] = pointPos(s, c.p1);
    const [bx, by] = pointPos(s, c.p2);
    const dx = bx - ax, dy = by - ay;
    const t = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1);
    return [ax + t * dx, ay + t * dy];
  }
  if (c.type === "spline" || c.type === "ellipse") return nearestOnPath(c.type === "spline" ? splinePath(s, c, 48) : ellipsePoints(s, c, 256), [x, y]);
  const [cx, cy] = pointPos(s, c.center);
  const r = radiusOf(s, c);
  const a = Math.atan2(y - cy, x - cx);
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** The nearest middle of a line within `tol` (lines using an ignored point don't count). */
function nearestMidpoint(s: SketchData, x: number, y: number, tol: number, ignore: Set<string>): { id: string; at: P2 } | null {
  let best: { id: string; at: P2 } | null = null;
  let bestD = tol;
  for (const c of s.curves) {
    if (c.type !== "line" || ignore.has(c.id) || ignore.has(c.p1) || ignore.has(c.p2)) continue;
    const at = hintFor(s, c);
    if (!at) continue;
    const d = Math.hypot(at[0] - x, at[1] - y);
    if (d <= bestD) {
      bestD = d;
      best = { id: c.id, at };
    }
  }
  return best;
}

/** Centres of circles, arcs and ellipses. */
function centreIds(s: SketchData): Set<string> {
  const out = new Set<string>();
  for (const c of s.curves) if (c.type === "circle" || c.type === "arc" || c.type === "ellipse") out.add(c.center);
  return out;
}

/** Where a click at (x, y) lands, and what to highlight. */
export function snapAt(s: SketchData, x: number, y: number, o: SnapOptions): SnapResult {
  const ignore = o.ignore ?? new Set<string>();
  const refs = o.refs ?? [];
  const virt = refs.length ? refSketch(refs) : null;
  const refOf = (id: string) => {
    const r = parseRefId(id);
    return r ? { edge: refs[r.index], what: r.what } : null;
  };

  // 1. A point of the sketch (or the origin). Centres of circles passed over reach further.
  const ptHit = hitTest(s, x, y, o.pointTol, 0, { ignore });
  if (ptHit?.kind === "point") {
    const [px, py] = pointPos(s, ptHit.id);
    return { placed: { x: px, y: py, snap: ptHit.id === ORIGIN_ID ? { kind: "origin" } : { kind: "point", id: ptHit.id } }, hover: ptHit, hints: [] };
  }

  // 2. The middle of a line.
  const mid = nearestMidpoint(s, x, y, o.pointTol, ignore);
  if (mid) return { placed: { x: mid.at[0], y: mid.at[1], snap: { kind: "midpoint", id: mid.id } }, hover: { kind: "curve", id: mid.id }, hints: [mid.at] };

  // 3. A part edge's corner, centre or middle.
  if (virt) {
    const vHit = hitTest(virt, x, y, o.pointTol, 0, { origin: false });
    const r = vHit?.kind === "point" ? refOf(vHit.id) : null;
    if (r?.edge && (r.what === "a" || r.what === "b" || r.what === "c")) {
      const at = r.what === "c" ? "centre" : r.what;
      const [px, py] = pointPos(virt, vHit!.id);
      return { placed: { x: px, y: py, snap: { kind: "ref", edge: r.edge, at } }, hover: vHit, hints: [] };
    }
    const vMid = nearestMidpoint(virt, x, y, o.pointTol, new Set());
    const m = vMid ? refOf(vMid.id) : null;
    if (vMid && m?.edge && m.what === "edge" && m.edge.kind === "line") return { placed: { x: vMid.at[0], y: vMid.at[1], snap: { kind: "ref", edge: m.edge, at: "mid" } }, hover: { kind: "curve", id: vMid.id }, hints: [vMid.at] };
  }

  // 4. Nothing right under the pointer: the centre of a circle passed over reaches further.
  const curveHit = hitTest(s, x, y, 0, o.curveTol, { ignore, origin: false });
  const onRef = !!virt && virt.curves.some((c) => distToCurve(virt, c, x, y) <= o.curveTol);
  if (!curveHit && !onRef) {
    const centres = centreIds(s);
    for (const id of o.acquired ?? []) {
      if (!centres.has(id) || ignore.has(id) || !s.points.some((p) => p.id === id)) continue;
      const [px, py] = pointPos(s, id);
      if (Math.hypot(px - x, py - y) <= 2 * o.pointTol) return { placed: { x: px, y: py, snap: { kind: "point", id } }, hover: { kind: "point", id }, hints: [] };
    }
  }

  // 5. Lined up with a point passed over.
  if (!curveHit && o.acquired?.length) {
    const al = alignWith(s, x, y, o.acquired.filter((id) => !ignore.has(id)), o.pointTol * 0.8);
    if (al.alongX || al.alongY) return { placed: { x: al.x, y: al.y, snap: { kind: "align", ...(al.alongX ? { x: al.alongX } : {}), ...(al.alongY ? { y: al.alongY } : {}) } }, hover: null, hints: [] };
  }

  // 6. Onto a line or curve of the sketch (its middle or centre is marked).
  if (curveHit?.kind === "curve") {
    const c = curveById(s, curveHit.id)!;
    const [px, py] = onCurve(s, c, x, y);
    const hint = hintFor(s, c);
    return { placed: { x: px, y: py, snap: { kind: "curve", id: c.id } }, hover: curveHit, hints: hint ? [hint] : [] };
  }

  // 7. Onto an edge of the face. (Things from elsewhere — other sketches, parts off the sketch — are
  // snapped to at their points only, so drawing near them doesn't tie a shape to them by accident;
  // click one with the dimension tool, or start a tangent line, to use the curve itself.)
  if (virt) {
    let best: { c: SketchCurve; d: number } | null = null;
    for (const c of virt.curves) {
      const edge = refOf(c.id)?.edge;
      if (!edge || !isFaceEdge(edge)) continue;
      const d = distToCurve(virt, c, x, y);
      if (d <= o.curveTol && (!best || d < best.d)) best = { c, d };
    }
    const r = best ? refOf(best.c.id) : null;
    if (best && r?.edge) {
      const [px, py] = onCurve(virt, best.c, x, y);
      const edgeId = best.c.id.replace(/:s\d+$/, "");
      // Only straight and round edges can be brought in to snap along.
      const along = r.edge.kind === "line" || r.edge.kind === "circle" || r.edge.kind === "arc";
      const hint = r.edge.kind === "curve" ? null : hintFor(virt, best.c);
      return {
        placed: along ? { x: px, y: py, snap: { kind: "ref", edge: r.edge, at: "on" } } : { x, y, snap: null },
        hover: { kind: "curve", id: edgeId },
        hints: hint ? [hint] : [],
      };
    }
  }
  return { placed: { x, y, snap: null }, hover: null, hints: [] };
}

/**
 * What's under the pointer for picking (selecting, dimensioning, a pattern's
 * centre): the sketch's own points and curves first, then part edges shown in
 * the sketch (as their stand-in ids).
 */
export function pickAt(s: SketchData, x: number, y: number, pointTol: number, curveTol: number, refs: RefEdge[] = []): Hit | null {
  const own = hitTest(s, x, y, pointTol, curveTol);
  if (own?.kind === "point" || !refs.length) return own;
  const virt = refSketch(refs);
  const v = hitTest(virt, x, y, pointTol, curveTol, { origin: false });
  if (v?.kind === "point" && !/:q\d+$/.test(v.id)) return v;
  if (own) return own;
  if (v?.kind === "curve") return { kind: "curve", id: v.id.replace(/:s\d+$/, "") };
  return null;
}

/**
 * Turn a picked stand-in ("ref:…") into real sketch ids: a face edge is
 * brought in as a reference (construction that follows the part) and the id
 * of its curve, end or centre returned; another sketch's point, or a part's
 * corner or centre off the face, comes in as a single point that follows it.
 * Ids of the sketch's own geometry come back unchanged.
 */
export function bringIn(s: SketchData, id: string, refs: RefEdge[]): EditResult & { id: string } {
  if (!isRefId(id)) return { sketch: s, id };
  const r = parseRefId(id);
  const edge = r ? refs[r.index] : undefined;
  if (!r || !edge || r.what === "q") return { sketch: s, id, error: "That part edge can't be used here." };
  // Another sketch's point, or a part's corner or centre off the face: just that point comes in.
  if (!isFaceEdge(edge) && r.what !== "edge") {
    const p = linkPoint(s, edge, r.what === "c" ? "centre" : r.what);
    return p.error ? { sketch: s, id, error: p.error } : { sketch: p.sketch, id: p.pointId };
  }
  const used = linkEdge(s, edge, true);
  if (used.error) return { ...used, id };
  const real = r.what === "edge" ? used.curveId : r.what === "c" ? used.points.c : used.points[r.what];
  if (!real) return { sketch: s, id, error: "That part edge can't be used here." };
  return { sketch: used.sketch, id: real };
}

/**
 * Attach a dragged point to what it was dropped on: another point (joined),
 * the middle of a line (Midpoint), or a part edge's corner or middle.
 */
export function attachPoint(s: SketchData, pointId: string, snap: Snap): EditResult {
  if (snap.kind === "point") return joinPoints(s, pointId, snap.id);
  if (snap.kind === "origin") return joinPoints(s, pointId, ORIGIN_ID);
  if (snap.kind === "midpoint") return addMidpoint(s, pointId, snap.id);
  if (snap.kind === "ref") {
    if (!isFaceEdge(snap.edge) && snap.at !== "on") {
      const p = linkPoint(s, snap.edge, snap.at);
      if (p.error) return { sketch: s, error: p.error };
      const j = joinPoints(p.sketch, pointId, p.pointId);
      return j.error ? { sketch: s, error: j.error } : j;
    }
    const used = linkEdge(s, snap.edge, true);
    if (used.error) return { sketch: s, error: used.error };
    const end = snap.at === "a" ? used.points.a : snap.at === "b" ? used.points.b : snap.at === "centre" ? used.points.c : undefined;
    if (end) {
      const j = joinPoints(used.sketch, pointId, end);
      return j.error ? { sketch: s, error: j.error } : j;
    }
    if (snap.at === "mid") {
      const m = addMidpoint(used.sketch, pointId, used.curveId);
      return m.error ? { sketch: s, error: m.error } : m;
    }
  }
  return { sketch: s };
}

/** Hold a point at the middle of a line. */
function addMidpoint(s: SketchData, pointId: string, lineId: string): EditResult {
  const line = curveById(s, lineId);
  if (line?.type !== "line" || line.p1 === pointId || line.p2 === pointId) return { sketch: s };
  if (s.constraints.some((c) => c.type === "midpoint" && c.refs[0] === pointId && c.refs[1] === lineId)) return { sketch: s };
  // Put it there first (as dropping it there would), so the line stays put.
  const [a, b] = [pointPos(s, line.p1), pointPos(s, line.p2)];
  const points = s.points.map((p) => (p.id === pointId ? { ...p, x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 } : p));
  const r = solveSketch({ ...s, points, constraints: [...s.constraints, { id: sketchId("c"), type: "midpoint", refs: [pointId, lineId] }] });
  if (!r.ok) return { sketch: s, error: "That point can't go to the middle of the line — it's held in place by other constraints or dimensions." };
  return { sketch: r.sketch };
}
