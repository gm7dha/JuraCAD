/**
 * Paths and roads picked off by hand (pure): kept by the map's way ids, so the same choice holds when the map is read
 * again or the rules change; a dropped path is gone from the ground, the paint and the filament changes; nothing dropped
 * = exactly the puzzle as before.
 */
import { describe, expect, it } from "vitest";
import { islandBands, LAYER_DEFAULT, mapOnPuzzle, mapRaster, PATH_RED, ROAD_BLACK, SEA_BLUE, type ColourSpec, type HeightScale } from "../src/terrain/colour";
import { bandPuzzle, plateSwaps } from "../src/terrain/colourFiles";
import { gridFrom } from "../src/terrain/elevation";
import { featuresForIsland, ISLAND_DEFAULTS, makeIslandPuzzle } from "../src/terrain/islandPuzzle";
import { ALL_MARKS, TIDY_MARKS } from "../src/terrain/mapMarks";
import { featuresOnGrid, readOsm, type MapFeatures } from "../src/terrain/osm";
import { canPick, distanceToLine, dropAll, fromView, idsOf, isDropped, islandViewBox, keptCount, landIdsAfter, lineLabel, mountainViewBox, nearestLine, NONE_DROPPED, onView, pickableLines, toggleDropped, withoutDropped } from "../src/terrain/pickMarks";
import { makeMountainPuzzle, MOUNTAIN_DEFAULTS } from "../src/terrain/mountainPuzzle";
import { plate3mf } from "../src/terrain/puzzle3mf";
import { createHash } from "node:crypto";
import { platesFor } from "../src/terrain/puzzle3mf";
import { hillOsm } from "./support/osmSample";

const BED: [number, number, number] = [256, 256, 256];
const sw = { e: 201000, n: 770500 };
const hill = gridFrom(sw, 4000, 3000, 20, (e, n) => 300 + 700 * Math.exp(-(((e - 202800) / 900) ** 2 + ((n - 771500) / 700) ** 2)));
const text = hillOsm();
const data = readOsm(text);
const spec = { ...ISLAND_DEFAULTS, bed: BED, piece: 60, land: "all" as const };
const tidy = featuresOnGrid(data, "all", TIDY_MARKS, hill);

function made(features: MapFeatures) {
  const p = makeIslandPuzzle(hill, sw, 4000, 3000, spec, undefined, features);
  const map = mapRaster(mapOnPuzzle(featuresForIsland(features, p.k).features, sw.e, sw.n, p.k), p.width, p.height);
  const colour: ColourSpec = { mode: "bands", bands: islandBands(p.high), base: SEA_BLUE, water: SEA_BLUE, layer: LAYER_DEFAULT, paths: PATH_RED, roads: ROAD_BLACK };
  const scale: HeightScale = { z0: spec.base, h0: 0, mmPerM: spec.relief / Math.max(p.high, 1) };
  const banded = bandPuzzle(p.pieces, { spec: colour, scale, map });
  let painted = 0;
  for (const parts of banded.parts.values()) for (const part of parts) if (part.paint) for (const f of part.paint) if (f) painted++;
  return { p, painted, swaps: plateSwaps(platesFor(p.pieces, BED), banded, LAYER_DEFAULT).reduce((a, b) => a + b, 0) };
}
const meshOf = (p: ReturnType<typeof makeIslandPuzzle>) => p.pieces.map((x) => x.bodies.map((b) => [Array.from(b.vertices), Array.from(b.triangles)]));

describe("Picking paths off", () => {
  it("gives each path and road the map's way ids, and a name when it has one", () => {
    const pickable = tidy.lines.filter(canPick);
    expect(pickable.length).toBeGreaterThan(1);
    expect(pickable.some((l) => l.kind === "road")).toBe(true);
    expect(pickable.some((l) => l.kind !== "road" && (l.ids?.length ?? 0) > 1)).toBe(true);
    for (const l of pickable) expect(lineLabel(l)).toMatch(/(m|km)$/);
    expect(tidy.lines.some((l) => l.name)).toBe(true);
  });

  it("keeps the same choice when the map is read again, and when every path is shown instead of the hill routes", () => {
    const route = tidy.lines.find((l) => l.kind !== "road" && (l.ids?.length ?? 0) > 1)!;
    const dropped = toggleDropped(NONE_DROPPED, route);
    const again = featuresOnGrid(readOsm(text), "all", TIDY_MARKS, hill);
    expect(again.lines.filter((l) => isDropped(l, dropped)).length).toBe(1);
    expect(withoutDropped(again, dropped).lines.length).toBe(again.lines.length - 1);
    // Every path: each of the route's ways is its own line, and every one of them is left off.
    const all = featuresOnGrid(data, "all", ALL_MARKS, hill);
    const ways = all.lines.filter((l) => l.ids?.some((id) => route.ids!.includes(id)));
    expect(ways.length).toBe(route.ids!.length);
    expect(ways.every((l) => isDropped(l, dropped))).toBe(true);
    // Clicked again, it's back.
    expect(toggleDropped(dropped, route).size).toBe(0);
  });

  it("counts, drops all and keeps all", () => {
    const n = tidy.lines.filter(canPick).length;
    expect(keptCount(tidy, NONE_DROPPED)).toMatchObject({ kept: n, total: n });
    const none = dropAll(tidy);
    expect(keptCount(tidy, none).kept).toBe(0);
    expect(withoutDropped(tidy, none).lines.filter(canPick)).toEqual([]);
  });

  it("finds the line nearest a click, within reach only", () => {
    const l = tidy.lines.findIndex(canPick);
    const pts = tidy.lines[l].pts;
    const mid: [number, number] = [(pts[0][0] + pts[1][0]) / 2 + 3, (pts[0][1] + pts[1][1]) / 2];
    expect(nearestLine(tidy.lines, mid, 20)).toBeGreaterThanOrEqual(0);
    expect(nearestLine(tidy.lines, [sw.e - 5000, sw.n - 5000], 20)).toBe(-1);
  });

  it("nothing dropped is the very same puzzle; a dropped path is gone from the ground, the paint and the filament changes", () => {
    expect(withoutDropped(tidy, NONE_DROPPED)).toBe(tidy);
    const route = tidy.lines.filter((l) => l.kind !== "road" && canPick(l)).sort((a, b) => b.pts.length - a.pts.length)[0];
    const kept = made(tidy);
    const fewer = made(withoutDropped(tidy, toggleDropped(NONE_DROPPED, route)));
    expect(fewer.painted).toBeLessThan(kept.painted);
    expect(fewer.swaps).toBeLessThanOrEqual(kept.swaps);
    expect(JSON.stringify(meshOf(fewer.p))).not.toBe(JSON.stringify(meshOf(kept.p)));
    // Everything dropped = the same as the map with no paths or roads at all.
    const none = made(withoutDropped(tidy, dropAll(tidy)));
    const bare = made({ ...tidy, lines: tidy.lines.filter((l) => !canPick(l)) });
    expect(JSON.stringify(meshOf(none.p))).toBe(JSON.stringify(meshOf(bare.p)));
    expect(none.painted).toBe(bare.painted);
    expect(none.swaps).toBeLessThan(kept.swaps);
  });
});

/** The features with the map's ids and names taken off again (what main made). */
const bare = (f: MapFeatures): MapFeatures => ({
  ...f,
  lines: f.lines.map((l) => {
    const out = { ...l };
    delete out.ids;
    delete out.name;
    return out;
  }),
});
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("Picking paths off: every click flips just what was clicked", () => {
  const all = featuresOnGrid(data, "all", ALL_MARKS, hill);
  it("no two lines share a way, in either rule, so a click never takes another line with it", () => {
    for (const f of [tidy, all]) {
      const seen = new Set<string>();
      for (const l of f.lines.filter(canPick)) for (const id of l.ids!) {
        expect(seen.has(id), id).toBe(false);
        seen.add(id);
      }
    }
  });
  it("a click flips the clicked line whatever part of its ways were already off, and leaves the others as they were", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const ways = [...idsOf(all.lines)];
    for (const f of [tidy, all]) {
      const lines = f.lines.filter(canPick);
      for (let round = 0; round < 40; round++) {
        const dropped = new Set(ways.filter(() => rnd() < 0.4));
        for (const l of lines) {
          const next = toggleDropped(dropped, l);
          expect(isDropped(l, next)).toBe(!isDropped(l, dropped));
          for (const o of lines) if (o !== l) expect(isDropped(o, next)).toBe(isDropped(o, dropped));
        }
      }
    }
  });
});

describe("Picking paths off: what's offered", () => {
  const line = (id: string, pts: [number, number][], kind: "path" | "road" = "path") => ({ kind, pts, ids: [id] });
  const a = line("a", [[0, 0], [10, 0]]);
  const b = line("b", [[50, 50], [60, 50]]);
  const c = line("c", [[-10, 5], [30, 5]], "road"); // passes through the box with both ends outside
  const river = { kind: "river" as const, pts: [[0, 0], [5, 5]] as [number, number][], ids: ["r"] };
  it("only lines on the land (island) or within the puzzle (mountain), plus any left off", () => {
    expect(pickableLines([a, b, c, river], NONE_DROPPED, new Set(["a"]))).toEqual([a]);
    expect(pickableLines([a, b, c], new Set(["b"]), new Set(["a"]))).toEqual([a, b]);
    const box = { e0: 0, n0: 1, width: 20, height: 10 };
    expect(pickableLines([a, b, c], NONE_DROPPED, null, box)).toEqual([c]);
    expect(pickableLines([a, b, c], NONE_DROPPED, null, { ...box, n0: -1 })).toEqual([a, c]);
    expect(pickableLines([a, b, c], NONE_DROPPED)).toEqual([a, b, c]);
  });
  it("a line put back stays known to be on the land until the puzzle is made again", () => {
    // Made with b left off: its marks can't say where b is, so what was known before is kept for it only.
    const known = landIdsAfter(new Set(["a", "b", "x"]), new Set(["a"]), new Set(["b"]));
    expect([...known].sort()).toEqual(["a", "b"]);
    expect(pickableLines([a, b], NONE_DROPPED, known)).toEqual([a, b]);
  });
});

describe("Picking paths off: the overlay sits exactly on the top view", () => {
  it("mountain: the same mapping as the canvas, any shape of area, any size on screen", () => {
    for (const [w, h] of [[4000, 3000], [1500, 6200], [7000, 900]]) {
      const area = { sw: { e: 250123, n: 801456 }, width: w, height: h };
      const s = Math.min(380 / w, 380 / h);
      const [cw, ch] = [Math.round(w * s), Math.round(h * s)];
      const box = mountainViewBox(area);
      for (const p of [[250123, 801456], [250123 + w, 801456 + h], [250123 + w * 0.3, 801456 + h * 0.8]] as [number, number][]) {
        // The canvas: ((e − e0)·s, h − (n − n0)·s) on a w × h canvas whose size is rounded.
        const canvas = [(p[0] - area.sw.e) * s, ch - (p[1] - area.sw.n) * s];
        const [x, y] = onView(box, cw, ch, p);
        expect(Math.abs(x - canvas[0])).toBeLessThan(0.5);
        expect(Math.abs(y - canvas[1])).toBeLessThan(0.5);
        // Shown at any size (CSS scaling, device pixels), the pointer comes back to the same grid point.
        for (const k of [0.5, 1, 2.75]) {
          const q = fromView(box, cw * k, ch * k, onView(box, cw * k, ch * k, p));
          expect(Math.hypot(q[0] - p[0], q[1] - p[1])).toBeLessThan(1e-6);
        }
      }
    }
  });

  it("island printed put together (cropped to the land): its marks land on the lines the overlay draws", () => {
    // The hill as an island: sea round it, so "put together" crops the area to the land and moves the origin.
    const isle = gridFrom(sw, 4000, 3000, 20, (e, n) => 700 * Math.exp(-(((e - 202800) / 900) ** 2 + ((n - 771500) / 700) ** 2)) - 150);
    const p = makeIslandPuzzle(isle, sw, 4000, 3000, { ...spec, inPlace: true }, undefined, tidy);
    expect(p.origin.e === sw.e && p.origin.n === sw.n).toBe(false);
    const box = islandViewBox(p, p.origin);
    const s = Math.min(380 / p.width, 380 / p.height);
    const [w, h] = [Math.round(p.width * s), Math.round(p.height * s)];
    const byId = new Map(tidy.lines.filter(canPick).flatMap((l) => l.ids!.map((id) => [id, l] as const)));
    let checked = 0;
    for (const m of p.marks.lines) {
      if (!m.ids) continue;
      const src = byId.get(m.ids[0])!;
      expect(src).toBeTruthy();
      for (const [x, y] of m.pts) {
        // Where the canvas draws the mark, read back through the overlay's mapping: on the source line — exactly when the
        // canvas isn't rounded to whole pixels, within the rounding's half pixel when it is.
        expect(distanceToLine(fromView(box, p.width * s, p.height * s, [x * s, p.height * s - y * s]), src.pts)).toBeLessThan(0.01);
        expect(distanceToLine(fromView(box, w, h, [x * s, h - y * s]), src.pts) * s * p.k).toBeLessThan(0.75);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(5);
    // Lines off the land aren't offered.
    const offered = pickableLines(featuresForIsland(tidy, p.k).features.lines, NONE_DROPPED, idsOf(p.marks.lines));
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.length).toBeLessThanOrEqual(tidy.lines.filter(canPick).length);
  });
});

describe("Picking paths off: the files", () => {
  const SPEC_M = { ...MOUNTAIN_DEFAULTS, bed: BED, cube: 40 };
  const files = (f: MapFeatures) => {
    const p = makeMountainPuzzle(hill, 4000, 3000, SPEC_M, f);
    return platesFor(p.pieces, BED).map((plate) => hash(plate3mf(plate, "Hill")));
  };
  it("the map's ids and names change nothing made, and a dropped path is gone from the mountain's 3MF", () => {
    const withIds = files(tidy);
    expect(files(bare(tidy))).toEqual(withIds);
    expect(files(withoutDropped(tidy, NONE_DROPPED))).toEqual(withIds);
    const route = tidy.lines.filter((l) => l.kind !== "road" && canPick(l)).sort((a, b) => b.pts.length - a.pts.length)[0];
    const dropped = toggleDropped(NONE_DROPPED, route);
    const fewer = files(withoutDropped(tidy, dropped));
    expect(fewer).not.toEqual(withIds);
    // Exactly as if the map had never had it.
    expect(fewer).toEqual(files({ ...tidy, lines: tidy.lines.filter((l) => l !== route) }));
  });
});
