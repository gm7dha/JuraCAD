/**
 * Lochs as two layers of water where the mesh is awkward (pure; its own file for memory): the biggest loch of the 40 mm
 * puzzles touches itself at single corners (a narrow neck), and a ragged coast's band edge grazes an upright wall — both
 * used to fall back to paint. Each now gets a closed slab two layers thick, every part closed, the volumes adding up.
 * "Closed" is strict: every edge used once each way (meshCheck would let an edge used twice each way cancel out).
 */
import { describe, expect, it } from "vitest";
import { bandParts, filaments, GROUND_BROWN, islandBands, mapOnPuzzle, mapRaster, meshCheck, NO_MAP, SEA_BLUE, type ColourSpec } from "../src/terrain/colour";
import { gridFrom } from "../src/terrain/elevation";
import { lochLayers } from "../src/terrain/groundMarks";
import { featuresForIsland, ISLAND_DEFAULTS, makeIslandPuzzle, type IslandSpec } from "../src/terrain/islandPuzzle";
import type { MapFeatures } from "../src/terrain/osm";

type XY = [number, number];
const BED: [number, number, number] = [256, 256, 256];
const sw = { e: 300000, n: 700000 };
const [W, H] = [6000, 4000];
function loch(e: number, n: number, re: number, rn: number, wob = 0.12, ph = 0): XY[] {
  return Array.from({ length: 60 }, (_, i) => {
    const a = (i / 60) * 2 * Math.PI;
    const w = 1 + wob * Math.sin(3 * a + ph) + 0.05 * Math.sin(7 * a);
    return [e + re * w * Math.cos(a), n + rn * w * Math.sin(a)] as XY;
  });
}
const grids = {
  lumpy: gridFrom(sw, W, H, 25, (e, n) => {
    const [x, y] = [(e - sw.e) / W - 0.5, (n - sw.n) / H - 0.5];
    const r = Math.hypot(x / 0.42, y / 0.4) + 0.15 * Math.sin(Math.atan2(y, x) * 3);
    return Math.max(0, (1 - r) * 400 + 60 * Math.sin(e / 300) * (1 - r));
  }),
  ragged: gridFrom(sw, W, H, 25, (e, n) => {
    const [x, y] = [(e - sw.e) / W - 0.5, (n - sw.n) / H - 0.5];
    const a = Math.atan2(y, x);
    return Math.max(0, (1 - (Math.hypot(x / 0.42, y / 0.4) + 0.12 * Math.sin(a * 7) + 0.08 * Math.sin(a * 13 + 1) + 0.05 * Math.sin(e / 90) * Math.cos(n / 110))) * 300);
  }),
  low: gridFrom(sw, W, H, 25, (e, n) => {
    const [x, y] = [(e - sw.e) / W - 0.5, (n - sw.n) / H - 0.5];
    const a = Math.atan2(y, x);
    return Math.max(0, (1 - (Math.hypot(x / 0.42, y / 0.4) + 0.12 * Math.sin(a * 9) + 0.07 * Math.sin(a * 23 + 1) + 0.04 * Math.sin(e / 70) * Math.cos(n / 80))) * 25);
  }),
};
const lochs: XY[][][] = [
  [loch(302400, 702100, 700, 420)],
  [loch(299600, 701300, 380, 300, 0.2, 1), loch(299620, 701300, 90, 70, 0, 0).reverse()],
  [loch(301000, 699000, 120, 90)],
  [loch(298500, 702900, 160, 110, 0.3, 2)],
  [loch(302400, 698500, 260, 160)],
  [loch(302400, 701000, 200, 300)],
];
const features: MapFeatures = { lines: [], shapes: lochs.map((rings) => ({ kind: "water" as const, rings })), names: [] };
import { createHash } from "node:crypto";
import { closedMesh, WATER_LAYERS } from "../src/terrain/waterPart";

function check(grid: keyof typeof grids, piece: number, seed: number, name: string, layer = 0.2) {
  const spec: IslandSpec = { ...ISLAND_DEFAULTS, bed: BED, piece, seed, ...lochLayers(true, { layer }, features) };
  const wet = makeIslandPuzzle(grids[grid], sw, W, H, spec, undefined, features);
  const map = mapRaster(mapOnPuzzle(featuresForIsland(features, wet.k).features, wet.origin.e, wet.origin.n, wet.k), wet.width, wet.height);
  const scale = { z0: spec.base, h0: 0, mmPerM: spec.relief / Math.max(wet.high, 1) };
  const cspec: ColourSpec = { mode: "bands", bands: islandBands(wet.high), base: GROUND_BROWN, water: SEA_BLUE, layer };
  const waterN = filaments(cspec, map).find((f) => f.colour === SEA_BLUE.toLowerCase())!.n;
  const p = wet.pieces.find((q) => q.name === name)!;
  const parts = bandParts(p.bodies, p.z0, { spec: cspec, scale, map });
  const whole = meshCheck(p.bodies[0].vertices, p.bodies[0].triangles).volume;
  let sum = 0;
  for (const q of parts) {
    const c = meshCheck(q.vertices, q.triangles);
    expect(closedMesh(q), `${grid} ${piece} piece ${name} filament ${q.filament}`).toBe(true);
    sum += c.volume;
  }
  expect(Math.abs(sum - whole) / whole).toBeLessThan(1e-8);
  const water = parts.filter((q) => q.filament === waterN && !q.paint);
  expect(water.length, `${grid} ${piece} piece ${name}: a slab`).toBeGreaterThan(0);
  for (const q of water) expect(q.high - q.low).toBeCloseTo(WATER_LAYERS * layer, 9);
  return water.reduce((s, q) => s + meshCheck(q.vertices, q.triangles).volume, 0);
}

describe("water slabs on awkward lochs", () => {
  it("the 40 mm puzzles' biggest loch (it touches itself at single corners) is two layers of water", () => {
    // About 1160 mm² of water, 0.4 thick.
    expect(check("lumpy", 40, 1, "6")).toBeGreaterThan(1100 * 0.4);
    expect(check("ragged", 40, 1, "7")).toBeGreaterThan(1100 * 0.4);
  });
  it("a band edge grazing an upright wall leaves every band closed (ragged coast, 15 mm, piece 28)", () => {
    check("ragged", 15, 1, "28");
  });
  it("a cap whose hole joins through a corner exactly: no folded triangles, with or without the map (low coast, 15 mm, piece 43)", () => {
    for (const layer of [0.2, 0.12]) check("low", 15, 1, "43", layer);
    const spec: IslandSpec = { ...ISLAND_DEFAULTS, bed: BED, piece: 15, seed: 1 };
    const isl = makeIslandPuzzle(grids.low, sw, W, H, spec);
    const p = isl.pieces.find((q) => q.name === "43")!;
    const scale = { z0: spec.base, h0: 0, mmPerM: spec.relief / Math.max(isl.high, 1) };
    for (const layer of [0.2, 0.12]) {
      const cspec: ColourSpec = { mode: "bands", bands: islandBands(isl.high), base: GROUND_BROWN, water: SEA_BLUE, layer };
      for (const q of bandParts(p.bodies, p.z0, { spec: cspec, scale, map: mapRaster(NO_MAP, isl.width, isl.height) })) expect(closedMesh(q), `filament ${q.filament}`).toBe(true);
    }
  });
  it("colour bands with no water come out byte for byte as before (low coast, 25 mm)", () => {
    const spec: IslandSpec = { ...ISLAND_DEFAULTS, bed: BED, piece: 25, seed: 1 };
    const isl = makeIslandPuzzle(grids.low, sw, W, H, spec);
    const scale = { z0: spec.base, h0: 0, mmPerM: spec.relief / Math.max(isl.high, 1) };
    const hashes = [0.2, 0.12].map((layer) => {
      const cspec: ColourSpec = { mode: "bands", bands: islandBands(isl.high), base: GROUND_BROWN, water: SEA_BLUE, layer };
      const map = mapRaster(NO_MAP, isl.width, isl.height);
      const parts = isl.pieces.map((p) => bandParts(p.bodies, p.z0, { spec: cspec, scale, map }).map((q) => [q.filament, Array.from(q.vertices), Array.from(q.triangles)]));
      return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
    });
    // What v0.125 made (main at 6cdbd2c).
    expect(hashes).toEqual(["17e6e1c209f48d14", "9bd92a60ffa81e2a"]);
  });
});
