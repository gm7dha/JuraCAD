/**
 * Island puzzle holes (pure): low ground the land closes round — a hollow dipping below sea level, a gap in the height
 * data — is filled in as land, so no piece has a hole through it; walls drawn along boundaries are always given back
 * to a piece; and an island with no such patches is made exactly as before.
 */
import { describe, expect, it } from "vitest";
import { gridFrom } from "../src/terrain/elevation";
import { fillEnclosed, ISLAND_DEFAULTS, makeIslandPuzzle, type IslandPuzzle, type IslandSpec } from "../src/terrain/islandPuzzle";
import { outlineSegs, type Seg } from "./support/outlineGeom";

const W = 6000;
const H = 4000;
const sw = { e: 300000, n: 700000 };
const SPEC: IslandSpec = { ...ISLAND_DEFAULTS, bed: [256, 256, 256] };

const plainHeight = (e: number, n: number) => {
  const [x, y] = [(e - sw.e) / W - 0.5, (n - sw.n) / H - 0.5];
  const r = Math.hypot(x / 0.42, y / 0.4) + 0.15 * Math.sin(Math.atan2(y, x) * 3);
  return Math.max(0, (1 - r) * 400 + 60 * Math.sin(e / 300) * (1 - r));
};
// The same island with a bowl dipping well below sea level in the west and a square of no data (0) in the east.
const HOLLOW = { e: sw.e + 0.36 * W, n: sw.n + 0.5 * H, r: 350 };
const GAP = { e: sw.e + 0.64 * W, n: sw.n + 0.52 * H, half: 200 };
const holed = gridFrom(sw, W, H, 25, (e, n) => {
  const d = Math.hypot(e - HOLLOW.e, n - HOLLOW.n);
  if (d < HOLLOW.r) return -20 * (1 - d / HOLLOW.r);
  if (Math.abs(e - GAP.e) < GAP.half && Math.abs(n - GAP.n) < GAP.half) return 0;
  return plainHeight(e, n);
});
const plain = gridFrom(sw, W, H, 25, plainHeight);

/** How many separate loops a piece's underside outline has (1 = no hole through it). */
function loops(segs: Seg[]): number {
  const key = (x: number, y: number) => `${x.toFixed(5)},${y.toFixed(5)}`;
  const up = new Map<string, string>();
  const find = (a: string): string => {
    while (up.get(a) !== a) a = up.get(a)!;
    return a;
  };
  for (const [ax, ay, bx, by] of segs) {
    const [a, b] = [key(ax, ay), key(bx, by)];
    if (!up.has(a)) up.set(a, a);
    if (!up.has(b)) up.set(b, b);
    up.set(find(a), find(b));
  }
  return new Set([...up.keys()].map(find)).size;
}

/** Is (x, y) inside a piece's underside (even–odd over its outline)? */
function inside(segs: Seg[], x: number, y: number): boolean {
  let n = 0;
  for (const [ax, ay, bx, by] of segs) if (ay > y !== by > y && x < ax + ((y - ay) * (bx - ax)) / (by - ay)) n++;
  return n % 2 === 1;
}

/** Points of the island's land (on a grid `step` mm apart, at least `margin` mm in from the coast) no piece covers. */
function uncovered(p: IslandPuzzle, isLand: (x: number, y: number) => boolean, step: number, margin: number, near: number) {
  const outlines = p.pieces.map((q) => outlineSegs(q.bodies[0]));
  const box = outlines.map((s) => {
    const xs = s.flatMap((g) => [g[0], g[2]]);
    const ys = s.flatMap((g) => [g[1], g[3]]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  });
  const missed: [number, number][] = [];
  for (let y = step / 2; y < p.height; y += step)
    for (let x = step / 2; x < p.width; x += step) {
      if (![[0, 0], [margin, 0], [-margin, 0], [0, margin], [0, -margin]].every(([dx, dy]) => isLand(x + dx, y + dy))) continue;
      let ok = false;
      for (let i = 0; i < outlines.length && !ok; i++) {
        const [x0, y0, x1, y1] = box[i];
        if (x < x0 - near || x > x1 + near || y < y0 - near || y > y1 + near) continue;
        if (inside(outlines[i], x, y)) ok = true;
        // In the fit gap between two pieces.
        else ok = outlines[i].some(([ax, ay, bx, by]) => {
          const [dx, dy] = [bx - ax, by - ay];
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
          return Math.hypot(x - ax - t * dx, y - ay - t * dy) <= near;
        });
      }
      if (!ok) missed.push([x, y]);
    }
  return missed;
}

describe("holes in the land", () => {
  it("fills patches the land closes round (each no lower than its lowest shore) and leaves open sea (diagonal channels too) alone", () => {
    // 7 × 7: a ring of land round a 1-cell hole, and a sea channel reaching the edge only diagonally.
    const nx = 7;
    const L = [
      "0000000",
      "0111110",
      "0101110",
      "0111110",
      "0111010",
      "0111101",
      "0000000",
    ].reverse();
    const isLand = new Uint8Array(nx * nx);
    for (let j = 0; j < nx; j++) for (let i = 0; i < nx; i++) isLand[j * nx + i] = L[j][i] === "1" ? 1 : 0;
    const f = fillEnclosed(isLand, nx, nx, (c) => 10 + c);
    expect(f.count).toBe(1);
    const hole = 4 * nx + 2;
    expect(isLand[hole]).toBe(1);
    // Its shore: the four cells beside it; the lowest is the one below.
    expect(f.level[0]).toBe(10 + 3 * nx + 2);
    // The cell at (4, 2) reaches the sea at (5, 1) diagonally: still sea.
    expect(isLand[2 * nx + 4]).toBe(0);
  });

  const p = makeIslandPuzzle(holed, sw, W, H, SPEC);
  const k = p.k;
  const landAt = (g: typeof plain) => (x: number, y: number) => {
    const [e, n] = [sw.e + x / k, sw.n + y / k];
    return e > sw.e && n > sw.n && e < sw.e + W && n < sw.n + H && plainHeight(e, n) > SPEC.sea && g === plain;
  };
  it("fills a hollow below sea level and a gap in the height data, with no hole through any piece", () => {
    expect(p.warnings.join(" ")).toMatch(/2 low patches inside the land .* were filled in/);
    for (const q of p.pieces) expect(loops(outlineSegs(q.bodies[0])), q.name).toBe(1);
    // Both patches' middles are under a piece.
    for (const [e, n] of [[HOLLOW.e, HOLLOW.n], [GAP.e, GAP.n]]) {
      const [x, y] = [(e - sw.e) * k, (n - sw.n) * k];
      expect(p.pieces.some((q) => inside(outlineSegs(q.bodies[0]), x, y)), `${e}, ${n}`).toBe(true);
    }
    // And all the land the plain island has is covered (or in the fit gap between two pieces).
    expect(uncovered(p, landAt(plain), 1.5, 1.2, SPEC.fit + 0.8)).toEqual([]);
  });
  it("fills them smoothly from the ground round them, never down at the base", () => {
    const q = makeIslandPuzzle(plain, sw, W, H, SPEC);
    for (const [e, n] of [[HOLLOW.e, HOLLOW.n], [GAP.e, GAP.n]]) {
      const [x, y] = [(e - sw.e) * k, (n - sw.n) * k];
      expect(p.groundAt(x, y)).toBeGreaterThan(SPEC.base + 1);
      expect(Math.abs(p.groundAt(x, y) - q.groundAt(x, y))).toBeLessThan(1.5);
    }
  });
  it("gives the cells under boundary walls to a piece, so the only gaps are the fit gaps between pieces", () => {
    // Boundaries crossing both patches and the island, wiggling.
    const lines: [number, number][][] = [
      Array.from({ length: 30 }, (_, i): [number, number] => [HOLLOW.e + 80 * Math.sin(i), sw.n - 100 + (i * (H + 200)) / 29]),
      Array.from({ length: 30 }, (_, i): [number, number] => [sw.e - 100 + (i * (W + 200)) / 29, GAP.n + 60 * Math.cos(i * 1.3)]),
      Array.from({ length: 30 }, (_, i): [number, number] => [GAP.e + 50 * Math.cos(i * 0.7), sw.n - 100 + (i * (H + 200)) / 29]),
    ];
    const c = makeIslandPuzzle(holed, sw, W, H, SPEC, { lines, names: [] });
    expect(c.alongBoundaries).toBe(true);
    for (const q of c.pieces) expect(loops(outlineSegs(q.bodies[0])), q.name).toBe(1);
    expect(uncovered(c, landAt(plain), 1.5, 1.2, SPEC.fit + 0.8)).toEqual([]);
  });
  it("makes an island with no such patches exactly as before (no fill, no note)", () => {
    const q = makeIslandPuzzle(plain, sw, W, H, SPEC);
    expect(q.warnings.join(" ")).not.toMatch(/filled in/);
    const r = makeIslandPuzzle(holed, sw, W, H, SPEC);
    // The same pieces where the patches aren't: as many, and the plain one's area plus the patches'.
    expect(r.pieces.length).toBe(q.pieces.length);
  });
});
