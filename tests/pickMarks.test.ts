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
import { canPick, dropAll, isDropped, keptCount, lineLabel, nearestLine, NONE_DROPPED, toggleDropped, withoutDropped } from "../src/terrain/pickMarks";
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
