/** Puzzle designs (pure): the cylinder maze box's maze — one way between any two cells, a way out, sizes. */
import { describe, expect, it } from "vitest";
import { makeMaze, mazeSizes, openNeighbours, GROOVE_DEPTH } from "../src/library/designs/mazeBox";
import { defaultValues, designGroups, findDesign } from "../src/library/insert";
import { searchDesigns } from "../src/library/browse";
import { AXIS, connected, contested, disassembly, fullStick, laidFlat, makeBurr, piecesFrom } from "../src/library/burr";
import { burrLayout, cellOutlines } from "../src/library/designs/sixPieceBurr";

describe("Cylinder maze box", () => {
  it("makes a perfect maze: every cell reached, no loops, the same maze for the same pattern", () => {
    for (const [cols, rows, seed] of [[8, 5, 1], [11, 7, 42], [3, 3, 9], [20, 12, 7]]) {
      const m = makeMaze(cols, rows, seed);
      const openings = m.right.filter(Boolean).length + m.up.filter(Boolean).length;
      expect(openings, `${cols}×${rows}`).toBe(cols * rows - 1);
      const seen = new Set([0]);
      const queue = [0];
      for (let k = 0; k < queue.length; k++) for (const j of openNeighbours(m, queue[k])) if (!seen.has(j)) (seen.add(j), queue.push(j));
      expect(seen.size).toBe(cols * rows);
      // Nothing opens upwards out of the top row.
      for (let c = 0; c < cols; c++) expect(m.up[(rows - 1) * cols + c]).toBe(false);
      expect(makeMaze(cols, rows, seed)).toEqual(m);
    }
    expect(makeMaze(8, 5, 1)).not.toEqual(makeMaze(8, 5, 2));
  });

  it("runs the way out from a bottom-row cell to the furthest top-row cell, one step at a time", () => {
    const m = makeMaze(10, 6, 3);
    expect(m.path[0]).toBe(m.home);
    expect(m.path[m.path.length - 1]).toBe(5 * 10 + m.exit);
    for (let k = 1; k < m.path.length; k++) expect(openNeighbours(m, m.path[k - 1])).toContain(m.path[k]);
    expect(m.path.length).toBeGreaterThan(10);
  });

  it("sizes the box so the nub and its chamfer fit the grooves with play", () => {
    const s = mazeSizes(defaultValues(findDesign("maze-box")!));
    expect(s.groove).toBeGreaterThan(s.nub + GROOVE_DEPTH - 2 * s.fit);
    expect(s.cols).toBeGreaterThanOrEqual(5);
    expect(s.rows).toBeGreaterThanOrEqual(4);
    expect(s.row0 + (s.rows - 1) * s.pitch + s.groove / 2).toBeLessThan(s.boxHeight);
    expect(findDesign("maze-box")!.problems({ ...defaultValues(findDesign("maze-box")!), height: 25 })).toEqual([]);
    expect(findDesign("maze-box")!.problems({ ...defaultValues(findDesign("maze-box")!), height: 25, diameter: 15 })).toEqual([]);
  });

  it("is listed first in the 3D printing tab under Puzzles, and found by searching", () => {
    expect(designGroups("print")[0]).toMatchObject({ group: "Puzzles" });
    expect(searchDesigns("maze")[0].id).toBe("maze-box");
  });
});

describe("Six-piece burr", () => {
  it("knows the sticks and where they cross", () => {
    for (let i = 0; i < 6; i++) expect(fullStick(i).length).toBe(32);
    expect(contested().length).toBe(32);
    expect(contested().filter((c) => c.by.length === 3).length).toBe(8);
    // With some cubes no stick has, the rest may still be split in two: such sets are mended before being tried.
    expect(piecesFrom(contested().map((c) => c.by[0])).every(connected)).toBe(false);
  });

  it("makes burrs that come apart at the chosen difficulty, the same for the same pattern", () => {
    for (const [d, lo, hi] of [["easy", 1, 1], ["medium", 2, 3], ["hard", 4, 99]] as const)
      for (const seed of [1, 2, 3]) {
        const b = makeBurr(seed, d);
        expect(b.level, `${d} ${seed}`).toBeGreaterThanOrEqual(lo);
        expect(b.level).toBeLessThanOrEqual(hi);
        expect(b.pieces.every(connected)).toBe(true);
        // Checked again from scratch.
        expect(disassembly(b.pieces)).toBe(b.level);
        // No cube is in two pieces.
        const all = b.pieces.flat().map((v) => v.join(","));
        expect(new Set(all).size).toBe(all.length);
      }
    expect(makeBurr(4, "medium")).toEqual(makeBurr(4, "medium"));
  });

  it("lays every piece flat with all its cubes, turned to need the fewest bridges", () => {
    const b = makeBurr(2, "hard");
    b.pieces.forEach((p, i) => {
      const l = laidFlat(p, AXIS[i]);
      expect(l.cells.length).toBe(p.length);
      for (const [a, u, w] of l.cells) expect([a >= 0 && a < 8, u === 0 || u === 1, w === 0 || w === 1]).toEqual([true, true, true]);
    });
    expect(burrLayout({ size: 20, difficulty: "hard", pattern: 2, fit: 0.2 }).laid.length).toBe(6);
  });

  it("outlines squares as loops round them", () => {
    expect(cellOutlines([[0, 0], [1, 0], [1, 1]])).toEqual([[[0, 0], [2, 0], [2, 2], [1, 2], [1, 1], [0, 1]]]);
    expect(cellOutlines([[0, 0], [3, 0]]).length).toBe(2);
    // Squares touching only at a corner stay two loops of four corners each.
    expect(cellOutlines([[0, 0], [1, 1]]).map((l) => l.length)).toEqual([4, 4]);
  });
});
