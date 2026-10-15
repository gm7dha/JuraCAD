import { describe, expect, it } from "vitest";

import { addCircle, addLine, addDimension, pointPos, type Placed } from "../src/sketch/ops";
import { extendAt, splitAt } from "../src/sketch/tools";
import { emptySketch, type SketchLine } from "../src/sketch/types";

const at = (x: number, y: number): Placed => ({ x, y, snap: null });
const round = (p: [number, number]) => p.map((v) => Math.round(v * 1e6) / 1e6);

describe("extend and split", () => {
  it("extends a line up to the next line or circle ahead", () => {
    const a = addLine(emptySketch(), at(0, 0), at(10, 0));
    const wall = addLine(a.sketch, at(30, -10), at(30, 10));
    const r = extendAt(wall.sketch, a.lineId, { x: 9, y: 0 });
    expect(r.error).toBe(undefined);
    const l = r.sketch.curves.find((c) => c.id === a.lineId) as SketchLine;
    expect(round(pointPos(r.sketch, l.p2))).toEqual([30, 0]);
    expect(r.sketch.constraints.some((c) => c.type === "pointOnLine" && c.refs[0] === l.p2)).toBe(true);
    // From the other end, towards a circle.
    const ring = addCircle(wall.sketch, at(-20, 0), 5);
    const back = extendAt(ring.sketch, a.lineId, { x: 1, y: 0 });
    const l2 = back.sketch.curves.find((c) => c.id === a.lineId) as SketchLine;
    expect(round(pointPos(back.sketch, l2.p1))).toEqual([-15, 0]);
    // Nothing ahead.
    expect(typeof extendAt(a.sketch, a.lineId, { x: 9, y: 0 }).error).toBe("string");
  });

  it("drops the line's length dimension when extending it", () => {
    const a = addLine(emptySketch(), at(0, 0), at(10, 0));
    const dimmed = addDimension(a.sketch, [a.lineId]);
    const wall = addLine(dimmed.sketch, at(30, -10), at(30, 10));
    const r = extendAt(wall.sketch, a.lineId, { x: 9, y: 0 });
    expect(r.sketch.constraints.some((c) => c.type === "length")).toBe(false);
  });

  it("splits a line into two that stay in line", () => {
    const a = addLine(emptySketch(), at(0, 0), at(20, 0), { horizontal: true } as never);
    const r = splitAt(a.sketch, a.lineId, { x: 8, y: 0.2 });
    expect(r.error).toBe(undefined);
    expect(r.lineIds).toHaveLength(2);
    const [l1, l2] = r.lineIds.map((id) => r.sketch.curves.find((c) => c.id === id) as SketchLine);
    expect(l1.p2).toBe(l2.p1);
    expect(round(pointPos(r.sketch, l1.p2))).toEqual([8, 0]);
    expect(r.sketch.constraints.some((c) => c.type === "parallel")).toBe(true);
    expect(typeof splitAt(a.sketch, a.lineId, { x: 0.1, y: 0 }).error).toBe("string");
  });
});
