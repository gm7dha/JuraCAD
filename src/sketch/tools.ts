/**
 * More sketch tools: slot, polygon, rounding a corner (sketch fillet) and trim.
 * Like ops.ts, each takes a sketch and returns a new, solved one (or an error
 * in plain English).
 */
import { evaluate } from "../model/expr";
import { solveSketch } from "./solver";
import { curveById, deleteItems, placePoint, pointPos, radiusOf, settle, sketchId, type EditResult, type Placed } from "./ops";
import type { SketchArc, SketchCircle, SketchConstraint, SketchCurve, SketchData, SketchLine, SketchPoint } from "./types";

type P2 = [number, number];
const TAU = Math.PI * 2;
const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: P2, k: number): P2 => [a[0] * k, a[1] * k];
const len = (a: P2) => Math.hypot(a[0], a[1]);
const unit = (a: P2): P2 => mul(a, 1 / (len(a) || 1));
const cross = (a: P2, b: P2) => a[0] * b[1] - a[1] * b[0];
const dot = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];
/** Angle normalised to [0, 2π). */
const norm = (a: number) => ((a % TAU) + TAU) % TAU;

const con = (type: SketchConstraint["type"], refs: string[], value?: string): SketchConstraint => ({
  id: sketchId("c"),
  type,
  refs,
  ...(value !== undefined ? { value } : {}),
});

// ---------------------------------------------------------------------------
// Slot

/** A slot (rounded-end rectangle) between two centre points, `radius` = half its width. */
export function addSlot(s: SketchData, c1: Placed, c2: Placed, radius: number, construction = false): EditResult & { curveIds: string[] } {
  const d = sub([c2.x, c2.y], [c1.x, c1.y]);
  if (len(d) < 1e-6) return { sketch: s, curveIds: [], error: "Click two different centre points for the slot." };
  if (radius < 1e-6) return { sketch: s, curveIds: [], error: "Move the pointer away from the centre line to give the slot a width." };
  const a = placePoint(s, c1);
  const b = placePoint(a.sketch, c2);
  if (a.id === b.id) return { sketch: s, curveIds: [], error: "Click two different centre points for the slot." };
  const n = mul([-unit(d)[1], unit(d)[0]], radius);
  const C1: P2 = [c1.x, c1.y];
  const C2: P2 = [c2.x, c2.y];
  const pts: SketchPoint[] = [add(C1, n), sub(C1, n), add(C2, n), sub(C2, n)].map(([x, y]) => ({ id: sketchId("p"), x, y }));
  const [a1, b1, a2, b2] = pts.map((p) => p.id);
  const ids = { axis: sketchId("l"), top: sketchId("l"), bottom: sketchId("l"), arc1: sketchId("a"), arc2: sketchId("a") };
  const curves: SketchCurve[] = [
    { id: ids.axis, type: "line", p1: a.id, p2: b.id, construction: true },
    { id: ids.top, type: "line", p1: a1, p2: a2, construction },
    { id: ids.bottom, type: "line", p1: b1, p2: b2, construction },
    { id: ids.arc1, type: "arc", center: a.id, start: a1, end: b1, construction },
    { id: ids.arc2, type: "arc", center: b.id, start: b2, end: a2, construction },
  ];
  const constraints = [
    con("tangent", [ids.top, ids.arc1]),
    con("tangent", [ids.top, ids.arc2]),
    con("tangent", [ids.bottom, ids.arc1]),
    con("tangent", [ids.bottom, ids.arc2]),
    con("equal", [ids.arc1, ids.arc2]),
  ];
  const sk = b.sketch;
  const r = settle({ points: [...sk.points, ...pts], curves: [...sk.curves, ...curves], constraints: [...sk.constraints, ...constraints] });
  return { ...r, curveIds: [ids.top, ids.bottom, ids.arc1, ids.arc2] };
}

// ---------------------------------------------------------------------------
// Polygon

/** A regular polygon with `sides` corners, centred on `centre`, one corner at `corner`. */
export function addPolygon(s: SketchData, centre: Placed, corner: { x: number; y: number }, sides: number, construction = false): EditResult & { lineIds: string[] } {
  const n = Math.round(sides);
  if (!(n >= 3 && n <= 64)) return { sketch: s, lineIds: [], error: "A polygon needs between 3 and 64 sides." };
  const R = Math.hypot(corner.x - centre.x, corner.y - centre.y);
  if (R < 1e-6) return { sketch: s, lineIds: [], error: "Move the pointer away from the centre to give the polygon a size." };
  const c = placePoint(s, centre);
  const start = Math.atan2(corner.y - centre.y, corner.x - centre.x);
  const pts: SketchPoint[] = Array.from({ length: n }, (_, i) => ({
    id: sketchId("p"),
    x: centre.x + R * Math.cos(start + (TAU * i) / n),
    y: centre.y + R * Math.sin(start + (TAU * i) / n),
  }));
  const circleId = sketchId("k");
  const lineIds = pts.map(() => sketchId("l"));
  const curves: SketchCurve[] = [
    { id: circleId, type: "circle", center: c.id, radius: R, construction: true },
    ...pts.map((p, i): SketchLine => ({ id: lineIds[i], type: "line", p1: p.id, p2: pts[(i + 1) % n].id, construction })),
  ];
  const constraints = [...pts.map((p) => con("pointOnCircle", [p.id, circleId])), ...lineIds.slice(1).map((id) => con("equal", [lineIds[0], id]))];
  const sk = c.sketch;
  return { ...settle({ points: [...sk.points, ...pts], curves: [...sk.curves, ...curves], constraints: [...sk.constraints, ...constraints] }), lineIds };
}

// ---------------------------------------------------------------------------
// Rounding a corner (sketch fillet)

/**
 * Round the corner where two straight lines meet at `pointId`. The corner
 * point stays as a "virtual sharp" so dimensions to it, and the lines'
 * length dimensions, keep working.
 */
export function filletCorner(s: SketchData, pointId: string, radiusText: string): EditResult & { arcId: string } {
  const fail = (error: string) => ({ sketch: s, arcId: "", error });
  const r = evaluate(radiusText);
  if (!r.ok) return fail(r.error);
  if (r.value <= 0) return fail("The radius must be more than 0.");
  const lines = s.curves.filter((c): c is SketchLine => c.type === "line" && !c.construction && (c.p1 === pointId || c.p2 === pointId));
  if (lines.length !== 2) return fail("Click a corner where exactly two lines meet.");
  const [L1, L2] = lines;
  const P = pointPos(s, pointId);
  const far = (l: SketchLine) => (l.p1 === pointId ? l.p2 : l.p1);
  const A = pointPos(s, far(L1));
  const B = pointPos(s, far(L2));
  const u1 = unit(sub(A, P));
  const u2 = unit(sub(B, P));
  const phi = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
  if (phi < 1e-3 || phi > Math.PI - 1e-3) return fail("Those lines are in a straight line, so there's no corner to round.");
  const half = phi / 2;
  const t = r.value / Math.tan(half);
  if (t >= len(sub(A, P)) - 1e-6 || t >= len(sub(B, P)) - 1e-6) return fail("That radius is too big for these lines — try a smaller one.");
  const T1 = add(P, mul(u1, t));
  const T2 = add(P, mul(u2, t));
  const C = add(P, mul(unit(add(u1, u2)), r.value / Math.sin(half)));

  const [t1, t2, c] = [T1, T2, C].map(([x, y]) => ({ id: sketchId("p"), x, y }));
  const arcId = sketchId("a");
  const ccw = cross(sub(T1, C), sub(T2, C)) > 0;
  const arc: SketchArc = { id: arcId, type: "arc", center: c.id, start: ccw ? t1.id : t2.id, end: ccw ? t2.id : t1.id, construction: false };
  const reroute = (l: SketchLine, to: string): SketchLine => (l.p1 === pointId ? { ...l, p1: to } : { ...l, p2: to });

  const constraints: SketchConstraint[] = s.constraints.map((k) =>
    // A length dimension on a trimmed line now measures to the virtual sharp instead.
    k.type === "length" && (k.refs[0] === L1.id || k.refs[0] === L2.id) ? { ...k, type: "distance", refs: [pointId, far(k.refs[0] === L1.id ? L1 : L2)] } : k,
  );
  constraints.push(
    con("pointOnLine", [pointId, L1.id]),
    con("pointOnLine", [pointId, L2.id]),
    con("tangent", [L1.id, arcId]),
    con("tangent", [L2.id, arcId]),
    con("radius", [arcId], radiusText),
  );
  const changed: SketchData = {
    points: [...s.points.map((p) => (p.id === pointId ? { ...p, standalone: true } : p)), t1, t2, c],
    curves: [...s.curves.map((k) => (k.id === L1.id ? reroute(L1, t1.id) : k.id === L2.id ? reroute(L2, t2.id) : k)), arc],
    constraints,
  };
  const solved = solveSketch(changed);
  if (!solved.ok) return fail("Rounding this corner would conflict with the sketch's other constraints.");
  return { sketch: solved.sketch, arcId };
}

// ---------------------------------------------------------------------------
// Trim

interface Cut {
  /** Position along the curve being trimmed (line: 0–1, arc/circle: angle from start). */
  at: number;
  point: P2;
  /** The curve that crosses it there. */
  by: string;
}

function circleOf(s: SketchData, c: SketchCircle | SketchArc): { c: P2; r: number } {
  return { c: pointPos(s, c.center), r: radiusOf(s, c) };
}

/** For an arc: [start angle, sweep] (anticlockwise). Circles: [0, 2π]. */
function arcSpan(s: SketchData, c: SketchCircle | SketchArc): [number, number] {
  if (c.type === "circle") return [0, TAU];
  const C = pointPos(s, c.center);
  const a0 = Math.atan2(pointPos(s, c.start)[1] - C[1], pointPos(s, c.start)[0] - C[0]);
  const a1 = Math.atan2(pointPos(s, c.end)[1] - C[1], pointPos(s, c.end)[0] - C[0]);
  const sweep = norm(a1 - a0);
  return [a0, sweep === 0 ? TAU : sweep];
}

/** Is the point (on the circle) within the arc's extent? */
function onArc(s: SketchData, c: SketchCircle | SketchArc, p: P2): boolean {
  if (c.type === "circle") return true;
  const { c: C } = circleOf(s, c);
  const [a0, sweep] = arcSpan(s, c);
  return norm(Math.atan2(p[1] - C[1], p[0] - C[0]) - a0) <= sweep + 1e-9;
}

/** Points where curves `a` and `b` cross (each within its own extent). */
export function intersections(s: SketchData, a: SketchCurve, b: SketchCurve): P2[] {
  const seg = (l: SketchLine) => [pointPos(s, l.p1), pointPos(s, l.p2)] as [P2, P2];
  const onSeg = (l: SketchLine, p: P2) => {
    const [A, B] = seg(l);
    const t = dot(sub(p, A), sub(B, A)) / (dot(sub(B, A), sub(B, A)) || 1);
    return t >= -1e-9 && t <= 1 + 1e-9;
  };
  if (a.type === "line" && b.type === "line") {
    const [A, B] = seg(a);
    const [C, D] = seg(b);
    const r = sub(B, A);
    const q = sub(D, C);
    const den = cross(r, q);
    if (Math.abs(den) < 1e-12) return [];
    const t = cross(sub(C, A), q) / den;
    const u = cross(sub(C, A), r) / den;
    return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 ? [add(A, mul(r, t))] : [];
  }
  if (a.type === "line" || b.type === "line") {
    const [l, k] = (a.type === "line" ? [a, b] : [b, a]) as [SketchLine, SketchCircle | SketchArc];
    const [A, B] = seg(l);
    const { c: C, r } = circleOf(s, k);
    const d = sub(B, A);
    const f = sub(A, C);
    const qa = dot(d, d);
    const qb = 2 * dot(f, d);
    const qc = dot(f, f) - r * r;
    const disc = qb * qb - 4 * qa * qc;
    if (disc < 0 || qa < 1e-12) return [];
    const root = Math.sqrt(disc);
    const ts = disc < 1e-12 ? [-qb / (2 * qa)] : [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)];
    return ts.filter((t) => t >= -1e-9 && t <= 1 + 1e-9).map((t) => add(A, mul(d, t))).filter((p) => onArc(s, k, p) && onSeg(l, p));
  }
  const ca = circleOf(s, a as SketchCircle | SketchArc);
  const cb = circleOf(s, b as SketchCircle | SketchArc);
  const d = len(sub(cb.c, ca.c));
  if (d < 1e-12 || d > ca.r + cb.r + 1e-9 || d < Math.abs(ca.r - cb.r) - 1e-9) return [];
  const x = (d * d + ca.r * ca.r - cb.r * cb.r) / (2 * d);
  const h = Math.sqrt(Math.max(0, ca.r * ca.r - x * x));
  const e = unit(sub(cb.c, ca.c));
  const m = add(ca.c, mul(e, x));
  const pts: P2[] = h < 1e-9 ? [m] : [add(m, mul([-e[1], e[0]], h)), sub(m, mul([-e[1], e[0]], h))];
  return pts.filter((p) => onArc(s, a as SketchArc, p) && onArc(s, b as SketchArc, p));
}

/** Position of a point along a curve (line: 0–1; arc/circle: angle from its start). */
function paramOf(s: SketchData, c: SketchCurve, p: P2): number {
  if (c.type === "line") {
    const A = pointPos(s, c.p1);
    const B = pointPos(s, c.p2);
    return dot(sub(p, A), sub(B, A)) / (dot(sub(B, A), sub(B, A)) || 1);
  }
  const { c: C } = circleOf(s, c);
  return norm(Math.atan2(p[1] - C[1], p[0] - C[0]) - arcSpan(s, c)[0]);
}

/** Constraints that stay true when a curve is shortened (others, like its length, are dropped). */
const KEEPS_WHEN_TRIMMED = new Set(["horizontal", "vertical", "parallel", "perpendicular", "tangent", "pointOnLine", "pointOnCircle", "concentric", "radius", "diameter", "equal", "fix"]);

/**
 * Trim: remove the piece of a curve between the nearest crossings either
 * side of where it was clicked (or the whole curve if nothing crosses it).
 */
export function trimAt(s: SketchData, curveId: string, at: { x: number; y: number }): EditResult {
  const target = curveById(s, curveId);
  if (!target) return { sketch: s, error: "Click a line, arc or circle to trim." };
  const cuts: Cut[] = [];
  for (const other of s.curves) {
    if (other.id === target.id) continue;
    for (const p of intersections(s, target, other)) cuts.push({ at: paramOf(s, target, p), point: p, by: other.id });
  }
  const click = paramOf(s, target, [at.x, at.y]);
  const end = target.type === "line" ? 1 : arcSpan(s, target)[1];
  const eps = target.type === "line" ? 1e-6 : 1e-6;
  const inside = target.type === "circle" ? cuts : cuts.filter((c) => c.at > eps && c.at < end - eps);
  if (inside.length === 0 || (target.type === "circle" && inside.length < 2)) return { sketch: deleteItems(s, [curveId]) };

  // Nearest crossings before and after the click.
  const before = inside.filter((c) => c.at < click).sort((a, b) => b.at - a.at)[0];
  const after = inside.filter((c) => c.at > click).sort((a, b) => a.at - b.at)[0];

  const newPoint = (cut: Cut) => {
    const id = sketchId("p");
    const other = curveById(s, cut.by)!;
    return { point: { id, x: cut.point[0], y: cut.point[1] }, constraint: con(other.type === "line" ? "pointOnLine" : "pointOnCircle", [id, cut.by]) };
  };
  const keep = s.constraints.filter((k) => !k.refs.includes(curveId) || KEEPS_WHEN_TRIMMED.has(k.type));
  const others = s.curves.filter((c) => c.id !== curveId);

  if (target.type === "circle") {
    // Keep the arc from the crossing after the click round to the crossing before it.
    const sorted = [...inside].sort((a, b) => a.at - b.at);
    const lo = before ?? sorted[sorted.length - 1];
    const hi = after ?? sorted[0];
    const a = newPoint(hi);
    const b = newPoint(lo);
    const arc: SketchArc = { id: curveId, type: "arc", center: target.center, start: a.point.id, end: b.point.id, construction: target.construction };
    return settle({ points: [...s.points, a.point, b.point], curves: [...others, arc], constraints: [...keep, a.constraint, b.constraint] });
  }

  const start = target.type === "line" ? target.p1 : target.start;
  const finish = target.type === "line" ? target.p2 : target.end;
  const piece = (from: string, to: string, id: string): SketchCurve =>
    target.type === "line" ? { ...target, id, p1: from, p2: to } : { ...target, id, start: from, end: to };

  if (!before && after) {
    const a = newPoint(after);
    return tidy(s, { points: [...s.points, a.point], curves: [...others, piece(a.point.id, finish, curveId)], constraints: [...keep, a.constraint] });
  }
  if (before && !after) {
    const b = newPoint(before);
    return tidy(s, { points: [...s.points, b.point], curves: [...others, piece(start, b.point.id, curveId)], constraints: [...keep, b.constraint] });
  }
  // A piece in the middle: split into two.
  const b = newPoint(before!);
  const a = newPoint(after!);
  const secondId = sketchId(target.type === "line" ? "l" : "a");
  const copied = keep
    .filter((k) => k.refs.includes(curveId) && (k.type === "horizontal" || k.type === "vertical"))
    .map((k) => ({ ...k, id: sketchId("c"), refs: k.refs.map((r) => (r === curveId ? secondId : r)) }));
  return tidy(s, {
    points: [...s.points, b.point, a.point],
    curves: [...others, piece(start, b.point.id, curveId), piece(a.point.id, finish, secondId)],
    constraints: [...keep, b.constraint, a.constraint, ...copied],
  });
}

/** Drop points nothing uses any more (and constraints on them), then solve. */
function tidy(before: SketchData, changed: SketchData): EditResult {
  const result = deleteItems(changed, []);
  const solved = solveSketch(result);
  if (!solved.ok) return { sketch: before, error: "Trimming there would conflict with the sketch's constraints." };
  return { sketch: solved.sketch };
}
