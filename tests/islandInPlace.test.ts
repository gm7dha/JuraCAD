/**
 * The island puzzle printed put together (pure): one plate, every piece where it sits in the finished puzzle, the island's
 * land filling the bed at 100%, neighbours still apart by the (wider) gap, and Bambu's per-piece settings in the 3MF.
 * With the option off everything is exactly as before.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gridFrom } from "../src/terrain/elevation";
import { IN_PLACE_FIT, ISLAND_DEFAULTS, islandChecks, makeIslandPuzzle, type IslandPuzzle, type IslandSpec } from "../src/terrain/islandPuzzle";
import { allPlatesZip, BED_MARGIN, type Plate, IN_PLACE_SETTINGS, plateFiles, platesFor, platesInPlace } from "../src/terrain/puzzle3mf";
import { islandBands, LAYER_DEFAULT, mapRaster, NO_MAP, SEA_BLUE } from "../src/terrain/colour";
import { bandPlateFile, bandPuzzle, plateSwaps } from "../src/terrain/colourFiles";
import { box, outlineSegs, SegGrid, segSegDist, segsCross } from "./support/outlineGeom";

// The lumpy island of tests/islandPuzzle, with a bay and an islet, on 6 × 4 km — sea all round it.
const W = 6000;
const H = 4000;
const sw = { e: 300000, n: 700000 };
const island = gridFrom(sw, W, H, 25, (e, n) => {
  const [x, y] = [(e - sw.e) / W - 0.5, (n - sw.n) / H - 0.5];
  const r = Math.hypot(x / 0.42, y / 0.4) + 0.15 * Math.sin(Math.atan2(y, x) * 3);
  const islet = Math.hypot(x - 0.44, y + 0.4) < 0.04 ? 30 : 0;
  return Math.max(0, (1 - r) * 400 + 60 * Math.sin(e / 300) * (1 - r)) + islet;
});
const BED: [number, number, number] = [256, 256, 256];
const SPEC: IslandSpec = { ...ISLAND_DEFAULTS, bed: BED };
const IN_PLACE: IslandSpec = { ...SPEC, inPlace: true, fit: IN_PLACE_FIT };

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

/** Every vertex of every piece as it lies on the plate. */
function plateBox(plate: Plate) {
  let [x0, y0, z0, x1, y1] = [Infinity, Infinity, Infinity, -Infinity, -Infinity];
  for (const { piece, move } of plate.pieces) {
    const v = piece.bodies[0].vertices;
    for (let i = 0; i < v.length; i += 3) {
      x0 = Math.min(x0, v[i] + move[0]);
      x1 = Math.max(x1, v[i] + move[0]);
      y0 = Math.min(y0, v[i + 1] + move[1]);
      y1 = Math.max(y1, v[i + 1] + move[1]);
      z0 = Math.min(z0, v[i + 2] + move[2]);
    }
  }
  return { x0, y0, z0, x1, y1 };
}

describe("island puzzle printed put together", () => {
  const laidOut = makeIslandPuzzle(island, sw, W, H, SPEC);
  const p = makeIslandPuzzle(island, sw, W, H, IN_PLACE);
  const placed = platesInPlace(p.pieces, BED);

  it("uses a wider gap and refuses a scale past 100%", () => {
    expect(IN_PLACE_FIT).toBe(0.15);
    expect(islandChecks({ ...IN_PLACE, scale: 1 })).toEqual([]);
    expect(islandChecks({ ...IN_PLACE, scale: 1.2 }).join(" ")).toMatch(/at most 100%/);
    expect(islandChecks({ ...SPEC, scale: 1.2 })).toEqual([]);
  });

  it("puts every piece on one plate, each where it sits in the finished puzzle", () => {
    expect(placed.plates.length).toBe(1);
    expect(placed.fits).toBe(true);
    const plate = placed.plates[0];
    expect(plate.pieces.length).toBe(p.pieces.length);
    expect(new Set(plate.pieces.map((x) => x.piece))).toEqual(new Set(p.pieces));
    // One move for them all: the puzzle moved as a whole, never pulled apart.
    for (const { move } of plate.pieces) expect(move).toEqual(plate.pieces[0].move);
    // On the bed, inside its margins, standing at z = 0.
    const b = plateBox(plate);
    expect(b.z0).toBe(0);
    expect(b.x0).toBeGreaterThanOrEqual(BED_MARGIN - 1e-6);
    expect(b.y0).toBeGreaterThanOrEqual(BED_MARGIN - 1e-6);
    expect(b.x1).toBeLessThanOrEqual(BED[0] - BED_MARGIN + 1e-6);
    expect(b.y1).toBeLessThanOrEqual(BED[1] - BED_MARGIN + 1e-6);
  });

  it("makes the island's land, not the whole area, fill the bed at 100% — a bigger print than laid out", () => {
    // The longer side reaches nearly across the bed less its margins.
    expect(Math.max(...placed.size)).toBeGreaterThan((BED[0] - 2 * BED_MARGIN) * 0.97);
    const before = platesInPlace(laidOut.pieces, BED).size;
    expect(Math.max(...placed.size)).toBeGreaterThan(Math.max(...before) * 1.03);
    expect(p.k).toBeGreaterThan(laidOut.k * 1.03);
    // Its (0, 0) is the land's corner, not the area's, so the map is placed from there.
    expect(p.origin.e).toBeGreaterThan(sw.e);
    expect(p.origin.n).toBeGreaterThan(sw.n);
    expect(laidOut.origin).toEqual(sw);
  });

  it("keeps neighbours apart by the wider gap, nothing overlapping", () => {
    const g = outlineGaps(p);
    expect(g.crossings).toBe(0);
    expect(g.nearest).toBeGreaterThan(2 * IN_PLACE_FIT - 0.005);
    expect(g.nearest).toBeLessThan(2 * IN_PLACE_FIT + 0.6);
  });

  it("says when the island is too big for the bed", () => {
    const small = platesInPlace(p.pieces, [180, 180, 180]);
    expect(small.fits).toBe(false);
    expect(small.size).toEqual(placed.size);
    expect(platesInPlace([], BED)).toEqual({ plates: [], size: [0, 0], fits: true });
  });

  it("writes each piece as its own object, with no brim and elephant-foot compensation, in Bambu's settings", () => {
    const { model, config } = plateFiles(placed.plates[0], "Island", IN_PLACE_SETTINGS);
    const n = p.pieces.length;
    expect(model.match(/<item /g)?.length).toBe(n);
    expect(config.match(/<object id=/g)?.length).toBe(n);
    expect(config.match(/<metadata key="brim_type" value="no_brim"\/>/g)?.length).toBe(n);
    expect(config.match(/<metadata key="elefant_foot_compensation" value="0.15"\/>/g)?.length).toBe(n);
    expect(config.match(/<model_instance>/g)?.length).toBe(n);
    // Only the settings asked for: no parts turned into modifiers or negative parts.
    expect(config).not.toMatch(/negative_part|modifier_part/);
    expect(Object.keys(IN_PLACE_SETTINGS).sort()).toEqual(["brim_type", "elefant_foot_compensation"]);
    // Without them, nothing is added.
    expect(plateFiles(placed.plates[0], "Island").config).not.toContain("brim_type");
  });

  it("is exactly the old puzzle and the old files with the option off", () => {
    const off = makeIslandPuzzle(island, sw, W, H, { ...SPEC, inPlace: false });
    expect(off.pieces.map((q) => q.area)).toEqual(laidOut.pieces.map((q) => q.area));
    expect(off.k).toBe(laidOut.k);
    const zip = allPlatesZip(platesFor(laidOut.pieces, BED), "Island");
    // What JuraCAD wrote for this island before the option existed.
    expect(createHash("sha256").update(zip).digest("hex")).toBe(OLD_ZIP_HASH);
    expect(createHash("sha256").update(allPlatesZip(platesFor(off.pieces, BED), "Island")).digest("hex")).toBe(OLD_ZIP_HASH);
  });
});

describe("in colour bands, put together", () => {
  it("is one plate whose filament changes are counted, each piece with Bambu's settings", async () => {
    const p = makeIslandPuzzle(island, sw, W, H, { ...IN_PLACE, piece: 60 });
    const { plates } = platesInPlace(p.pieces, BED);
    expect(plates.length).toBe(1);
    const ctx = {
      spec: { mode: "bands" as const, bands: islandBands(p.high), base: SEA_BLUE, water: SEA_BLUE, layer: LAYER_DEFAULT },
      scale: { z0: IN_PLACE.base, h0: 0, mmPerM: IN_PLACE.relief / Math.max(p.high, 1) },
      map: mapRaster(NO_MAP, 1, 1),
    };
    const banded = bandPuzzle(p.pieces, ctx);
    const swaps = plateSwaps(plates, banded, LAYER_DEFAULT);
    expect(swaps.length).toBe(1);
    // Every piece starts at the bed, so its bands change on the same layers: a handful of changes, not one per piece.
    expect(swaps[0]).toBeGreaterThan(0);
    expect(swaps[0]).toBeLessThanOrEqual(2 * (ctx.spec.bands.length + 1));
    const file = await bandPlateFile(plates[0], "Island", banded, ctx, IN_PLACE_SETTINGS);
    expect(file.length).toBeGreaterThan(1000);
  });
});

const OLD_ZIP_HASH = "5cb08705af22373afee0e3aeaa9809eb0d7c8d2db4265a7298a355fb05204ef7";
