/**
 * The Mountain puzzle printed put together (pure): a plate per layer with every piece where it sits; or the whole
 * mountain on one plate with a breakaway layer between the layers — each layer's underside on a print layer boundary at
 * least one print layer above the layer below, the breakaway layer closed, in that gap and in each pocket over its key,
 * and written to the 3MF on its own filament.
 */
import { describe, expect, it } from "vitest";
import { weld } from "../src/geometry/threeMf";
import { gridFrom } from "../src/terrain/elevation";
import { boundaryAtOrAbove, capLoop, FIRST_LAYER, layerPlates, liftsFor, stackWithBreakaway, togetherPlate, breakawaySwaps } from "../src/terrain/mountainInPlace";
import { keyAt, makeMountainPuzzle, MOUNTAIN_DEFAULTS, pocketAt, type Body, type MountainSpec } from "../src/terrain/mountainPuzzle";
import { FILAMENT, plateFiles, platesFor } from "../src/terrain/puzzle3mf";

const W = 4000;
const H = 3000;
const hill = gridFrom({ e: 200000, n: 770000 }, W, H, 20, (e, n) => 300 + 1000 * Math.exp(-(((e - 201800) / 900) ** 2 + ((n - 771500) / 700) ** 2)) + 40 * Math.sin(e / 170));
const SPEC: MountainSpec = { ...MOUNTAIN_DEFAULTS, bed: [256, 256, 256], snowline: 1000 };
const BED: [number, number, number] = [256, 256, 256];

function closed(b: Body): { open: number; volume: number } {
  const m = weld(b.vertices, b.triangles);
  const edges = new Map<string, number>();
  let volume = 0;
  for (let t = 0; t < m.triangles.length; t += 3) {
    const ids = [m.triangles[t], m.triangles[t + 1], m.triangles[t + 2]];
    for (let k = 0; k < 3; k++) {
      const key = `${ids[k]}>${ids[(k + 1) % 3]}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    const [A, B, C] = ids.map((i) => m.vertices.slice(i * 3, i * 3 + 3));
    volume += (A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6;
  }
  let open = 0;
  for (const [key, n] of edges) {
    const [a, c] = key.split(">");
    if (n !== 1 || edges.get(`${c}>${a}`) !== 1) open++;
  }
  return { open, volume };
}

const zRange = (b: Body) => {
  let [lo, hi] = [Infinity, -Infinity];
  for (let i = 2; i < b.vertices.length; i += 3) [lo, hi] = [Math.min(lo, b.vertices[i]), Math.max(hi, b.vertices[i])];
  return [lo, hi];
};

const halfOf = (loop: [number, number][], c: [number, number]) => Math.max(...loop.map(([x, y]) => Math.max(Math.abs(x - c[0]), Math.abs(y - c[1]))));

describe("Mountain puzzle printed put together", () => {
  const puzzle = makeMountainPuzzle(hill, W, H, SPEC);
  const layers = Math.max(...puzzle.pieces.map((p) => p.layer)) + 1;

  it("prints each layer put together on a plate of its own, every layer in the same place", () => {
    expect(layers).toBeGreaterThan(2);
    const { plates, fits } = layerPlates(puzzle.pieces, BED);
    expect(fits).toBe(true);
    expect(plates.length).toBe(layers);
    expect(plates.flatMap((p) => p.pieces).length).toBe(puzzle.pieces.length);
    const moves = new Set(plates.flatMap((p) => p.pieces.map((x) => `${x.move[0].toFixed(6)},${x.move[1].toFixed(6)}`)));
    expect(moves.size).toBe(1);
    plates.forEach((plate, L) => {
      for (const { piece, move } of plate.pieces) {
        expect(piece.layer).toBe(L);
        expect(Math.min(...piece.bodies.map((b) => zRange(b)[0])) + move[2]).toBeCloseTo(0, 6);
        for (const [x, y] of piece.outline) {
          expect(x + move[0]).toBeGreaterThanOrEqual(5 - 1e-6);
          expect(y + move[1]).toBeLessThanOrEqual(BED[1] - 5 + 1e-6);
        }
      }
    });
    // Too big for the bed is said, not squeezed.
    expect(layerPlates(puzzle.pieces, [150, 150, 256]).fits).toBe(false);
  });

  it("finds print layer boundaries", () => {
    expect(boundaryAtOrAbove(0.1, 0.2)).toBeCloseTo(0.2, 9);
    expect(boundaryAtOrAbove(4.6, 0.2)).toBeCloseTo(4.6, 9);
    expect(boundaryAtOrAbove(4.61, 0.2)).toBeCloseTo(4.8, 9);
    expect(boundaryAtOrAbove(1, 0.12)).toBeCloseTo(0.2 + 7 * 0.12, 9);
  });

  for (const layer of [0.2, 0.16, 0.28]) {
    it(`lifts each layer onto a print layer boundary with room for the breakaway layer (${layer} mm layers)`, () => {
      const lifts = liftsFor(puzzle.pieces, layer);
      expect(lifts[0]).toBe(0);
      const z0 = (L: number) => Math.min(...puzzle.pieces.filter((p) => p.layer === L).map((p) => p.z0));
      for (let L = 1; L < layers; L++) {
        const under = z0(L) + lifts[L];
        const k = (under - FIRST_LAYER) / layer;
        expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
        const gap = under - (z0(L) + lifts[L - 1]);
        expect(gap).toBeGreaterThanOrEqual(layer - 1e-6);
        expect(gap).toBeLessThan(2 * layer + 1e-6);
      }
    });
  }

  it("stacks the whole mountain with a closed breakaway layer filling each gap and each pocket over its key", () => {
    const layer = 0.2;
    const stacked = stackWithBreakaway(puzzle, layer);
    const breaks = stacked.pieces.filter((p) => p.bodies.some((b) => b.part === "breakaway"));
    expect(breaks.length).toBe(layers - 1);
    expect(stacked.pieces.length).toBe(puzzle.pieces.length + layers - 1);
    for (const b of breaks) {
      const c = closed(b.bodies[0]);
      expect(c.open, b.name).toBe(0);
      expect(c.volume, b.name).toBeGreaterThan(0);
    }
    // Each lifted piece of layer L ≥ 1 starts right on top of its breakaway layer; the pieces under it end at its foot.
    for (const b of breaks) {
      const L = b.layer;
      const [lo] = zRange(b.bodies[0]);
      const upper = stacked.pieces.filter((p) => p.layer === L && p.col >= 0);
      const hi = Math.min(...upper.map((p) => p.z0));
      for (const p of upper) expect(p.z0).toBeCloseTo(hi, 9);
      for (const p of upper) expect(Math.min(...p.bodies.map((body) => zRange(body)[0]))).toBeCloseTo(p.z0, 6);
      expect(hi - lo).toBeGreaterThanOrEqual(layer - 1e-6);
      // The whole cubes below end at lo (their keys go on up into the pockets).
      const below = stacked.pieces.filter((p) => p.layer === L - 1 && p.col >= 0 && !p.top);
      for (const p of below) expect(p.z0 + p.height - (p.key ? puzzle.keys.h : 0)).toBeCloseTo(lo, 6);
    }
    expect(stacked.height).toBeGreaterThan(Math.max(...puzzle.pieces.map((p) => p.z0 + p.height)));
    expect(breakawaySwaps(stacked, layer, puzzle.keys)).toBeGreaterThan(0);
  });

  it("caps each key inside its pocket, clear of both", () => {
    const g = puzzle.keys;
    for (const p of puzzle.pieces.filter((x) => x.pocket)) {
      const k = p.pocket!;
      const cap = halfOf(capLoop(k, g), k.c);
      expect(cap).toBeLessThan(halfOf(keyAt(k, g, g.h), k.c) - 0.01);
      expect(cap).toBeLessThan(halfOf(pocketAt(k, g, g.depth), k.c) - 0.01);
      expect(cap).toBeGreaterThan(0.5);
    }
  });

  it("writes the breakaway layer on its own filament, the puzzle on the usual ones", () => {
    const stacked = stackWithBreakaway(puzzle, 0.2);
    const { plates, fits } = togetherPlate(stacked, BED);
    expect(fits).toBe(true);
    expect(plates.length).toBe(1);
    // Kept at the heights they're printed at.
    expect(plates[0].pieces.every((x) => x.move[2] === 0)).toBe(true);
    const { config } = plateFiles(plates[0], "Hill", undefined, { ...FILAMENT, breakaway: 4 });
    const breakawayObjects = config.split("<object ").filter((o) => o.includes("Breakaway layer"));
    expect(breakawayObjects.length).toBe(layers - 1);
    for (const o of breakawayObjects) expect(o).toContain('<metadata key="extruder" value="4"/>');
    expect(config).toContain('<metadata key="extruder" value="2"/>');
    // The ordinary plates are written exactly as before.
    const usual = platesFor(puzzle.pieces, BED)[0];
    expect(plateFiles(usual, "Hill").config).toBe(plateFiles(usual, "Hill", undefined, FILAMENT).config);
    expect(plateFiles(usual, "Hill").config).not.toContain('value="3"');
  });
});
