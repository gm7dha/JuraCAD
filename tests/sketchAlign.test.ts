import { describe, expect, it } from "vitest";

import { alignWith } from "../src/sketch/hit";
import { addLine, pointPos, type Placed } from "../src/sketch/ops";
import { emptySketch, type SketchLine } from "../src/sketch/types";

const at = (x: number, y: number): Placed => ({ x, y, snap: null });

describe("lining up with earlier points", () => {
  // An L: across from (0, 0) to (40, 0), then down to (40, -20).
  const first = addLine(emptySketch(), at(5, 5), at(40, 5));
  const start = (first.sketch.curves[0] as SketchLine).p1;

  it("snaps straight below a point the pointer passed over, and level with another", () => {
    const below = alignWith(first.sketch, 5.3, -20, [start], 1);
    expect(below).toEqual({ x: 5, y: -20, alongX: start });
    const level = alignWith(first.sketch, 20, 4.6, [start], 1);
    expect(level.y).toBe(5);
    // Not near anything: no change. The origin always counts.
    expect(alignWith(first.sketch, 20, 20, [start], 1)).toEqual({ x: 20, y: 20 });
    expect(alignWith(first.sketch, 0.4, 20, [], 1)).toEqual({ x: 0, y: 20, alongX: "origin" });
  });

  it("keeps the new point lined up with a constraint", () => {
    // The next line ends straight below the first point.
    const end = (first.sketch.curves[0] as SketchLine).p2;
    const r = addLine(first.sketch, { x: 40, y: 5, snap: { kind: "point", id: end } }, { x: 5, y: -20, snap: { kind: "align", x: start } });
    expect(r.error).toBeUndefined();
    const added = r.sketch.constraints.find((c) => c.type === "vertical" && c.refs.includes(start));
    expect(added?.refs.length).toBe(2);
    expect(pointPos(r.sketch, r.endId)[0]).toBeCloseTo(5, 9);
  });
});
