/**
 * Paths and roads as printed (the owner: "nice solid, continuous and the same width and height throughout"): a long
 * winding path — gentle bends, tight zigzags, hairpins up a steep slope, across pieces and their dovetails — and a road,
 * on an Island and a Mountain puzzle. Measured along the line the puzzle used: the groove's depth and width, and the
 * painted strip's width, breaks and blobs, in bands and full colour.
 */
import { describe, expect, it } from "vitest";
import { weld } from "../src/geometry/threeMf";
import { gridFrom, heightAt } from "../src/terrain/elevation";
import { THIN_FLAT, THIN_GROOVE } from "../src/terrain/groundMarks";
import { ISLAND_DEFAULTS, featuresForIsland, makeIslandPuzzle } from "../src/terrain/islandPuzzle";
import { baseFor, makeMountainPuzzle, MOUNTAIN_DEFAULTS } from "../src/terrain/mountainPuzzle";
import { featuresAtScale, type MapFeatures } from "../src/terrain/osm";
import { filaments, islandBands, mapOnPuzzle, meshCheck, mapRaster, mountainBands, PATH_RED, ROAD_BLACK, type ColourSpec, type HeightScale } from "../src/terrain/colour";
import { bandPuzzle, colourPuzzle } from "../src/terrain/colourFiles";
import { measureLine, reportText, stations, TopIndex, type LineReport, type Mesh } from "./support/lineQuality";

type XY = [number, number];

/** A winding route in metres from `start`, `mPerMm` metres per puzzle mm: bends, a tight zigzag, hairpins. */
function windingRoute(start: XY, mPerMm: number, east: number): XY[] {
  const pts: XY[] = [];
  const mm = (x: number) => x * mPerMm;
  let [x, y] = start;
  // Gentle bends: 30 mm with a 4 mm swing.
  for (let s = 0; s <= 30; s += 0.5) pts.push([x + mm(s), y + mm(4 * Math.sin(s / 5))]);
  [x, y] = pts[pts.length - 1];
  // A tight zigzag, ±0.25 mm every 0.4 mm (GPS jitter, steps): 12 mm of it.
  for (let s = 0.4; s <= 12; s += 0.4) pts.push([x + mm(s), y + mm((Math.round(s / 0.4) % 2 ? 0.25 : -0.25))]);
  [x, y] = pts[pts.length - 1];
  // Hairpins up a slope: legs 3 mm long, 0.7 mm apart, eight of them.
  for (let k = 0; k < 8; k++) {
    const dir = k % 2 ? -1 : 1;
    x += mm(dir * 3);
    pts.push([x, y]);
    y += mm(0.7);
    pts.push([x, y]);
  }
  // On east, a long gentle stretch.
  for (let s = 0.5; s <= east; s += 0.5) pts.push([x + mm(s), y + mm(2 * Math.sin(s / 7))]);
  return pts;
}

const meshOf = (b: { vertices: ArrayLike<number>; triangles: ArrayLike<number> }, painted?: (t: number) => boolean): Mesh => ({ vertices: b.vertices, triangles: b.triangles, painted });

function report(name: string, r: LineReport) {
  console.log(`${name}: ${reportText(r)}`);
}

describe("paths as printed", () => {
  // An island with a steep hill in its middle.
  const sw = { e: 300000, n: 700000 };
  const [W, H] = [6000, 4000];
  const grid = gridFrom(sw, W, H, 20, (e, n) => {
    const [u, v] = [(e - sw.e) / W - 0.5, (n - sw.n) / H - 0.5];
    const land = Math.max(0, 1 - Math.hypot(u / 0.46, v / 0.44)) * 120;
    return land > 0 ? land + 500 * Math.exp(-(((u - 0.05) / 0.12) ** 2 + (v / 0.1) ** 2)) : 0;
  });
  const spec = { ...ISLAND_DEFAULTS, bed: [256, 256, 256] as [number, number, number], piece: 30, relief: 14 };
  const plainIsland = makeIslandPuzzle(grid, sw, W, H, spec);
  const k = plainIsland.k;
  const route = windingRoute([sw.e + 40 / k, sw.n + 70 / k], 1 / k, 120);
  const road = Array.from({ length: 80 }, (_, i): XY => [sw.e + (30 + i * 2) / k, sw.n + (110 + 6 * Math.sin(i / 6)) / k]);
  const features: MapFeatures = {
    lines: [
      { kind: "path", pts: route, thin: true, ids: ["1"] },
      { kind: "road", pts: road, thin: true, ids: ["2"] },
    ],
    shapes: [],
    names: [],
  };
  const island = makeIslandPuzzle(grid, sw, W, H, spec, undefined, features);
  const used = featuresForIsland(features, k).features;
  const lift = spec.relief / Math.max(island.high, 1);
  const plain = (x: number, y: number) => spec.base + Math.max(0, heightAt(grid, sw.e + x / k, sw.n + y / k)) * lift;
  const want = (x: number, y: number) => plain(x, y) - island.groundAt(x, y);
  const pmap = mapOnPuzzle(used, sw.e, sw.n, k);
  const raster = mapRaster(pmap, island.width, island.height);
  const scale: HeightScale = { z0: spec.base, h0: 0, mmPerM: lift };
  const cs: ColourSpec = { mode: "bands", bands: islandBands(island.high), base: null, water: null, layer: 0.2, paths: PATH_RED, roads: ROAD_BLACK };
  const fs = filaments(cs, raster);
  const pathN = fs.find((f) => f.uses.includes("Paths"))!.n;
  const roadN = fs.find((f) => f.uses.includes("Roads"))!.n;
  const lines = pmap.lines.map((l) => l.pts);

  it("island: the groove is as deep and wide all along, the paint a clean strip of its width", () => {
    const banded = bandPuzzle(island.pieces, { spec: cs, scale, map: raster });
    const groove = new TopIndex(island.pieces.flatMap((p) => p.bodies.map((b) => meshOf(b))));
    const paintedFor = (n: number) =>
      new TopIndex([...banded.parts.values()].flat().map((part) => meshOf(part, (t) => part.paint?.[t] === n)));
    const full = colourPuzzle(island.pieces, { spec: { ...cs, mode: "full" }, scale, map: raster });
    const red = (m: { rgb: Uint8Array; triangles: ArrayLike<number> }) => (t: number) => [0, 1, 2].every((c) => m.rgb[(t * 3 + c) * 3] > 120 && m.rgb[(t * 3 + c) * 3 + 1] < 80);
    const fullIndex = new TopIndex([...full.values()].map((m) => meshOf(m, red(m))));
    const D = THIN_GROOVE.depth;
    const w = THIN_GROOVE.width;
    // A perfect channel is this wide half way down its walls.
    const half = (w / 2) * (1 + THIN_FLAT);
    const g = measureLine(groove, stations(lines[0], 0.1), plain, want, w, D, false, half);
    const p = measureLine(paintedFor(pathN), stations(lines[0], 0.1), plain, want, w, D, true);
    const r = measureLine(paintedFor(roadN), stations(lines[1], 0.1), plain, want, w, D, true);
    const f = measureLine(fullIndex, stations(lines[0], 0.1), plain, want, w, D, true);
    report("island path groove", g);
    report("island path paint (bands)", p);
    report("island road paint (bands)", r);
    report("island path paint (full colour)", f);
    expect(g.stations).toBeGreaterThan(500);
    // Every piece still closed, with the channels cut into it.
    for (const piece of island.pieces)
      for (const b of piece.bodies) {
        if (process.env.LQ_DEBUG && meshCheck(b.vertices, b.triangles).open) {
          const m = weld(b.vertices, b.triangles);
          const edges = new Map<string, number>();
          for (let t = 0; t < m.triangles.length; t += 3)
            for (let k = 0; k < 3; k++) {
              const [p, q] = [m.triangles[t + k], m.triangles[t + ((k + 1) % 3)]];
              const back = `${q}>${p}`;
              if (edges.get(back)) edges.set(back, edges.get(back)! - 1);
              else edges.set(`${p}>${q}`, (edges.get(`${p}>${q}`) ?? 0) + 1);
            }
          for (const [key, n] of edges) if (n) console.log("open", key, n, key.split(">").map((i) => [0, 1, 2].map((d) => m.vertices[+i * 3 + d].toFixed(6)).join(",")).join(" -> "));
        }
        expect(meshCheck(b.vertices, b.triangles).open, piece.name).toBe(0);
      }
    expect(g.depthP5).toBeGreaterThan(0.95 * D);
    expect(g.shallow).toBe(0);
    expect(g.widthP5).toBeGreaterThan(0.95 * half);
    expect(g.widthP95).toBeLessThan(1.05 * half);
    expect(g.widthMin).toBeGreaterThan(0.85 * half);
    for (const q of [p, r, f]) {
      expect(q.breaks).toBe(0);
      expect(q.blobs).toBe(0);
      expect(q.paintP5).toBeGreaterThan(0.95 * w);
      expect(q.paintP95).toBeLessThan(1.05 * w);
      expect(q.paintMin).toBeGreaterThan(0.85 * w);
    }
  });

  it("mountain: the same on its top pieces", () => {
    const hw = 4000;
    const hh = 3000;
    const msw = { e: 201000, n: 770500 };
    const hill = gridFrom(msw, hw, hh, 20, (e, n) => 300 + 700 * Math.exp(-(((e - 202800) / 900) ** 2 + ((n - 771500) / 700) ** 2)));
    const mspec = { ...MOUNTAIN_DEFAULTS, bed: [256, 256, 256] as [number, number, number], snowline: null };
    const L = makeMountainPuzzle(hill, hw, hh, mspec).layout;
    const mroute = windingRoute([L.e0 + 15 / L.k, L.n0 + 40 / L.k], 1 / L.k, 100);
    const mf: MapFeatures = { lines: [{ kind: "path", pts: mroute, thin: true, ids: ["1"] }], shapes: [], names: [] };
    const m = makeMountainPuzzle(hill, hw, hh, mspec, mf);
    const base = baseFor(mspec);
    const mplain = (x: number, y: number) => base + (heightAt(hill, L.e0 + x / L.k, L.n0 + y / L.k) - L.low) * L.k * mspec.exaggeration;
    const mused = featuresAtScale(mf, L.k).features;
    const mmap = mapOnPuzzle(mused, L.e0, L.n0, L.k);
    const mr = mapRaster(mmap, L.cols * mspec.cube, L.rows * mspec.cube);
    const mscale: HeightScale = { z0: base, h0: L.low, mmPerM: L.k * mspec.exaggeration };
    const mcs: ColourSpec = { mode: "bands", bands: mountainBands(L.low, L.low + 700), base: null, water: null, layer: 0.2, paths: PATH_RED, roads: ROAD_BLACK };
    const mfs = filaments(mcs, mr);
    const n = mfs.find((f) => f.uses.includes("Paths"))!.n;
    const tops = m.pieces.filter((p) => p.top);
    const banded = bandPuzzle(tops, { spec: mcs, scale: mscale, map: mr });
    const D = THIN_GROOVE.depth;
    const w = THIN_GROOVE.width;
    const st = stations(mmap.lines[0].pts, 0.1);
    const half = (w / 2) * (1 + THIN_FLAT);
    const g = measureLine(new TopIndex(tops.flatMap((p) => p.bodies.map((b) => meshOf(b)))), st, mplain, () => D, w, D, false, half);
    const p = measureLine(new TopIndex([...banded.parts.values()].flat().map((part) => meshOf(part, (t) => part.paint?.[t] === n))), st, mplain, () => D, w, D, true);
    report("mountain path groove", g);
    report("mountain path paint (bands)", p);
    expect(g.stations).toBeGreaterThan(500);
    // Every piece still closed, with the channels cut into it.
    for (const piece of tops) for (const b of piece.bodies) expect(meshCheck(b.vertices, b.triangles).open, piece.name).toBe(0);
    expect(g.depthP5).toBeGreaterThan(0.95 * D);
    expect(g.shallow).toBe(0);
    expect(g.widthP5).toBeGreaterThan(0.95 * half);
    expect(g.widthP95).toBeLessThan(1.05 * half);
    expect(g.widthMin).toBeGreaterThan(0.85 * half);
    expect(p.breaks).toBe(0);
    expect(p.blobs).toBe(0);
    expect(p.paintP5).toBeGreaterThan(0.95 * w);
    expect(p.paintP95).toBeLessThan(1.05 * w);
    expect(p.paintMin).toBeGreaterThan(0.85 * w);
  });
});
