import { describe, expect, it } from "vitest";

import { addLine, pointPos, radiusOf, type Placed } from "../src/sketch/ops";
import { findRegions } from "../src/sketch/regions";
import { addAlignedRectangle, addCentreArc, addThreePointCircle } from "../src/sketch/tools";
import { emptySketch, type SketchArc, type SketchCircle, type SketchLine } from "../src/sketch/types";

const at = (x: number, y: number): Placed => ({ x, y, snap: null });

describe("more sketch tools", () => {
  it("3-point circle passes through the clicks, and holds clicked points on it", () => {
    const r = addThreePointCircle(emptySketch(), at(10, 0), at(0, 10), at(-10, 0));
    expect(r.error).toBe(undefined);
    const c = r.sketch.curves[0] as SketchCircle;
    expect(radiusOf(r.sketch, c)).toBeCloseTo(10, 6);
    expect(pointPos(r.sketch, c.center).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0]);
    expect(!!addThreePointCircle(emptySketch(), at(0, 0), at(1, 1), at(2, 2)).error).toBe(true);
    // Through the end of a line: the end stays on the circle.
    const l = addLine(emptySketch(), at(20, 0), at(30, 0));
    const p = { x: 30, y: 0, snap: { kind: "point" as const, id: l.endId } };
    const on = addThreePointCircle(l.sketch, p, at(20, 10), at(10, 0));
    expect(on.sketch.constraints.some((k) => k.type === "pointOnCircle" && k.refs[0] === l.endId)).toBe(true);
  });

  it("centre-point arc goes the short way round from the start", () => {
    const r = addCentreArc(emptySketch(), at(0, 0), at(10, 0), at(0, 5));
    expect(r.error).toBe(undefined);
    const arc = r.sketch.curves[0] as SketchArc;
    expect(radiusOf(r.sketch, arc)).toBeCloseTo(10, 6);
    const [sx, sy] = pointPos(r.sketch, arc.start);
    const [ex, ey] = pointPos(r.sketch, arc.end);
    // Anticlockwise from (10, 0) to (0, 10): a quarter.
    expect([sx, sy, ex, ey].map((v) => Math.round(v * 1e4) / 1e4)).toEqual([10, 0, 0, 10]);
    // The other way: clockwise, stored the other way round.
    const back = addCentreArc(emptySketch(), at(0, 0), at(10, 0), at(0, -5));
    const b = back.sketch.curves[0] as SketchArc;
    expect(pointPos(back.sketch, b.start).map((v) => Math.round(v * 1e4) / 1e4)).toEqual([0, -10]);
  });

  it("aligned rectangle sits at any angle and stays square", () => {
    const r = addAlignedRectangle(emptySketch(), at(0, 0), at(30, 40), [-8, 6]);
    expect(r.error).toBe(undefined);
    expect(r.lineIds).toHaveLength(4);
    const lines = r.sketch.curves as SketchLine[];
    const length = (l: SketchLine) => Math.hypot(...pointPos(r.sketch, l.p2).map((v, i) => v - pointPos(r.sketch, l.p1)[i]));
    expect(length(lines[0])).toBeCloseTo(50, 6);
    expect(length(lines[1])).toBeCloseTo(10, 6);
    expect(findRegions(r.sketch).regions[0].outer.area).toBeCloseTo(500, 4);
    expect(r.sketch.constraints.map((c) => c.type).sort()).toEqual(["parallel", "parallel", "perpendicular"]);
  });
});
