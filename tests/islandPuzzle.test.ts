/**
 * Island puzzle (pure): an island's land cut into pieces of about the chosen size, or along boundaries; every piece a
 * closed mesh standing on z = 0, the ground on top; neighbours clear of each other by the fit gap; dovetails made.
 */
import { describe, expect, it } from "vitest";
import { weld } from "../src/geometry/threeMf";
import { areaProblem, gridFrom, MAX_TILES, tilesFor, zoomFor } from "../src/terrain/elevation";
import { BOUNDARY_LEVELS, boundaryQuery, ISLANDS } from "../src/terrain/islands";
import { boundariesOnGrid, boundaryLevels, readOsm } from "../src/terrain/osm";
import { distanceTransform, ISLAND_DEFAULTS, islandChecks, makeIslandPuzzle, MIN_JOINTS, type IslandPuzzle, type IslandSpec } from "../src/terrain/islandPuzzle";
import type { Body } from "../src/terrain/mountainPuzzle";
import { platesFor } from "../src/terrain/puzzle3mf";

// A lumpy island with a bay, on 6 × 4 km, and a small islet off it.
const W = 6000;
const H = 4000;
const sw = { e: 300000, n: 700000 };
const island = gridFrom(sw, W, H, 25, (e, n) => {
  const [x, y] = [(e - sw.e) / W - 0.5, (n - sw.n) / H - 0.5];
  const r = Math.hypot(x / 0.42, y / 0.4) + 0.15 * Math.sin(Math.atan2(y, x) * 3);
  const islet = Math.hypot(x - 0.44, y + 0.4) < 0.04 ? 30 : 0;
  return Math.max(0, (1 - r) * 400 + 60 * Math.sin(e / 300) * (1 - r)) + islet;
});
const SPEC: IslandSpec = { ...ISLAND_DEFAULTS, bed: [256, 256, 256] };

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

/** Points sampled on a body's walls (z = 0 corners): the outline. */
const footprint = (b: Body) => {
  const pts: [number, number][] = [];
  for (let i = 0; i < b.vertices.length; i += 3) if (b.vertices[i + 2] === 0) pts.push([b.vertices[i], b.vertices[i + 1]]);
  return pts;
};

describe("distance transform", () => {
  it("gives squared distances to the nearest set cell", () => {
    const m = new Uint8Array(25);
    m[12] = 1;
    const d = distanceTransform(m, 5, 5);
    expect(d[12]).toBe(0);
    expect(d[0]).toBe(8);
    expect(d[14]).toBe(4);
  });
});

describe("island puzzle", () => {
  const p = makeIslandPuzzle(island, sw, W, H, SPEC);
  it("cuts the island into pieces of about the chosen size, each a closed solid on the bed", () => {
    expect(p.pieces.length).toBeGreaterThan(8);
    expect(p.pieces.length).toBeLessThan(40);
    for (const piece of p.pieces) {
      const c = closed(piece.bodies[0]);
      expect(c.open, piece.name).toBe(0);
      expect(c.volume, piece.name).toBeGreaterThan(0);
      expect(piece.area).toBeGreaterThan(50);
      expect(Math.min(...piece.bodies[0].vertices.filter((_, i) => i % 3 === 2))).toBe(0);
    }
    expect(p.width).toBeLessThanOrEqual(246.01);
  });
  it("puts dovetails across most borders", () => {
    expect(p.joins).toBeGreaterThan(p.pieces.length * 0.8);
    expect(p.joins).toBeGreaterThan(p.unjoined * 2);
  });
  it("keeps neighbours apart by the fit gap", () => {
    const fps = p.pieces.map((q) => footprint(q.bodies[0]));
    // Points of every piece on a 2 mm grid; each compared with other pieces' points nearby.
    const grid = new Map<string, [number, number, number][]>();
    fps.forEach((pts, n) => pts.forEach(([x, y]) => {
      const k = `${Math.floor(x / 2)},${Math.floor(y / 2)}`;
      grid.set(k, [...(grid.get(k) ?? []), [x, y, n]]);
    }));
    let nearest = Infinity;
    fps.forEach((pts, n) => pts.forEach(([x, y]) => {
      for (let a = -1; a <= 1; a++)
        for (let b = -1; b <= 1; b++)
          for (const [u, v, m] of grid.get(`${Math.floor(x / 2) + a},${Math.floor(y / 2) + b}`) ?? [])
            if (m !== n) nearest = Math.min(nearest, Math.hypot(x - u, y - v));
    }));
    expect(nearest).toBeGreaterThan(2 * SPEC.fit * 0.8);
    expect(nearest).toBeLessThan(2 * SPEC.fit + 0.6);
  });
  it("is the same for the same seed and different for another", () => {
    const again = makeIslandPuzzle(island, sw, W, H, SPEC);
    expect(again.pieces.map((q) => q.area)).toEqual(p.pieces.map((q) => q.area));
    const other = makeIslandPuzzle(island, sw, W, H, { ...SPEC, seed: 2 });
    expect(other.pieces.map((q) => q.area)).not.toEqual(p.pieces.map((q) => q.area));
  });
  it("cuts along boundaries when given them, naming the pieces", () => {
    const line: [number, number][] = [[sw.e + W / 2, sw.n - 100], [sw.e + W / 2 + 300, sw.n + H / 2], [sw.e + W / 2, sw.n + H + 100]];
    const names = [
      { text: "Westshire", at: [sw.e + W * 0.3, sw.n + H / 2] as [number, number] },
      { text: "Eastshire", at: [sw.e + W * 0.7, sw.n + H / 2] as [number, number] },
    ];
    const c = makeIslandPuzzle(island, sw, W, H, SPEC, { lines: [line], names });
    expect(c.alongBoundaries).toBe(true);
    const regions = c.pieces.map((q) => q.region);
    expect(regions).toContain("Westshire");
    expect(regions).toContain("Eastshire");
    expect(c.pieces.filter((q) => q.region).length).toBe(2);
    expect(c.joins).toBeGreaterThanOrEqual(1);
    for (const q of c.pieces) expect(closed(q.bodies[0]).open).toBe(0);
    // Lines that don't divide the land: cut into pieces as usual, with a note.
    const none = makeIslandPuzzle(island, sw, W, H, SPEC, { lines: [[[sw.e - 500, sw.n - 500], [sw.e - 400, sw.n - 400]]], names: [] });
    expect(none.alongBoundaries).toBe(false);
    expect(none.warnings.join(" ")).toMatch(/boundaries/);
  });
  it("keeps the islands, the biggest, or all the land", () => {
    // The same island with mainland along the south edge.
    const withMainland = gridFrom(sw, W, H, 25, (e, n) => (n - sw.n < 300 ? 50 : 0) + Math.max(0, 400 * (1 - Math.hypot((e - sw.e) / W - 0.5, (n - sw.n) / H - 0.55) / 0.3)));
    const area = (p: ReturnType<typeof makeIslandPuzzle>) => p.pieces.reduce((s, q) => s + q.area, 0);
    const islands = makeIslandPuzzle(withMainland, sw, W, H, SPEC);
    const all = makeIslandPuzzle(withMainland, sw, W, H, { ...SPEC, land: "all" });
    expect(area(all)).toBeGreaterThan(area(islands) + 1000);
    expect(islands.warnings.join(" ")).toMatch(/mainland/);
    const biggest = makeIslandPuzzle(island, sw, W, H, { ...SPEC, land: "biggest" });
    expect(biggest.pieces.length).toBe(p.pieces.length - 1);
  });
  it("raises the highest ground by the relief asked for", () => {
    const tallest = Math.max(...p.pieces.map((q) => q.height));
    expect(tallest).toBeGreaterThan(SPEC.base + SPEC.relief * 0.9);
    expect(tallest).toBeLessThanOrEqual(SPEC.base + SPEC.relief + 1e-6);
  });
  it("lays out on plates", () => {
    const plates = platesFor(p.pieces, SPEC.bed);
    expect(plates.flatMap((pl) => pl.pieces).length).toBe(p.pieces.length);
  });
  it("refuses odd sizes and all-sea areas", () => {
    expect(islandChecks({ ...SPEC, piece: 5 })).not.toEqual([]);
    const sea = gridFrom(sw, W, H, 100, () => 0);
    expect(() => makeIslandPuzzle(sea, sw, W, H, SPEC)).toThrow(/sea/);
  });
});

/** Every piece held by at least two dovetails, or by one when it has just one neighbour; only lone islets loose. */
function heldTogether(p: IslandPuzzle, label: string) {
  for (const q of p.pieces) {
    if (!q.neighbours) continue;
    expect(q.joints, `${label}: piece ${q.name} (${q.neighbours} neighbours)`).toBeGreaterThanOrEqual(Math.min(MIN_JOINTS, q.neighbours));
    expect(q.joints, `${label}: piece ${q.name}`).toBeGreaterThan(0);
  }
  expect(p.pieces.filter((q) => !q.neighbours).length, label).toBe(p.loose);
  // Each dovetail holds two pieces.
  expect(p.pieces.reduce((s, q) => s + q.joints, 0), label).toBe(2 * p.joins);
}

describe("every piece is held", () => {
  // A ragged coast: bays and headlands every few mm, where borders are short and tabs meet the sea.
  const ragged = gridFrom(sw, W, H, 25, (e, n) => {
    const [x, y] = [(e - sw.e) / W - 0.5, (n - sw.n) / H - 0.5];
    const a = Math.atan2(y, x);
    const r = Math.hypot(x / 0.42, y / 0.4) + 0.12 * Math.sin(a * 7) + 0.08 * Math.sin(a * 13 + 1) + 0.05 * Math.sin(e / 90) * Math.cos(n / 110);
    return Math.max(0, (1 - r) * 300);
  });
  const small: IslandSpec = { ...SPEC, bed: [200, 200, 200] };
  it("by at least two dovetails, on the lumpy island and a ragged coast, for several seeds and piece sizes", () => {
    for (const [name, g] of [["lumpy", island], ["ragged", ragged]] as const)
      for (const [piece, seed] of [[20, 1], [35, 2], [60, 3]]) {
        const p = makeIslandPuzzle(g, sw, W, H, { ...small, piece, seed });
        heldTogether(p, `${name} ${piece} mm seed ${seed}`);
        for (const q of p.pieces) expect(closed(q.bodies[0]).open, q.name).toBe(0);
      }
  });
  it("makes the islet off the lumpy island a loose piece and says so", () => {
    const p = makeIslandPuzzle(island, sw, W, H, SPEC);
    heldTogether(p, "default");
    expect(p.loose).toBe(1);
    expect(p.warnings.join(" ")).toMatch(/1 small islet is a loose piece/);
  });
  it("gives two areas cut along a boundary two dovetails between them", () => {
    const line: [number, number][] = [[sw.e + W / 2, sw.n - 100], [sw.e + W / 2 + 300, sw.n + H / 2], [sw.e + W / 2, sw.n + H + 100]];
    const c = makeIslandPuzzle(island, sw, W, H, SPEC, { lines: [line], names: [] });
    heldTogether(c, "boundary");
    expect(c.pieces.filter((q) => q.neighbours === 1).every((q) => q.joints >= 2)).toBe(true);
  });
});

describe("islands and boundaries", () => {
  it("has a box round each island that can be fetched", () => {
    for (const i of ISLANDS) {
      const z = zoomFor(i.sw, i.width, i.height);
      expect(areaProblem(i.sw, i.width, i.height, 1_300_000, z), i.name).toBeNull();
      expect(tilesFor(i.sw, i.width, i.height, z).length).toBeLessThanOrEqual(MAX_TILES);
    }
    // Small islands get the finest heights; Great Britain coarser ones.
    expect(zoomFor(ISLANDS[1].sw, ISLANDS[1].width, ISLANDS[1].height)).toBe(12);
    expect(zoomFor(ISLANDS[0].sw, ISLANDS[0].width, ISLANDS[0].height)).toBeLessThan(9);
    // Mountains keep their own limit.
    expect(areaProblem({ e: 200000, n: 700000 }, 50000, 1000)).toMatch(/40 km/);
  });
  it("asks OpenStreetMap for one level of boundaries round the area", () => {
    const q = boundaryQuery(ISLANDS[1].sw, ISLANDS[1].width, ISLANDS[1].height, 6);
    expect(q).toContain('["admin_level"="6"]');
    const [s, w, n, e] = q.match(/\(([-\d.,]+)\)/)![1].split(",").map(Number);
    expect(s).toBeGreaterThan(55.3);
    expect(n).toBeLessThan(55.9);
    expect(w).toBeLessThan(-5.4);
    expect(e).toBeGreaterThan(-5.05);
    expect(BOUNDARY_LEVELS.map(([l]) => l)).toEqual([4, 6, 8, 10]);
  });
  it("reads boundaries and their names from a map file", () => {
    const osm = `<?xml version="1.0"?><osm version="0.6">
      <node id="1" lat="55.5" lon="-5.3"/><node id="2" lat="55.7" lon="-5.3"/><node id="3" lat="55.6" lon="-5.4"/><node id="4" lat="55.6" lon="-5.1"/>
      <node id="5" lat="55.6" lon="-5.2"/>
      <way id="10"><nd ref="1"/><nd ref="2"/></way>
      <way id="11"><nd ref="3"/><nd ref="4"/><tag k="boundary" v="administrative"/><tag k="admin_level" v="10"/></way>
      <relation id="20"><member type="way" ref="10" role="outer"/><member type="node" ref="3" role="label"/><tag k="type" v="boundary"/><tag k="boundary" v="administrative"/><tag k="admin_level" v="8"/><tag k="name" v="Westerby"/></relation>
      <relation id="21"><member type="way" ref="10" role="outer"/><member type="node" ref="5" role="admin_centre"/><tag k="type" v="boundary"/><tag k="boundary" v="administrative"/><tag k="admin_level" v="8"/><tag k="name" v="Easterby"/></relation>
    </osm>`;
    const data = readOsm(osm);
    expect(boundaryLevels(data)).toEqual([[8, 1], [10, 1]]);
    const b = boundariesOnGrid(data, 8);
    expect(b.lines.length).toBe(1);
    expect(b.names.map((n) => n.text).sort()).toEqual(["Easterby", "Westerby"]);
    // On the grid, running north.
    expect(b.lines[0][1][1]).toBeGreaterThan(b.lines[0][0][1] + 20000);
  });
});
