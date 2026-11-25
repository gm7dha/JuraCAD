import { describe, expect, it } from "vitest";

import { addArc, addCircle, addDimension, addLine, pointPos, radiusOf } from "../src/sketch/ops";
import { findRegions } from "../src/sketch/regions";
import { analyzeSketch, solveSketch } from "../src/sketch/solver";
import { chamferCorner } from "../src/sketch/sketchChamfer";
import { filletBetween } from "../src/sketch/filletCurves";
import { emptySketch, type SketchArc, type SketchData, type SketchLine } from "../src/sketch/types";

const at = (x: number, y: number) => ({ x, y });
const pt = (s: SketchData, x: number, y: number) => s.points.find((p) => Math.hypot(p.x - x, p.y - y) < 1e-6)!.id;

/** A quarter-circle pie slice of radius 10 at the origin: two lines and an arc. */
function pie(): SketchData {
  let s = addLine(emptySketch(), { x: 0, y: 0, snap: { kind: "origin" } }, at(10, 0)).sketch;
  const a = pt(s, 10, 0);
  s = addLine(s, at(0, 10), { x: 0, y: 0, snap: { kind: "origin" } }).sketch;
  const b = pt(s, 0, 10);
  s = addArc(s, { x: 10, y: 0, snap: { kind: "point", id: a } }, { x: 0, y: 10, snap: { kind: "point", id: b } }, at(7.0710678, 7.0710678)).sketch;
  return solveSketch(s).sketch;
}

/** The area a chamfer d (straight from the corner) takes off where a line meets an arc at right angles, radius r. */
function cutArea(r: number, d1: number, d2: number): number {
  const turn = 2 * Math.asin(d2 / (2 * r));
  const P: [number, number] = [r, 0];
  const T1: [number, number] = [r - d1, 0];
  const T2: [number, number] = [r * Math.cos(turn), r * Math.sin(turn)];
  const tri = Math.abs((P[0] - T1[0]) * (T2[1] - T1[1]) - (P[1] - T1[1]) * (T2[0] - T1[0])) / 2;
  const segment = ((r * r) / 2) * (turn - Math.sin(turn));
  return tri + segment;
}

describe("sketch chamfer next to arcs", () => {
  it("cuts a line–arc corner exactly, the corner kept as a sharp on the line and the arc's circle", () => {
    const s = pie();
    const corner = pt(s, 10, 0);
    const before = findRegions(s).regions[0].outer.area;
    expect(before).toBeCloseTo(25 * Math.PI, 0);
    const r = chamferCorner(s, corner, { mode: "equal", distance: "2" });
    expect(r.error).toBeUndefined();
    // (Regions draw arcs as many short lines, so compare what was taken off.)
    const area = findRegions(r.sketch).regions[0].outer.area;
    expect((before - area) / cutArea(10, 2, 2)).toBeCloseTo(1, 1);
    const arc = r.sketch.curves.find((c): c is SketchArc => c.type === "arc")!;
    expect(radiusOf(r.sketch, arc)).toBeCloseTo(10, 6);
    // Both cut stretches are 2 straight across from the sharp.
    const cut = r.sketch.curves.find((c) => c.id === r.lineId) as SketchLine;
    for (const p of [cut.p1, cut.p2]) expect(Math.hypot(...(pointPos(r.sketch, p).map((v, i) => v - [10, 0][i]) as [number, number]))).toBeCloseTo(2, 6);
    expect(r.sketch.constraints.some((c) => c.type === "pointOnCircle" && c.refs[0] === corner && c.refs[1] === arc.id)).toBe(true);
  });

  it("two distances, and a fully defined sketch stays fully defined", () => {
    let s = pie();
    const line = s.curves.find((c) => c.type === "line")!;
    const arc = s.curves.find((c) => c.type === "arc")!;
    s = addDimension(s, [line.id], { x: 0, y: -3 }).sketch;
    s = addDimension(s, [arc.id], { x: 8, y: 8 }).sketch;
    // The other line upright.
    const other = s.curves.find((c) => c.type === "line" && c.id !== line.id) as SketchLine;
    s = solveSketch({ ...s, constraints: [...s.constraints, { id: "v", type: "vertical", refs: [other.id] }, { id: "h", type: "horizontal", refs: [line.id] }] }).sketch;
    const free = analyzeSketch(s).freedom;
    const r = chamferCorner(s, pt(s, 10, 0), { mode: "two", distance: "3", distance2: "1.5" });
    expect(r.error).toBeUndefined();
    expect(analyzeSketch(r.sketch).freedom).toBe(free);
    expect((findRegions(s).regions[0].outer.area - findRegions(r.sketch).regions[0].outer.area) / cutArea(10, 3, 1.5)).toBeCloseTo(1, 1);
  });

  it("refuses distance + angle next to an arc, and a chamfer longer than the arc", () => {
    const s = pie();
    expect(chamferCorner(s, pt(s, 10, 0), { mode: "angle", distance: "2", angle: "45" }).error).toMatch(/two straight lines/);
    expect(chamferCorner(s, pt(s, 10, 0), { mode: "equal", distance: "9.5" }).error).toBeUndefined();
    expect(chamferCorner(s, pt(s, 10, 0), { mode: "equal", distance: "15" }).error).toMatch(/too big/);
  });

  it("cuts an arc–arc corner", () => {
    // Two arcs meeting at (10, 0): a lens.
    let s = addArc(emptySketch(), at(-10, 0), at(10, 0), at(0, -6)).sketch;
    const a = pt(s, -10, 0);
    const b = pt(s, 10, 0);
    s = addArc(s, { x: 10, y: 0, snap: { kind: "point", id: b } }, { x: -10, y: 0, snap: { kind: "point", id: a } }, at(0, 6)).sketch;
    s = solveSketch(s).sketch;
    const before = findRegions(s).regions[0].outer.area;
    const r = chamferCorner(s, b, { mode: "equal", distance: "2" });
    expect(r.error).toBeUndefined();
    const after = findRegions(r.sketch).regions[0].outer.area;
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(before - 4);
    for (const arc of r.sketch.curves.filter((c): c is SketchArc => c.type === "arc")) expect(radiusOf(r.sketch, arc)).toBeCloseTo(radiusOf(s, s.curves.find((c) => c.id === arc.id) as SketchArc), 6);
  });
});

describe("round with circles", () => {
  it("between a line and a circle it crosses: the circle becomes an arc from the round round to the other crossing", () => {
    let s = addCircle(emptySketch(), { x: 0, y: 0, snap: { kind: "origin" } }, 10).sketch;
    s = addLine(s, at(-20, 5), at(20, 5)).sketch;
    const circle = s.curves.find((c) => c.type === "circle")!;
    const line = s.curves.find((c) => c.type === "line")!;
    // Keep the circle below the line and the line out to the right.
    const r = filletBetween(s, circle.id, [0, -10], line.id, [18, 5], "2");
    expect(r.error).toBeUndefined();
    const was = r.sketch.curves.find((c) => c.id === circle.id)!;
    expect(was.type).toBe("arc");
    const arc = was as SketchArc;
    expect(radiusOf(r.sketch, arc)).toBeCloseTo(10, 6);
    // One end where the round touches it, the other where the line crosses it on the left (-√75, 5).
    const ends = [arc.start, arc.end].map((p) => pointPos(r.sketch, p));
    expect(ends.some(([x, y]) => Math.abs(x + Math.sqrt(75)) < 1e-6 && Math.abs(y - 5) < 1e-6)).toBe(true);
    const round = r.sketch.curves.find((c) => c.id === r.arcId) as SketchArc;
    expect(radiusOf(r.sketch, round)).toBeCloseTo(2, 6);
    // The round touches the circle from outside (centres 12 apart) and the line from below, in the corner on the right.
    const c = pointPos(r.sketch, round.center);
    expect(Math.hypot(...c)).toBeCloseTo(12, 6);
    expect(c[1]).toBeCloseTo(3, 6);
    expect(c[0]).toBeGreaterThan(0);
    expect(solveSketch(r.sketch).ok).toBe(true);
  });

  it("between two circles that don't cross: both stay whole, the round touching each", () => {
    let s = addCircle(emptySketch(), at(0, 0), 5).sketch;
    s = addCircle(s, at(20, 0), 5).sketch;
    const [a, b] = s.curves.map((c) => c.id);
    const r = filletBetween(s, a, [0, 5], b, [20, 5], "6");
    expect(r.error).toBeUndefined();
    expect(r.sketch.curves.filter((c) => c.type === "circle")).toHaveLength(2);
    const round = r.sketch.curves.find((c) => c.id === r.arcId) as SketchArc;
    const c = pointPos(r.sketch, round.center);
    expect(Math.hypot(c[0], c[1])).toBeCloseTo(11, 6);
    expect(Math.hypot(c[0] - 20, c[1])).toBeCloseTo(11, 6);
    for (const p of [round.start, round.end]) {
      const q = pointPos(r.sketch, p);
      expect(Math.min(Math.abs(Math.hypot(q[0], q[1]) - 5), Math.abs(Math.hypot(q[0] - 20, q[1]) - 5))).toBeLessThan(1e-6);
    }
    expect(solveSketch(r.sketch).ok).toBe(true);
  });

  it("between an arc and a circle that cross", () => {
    let s = addCircle(emptySketch(), at(0, 0), 10).sketch;
    s = addArc(s, at(5, -15), at(5, 15), at(-3, 0)).sketch;
    const circle = s.curves.find((c) => c.type === "circle")!;
    const arc = s.curves.find((c) => c.type === "arc")!;
    const r = filletBetween(s, circle.id, [10, 0], arc.id, [5, 14], "1");
    expect(r.error).toBeUndefined();
    expect(r.sketch.curves.find((c) => c.id === circle.id)?.type).toBe("arc");
    expect(solveSketch(r.sketch).ok).toBe(true);
  });
});
