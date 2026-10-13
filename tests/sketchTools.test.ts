import { describe, expect, it } from "vitest";

import { addCircle, addDimension, addLine, addRectangle, pointPos, radiusOf } from "../src/sketch/ops";
import { findRegions } from "../src/sketch/regions";
import { analyzeSketch, solveSketch } from "../src/sketch/solver";
import { addPolygon, addSlot, filletCorner, intersections, trimAt } from "../src/sketch/tools";
import { emptySketch, type SketchArc, type SketchLine } from "../src/sketch/types";

const at = (x: number, y: number) => ({ x, y });
const lengthOf = (s: ReturnType<typeof emptySketch>, l: SketchLine) => {
  const [a, b] = [pointPos(s, l.p1), pointPos(s, l.p2)];
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
};

describe("slot", () => {
  it("makes one closed shape that can move, stretch and widen", () => {
    const r = addSlot(emptySketch(), at(0, 0), at(30, 0), 5);
    expect(r.error).toBeUndefined();
    const regions = findRegions(r.sketch);
    expect(regions.regions).toHaveLength(1);
    // Area of a 30 mm slot, 10 mm wide.
    expect(regions.regions[0].outer.area).toBeCloseTo(30 * 10 + Math.PI * 25, 0);
    expect(analyzeSketch(r.sketch).freedom).toBe(5);
  });

  it("refuses zero size", () => {
    expect(addSlot(emptySketch(), at(0, 0), at(0, 0), 5).error).toMatch(/two different/);
    expect(addSlot(emptySketch(), at(0, 0), at(10, 0), 0).error).toMatch(/width/);
  });
});

describe("polygon", () => {
  it("makes a regular hexagon that can only move, resize and turn", () => {
    const r = addPolygon(emptySketch(), at(0, 0), at(10, 0), 6);
    expect(r.error).toBeUndefined();
    expect(r.lineIds).toHaveLength(6);
    const region = findRegions(r.sketch).regions[0];
    expect(region.outer.area).toBeCloseTo((3 * Math.sqrt(3) / 2) * 100, 3);
    expect(analyzeSketch(r.sketch).freedom).toBe(4);
  });

  it("checks the number of sides", () => {
    expect(addPolygon(emptySketch(), at(0, 0), at(10, 0), 2).error).toMatch(/3 and 64/);
  });
});

describe("rounding a corner", () => {
  it("rounds a rectangle corner, keeping its length dimension", () => {
    const rect = addRectangle(emptySketch(), at(0, 0), at(40, 20));
    let s = addDimension(rect.sketch, [rect.lineIds[0]], { x: 0, y: -5 }).sketch;
    const bottom = s.curves.find((c) => c.id === rect.lineIds[0]) as SketchLine;
    const corner = bottom.p2; // bottom-right
    const r = filletCorner(s, corner, "5");
    expect(r.error).toBeUndefined();
    s = r.sketch;
    const arc = s.curves.find((c) => c.id === r.arcId) as SketchArc;
    expect(radiusOf(s, arc)).toBeCloseTo(5, 6);
    // The bottom line now stops 5 mm short of the corner, and the width is still 40.
    expect(lengthOf(s, s.curves.find((c) => c.id === rect.lineIds[0]) as SketchLine)).toBeCloseTo(35, 6);
    expect(pointPos(s, corner)[0]).toBeCloseTo(40, 6);
    expect(solveSketch(s).ok).toBe(true);
    const area = findRegions(s).regions[0].outer.area;
    expect(area).toBeCloseTo(40 * 20 - (25 - (Math.PI * 25) / 4), 1);
  });

  it("explains corners it can't round", () => {
    const rect = addRectangle(emptySketch(), at(0, 0), at(10, 10));
    const corner = (rect.sketch.curves[0] as SketchLine).p2;
    expect(filletCorner(rect.sketch, corner, "12").error).toMatch(/too big/);
    expect(filletCorner(rect.sketch, "nope", "1").error).toMatch(/two lines/);
  });
});

describe("trim", () => {
  it("finds where lines and circles cross", () => {
    const a = addLine(emptySketch(), at(-10, 0), at(10, 0));
    const b = addCircle(a.sketch, at(0, 0), 5);
    const s = b.sketch;
    const pts = intersections(s, s.curves[0], s.curves[1]);
    expect(pts.map((p) => Math.round(p[0])).sort((a, b) => a - b)).toEqual([-5, 5]);
  });

  it("removes the middle of a line crossed by a circle, leaving two lines", () => {
    const a = addLine(emptySketch(), at(-10, 0), at(10, 0));
    const s = addCircle(a.sketch, at(0, 0), 5).sketch;
    const r = trimAt(s, a.lineId, at(0, 0));
    expect(r.error).toBeUndefined();
    const lines = r.sketch.curves.filter((c): c is SketchLine => c.type === "line");
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(lengthOf(r.sketch, l)).toBeCloseTo(5, 6);
  });

  it("turns a circle into an arc, and deletes curves nothing crosses", () => {
    const a = addLine(emptySketch(), at(-10, 0), at(10, 0));
    const c = addCircle(a.sketch, at(0, 0), 5);
    const r = trimAt(c.sketch, c.circleId, at(0, 5));
    const arc = r.sketch.curves.find((k) => k.id === c.circleId)!;
    expect(arc.type).toBe("arc");
    // The bottom half is kept.
    const [, y] = pointPos(r.sketch, (arc as SketchArc).start);
    expect(Math.abs(y)).toBeLessThan(1e-6);

    const lone = addLine(emptySketch(), at(0, 0), at(10, 0));
    expect(trimAt(lone.sketch, lone.lineId, at(5, 0)).sketch.curves).toHaveLength(0);
  });

  it("trims a crossing to make a clean corner", () => {
    // Two lines crossing like a plus sign; trimming the right arm of the horizontal leaves a T.
    const h = addLine(emptySketch(), at(-10, 0), at(10, 0));
    const v = addLine(h.sketch, at(0, -10), at(0, 10));
    const r = trimAt(v.sketch, h.lineId, at(7, 0));
    const line = r.sketch.curves.find((c) => c.id === h.lineId) as SketchLine;
    const xs = [pointPos(r.sketch, line.p1)[0], pointPos(r.sketch, line.p2)[0]].sort((p, q) => p - q);
    expect(xs[0]).toBeCloseTo(-10, 6);
    expect(xs[1]).toBeCloseTo(0, 6);
  });
});
