/**
 * Sketch chamfer (Onshape's sketch Chamfer): cut a corner where two lines meet
 * with a short straight line. Like Round (filletCorner in tools.ts), the corner
 * point stays as a "virtual sharp" — the lines' length dimensions measure to
 * it — and the cut-off stretches are kept as dashed construction lines from the
 * chamfer's ends to the sharp, which carry the chamfer's sizes.
 */
import { evaluate } from "../model/expr";
import { curveById, deleteItems, pointPos, sketchId, type EditResult } from "./ops";
import { solveSketch } from "./solver";
import { mergeCoincident } from "./tools";
import { ORIGIN_ID, type SketchConstraint, type SketchCurve, type SketchData, type SketchLine, type SketchPoint } from "./types";

type P2 = [number, number];
const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: P2, k: number): P2 => [a[0] * k, a[1] * k];
const len = (a: P2) => Math.hypot(a[0], a[1]);
const unit = (a: P2): P2 => mul(a, 1 / (len(a) || 1));
const dot = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];
const cross = (a: P2, b: P2) => a[0] * b[1] - a[1] * b[0];

const con = (type: SketchConstraint["type"], refs: string[], value?: string, extra?: number[]): SketchConstraint => ({
  id: sketchId("c"),
  type,
  refs,
  ...(value !== undefined ? { value } : {}),
  ...(extra !== undefined ? { extra } : {}),
});

/** Onshape's three ways of sizing a chamfer. */
export type ChamferMode = "equal" | "two" | "angle";

export interface ChamferOptions {
  mode: ChamferMode;
  /** Distance from the corner along the first line (and the second, for Equal), as typed. */
  distance: string;
  /** Two distances: along the second line. */
  distance2?: string;
  /** Distance and angle: degrees between the chamfer and the first line (45 = the usual). */
  angle?: string;
  /**
   * Equal distance: the construction line holding an earlier chamfer's size. This one is kept Equal
   * to it instead of getting a dimension of its own, so changing one changes them all (as Onshape).
   */
  equalTo?: string;
}

export interface ChamferResult extends EditResult {
  /** The chamfer line made. */
  lineId: string;
  /** The construction line along the first line holding the chamfer's (first) distance — for `equalTo`. */
  sizeLineId: string;
}

/**
 * Chamfer the corner where two lines meet at `pointId`. The first line is the
 * one the corner point starts (or, for the corner of two picked lines, the
 * first picked: `firstLine`).
 */
export function chamferCorner(original: SketchData, pointId: string, opts: ChamferOptions, firstLine?: string): ChamferResult {
  const fail = (error: string): ChamferResult => ({ sketch: original, lineId: "", sizeLineId: "", error });
  if (pointId === ORIGIN_ID) return fail("Click a corner where two lines meet.");
  const d1 = evaluate(opts.distance);
  if (!d1.ok) return fail(d1.error);
  if (!(d1.value > 0)) return fail("The chamfer's distance must be more than 0.");
  let d2 = d1.value;
  let angle = 0;
  if (opts.mode === "two") {
    const v = evaluate(opts.distance2 ?? opts.distance);
    if (!v.ok) return fail(v.error);
    if (!(v.value > 0)) return fail("The chamfer's second distance must be more than 0.");
    d2 = v.value;
  } else if (opts.mode === "angle") {
    const v = evaluate(opts.angle ?? "45");
    if (!v.ok) return fail(v.error);
    if (!(v.value > 0 && v.value < 180)) return fail("The chamfer's angle must be between 0° and 180°.");
    angle = (v.value * Math.PI) / 180;
  }
  const s = mergeCoincident(original, pointId);
  const meeting = s.curves.filter((c) => !c.construction && (c.type === "line" ? c.p1 === pointId || c.p2 === pointId : c.type === "arc" ? c.start === pointId || c.end === pointId : false));
  const lines = meeting.filter((c): c is SketchLine => c.type === "line");
  if (meeting.length !== 2 || lines.length !== 2) return fail(meeting.length === 2 ? "Chamfer works where two straight lines meet — use Round for a corner with an arc." : "Click a corner where exactly two lines meet.");
  const [L1, L2] = firstLine && lines[1].id === firstLine ? [lines[1], lines[0]] : lines;
  const far = (l: SketchLine) => (l.p1 === pointId ? l.p2 : l.p1);
  const P = pointPos(s, pointId);
  const A = pointPos(s, far(L1));
  const B = pointPos(s, far(L2));
  const u1 = unit(sub(A, P));
  const u2 = unit(sub(B, P));
  const phi = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
  if (phi < 1e-3 || phi > Math.PI - 1e-3) return fail("Those lines are in a straight line, so there's no corner to chamfer.");
  if (opts.mode === "angle") {
    // The triangle cut off: the corner's angle φ at P, the chamfer's angle at the first line's cut.
    const third = Math.PI - phi - angle;
    if (third < 1e-3) return fail("That angle is too big for this corner — the chamfer would never meet the second line. Try a smaller one.");
    d2 = (d1.value * Math.sin(angle)) / Math.sin(third);
  }
  if (d1.value >= len(sub(A, P)) - 1e-6 || d2 >= len(sub(B, P)) - 1e-6) return fail("That chamfer is too big for these lines — try a smaller distance.");
  const T1 = add(P, mul(u1, d1.value));
  const T2 = add(P, mul(u2, d2));
  const [t1, t2] = [T1, T2].map(([x, y]): SketchPoint => ({ id: sketchId("p"), x, y }));
  const ids = { cut: sketchId("l"), c1: sketchId("l"), c2: sketchId("l") };
  const reroute = (l: SketchLine, to: string): SketchLine => (l.p1 === pointId ? { ...l, p1: to } : { ...l, p2: to });
  const curves: SketchCurve[] = [
    ...s.curves.map((k) => (k.id === L1.id ? reroute(L1, t1.id) : k.id === L2.id ? reroute(L2, t2.id) : k)),
    { id: ids.cut, type: "line", p1: t1.id, p2: t2.id, construction: false },
    { id: ids.c1, type: "line", p1: pointId, p2: t1.id, construction: true },
    { id: ids.c2, type: "line", p1: pointId, p2: t2.id, construction: true },
  ];
  const constraints: SketchConstraint[] = s.constraints.map((k) =>
    // A length dimension on a cut-back line now measures to the virtual sharp instead.
    k.type === "length" && (k.refs[0] === L1.id || k.refs[0] === L2.id) ? { ...k, type: "distance", refs: [pointId, far(k.refs[0] === L1.id ? L1 : L2)] } : k,
  );
  constraints.push(con("pointOnLine", [pointId, L1.id]), con("pointOnLine", [pointId, L2.id]));
  const earlier = opts.mode === "equal" && opts.equalTo && curveById(s, opts.equalTo)?.type === "line" ? opts.equalTo : undefined;
  if (opts.mode === "equal") {
    constraints.push(earlier ? con("equal", [earlier, ids.c1]) : con("length", [ids.c1], opts.distance), con("equal", [ids.c1, ids.c2]));
  } else if (opts.mode === "two") {
    constraints.push(con("length", [ids.c1], opts.distance), con("length", [ids.c2], opts.distance2 ?? opts.distance));
  } else {
    // The angle inside the cut-off corner, between the chamfer and the stretch of the first line it cut off.
    const u: P2 = sub(P, T1);
    const w: P2 = sub(T2, T1);
    const sign = Math.atan2(cross(u, w), dot(u, w)) >= 0 ? 1 : -1;
    constraints.push(con("length", [ids.c1], opts.distance), { ...con("angle", [ids.c1, ids.cut], opts.angle ?? "45", [sign, -1, 1]), labelOffset: { x: 0, y: 0 } });
  }
  for (const k of constraints) if (k.type === "length" && (k.refs[0] === ids.c1 || k.refs[0] === ids.c2)) k.labelOffset = { x: 0, y: 0 };
  const changed: SketchData = { ...s, points: [...s.points, t1, t2], curves, constraints };
  const solved = solveSketch(changed);
  if (!solved.ok) return fail("Chamfering this corner would conflict with the sketch's other constraints.");
  return { sketch: solved.sketch, lineId: ids.cut, sizeLineId: ids.c1 };
}

/** Where two lines meet (or would, carried on), or null when they're parallel. */
function lineMeet(a: P2, b: P2, c: P2, d: P2): P2 | null {
  const r = sub(b, a);
  const q = sub(d, c);
  const den = cross(r, q);
  if (Math.abs(den) < 1e-12 * (len(r) * len(q) || 1)) return null;
  return add(a, mul(r, cross(sub(c, a), q) / den));
}

/**
 * The corner of two picked lines: the point they share, or — when they don't
 * meet — each trimmed or carried on to where they cross, keeping the part that
 * was clicked (`at1`, `at2`), so they then share a corner point (as Onshape
 * does for a chamfer or round between two lines).
 */
export function cornerOfLines(original: SketchData, id1: string, at1: P2, id2: string, at2: P2): EditResult & { pointId: string } {
  const fail = (error: string) => ({ sketch: original, pointId: "", error });
  const l1 = curveById(original, id1);
  const l2 = curveById(original, id2);
  if (l1?.type !== "line" || l2?.type !== "line" || id1 === id2) return fail("Click two different straight lines.");
  // They already share an end (or ends held together): that's the corner.
  for (const p of [l1.p1, l1.p2]) {
    if (p === ORIGIN_ID) continue;
    const merged = mergeCoincident(original, p);
    const k2 = curveById(merged, id2);
    if (k2?.type === "line" && (k2.p1 === p || k2.p2 === p)) return { sketch: merged, pointId: p };
  }
  const s = original;
  const [a1, b1, a2, b2] = [l1.p1, l1.p2, l2.p1, l2.p2].map((id) => pointPos(s, id));
  const V = lineMeet(a1, b1, a2, b2);
  if (!V) return fail("Those lines are parallel, so they have no corner.");
  const param = (a: P2, b: P2, p: P2) => dot(sub(p, a), sub(b, a)) / (dot(sub(b, a), sub(b, a)) || 1);
  const v: SketchPoint = { id: sketchId("p"), x: V[0], y: V[1] };
  /** The line with the end on the corner's side of the click moved to the corner. */
  const moved = (l: SketchLine, a: P2, b: P2, at: P2): SketchLine | null => {
    const tc = param(a, b, at);
    const tv = param(a, b, V);
    if (Math.abs(tv - tc) < 1e-9) return null;
    return tv > tc ? { ...l, p2: v.id } : { ...l, p1: v.id };
  };
  const n1 = moved(l1, a1, b1, at1);
  const n2 = moved(l2, a2, b2, at2);
  if (!n1 || !n2) return fail("Click the lines a little away from where they cross.");
  // Their lengths change, so length dimensions on them go.
  const constraints = s.constraints.filter((k) => !(k.type === "length" && (k.refs[0] === id1 || k.refs[0] === id2)));
  const changed: SketchData = { ...s, points: [...s.points, v], curves: s.curves.map((k) => (k.id === id1 ? n1 : k.id === id2 ? n2 : k)), constraints };
  // Ends no longer used by anything are dropped.
  const tidied = deleteItems(changed, []);
  const solved = solveSketch(tidied);
  if (!solved.ok) return fail("Joining those lines at their corner would conflict with the sketch's other constraints.");
  return { sketch: solved.sketch, pointId: v.id };
}
