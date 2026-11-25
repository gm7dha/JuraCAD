/**
 * "As many pieces as will print well" on real builds (pure, but heavy: its own file). An island on a test coast and a
 * mountain read through a pretend tile loader: the size found prints well, and the size one step smaller was built and
 * doesn't.
 */
import { describe, expect, it } from "vitest";
import { gridFrom, readHeights, worldPixel, type TilePixels } from "../src/terrain/elevation";
import { ISLAND_DEFAULTS, makeIslandPuzzle, type IslandPuzzle } from "../src/terrain/islandPuzzle";
import { layoutFor, makeMountainPuzzle, MOUNTAIN_DEFAULTS, type MountainPuzzle, type MountainSpec } from "../src/terrain/mountainPuzzle";
import { CUBE_STEP, ISLAND_STEP, islandPrintsWell, mountainFloor, mountainLayoutVerdict, mountainPrintsWell, smallestThatPrints, type Verdict } from "../src/terrain/mostPieces";
import { gridToLatLon } from "../src/terrain/osGrid";
import { collides, outlineSegs, SegGrid } from "./support/outlineGeom";

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

describe("the smallest island pieces that print well", () => {
  const W = 6000;
  const H = 4000;
  const sw = { e: 300000, n: 700000 };
  // islandOneSolid's low coast: at pattern 1, 17 mm pieces leave a dovetail too thin to hold.
  const low = gridFrom(sw, W, H, 25, (e, n) => {
    const [x, y] = [(e - sw.e) / W - 0.5, (n - sw.n) / H - 0.5];
    const a = Math.atan2(y, x);
    return Math.max(0, (1 - (Math.hypot(x / 0.42, y / 0.4) + 0.12 * Math.sin(a * 9) + 0.07 * Math.sin(a * 23 + 1) + 0.04 * Math.sin(e / 70) * Math.cos(n / 80))) * 25);
  });
  it("finds a size that prints well, one step smaller not", async () => {
    const built = new Map<number, IslandPuzzle>();
    const test = async (piece: number): Promise<Verdict> => {
      const p = makeIslandPuzzle(low, sw, W, H, { ...ISLAND_DEFAULTS, bed: [256, 256, 256], piece, seed: 1 });
      built.set(piece, p);
      return islandPrintsWell(p);
    };
    // The window's floor is 15 mm; 17 here, so there's something to find above it.
    const r = await smallestThatPrints({ from: 20, floor: 17, top: 150, step: ISLAND_STEP, test });
    expect(r.size).not.toBeNull();
    const size = r.size!;
    expect(size).toBeGreaterThan(17);
    const chosen = built.get(size)!;
    expect(islandPrintsWell(chosen).ok).toBe(true);
    expect(slideOut(chosen)).toBe(0);
    const smaller = built.get(size - ISLAND_STEP)!;
    expect(smaller, "one step smaller was built").toBeTruthy();
    expect(islandPrintsWell(smaller).ok).toBe(false);
    expect(r.why).toMatch(/smaller pieces/);
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
