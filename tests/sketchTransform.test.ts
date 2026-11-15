import { describe, expect, it } from "vitest";

import { addLine, addRectangle, applyRelation, pointPos, type Placed } from "../src/sketch/ops";
import { readTransformSettings } from "../src/sketch/tools";
import { selectionCentre, transformCopy, transformSelection } from "../src/sketch/transformSelection";
import { emptySketch, type SketchLine } from "../src/sketch/types";

// The sketch panel's typed Move / copy (makeSketchTransform) runs transformSelection / transformCopy with these settings.
const at = (x: number, y: number): Placed => ({ x, y, snap: null });
const r6 = (p: [number, number]) => p.map((v) => Math.round(v * 1e6) / 1e6 + 0);

describe("sketch move / copy (typed)", () => {
  it("moves shapes by a distance", () => {
    const r = addRectangle(emptySketch(), at(0, 0), at(10, 5));
    const moved = transformSelection(r.sketch, r.lineIds, { dx: 20, dy: 3, angle: 0, scale: 1 });
    expect(moved.error).toBe(undefined);
    const l = moved.sketch.curves[0] as SketchLine;
    expect(r6(pointPos(moved.sketch, l.p1))).toEqual([20, 3]);
    expect(moved.sketch.curves).toHaveLength(4);
  });

  it("turns about the middle of the shapes' box (where the handles sit), and copies", () => {
    const l = addLine(emptySketch(), at(0, 0), at(10, 0));
    const turned = transformCopy(l.sketch, [l.lineId], { dx: 0, dy: 0, angle: 90, scale: 1 });
    expect(turned.sketch.curves).toHaveLength(2);
    const copy = turned.sketch.curves[1] as SketchLine;
    expect(r6(pointPos(turned.sketch, copy.p1))).toEqual([5, -5]);
    expect(r6(pointPos(turned.sketch, copy.p2))).toEqual([5, 5]);
    // An L of two lines: the box middle (5, 3), not the average of its three corners (6.67, 2).
    const a = addLine(emptySketch(), at(0, 0), at(10, 0));
    const b = addLine(a.sketch, { x: 10, y: 0, snap: { kind: "point", id: a.endId } }, at(10, 6));
    expect(selectionCentre(b.sketch, [a.lineId, b.lineId])).toEqual([5, 3]);
    const t = transformSelection(b.sketch, [a.lineId, b.lineId], { dx: 0, dy: 0, angle: 180, scale: 1 });
    expect(r6(pointPos(t.sketch, a.endId))).toEqual([0, 6]);
  });

  it("says when constraints hold shapes in place, and reads typed settings", () => {
    const l = addLine(emptySketch(), at(0, 0), at(10, 0));
    const fixed = applyRelation(l.sketch, "fix", [l.lineId]).sketch;
    expect(typeof transformSelection(fixed, [l.lineId], { dx: 5, dy: 0, angle: 0, scale: 1 }).error).toBe("string");
    expect(readTransformSettings({ moveDx: "2 * 5", moveDy: "", moveAngle: "45", moveCopy: true })).toEqual({ dx: 10, dy: 0, angle: 45, copy: true });
    expect(typeof readTransformSettings({ moveDx: "oops(", moveDy: "0", moveAngle: "0", moveCopy: false })).toBe("string");
  });
});
