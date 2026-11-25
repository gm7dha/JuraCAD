/** "As many pieces as will print well": the rules (pure) and the search, with a fake builder. */
import { describe, expect, it } from "vitest";
import { islandPrintsWell, mountainLayoutVerdict, mountainPrintsWell, resultText, SearchStopped, smallestThatPrints, stepsText, type Verdict } from "../src/terrain/mostPieces";
import { MOUNTAIN_DEFAULTS, type MountainSpec, type PuzzlePiece } from "../src/terrain/mountainPuzzle";
import type { IslandPiece, IslandTab } from "../src/terrain/islandPuzzle";

const piece = (joints: number, neighbours: number) => ({ joints, neighbours }) as IslandPiece;
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
