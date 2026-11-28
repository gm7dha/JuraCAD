/** "As many pieces as will print well": the rules (pure) and the search, with a fake builder. */
import { describe, expect, it } from "vitest";
import { ISLAND_COARSE, ISLAND_FLOOR, ISLAND_START, ISLAND_STEP, islandPrintsWell, mostPiecesSize, mountainLayoutVerdict, mountainPrintsWell, resultText, SearchStopped, smallestThatPrints, SMALLER_JOIN_UP, stepsText, undersideParts, type CountedVerdict, type Verdict } from "../src/terrain/mostPieces";
import { islandChecks, ISLAND_DEFAULTS } from "../src/terrain/islandPuzzle";
import { MOUNTAIN_DEFAULTS, type MountainSpec, type PuzzlePiece } from "../src/terrain/mountainPuzzle";
import type { IslandPiece, IslandTab } from "../src/terrain/islandPuzzle";

/** A flat square's underside (two triangles at z = 0), moved along x. */
const square = (x: number) => ({ part: "rock" as const, vertices: [x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 1, 0], triangles: [0, 2, 1, 0, 3, 2] });
const piece = (joints: number, neighbours: number, bits = 1) => ({ joints, neighbours, bodies: [bits === 1 ? square(0) : { part: "rock", vertices: [...square(0).vertices, ...square(3).vertices], triangles: [0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6] }] }) as IslandPiece;
const tab = (neck: number) => ({ neck }) as IslandTab;

describe("islandPrintsWell", () => {
  it("passes a puzzle whose pieces all have two dovetails or are loose islets", () => {
    expect(islandPrintsWell({ pieces: [piece(2, 1), piece(3, 2), piece(0, 0)], tabs: [tab(4), tab(3.5)] }).ok).toBe(true);
  });
  it("fails a dropped dovetail, a thin neck or a weakly held piece, saying why", () => {
    expect(islandPrintsWell({ pieces: [piece(2, 1)], tabs: [tab(4)], droppedTabs: 1 })).toEqual({ ok: false, why: "smaller pieces would make some dovetails too thin to hold" });
    expect(islandPrintsWell({ pieces: [piece(2, 1)], tabs: [tab(3.2)] }).ok).toBe(false);
    expect(islandPrintsWell({ pieces: [piece(1, 1), piece(2, 1)], tabs: [tab(4)] }).why).toMatch(/fewer than two/);
    expect(islandPrintsWell({ pieces: [], tabs: [] }).ok).toBe(false);
  });
  it("fails a piece whose mesh came out in two bits", () => {
    expect(undersideParts(square(0))).toBe(1);
    expect(islandPrintsWell({ pieces: [piece(2, 1), piece(2, 1, 2)], tabs: [tab(4)] }).why).toMatch(/in bits/);
  });
});

describe("mountainPrintsWell", () => {
  const spec = (cube: number): MountainSpec => ({ ...MOUNTAIN_DEFAULTS, cube, bed: [256, 256, 256], snowline: null });
  const p = (layer: number, pocket: boolean, height = 30) => ({ layer, pocket: pocket ? {} : null, height }) as PuzzlePiece;
  it("needs sturdy necks, a key under every piece, no key clashes and pieces the printer can take", () => {
    expect(mountainPrintsWell({ spec: spec(30), pieces: [p(0, false), p(1, true)] }).ok).toBe(true);
    expect(mountainPrintsWell({ spec: spec(12), pieces: [p(0, false)] }).why).toMatch(/necks/);
    expect(mountainPrintsWell({ spec: spec(30), pieces: [p(1, false)] }).why).toMatch(/key/);
    expect(mountainPrintsWell({ spec: spec(30), pieces: [p(1, true)], keyClashes: 2 }).why).toMatch(/wrong pockets/);
    expect(mountainPrintsWell({ spec: spec(30), pieces: [p(1, true, 300)] }).why).toMatch(/taller/);
  });
});

/** A fake builder: sizes from `good` up print well. */
function fake(good: number) {
  const built: number[] = [];
  return {
    built,
    test: async (size: number): Promise<Verdict> => {
      built.push(size);
      return size >= good - 1e-9 ? { ok: true } : { ok: false, why: "smaller pieces would be too small" };
    },
  };
}

describe("smallestThatPrints", () => {
  it("stops at once when the floor prints well", async () => {
    const f = fake(10);
    const r = await smallestThatPrints({ from: 35, floor: 15, top: 150, step: 0.5, test: f.test });
    expect(r.size).toBe(15);
    expect(r.atFloor).toBe(true);
    expect(f.built).toEqual([15]);
  });
  it("finds the smallest good size, having built it and one step smaller, each size once", async () => {
    for (const good of [15.5, 17, 22.5, 34.5, 35, 41]) {
      const f = fake(good);
      const steps: number[] = [];
      const r = await smallestThatPrints({ from: 35, floor: 15, top: 150, step: 0.5, test: f.test, onStep: (s) => steps.push(s.length) });
      expect(r.size, `good from ${good}`).toBe(good);
      expect(f.built).toContain(good);
      expect(f.built).toContain(good - 0.5);
      expect(new Set(f.built).size).toBe(f.built.length);
      expect(r.why).toMatch(/too small/);
      expect(steps.at(-1)).toBe(f.built.length);
      expect(f.built.length).toBeLessThanOrEqual(10);
    }
  });
  it("whole-millimetre steps for cubes, from a floor", async () => {
    const f = fake(23);
    const r = await smallestThatPrints({ from: 30, floor: 18, top: 100, step: 1, test: f.test });
    expect(r.size).toBe(23);
    expect(f.built).toContain(22);
  });
  it("says when nothing up to the top prints well, and keeps to its work cap", async () => {
    const r = await smallestThatPrints({ from: 35, floor: 15, top: 60, step: 0.5, test: fake(1000).test });
    expect(r.size).toBeNull();
    expect(resultText(r, "")).toMatch(/No size/);
    const capped = await smallestThatPrints({ from: 16, floor: 15, top: 150, step: 0.5, test: fake(140).test, most: 4 });
    expect(capped.capped).toBe(true);
    expect(capped.steps.length).toBe(4);
  });
  it("stops when told", async () => {
    let n = 0;
    let thrown: unknown = null;
    try {
      await smallestThatPrints({ from: 35, floor: 15, top: 150, step: 0.5, test: fake(30).test, stopped: () => ++n > 3 });
    } catch (e) {
      thrown = e;
    }
    expect(thrown instanceof SearchStopped).toBe(true);
  });
  it("words its progress and result plainly", async () => {
    const r = await smallestThatPrints({ from: 35, floor: 15, top: 150, step: 0.5, test: fake(20).test });
    expect(stepsText(r.steps)).toMatch(/^15 mm ✗ {2}35 mm ✓/);
    expect(resultText(r, "")).toBe("Smaller pieces would be too small.");
    const floor = await smallestThatPrints({ from: 35, floor: 15, top: 150, step: 0.5, test: fake(1).test });
    expect(resultText(floor, "15 mm is the smallest the window makes")).toBe("15 mm is the smallest the window makes, and it prints well.");
  });
});

describe("mountainLayoutVerdict", () => {
  const spec = (cube: number): MountainSpec => ({ ...MOUNTAIN_DEFAULTS, cube, bed: [256, 256, 256], snowline: null });
  const layout = (cols: number, rows: number, tall = 50) => ({ cols, rows, k: 1, e0: 0, n0: 0, width: 1, height: 1, low: 0, high: tall });
  it("is fine within the limits, and says which limit a smaller cube passes", () => {
    expect(mountainLayoutVerdict(spec(30), layout(8, 8))).toBeNull();
    expect(mountainLayoutVerdict(spec(30), layout(30, 30))?.why).toMatch(/400 cubes/);
    expect(mountainLayoutVerdict(spec(20), layout(5, 5, 2000))?.why).toMatch(/40 layers/);
  });
});

describe("smallestThatPrints looks below what it finds", () => {
  it("takes a smaller size that prints well past one that doesn't", async () => {
    // Prints well from 20 up except 22 (a size where one dovetail happened to be dropped).
    const built: number[] = [];
    const test = async (size: number): Promise<Verdict> => {
      built.push(size);
      return size >= 20 && size !== 22 ? { ok: true } : { ok: false, why: "smaller cubes would be too small" };
    };
    const r = await smallestThatPrints({ from: 30, floor: 15, top: 100, step: 1, test });
    expect(r.size).toBe(20);
    expect(built).toContain(19);
    expect(new Set(built).size).toBe(built.length);
    expect(built.length).toBeLessThanOrEqual(10);
  });
});

/** A fake island builder: the counts measured on the lumpy coast (pattern 1), most at 12 mm. */
const COUNTS: Record<number, number> = { 10: 115, 10.5: 118, 11: 122, 11.5: 126, 12: 129, 12.5: 125, 13: 119, 13.5: 112, 14: 104, 14.5: 98, 15: 93, 16: 87, 17: 81 };
function counted(bad: number[] = []) {
  const built: number[] = [];
  return {
    built,
    test: async (size: number): Promise<CountedVerdict> => {
      built.push(size);
      const pieces = COUNTS[size] ?? Math.round(1500 / size);
      return bad.includes(size) ? { ok: false, why: "smaller pieces would make some dovetails too thin to hold", pieces } : { ok: true, pieces };
    },
  };
}
const island = (f: ReturnType<typeof counted>, most?: number) => mostPiecesSize({ start: ISLAND_START, floor: ISLAND_FLOOR, top: 150, coarse: ISLAND_COARSE, step: ISLAND_STEP, test: f.test, ...(most ? { most } : {}) });

describe("mostPiecesSize (the island: most pieces, not just smallest)", () => {
  it("goes below 15 mm: the window makes pieces from 10 mm", () => {
    expect(ISLAND_FLOOR).toBe(10);
    expect(islandChecks({ ...ISLAND_DEFAULTS, bed: [256, 256, 256], piece: 10 })).toEqual([]);
    expect(islandChecks({ ...ISLAND_DEFAULTS, bed: [256, 256, 256], piece: 9.5 })).not.toEqual([]);
  });
  it("finds the size with the most pieces, having built both sides of it, and says smaller would join up", async () => {
    const f = counted();
    const r = await island(f);
    expect(r.size).toBe(12);
    for (const s of [11, 11.5, 12, 12.5, 13]) expect(f.built).toContain(s);
    expect(new Set(f.built).size).toBe(f.built.length);
    expect(f.built.length).toBeLessThanOrEqual(7);
    expect(r.why).toBe(SMALLER_JOIN_UP);
    expect(resultText(r, "")).toMatch(/^Smaller pieces are too small to hold two dovetails/);
    expect(stepsText(r.steps)).toMatch(/12 mm ✓ 129/);
  });
  it("skips sizes that don't print well, and climbs to where the most are", async () => {
    const f = counted([12, 12.5, 11.5]);
    const r = await island(f);
    expect(r.size).toBe(11);
    expect(f.built).toContain(10);
    // Nothing near the start prints well: it goes up until something does.
    const g = counted([11, 12, 13, 14]);
    const r2 = await island(g);
    expect(r2.size).toBe(14.5);
    expect(r2.why).toMatch(/too thin/);
  });
  it("walks down to the floor when smaller is always more", async () => {
    const f = { built: [] as number[], test: async (size: number): Promise<CountedVerdict> => ({ ok: true, pieces: Math.round(2000 / size) }) };
    const r = await mostPiecesSize({ start: 12, floor: 10, top: 150, coarse: 1, step: 0.5, test: f.test });
    expect(r.size).toBe(10);
    expect(r.atFloor).toBe(true);
  });
  it("stops at once on a problem no size gets round (no land), saying it plainly", async () => {
    const built: number[] = [];
    const r = await mostPiecesSize({ start: 12, floor: 10, top: 150, coarse: 1, step: 0.5, test: async (size) => (built.push(size), { ok: false, why: "There's no land in this area — it's all sea.", pieces: 0, final: true }) });
    expect(r.size).toBeNull();
    expect(built).toEqual([12]);
    expect(resultText(r, "")).toBe("There's no land in this area — it's all sea.");
  });
  it("keeps to its work cap and stops when told", async () => {
    const r = await island(counted([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]), 5);
    expect(r.capped).toBe(true);
    expect(r.steps.length).toBe(5);
    let thrown: unknown = null;
    let n = 0;
    try {
      await mostPiecesSize({ start: 12, floor: 10, top: 150, coarse: 1, step: 0.5, test: counted().test, stopped: () => ++n > 2 });
    } catch (e) {
      thrown = e;
    }
    expect(thrown instanceof SearchStopped).toBe(true);
  });
});

describe("beatsKept", () => {
  it("keeps the puzzle the search would choose: most pieces, ties to the bigger size, never one that doesn't print well", async () => {
    const { beatsKept } = await import("../src/terrain/mostPieces");
    expect(beatsKept(null, 12, { ok: true, pieces: 90 })).toBe(true);
    expect(beatsKept(null, 12, { ok: false, pieces: 90 })).toBe(false);
    expect(beatsKept({ size: 12, pieces: 90 }, 11, { ok: true, pieces: 99 })).toBe(true);
    expect(beatsKept({ size: 12, pieces: 90 }, 13, { ok: true, pieces: 85 })).toBe(false);
    expect(beatsKept({ size: 12, pieces: 90 }, 13, { ok: true, pieces: 90 })).toBe(true);
    expect(beatsKept({ size: 12, pieces: 90 }, 11, { ok: true, pieces: 90 })).toBe(false);
  });
});
