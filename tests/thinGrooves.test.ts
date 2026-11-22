/**
 * Thin map lines (tidy hill routes and trunk roads, 0.6 mm wide) are deep enough on the printed pieces wherever they
 * fall against the mesh's points — once half-way between two was the worst place; now the pieces are cut along the
 * channels (grooveCut.ts) — on both the Island and Mountain puzzles.
 */
import { describe, expect, it } from "vitest";
import { gridFrom, heightAt } from "../src/terrain/elevation";
import { THIN_GROOVE } from "../src/terrain/groundMarks";
import { ISLAND_DEFAULTS, makeIslandPuzzle, type IslandSpec } from "../src/terrain/islandPuzzle";
import { weld } from "../src/geometry/threeMf";
import { baseFor, makeMountainPuzzle, MOUNTAIN_DEFAULTS, type Body, type PuzzlePiece } from "../src/terrain/mountainPuzzle";
import type { MapFeatures } from "../src/terrain/osm";
import { TopIndex } from "./support/lineQuality";

type XY = [number, number];

/** The mesh's depth below `plain` on the upright line x = x0, every 0.05 mm up it: (y, depth). */
function deepestNear(pieces: PuzzlePiece[], x0: number, _reach: number, plain: (x: number, y: number) => number, keep: (p: PuzzlePiece) => boolean): Map<number, number> {
  const index = new TopIndex(pieces.filter(keep).flatMap((p) => p.bodies));
  const rows = new Map<number, number>();
  for (let y = 0; y < 300; y += 0.05) {
    const h = index.at(x0, y);
    if (h) rows.set(Math.round(y * 100), plain(x0, y) - h.z);
  }
  return rows;
}

describe("Thin grooves at their worst offset", () => {
  it("are nearly their full depth on an island at its coarsest cell", () => {
    const sw = { e: 200500, n: 770000 };
    const [W, H] = [5000, 4000];
    const island = gridFrom(sw, W, H, 25, (e, n) => Math.max(0, (1 - Math.hypot((e - 203000) / 2300, (n - 771900) / 1600)) * 300));
    // A big bed, so the cell is as coarse as thin lines allow.
    const spec: IslandSpec = { ...ISLAND_DEFAULTS, bed: [410, 330, 180], piece: 80 };
    const plainPuzzle = makeIslandPuzzle(island, sw, W, H, spec);
    const k = plainPuzzle.k;
    const cell = 0.6;
    // Half-way between two columns of the mesh's points at the coarsest cell ((i + ½) · cell): on a whole number of cells.
    const x0 = Math.round(195 / cell) * cell;
    const line: XY[] = [80, 150, 220].map((y) => [sw.e + x0 / k, sw.n + y / k]);
    const f: MapFeatures = { lines: [{ kind: "path", pts: line, thin: true }], shapes: [], names: [] };
    const p = makeIslandPuzzle(island, sw, W, H, spec, undefined, f);
    const plain = (x: number, y: number) => spec.base + Math.max(0, heightAt(island, sw.e + x / k, sw.n + y / k)) * (spec.relief / Math.max(p.high, 1));
    const rows = deepestNear(p.pieces, x0, cell, plain, () => true);
    let checked = 0;
    for (const [key, d] of rows) {
      const y = key / 100;
      if (y < 85 || y > 215) continue;
      // Where the ground's own groove is full depth (not faded over a dovetail's neck).
      const want = plain(x0, y) - p.groundAt(x0, y);
      if (want < THIN_GROOVE.depth * 0.95) continue;
      expect(d, `y ${y}`).toBeGreaterThan(THIN_GROOVE.depth * 0.97);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("are nearly their full depth on a mountain's top pieces, wherever they fall", () => {
    const sw = { e: 201000, n: 770500 };
    const hill = gridFrom(sw, 4000, 3000, 20, (e, n) => 300 + 700 * Math.exp(-(((e - 202800) / 900) ** 2 + ((n - 771500) / 700) ** 2)));
    const spec = { ...MOUNTAIN_DEFAULTS, bed: [256, 256, 256] as [number, number, number], snowline: null };
    const plainPuzzle = makeMountainPuzzle(hill, 4000, 3000, spec);
    const L = plainPuzzle.layout;
    const base = baseFor(spec);
    const plain = (x: number, y: number) => base + (heightAt(hill, L.e0 + x / L.k, L.n0 + y / L.k) - L.low) * L.k * spec.exaggeration;
    for (const shift of [0, 0.06, 0.125, 0.19]) {
      // Through the middle of the second column of cubes, shifted against the samples.
      const x0 = 1.5 * spec.cube + shift;
      const line: XY[] = [10, 60, 110].map((y) => [L.e0 + x0 / L.k, L.n0 + y / L.k]);
      const f: MapFeatures = { lines: [{ kind: "path", pts: line, thin: true }], shapes: [], names: [] };
      const p = makeMountainPuzzle(hill, 4000, 3000, spec, f);
      const rows = deepestNear(p.pieces, x0, 0.3, plain, (q) => q.top);
      let checked = 0;
      for (const [key, d] of rows) {
        const y = key / 100;
        // Away from the pieces' sides (where outlines and fits bend things).
        const inCube = y - Math.floor(y / spec.cube) * spec.cube;
        if (y < 15 || y > 105 || inCube < 2 || inCube > spec.cube - 2) continue;
        expect(d, `shift ${shift}, y ${y}`).toBeGreaterThan(THIN_GROOVE.depth * 0.97);
        checked++;
      }
      expect(checked, `shift ${shift}`).toBeGreaterThan(100);
    }
  });

  it("cuts only the mountain's top pieces a thin line passes, each still closed", () => {
    const sw = { e: 201000, n: 770500 };
    const hill = gridFrom(sw, 4000, 3000, 20, (e, n) => 300 + 700 * Math.exp(-(((e - 202800) / 900) ** 2 + ((n - 771500) / 700) ** 2)));
    const spec = { ...MOUNTAIN_DEFAULTS, bed: [256, 256, 256] as [number, number, number], snowline: 800 };
    const plainPuzzle = makeMountainPuzzle(hill, 4000, 3000, spec);
    const L = plainPuzzle.layout;
    // Up the middle of the second column, through its first three or four squares.
    const x0 = 1.5 * spec.cube;
    const line: XY[] = [10, 60, 110].map((y) => [L.e0 + x0 / L.k, L.n0 + y / L.k]);
    const thin = makeMountainPuzzle(hill, 4000, 3000, spec, { lines: [{ kind: "path", pts: line, thin: true }], shapes: [], names: [] });
    const count = (p: PuzzlePiece) => p.bodies.reduce((a, b) => a + b.triangles.length / 3, 0);
    let cut = 0;
    thin.pieces.forEach((p, i) => {
      const q = plainPuzzle.pieces[i];
      expect(q.name).toBe(p.name);
      if (!p.top || p.col !== 1) expect(count(p), p.name).toBe(count(q));
      else if (count(p) !== count(q)) cut++;
      for (const b of p.bodies) expect(openEdges(b), `${p.name} ${b.part}`).toBe(0);
    });
    expect(cut).toBeGreaterThanOrEqual(3);
    expect(cut).toBeLessThanOrEqual(5);
    // Far fewer triangles than sampling every top piece finely would make.
    const total = (pz: typeof thin) => pz.pieces.reduce((a, p) => a + count(p), 0);
    expect(total(thin)).toBeLessThan(total(plainPuzzle) * 1.5);
  });
});

function openEdges(b: Body): number {
  const m = weld(b.vertices, b.triangles);
  const edges = new Map<string, number>();
  for (let t = 0; t < m.triangles.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const key = `${m.triangles[t + k]}>${m.triangles[t + ((k + 1) % 3)]}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  let open = 0;
  for (const [key, n] of edges) {
    const [a, c] = key.split(">");
    if (n !== 1 || edges.get(`${c}>${a}`) !== 1) open++;
  }
  return open;
}
