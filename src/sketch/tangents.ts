/**
 * Tangent lines while drawing (Onshape's tangent inference): a line started
 * on one circle or arc and ended near another is offered the four lines that
 * just touch both — the two "outer" ones (both circles on the same side) and
 * the two "crossing" ones (between them). A line from a point is offered the
 * two lines that just touch the circle it's heading for.
 *
 * Arcs count as circles here, but a line is only offered where it would
 * touch the arc itself (not the rest of its circle). Part edges and other
 * sketches' circles shown in the sketch (reference edges) count too: they're
 * brought in when the line is made.
 *
 * All positions are sketch millimetres.
 */
import type { RefEdge } from "./links";
import { addLine, curveById, pointPos, radiusOf, type EditResult, type Placed, type Snap } from "./ops";
import { linkedCurveFor } from "./links";
import { solveSketch } from "./solver";
import { sketchId } from "./ops";
import type { SketchConstraint, SketchData } from "./types";

type P2 = [number, number];

/** What a tangent line touches: one of the sketch's circles or arcs, or a reference edge (brought in when used). */
export type TangentTarget = { kind: "curve"; id: string } | { kind: "ref"; edge: RefEdge };

/** A circle or arc a tangent line can touch. */
export interface Round {
  centre: P2;
  r: number;
  /** Arcs: where they start and how far round they go, anticlockwise (radians). Missing for whole circles. */
  arc?: { from: number; sweep: number };
  target: TangentTarget;
}

/** A tangent line offered while drawing. */
export interface TangentLine {
  /** Where the line starts (moved round the first circle, when it started on one) and ends (on the circle it touches). */
  start: P2;
  end: P2;
  /** The circle the line starts on, if it did. */
  startOn: TangentTarget | null;
  endOn: TangentTarget;
  /** Both circles on the same side of the line, the line passing between them, or from a point. */
  kind: "outer" | "crossing" | "point";
}

const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const TAU = 2 * Math.PI;
const norm = (a: number) => ((a % TAU) + TAU) % TAU;

/**
 * The lines touching two circles: up to two outer ones (none when one circle
 * is inside the other) and up to two crossing ones (only when they're apart).
 * `a` is on the first circle, `b` on the second.
 */
export function circleTangents(c1: P2, r1: number, c2: P2, r2: number): { kind: "outer" | "crossing"; a: P2; b: P2 }[] {
  const d = dist(c1, c2);
  if (d < 1e-9) return [];
  const u: P2 = [(c2[0] - c1[0]) / d, (c2[1] - c1[1]) / d];
  const w: P2 = [-u[1], u[0]];
  const out: { kind: "outer" | "crossing"; a: P2; b: P2 }[] = [];
  // A line n·x = h with both centres on its +n side (outer: n·c1 − h = r1, n·c2 − h = r2),
  // or on opposite sides (crossing: n·c2 − h = −r2). So n·u = (r2 − r1)/d or −(r1 + r2)/d.
  for (const kind of ["outer", "crossing"] as const) {
    const cos = kind === "outer" ? (r2 - r1) / d : -(r1 + r2) / d;
    if (Math.abs(cos) > 1 + 1e-12) continue;
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    // Touching circles give one line twice: keep it once.
    for (const side of sin < 1e-9 ? [1] : [1, -1]) {
      const n: P2 = [cos * u[0] + side * sin * w[0], cos * u[1] + side * sin * w[1]];
      const a: P2 = [c1[0] - r1 * n[0], c1[1] - r1 * n[1]];
      const k = kind === "outer" ? -r2 : r2;
      const b: P2 = [c2[0] + k * n[0], c2[1] + k * n[1]];
      out.push({ kind, a, b });
    }
  }
  return out;
}

/** Where the two lines from a point just touch a circle (none when the point is inside it). */
export function pointTangents(p: P2, c: P2, r: number): P2[] {
  const d = dist(p, c);
  if (d <= r + 1e-9) return [];
  const u: P2 = [(p[0] - c[0]) / d, (p[1] - c[1]) / d];
  const cos = r / d;
  const sin = Math.sqrt(1 - cos * cos);
  return [1, -1].map((side): P2 => [c[0] + r * (cos * u[0] - side * sin * u[1]), c[1] + r * (cos * u[1] + side * sin * u[0])]);
}

/** Whether a point on a circle is on the arc (within a hair of its ends). */
function onArc(round: Round, p: P2): boolean {
  if (!round.arc) return true;
  const a = norm(Math.atan2(p[1] - round.centre[1], p[0] - round.centre[0]) - round.arc.from);
  const slack = 1e-6 / Math.max(round.r, 1e-6);
  return a <= round.arc.sweep + slack || a >= TAU - slack;
}

/** The sketch's circles and arcs, and the round reference edges, as rounds a tangent line can touch. */
export function roundsOf(s: SketchData, refs: RefEdge[] = [], ignore?: Set<string>): Round[] {
  const out: Round[] = [];
  for (const c of s.curves) {
    if ((c.type !== "circle" && c.type !== "arc") || ignore?.has(c.id)) continue;
    try {
      const centre = pointPos(s, c.center);
      const r = radiusOf(s, c);
      if (!(r > 1e-9)) continue;
      let arc: Round["arc"];
      if (c.type === "arc") {
        const st = pointPos(s, c.start), en = pointPos(s, c.end);
        const from = Math.atan2(st[1] - centre[1], st[0] - centre[0]);
        let sweep = norm(Math.atan2(en[1] - centre[1], en[0] - centre[0]) - from);
        if (sweep < 1e-12) sweep = TAU;
        arc = { from, sweep };
      }
      out.push({ centre, r, ...(arc ? { arc } : {}), target: { kind: "curve", id: c.id } });
    } catch {
      // refers to something that no longer exists
    }
  }
  for (const e of refs) {
    if ((e.kind !== "circle" && e.kind !== "arc") || !e.centre || !e.radius) continue;
    // Edges already in the sketch are offered as the sketch's own curve.
    if (linkedCurveFor(s, e)) continue;
    let arc: Round["arc"];
    if (e.kind === "arc" && e.start && e.end) {
      const from = Math.atan2(e.start[1] - e.centre[1], e.start[0] - e.centre[0]);
      arc = { from, sweep: norm(Math.atan2(e.end[1] - e.centre[1], e.end[0] - e.centre[0]) - from) || TAU };
    }
    out.push({ centre: e.centre, r: e.radius, ...(arc ? { arc } : {}), target: { kind: "ref", edge: e } });
  }
  return out;
}

const sameTarget = (a: TangentTarget, b: TangentTarget) => (a.kind === "curve" && b.kind === "curve" ? a.id === b.id : a.kind === "ref" && b.kind === "ref" ? a.edge === b.edge : false);

/** The circle or arc a placed point sits on (by what it snapped to), if any. */
export function roundUnder(rounds: Round[], p: Placed): Round | null {
  const sn = p.snap;
  if (sn?.kind === "curve") return rounds.find((r) => r.target.kind === "curve" && r.target.id === sn.id) ?? null;
  if (sn?.kind === "ref" && sn.at === "on") return rounds.find((r) => r.target.kind === "ref" && r.target.edge === sn.edge) ?? null;
  return null;
}

/**
 * The tangent line to offer while drawing a line from `start` with the
 * pointer at (x, y): when the start is on a circle or arc, the line touching
 * it and the circle the pointer is near; from anywhere else, the line from the
 * start touching that circle. Only offered when the pointer is within `reach`
 * (mm) of where the line would touch. Null when there's none.
 */
export function tangentLineAt(s: SketchData, start: Placed, x: number, y: number, reach: number, refs: RefEdge[] = []): TangentLine | null {
  const rounds = roundsOf(s, refs);
  if (!rounds.length) return null;
  // Started on a circle's rim: by what the click snapped to, or (for circles shown from elsewhere,
  // which aren't snapped onto) by being right on the rim.
  let from = roundUnder(rounds, start);
  if (!from && !start.snap) {
    let bestRim = reach / 2;
    for (const r of rounds) {
      const off = Math.abs(dist([start.x, start.y], r.centre) - r.r);
      if (r.target.kind === "ref" && off <= bestRim && onArc(r, [start.x, start.y])) {
        bestRim = off;
        from = r;
      }
    }
  }
  const pointer: P2 = [x, y];
  let best: TangentLine | null = null;
  let bestD = reach;
  for (const to of rounds) {
    if (from && sameTarget(from.target, to.target)) continue;
    // Quick check: the pointer must be near this circle at all.
    if (Math.abs(dist(pointer, to.centre) - to.r) > reach) continue;
    if (from) {
      for (const t of circleTangents(from.centre, from.r, to.centre, to.r)) {
        if (!onArc(from, t.a) || !onArc(to, t.b) || dist(t.a, t.b) < 1e-6) continue;
        const d = dist(t.b, pointer);
        if (d <= bestD) {
          bestD = d;
          best = { start: t.a, end: t.b, startOn: from.target, endOn: to.target, kind: t.kind };
        }
      }
    } else {
      for (const b of pointTangents([start.x, start.y], to.centre, to.r)) {
        if (!onArc(to, b)) continue;
        const d = dist(b, pointer);
        if (d <= bestD) {
          bestD = d;
          best = { start: [start.x, start.y], end: b, startOn: null, endOn: to.target, kind: "point" };
        }
      }
    }
  }
  return best;
}

const snapFor = (t: TangentTarget): Snap => (t.kind === "curve" ? { kind: "curve", id: t.id } : { kind: "ref", edge: t.edge, at: "on" });

/**
 * Make a tangent line: its ends on the circles (or the start where it was
 * clicked), held touching each circle with Tangent constraints. Reference
 * edges are brought in (as references that follow their source) first.
 */
export function addTangentLine(s: SketchData, start: Placed, t: TangentLine, construction = false): EditResult & { lineId: string; endId: string } {
  const a: Placed = t.startOn ? { x: t.start[0], y: t.start[1], snap: snapFor(t.startOn) } : start;
  const b: Placed = { x: t.end[0], y: t.end[1], snap: snapFor(t.endOn) };
  const made = addLine(s, a, b, { construction });
  if (made.error) return made;
  const idOf = (target: TangentTarget) => (target.kind === "curve" ? target.id : linkedCurveFor(made.sketch, target.edge)?.id);
  const touching = [t.startOn, t.endOn].filter((x): x is TangentTarget => !!x).map(idOf);
  if (touching.some((id) => !id || !curveById(made.sketch, id)))
    return { sketch: s, lineId: "", endId: "", error: "That circle can't be used for a tangent line here. Draw the line, then add Tangent from the constraints." };
  const constraints: SketchConstraint[] = touching.map((id) => ({ id: sketchId("c"), type: "tangent", refs: [made.lineId, id!] }));
  const r = solveSketch({ ...made.sketch, constraints: [...made.sketch.constraints, ...constraints] });
  if (!r.ok) return { sketch: s, lineId: "", endId: "", error: "The line can't be made to touch that circle — something else holds it in place. Draw it without snapping, then add Tangent." };
  return { sketch: r.sketch, lineId: made.lineId, endId: made.endId };
}
