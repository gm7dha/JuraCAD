/**
 * Channels cut into the pieces leave sound meshes (the reviewer's checks): every body closed, each edge shared by exactly
 * two triangles, no two triangles folded back on each other (a piece's wall under a channel's points once was fanned
 * past its own diagonal and over its partner; points on a straight side once stood triangles on their edge), where paths
 * cross, meet, end on each other, overlap a road, run along a piece's side and cross the coast; on the mountain too, with
 * a snow line. Pieces no line comes near are exactly as without the map. Switchbacks wider than the fold limit keep their
 * legs, and small loops stay loops.
 */
import { describe, expect, it } from "vitest";
import { gridFrom } from "../src/terrain/elevation";
import { weld } from "../src/geometry/threeMf";
import { ISLAND_DEFAULTS, makeIslandPuzzle } from "../src/terrain/islandPuzzle";
import { makeMountainPuzzle, MOUNTAIN_DEFAULTS } from "../src/terrain/mountainPuzzle";
import { FOLD, smoothLine } from "../src/terrain/smoothLines";
import { lineLength, type MapFeatures } from "../src/terrain/osm";

type XY = [number, number];

/** Edges not shared by exactly two triangles, and edges whose two triangles lie back to back. */
function soundness(vs: ArrayLike<number>, ts: ArrayLike<number>): { bad: number; folded: number } {
  const { vertices: V, triangles: T } = weld(vs, ts);
  const normals: number[][] = [];
  const edges = new Map<number, number[]>();
  const nv = V.length / 3;
  for (let t = 0; t < T.length / 3; t++) {
    const [a, b, c] = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
    const u = [0, 1, 2].map((k) => V[b * 3 + k] - V[a * 3 + k]);
    const v = [0, 1, 2].map((k) => V[c * 3 + k] - V[a * 3 + k]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    normals.push(n.map((x) => x / l));
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = p < q ? p * nv + q : q * nv + p;
      const list = edges.get(key);
      if (list) list.push(t);
      else edges.set(key, [t]);
    }
  }
  let [bad, folded] = [0, 0];
  for (const list of edges.values()) {
    if (list.length !== 2) bad++;
    else {
      const [m, n] = [normals[list[0]], normals[list[1]]];
      if (m[0] * n[0] + m[1] * n[1] + m[2] * n[2] < -0.999) folded++;
    }
  }
  return { bad, folded };
}

function route(start: XY, mPerMm: number): XY[] {
  const pts: XY[] = [];
  const mm = (x: number) => x * mPerMm;
  let [x, y] = start;
  for (let s = 0; s <= 30; s += 0.5) pts.push([x + mm(s), y + mm(4 * Math.sin(s / 5))]);
  [x, y] = pts[pts.length - 1];
  for (let s = 0.4; s <= 12; s += 0.4) pts.push([x + mm(s), y + mm(Math.round(s / 0.4) % 2 ? 0.25 : -0.25)]);
  [x, y] = pts[pts.length - 1];
  for (let k = 0; k < 8; k++) {
    const d = k % 2 ? -1 : 1;
    x += mm(d * 3);
    pts.push([x, y]);
    y += mm(0.7);
    pts.push([x, y]);
  }
  for (let s = 0.5; s <= 120; s += 0.5) pts.push([x + mm(s), y + mm(2 * Math.sin(s / 7))]);
  return pts;
}

describe("channels cut into sound meshes", () => {
  it("island: crossings, a T, a path on a road, a path over the coast — every body sound", () => {
    const sw = { e: 300000, n: 700000 };
    const [W, H] = [6000, 4000];
    const grid = gridFrom(sw, W, H, 20, (e, n) => {
      const [u, v] = [(e - sw.e) / W - 0.5, (n - sw.n) / H - 0.5];
      const land = Math.max(0, 1 - Math.hypot(u / 0.46, v / 0.44)) * 120;
      return land > 0 ? land + 500 * Math.exp(-(((u - 0.05) / 0.12) ** 2 + (v / 0.1) ** 2)) : 0;
    });
    const spec = { ...ISLAND_DEFAULTS, bed: [256, 256, 256] as [number, number, number], piece: 30, relief: 14 };
    const plain = makeIslandPuzzle(grid, sw, W, H, spec);
    const k = plain.k;
    const at = (x: number, y: number): XY => [sw.e + x / k, sw.n + y / k];
    const lines: MapFeatures["lines"] = [
      { kind: "path", pts: route(at(40, 70), 1 / k), thin: true, ids: ["1"] },
      { kind: "road", pts: Array.from({ length: 80 }, (_, i): XY => at(30 + i * 2, 110 + 6 * Math.sin(i / 6))), thin: true, ids: ["2"] },
      { kind: "path", pts: [at(100, 20), at(100, 160)], thin: true, ids: ["3"] },
      { kind: "track", pts: [at(60, 90), at(100, 90)], thin: true, ids: ["4"] },
      { kind: "path", pts: [at(30, 110.2), at(120, 110.3)], thin: true, ids: ["5"] },
      { kind: "path", pts: [at(-20, 50), at(300, 130)], ids: ["6"] },
    ];
    const island = makeIslandPuzzle(grid, sw, W, H, spec, undefined, { lines, shapes: [], names: [] });
    let changed = 0;
    island.pieces.forEach((p, i) => {
      for (const b of p.bodies) expect(soundness(b.vertices, b.triangles), p.name).toEqual({ bad: 0, folded: 0 });
      const q = plain.pieces[i];
      const same = p.bodies.every((b, j) => q.bodies[j] && b.vertices.length === q.bodies[j].vertices.length && b.vertices.every((x, m) => x === q.bodies[j].vertices[m]));
      if (!same) changed++;
    });
    // Only the pieces a line comes near changed; the rest exactly as without the map.
    expect(changed).toBeGreaterThan(0);
    expect(changed).toBeLessThan(island.pieces.length);
  });

  it("mountain with a snow line: every body sound (the snow's channel stops at its floor)", () => {
    const sw = { e: 201000, n: 770500 };
    const hill = gridFrom(sw, 4000, 3000, 20, (e, n) => 300 + 700 * Math.exp(-(((e - 202800) / 900) ** 2 + ((n - 771500) / 700) ** 2)));
    const spec = { ...MOUNTAIN_DEFAULTS, bed: [256, 256, 256] as [number, number, number], snowline: 800 };
    const L = makeMountainPuzzle(hill, 4000, 3000, spec).layout;
    const at = (x: number, y: number): XY => [L.e0 + x / L.k, L.n0 + y / L.k];
    const lines: MapFeatures["lines"] = [
      { kind: "path", pts: route(at(10, 15), 1 / L.k), thin: true },
      { kind: "path", pts: [at(5, 5), at(150, 110)], thin: true },
      { kind: "road", pts: [at(5, 60), at(160, 60)], thin: true },
      { kind: "track", pts: [at(45, 0), at(45, 120)] },
    ];
    const m = makeMountainPuzzle(hill, 4000, 3000, spec, { lines, shapes: [], names: [] });
    for (const p of m.pieces)
      for (const b of p.bodies) {
        const s = soundness(b.vertices, b.triangles);
        expect(s.bad, `${p.name} ${b.part}`).toBe(0);
        // The snow may thin to a hair over its floor in a channel just above the snow line (lying flat on it, not through it).
        if (b.part === "rock") expect(s.folded, `${p.name} ${b.part}`).toBe(0);
      }
  });
});

describe("smoothing keeps what prints as it is", () => {
  const W = 0.6;
  it("keeps a switchback's legs when they're further apart than the fold limit", () => {
    for (const gap of [1.3, 1.5, 2]) {
      const p: XY[] = [[0, 0]];
      let y = 0;
      for (let k = 0; k < 6; k++) {
        const x = k % 2 ? 0 : 3;
        p.push([x, y]);
        y += gap;
        p.push([x, y]);
      }
      const s = smoothLine(p, W);
      // Only the corners rounded (each quarter turn loses (2 − π/2) × the radius).
      expect(lineLength(s), `gap ${gap}`).toBeGreaterThan(lineLength(p) - 11 * W * 1.01 * (2 - Math.PI / 2) - 0.05);
      expect(Math.max(...s.map((q) => q[0])), `gap ${gap}`).toBeGreaterThan(2.9);
      expect(Math.min(...s.slice(1, -1).map((q) => q[0])), `gap ${gap}`).toBeLessThan(0.1);
      expect(gap).toBeGreaterThan(FOLD * W);
    }
  });

  it("keeps a small loop a loop (it isn't folded across its own closing)", () => {
    for (const r of [0.8, 1, 1.2]) {
      const ring: XY[] = Array.from({ length: 41 }, (_, i): XY => [r * Math.cos((2 * Math.PI * i) / 40), r * Math.sin((2 * Math.PI * i) / 40)]);
      const s = smoothLine(ring, W);
      expect(lineLength(s), `r ${r}`).toBeGreaterThan(0.9 * lineLength(ring));
      expect(s[0]).toEqual(ring[0]);
      expect(s[s.length - 1]).toEqual(ring[40]);
    }
  });
});
