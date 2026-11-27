/**
 * Island in one piece (pure): no jigsaw — each separate bit of land kept is one piece, every mesh closed with a positive
 * volume, no dovetails; laid on the bed or put together; colour bands still split it into closed parts; the jigsaw itself
 * unchanged without the option.
 */
import { describe, expect, it } from "vitest";
import { weld } from "../src/geometry/threeMf";
import { bandParts, islandBands, LAYER_DEFAULT, mapOnPuzzle, mapRaster, meshCheck, NO_MAP, SEA_BLUE, GROUND_BROWN, type ColourSpec } from "../src/terrain/colour";
import { gridFrom } from "../src/terrain/elevation";
import { featuresForIsland, ISLAND_DEFAULTS, islandChecks, makeIslandPuzzle, type IslandSpec } from "../src/terrain/islandPuzzle";
import type { MapFeatures } from "../src/terrain/osm";
import { platesFor, platesInPlace } from "../src/terrain/puzzle3mf";
import { closedMesh } from "../src/terrain/waterPart";

const W = 6000;
const H = 4000;
const sw = { e: 300000, n: 700000 };
// A lumpy island with an islet off its south-east, sea all round.
const island = gridFrom(sw, W, H, 25, (e, n) => {
  const [x, y] = [(e - sw.e) / W - 0.5, (n - sw.n) / H - 0.5];
  const r = Math.hypot(x / 0.42, y / 0.4) + 0.15 * Math.sin(Math.atan2(y, x) * 3);
  const islet = Math.hypot(x - 0.44, y + 0.4) < 0.04 ? 30 : 0;
  return Math.max(0, (1 - r) * 400 + 60 * Math.sin(e / 300) * (1 - r)) + islet;
});
const BED: [number, number, number] = [256, 256, 256];
const SPEC: IslandSpec = { ...ISLAND_DEFAULTS, bed: BED, land: "all", onePiece: true };

/** Separate bits of land on a fine grid of the heights (8-connected, as the meshes may touch at a corner). */
function landBits(): number {
  const n = 300;
  const m = 200;
  const land = new Uint8Array(n * m);
  for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) land[j * n + i] = heightAt(i * (W / n), j * (H / m)) > SPEC.sea ? 1 : 0;
  const seen = new Uint8Array(n * m);
  let count = 0;
  for (let c0 = 0; c0 < n * m; c0++) {
    if (!land[c0] || seen[c0]) continue;
    count++;
    const st = [c0];
    seen[c0] = 1;
    while (st.length) {
      const c = st.pop()!;
      const [i, j] = [c % n, Math.floor(c / n)];
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const [a, b] = [i + di, j + dj];
          if (a < 0 || b < 0 || a >= n || b >= m) continue;
          const d = b * n + a;
          if (land[d] && !seen[d]) {
            seen[d] = 1;
            st.push(d);
          }
        }
    }
  }
  return count;
}
function heightAt(x: number, y: number) {
  const i = Math.min(island.nx - 1, Math.round(x / island.spacing));
  const j = Math.min(island.ny - 1, Math.round(y / island.spacing));
  return island.h[j * island.nx + i];
}

const sound = (b: { vertices: number[]; triangles: number[] }) => closedMesh(weld(b.vertices, b.triangles));

describe("island in one piece", () => {
  const p = makeIslandPuzzle(island, sw, W, H, SPEC);

  it("each separate bit of land is one piece: closed, with a volume, and nothing joining them", () => {
    expect(p.pieces.length).toBe(landBits());
    expect(p.pieces.length).toBe(2);
    expect(p.tabs).toEqual([]);
    expect(p.joins).toBe(0);
    expect(p.loose).toBe(0);
    for (const q of p.pieces) {
      expect(q.bodies.length).toBe(1);
      expect(sound(q.bodies[0]), q.name).toBe(true);
      const c = meshCheck(q.bodies[0].vertices, q.bodies[0].triangles);
      expect(c.open).toBe(0);
      expect(c.volume, q.name).toBeGreaterThan(0);
      expect(q.joints).toBe(0);
    }
    // The main island is by far the biggest, and the islet is said.
    const areas = p.pieces.map((q) => q.area).sort((a, b) => b - a);
    expect(areas[0]).toBeGreaterThan(areas[1] * 20);
    expect(p.warnings.join(" ")).toMatch(/1 other island is a piece of its own/);
  });

  it("ignores the piece size, fit and pattern", () => {
    expect(islandChecks({ ...SPEC, piece: 1, fit: 9 })).toEqual([]);
    const q = makeIslandPuzzle(island, sw, W, H, { ...SPEC, piece: 15, seed: 7, fit: 0.3 });
    expect(q.pieces.length).toBe(p.pieces.length);
    q.pieces.forEach((x, i) => expect(x.bodies[0].vertices).toEqual(p.pieces[i].bodies[0].vertices));
  });

  it("one island with paths: still one closed piece", () => {
    const k = p.k;
    const at = (x: number, y: number): [number, number] => [sw.e + x / k, sw.n + y / k];
    const features: MapFeatures = {
      lines: [{ kind: "path", pts: Array.from({ length: 50 }, (_, i) => at(60 + i * 2.5, 80 + 10 * Math.sin(i / 6))), thin: true, ids: ["1"] }],
      shapes: [],
      names: [],
    };
    const m = makeIslandPuzzle(island, sw, W, H, { ...SPEC, land: "biggest" }, undefined, features);
    expect(m.pieces.length).toBe(1);
    expect(sound(m.pieces[0].bodies[0])).toBe(true);
  });

  it("laid on the bed or put together; colour bands split it into closed parts", () => {
    expect(platesFor(p.pieces, BED).length).toBe(1);
    const put = makeIslandPuzzle(island, sw, W, H, { ...SPEC, inPlace: true });
    const placed = platesInPlace(put.pieces, BED, put.room);
    expect(placed.fits).toBe(true);
    expect(placed.plates.length).toBe(1);
    const cspec: ColourSpec = { mode: "bands", bands: islandBands(p.high), base: GROUND_BROWN, water: SEA_BLUE, layer: LAYER_DEFAULT };
    const scale = { z0: SPEC.base, h0: 0, mmPerM: SPEC.relief / Math.max(p.high, 1) };
    const map = mapRaster(NO_MAP, p.width, p.height);
    const main = p.pieces.reduce((a, b) => (a.area > b.area ? a : b));
    const parts = bandParts(main.bodies, main.z0, { spec: cspec, scale, map });
    expect(parts.length).toBeGreaterThan(1);
    const whole = meshCheck(main.bodies[0].vertices, main.bodies[0].triangles).volume;
    let sum = 0;
    for (const part of parts) {
      const c = meshCheck(part.vertices, part.triangles);
      expect(c.open).toBe(0);
      sum += c.volume;
    }
    expect(Math.abs(sum - whole) / whole).toBeLessThan(1e-9);
  });

  it("leaves the jigsaw exactly as it was without the option", () => {
    const a = makeIslandPuzzle(island, sw, W, H, { ...ISLAND_DEFAULTS, bed: BED });
    const b = makeIslandPuzzle(island, sw, W, H, { ...ISLAND_DEFAULTS, bed: BED, onePiece: false });
    expect(a.pieces.length).toBeGreaterThan(5);
    expect(b.pieces.length).toBe(a.pieces.length);
    a.pieces.forEach((x, i) => expect(b.pieces[i].bodies[0].vertices).toEqual(x.bodies[0].vertices));
    expect(b.tabs).toEqual(a.tabs);
  });

  // The reviewer's ragged coast (8 × 6 km): the coast all round at the base's height once left colour bands open there.
  it("a ragged coast in colour bands: every band part closed, with and without map marks", () => {
    const isw = { e: 300000, n: 700000 };
    const [IW, IH] = [8000, 6000];
    const ragged = gridFrom(isw, IW, IH, 25, (e, n) => {
      const [x, y] = [(e - isw.e) / IW - 0.5, (n - isw.n) / IH - 0.5];
      const a = Math.atan2(y, x);
      const r = Math.hypot(x / 0.42, y / 0.4) + 0.12 * Math.sin(a * 7) + 0.06 * Math.sin(a * 23) + 0.03 * Math.sin(e / 90) * Math.cos(n / 70);
      const specks = Math.sin(e / 140) * Math.sin(n / 130) > 0.97 ? 3 : 0;
      return Math.max(0, (1 - r) * 500 + 120 * Math.sin(e / 400)) + specks;
    });
    const spec: IslandSpec = { ...ISLAND_DEFAULTS, bed: BED, land: "biggest", onePiece: true, inPlace: true, printLayer: { layer: 0.2 } };
    const p0 = makeIslandPuzzle(ragged, isw, IW, IH, spec);
    for (const withMarks of [false, true]) {
      const o = p0.origin;
      const k = p0.k;
      const A = (x: number, y: number): [number, number] => [o.e + x / k, o.n + y / k];
      const ring = (cx: number, cy: number, r: number) => Array.from({ length: 20 }, (_, i) => A(cx + r * Math.cos(i * 0.314), cy + r * Math.sin(i * 0.314)));
      const f: MapFeatures = withMarks
        ? {
            lines: [
              { kind: "path", pts: Array.from({ length: 80 }, (_, i) => A(20 + i * 2.5, 100 + 30 * Math.sin(i / 7))), thin: true, ids: ["1"] },
              { kind: "road", pts: [A(0, 60), A(260, 70)], thin: true, ids: ["2"] },
            ],
            shapes: [{ kind: "water", rings: [ring(120, 120, 15)] }, { kind: "building", rings: [[A(80, 80), A(84, 80), A(84, 84), A(80, 84)]] }],
            names: [],
          }
        : { lines: [], shapes: [], names: [] };
      const p = makeIslandPuzzle(ragged, isw, IW, IH, spec, undefined, f);
      const map = withMarks ? mapRaster(mapOnPuzzle(featuresForIsland(f, p.k).features, p.origin.e, p.origin.n, p.k), p.width, p.height) : mapRaster(NO_MAP, p.width, p.height);
      const cspec: ColourSpec = { mode: "bands", bands: islandBands(p.high), base: GROUND_BROWN, water: SEA_BLUE, layer: LAYER_DEFAULT, paths: "#ff0000", roads: "#000000" };
      const scale = { z0: spec.base, h0: 0, mmPerM: spec.relief / Math.max(p.high, 1) };
      let parts = 0;
      for (const q of p.pieces) {
        for (const b of q.bodies) expect(sound(b), `marks ${withMarks} ${q.name}`).toBe(true);
        for (const part of bandParts(q.bodies, q.z0, { spec: cspec, scale, map }, q.top)) {
          parts++;
          expect(sound(part), `marks ${withMarks} ${q.name} filament ${part.filament}`).toBe(true);
        }
      }
      expect(parts).toBeGreaterThan(3);
    }
  });
});
