/** Photo relief puzzle (pure): a picture's brightness as heights, the right way up and the asked-for relief in mm. */
import { describe, expect, it } from "vitest";
import { MOUNTAIN_DEFAULTS, makeMountainPuzzle, layoutFor, type MountainSpec } from "../src/terrain/mountainPuzzle";
import { blurred, greyFromRgba, photoGrid, photoReadSize } from "../src/terrain/photoRelief";
import { searchTools, toolsIn } from "../src/library/tools";

/** A 120 × 90 picture: black, with a white disc in the top-left quarter. */
function picture() {
  const [w, h] = [120, 90];
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const on = (x - 30) ** 2 + (y - 22) ** 2 < 15 ** 2;
      rgba.set([on ? 255 : 0, on ? 255 : 0, on ? 255 : 0, 255], (y * w + x) * 4);
    }
  return greyFromRgba(rgba, w, h);
}
const SPEC: MountainSpec = { ...MOUNTAIN_DEFAULTS, bed: [256, 256, 256], snowline: null, exaggeration: 1 };

describe("Photo relief", () => {
  it("reads brightness (see-through as white) and keeps pictures small", () => {
    const g = greyFromRgba(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 0]), 3, 1);
    expect([...g.grey].map((v) => +v.toFixed(3))).toEqual([1, 0, 1]);
    expect(photoReadSize(4000, 3000)).toEqual([400, 300]);
    expect(photoReadSize(100, 50)).toEqual([100, 50]);
  });

  it("makes light parts high, the picture's top to the north, with the asked-for relief", () => {
    const p = picture();
    const grid = photoGrid(p, SPEC, 20);
    const k = layoutFor(grid, p.width - 1, p.height - 1, SPEC).k;
    // The disc is near the picture's top, so near the grid's north edge.
    expect(grid.h[(p.height - 1 - 22) * p.width + 30] * k).toBeCloseTo(20, 4);
    expect(grid.h[(p.height - 1 - 70) * p.width + 90]).toBe(0);
    const inv = photoGrid(p, SPEC, 20, true);
    expect(inv.h[(p.height - 1 - 22) * p.width + 30]).toBe(0);
    // Blurring softens the disc's edge but keeps its middle.
    const soft = blurred(p, 2);
    expect(soft.grey[22 * p.width + 30]).toBeCloseTo(1, 6);
    expect(soft.grey[22 * p.width + 15]).toBeGreaterThan(0);
    expect(soft.grey[22 * p.width + 15]).toBeLessThan(1);
  });

  it("makes a puzzle whose top stands the relief above the lowest ground", () => {
    const p = picture();
    const puzzle = makeMountainPuzzle(photoGrid(blurred(p, 1), SPEC, 20), p.width - 1, p.height - 1, SPEC);
    let [lo, hi] = [Infinity, -Infinity];
    for (const q of puzzle.pieces) if (q.top) for (const b of q.bodies) for (let i = 2; i < b.vertices.length; i += 3) if (b.vertices[i] > q.z0 + puzzle.keys.depth + 0.01) [lo, hi] = [Math.min(lo, b.vertices[i]), Math.max(hi, b.vertices[i])];
    expect(hi - lo).toBeGreaterThan(19);
    expect(hi - lo).toBeLessThan(20.5);
  });

  it("has its own card in the library, under Puzzles", () => {
    expect(toolsIn("print").map((t) => t.id)).toEqual(["mountain", "photo"]);
    expect(searchTools("lithophane").map((t) => t.id)).toEqual(["photo"]);
    expect(searchTools("puzzle").map((t) => t.id)).toEqual(["mountain", "photo"]);
  });
});
