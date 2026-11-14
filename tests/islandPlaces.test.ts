/**
 * Island puzzle, one island only (pure): a list entry's keep points keep just its land, and land the height data joins
 * on (a bridge, narrows) is cut free at the narrowest neck. The list's boxes hold their points; the older entries are
 * unchanged.
 */
import { describe, expect, it } from "vitest";
import { gridFrom } from "../src/terrain/elevation";
import { ISLANDS } from "../src/terrain/islands";
import { ISLAND_DEFAULTS, keepOnly, makeIslandPuzzle, onlyCells, type IslandPuzzle, type IslandSpec } from "../src/terrain/islandPuzzle";
import { latLonToGrid } from "../src/terrain/osGrid";

const SPEC: IslandSpec = { ...ISLAND_DEFAULTS, bed: [256, 256, 256] };
const sw = { e: 300000, n: 700000 };
const W = 8000;
const H = 4000;

/** x range (m east of sw) the pieces' footprints cover. */
const spanE = (p: IslandPuzzle) => {
  const xs = p.pieces.flatMap((q) => q.outline.map((pt) => pt[0]));
  return [Math.min(...xs) / p.k, Math.max(...xs) / p.k];
};

// An island (a dome round x = 2.5 km) joined by a thin causeway (80 m wide) to a mainland that runs off the east edge.
const dome = (x: number, y: number, cx: number, r: number) => Math.max(0, 300 * (1 - Math.hypot(x - cx, y - 2000) / r));
const joined = gridFrom(sw, W, H, 20, (e, n) => {
  const [x, y] = [e - sw.e, n - sw.n];
  const causeway = x > 3900 && x < 5600 && Math.abs(y - 2000) < 40 ? 5 : 0;
  const mainland = x > 5500 ? 80 : 0;
  return Math.max(dome(x, y, 2500, 1500), causeway, mainland);
});

describe("one island only", () => {
  it("cuts an island free of the mainland it's joined to and keeps only it", () => {
    // As before: the island and mainland are one, running off the edge, so "every island" finds no island at all.
    expect(() => makeIslandPuzzle(joined, sw, W, H, SPEC)).not.toThrow();
    const all = makeIslandPuzzle(joined, sw, W, H, { ...SPEC, land: "all" });
    expect(spanE(all)[1]).toBeGreaterThan(7500);
    const only = { keep: [{ e: sw.e + 2500, n: sw.n + 2000 }] };
    for (const land of ["islands", "biggest", "all"] as const) {
      const p = makeIslandPuzzle(joined, sw, W, H, { ...SPEC, land, only });
      const [x0, x1] = spanE(p);
      expect(x0).toBeGreaterThan(900);
      // The island reaches 4 km; at most a stub of the causeway is left on it.
      expect(x1).toBeLessThan(4900);
      expect(x1).toBeGreaterThan(3800);
      expect(p.warnings.join(" ")).toMatch(/cut free/);
      expect(p.warnings.join(" ")).toMatch(/Only the island itself/);
    }
    // Put together, the area is cut down to the island alone too.
    const placed = makeIslandPuzzle(joined, sw, W, H, { ...SPEC, inPlace: true, only });
    expect(placed.origin.e - sw.e + spanE(placed)[1]).toBeLessThan(4900);
  });

  it("parts two islands joined by a bridge when the other one is named", () => {
    const pair = gridFrom(sw, W, H, 20, (e, n) => {
      const [x, y] = [e - sw.e, n - sw.n];
      const bridge = x > 3000 && x < 5000 && Math.abs(y - 2000) < 30 ? 5 : 0;
      // And a little islet that's no part of either.
      const islet = Math.hypot(x - 4000, y - 3500) < 150 ? 20 : 0;
      return Math.max(dome(x, y, 2000, 1200), dome(x, y, 6000, 1200), bridge, islet);
    });
    const keepOnlyA = { keep: [{ e: sw.e + 2000, n: sw.n + 2000 }] };
    // Not named: they're one piece of land as far as the data goes, so both stay; the islet goes.
    const both = makeIslandPuzzle(pair, sw, W, H, { ...SPEC, only: keepOnlyA });
    expect(spanE(both)[1]).toBeGreaterThan(7000);
    const a = makeIslandPuzzle(pair, sw, W, H, { ...SPEC, only: { ...keepOnlyA, apart: [{ e: sw.e + 6000, n: sw.n + 2000 }] } });
    expect(spanE(a)[1]).toBeLessThan(4200);
    expect(spanE(a)[0]).toBeGreaterThan(700);
    // Kept the other way round.
    const b = makeIslandPuzzle(pair, sw, W, H, { ...SPEC, only: { keep: [{ e: sw.e + 6000, n: sw.n + 2000 }], apart: [{ e: sw.e + 2000, n: sw.n + 2000 }] } });
    expect(spanE(b)[0]).toBeGreaterThan(3800);
  });

  it("finds the island when a point falls just off its coast, and says so when it's not there", () => {
    const nx = 40;
    const ny = 20;
    const land = new Uint8Array(nx * ny);
    for (let j = 5; j < 15; j++) for (let i = 5; i < 15; i++) land[j * nx + i] = 1;
    for (let j = 5; j < 15; j++) for (let i = 25; i < 35; i++) land[j * nx + i] = 1;
    const warnings: string[] = [];
    const a = Uint8Array.from(land);
    expect(keepOnly(a, nx, ny, { keep: [[16.5, 10]], apart: [], reach: 4, widest: 5 }, warnings)).toBe(true);
    expect(a.slice(0).reduce((s, v) => s + v, 0)).toBe(100);
    expect(a[10 * nx + 30]).toBe(0);
    const b = Uint8Array.from(land);
    expect(keepOnly(b, nx, ny, { keep: [[20, 10]], apart: [], reach: 2, widest: 5 }, [])).toBe(false);
    expect(b).toEqual(land);
  });

  it("works out points on the grid's own cells", () => {
    const c = onlyCells({ keep: [{ e: 1150, n: 2025 }], apart: [{ e: 900, n: 1000 }] }, { e: 1000, n: 2000 }, 50);
    expect(c.keep[0]).toEqual([3, 0.5]);
    expect(c.apart[0]).toEqual([-2, -20]);
    expect(c.reach).toBe(40);
  });

  it("makes a sensible puzzle of a tiny island like Ailsa Craig", () => {
    const ailsa = ISLANDS.find((i) => i.id === "ailsa-craig")!;
    const c = latLonToGrid({ lat: 55.2525, lon: -5.1158 });
    // About 1.2 × 0.9 km, 338 m high and steep, read 15 m apart as the window does.
    const grid = gridFrom(ailsa.sw, ailsa.width, ailsa.height, 15, (e, n) => {
      const r = Math.hypot((e - c.e) / 450, (n - c.n) / 600);
      return r < 1 ? 20 + 318 * Math.sqrt(1 - r * r) : 0;
    });
    const p = makeIslandPuzzle(grid, ailsa.sw, ailsa.width, ailsa.height, { ...SPEC, only: ailsa.only });
    expect(p.pieces.length).toBeGreaterThanOrEqual(3);
    expect(p.pieces.length).toBeLessThanOrEqual(12);
    expect(p.loose).toBe(0);
    const ys = p.pieces.flatMap((q) => q.outline.map((pt) => pt[1]));
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(80);
    const placed = makeIslandPuzzle(grid, ailsa.sw, ailsa.width, ailsa.height, { ...SPEC, only: ailsa.only, inPlace: true });
    expect(placed.pieces.length).toBeGreaterThanOrEqual(4);
  });
});

describe("the list of islands", () => {
  it("has the new islands in their places", () => {
    expect(ISLANDS.map((i) => i.id)).toEqual(["great-britain", "arran", "ailsa-craig", "wight", "man", "anglesey", "mull", "islay", "jura", "skye", "lewis-harris", "orkney", "shetland"]);
    for (const id of ["ailsa-craig", "islay", "jura", "skye"]) expect(ISLANDS.find((i) => i.id === id)?.only, id).toBeDefined();
  });

  it("holds every keep and apart point well inside its box", () => {
    for (const i of ISLANDS) {
      for (const p of [...(i.only?.keep ?? []), ...(i.only?.apart ?? [])]) {
        const margin = Math.min(p.e - i.sw.e, i.sw.e + i.width - p.e, p.n - i.sw.n, i.sw.n + i.height - p.n);
        expect(margin, i.name).toBeGreaterThan(i.width < 10000 ? 1000 : 3000);
      }
    }
  });

  it("leaves the other islands exactly as they were", () => {
    const before: [string, number, number, number, number][] = [
      ["great-britain", 0, 0, 665000, 1230000],
      ["arran", 181134, 616524, 32000, 40000],
      ["wight", 424444, 71807, 46000, 28000],
      ["man", 212882, 454590, 42000, 60000],
      ["anglesey", 216085, 357512, 52000, 42000],
      ["mull", 120525, 711005, 60000, 50000],
      ["islay", 109223, 638109, 46000, 44000],
      ["skye", 101105, 788487, 90000, 92000],
      ["lewis-harris", 91133, 869279, 70000, 105000],
      ["orkney", 312482, 978573, 72000, 82000],
      ["shetland", 390962, 1101677, 90000, 125000],
    ];
    for (const [id, e, n, width, height] of before) {
      const i = ISLANDS.find((x) => x.id === id)!;
      expect({ e: i.sw.e, n: i.sw.n, width: i.width, height: i.height }, id).toEqual({ e, n, width, height });
      if (id !== "islay" && id !== "skye") expect(i.only, id).toBeUndefined();
    }
  });

  it("builds the same puzzle as before without an island's own points", () => {
    const g = gridFrom(sw, W, H, 25, (e, n) => dome(e - sw.e, n - sw.n, 3000, 1400));
    const a = makeIslandPuzzle(g, sw, W, H, SPEC);
    const b = makeIslandPuzzle(g, sw, W, H, { ...SPEC, only: undefined });
    expect(JSON.stringify(b.pieces)).toBe(JSON.stringify(a.pieces));
    expect(a.warnings.join(" ")).not.toMatch(/island itself/);
  });
});
