/**
 * Flat water, the reviewer's cases (pure; its own file for memory): every band part stays closed after the lochs are
 * split off; a piece with lochs at two levels gets a slab per level (so filament changes count only their layers); the
 * 3MF object's own filament is the band it stands on, never the water's; and with other layer heights the lochs and
 * their slabs sit on those layers.
 */
import { describe, expect, it } from "vitest";
import { bandParts, filamentSwaps, filaments, GROUND_BROWN, islandBands, mapOnPuzzle, mapRaster, meshCheck, SEA_BLUE, type ColourSpec } from "../src/terrain/colour";
import { bandPuzzle } from "../src/terrain/colourFiles";
import { gridFrom } from "../src/terrain/elevation";
import { lochLayers } from "../src/terrain/groundMarks";
import { featuresForIsland, ISLAND_DEFAULTS, makeIslandPuzzle, type IslandSpec } from "../src/terrain/islandPuzzle";
import type { MapFeatures } from "../src/terrain/osm";
import { bandPlateFiles, platesFor } from "../src/terrain/puzzle3mf";
import { WATER_LAYERS } from "../src/terrain/waterPart";

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
const onLayer = (z: number, layer: number, first = layer) => Math.abs((z - first) / layer - Math.round((z - first) / layer)) < 1e-6;

function setUp(grid: keyof typeof grids, layer = 0.2) {
  const spec: IslandSpec = { ...ISLAND_DEFAULTS, bed: BED, piece: 25, seed: 1, ...lochLayers(true, { layer }, features) };
  const wet = makeIslandPuzzle(grids[grid], sw, W, H, spec, undefined, features);
  const map = mapRaster(mapOnPuzzle(featuresForIsland(features, wet.k).features, wet.origin.e, wet.origin.n, wet.k), wet.width, wet.height);
  const scale = { z0: spec.base, h0: 0, mmPerM: spec.relief / Math.max(wet.high, 1) };
  const cspec: ColourSpec = { mode: "bands", bands: islandBands(wet.high), base: GROUND_BROWN, water: SEA_BLUE, layer };
  const waterN = filaments(cspec, map).find((f) => f.colour === SEA_BLUE.toLowerCase())!.n;
  return { wet, ctx: { spec: cspec, scale, map }, waterN };
}

describe("flat water: the reviewer's cases", () => {
  it("every band part is closed and they add up (ragged coast; piece 32's band edge under its loch)", () => {
    const { wet, ctx, waterN } = setUp("ragged");
    let slabs = 0;
    for (const p of wet.pieces) {
      const parts = bandParts(p.bodies, p.z0, ctx);
      const whole = meshCheck(p.bodies[0].vertices, p.bodies[0].triangles).volume;
      let sum = 0;
      for (const q of parts) {
        const c = meshCheck(q.vertices, q.triangles);
        expect(c.open, `${p.name} filament ${q.filament}`).toBe(0);
        sum += c.volume;
      }
      expect(Math.abs(sum - whole) / whole, p.name).toBeLessThan(1e-8);
      const water = parts.filter((q) => q.filament === waterN && !q.paint);
      slabs += water.length;
      // The water comes after the bands.
      const firstWater = parts.findIndex((q) => q.filament === waterN && !q.paint);
      if (firstWater >= 0) expect(parts.slice(firstWater).every((q) => q.filament === waterN)).toBe(true);
    }
    expect(slabs).toBeGreaterThan(0);
    // The 3MF object's own filament is never the water's.
    const banded = bandPuzzle(wet.pieces, ctx);
    for (const plate of platesFor(wet.pieces, BED)) {
      const { config } = bandPlateFiles(plate, "t", (p) => (banded.parts.get(p) ?? []).map((b) => ({ ...b, label: `f${b.filament}` })), String);
      const objects = [...config.matchAll(/<object id="\d+">\s*<metadata key="name" value="[^"]*"\/>\s*<metadata key="extruder" value="(\d+)"/g)].map((m) => +m[1]);
      expect(objects.length).toBeGreaterThan(0);
      expect(objects.includes(waterN)).toBe(false);
    }
  });

  it("lochs at two levels in one piece: a slab each, counted only on its own layers (lumpy coast, piece 26)", () => {
    const { wet, ctx, waterN } = setUp("lumpy");
    let two = 0;
    for (const p of wet.pieces) {
      const parts = bandParts(p.bodies, p.z0, ctx);
      const water = parts.filter((q) => q.filament === waterN && !q.paint);
      for (const q of water) expect(q.high - q.low).toBeCloseTo(WATER_LAYERS * 0.2, 9);
      if (new Set(water.map((q) => q.high.toFixed(6))).size < 2) continue;
      two++;
      // The water's changes: exactly its own layers, not all between.
      const without = filamentSwaps(parts.filter((q) => q.filament !== waterN), 0.2);
      const withWater = filamentSwaps(parts, 0.2);
      expect(withWater - without).toBeLessThanOrEqual(2 * water.length * (WATER_LAYERS + 1));
    }
    expect(two).toBeGreaterThan(0);
  });

  it("with 0.12 mm layers the lochs and their slabs are on those layers", () => {
    expect(lochLayers(true, { layer: 0.2 }, features)).toEqual({});
    expect(lochLayers(false, { layer: 0.12 }, features)).toEqual({});
    expect(lochLayers(true, { layer: 0.12 }, { ...features, shapes: [] })).toEqual({});
    expect(lochLayers(true, { layer: 0.12, firstLayer: 0.2 }, features)).toEqual({ printLayer: { layer: 0.12, first: 0.2 } });
    const { wet, ctx, waterN } = setUp("ragged", 0.12);
    let slabs = 0;
    for (const p of wet.pieces)
      for (const q of bandParts(p.bodies, p.z0, ctx)) {
        if (q.filament !== waterN || q.paint) continue;
        slabs++;
        expect(q.high - q.low).toBeCloseTo(WATER_LAYERS * 0.12, 9);
        expect(onLayer(q.low, 0.12) && onLayer(q.high, 0.12), `${p.name} ${q.low} ${q.high}`).toBe(true);
      }
    expect(slabs).toBeGreaterThan(0);
  });
});
