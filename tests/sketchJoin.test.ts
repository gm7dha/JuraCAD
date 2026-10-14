import { describe, expect, it } from "vitest";

import { addLine, joinPoints, pointPos, pointsSharingCurve, type Placed } from "../src/sketch/ops";
import { findRegions } from "../src/sketch/regions";
import { emptySketch, type SketchLine } from "../src/sketch/types";

const at = (x: number, y: number): Placed => ({ x, y, snap: null });

describe("dragging a point onto another", () => {
  it("joins them, closing a shape", () => {
    // Three sides of a triangle, the last end left loose near the start.
    let s = emptySketch();
    const l1 = addLine(s, at(0, 0), at(10, 0));
    s = l1.sketch;
    const l2 = addLine(s, { x: 10, y: 0, snap: { kind: "point", id: l1.endId } }, at(5, 8));
    s = l2.sketch;
    const l3 = addLine(s, { x: 5, y: 8, snap: { kind: "point", id: l2.endId } }, at(0.4, 0.3));
    s = l3.sketch;
    expect(findRegions(s).regions.length).toBe(0);
    const start = (s.curves[0] as SketchLine).p1;
    const r = joinPoints(s, l3.endId, start);
    expect(r.error).toBe(undefined);
    expect(pointPos(r.sketch, l3.endId)).toEqual(pointPos(r.sketch, start));
    expect(r.sketch.constraints.some((c) => c.type === "coincident" && c.refs.includes(start) && c.refs.includes(l3.endId))).toBe(true);
    expect(findRegions(r.sketch).regions.length).toBe(1);
    // Doing it again changes nothing.
    expect(joinPoints(r.sketch, l3.endId, start).sketch.constraints.length).toBe(r.sketch.constraints.length);
  });

  it("can join a point to the origin", () => {
    const l = addLine(emptySketch(), at(1, 1), at(10, 0));
    const p1 = (l.sketch.curves[0] as SketchLine).p1;
    const r = joinPoints(l.sketch, p1, "origin");
    expect(pointPos(r.sketch, p1)).toEqual([0, 0]);
  });

  it("won't squash a line onto itself", () => {
    const l = addLine(emptySketch(), at(0, 0), at(10, 0));
    const p1 = (l.sketch.curves[0] as SketchLine).p1;
    expect(pointsSharingCurve(l.sketch, p1).has(l.endId)).toBe(true);
    expect(!!joinPoints(l.sketch, p1, l.endId).error).toBe(true);
  });
});
