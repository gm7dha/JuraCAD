/**
 * Island puzzle, one island only (pure): a list entry's keep points keep just its land, and land the height data joins
 * on (a bridge, narrows) is cut free at the narrowest neck. The list's boxes hold their points; the older entries are
 * unchanged.
 */
import { describe, expect, it } from "vitest";
import { gridFrom } from "../src/terrain/elevation";
import { ISLANDS } from "../src/terrain/islands";
import { APART_REACH, ISLAND_DEFAULTS, keepOnly, makeIslandPuzzle, onlyCells, type IslandPuzzle, type IslandSpec } from "../src/terrain/islandPuzzle";
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
    const lost: string[] = [];
    expect(keepOnly(b, nx, ny, { keep: [[20, 10]], apart: [], reach: 2, widest: 5 }, lost)).toBe(false);
    expect(lost.join(" ")).toMatch(/usual Land choice/);
    expect(b).toEqual(land);
  });

  it("says so when cutting free hands a piece of the island to the other side", () => {
    const [nx, ny] = [60, 30];
    const land = new Uint8Array(nx * ny);
    const fill = (i0: number, i1: number, j0: number, j1: number) => {
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) land[j * nx + i] = 1;
    };
    fill(2, 20, 2, 27); // the island
    fill(45, 59, 0, 29); // the mainland, off the edge
    fill(21, 44, 14, 16); // a causeway three cells wide
    fill(33, 43, 18, 28); // a lobe hanging off it by a one-cell waist, nearer the mainland
    fill(38, 38, 17, 17);
    const warnings: string[] = [];
    expect(keepOnly(land, nx, ny, { keep: [[10, 14]], apart: [], reach: 4, widest: 8 }, warnings)).toBe(true);
    expect(land[5 * nx + 10]).toBe(1);
    expect(land[15 * nx + 50]).toBe(0);
    expect(land[23 * nx + 38]).toBe(0);
    expect(warnings.join(" ")).toMatch(/cut free/);
    expect(warnings.join(" ")).toMatch(/sizeable piece/);
    // Without the lobe, only the causeway goes, and nothing more is said.
    const plain = new Uint8Array(nx * ny);
    for (let c = 0; c < nx * ny; c++) plain[c] = land[c];
    const again = new Uint8Array(nx * ny);
    for (let j = 2; j <= 27; j++) for (let i = 2; i <= 20; i++) again[j * nx + i] = 1;
    for (let j = 0; j <= 29; j++) for (let i = 45; i <= 59; i++) again[j * nx + i] = 1;
    for (let j = 14; j <= 16; j++) for (let i = 21; i <= 44; i++) again[j * nx + i] = 1;
    const quiet: string[] = [];
    keepOnly(again, nx, ny, { keep: [[10, 14]], apart: [], reach: 4, widest: 8 }, quiet);
    expect(quiet.join(" ")).toMatch(/cut free/);
    expect(quiet.join(" ")).not.toMatch(/sizeable piece/);
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

// Arran and Holy Isle (the owner's report): a big island, and a long thin islet off its east coast joined to it by two
// strips the height data reads as land (the narrow sounds), so the bay between them — shallows read just above 0 m,
// under the sea line — is closed in and was filled as land.
const AW = 8000;
const AH = 6000;
const islet = (x: number, y: number) => {
  const r = Math.hypot((x - 6200) / 300, (y - 3000) / 1200);
  return r < 1 ? 20 + 200 * (1 - r) : 0;
};
const arranLike = (bay: number) =>
  gridFrom(sw, AW, AH, 20, (e, n) => {
    const [x, y] = [e - sw.e, n - sw.n];
    const main = Math.max(0, 400 * (1 - Math.hypot(x - 3000, y - 3000) / 2500));
    const sounds = x > 4800 && x < 6300 && Math.abs(Math.abs(y - 3000) - 1150) < 60 ? 3 : 0;
    const shallows = x > 4800 && x < 6100 && Math.abs(y - 3000) < 1150 ? bay : 0;
    return Math.max(main, islet(x, y), sounds, shallows);
  });
const mainAlone = gridFrom(sw, AW, AH, 20, (e, n) => Math.max(0, 400 * (1 - Math.hypot(e - sw.e - 3000, n - sw.n - 3000) / 2500)));
const landArea = (p: IslandPuzzle) => p.pieces.reduce((s, q) => s + q.area, 0);
const arranOnly = { keep: [{ e: sw.e + 3000, n: sw.n + 3000 }], apart: [{ e: sw.e + 6200, n: sw.n + 3000 }] };

describe("an island with an islet joined across a bay (Arran and Holy Isle)", () => {
  it("drops the islet and leaves the bay as sea", () => {
    const grid = arranLike(0.2);
    const lone = makeIslandPuzzle(mainAlone, sw, AW, AH, SPEC);
    const alone = landArea(lone);
    // As it was: the islet kept and the bay filled in.
    const before = makeIslandPuzzle(grid, sw, AW, AH, SPEC);
    expect(spanE(before)[1]).toBeGreaterThan(6400);
    expect(landArea(before)).toBeGreaterThan(alone * 1.1);
    expect(before.warnings.join(" ")).toMatch(/filled in/);
    for (const spec of [SPEC, { ...SPEC, inPlace: true }]) {
      const p = makeIslandPuzzle(grid, sw, AW, AH, { ...spec, only: arranOnly });
      expect(spanE(p)[1] + (p.origin.e - sw.e)).toBeLessThan(5900);
      // Put together, the area is first cut down to the island (cut free on a coarser grid), so there's nothing left to part.
      if (!spec.inPlace) expect(p.warnings.join(" ")).toMatch(/cut free/);
      expect(p.warnings.join(" ")).not.toMatch(/filled in|too broadly/);
      // Only the stubs of the two sounds are left on the island.
      const k2 = (p.k / lone.k) ** 2;
      expect(landArea(p)).toBeLessThan(alone * k2 * 1.04);
    }
  });

  it("cuts the islet free even when the whole bay reads as low land", () => {
    const p = makeIslandPuzzle(arranLike(3), sw, AW, AH, { ...SPEC, only: arranOnly });
    expect(spanE(p)[1]).toBeLessThan(6000);
    expect(p.warnings.join(" ")).toMatch(/cut free/);
    expect(p.warnings.join(" ")).not.toMatch(/too broadly/);
    // Cut through ground the data may have read from the sea: it says so, as a bit of the bay may be left.
    expect(p.warnings.join(" ")).toMatch(/low ground/);
    // Parted by shape alone, that isn't said.
    expect(makeIslandPuzzle(arranLike(0.2), sw, AW, AH, { ...SPEC, only: arranOnly }).warnings.join(" ")).not.toMatch(/low ground/);
  });

  it("never cuts away land holding a keep point when parting through low ground", () => {
    // 100 m cells: a hill and an islet joined by a broad flat 3 m high.
    const [gx, gy] = [60, 30];
    const h = (c: number) => {
      const [i, j] = [c % gx, Math.floor(c / gx)];
      const flat = i > 15 && i < 45 && Math.abs(j - 15) < 8 ? 3 : 0;
      return Math.max(300 - 30 * Math.hypot(i - 15, j - 15), 200 - 60 * Math.hypot(i - 45, j - 15), flat, 0);
    };
    const run = (keep: [number, number][]) => {
      const isl = new Uint8Array(gx * gy);
      for (let c = 0; c < isl.length; c++) isl[c] = h(c) > 0.5 ? 1 : 0;
      const w: string[] = [];
      keepOnly(isl, gx, gy, { keep, apart: [[45, 15]], reach: 20, widest: 15 }, w, h);
      return { isl, w: w.join(" ") };
    };
    // The hill alone: the islet is cut free across the flat.
    const one = run([[15, 15]]);
    expect(one.isl[15 * gx + 45]).toBe(0);
    expect(one.w).toMatch(/cut free/);
    // A keep point on the flat near the islet: cutting there would take it, so it's all kept and said.
    const two = run([[15, 15], [38, 15]]);
    expect(two.isl[15 * gx + 38]).toBe(1);
    expect(two.w).toMatch(/too broadly/);
  });

  it("still fills a small sea-level hole in the island, even round an islet that's left out", () => {
    // A lagoon 0 m high (a gap the data holds at sea level) inside the island, with a speck of land in it.
    const lagoon = gridFrom(sw, AW, AH, 20, (e, n) => {
      const [x, y] = [e - sw.e, n - sw.n];
      const r = Math.hypot(x - 3500, y - 3000);
      if (r < 40) return 5;
      if (r < 120) return 0;
      return Math.max(0, 400 * (1 - Math.hypot(x - 3000, y - 3000) / 2500));
    });
    const p = makeIslandPuzzle(lagoon, sw, AW, AH, { ...SPEC, only: arranOnly });
    expect(p.warnings.join(" ")).toMatch(/filled in/);
  });

  it("an apart point on sea doesn't reach the island", () => {
    // An apart point 1 km off the island (an islet the data hasn't got) finds nothing to part.
    const [gx, gy] = [40, 20];
    const isl = new Uint8Array(gx * gy);
    for (let j = 5; j < 15; j++) for (let i = 5; i < 15; i++) isl[j * gx + i] = 1;
    const quiet: string[] = [];
    const cellM = 100;
    keepOnly(isl, gx, gy, { keep: [[10, 10]], apart: [[25, 10]], reach: 2000 / cellM, apartReach: APART_REACH / cellM, widest: 15 }, quiet);
    expect(quiet.join(" ")).not.toMatch(/too broadly/);
    expect(isl.reduce((s, v) => s + v, 0)).toBe(100);
  });
});

describe("the list of islands", () => {
  it("has the new islands in their places", () => {
    expect(ISLANDS.map((i) => i.id)).toEqual(["great-britain", "arran", "ailsa-craig", "wight", "man", "anglesey", "mull", "islay", "jura", "skye", "lewis-harris", "orkney", "shetland"]);
    for (const id of ["arran", "ailsa-craig", "wight", "anglesey", "mull", "islay", "jura", "skye"]) expect(ISLANDS.find((i) => i.id === id)?.only, id).toBeDefined();
  });

  it("holds every keep and apart point well inside its box", () => {
    for (const i of ISLANDS) {
      // Apart points may sit nearer the edge (Pladda, off Arran's south coast): they're on other land, not the island.
      for (const [p, most] of [...(i.only?.keep ?? []).map((q) => [q, 3000] as const), ...(i.only?.apart ?? []).map((q) => [q, 2000] as const)]) {
        const margin = Math.min(p.e - i.sw.e, i.sw.e + i.width - p.e, p.n - i.sw.n, i.sw.n + i.height - p.n);
        expect(margin, i.name).toBeGreaterThan(i.width < 10000 ? 1000 : most);
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
      if (!["islay", "skye", "arran", "wight", "anglesey", "mull"].includes(id)) expect(i.only, id).toBeUndefined();
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

// Mull (the owner's map): Mull itself, without Ulva, Gometra, Inch Kenneth, Erraid, Iona, Calve Island or the mainland,
// with its sea lochs left as sea.
describe("the Isle of Mull", () => {
  const mull = ISLANDS.find((i) => i.id === "mull")!;
  const at = (lat: number, lon: number) => latLonToGrid({ lat, lon });
  const near = (a: { e: number; n: number }, b: { e: number; n: number }) => Math.hypot(a.e - b.e, a.n - b.n);

  it("keeps Mull by points across it and parts the islands off it", () => {
    const only = mull.only!;
    expect(only.keep.length).toBeGreaterThanOrEqual(6);
    // Ben More, and the Ross of Mull's end inland from Fionnphort.
    expect(only.keep.some((p) => near(p, at(56.4246, -6.0136)) < 300)).toBe(true);
    expect(only.keep.some((p) => near(p, at(56.325, -6.345)) < 500)).toBe(true);
    // Ulva, Gometra, Inch Kenneth, Erraid, Iona, Calve Island, Morvern.
    for (const [lat, lon] of [[56.48, -6.205], [56.49, -6.289], [56.4417, -6.1632], [56.294, -6.369], [56.334, -6.41], [56.6175, -6.0423], [56.556, -5.826]])
      expect(only.apart!.some((p) => near(p, at(lat, lon)) < 500), `${lat}, ${lon}`).toBe(true);
    // Every apart point well clear of every keep point (the keep points' reach can't land on another island).
    for (const a of only.apart!) for (const k of only.keep) expect(near(a, k)).toBeGreaterThan(3000);
    // Loch Spelve, Loch Don, Loch na Keal and Loch Scridain, in the box and clear of the keep points.
    expect(only.sea!.length).toBe(4);
    for (const p of only.sea!) {
      expect(p.e > mull.sw.e && p.e < mull.sw.e + mull.width && p.n > mull.sw.n && p.n < mull.sw.n + mull.height).toBe(true);
      for (const k of only.keep) expect(near(p, k)).toBeGreaterThan(2000);
    }
  });

  // A sea loch whose mouth the height data closes: small enough on the puzzle to be filled in as a gap, unless it's named.
  const withLoch = gridFrom(sw, AW, AH, 20, (e, n) => {
    const [x, y] = [e - sw.e, n - sw.n];
    if (x > 3800 && x < 4100 && Math.abs(y - 3000) < 100) return -2;
    return Math.max(0, 400 * (1 - Math.hypot(x - 3000, y - 3000) / 2500));
  });
  const keepIt = [{ e: sw.e + 3000, n: sw.n + 3000 }];
  const loch = [{ e: sw.e + 3950, n: sw.n + 3000 }];

  it("leaves a named sea loch as sea when its mouth is closed", () => {
    const filled = makeIslandPuzzle(withLoch, sw, AW, AH, { ...SPEC, only: { keep: keepIt } });
    expect(filled.warnings.join(" ")).toMatch(/filled in/);
    const open = makeIslandPuzzle(withLoch, sw, AW, AH, { ...SPEC, only: { keep: keepIt, sea: loch } });
    expect(open.warnings.join(" ")).not.toMatch(/filled in/);
    // About the loch's 300 × 200 m less, on the puzzle.
    const lost = (landArea(filled) - landArea(open)) / (filled.k * filled.k);
    expect(lost).toBeGreaterThan(30000);
    expect(lost).toBeLessThan(120000);
    // Put together too.
    const placed = makeIslandPuzzle(withLoch, sw, AW, AH, { ...SPEC, inPlace: true, only: { keep: keepIt, sea: loch } });
    expect(placed.warnings.join(" ")).not.toMatch(/filled in/);
  });

  it("keeps the sea lochs with no keep points (land already chosen on a trimmed area)", () => {
    const p = makeIslandPuzzle(withLoch, sw, AW, AH, { ...SPEC, land: "all", only: { keep: [], sea: loch } });
    expect(p.warnings.join(" ")).not.toMatch(/filled in|wasn't found/);
    // A sea point leaves everything else as it was.
    const a = makeIslandPuzzle(mainAlone, sw, AW, AH, { ...SPEC, only: { keep: keepIt } });
    const b = makeIslandPuzzle(mainAlone, sw, AW, AH, { ...SPEC, only: { keep: keepIt, sea: loch } });
    expect(JSON.stringify(b.pieces)).toBe(JSON.stringify(a.pieces));
  });
});

// Mull's own troubles together: an islet (Ulva) joined by a neck a cell or two wide, the mainland off the edge, a big sea
// loch (Loch Spelve) whose mouth is closed and whose water the tiles blend just above 0 (so it was filled in), and a
// lochan the sea point mustn't touch. The sea point sits on the loch's shore, as a label's spot can on a narrow loch.
describe("a Mull-like island", () => {
  const sea0 = { ...SPEC, sea: 0.5 };
  const grid = gridFrom(sw, W, H, 20, (e, n) => {
    const [x, y] = [e - sw.e, n - sw.n];
    if (x > 3500 && x < 4300 && Math.abs(y - 2000) < 150) return 0.3;
    if (Math.hypot(x - 1500, y - 2000) < 200) return 0.3;
    const mull = Math.max(0, 300 * (1 - Math.hypot(x - 3000, y - 2000) / 1800));
    const ulva = Math.max(0, 60 * (1 - Math.hypot(x - 6200, y - 2000) / 500));
    const neck = x > 4700 && x < 5800 && Math.abs(y - 2000) < 10 ? 5 : 0;
    const mainland = x > 7600 ? 80 : 0;
    return Math.max(mull, ulva, neck, mainland);
  });
  const keep = [{ e: sw.e + 3000, n: sw.n + 3000 }, { e: sw.e + 2000, n: sw.n + 1200 }];
  const apart = [{ e: sw.e + 6200, n: sw.n + 2000 }];
  const sea = [{ e: sw.e + 3900, n: sw.n + 2160 }];

  it("keeps Mull alone with its sea loch open and its lochan filled", () => {
    const before = makeIslandPuzzle(grid, sw, W, H, { ...sea0, only: { keep, apart } });
    expect(spanE(before)[1]).toBeLessThan(5600);
    expect(before.warnings.join(" ")).toMatch(/2 low patches/);
    const p = makeIslandPuzzle(grid, sw, W, H, { ...sea0, only: { keep, apart, sea } });
    expect(spanE(p)[1]).toBeLessThan(5600);
    expect(p.warnings.join(" ")).toMatch(/A low patch/);
    const lost = (landArea(before) - landArea(p)) / (p.k * p.k);
    expect(lost).toBeGreaterThan(180000);
    expect(lost).toBeLessThan(300000);
    // Trimmed (land chosen already): everything is kept, the loch still open.
    const all = makeIslandPuzzle(grid, sw, W, H, { ...sea0, land: "all", only: { keep: [], sea } });
    expect(spanE(all)[1]).toBeGreaterThan(7900);
    expect(all.warnings.join(" ")).toMatch(/A low patch/);
  });
});
