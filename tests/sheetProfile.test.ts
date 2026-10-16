import { describe, expect, it } from "vitest";

import { addArc, addLine, type Placed } from "../src/sketch/ops";
import { openChain, profileSheet } from "../src/sheetmetal/profile";
import { flatPattern, foldSheet, wallPoint, type Frame3, type P2, type SheetSpec } from "../src/sheetmetal/sheet";
import { emptySketch, type SketchData } from "../src/sketch/types";

const close = (a: number[], b: number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const top: Frame3 = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
const at = (x: number, y: number): Placed => ({ x, y, snap: null });
/** Lines drawn separately (each with its own end points, joined only by where they are). */
function lines(...segs: [number, number, number, number][]): SketchData {
  let s = emptySketch();
  for (const [a, b, c, d] of segs) s = addLine(s, at(a, b), at(c, d)).sketch;
  return s;
}
const sheet = (pts: P2[], reverse = false) => profileSheet(top, pts, { depth: 20, thickness: 2, radius: 2, k: 0.5, reverse, idPrefix: "sm" }) as SheetSpec;

describe("sheet metal from an open outline", () => {
  it("joins the lines end to end, whichever way they were drawn, and merges straight-through joins", () => {
    expect(openChain(lines([50, 0, 50, 30], [0, 0, 50, 0]))).toEqual([
      [50, 30],
      [50, 0],
      [0, 0],
    ]);
    expect(openChain(lines([0, 0, 20, 0], [20, 0, 50, 0], [50, 0, 50, 30]))).toEqual([
      [0, 0],
      [50, 0],
      [50, 30],
    ]);
  });

  it("explains outlines it can't use", () => {
    expect(openChain(lines([0, 0, 10, 0], [20, 0, 30, 0]))).toMatch(/end to end/);
    expect(openChain(lines([0, 0, 10, 0], [10, 0, 10, 10], [10, 0, 20, 0]))).toMatch(/branch/);
    expect(openChain(addArc(emptySketch(), at(0, 0), at(10, 0), at(5, 3)).sketch)).toMatch(/straight lines only/);
    expect(profileSheet(top, [[0, 0], [3, 0], [3, 30]], { depth: 20, thickness: 2, radius: 2, k: 0.5, idPrefix: "x" })).toMatch(/too short/);
  });

  it("an L turning left: a bend with the lines on its outside; the metal's face follows the lines", () => {
    const spec = sheet([[0, 0], [50, 0], [50, 30]]);
    const f = foldSheet(spec);
    expect(f.errors).toEqual({});
    expect(f.walls).toHaveLength(2);
    // The lines are the metal's face (its 0 side): the base starts at (0,0), the flange ends at (50,30), 20 deep along Z.
    close(wallPoint(f.walls[0].frame, [0, 0]), [0, 0, 0]);
    close(wallPoint(f.walls[0].frame, [20, 0]), [0, 0, 20]);
    close(wallPoint(f.walls[1].frame, [0, 26]), [50, 30, 0]);
    // The metal is on the lines' left (inside the L).
    close(wallPoint(f.walls[0].frame, [0, 0], 2), [0, 2, 0]);
    // Flat: both flats (46 and 26, less the bend's 4 mm each side of the corner) plus the bend allowance.
    const flat = flatPattern(f);
    const ys = flat.outline.map((p) => p[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(46 + 26 + (Math.PI / 2) * (2 + 0.5 * 2), 6);
  });

  it("turning right bends the other way, with the lines on the inside; Flip puts the metal on the other side", () => {
    const f = foldSheet(sheet([[0, 0], [50, 0], [50, -30]]));
    expect(f.errors).toEqual({});
    close(wallPoint(f.walls[1].frame, [0, 28]), [50, -30, 0]);
    const flipped = foldSheet(sheet([[0, 0], [50, 0], [50, 30]], true));
    expect(flipped.errors).toEqual({});
    close(wallPoint(flipped.walls[0].frame, [0, 0]), [50, 30, 0]);
  });

  it("makes a U channel with two bends", () => {
    const f = foldSheet(sheet([[0, 30], [0, 0], [40, 0], [40, 30]]));
    expect(f.errors).toEqual({});
    expect(f.walls).toHaveLength(3);
    expect(flatPattern(f).bendLines).toHaveLength(2);
    close(wallPoint(f.walls[2].frame, [0, 26]), [40, 30, 0]);
  });
});
