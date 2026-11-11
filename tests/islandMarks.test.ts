/**
 * Island puzzle with map marks (pure): the sample OpenStreetMap file's path, stream, road, loch and hut pressed into an
 * island's ground — grooves at the right depth on the tops, marks only on the land (rivers end at the coast), every
 * piece still a closed solid, the 3MF still made, and "just the area" exactly the plain puzzle.
 */
import { describe, expect, it } from "vitest";
import { weld } from "../src/geometry/threeMf";
import { gridFrom, heightAt } from "../src/terrain/elevation";
import { GROOVES } from "../src/terrain/groundMarks";
import { featuresForIsland, ISLAND_DEFAULTS, LEAST_BASE, makeIslandPuzzle, type IslandSpec } from "../src/terrain/islandPuzzle";
import type { Body } from "../src/terrain/mountainPuzzle";
import { featuresOnGrid, readOsm } from "../src/terrain/osm";
import { plate3mf, platesFor } from "../src/terrain/puzzle3mf";
import { sampleOsm } from "./support/osmSample";

// An island under the sample map (which covers 201000–205000 E, 770500–773500 N): the road along the south and the
// stream's west end run out to sea.
const sw = { e: 200500, n: 770000 };
const W = 5000;
const H = 4000;
const island = gridFrom(sw, W, H, 25, (e, n) => {
  const r = Math.hypot((e - 203000) / 2300, (n - 771900) / 1600);
  return Math.max(0, (1 - r) * 300);
});
const SPEC: IslandSpec = { ...ISLAND_DEFAULTS, bed: [180, 180, 180] };
const data = readOsm(sampleOsm());

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

describe("island puzzle with map marks", () => {
  const plain = makeIslandPuzzle(island, sw, W, H, SPEC);
  const water = makeIslandPuzzle(island, sw, W, H, SPEC, undefined, featuresOnGrid(data, "water"));
  const all = makeIslandPuzzle(island, sw, W, H, SPEC, undefined, featuresOnGrid(data, "all"));
  const k = plain.k;
  const plainAt = (x: number, y: number) => SPEC.base + Math.max(0, heightAt(island, sw.e + x / k, sw.n + y / k)) * (SPEC.relief / Math.max(plain.high, 1));
  const mm = (e: number, n: number): [number, number] => [(e - sw.e) * k, (n - sw.n) * k];

  it("gives exactly the plain puzzle for just the area", () => {
    const area = makeIslandPuzzle(island, sw, W, H, SPEC, undefined, featuresOnGrid(data, "area"));
    expect(area.pieces.length).toBe(plain.pieces.length);
    area.pieces.forEach((p, i) => {
      expect(p.name).toBe(plain.pieces[i].name);
      expect(p.bodies[0].vertices).toEqual(plain.pieces[i].bodies[0].vertices);
      expect(p.bodies[0].triangles).toEqual(plain.pieces[i].bodies[0].triangles);
    });
    expect(area.marks.shown).toBe(0);
  });

  it("presses grooves into the tops at the right depth, and sets the loch flat", () => {
    // Along the path (inland, 201200,771000 → 202500,772000): the groove is its full depth except where it crosses a
    // dovetail, where it fades; never deeper.
    let [px, py, most] = [0, 0, 0];
    for (let t = 0; t <= 1; t += 0.01) {
      const [x, y] = mm(201200 + 1300 * t, 771000 + 1000 * t);
      const d = plainAt(x, y) - water.groundAt(x, y);
      expect(d).toBeLessThanOrEqual(GROOVES.path.depth + 1e-6);
      if (d > most) [px, py, most] = [x, y, d];
    }
    expect(most).toBeCloseTo(GROOVES.path.depth, 1);
    // The pieces' top points near it are lowered by up to the groove's depth.
    let deepest = 0;
    for (const p of water.pieces) {
      const v = p.bodies[0].vertices;
      for (let i = 0; i < v.length; i += 3) if (v[i + 2] > 0 && Math.hypot(v[i] - px, v[i + 1] - py) < 1) deepest = Math.max(deepest, plainAt(v[i], v[i + 1]) - v[i + 2]);
    }
    expect(deepest).toBeGreaterThan(GROOVES.path.depth * 0.5);
    expect(deepest).toBeLessThanOrEqual(GROOVES.path.depth + 1e-6);
    // Off the marks, the ground is untouched.
    const [qx, qy] = mm(202000, 772800);
    expect(water.groundAt(qx, qy)).toBe(plainAt(qx, qy));
    // In the loch: flat, a little below its lowest shore.
    // (Near a thin part — a dovetail — it fades back towards the ground, so most of it, not all, is at the level.)
    const levels: number[] = [];
    for (let de = 2850; de <= 3450; de += 50)
      for (let dn = 650; dn <= 1050; dn += 50) {
        if (de > 3050 && de < 3250 && dn > 750 && dn < 950) continue;
        const [x, y] = mm(201000 + de, 770500 + dn);
        levels.push(water.groundAt(x, y));
        expect(water.groundAt(x, y)).toBeLessThan(plainAt(x, y) + 1e-9);
      }
    const level = Math.min(...levels);
    expect(levels.filter((z) => Math.abs(z - level) < 1e-6).length).toBeGreaterThan(levels.length * 0.7);
    expect(level).toBeGreaterThanOrEqual(LEAST_BASE);
    // Roads and the hut only with everything.
    const [rx, ry] = mm(203000, 770600 + 50 * 0.75);
    expect(all.groundAt(rx, ry)).toBeLessThan(water.groundAt(rx, ry));
  });

  it("keeps marks to the land: lines stop at the coast", () => {
    const onLand = (x: number, y: number) => heightAt(island, sw.e + x / k, sw.n + y / k) > SPEC.sea;
    expect(all.marks.lines.length).toBeGreaterThan(2);
    for (const l of all.marks.lines) for (const [x, y] of l.pts) expect(onLand(x, y) || heightAt(island, sw.e + x / k, sw.n + y / k) > -1, `${l.kind} ${x},${y}`).toBe(true);
    // The road (east–west at 770600 N) runs off into the sea at both ends: its drawn piece is shorter than the map's.
    const road = all.marks.lines.filter((l) => l.kind === "road");
    expect(road.length).toBeGreaterThan(0);
    const xs = road.flatMap((l) => l.pts.map((p) => p[0]));
    expect(Math.min(...xs)).toBeGreaterThan(mm(201000, 0)[0] + 5);
    expect(Math.max(...xs)).toBeLessThan(mm(205000, 0)[0] - 5);
    // And every point of every line is on a piece's land.
    for (const l of all.marks.lines)
      for (const [x, y] of l.pts) expect(heightAt(island, sw.e + x / k, sw.n + y / k)).toBeGreaterThan(SPEC.sea - 2);
    // Nothing goes below the thinnest base.
    for (const p of all.pieces) {
      const v = p.bodies[0].vertices;
      for (let i = 2; i < v.length; i += 3) if (v[i] > 0) expect(v[i]).toBeGreaterThanOrEqual(LEAST_BASE - 1e-9);
    }
  });

  it("keeps every piece a closed solid, with the outlines unchanged, and still makes the 3MF", () => {
    expect(all.pieces.length).toBe(plain.pieces.length);
    all.pieces.forEach((p, i) => {
      const c = closed(p.bodies[0]);
      expect(c.open, p.name).toBe(0);
      expect(c.volume, p.name).toBeGreaterThan(0);
      expect(p.outline).toEqual(plain.pieces[i].outline);
      // Held by two dovetails (one where a piece has just one neighbour), marks or not.
      if (p.neighbours) expect(p.joints, p.name).toBeGreaterThanOrEqual(2);
    });
    const plates = platesFor(all.pieces, SPEC.bed);
    expect(plate3mf(plates[0], "Marks").length).toBeGreaterThan(1000);
  });

  it("leaves out marks too small for the island's scale", () => {
    const f = featuresOnGrid(data, "all");
    // At a hundredth of the scale the hut (40 m) and the loch are specks.
    const small = featuresForIsland(f, k / 100);
    expect(small.features.shapes.length).toBe(0);
    expect(small.tooSmall).toBeGreaterThan(1);
    expect(featuresForIsland(f, k).features.shapes.length).toBe(2);
  });
});
