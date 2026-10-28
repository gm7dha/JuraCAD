import { describe, expect, it } from "vitest";

import { addLine, pointPos, type Placed } from "../src/sketch/ops";
import { addConic, addSpline, extendAt, offsetCurves } from "../src/sketch/tools";
import { bezierAt, cubicOn } from "../src/sketch/spline";
import { curvatureAt, curveParam, nearestParam, splinePieces } from "../src/sketch/curves";
import { solveSketch } from "../src/sketch/solver";
import { emptySketch, type SketchCurve, type SketchData, type SketchSpline } from "../src/sketch/types";

type P2 = [number, number];
const at = (x: number, y: number): Placed => ({ x, y, snap: null });
const curve = <T extends SketchCurve>(s: SketchData, id: string) => s.curves.find((c) => c.id === id) as T;
const round = (p: P2, k = 1e6) => p.map((v) => Math.round(v * k) / k);

/** A sketch with part of an ellipse (centre 0,0; 20 along X, 10 along Y) from (20, 0) anticlockwise to (0, 10), and a line at x = −10. */
function ellipseArcSketch(): SketchData {
  return {
    points: [
      { id: "c", x: 0, y: 0 },
      { id: "ma", x: 20, y: 0 },
      { id: "mi", x: 0, y: 10 },
      { id: "s", x: 20, y: 0 },
      { id: "e", x: 0, y: 10 },
      { id: "w1", x: -10, y: -50 },
      { id: "w2", x: -10, y: 50 },
    ],
    curves: [
      { id: "el", type: "ellipse", center: "c", major: "ma", minor: "mi", start: "s", end: "e", construction: false },
      { id: "wall", type: "line", p1: "w1", p2: "w2", construction: false },
    ],
    constraints: [],
  };
}

describe("cubicOn", () => {
  it("is the same piece inside 0…1 and its natural carrying-on outside", () => {
    const b: [P2, P2, P2, P2] = [
      [0, 0],
      [3, 6],
      [8, 7],
      [12, 1],
    ];
    const same = cubicOn(b, 0, 1);
    same.forEach((p, i) => expect(round(p)).toEqual(round(b[i])));
    const longer = cubicOn(b, 0, 1.5);
    for (const t of [0, 0.25, 0.5, 1, 1.5]) expect(round(bezierAt(longer, t / 1.5))).toEqual(round(bezierAt(b, t)));
    const before = cubicOn(b, -0.5, 1);
    for (const t of [-0.5, 0, 0.7, 1]) expect(round(bezierAt(before, (t + 0.5) / 1.5))).toEqual(round(bezierAt(b, t)));
  });
});

describe("Extend splines, conics and parts of ellipses", () => {
  it("carries a spline on naturally from its end to the next line, keeping its shape up to there", () => {
    const sp = addSpline(emptySketch(), [at(0, 0), at(10, 5), at(20, 0)], false);
    const wall = addLine(sp.sketch, at(25, -50), at(25, 50));
    const before = curve<SketchSpline>(wall.sketch, sp.splineId);
    const oldPath = curveParam(wall.sketch, before);
    // Where the last piece, carried on as it was curving, crosses x = 25 (by halving).
    const last = splinePieces(wall.sketch, before)[1];
    let lo = 1, hi = 3;
    for (let k = 0; k < 200; k++) {
      const mid = (lo + hi) / 2;
      if (bezierAt(last, mid)[0] < 25) lo = mid;
      else hi = mid;
    }
    const want = bezierAt(last, lo);
    const r = extendAt(wall.sketch, sp.splineId, { x: 19, y: 0 });
    expect(r.error).toBeUndefined();
    const after = curve<SketchSpline>(r.sketch, sp.splineId);
    const end = pointPos(r.sketch, after.points[2]);
    expect(end[0]).toBeCloseTo(25, 9);
    expect(end[1]).toBeCloseTo(want[1], 9);
    // This piece runs x = 10 + 10t, y = 5 − 5t² + … : at t = 1.5 it's (25, −0.625).
    expect(round(end)).toEqual([25, -0.625]);
    // Held on the line it reached.
    expect(r.sketch.constraints.some((c) => c.type === "pointOnLine" && c.refs[0] === after.points[2] && c.refs[1] === wall.lineId)).toBe(true);
    // The old curve is still exactly there…
    const newPath = curveParam(r.sketch, after);
    for (let i = 0; i <= 40; i++) {
      const q = oldPath.at((2 * i) / 40);
      const on = newPath.at(nearestParam(newPath, q));
      expect(Math.hypot(on[0] - q[0], on[1] - q[1])).toBeLessThan(1e-9);
    }
    // …and it bends smoothly through where it used to end (the same bend either side).
    const u = nearestParam(newPath, [20, 0]);
    expect(curvatureAt(newPath, u - 1e-4)).toBeCloseTo(curvatureAt(newPath, u + 1e-4), 3);
    // Still the same middle point, still three points.
    expect(after.points).toEqual(before.points);
    expect(round(pointPos(r.sketch, after.points[1]))).toEqual([10, 5]);
  });

  it("extends a spline from its start too", () => {
    const sp = addSpline(emptySketch(), [at(0, 0), at(10, 5), at(20, 0)], false);
    const wall = addLine(sp.sketch, at(-5, -50), at(-5, 50));
    const r = extendAt(wall.sketch, sp.splineId, { x: 1, y: 0 });
    expect(r.error).toBeUndefined();
    const after = curve<SketchSpline>(r.sketch, sp.splineId);
    expect(round(pointPos(r.sketch, after.points[0]))).toEqual([-5, -0.625]);
    // By symmetry, the same height as extending the other end to x = 25.
    const other = extendAt(addLine(sp.sketch, at(25, -50), at(25, 50)).sketch, sp.splineId, { x: 19, y: 0 });
    const end = pointPos(other.sketch, curve<SketchSpline>(other.sketch, sp.splineId).points[2]);
    expect(pointPos(r.sketch, after.points[0])[1]).toBeCloseTo(end[1], 9);
  });

  it("carries a conic on along its own curve: a parabola reaches y = −15 at x = 30", () => {
    // From (0, 0) towards the corner (10, 10) to (20, 0), fullness 0.5: the parabola y = x − x²/20.
    const cn = addConic(emptySketch(), at(0, 0), at(20, 0), at(10, 10), 0.5);
    expect(cn.error).toBeUndefined();
    const floor = addLine(cn.sketch, at(-100, -15), at(100, -15));
    const r = extendAt(floor.sketch, cn.conicId, { x: 19, y: 0 });
    expect(r.error).toBeUndefined();
    const c = curve<SketchSpline>(r.sketch, cn.conicId);
    expect(round(pointPos(r.sketch, c.points[2]))).toEqual([30, -15]);
    // The corner moves to where the end tangents meet (15, 15); still a parabola.
    expect(round(pointPos(r.sketch, c.points[1]))).toEqual([15, 15]);
    expect(c.conic).toBeCloseTo(0.5, 9);
    expect(round(pointPos(r.sketch, c.points[0]))).toEqual([0, 0]);
  });

  it("extends part of an ellipse round its ellipse, either way", () => {
    const s = ellipseArcSketch();
    expect(solveSketch(s).ok).toBe(true);
    const r = extendAt(s, "el", { x: 1, y: 10 });
    expect(r.error).toBeUndefined();
    // x = 20·cos t = −10 at t = 120°: y = 10·sin 120° = 5√3.
    expect(round(pointPos(r.sketch, "e"))).toEqual(round([-10, 5 * Math.sqrt(3)]));
    expect(round(pointPos(r.sketch, "s"))).toEqual([20, 0]);
    expect(r.sketch.constraints.some((c) => c.type === "pointOnLine" && c.refs[0] === "e" && c.refs[1] === "wall")).toBe(true);
    // The ellipse itself hasn't changed.
    expect(round(pointPos(r.sketch, "ma"))).toEqual([20, 0]);
    expect(round(pointPos(r.sketch, "mi"))).toEqual([0, 10]);
    // From the start: clockwise round to t = −120°.
    const back = extendAt(s, "el", { x: 20, y: 1 });
    expect(back.error).toBeUndefined();
    expect(round(pointPos(back.sketch, "s"))).toEqual(round([-10, -5 * Math.sqrt(3)]));
  });

  it("explains what it can't extend", () => {
    const whole: SketchData = { ...ellipseArcSketch(), curves: [{ id: "el", type: "ellipse", center: "c", major: "ma", minor: "mi", construction: false }] };
    expect(extendAt(whole, "el", { x: 20, y: 0 }).error).toMatch(/whole ellipse has no ends/);
    const closed = addSpline(emptySketch(), [at(0, 0), at(10, 5), at(20, 0)], true);
    expect(extendAt(closed.sketch, closed.splineId, { x: 0, y: 0 }).error).toMatch(/closed spline has no ends/);
    const alone = addSpline(emptySketch(), [at(0, 0), at(10, 5), at(20, 0)], false);
    expect(extendAt(alone.sketch, alone.splineId, { x: 19, y: 0 }).error).toMatch(/nothing ahead of that end for the spline/);
    // An offset copy follows its original, so it's the original that's extended.
    const copy = offsetCurves(alone.sketch, alone.splineId, { x: 10, y: 8 }, "1");
    expect(copy.error).toBeUndefined();
    expect(extendAt(copy.sketch, copy.curveIds[0], { x: 19, y: 6 }).error).toMatch(/offset copy/);
    // An end held in place by its constraints can't move.
    const wall = addLine(alone.sketch, at(25, -50), at(25, 50));
    const end = curve<SketchSpline>(wall.sketch, alone.splineId).points[2];
    const held: SketchData = { ...wall.sketch, constraints: [...wall.sketch.constraints, { id: "fx", type: "fix", refs: [end], extra: [20, 0] }] };
    expect(extendAt(held, alone.splineId, { x: 19, y: 0 }).error).toMatch(/held where it is/);
  });

  it("doesn't wander off: a spline curling away never reaches a line far behind it", () => {
    const sp = addSpline(emptySketch(), [at(0, 0), at(10, 5), at(20, 0)], false);
    // Straight back past its start, far beyond: the end heads down and away, so it's out of reach.
    const far = addLine(sp.sketch, at(-1000, 400), at(1000, 400));
    expect(extendAt(far.sketch, sp.splineId, { x: 19, y: 0 }).error).toMatch(/nothing ahead/);
  });
});
