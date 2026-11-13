/**
 * Tidy marks on a colour-band island print: far less painted, and fewer filament changes than with every path, river and
 * road (the window's rough count, `plateSwaps`). Changes go by the layers painted lines cross, not how many lines there
 * are: one path up the hill costs about a change per layer it climbs, so the saving is from marks on layers the kept
 * ones don't reach (here the minor road and the paths low down).
 */
import { describe, expect, it } from "vitest";
import { islandBands, LAYER_DEFAULT, mapOnPuzzle, mapRaster, PATH_RED, ROAD_BLACK, SEA_BLUE, type ColourSpec, type HeightScale } from "../src/terrain/colour";
import { bandPuzzle, plateSwaps } from "../src/terrain/colourFiles";
import { gridFrom } from "../src/terrain/elevation";
import { featuresForIsland, ISLAND_DEFAULTS, makeIslandPuzzle } from "../src/terrain/islandPuzzle";
import { ALL_MARKS, TIDY_MARKS } from "../src/terrain/mapMarks";
import { featuresOnGrid, readOsm } from "../src/terrain/osm";
import { platesFor } from "../src/terrain/puzzle3mf";
import { hillOsm } from "./support/osmSample";

const BED: [number, number, number] = [256, 256, 256];
const sw = { e: 201000, n: 770500 };
const hill = gridFrom(sw, 4000, 3000, 20, (e, n) => 300 + 700 * Math.exp(-(((e - 202800) / 900) ** 2 + ((n - 771500) / 700) ** 2)));
const data = readOsm(hillOsm());
const spec = { ...ISLAND_DEFAULTS, bed: BED, piece: 60, land: "all" as const };

function swapsWith(choice: typeof TIDY_MARKS | null): { swaps: number; painted: number } {
  const features = choice ? featuresOnGrid(data, "all", choice, hill) : featuresOnGrid(data, "area");
  const p = makeIslandPuzzle(hill, sw, 4000, 3000, spec, undefined, features);
  const map = mapRaster(mapOnPuzzle(featuresForIsland(features, p.k).features, sw.e, sw.n, p.k), p.width, p.height);
  const colour: ColourSpec = { mode: "bands", bands: islandBands(p.high), base: SEA_BLUE, water: SEA_BLUE, layer: LAYER_DEFAULT, paths: PATH_RED, roads: ROAD_BLACK };
  const scale: HeightScale = { z0: spec.base, h0: 0, mmPerM: spec.relief / Math.max(p.high, 1) };
  const banded = bandPuzzle(p.pieces, { spec: colour, scale, map });
  let painted = 0;
  for (const parts of banded.parts.values()) for (const part of parts) if (part.paint) for (const f of part.paint) if (f) painted++;
  return { swaps: plateSwaps(platesFor(p.pieces, BED), banded, LAYER_DEFAULT).reduce((a, b) => a + b, 0), painted };
}

describe("Filament changes with tidy marks", () => {
  it("are fewer than with everything from the map, with far less painted", () => {
    const plain = swapsWith(null);
    const tidy = swapsWith(TIDY_MARKS);
    const all = swapsWith(ALL_MARKS);
    expect(plain.painted).toBe(0);
    expect(tidy.swaps).toBeGreaterThan(plain.swaps);
    expect(tidy.swaps).toBeLessThan(all.swaps);
    // Far less painted: the footway, park and estate paths, the minor and slip roads and the flat track are gone.
    expect(tidy.painted).toBeLessThan(all.painted * 0.6);
  });
});
