/**
 * Slot along a curve (Onshape's slot on a curve): pick a line, arc, circle,
 * spline or ellipse (or a run of joined lines and arcs) and give a width. Two
 * offset copies, half the width either side, held by ONE offset dimension so
 * the slot follows the curve, with round ends where the curve has ends (a
 * closed curve gets just the two copies). The curve itself becomes a dashed
 * construction line down the slot's middle. Useful for adjustable laser parts
 * (an arc slot lets a bolt slide round).
 */
import { evaluate } from "../model/expr";
import { curveById, pointPos, radiusOf, roundValue, sketchId, type EditResult } from "./ops";
import { curveParam } from "./curves";
import { solveSketch } from "./solver";
import { isWavy, offsetWavy } from "./curveEdits";
import { chainOf, offsetCurves } from "./tools";
import type { SketchArc, SketchConstraint, SketchCurve, SketchData } from "./types";

type P2 = [number, number];
const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: P2, k: number): P2 => [a[0] * k, a[1] * k];
const len = (a: P2) => Math.hypot(a[0], a[1]);
const unit = (a: P2): P2 => mul(a, 1 / (len(a) || 1));
const dot = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];
const cross = (a: P2, b: P2) => a[0] * b[1] - a[1] * b[0];

/** Half of a typed width, as text for the offset dimension: a plain number halved, else "(…) / 2". */
export function halfWidthText(text: string): string {
  const t = text.trim();
  if (/^[-+]?(\d+\.?\d*|\.\d+)(\s*mm)?$/.test(t)) return roundValue(parseFloat(t) / 2);
  return `(${t}) / 2`;
}

export interface SlotAlongResult extends EditResult {
  curveIds: string[];
  /** The offset dimension holding the slot's half width. */
  dimensionId: string;
}

/** End of a run: the point, which way the run leaves it (away from the slot), and the copies' end points there. */
interface SlotEnd {
  centre: string;
  out: P2;
}

export function slotAlong(original: SketchData, curveId: string, widthText: string): SlotAlongResult {
  const fail = (error: string): SlotAlongResult => ({ sketch: original, curveIds: [], dimensionId: "", error });
  const w = evaluate(widthText);
  if (!w.ok) return fail(w.error);
  if (!(w.value > 0)) return fail("The slot's width must be more than 0.");
  const s = original;
  const picked = curveById(s, curveId);
  if (!picked) return fail("Click a line, arc, circle, spline or ellipse to put the slot along.");
  if (picked.link) return fail("That curve follows a part or another sketch — use it as it is, or copy it in first with Use.");
  const half = w.value / 2;
  const halfText = halfWidthText(widthText);
  const eps = Math.min(half, 1e-3);
  // Two clicks, one either side of the curve, for the two offsets; and the run's ends (if any).
  let sides: [P2, P2];
  let ends: SlotEnd[] = [];
  let source: string[] = [picked.id];
  if (isWavy(picked)) {
    const path = curveParam(s, picked);
    const u = (path.lo + path.hi) / 2;
    const q = path.at(u);
    const n = unit([-path.d1(u)[1], path.d1(u)[0]]);
    sides = [add(q, mul(n, eps)), sub(q, mul(n, eps))];
    if (!path.closed) {
      const [a, b] = picked.type === "ellipse" ? [picked.start!, picked.end!] : [picked.points[0], picked.points[picked.points.length - 1]];
      ends = [
        { centre: a, out: mul(unit(path.d1(path.lo)), -1) },
        { centre: b, out: unit(path.d1(path.hi)) },
      ];
    }
  } else if (picked.type === "circle") {
    const c = pointPos(s, picked.center);
    sides = [add(c, [picked.radius + eps, 0]), add(c, [picked.radius - eps, 0])];
  } else {
    const { steps, closed } = chainOf(s, picked);
    source = steps.map((st) => st.curve.id);
    const mid = (k: SketchCurve): { q: P2; n: P2 } => {
      if (k.type === "line") {
        const a = pointPos(s, k.p1);
        const b = pointPos(s, k.p2);
        const d = unit(sub(b, a));
        return { q: mul(add(a, b), 0.5), n: [-d[1], d[0]] };
      }
      const arc = k as SketchArc;
      const c = pointPos(s, arc.center);
      const a0 = Math.atan2(pointPos(s, arc.start)[1] - c[1], pointPos(s, arc.start)[0] - c[0]);
      let sweep = Math.atan2(pointPos(s, arc.end)[1] - c[1], pointPos(s, arc.end)[0] - c[0]) - a0;
      while (sweep <= 0) sweep += 2 * Math.PI;
      const dir: P2 = [Math.cos(a0 + sweep / 2), Math.sin(a0 + sweep / 2)];
      return { q: add(c, mul(dir, radiusOf(s, arc))), n: dir };
    };
    const m = mid(picked);
    sides = [add(m.q, mul(m.n, eps)), sub(m.q, mul(m.n, eps))];
    if (!closed) {
      /** Which way the run goes at point `p` of step curve k, walking from `from` to `to`. */
      const heading = (k: SketchCurve, from: string, at: string): P2 => {
        if (k.type === "line") return unit(sub(pointPos(s, k.p1 === from ? k.p2 : k.p1), pointPos(s, from)));
        const arc = k as SketchArc;
        const c = pointPos(s, arc.center);
        const r = sub(pointPos(s, at), c);
        const t: P2 = unit([-r[1], r[0]]);
        // Walking an arc anticlockwise (start → end) its heading is the anticlockwise tangent.
        return from === arc.start ? t : mul(t, -1);
      };
      const first = steps[0];
      const last = steps[steps.length - 1];
      ends = [
        { centre: first.from, out: mul(heading(first.curve, first.from, first.from), -1) },
        { centre: last.to, out: heading(last.curve, last.from, last.to) },
      ];
    }
  }
  const offset = (d: SketchData, at: P2) =>
    isWavy(picked) ? offsetWavy(d, curveById(d, curveId) as never, { x: at[0], y: at[1] }, halfText) : offsetCurves(d, curveId, { x: at[0], y: at[1] }, halfText);
  const before = new Set(s.constraints.map((k) => k.id));
  const one = offset(s, sides[0]);
  if (one.error) return fail(one.error.replace("offset", "slot").replace("The slot distance", "The slot's width"));
  const two = offset(one.sketch, sides[1]);
  if (two.error) return fail(/bigger/.test(two.error) ? "That slot is too wide for this curve — try a narrower one." : two.error);
  let d = two.sketch;
  // One dimension holds both sides.
  const made = d.constraints.filter((k) => !before.has(k.id) && k.type === "offset");
  if (made.length !== 2) return fail("The slot couldn't be made along that curve.");
  const [k1, k2] = made;
  const joined: SketchConstraint = { ...k1, refs: [...k1.refs, ...k2.refs], extra: [...(k1.extra ?? []), ...(k2.extra ?? [])], value: halfText };
  d = { ...d, constraints: d.constraints.filter((k) => k.id !== k2.id).map((k) => (k.id === k1.id ? joined : k)) };
  const copies = [...one.curveIds, ...two.curveIds];
  const extra: SketchCurve[] = [];
  const constraints: SketchConstraint[] = [];
  for (const end of ends) {
    const C = pointPos(d, end.centre);
    // Each side's copy that ends next to this end: the copy's end point nearest it.
    const endOf = (ids: string[]) => {
      let best: { curve: string; point: string; gap: number } | null = null;
      for (const id of ids) {
        const k = curveById(d, id)!;
        const pts = k.type === "line" ? [k.p1, k.p2] : k.type === "arc" ? [k.start, k.end] : k.type === "spline" && !k.closed ? [k.points[0], k.points[k.points.length - 1]] : [];
        for (const p of pts) {
          const gap = Math.abs(len(sub(pointPos(d, p), C)) - half) + len(sub(pointPos(d, p), C));
          if (!best || gap < best.gap) best = { curve: id, point: p, gap };
        }
      }
      return best;
    };
    const a = endOf(one.curveIds);
    const b = endOf(two.curveIds);
    if (!a || !b) return fail("The slot's round ends couldn't be made.");
    const A = pointPos(d, a.point);
    const id = sketchId("a");
    const startA = cross(sub(A, C), end.out) > 0;
    const cap: SketchArc = { id, type: "arc", center: end.centre, start: startA ? a.point : b.point, end: startA ? b.point : a.point, construction: false };
    extra.push(cap);
    for (const side of [a, b]) {
      const k = curveById(d, side.curve)!;
      const T = pointPos(d, side.point);
      const t: SketchConstraint = { id: sketchId("c"), type: "tangent", refs: [side.curve, id] };
      if (k.type === "arc") t.extra = [dot(sub(pointPos(d, k.center), T), sub(C, T)) > 0 ? 1 : 0];
      constraints.push(t);
    }
  }
  const sourceSet = new Set(source);
  const solved = solveSketch({
    ...d,
    curves: [...d.curves.map((k) => (sourceSet.has(k.id) ? { ...k, construction: true } : k)), ...extra],
    constraints: [...d.constraints, ...constraints],
  });
  if (!solved.ok) return fail("A slot along that curve would conflict with the sketch's other constraints.");
  return { sketch: solved.sketch, curveIds: [...copies, ...extra.map((k) => k.id)], dimensionId: joined.id };
}
