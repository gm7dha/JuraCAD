/**
 * Round between two picked lines or arcs that don't share a point (Onshape's
 * sketch Fillet on two curves): an arc of the radius touching both smoothly,
 * each curve trimmed back or carried on to where the arc touches it, keeping
 * the part that was clicked.
 */
import { evaluate } from "../model/expr";
import { curveById, deleteItems, pointPos, radiusOf, sketchId, type EditResult } from "./ops";
import { solveSketch } from "./solver";
import { filletCorner, mergeCoincident, sizeOfRound } from "./tools";
import { ORIGIN_ID, type SketchArc, type SketchConstraint, type SketchCurve, type SketchData, type SketchLine, type SketchPoint } from "./types";

type P2 = [number, number];
const TAU = Math.PI * 2;
const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: P2, k: number): P2 => [a[0] * k, a[1] * k];
const len = (a: P2) => Math.hypot(a[0], a[1]);
const unit = (a: P2): P2 => mul(a, 1 / (len(a) || 1));
const dot = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];
const cross = (a: P2, b: P2) => a[0] * b[1] - a[1] * b[0];
const norm = (a: number) => ((a % TAU) + TAU) % TAU;

const con = (type: SketchConstraint["type"], refs: string[], extra?: number[]): SketchConstraint => ({ id: sketchId("c"), type, refs, ...(extra ? { extra } : {}) });

type Round = SketchLine | SketchArc;
type Side = { kind: "line"; a: P2; d: P2 } | { kind: "circle"; c: P2; r: number };

/** The end both curves share (after joining points held together), if any. */
function sharedEnd(s: SketchData, a: Round, b: Round): { sketch: SketchData; point: string } | null {
  const ends = (k: Round) => (k.type === "line" ? [k.p1, k.p2] : [k.start, k.end]);
  for (const p of ends(a)) {
    if (p === ORIGIN_ID) continue;
    const merged = mergeCoincident(s, p);
    const k = curveById(merged, b.id) as Round | undefined;
    if (k && ends(k).includes(p)) return { sketch: merged, point: p };
  }
  return null;
}

export interface FilletBetweenResult extends EditResult {
  arcId: string;
}

/**
 * Round between curves `idA` and `idB` (lines or arcs), clicked at `atA` and
 * `atB`. Curves that already meet at an end are rounded as a corner (as Round
 * does); otherwise they're trimmed or carried on to the round. `equalTo`: an
 * earlier round to keep this one Equal to (no radius dimension of its own).
 */
export function filletBetween(s: SketchData, idA: string, atA: P2, idB: string, atB: P2, radiusText: string, equalTo?: string): FilletBetweenResult {
  const fail = (error: string): FilletBetweenResult => ({ sketch: s, arcId: "", error });
  const r = evaluate(radiusText);
  if (!r.ok) return fail(r.error);
  if (!(r.value > 0)) return fail("The radius must be more than 0.");
  const ka = curveById(s, idA);
  const kb = curveById(s, idB);
  if (!ka || !kb || idA === idB) return fail("Click two different lines or arcs to round between.");
  if ((ka.type !== "line" && ka.type !== "arc") || (kb.type !== "line" && kb.type !== "arc"))
    return fail("Round between two curves works on lines and arcs — trim a circle into an arc first, or round a corner where they meet.");
  const shared = sharedEnd(s, ka, kb);
  if (shared) {
    const made = filletCorner(shared.sketch, shared.point, radiusText, equalTo);
    return made.error ? fail(made.error) : made;
  }
  const radius = r.value;
  const P = (id: string) => pointPos(s, id);
  const shifted = (k: Round, sign: number): Side => {
    if (k.type === "line") {
      const a = P(k.p1);
      const d = unit(sub(P(k.p2), a));
      return { kind: "line", a: add(a, mul([-d[1], d[0]], sign * radius)), d };
    }
    return { kind: "circle", c: P(k.center), r: radiusOf(s, k) + sign * radius };
  };
  const meet = (u: Side, w: Side): P2[] => {
    if (u.kind === "line" && w.kind === "line") {
      const den = cross(u.d, w.d);
      if (Math.abs(den) < 1e-12) return [];
      return [add(u.a, mul(u.d, cross(sub(w.a, u.a), w.d) / den))];
    }
    if (u.kind === "circle" && w.kind === "circle") {
      if (u.r <= 1e-9 || w.r <= 1e-9) return [];
      const d = len(sub(w.c, u.c));
      if (d < 1e-12 || d > u.r + w.r || d < Math.abs(u.r - w.r)) return [];
      const x = (d * d + u.r * u.r - w.r * w.r) / (2 * d);
      const h = Math.sqrt(Math.max(0, u.r * u.r - x * x));
      const e = unit(sub(w.c, u.c));
      const m = add(u.c, mul(e, x));
      return [add(m, mul([-e[1], e[0]], h)), sub(m, mul([-e[1], e[0]], h))];
    }
    const [l, c] = (u.kind === "line" ? [u, w] : [w, u]) as [Extract<Side, { kind: "line" }>, Extract<Side, { kind: "circle" }>];
    if (c.r <= 1e-9) return [];
    const f = sub(l.a, c.c);
    const b = dot(f, l.d);
    const disc = b * b - (dot(f, f) - c.r * c.r);
    if (disc < 0) return [];
    const q = Math.sqrt(disc);
    return [add(l.a, mul(l.d, -b - q)), add(l.a, mul(l.d, -b + q))];
  };
  /** Where a round centred at f touches k (on the whole line or circle). */
  const foot = (k: Round, f: P2): P2 => {
    if (k.type === "line") {
      const a = P(k.p1);
      const d = sub(P(k.p2), a);
      return add(a, mul(d, dot(sub(f, a), d) / (dot(d, d) || 1)));
    }
    const c = P(k.center);
    return add(c, mul(unit(sub(f, c)), radiusOf(s, k)));
  };
  let best: { f: P2; t1: P2; t2: P2; cost: number } | null = null;
  for (const s1 of [1, -1])
    for (const s2 of [1, -1])
      for (const f of meet(shifted(ka, s1), shifted(kb, s2))) {
        const t1 = foot(ka, f);
        const t2 = foot(kb, f);
        if (len(sub(t1, t2)) < 1e-9) continue;
        // The round nearest where the curves were clicked (it joins the parts kept).
        const cost = len(sub(t1, atA)) + len(sub(t2, atB));
        if (!best || cost < best.cost) best = { f, t1, t2, cost };
      }
  if (!best) return fail("A round of that radius can't touch both of those — try another radius.");
  const { f, t1: T1, t2: T2 } = best;
  const [p1, p2, pc] = [T1, T2, f].map(([x, y]): SketchPoint => ({ id: sketchId("p"), x, y }));
  const arcId = sketchId("a");
  const ccw = cross(sub(T1, f), sub(T2, f)) > 0;
  const fillet: SketchArc = { id: arcId, type: "arc", center: pc.id, start: ccw ? p1.id : p2.id, end: ccw ? p2.id : p1.id, construction: false };

  /** The curve with the end on the round's side of the click moved to where the round touches it. */
  const trimmed = (k: Round, at: P2, T: P2, to: string): SketchCurve | string => {
    if (k.type === "line") {
      const a = P(k.p1);
      const d = sub(P(k.p2), a);
      const tc = dot(sub(at, a), d) / (dot(d, d) || 1);
      const tt = dot(sub(T, a), d) / (dot(d, d) || 1);
      if (Math.abs(tt - tc) < 1e-9) return "Click the lines a little away from where the round would touch them.";
      return tt > tc ? { ...k, p2: to } : { ...k, p1: to };
    }
    const c = P(k.center);
    const ang = (p: P2) => Math.atan2(p[1] - c[1], p[0] - c[0]);
    const a0 = ang(P(k.start));
    const sweep = norm(ang(P(k.end)) - a0) || TAU;
    const ac = norm(ang(at) - a0);
    const aT = norm(ang(T) - a0);
    if (aT <= sweep) return aT > ac ? { ...k, end: to } : { ...k, start: to };
    // Past the arc's ends: carry on the nearer one round to it.
    return aT - sweep < TAU - aT ? { ...k, end: to } : { ...k, start: to };
  };
  const na = trimmed(ka, atA, T1, p1.id);
  const nb = trimmed(kb, atB, T2, p2.id);
  if (typeof na === "string") return fail(na);
  if (typeof nb === "string") return fail(nb);
  const resized = new Set(["length", "arcLength", "arcAngle"]);
  const constraints = s.constraints.filter((k) => !(resized.has(k.type) && (k.refs[0] === idA || k.refs[0] === idB)));
  const tangentTo = (k: Round, T: P2): SketchConstraint =>
    k.type === "arc" ? con("tangent", [k.id, arcId], [dot(sub(P(k.center), T), sub(f, T)) > 0 ? 1 : 0]) : con("tangent", [k.id, arcId]);
  constraints.push(tangentTo(ka, T1), tangentTo(kb, T2), sizeOfRound(s, arcId, radiusText, equalTo));
  const changed: SketchData = {
    ...s,
    points: [...s.points, p1, p2, pc],
    curves: [...s.curves.map((k) => (k.id === idA ? na : k.id === idB ? nb : k)), fillet],
    constraints,
  };
  // Ends no longer used by anything are dropped.
  const solved = solveSketch(deleteItems(changed, []));
  if (!solved.ok) return fail("Rounding between those would conflict with the sketch's other constraints.");
  return { sketch: solved.sketch, arcId };
}
