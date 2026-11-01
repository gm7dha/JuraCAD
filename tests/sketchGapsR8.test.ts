/**
 * Sketch gaps closed in round 8 (pure logic, exact numbers): Shift places a
 * point without snapping; circles and arcs from elsewhere at a slant are seen
 * as their real ellipse (or part of one); another sketch's spline can be used
 * and follows; Pierce finds every crossing of a wiggly edge; relations on
 * curves say "Working…" first.
 */
import { describe, expect, it } from "vitest";

import type { EdgeRef, Vec3 } from "../src/geometry/topoRef";
import { curveParam, ellipseSpan } from "../src/sketch/curves";
import { ellipseFrom } from "../src/sketch/ellipse";
import { followLinks, linkEdge, refSketch, type RefEdge } from "../src/sketch/links";
import { addCircle, addLine, addPoint, curveById, pointPos, relationMayTakeAWhile, type Placed } from "../src/sketch/ops";
import { planeFrame, planeOnFace, toSketch, toWorld, type SketchPlane } from "../src/sketch/planes";
import { PIERCE_SAMPLES, circleOf, edgePierceRefs, edgePierces, pierceSamples, seeConic, seeEdge, seeSketchCurve, shapePath, sketchRefs, type SourceSketch } from "../src/sketch/projected";
import { sketchCurveAt, snapAt } from "../src/sketch/snaps";
import { solveSketch } from "../src/sketch/solver";
import { addCentreArc, addEllipse, addSpline } from "../src/sketch/tools";
import { emptySketch, type SketchData, type SketchEllipse, type SketchSpline } from "../src/sketch/types";

const at = (x: number, y: number): Placed => ({ x, y, snap: null });
const TOP: SketchPlane = { kind: "default", name: "Top" };
const S60 = Math.sin(Math.PI / 3);
/** A plane through the origin tipped 60° from Top about X (its normal is (0, −sin 60°, cos 60°)). */
const TILT = planeOnFace([0, -S60, 0.5], [0, 0, 0], "Tilted");
const tilt = planeFrame(TILT);
const seen = (p: Vec3) => toSketch(tilt, p);
const close = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** How far a point is off an ellipse (centre, major and minor axis ends), measured along the ray from its centre. */
function offEllipse(c: [number, number], ma: [number, number], mi: [number, number], p: [number, number]): number {
  const g = ellipseFrom(c, ma, mi);
  const [dx, dy] = [p[0] - c[0], p[1] - c[1]];
  const u = (dx * Math.cos(g.angle) + dy * Math.sin(g.angle)) / g.rx;
  const v = (-dx * Math.sin(g.angle) + dy * Math.cos(g.angle)) / g.ry;
  return Math.abs(Math.hypot(u, v) - 1) * Math.hypot(dx, dy);
}

describe("Shift: no snapping", () => {
  it("places the point exactly where the pointer is, even on top of another point", () => {
    const p = addPoint(emptySketch(), at(5, 5));
    const opts = { pointTol: 1, curveTol: 0.5 };
    expect(snapAt(p.sketch, 5.2, 4.9, opts).placed).toEqual({ x: 5, y: 5, snap: { kind: "point", id: p.pointId } });
    expect(snapAt(p.sketch, 5.2, 4.9, { ...opts, free: true })).toEqual({ placed: { x: 5.2, y: 4.9, snap: null }, hover: null, hints: [] });
  });
});

describe("circles and arcs at a slant, seen as ellipses", () => {
  it("another sketch's circle (r 4 on Top) seen from a plane tipped 60°: an ellipse 4 by 2 that the circle lies on", () => {
    const c = addCircle(emptySketch(), at(5, 5), 4);
    const src: SourceSketch = { id: "skA", name: "Sketch 1", plane: TOP, data: c.sketch };
    const e = seeSketchCurve(src, c.circleId, tilt)!;
    expect(e.kind).toBe("curve");
    const sh = e.shape!;
    if (sh.kind !== "ellipse") throw new Error("not an ellipse");
    expect(close(sh.centre, seen([5, 5, 0]))).toBeLessThan(1e-12);
    expect(close(sh.major, sh.centre)).toBeCloseTo(4, 12);
    expect(close(sh.minor, sh.centre)).toBeCloseTo(2, 12);
    // The long axis is along X (square to the tip), pointing the positive way.
    expect(sh.major[0] - sh.centre[0]).toBeCloseTo(4, 12);
    expect(sh.start).toBeUndefined();
    // Every point of the circle, seen from the tilted plane, is on it.
    for (let i = 0; i < 24; i++) {
      const t = (2 * Math.PI * i) / 24;
      expect(offEllipse(sh.centre, sh.major, sh.minor, seen([5 + 4 * Math.cos(t), 5 + 4 * Math.sin(t), 0]))).toBeLessThan(1e-12);
    }
    // Its centre can be snapped to (it follows the circle's centre); a closed curve has no ends to snap to.
    expect(e.source?.ends).toEqual({ c: (curveById(c.sketch, c.circleId) as { center: string }).center });
    const stand = refSketch([e]);
    expect(stand.points.filter((p) => /:[ab]$/.test(p.id))).toHaveLength(0);
    expect(stand.points.filter((p) => p.id === "ref:0:c")).toHaveLength(1);
  });

  it("an arc keeps its ends, anticlockwise; the copy brought in is an ellipse arc between them that solves", () => {
    const a = addCentreArc(emptySketch(), at(0, 0), at(5, 0), at(0, 5));
    const src: SourceSketch = { id: "skA", plane: TOP, data: a.sketch };
    const e = seeSketchCurve(src, a.arcId, tilt)!;
    const sh = e.shape!;
    if (sh.kind !== "ellipse") throw new Error("not an ellipse");
    expect(close(sh.start!, seen([5, 0, 0]))).toBeLessThan(1e-12);
    expect(close(sh.end!, seen([0, 5, 0]))).toBeLessThan(1e-12);
    // Its path starts at the arc's start (its "a" end) and ends at its end.
    expect(close(e.a, sh.start!)).toBeLessThan(1e-12);
    expect(close(e.b, sh.end!)).toBeLessThan(1e-12);
    const r = linkEdge(emptySketch(), e, false);
    expect(r.error).toBeUndefined();
    const el = curveById(r.sketch, r.curveId) as SketchEllipse;
    expect(el.type).toBe("ellipse");
    expect(el.link).toEqual({ sketch: "skA", item: a.arcId });
    expect(close(pointPos(r.sketch, el.start!), seen([5, 0, 0]))).toBeLessThan(1e-9);
    expect(close(pointPos(r.sketch, el.end!), seen([0, 5, 0]))).toBeLessThan(1e-9);
    // A quarter of the circle is a quarter of the ellipse (its own angle turns 90°).
    const span = ellipseSpan(r.sketch, el);
    expect(span.t1 - span.t0).toBeCloseTo(Math.PI / 2, 9);
    expect(solveSketch(r.sketch).ok).toBe(true);
    // Seen from the back of the tilted plane, anticlockwise turns the other way: start and end swap.
    const back = planeFrame(planeOnFace([0, S60, -0.5], [0, 0, 0], "Back"));
    const b = seeSketchCurve(src, a.arcId, back)!.shape!;
    if (b.kind !== "ellipse") throw new Error("not an ellipse");
    expect(close(b.start!, toSketch(back, [0, 5, 0]))).toBeLessThan(1e-12);
    expect(close(b.end!, toSketch(back, [5, 0, 0]))).toBeLessThan(1e-12);
  });

  it("the brought-in ellipse follows when the circle grows", () => {
    const c = addCircle(emptySketch(), at(5, 5), 4);
    const src: SourceSketch = { id: "skA", plane: TOP, data: c.sketch };
    const r = linkEdge(emptySketch(), seeSketchCurve(src, c.circleId, tilt)!, false);
    const bigger: SourceSketch = { ...src, data: { ...c.sketch, curves: c.sketch.curves.map((k) => (k.type === "circle" ? { ...k, radius: 6 } : k)) } };
    const now = followLinks(r.sketch, { [r.curveId]: seeSketchCurve(bigger, c.circleId, tilt) });
    const el = curveById(now, r.curveId) as SketchEllipse;
    const [ce, ma, mi] = [pointPos(now, el.center), pointPos(now, el.major), pointPos(now, el.minor)];
    expect(close(ce, seen([5, 5, 0]))).toBeLessThan(1e-9);
    expect(close(ma, ce)).toBeCloseTo(6, 9);
    expect(close(mi, ce)).toBeCloseTo(3, 9);
  });

  it("a long axis near upright keeps its ends when a tiny turn makes the original's come back the other way round", () => {
    const front = planeFrame(TOP);
    const conic = (ang: number) => ({ centre: [3, 4, 0] as Vec3, major: [10 * Math.cos(ang), 10 * Math.sin(ang), 0] as Vec3, minor: [-4 * Math.sin(ang), 4 * Math.cos(ang), 0] as Vec3, t0: 0, t1: 2 * Math.PI, whole: true });
    const before = seeConic(front, conic(Math.PI / 2 - 1e-7))!;
    const after = seeConic(front, conic(Math.PI / 2 + 1e-7))!;
    // Its own long-axis end is chosen right / up, so here the original's comes back at the other end, 20 mm away.
    expect(close(before.major, after.major)).toBeGreaterThan(19.99);
    const edge = (sh: typeof before): RefEdge => ({ kind: "curve", a: sh.major, b: sh.major, mid: sh.centre, centre: sh.centre, shape: sh, path: shapePath(sh), source: { sketch: "skA", item: "k", ends: { c: "c" } } });
    const r = linkEdge(emptySketch(), edge(before), false);
    const el = curveById(r.sketch, r.curveId) as SketchEllipse;
    const was = [pointPos(r.sketch, el.major), pointPos(r.sketch, el.minor)];
    const now = followLinks(r.sketch, { [r.curveId]: edge(after) });
    const ma = pointPos(now, el.major), mi = pointPos(now, el.minor);
    // The copy's ends hardly move (the ellipse turned 2 × 10⁻⁷ rad), and it's still the same ellipse.
    expect(close(ma, was[0])).toBeLessThan(1e-5);
    expect(close(mi, was[1])).toBeLessThan(1e-5);
    expect(close(ma, [3, 4])).toBeCloseTo(10, 9);
    expect(close(mi, [3, 4])).toBeCloseTo(4, 9);
    expect(solveSketch(now).ok).toBe(true);
  });

  it("seen side-on it's no curve (its centre is offered instead, as before)", () => {
    const c = addCircle(emptySketch(), at(5, 5), 4);
    const front = planeFrame({ kind: "default", name: "Front" });
    expect(seeSketchCurve({ id: "skA", plane: TOP, data: c.sketch }, c.circleId, front)).toBeNull();
    expect(seeConic(front, { centre: [5, 5, 0], major: [4, 0, 0], minor: [0, 4, 0], t0: 0, t1: 2 * Math.PI, whole: true })).toBeNull();
  });

  it("a part's round edge at a slant (r 6, flat on Top, 3 up) is seen as an ellipse 6 by 3 from the tilted plane", () => {
    const pts = Array.from({ length: 9 }, (_, i): Vec3 => [6 * Math.cos((2 * Math.PI * i) / 8), 6 * Math.sin((2 * Math.PI * i) / 8), 3]);
    const ref: EdgeRef = { kind: "edge", curve: "CIRCLE", a: [6, 0, 3], b: [6, 0, 3], mid: [-6, 0, 3] };
    const round = circleOf(ref, pts)!;
    expect(round.whole).toBe(true);
    const e = seeEdge(tilt, { partId: "box", ref }, pts)!;
    expect(e.kind).toBe("curve");
    expect(e.project).toBe(true);
    const sh = e.shape!;
    if (sh.kind !== "ellipse") throw new Error("not an ellipse");
    expect(close(sh.centre, seen([0, 0, 3]))).toBeLessThan(1e-12);
    expect(close(sh.major, sh.centre)).toBeCloseTo(6, 12);
    expect(close(sh.minor, sh.centre)).toBeCloseTo(3, 12);
    // The path starts at the edge's own end (where its "a" point is snapped to).
    expect(close(e.path![0], e.a)).toBeLessThan(1e-12);
    for (const p of e.path!) expect(offEllipse(sh.centre, sh.major, sh.minor, p)).toBeLessThan(1e-12);
    // Square-on (from Top) it's still a plain circle, exactly as before.
    expect(seeEdge(planeFrame(TOP), { partId: "box", ref }, pts)!.kind).toBe("circle");
    // Part of it (a half circle from (6,0,3) round to (−6,0,3)): an ellipse arc.
    const half: EdgeRef = { kind: "edge", curve: "CIRCLE", a: [6, 0, 3], b: [-6, 0, 3], mid: [0, 6, 3] };
    const hs = Array.from({ length: 9 }, (_, i): Vec3 => [6 * Math.cos((Math.PI * i) / 8), 6 * Math.sin((Math.PI * i) / 8), 3]);
    const ha = seeEdge(tilt, { partId: "box", ref: half }, hs)!.shape!;
    if (ha.kind !== "ellipse") throw new Error("not an ellipse");
    expect(close(ha.start!, seen([6, 0, 3]))).toBeLessThan(1e-12);
    expect(close(ha.end!, seen([-6, 0, 3]))).toBeLessThan(1e-12);
  });

  it("another sketch's ellipse at a slant is seen as an ellipse too", () => {
    const el = addEllipse(emptySketch(), at(0, 0), at(8, 0), [0, 4]);
    const e = seeSketchCurve({ id: "skA", plane: TOP, data: el.sketch }, el.ellipseId, tilt)!;
    const sh = e.shape!;
    if (sh.kind !== "ellipse") throw new Error("not an ellipse");
    expect(close(sh.major, sh.centre)).toBeCloseTo(8, 12);
    expect(close(sh.minor, sh.centre)).toBeCloseTo(2, 12);
  });
});

describe("another sketch's spline, used", () => {
  const spline = () => addSpline(emptySketch(), [at(0, 0), at(10, 6), at(20, -2), at(30, 5)], false);

  it("comes in as a spline that is exactly the original seen from the tilted plane, with its ends to snap to", () => {
    const sp = spline();
    const src: SourceSketch = { id: "skA", plane: TOP, data: sp.sketch };
    const e = seeSketchCurve(src, sp.splineId, tilt)!;
    expect(e.kind).toBe("curve");
    expect(e.shape?.kind).toBe("spline");
    const ids = (curveById(sp.sketch, sp.splineId) as SketchSpline).points;
    expect(e.source?.ends).toEqual({ a: ids[0], b: ids[3] });
    const r = linkEdge(emptySketch(), e, false);
    expect(r.error).toBeUndefined();
    const copy = curveById(r.sketch, r.curveId) as SketchSpline;
    expect(copy.link).toEqual({ sketch: "skA", item: sp.splineId });
    expect(copy.points).toHaveLength(4);
    expect(solveSketch(r.sketch).ok).toBe(true);
    // The same curve, place for place (projection keeps cubic pieces cubic).
    const a = curveParam(r.sketch, copy);
    const o = curveParam(sp.sketch, curveById(sp.sketch, sp.splineId)!);
    expect(a.hi - a.lo).toBe(o.hi - o.lo);
    let worst = 0;
    for (let i = 0; i <= 120; i++) {
      const u = o.lo + ((o.hi - o.lo) * i) / 120;
      const p = o.at(u);
      worst = Math.max(worst, close(a.at(a.lo + u - o.lo), seen([p[0], p[1], 0])));
    }
    expect(worst).toBeLessThan(1e-9);
    // Its points between the ends can still be snapped to on their own.
    const refs = sketchRefs(src, tilt);
    expect(refs.filter((x) => x.kind === "point" && (x.source?.item === ids[1] || x.source?.item === ids[2]))).toHaveLength(2);
  });

  it("follows when the original's point moves (same points, exact again)", () => {
    const sp = spline();
    const src: SourceSketch = { id: "skA", plane: TOP, data: sp.sketch };
    const r = linkEdge(emptySketch(), seeSketchCurve(src, sp.splineId, tilt)!, false);
    const ids = (curveById(sp.sketch, sp.splineId) as SketchSpline).points;
    const moved: SketchData = { ...sp.sketch, points: sp.sketch.points.map((p) => (p.id === ids[2] ? { ...p, x: 24, y: -9 } : p)) };
    const now = followLinks(r.sketch, { [r.curveId]: seeSketchCurve({ ...src, data: moved }, sp.splineId, tilt) });
    const copy = curveById(now, r.curveId) as SketchSpline;
    expect(copy.points).toEqual((curveById(r.sketch, r.curveId) as SketchSpline).points);
    expect(close(pointPos(now, copy.points[2]), seen([24, -9, 0]))).toBeLessThan(1e-9);
    const a = curveParam(now, copy);
    const o = curveParam(moved, curveById(moved, sp.splineId)!);
    let worst = 0;
    for (let i = 0; i <= 120; i++) {
      const u = (3 * i) / 120;
      const p = o.at(o.lo + u);
      worst = Math.max(worst, close(a.at(a.lo + u), seen([p[0], p[1], 0])));
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it("a spline that changes speed at a point (as Split leaves it) comes in exactly too, and follows reversed", () => {
    const sp = spline();
    const s0 = curveById(sp.sketch, sp.splineId) as SketchSpline;
    const kinked: SketchData = { ...sp.sketch, curves: [{ ...s0, tangents: { [s0.points[1]]: [12, 0] }, tangentsIn: { [s0.points[1]]: [4, 0] } }] };
    const src: SourceSketch = { id: "skA", plane: TOP, data: kinked };
    const e = seeSketchCurve(src, sp.splineId, tilt)!;
    const sh = e.shape!;
    if (sh.kind !== "spline") throw new Error("not a spline");
    expect(sh.tangentsIn?.filter(Boolean)).toHaveLength(1);
    const r = linkEdge(emptySketch(), e, false);
    const copy = curveById(r.sketch, r.curveId) as SketchSpline;
    expect(Object.keys(copy.tangentsIn ?? {})).toEqual([copy.points[1]]);
    const exact = (now: SketchData, id: string, from: SketchData) => {
      const a = curveParam(now, curveById(now, id)!);
      const o = curveParam(from, curveById(from, sp.splineId)!);
      let worst = 0;
      for (let i = 0; i <= 120; i++) {
        const u = (3 * i) / 120;
        const p = o.at(o.lo + u);
        worst = Math.max(worst, close(a.at(a.lo + u), seen([p[0], p[1], 0])));
      }
      return worst;
    };
    expect(exact(r.sketch, r.curveId, kinked)).toBeLessThan(1e-9);
    // The original is drawn the other way round now (its points reversed): the copy keeps its own way and its exact shape.
    const ids = s0.points;
    const flipped: SketchData = { ...kinked, curves: [{ ...s0, points: [...ids].reverse(), tangents: { [ids[1]]: [-4, 0] }, tangentsIn: { [ids[1]]: [-12, 0] } }] };
    const now = followLinks(r.sketch, { [r.curveId]: seeSketchCurve({ ...src, data: flipped }, sp.splineId, tilt) });
    const back = curveById(now, r.curveId) as SketchSpline;
    expect(back.points).toEqual(copy.points);
    expect(exact(now, r.curveId, kinked)).toBeLessThan(1e-9);
  });

  it("a closed spline has no ends to snap to; a spline seen side-on isn't offered as a curve", () => {
    const sp = addSpline(emptySketch(), [at(0, 0), at(10, 6), at(20, -2)], true);
    const e = seeSketchCurve({ id: "skA", plane: TOP, data: sp.sketch }, sp.splineId, tilt)!;
    expect(e.source?.ends).toEqual({});
    expect(refSketch([e]).points.filter((p) => /:[ab]$/.test(p.id))).toHaveLength(0);
    // From Front, a spline drawn on Top is seen side-on (a straight line): no curve.
    expect(seeSketchCurve({ id: "skA", plane: TOP, data: spline().sketch }, spline().splineId, planeFrame({ kind: "default", name: "Front" }))).toBeNull();
  });

  it("the Use tool finds another sketch's curve under the pointer, not its points or this sketch's own", () => {
    const sp = spline();
    const refs = sketchRefs({ id: "skA", plane: TOP, data: sp.sketch }, tilt);
    const curve = refs.find((r) => r.kind === "curve")!;
    const on = curve.path![5];
    expect(sketchCurveAt(refs, on[0] + 0.01, on[1], 0.1)).toBe(curve);
    expect(sketchCurveAt(refs, on[0] + 3, on[1] + 3, 0.1)).toBeNull();
    // Hidden ones are skipped.
    expect(sketchCurveAt(refs, on[0], on[1], 0.1, () => true)).toBeNull();
    const part: RefEdge = { pick: { partId: "p", ref: { kind: "edge", curve: "LINE", a: [0, 0, 0], b: [10, 0, 0], mid: [5, 0, 0] } }, project: true, kind: "line", a: [0, 0], b: [10, 0], mid: [5, 0] };
    expect(sketchCurveAt([part], 5, 0, 0.1)).toBeNull();
  });
});

describe("Pierce on wiggly edges", () => {
  const TOPF = planeFrame(TOP);
  /** An edge along x, 100 long, waving up and down through Top `k` half-waves (k crossings). */
  const wave = (k: number) => (f: number): Vec3 => [100 * f, 0, Math.sin(f * k * Math.PI + 0.3)];

  it("finds all 9, 40 and 150 places a wave passes through, where 32 even samples missed most of the fast ones", () => {
    for (const k of [9, 40, 150]) {
      const got = edgePierces(TOPF, wave(k), pierceSamples(wave(k)));
      expect(got).toHaveLength(k);
      // Each exactly where sin(fkπ + 0.3) = 0.
      got.forEach((p, i) => expect(p[0]).toBeCloseTo((100 * ((i + 1) * Math.PI - 0.3)) / (k * Math.PI), 5));
    }
    expect(edgePierces(TOPF, wave(150), PIERCE_SAMPLES).length).toBeLessThan(150);
  });

  it("a plain curve still needs only the usual 32 samples (snap lists stay quick)", () => {
    const arc = (f: number): Vec3 => [10 * Math.cos(Math.PI * f), 0, 10 * Math.sin(Math.PI * f) - 5];
    expect(pierceSamples(arc)).toBe(PIERCE_SAMPLES);
    expect(edgePierces(TOPF, arc, pierceSamples(arc)).map((p) => p[0].toFixed(6))).toEqual([(10 * Math.cos(Math.PI / 6)).toFixed(6), (-10 * Math.cos(Math.PI / 6)).toFixed(6)]);
  });

  it("edgePierceRefs uses the adaptive count for curved edges", () => {
    const ref: EdgeRef = { kind: "edge", curve: "BSPLINE", a: wave(40)(0), b: wave(40)(1), mid: wave(40)(0.5) };
    expect(edgePierceRefs(TOPF, { partId: "p", ref }, wave(40))).toHaveLength(40);
  });
});

describe("Working… for relations that may take a while", () => {
  it("is shown for Tangent, Normal, Curvature, Equal and Concentric with a spline or ellipse, never for plain lines and circles", () => {
    const sp = addSpline(emptySketch(), [at(0, 0), at(10, 6), at(20, -2)], false);
    const l = addLine(sp.sketch, at(0, 10), at(10, 12));
    const c = addCircle(l.sketch, at(30, 30), 3);
    const s = c.sketch;
    expect(relationMayTakeAWhile(s, "tangent", [l.lineId, sp.splineId])).toBe(true);
    expect(relationMayTakeAWhile(s, "curvature", [sp.splineId, c.circleId])).toBe(true);
    expect(relationMayTakeAWhile(s, "tangent", [l.lineId, c.circleId])).toBe(false);
    expect(relationMayTakeAWhile(s, "horizontal", [sp.splineId])).toBe(false);
  });
});

void toWorld;
