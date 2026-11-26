/**
 * Flat water (pure): a loch on sloping, dipping ground comes out as one flat surface on a whole print layer — the land
 * built up under it where it's lower, taken down where it's higher — on the island and the mountain puzzles; in colour
 * bands it's a real part of the water filament exactly WATER_LAYERS layers thick, closed, with the rest of the piece
 * still adding up; and nothing changes without water.
 */
import { describe, expect, it } from "vitest";
import { bandParts, filaments, islandBands, LAYER_DEFAULT, mapOnPuzzle, mapRaster, meshCheck, mountainBands, WATER_BLUE, GROUND_BROWN, clearOfWater, type ColourSpec } from "../src/terrain/colour";
import { gridFrom, heightAt } from "../src/terrain/elevation";
import { groundMarks, onPrintLayer, PRINT_LAYER } from "../src/terrain/groundMarks";
import { featuresForIsland, ISLAND_DEFAULTS, LEAST_BASE, makeIslandPuzzle } from "../src/terrain/islandPuzzle";
import { baseFor, makeMountainPuzzle, MOUNTAIN_DEFAULTS, type MountainSpec, type PuzzlePiece } from "../src/terrain/mountainPuzzle";
import type { MapFeatures } from "../src/terrain/osm";
import { splitWater, WATER_LAYERS } from "../src/terrain/waterPart";

type XY = [number, number];
const BED: [number, number, number] = [256, 256, 256];

/** A loch: a wobbly ellipse in OS grid metres. */
function loch(e: number, n: number, re: number, rn: number): XY[] {
  return Array.from({ length: 48 }, (_, i) => {
    const a = (i / 48) * 2 * Math.PI;
    const w = 1 + 0.12 * Math.sin(3 * a);
    return [e + re * w * Math.cos(a), n + rn * w * Math.sin(a)] as XY;
  });
}
const inside = (pts: XY[], x: number, y: number) => {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [a, b] = [pts[i], pts[j]];
    if (a[1] > y !== b[1] > y && x < a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1])) c = !c;
  }
  return c;
};
/** How far x, y is inside the outline (negative outside). */
function depthIn(pts: XY[], x: number, y: number): number {
  let d = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [a, b] = [pts[i], pts[(i + 1) % pts.length]];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
    d = Math.min(d, Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy));
  }
  return inside(pts, x, y) ? d : -d;
}

/** Upward triangles of a piece whose corners are all at least `margin` mm inside the outline: their heights. */
function topHeightsIn(p: PuzzlePiece, outline: XY[], margin: number): number[] {
  const zs: number[] = [];
  for (const b of p.bodies) {
    const V = b.vertices;
    for (let t = 0; t < b.triangles.length; t += 3) {
      const ids = [b.triangles[t], b.triangles[t + 1], b.triangles[t + 2]];
      if (!ids.every((i) => depthIn(outline, V[i * 3], V[i * 3 + 1]) > margin)) continue;
      const [a, c, d] = ids.map((i) => [V[i * 3], V[i * 3 + 1], V[i * 3 + 2]]);
      const nz = (c[0] - a[0]) * (d[1] - a[1]) - (c[1] - a[1]) * (d[0] - a[0]);
      if (nz <= 0) continue;
      zs.push(a[2], c[2], d[2]);
    }
  }
  return zs;
}

describe("flat water on the island puzzle", () => {
  const sw = { e: 300000, n: 700000 };
  const [W, H] = [6000, 4000];
  // A hill sloping east to west, with a dip where the loch is: the tiles' loch bed is anything but flat.
  const grid = gridFrom(sw, W, H, 25, (e, n) => {
    const [x, y] = [(e - sw.e) / W - 0.5, (n - sw.n) / H - 0.5];
    const r = Math.hypot(x / 0.42, y / 0.4);
    const land = Math.max(0, (1 - r) * 400);
    const dip = 150 * Math.exp(-(((e - 302000) / 300) ** 2 + ((n - 702000) / 220) ** 2));
    return land > 0 ? Math.max(1, land + 0.03 * (e - 302000) - dip) : 0;
  });
  const ring = loch(302000, 702000, 500, 350);
  const features: MapFeatures = { lines: [], shapes: [{ kind: "water", rings: [ring] }], names: [] };
  const spec = { ...ISLAND_DEFAULTS, bed: BED, piece: 40 };
  const plain = makeIslandPuzzle(grid, sw, W, H, spec);
  const wet = makeIslandPuzzle(grid, sw, W, H, spec, undefined, features);
  const k = wet.k;
  const outline = ring.map(([e, n]) => [(e - wet.origin.e) * k, (n - wet.origin.n) * k] as XY);
  const plainAt = (x: number, y: number) => spec.base + Math.max(0, heightAt(grid, wet.origin.e + x / k, wet.origin.n + y / k)) * (spec.relief / Math.max(plain.high, 1));

  it("is one flat surface on a whole print layer, built up where the ground is lower", () => {
    const levels = new Set<number>();
    let raised = 0;
    let lowered = 0;
    for (let x = 0; x < wet.width; x += 0.5)
      for (let y = 0; y < wet.height; y += 0.5) {
        if (depthIn(outline, x, y) < 1) continue;
        const z = wet.groundAt(x, y);
        levels.add(Math.round(z * 1e6) / 1e6);
        if (z > plainAt(x, y) + 0.05) raised++;
        if (z < plainAt(x, y) - 0.05) lowered++;
      }
    expect(levels.size).toBe(1);
    const [level] = [...levels];
    expect(Math.abs(level / PRINT_LAYER - Math.round(level / PRINT_LAYER))).toBeLessThan(1e-6);
    expect(level).toBeGreaterThanOrEqual(LEAST_BASE);
    expect(raised).toBeGreaterThan(20);
    expect(lowered).toBeGreaterThan(20);
    // Every piece's top inside the loch (away from its shore) is at that one height.
    let seen = 0;
    for (const p of wet.pieces) {
      const zs = topHeightsIn(p, outline, 1);
      seen += zs.length;
      for (const z of zs) expect(Math.abs(z - level), p.name).toBeLessThan(1e-9);
    }
    expect(seen).toBeGreaterThan(100);
    // Pieces still closed solids.
    for (const p of wet.pieces) expect(meshCheck(p.bodies[0].vertices, p.bodies[0].triangles).open, p.name).toBe(0);
  });

  it("in colour bands: the water is its own closed part, WATER_LAYERS layers thick, and the parts still add up", () => {
    const map = mapRaster(mapOnPuzzle(featuresForIsland(features, k).features, wet.origin.e, wet.origin.n, k), wet.width, wet.height);
    expect(map.water).toBe(true);
    const cspec: ColourSpec = { mode: "bands", bands: islandBands(wet.high), base: GROUND_BROWN, water: WATER_BLUE, layer: LAYER_DEFAULT };
    const scale = { z0: spec.base, h0: 0, mmPerM: spec.relief / Math.max(wet.high, 1) };
    const waterN = filaments(cspec, map).find((f) => f.colour === WATER_BLUE)!.n;
    let slabs = 0;
    for (const p of wet.pieces) {
      const parts = bandParts(p.bodies, p.z0, { spec: cspec, scale, map });
      const whole = meshCheck(p.bodies[0].vertices, p.bodies[0].triangles).volume;
      let sum = 0;
      for (const part of parts) {
        const c = meshCheck(part.vertices, part.triangles);
        expect(c.open, p.name).toBe(0);
        sum += c.volume;
      }
      expect(Math.abs(sum - whole) / whole, p.name).toBeLessThan(1e-9);
      for (const part of parts.filter((q) => q.filament === waterN && !q.paint)) {
        if (topHeightsIn(p, outline, 1).length === 0) continue;
        slabs++;
        expect(part.high - part.low).toBeCloseTo(WATER_LAYERS * LAYER_DEFAULT, 9);
        // Its floor and top are whole layers of the piece as printed.
        for (const z of [part.low, part.high]) expect(Math.abs(z / LAYER_DEFAULT - Math.round(z / LAYER_DEFAULT))).toBeLessThan(1e-6);
        // Nothing else of the piece's top inside the loch is water-coloured paint.
        for (const q of parts) if (q.paint) for (let t = 0; t < q.triangles.length; t += 3) {
          if (!q.paint[t / 3]) continue;
          const ids = [q.triangles[t], q.triangles[t + 1], q.triangles[t + 2]];
          expect(ids.every((i) => depthIn(outline, q.vertices[i * 3], q.vertices[i * 3 + 1]) > 1)).toBe(false);
        }
      }
    }
    expect(slabs).toBeGreaterThan(0);
  });
});

describe("flat water on the mountain puzzle", () => {
  const sw = { e: 200000, n: 770000 };
  const [W, H] = [3000, 2400];
  // A hill, with a hollow near its top where the lochan is.
  const hill = gridFrom(
    sw,
    W,
    H,
    20,
    (e, n) => 300 + 1000 * Math.exp(-(((e - 201500) / 800) ** 2 + ((n - 771200) / 650) ** 2)) + 40 * Math.sin(e / 170) - 90 * Math.exp(-(((e - 201500) / 140) ** 2 + ((n - 771200) / 100) ** 2)),
  );
  // A lochan in a hollow near the top.
  const ring = loch(201500, 771200, 160, 120);
  const features: MapFeatures = { lines: [], shapes: [{ kind: "water", rings: [ring] }], names: [] };
  const spec: MountainSpec = { ...MOUNTAIN_DEFAULTS, bed: BED, cube: 40, snowline: null };
  const m = makeMountainPuzzle(hill, W, H, spec, features);
  const k = m.layout.k;
  const outline = ring.map(([e, n]) => [(e - m.layout.e0) * k, (n - m.layout.n0) * k] as XY);

  it("is flat on a whole print layer of the top piece it's on", () => {
    const levels = new Set<number>();
    let seen = 0;
    let onLayer = 0;
    for (const p of m.pieces) {
      if (!p.top) continue;
      const zs = topHeightsIn(p, outline, 1);
      seen += zs.length;
      for (const z of zs) levels.add(Math.round(z * 1e6) / 1e6);
      if (zs.length && Math.abs((zs[0] - p.z0) / PRINT_LAYER - Math.round((zs[0] - p.z0) / PRINT_LAYER)) < 1e-6) onLayer++;
    }
    expect(seen).toBeGreaterThan(30);
    expect(levels.size).toBe(1);
    expect(onLayer).toBeGreaterThan(0);
    // Built up somewhere: the hill's flank is lower than the loch on its downhill side.
    const [level] = [...levels];
    let raised = 0;
    for (let x = 0; x < m.layout.cols * spec.cube; x += 0.5)
      for (let y = 0; y < m.layout.rows * spec.cube; y += 0.5)
        if (depthIn(outline, x, y) > 1 && level > baseFor(spec) + (heightAt(hill, m.layout.e0 + x / k, m.layout.n0 + y / k) - m.layout.low) * k * spec.exaggeration + 0.05) raised++;
    expect(raised).toBeGreaterThan(10);
    for (const p of m.pieces) for (const b of p.bodies) expect(meshCheck(b.vertices, b.triangles).open, p.name).toBe(0);
  });

  it("in colour bands: a closed water part as thick as WATER_LAYERS layers", () => {
    const map = mapRaster(mapOnPuzzle(features, m.layout.e0, m.layout.n0, k), m.layout.cols * spec.cube, m.layout.rows * spec.cube);
    const cspec: ColourSpec = { mode: "bands", bands: mountainBands(m.layout.low, m.layout.high, 1000), base: null, water: WATER_BLUE, layer: LAYER_DEFAULT };
    const scale = { z0: baseFor(spec), h0: m.layout.low, mmPerM: k * spec.exaggeration };
    const waterN = filaments(cspec, map).find((f) => f.colour === WATER_BLUE)!.n;
    let slabs = 0;
    for (const p of m.pieces) {
      if (!p.top || !topHeightsIn(p, outline, 1).length) continue;
      const parts = bandParts(p.bodies, p.z0, { spec: cspec, scale, map });
      let whole = 0;
      for (const b of p.bodies) whole += meshCheck(b.vertices, b.triangles).volume;
      let sum = 0;
      for (const part of parts) {
        const c = meshCheck(part.vertices, part.triangles);
        expect(c.open).toBe(0);
        sum += c.volume;
      }
      expect(Math.abs(sum - whole) / whole).toBeLessThan(1e-9);
      for (const part of parts) if (part.filament === waterN && !part.paint && Math.abs(part.high - part.low - WATER_LAYERS * LAYER_DEFAULT) < 1e-9) slabs++;
    }
    expect(slabs).toBeGreaterThan(0);
  });
});

describe("the water slab on a simple block", () => {
  // A 10 × 10 block, 5 high, whose top's middle (x 0…6) is a flat loch at 5 and the rest a slope up to 6: the loch
  // reaches three of the block's sides.
  const V = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 5, 6, 0, 5, 6, 10, 5, 0, 10, 5, 10, 0, 6, 10, 10, 6];
  // 0-3 bottom, 4-7 the loch's corners on top, 8-9 the high east edge.
  const T = [
    0, 2, 1, 0, 3, 2, // bottom
    4, 5, 6, 4, 6, 7, // loch
    5, 8, 9, 5, 9, 6, // slope
    0, 1, 5, 0, 5, 4, 1, 8, 5, // south side (two panels: x 0…6 and 6…10, joined at a slanting edge)
    1, 2, 9, 1, 9, 8, // east side
    2, 3, 7, 2, 7, 6, 2, 6, 9, // north side
    3, 0, 4, 3, 4, 7, // west side
  ];
  const isWater = (x: number) => x < 6;

  it("splits it into the rest and a closed slab that add up", () => {
    expect(meshCheck(V, T).open).toBe(0);
    const s = splitWater({ vertices: V, triangles: T }, (x) => isWater(x), 0.4, 0.2)!;
    expect(s).not.toBeNull();
    expect(s.levels).toEqual([5]);
    const [main, water] = [meshCheck(s.main.vertices, s.main.triangles), meshCheck(s.waters[0].mesh.vertices, s.waters[0].mesh.triangles)];
    expect(main.open).toBe(0);
    expect(water.open).toBe(0);
    expect(water.volume).toBeCloseTo(6 * 10 * 0.4, 9);
    expect(main.volume + water.volume).toBeCloseTo(meshCheck(V, T).volume, 9);
  });

  it("leaves pieces with no flat water alone", () => {
    expect(splitWater({ vertices: V, triangles: T }, () => false, 0.4, 0.2)).toBeNull();
    // And a loch too low for its slab.
    expect(splitWater({ vertices: V, triangles: T }, (x) => isWater(x), 0.4, 4.8)).toBeNull();
  });

  it("moves band edges out of the slab", () => {
    expect(clearOfWater([{ z: 3, filament: 2 }, { z: 4.8, filament: 3 }, { z: 6, filament: 4 }], [5], 0.4, 0.2).map((c) => [Math.round(c.z * 1e3) / 1e3, c.filament])).toEqual([
      [3, 2],
      [4.4, 3],
      [6, 4],
    ]);
    // On the slab's floor: a layer under it too.
    expect(clearOfWater([{ z: 4.6, filament: 3 }], [5], 0.4, 0.2)[0].z).toBeCloseTo(4.4, 12);
    // Well under it: left alone.
    expect(clearOfWater([{ z: 4.4, filament: 3 }], [5], 0.4, 0.2)[0].z).toBe(4.4);
  });
});

describe("without water", () => {
  it("puts levels on print layers, never on the bed", () => {
    expect(onPrintLayer(3.07, 0)).toBeCloseTo(3.0, 12);
    expect(onPrintLayer(0.05, 0)).toBeCloseTo(0.2, 12);
    expect(onPrintLayer(12.31, 10)).toBeCloseTo(12.4, 12);
  });

  it("marks with no water shapes have no water levels and press the ground as before", () => {
    const f: MapFeatures = { lines: [{ kind: "stream", pts: [[0, 50], [2000, 50]] }], shapes: [{ kind: "building", rings: [[[500, 500], [540, 500], [540, 540], [500, 540]]] }], names: [] };
    const g = groundMarks(f, 0, 0, 0.05, 100, 100, () => 10);
    expect(g.water).toBeUndefined();
    expect(g.apply(50, 50, 10)).toBe(10);
    expect(g.apply(26, 26, 10)).toBeGreaterThan(10.5);
  });
});
