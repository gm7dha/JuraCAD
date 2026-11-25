/**
 * "As many pieces as will print well" on real builds (pure, but heavy: its own file). An island on a test coast: the size
 * with the most pieces is below 15 mm and every piece there is held, apart and whole. A mountain read through a pretend
 * tile loader: the size found prints well, and the size one step smaller was built and doesn't.
 */
import { describe, expect, it } from "vitest";
import { gridFrom, readHeights, worldPixel, type TilePixels } from "../src/terrain/elevation";
import { ISLAND_DEFAULTS, makeIslandPuzzle, MIN_JOINTS, type IslandPuzzle } from "../src/terrain/islandPuzzle";
import { layoutFor, makeMountainPuzzle, MOUNTAIN_DEFAULTS, type MountainPuzzle, type MountainSpec } from "../src/terrain/mountainPuzzle";
import { CUBE_STEP, ISLAND_COARSE, ISLAND_FLOOR, ISLAND_START, ISLAND_STEP, islandPrintsWell, mostPiecesSize, mountainFloor, mountainLayoutVerdict, mountainPrintsWell, smallestThatPrints, type CountedVerdict, type Verdict } from "../src/terrain/mostPieces";
import { gridToLatLon } from "../src/terrain/osGrid";
import { box, collides, outlineSegs, SegGrid, segsCross, segSegDist } from "./support/outlineGeom";

/** Dovetails that slide straight out (islandPuzzle.test's check). */
function slideOut(p: IslandPuzzle): number {
  const O = p.pieces.map((q) => outlineSegs(q.bodies[0]));
  const G = O.map((s) => new SegGrid(s, 1));
  let free = 0;
  for (const t of p.tabs) {
    let d = 0;
    let hit = false;
    while (d < t.reach + 1 && !hit) {
      d += 0.05;
      hit = collides(O[t.from], G[t.into], -t.dir[0] * d, -t.dir[1] * d);
    }
    if (!hit) free++;
  }
  return free;
}

/** A piece's underside outline as loops with signed areas (islandOneSolid's check: outer loops negative, holes positive). */
function loopAreas(b: { vertices: ArrayLike<number>; triangles: ArrayLike<number> }): number[] {
  const segs = outlineSegs(b);
  const key = (x: number, y: number) => `${x.toFixed(5)},${y.toFixed(5)}`;
  const up = new Map<string, string>();
  const find = (a: string): string => {
    while (up.get(a) !== a) a = up.get(a)!;
    return a;
  };
  for (const [ax, ay, bx, by] of segs) {
    const [a, c] = [key(ax, ay), key(bx, by)];
    if (!up.has(a)) up.set(a, a);
    if (!up.has(c)) up.set(c, c);
    up.set(find(a), find(c));
  }
  const area = new Map<string, number>();
  for (const [ax, ay, bx, by] of segs) {
    const r = find(key(ax, ay));
    area.set(r, (area.get(r) ?? 0) + (ax * by - bx * ay) / 2);
  }
  return [...area.values()];
}

/** Neighbouring pieces' outlines: how often they cross and how near they come (islandPuzzle.test's check). */
function outlineGaps(p: IslandPuzzle): { crossings: number; nearest: number } {
  const O = p.pieces.map((q) => outlineSegs(q.bodies[0]));
  const G = O.map((s) => new SegGrid(s, 1));
  const B = O.map(box);
  let [crossings, nearest] = [0, Infinity];
  for (let a = 0; a < O.length; a++)
    for (let b = a + 1; b < O.length; b++) {
      const [A, C] = [B[a], B[b]];
      if (A[0] > C[2] + 1 || C[0] > A[2] + 1 || A[1] > C[3] + 1 || C[1] > A[3] + 1) continue;
      for (const s of O[a])
        for (const k of G[b].near((s[0] + s[2]) / 2, (s[1] + s[3]) / 2, 1 + Math.hypot(s[2] - s[0], s[3] - s[1]) / 2)) {
          if (segsCross(s, G[b].segs[k])) crossings++;
          nearest = Math.min(nearest, segSegDist(s, G[b].segs[k]));
        }
    }
  return { crossings, nearest };
}

describe("the island piece size with the most pieces that print well", () => {
  const W = 6000;
  const H = 4000;
  const sw = { e: 300000, n: 700000 };
  // islandOneSolid's low ragged coast: at pattern 1, 17 mm pieces leave a dovetail too thin to hold.
  const low = gridFrom(sw, W, H, 25, (e, n) => {
    const [x, y] = [(e - sw.e) / W - 0.5, (n - sw.n) / H - 0.5];
    const a = Math.atan2(y, x);
    return Math.max(0, (1 - (Math.hypot(x / 0.42, y / 0.4) + 0.12 * Math.sin(a * 9) + 0.07 * Math.sin(a * 23 + 1) + 0.04 * Math.sin(e / 70) * Math.cos(n / 80))) * 25);
  });
  it("goes below 15 mm to more pieces, every one held by two dovetails that catch, apart by the gap, each one solid", async () => {
    const spec = { ...ISLAND_DEFAULTS, bed: [256, 256, 256] as [number, number, number], seed: 1 };
    const built = new Map<number, IslandPuzzle>();
    const test = async (piece: number): Promise<CountedVerdict> => {
      const p = makeIslandPuzzle(low, sw, W, H, { ...spec, piece });
      built.set(piece, p);
      return { ...islandPrintsWell(p), pieces: p.pieces.length };
    };
    const r = await mostPiecesSize({ start: ISLAND_START, floor: ISLAND_FLOOR, top: 150, coarse: ISLAND_COARSE, step: ISLAND_STEP, test });
    expect(r.size).not.toBeNull();
    const size = r.size!;
    expect(size).toBeLessThan(15);
    const chosen = built.get(size)!;
    const at15 = makeIslandPuzzle(low, sw, W, H, { ...spec, piece: 15 });
    expect(chosen.pieces.length).toBeGreaterThan(1.15 * at15.pieces.length);
    // Every size either side of it that was built prints no more pieces.
    for (const s of r.steps) if (s.ok) expect(s.pieces!).toBeLessThanOrEqual(chosen.pieces.length);
    expect(islandPrintsWell(chosen).ok).toBe(true);
    for (const q of chosen.pieces) {
      if (q.neighbours) expect(q.joints, q.name).toBeGreaterThanOrEqual(MIN_JOINTS);
      const loops = loopAreas(q.bodies[0]);
      expect(loops.filter((a) => a < 0).length, `piece ${q.name} in bits`).toBe(1);
      expect(loops.filter((a) => a > 0), `piece ${q.name} holes`).toEqual([]);
    }
    expect(slideOut(chosen)).toBe(0);
    const gaps = outlineGaps(chosen);
    expect(gaps.crossings).toBe(0);
    expect(gaps.nearest).toBeGreaterThan(2 * spec.fit - 0.005);
    expect(r.steps.length).toBeLessThanOrEqual(10);
  });
});

describe("the smallest mountain cubes that print well", () => {
  it("finds a cube size through a pretend tile loader, one step smaller not", async () => {
    const sw = { e: 200000, n: 770000 };
    const z = 12;
    const sll = gridToLatLon(sw);
    const [ox, oy] = worldPixel(sll.lat, sll.lon, z);
    // A hill about 1 km high, by world pixel (the tiles' own coordinates).
    const f = (px: number, py: number) => 300 + 1000 * Math.exp(-(((px - ox - 90) / 45) ** 2 + ((py - oy + 70) / 35) ** 2));
    const loader = async (_z: number, tx: number, ty: number): Promise<TilePixels> => {
      const data = new Uint8ClampedArray(256 * 256 * 4);
      for (let j = 0; j < 256; j++)
        for (let i = 0; i < 256; i++) {
          const v = f(tx * 256 + i + 0.5, ty * 256 + j + 0.5) + 32768;
          const k = (j * 256 + i) * 4;
          data[k] = Math.floor(v / 256);
          data[k + 1] = Math.floor(v) % 256;
          data[k + 2] = Math.floor((v % 1) * 256);
          data[k + 3] = 255;
        }
      return { width: 256, height: 256, data };
    };
    const [W, H] = [4000, 3000];
    const grid = await readHeights(loader, sw, W, H);
    // Three times the bed across: the layer limit stops small cubes.
    const spec: MountainSpec = { ...MOUNTAIN_DEFAULTS, bed: [256, 256, 256], snowline: null, scale: 3 };
    const built = new Map<number, MountainPuzzle>();
    const test = async (cube: number): Promise<Verdict> => {
      const s = { ...spec, cube };
      const early = mountainLayoutVerdict(s, layoutFor(grid, W, H, s));
      if (early) return early;
      const p = makeMountainPuzzle(grid, W, H, s);
      built.set(cube, p);
      return mountainPrintsWell(p);
    };
    const floor = mountainFloor(spec.fit);
    const r = await smallestThatPrints({ from: 30, floor, top: 100, step: CUBE_STEP, test });
    expect(r.size).not.toBeNull();
    const size = r.size!;
    expect(size).toBeGreaterThan(floor);
    expect(mountainPrintsWell(built.get(size)!).ok).toBe(true);
    expect(r.steps.some((s) => s.size === size - 1 && !s.ok)).toBe(true);
    expect(r.why).toMatch(/smaller cubes/);
  });
});
