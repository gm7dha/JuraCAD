import { describe, expect, it } from "vitest";

import { addCircle, addRectangle, pointPos } from "../src/sketch/ops";
import { addSlot, chainOf, copyEdge, offsetCurves } from "../src/sketch/tools";
import { findRegions } from "../src/sketch/regions";
import { emptySketch, type SketchArc, type SketchLine } from "../src/sketch/types";

const at = (x: number, y: number) => ({ x, y, snap: null });

function bounds(s: ReturnType<typeof emptySketch>, ids: string[]) {
  const pts = s.curves
    .filter((c) => ids.includes(c.id))
    .flatMap((c) => (c.type === "line" ? [c.p1, c.p2] : c.type === "arc" ? [c.start, c.end] : []))
    .map((id) => pointPos(s, id));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((v) => Math.round(v * 1e6) / 1e6);
}

describe("offset", () => {
  it("offsets a rectangle outwards and inwards, keeping it closed", () => {
    const rect = addRectangle(emptySketch(), at(0, 0), at(40, 20));
    const side = rect.sketch.curves.find((c) => c.id === rect.lineIds[0]) as SketchLine;
    expect(chainOf(rect.sketch, side).closed).toBe(true);
    expect(chainOf(rect.sketch, side).steps).toHaveLength(4);
    const out = offsetCurves(rect.sketch, rect.lineIds[0], { x: 20, y: -5 }, "2");
    expect(out.error).toBeUndefined();
    expect(bounds(out.sketch, out.curveIds)).toEqual([-2, -2, 42, 22]);
    const inside = offsetCurves(rect.sketch, rect.lineIds[0], { x: 20, y: 5 }, "2");
    expect(bounds(inside.sketch, inside.curveIds)).toEqual([2, 2, 38, 18]);
    // Each new line is parallel to its original, and the offset makes a closed shape of its own.
    expect(out.sketch.constraints.filter((c) => c.type === "parallel")).toHaveLength(4);
    expect(findRegions(out.sketch).problems).toEqual([]);
  });

  it("offsets a slot (lines and arcs) by moving the arcs' radii", () => {
    const slot = addSlot(emptySketch(), at(0, 0), at(30, 0), 5);
    const out = offsetCurves(slot.sketch, slot.curveIds[0], { x: 15, y: 9 }, "1");
    expect(out.error).toBeUndefined();
    const arcs = out.sketch.curves.filter((c): c is SketchArc => c.type === "arc" && out.curveIds.includes(c.id));
    expect(arcs).toHaveLength(2);
    for (const a of arcs) {
      const [cx, cy] = pointPos(out.sketch, a.center);
      const [sx, sy] = pointPos(out.sketch, a.start);
      expect(Math.hypot(sx - cx, sy - cy)).toBeCloseTo(6, 6);
    }
    expect(bounds(out.sketch, out.curveIds)).toEqual([0, -6, 30, 6]);
  });

  it("offsets a circle to a concentric one", () => {
    const c = addCircle(emptySketch(), at(5, 5), 10);
    const out = offsetCurves(c.sketch, c.circleId, { x: 5, y: 22 }, "3");
    const made = out.sketch.curves.find((x) => x.id === out.curveIds[0]);
    expect(made && made.type === "circle" && made.radius).toBe(13);
    expect(offsetCurves(c.sketch, c.circleId, { x: 5, y: 6 }, "20").error).toMatch(/bigger than the circle/);
  });

  it("explains bad distances", () => {
    const c = addCircle(emptySketch(), at(0, 0), 10);
    expect(offsetCurves(c.sketch, c.circleId, { x: 0, y: 20 }, "0").error).toMatch(/more than 0/);
    expect(offsetCurves(c.sketch, c.circleId, { x: 0, y: 20 }, "abc").error).toBeTruthy();
  });
});

describe("using part edges", () => {
  const top = { origin: [0, 0, 10] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number], n: [0, 0, 1] as [number, number, number] };
  const edge = (curve: string, a: number[], b: number[], mid: number[]) => ({ kind: "edge" as const, curve, a: a as [number, number, number], b: b as [number, number, number], mid: mid as [number, number, number] });

  it("copies a straight edge, fixed in place", () => {
    const r = copyEdge(emptySketch(), top, edge("LINE", [0, 0, 10], [40, 0, 10], [20, 0, 10]));
    expect(r.error).toBeUndefined();
    const line = r.sketch.curves[0] as SketchLine;
    expect([pointPos(r.sketch, line.p1), pointPos(r.sketch, line.p2)]).toEqual([
      [0, 0],
      [40, 0],
    ]);
    expect(r.sketch.constraints.filter((c) => c.type === "fix")).toHaveLength(2);
  });

  it("copies a circle and an arc", () => {
    const c = copyEdge(emptySketch(), top, edge("CIRCLE", [15, 5, 10], [15, 5, 10], [5, 5, 10]));
    const circle = c.sketch.curves[0];
    expect(circle.type === "circle" && circle.radius).toBe(5);
    expect(pointPos(c.sketch, circle.type === "circle" ? circle.center : "")).toEqual([10, 5]);
    // A quarter arc from (10, 0) round to (0, 10), passing (7.07, 7.07).
    const a = copyEdge(emptySketch(), top, edge("CIRCLE", [10, 0, 10], [0, 10, 10], [Math.SQRT1_2 * 10, Math.SQRT1_2 * 10, 10]));
    const arc = a.sketch.curves[0] as SketchArc;
    expect(pointPos(a.sketch, arc.start).map(Math.round)).toEqual([10, 0]);
    expect(pointPos(a.sketch, arc.end).map(Math.round)).toEqual([0, 10]);
    // Same arc listed the other way round still runs anticlockwise.
    const b = copyEdge(emptySketch(), top, edge("CIRCLE", [0, 10, 10], [10, 0, 10], [Math.SQRT1_2 * 10, Math.SQRT1_2 * 10, 10]));
    expect(pointPos(b.sketch, (b.sketch.curves[0] as SketchArc).start).map(Math.round)).toEqual([10, 0]);
  });

  it("refuses edges that aren't flat to the sketch", () => {
    expect(copyEdge(emptySketch(), top, edge("LINE", [0, 0, 0], [0, 0, 10], [0, 0, 5])).error).toMatch(/isn't flat/);
    expect(copyEdge(emptySketch(), top, edge("BSPLINE", [0, 0, 10], [5, 0, 10], [2, 1, 10])).error).toMatch(/Only straight edges/);
  });
});
