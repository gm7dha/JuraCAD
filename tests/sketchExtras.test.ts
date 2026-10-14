import { describe, expect, it } from "vitest";

import { addArc, addLine, pointPos, radiusOf, type Placed } from "../src/sketch/ops";
import { findRegions } from "../src/sketch/regions";
import { solveSketch } from "../src/sketch/solver";
import { addCentreRectangle, addTangentArc, patternCurves, tangentArcCentre, tangentAt } from "../src/sketch/tools";
import { addCircle } from "../src/sketch/ops";
import { emptySketch, type SketchArc, type SketchLine } from "../src/sketch/types";

const at = (x: number, y: number): Placed => ({ x, y, snap: null });
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

describe("centre-point rectangle", () => {
  it("draws a rectangle centred on the first click, with a construction diagonal through the centre", () => {
    const r = addCentreRectangle(emptySketch(), at(5, 5), at(15, 10));
    expect(r.error).toBe(undefined);
    expect(r.lineIds.length).toBe(4);
    const s = r.sketch;
    const xs = s.points.map((p) => p.x);
    const ys = s.points.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(-5);
    expect(Math.max(...xs)).toBeCloseTo(15);
    expect(Math.min(...ys)).toBeCloseTo(0);
    expect(Math.max(...ys)).toBeCloseTo(10);
    const diag = s.curves.find((c) => c.type === "line" && c.construction) as SketchLine;
    expect(!!diag).toBe(true);
    expect(s.constraints.some((c) => c.type === "midpoint" && c.refs[1] === diag.id)).toBe(true);
    expect(findRegions(s).regions.length).toBe(1);
    expect(solveSketch(s).ok).toBe(true);
  });

  it("can be centred on the origin", () => {
    const r = addCentreRectangle(emptySketch(), { x: 0, y: 0, snap: { kind: "origin" } }, at(10, 4));
    const s = r.sketch;
    expect(s.constraints.some((c) => c.type === "midpoint" && c.refs[0] === "origin")).toBe(true);
    expect(near([Math.min(...s.points.map((p) => p.x)), Math.min(...s.points.map((p) => p.y))], [-10, -4])).toBe(true);
  });

  it("needs a width and height", () => {
    expect(!!addCentreRectangle(emptySketch(), at(0, 0), at(0, 5)).error).toBe(true);
  });
});

describe("tangent arc", () => {
  it("carries on smoothly from the end of a line", () => {
    const l = addLine(emptySketch(), at(0, 0), at(10, 0));
    let s = l.sketch;
    const t = tangentAt(s, l.endId)!;
    expect(near(t.dir, [1, 0])).toBe(true);
    // Leaving (10, 0) heading +X, ending at (10, 10): a half circle centred on (10, 5), turning left (anticlockwise).
    expect(near(tangentArcCentre([10, 0], [1, 0], [10, 10])!, [10, 5])).toBe(true);
    const r = addTangentArc(s, l.endId, at(10, 10));
    expect(r.error).toBe(undefined);
    s = r.sketch;
    const arc = s.curves.find((c) => c.id === r.arcId) as SketchArc;
    expect(arc.start).toBe(l.endId);
    expect(near(pointPos(s, arc.center), [10, 5])).toBe(true);
    expect(radiusOf(s, arc)).toBeCloseTo(5);
    expect(s.constraints.some((c) => c.type === "tangent" && c.refs.includes(r.arcId))).toBe(true);
  });

  it("turns clockwise when the end is to the right", () => {
    const l = addLine(emptySketch(), at(0, 0), at(10, 0));
    const r = addTangentArc(l.sketch, l.endId, at(10, -10));
    const arc = r.sketch.curves.find((c) => c.id === r.arcId) as SketchArc;
    // Stored anticlockwise, so it runs from the new end back to the line's end.
    expect(arc.end).toBe(l.endId);
    expect(near(pointPos(r.sketch, arc.center), [10, -5])).toBe(true);
  });

  it("can follow on from another arc", () => {
    const a = addArc(emptySketch(), at(0, 0), at(10, 0), { x: 5, y: -5 });
    let s = a.sketch;
    const arc = s.curves.find((c) => c.id === a.arcId) as SketchArc;
    // This arc dips below, running anticlockwise from (0,0) round to (10,0); at (10,0) it heads straight up.
    expect(near(tangentAt(s, arc.end)!.dir, [0, 1])).toBe(true);
    const r = addTangentArc(s, arc.end, at(20, 0));
    expect(r.error).toBe(undefined);
    s = r.sketch;
    expect(solveSketch(s).ok).toBe(true);
    const next = s.curves.find((c) => c.id === r.arcId) as SketchArc;
    expect(near(pointPos(s, next.center), [15, 0])).toBe(true);
  });

  it("explains when it can't start or bend", () => {
    const l = addLine(emptySketch(), at(0, 0), at(10, 0));
    expect(!!addTangentArc(l.sketch, "origin", at(5, 5)).error).toBe(true);
    expect(!!addTangentArc(l.sketch, l.endId, at(20, 0)).error).toBe(true);
  });
});

describe("sketch patterns", () => {
  it("repeats a circle in a row", () => {
    const c = addCircle(emptySketch(), at(0, 0), 2);
    const r = patternCurves(c.sketch, [c.circleId], { kind: "linear", count: 4, spacing: 10, angle: 0 });
    expect(r.error).toBe(undefined);
    expect(r.curveIds.length).toBe(3);
    const centres = r.sketch.curves.filter((k) => k.type === "circle").map((k) => pointPos(r.sketch, (k as { center: string }).center)[0]);
    expect(centres.map((x) => Math.round(x))).toEqual([0, 10, 20, 30]);
    expect(findRegions(r.sketch).regions.length).toBe(4);
  });

  it("goes round a centre, sharing points that sit on it", () => {
    const l = addLine(emptySketch(), { x: 0, y: 0, snap: { kind: "origin" } }, at(10, 0));
    const r = patternCurves(l.sketch, [l.lineId], { kind: "circular", count: 4, angle: 360, centre: [0, 0] });
    expect(r.curveIds.length).toBe(3);
    const ends = r.curveIds.map((id) => {
      const k = r.sketch.curves.find((c) => c.id === id) as SketchLine;
      return pointPos(r.sketch, k.p2).map((v) => Math.round(v * 1e6) / 1e6 + 0);
    });
    expect(ends).toEqual([
      [0, 10],
      [-10, 0],
      [0, -10],
    ]);
    // All copies start at the same point as the original.
    const starts = new Set(r.sketch.curves.map((c) => (c as SketchLine).p1));
    expect(starts.size).toBe(1);
  });

  it("spreads over part of a turn, first and last on the ends", () => {
    const c = addCircle(emptySketch(), at(10, 0), 1);
    const r = patternCurves(c.sketch, [c.circleId], { kind: "circular", count: 3, angle: 90, centre: [0, 0] });
    const last = r.sketch.curves[r.sketch.curves.length - 1] as { center: string };
    expect(near(pointPos(r.sketch, last.center), [0, 10])).toBe(true);
  });

  it("keeps arcs running the same way", () => {
    const a = addArc(emptySketch(), at(0, 0), at(10, 0), { x: 5, y: 5 });
    const r = patternCurves(a.sketch, [a.arcId], { kind: "linear", count: 2, spacing: 20, angle: 90 });
    const src = a.sketch.curves[0] as SketchArc;
    const copy = r.sketch.curves[1] as SketchArc;
    const sp = pointPos(a.sketch, src.start);
    expect(near(pointPos(r.sketch, copy.start), [sp[0], sp[1] + 20])).toBe(true);
  });

  it("checks its settings", () => {
    const c = addCircle(emptySketch(), at(0, 0), 2);
    expect(!!patternCurves(c.sketch, [], { kind: "linear", count: 3, spacing: 5, angle: 0 }).error).toBe(true);
    expect(!!patternCurves(c.sketch, [c.circleId], { kind: "linear", count: 1, spacing: 5, angle: 0 }).error).toBe(true);
    expect(!!patternCurves(c.sketch, [c.circleId], { kind: "linear", count: 3, spacing: 0, angle: 0 }).error).toBe(true);
  });
});
