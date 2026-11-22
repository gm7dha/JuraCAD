/**
 * Island puzzle's area (pure): an OpenStreetMap file's box as the area, its marks on the island, and trimming the area
 * in from each side before the island is built — no trim makes exactly the old puzzle.
 */
import { describe, expect, it } from "vitest";
import { gridFrom, heightAt } from "../src/terrain/elevation";
import { areaInside, osmIslandArea, trimmedIsland } from "../src/terrain/islandArea";
import { featuresForIsland, ISLAND_DEFAULTS, makeIslandPuzzle, type IslandSpec } from "../src/terrain/islandPuzzle";
import { NO_TRIM } from "../src/terrain/mountainCrop";
import { featuresOnGrid, readOsm } from "../src/terrain/osm";
import { sampleOsm } from "./support/osmSample";

const sw = { e: 200500, n: 770000 };
const W = 5000;
const H = 4000;
// Two islands side by side: a big one to the west and a small one to the east.
const grid = gridFrom(sw, W, H, 25, (e, n) => {
  const a = (1 - Math.hypot((e - 202200) / 1400, (n - 772000) / 1500)) * 300;
  const b = (1 - Math.hypot((e - 204500) / 350, (n - 772000) / 350)) * 120;
  return Math.max(0, a, b);
});
const SPEC: IslandSpec = { ...ISLAND_DEFAULTS, bed: [180, 180, 180], land: "all" };
const area = { sw, width: W, height: H };

const sig = (p: ReturnType<typeof makeIslandPuzzle>) =>
  JSON.stringify([p.width, p.height, p.origin, p.k, p.pieces.length, p.pieces.map((q) => [q.name, q.bodies.map((b) => [b.vertices.length, Array.from(b.vertices.slice(0, 30))])])]);

describe("island area from an OpenStreetMap file", () => {
  it("takes the file's box on the OS grid", () => {
    const a = osmIslandArea(readOsm(sampleOsm()), "My map");
    expect(typeof a).not.toBe("string");
    if (typeof a === "string") return;
    expect(a.name).toBe("My map");
    // The sample covers about 201000–205000 E, 770500–773500 N.
    expect(a.sw.e).toBeGreaterThan(200900);
    expect(a.sw.e).toBeLessThan(201200);
    expect(a.width).toBeGreaterThan(3500);
    expect(a.height).toBeGreaterThan(2500);
  });

  it("refuses a map outside Great Britain, naming the island puzzle", () => {
    const paris = `<?xml version="1.0"?><osm version="0.6"><bounds minlat="48.85" minlon="2.33" maxlat="48.86" maxlon="2.35"/><node id="1" lat="48.855" lon="2.34"/></osm>`;
    const a = osmIslandArea(readOsm(paris), "Paris");
    expect(typeof a).toBe("string");
    expect(a as string).toMatch(/outside Great Britain — the Island puzzle/);
  });

  it("presses the file's marks into the island", () => {
    const f = featuresOnGrid(readOsm(sampleOsm()), "water");
    const p = makeIslandPuzzle(grid, sw, W, H, SPEC, undefined, f);
    expect(featuresForIsland(f, p.k).features.lines.length).toBeGreaterThan(0);
    expect(p.marks.shown).toBeGreaterThan(0);
  });
});

describe("trimming the island's area", () => {
  it("leaves the grid and corner alone with no trim, so the puzzle is the same", () => {
    const t = trimmedIsland(area, grid, NO_TRIM);
    expect(t.grid).toBe(grid);
    expect(t.sw).toBe(sw);
    expect([t.width, t.height]).toEqual([W, H]);
    expect(sig(makeIslandPuzzle(t.grid, t.sw, t.width, t.height, SPEC))).toBe(sig(makeIslandPuzzle(grid, sw, W, H, SPEC)));
  });

  it("moves the corner by whole steps and keeps the heights where they were", () => {
    const t = trimmedIsland(area, grid, { n: 0.1, e: 0.3, s: 0.05, w: 0.2 });
    expect(t.sw.e).toBe(sw.e + 1000);
    expect(t.sw.n).toBe(sw.n + 200);
    expect(t.width).toBe(W - 1000 - 1500);
    expect(t.height).toBe(H - 200 - 400);
    expect(t.grid.e0).toBe(t.sw.e);
    expect(t.grid.n0).toBe(t.sw.n);
    for (const [e, n] of [
      [202000, 772000],
      [203000, 771000],
    ])
      expect(heightAt(t.grid, e, n)).toBeCloseTo(heightAt(grid, e, n), 4);
    expect(areaInside(t, area)).toBe(true);
    expect(areaInside(area, t)).toBe(false);
  });

  it("builds only what's left: trimming the east drops the small island", () => {
    const whole = makeIslandPuzzle(grid, sw, W, H, { ...SPEC, land: "islands" });
    const t = trimmedIsland(area, grid, { ...NO_TRIM, e: 0.3 });
    const cut = makeIslandPuzzle(t.grid, t.sw, t.width, t.height, { ...SPEC, land: "islands" });
    expect(cut.origin).toEqual(t.sw);
    expect(cut.pieces.length).toBeGreaterThan(0);
    // The same scale fits a smaller area bigger on the bed.
    expect(cut.k).toBeGreaterThan(whole.k);
    // Put together, the area is cropped to the land the trim leaves.
    const placed = makeIslandPuzzle(t.grid, t.sw, t.width, t.height, { ...SPEC, inPlace: true });
    expect(placed.origin.e).toBeGreaterThanOrEqual(t.sw.e);
    expect(placed.origin.e + placed.width / placed.k).toBeLessThanOrEqual(t.sw.e + t.width + 1);
  });
});

describe("a trim is only a frame: which land is kept is decided on the whole area", () => {
  // A trim from the west cuts through the big island (it runs 200800–203600 E); the small one stays whole.
  const westCut = { ...NO_TRIM, w: 0.2 };
  const rule = (land: IslandSpec["land"], only?: IslandSpec["only"]) => ({ sea: SPEC.sea, land, only });
  const build = (t: ReturnType<typeof trimmedIsland>, spec: IslandSpec, features?: Parameters<typeof makeIslandPuzzle>[6]) =>
    makeIslandPuzzle(t.grid, t.sw, t.width, t.height, t.decided ? { ...spec, land: "all", only: undefined } : spec, undefined, features);

  it("keeps an island the trim cuts through (it isn't mainland)", () => {
    // Decided on the trimmed area alone, the cut island would touch its edge and be dropped, leaving only the small one.
    const naive = trimmedIsland(area, grid, westCut);
    expect(makeIslandPuzzle(naive.grid, naive.sw, naive.width, naive.height, { ...SPEC, land: "islands" }).high).toBeLessThan(150);
    const t = trimmedIsland(area, grid, westCut, rule("islands"));
    expect(t.decided).toBe(true);
    expect(build(t, { ...SPEC, land: "islands" }).high).toBeGreaterThan(250);
  });

  it("still leaves out land running off the whole area's edge", () => {
    // Mainland (500 m) along the east edge, the island in the middle-west; a trim from the west cuts the island.
    const g = gridFrom(sw, W, H, 25, (e, n) => Math.max(0, (1 - Math.hypot((e - 202200) / 1400, (n - 772000) / 1500)) * 300, e > 204700 ? 500 : 0));
    const t = trimmedIsland(area, g, westCut, rule("islands"));
    expect(t.notes.join(" ")).toMatch(/running off the edge/);
    const p = build(t, { ...SPEC, land: "islands" });
    expect(p.high).toBeGreaterThan(250);
    expect(p.high).toBeLessThan(400);
  });

  it("keeps a list island's own land whole when the trim cuts it", () => {
    const only = { keep: [{ e: 202200, n: 772000 }] };
    const t = trimmedIsland(area, grid, westCut, rule("islands", only));
    expect(t.decided).toBe(true);
    const p = build(t, { ...SPEC, only });
    expect(p.high).toBeGreaterThan(250);
    // The small island to the east isn't the list island's.
    expect(p.pieces.every((q) => q.outline[2][0] / p.k + p.origin.e < 204000)).toBe(true);
    expect(p.warnings.join(" ")).not.toMatch(/cut free|joined to other land/);
  });

  it("changes nothing without a trim, whatever the rule", () => {
    const t = trimmedIsland(area, grid, NO_TRIM, rule("islands", { keep: [{ e: 202200, n: 772000 }] }));
    expect(t.grid).toBe(grid);
    expect(t.decided).toBe(false);
  });

  it("puts a path at the same place on the map with and without a trim", () => {
    // A straight path across the big island, north–south through 202200 E.
    const features = { lines: [{ kind: "path" as const, pts: [[202200, 770900], [202200, 773100]] as [number, number][], thin: true as const, ids: ["w1"] }], shapes: [], names: [] };
    const trims = [NO_TRIM, { n: 0.1, e: 0.25, s: 0.08, w: 0.15 }];
    for (const trim of trims) {
      const t = trimmedIsland(area, grid, trim, rule("all"));
      const p = build(t, { ...SPEC, land: "all" }, features);
      expect(p.marks.lines.length).toBeGreaterThan(0);
      // Every drawn point, back on the map, lies on the path.
      for (const l of p.marks.lines) for (const [x, y] of l.pts) expect(Math.abs(p.origin.e + x / p.k - 202200)).toBeLessThan(2);
      // And the groove is pressed in there, not beside it.
      for (const n of [771400, 772600]) {
        const at = (e: number) => p.groundAt((e - p.origin.e) * p.k, (n - p.origin.n) * p.k);
        expect(at(202200)).toBeLessThan((at(202140) + at(202260)) / 2 - 0.2);
      }
    }
  });
});
