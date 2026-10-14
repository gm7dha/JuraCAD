import { describe, expect, it } from "vitest";

import { addCircle, addLine, addPoint, type Placed } from "../src/sketch/ops";
import { emptySketch } from "../src/sketch/types";
import { rectOf, segmentHitsRect, shapeInBox, sketchItemsInBox } from "../src/viewport/boxSelect";

const at = (x: number, y: number): Placed => ({ x, y, snap: null });

describe("box select", () => {
  const box = rectOf(10, 10, 0, 0);

  it("works out the box whichever way it was dragged", () => {
    expect(box).toEqual({ x0: 0, y0: 0, x1: 10, y1: 10 });
  });

  it("finds pieces passing through the box", () => {
    expect(segmentHitsRect(box, -5, 5, 15, 5)).toBe(true); // straight across
    expect(segmentHitsRect(box, -5, -5, -1, 20)).toBe(false); // off to the left
    expect(segmentHitsRect(box, -5, 12, 12, -5)).toBe(true); // clips a corner
    expect(segmentHitsRect(box, -5, 30, 30, -5)).toBe(false); // misses the corner
  });

  it("window needs all of it inside; crossing just a touch", () => {
    const inside = [2, 2, 8, 8];
    const across = [5, 5, 20, 5];
    const past = [-5, 5, 15, 5];
    expect(shapeInBox(box, inside, inside, false)).toBe(true);
    expect(shapeInBox(box, across, across, false)).toBe(false);
    expect(shapeInBox(box, across, across, true)).toBe(true);
    // Both ends outside, but the line goes through.
    expect(shapeInBox(box, past, past, true)).toBe(true);
  });

  it("picks sketch lines, circles and loose points", () => {
    let s = emptySketch();
    const l1 = addLine(s, at(1, 1), at(4, 1));
    s = l1.sketch;
    const l2 = addLine(s, at(5, 5), at(30, 5));
    s = l2.sketch;
    const c = addCircle(s, at(50, 50), 3);
    s = c.sketch;
    const p = addPoint(s, at(7, 7));
    s = p.sketch;
    expect(sketchItemsInBox(s, box, false).sort()).toEqual([l1.lineId, p.pointId].sort());
    expect(sketchItemsInBox(s, box, true).sort()).toEqual([l1.lineId, l2.lineId, p.pointId].sort());
    expect(sketchItemsInBox(s, rectOf(46, 46, 54, 54), false)).toEqual([c.circleId]);
    // A box inside the circle, not touching its edge, doesn't take it.
    expect(sketchItemsInBox(s, rectOf(49, 49, 51, 51), true)).toEqual([]);
  });
});
