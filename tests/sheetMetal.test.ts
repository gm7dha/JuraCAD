import { describe, expect, it } from "vitest";

import { findSheetEdge, flatPattern, foldSheet, wallPoint, type Frame3, type SheetSpec, type V3 } from "../src/sheetmetal/sheet";
import type { Segment } from "../src/sketch/regions";

const close = (a: number[], b: number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const top: Frame3 = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
/** A w × h rectangle, anticlockwise from the origin: edge 0 along the bottom (y = 0), 1 the right, 2 the top, 3 the left. */
const plate = (w: number, h: number): Segment[] => [
  { kind: "line", from: [0, 0], to: [w, 0] },
  { kind: "line", from: [w, 0], to: [w, h] },
  { kind: "line", from: [w, h], to: [0, h] },
  { kind: "line", from: [0, h], to: [0, 0] },
];
const spec = (flanges: SheetSpec["flanges"], T = 2, R = 2, k = 0.5): SheetSpec => ({ thickness: T, radius: R, k, base: { frame: top, outer: plate(100, 50), holes: [] }, flanges });

function area(pts: [number, number][]) {
  let a = 0;
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  });
  return a / 2;
}

describe("sheet metal", () => {
  it("bends a flange straight up off an edge, standing as tall as its length", () => {
    const f = foldSheet(spec([{ id: "f1", wall: "base", edge: 1, length: 30, angle: 90, down: false }]));
    expect(f.errors).toEqual({});
    const wall = f.walls[1];
    // Off the right edge (x = 100): the flange's outside face is at x = 100 + R + T = 104, inside at 102.
    const T = 2;
    const corners: V3[] = [wallPoint(wall.frame, [0, 0]), wallPoint(wall.frame, [50, 26]), wallPoint(wall.frame, [0, 0], T)];
    close(corners[0], [104, 50, 4]);
    // Its tip is 30 mm up on the outside (from the base's underside), across the whole edge.
    close(corners[1], [104, 0, 30]);
    close(corners[2], [102, 50, 4]);
  });

  it("bends down too, at any angle", () => {
    const f = foldSheet(spec([{ id: "f1", wall: "base", edge: 0, length: 20, angle: 45, down: true }]));
    expect(f.errors).toEqual({});
    const tip = wallPoint(f.walls[1].frame, [0, 10]);
    // Heading out (−y) and down at 45°.
    expect(tip[1]).toBeLessThan(-5);
    expect(tip[2]).toBeLessThan(-5);
  });

  it("unfolds into one outline with the bend allowance added, and bend lines", () => {
    // Flanges up on the right and left edges: flat width = 100 + 2 × (allowance + straight).
    const T = 2;
    const R = 2;
    const k = 0.5;
    const f = foldSheet(spec([
      { id: "r", wall: "base", edge: 1, length: 30, angle: 90, down: false },
      { id: "l", wall: "base", edge: 3, length: 30, angle: 90, down: false },
    ], T, R, k));
    const flat = flatPattern(f);
    const allowance = (Math.PI / 2) * (R + k * T);
    const straight = 30 - (R + T);
    const xs = flat.outline.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(100 + 2 * (allowance + straight), 6);
    expect(area(flat.outline)).toBeCloseTo(50 * (100 + 2 * (allowance + straight)), 4);
    expect(flat.bendLines).toHaveLength(2);
    close(flat.bendLines[0][0], [100 + allowance / 2, 0]);
  });

  it("puts flanges on flanges, and finds the wall edge a picked edge lies along", () => {
    const f = foldSheet(spec([
      { id: "a", wall: "base", edge: 1, length: 30, angle: 90, down: false },
      // On the first flange's tip, bent back inwards over the base.
      { id: "b", wall: "a", edge: 2, length: 15, angle: 90, down: false },
    ]));
    expect(f.errors).toEqual({});
    expect(f.walls).toHaveLength(3);
    const flat = flatPattern(f);
    expect(flat.bendLines).toHaveLength(2);
    expect(area(flat.outline)).toBeGreaterThan(50 * 100);
    // The base's top edge along y = 50, picked on its top face.
    expect(findSheetEdge(f, 2, [10, 50, 2], [90, 50, 2])).toEqual({ wall: "base", edge: 2 });
    // The bent edge isn't offered again; a line off the sheet isn't an edge.
    expect(findSheetEdge(f, 2, [100, 10, 0], [100, 40, 0])).toBe(null);
    expect(findSheetEdge(f, 2, [10, 70, 0], [90, 70, 0])).toBe(null);
  });

  it("shortens a flange at each end, cutting a relief notch into the sheet beside each end of the bend", () => {
    const T = 2;
    const R = 2;
    const k = 0.5;
    const f = foldSheet(spec([{ id: "f", wall: "base", edge: 1, length: 30, angle: 90, down: false, inset: 10 }], T, R, k));
    expect(f.errors).toEqual({});
    // 30 wide (50 less 10 each end), starting 10 in from y = 50.
    close(wallPoint(f.walls[1].frame, [0, 0]), [104, 40, 4]);
    close(wallPoint(f.walls[1].frame, [30, 0]), [104, 10, 4]);
    expect(f.bends[0].reliefs).toHaveLength(2);
    // Flat: the plate less two 2 × 2 notches, plus the 30 wide strip and flange.
    const allowance = (Math.PI / 2) * (R + k * T);
    expect(area(flatPattern(f).outline)).toBeCloseTo(100 * 50 - 2 * T * T + 30 * (allowance + 26), 4);
    expect(foldSheet(spec([{ id: "g", wall: "base", edge: 1, length: 30, angle: 90, down: false, inset: 25 }])).errors.g).toMatch(/Shortened too much/);
  });

  it("explains flanges it can't make", () => {
    const f = foldSheet(spec([
      { id: "short", wall: "base", edge: 0, length: 3, angle: 90, down: false },
      { id: "flat", wall: "base", edge: 1, length: 30, angle: 0, down: false },
      { id: "twice", wall: "base", edge: 2, length: 30, angle: 90, down: false },
      { id: "again", wall: "base", edge: 2, length: 30, angle: 90, down: false },
      { id: "lost", wall: "nowhere", edge: 0, length: 30, angle: 90, down: false },
    ]));
    expect(Object.keys(f.errors).sort()).toEqual(["again", "flat", "lost", "short"]);
    expect(f.errors.short).toMatch(/longer than 4.01 mm/);
  });
});
