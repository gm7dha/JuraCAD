import { describe, expect, it } from "vitest";

import { addLine, addRectangle, applyRelation, pointPos, type Placed } from "../src/sketch/ops";
import { readTransformSettings, transformCurves } from "../src/sketch/tools";
import { emptySketch, type SketchLine } from "../src/sketch/types";

const at = (x: number, y: number): Placed => ({ x, y, snap: null });
const r6 = (p: [number, number]) => p.map((v) => Math.round(v * 1e6) / 1e6);

describe("sketch move / copy", () => {
  it("moves shapes by a distance", () => {
    const r = addRectangle(emptySketch(), at(0, 0), at(10, 5));
    const moved = transformCurves(r.sketch, r.lineIds, { dx: 20, dy: 3, angle: 0, copy: false });
    expect(moved.error).toBe(undefined);
    const l = moved.sketch.curves[0] as SketchLine;
    expect(r6(pointPos(moved.sketch, l.p1))).toEqual([20, 3]);
    expect(moved.sketch.curves).toHaveLength(4);
  });

  it("turns about the shapes' middle, and copies", () => {
    const l = addLine(emptySketch(), at(0, 0), at(10, 0));
    const turned = transformCurves(l.sketch, [l.lineId], { dx: 0, dy: 0, angle: 90, copy: true });
    expect(turned.sketch.curves).toHaveLength(2);
    const copy = turned.sketch.curves[1] as SketchLine;
    expect(r6(pointPos(turned.sketch, copy.p1))).toEqual([5, -5]);
    expect(r6(pointPos(turned.sketch, copy.p2))).toEqual([5, 5]);
  });

  it("says when constraints hold shapes in place, and reads typed settings", () => {
    const l = addLine(emptySketch(), at(0, 0), at(10, 0));
    const fixed = applyRelation(l.sketch, "fix", [l.lineId]).sketch;
    expect(typeof transformCurves(fixed, [l.lineId], { dx: 5, dy: 0, angle: 0, copy: false }).error).toBe("string");
    expect(readTransformSettings({ moveDx: "2 * 5", moveDy: "", moveAngle: "45", moveCopy: true })).toEqual({ dx: 10, dy: 0, angle: 45, copy: true });
    expect(typeof readTransformSettings({ moveDx: "oops(", moveDy: "0", moveAngle: "0", moveCopy: false })).toBe("string");
  });
});
