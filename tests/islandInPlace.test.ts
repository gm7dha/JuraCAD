/**
 * The island puzzle printed put together (pure): one plate, every piece where it sits in the finished puzzle, the island's
 * land filling the bed at 100%, neighbours still apart by the (wider) gap, and Bambu's per-piece settings in the 3MF.
 * With the option off everything is exactly as before.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gridFrom } from "../src/terrain/elevation";
import { IN_PLACE_FIT, ISLAND_DEFAULTS, islandChecks, makeIslandPuzzle, MIN_JOINTS, type IslandPuzzle, type IslandSpec } from "../src/terrain/islandPuzzle";
import { PRINTERS } from "../src/model/printBed";
import { allPlatesZip, BED_MARGIN, bestRoom, freeRooms, type BedRect, type Plate, IN_PLACE_SETTINGS, plateFiles, platesFor, platesInPlace, towerCorner } from "../src/terrain/puzzle3mf";
import { islandBands, LAYER_DEFAULT, mapRaster, NO_MAP, SEA_BLUE } from "../src/terrain/colour";
import { bandPlateFile, bandPuzzle, plateSwaps } from "../src/terrain/colourFiles";
import { box, collides, outlineSegs, SegGrid, segSegDist, segsCross } from "./support/outlineGeom";

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

/** Each dovetail's piece pulled straight back out of its socket in 0.05 mm steps: how far it goes before it catches. */
function pullOut(p: IslandPuzzle): { free: number; median: number; most: number } {
  const O = p.pieces.map((q) => outlineSegs(q.bodies[0]));
  const G = O.map((s) => new SegGrid(s, 1));
  const plays: number[] = [];
  let free = 0;
  for (const t of p.tabs) {
    let d = 0;
    let hit = false;
    while (d < t.reach + 1 && !hit) {
      d += 0.05;
      hit = collides(O[t.from], G[t.into], -t.dir[0] * d, -t.dir[1] * d);
    }
    if (hit) plays.push(d);
    else free++;
  }
  plays.sort((a, b) => a - b);
  return { free, median: plays[Math.floor(plays.length / 2)] ?? 0, most: plays[plays.length - 1] ?? 0 };
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

  it("keeps the usual fit gap and refuses a scale past 100%", () => {
    expect(IN_PLACE_FIT).toBe(0.1);
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

  it("keeps neighbours about 0.3 mm apart at its fit gap (0.4 at 0.15), nothing overlapping", () => {
    const g = outlineGaps(p);
    expect(g.crossings).toBe(0);
    expect(g.nearest).toBeGreaterThan(0.25);
    expect(g.nearest).toBeLessThan(0.36);
    const wider = outlineGaps(makeIslandPuzzle(island, sw, W, H, { ...IN_PLACE, fit: 0.15 }));
    expect(wider.crossings).toBe(0);
    expect(wider.nearest).toBeGreaterThan(0.35);
    expect(wider.nearest).toBeLessThan(0.46);
  });

  it("holds every piece with at least two dovetails that catch when pulled", () => {
    for (const q of p.pieces) if (q.neighbours) expect(q.joints, q.name).toBeGreaterThanOrEqual(MIN_JOINTS);
    expect(p.pieces.reduce((t, q) => t + q.joints, 0)).toBe(2 * p.joins);
    const plays = pullOut(p);
    expect(plays.free).toBe(0);
    // Printed put together the pieces never move, so play only matters once it's taken apart: as laid out.
    expect(plays.median).toBeLessThanOrEqual(0.5);
    expect(plays.most).toBeLessThan(0.8);
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

describe("land touching the area's edge, put together", () => {
  // Land running off the west edge (a mainland), kept with "all" and "biggest".
  const coast = gridFrom(sw, W, H, 25, (e) => Math.max(0, 200 - ((e - sw.e) / W) * 400));
  for (const land of ["all", "biggest"] as const)
    it(`fits the bed at 100% and has no land outside the area (${land})`, () => {
      const p = makeIslandPuzzle(coast, sw, W, H, { ...IN_PLACE, land });
      expect(p.origin.e).toBeGreaterThanOrEqual(sw.e);
      expect(p.origin.n).toBeGreaterThanOrEqual(sw.n);
      expect(p.origin.e + p.width / p.k).toBeLessThanOrEqual(sw.e + W + 1e-6);
      expect(p.origin.n + p.height / p.k).toBeLessThanOrEqual(sw.n + H + 1e-6);
      const placed = platesInPlace(p.pieces, BED, p.room);
      expect(placed.fits).toBe(true);
      expect(Math.max(...placed.size)).toBeGreaterThan((BED[0] - 2 * BED_MARGIN) * 0.95);
      // Every piece's corners within the puzzle (nothing smeared past the area's edge).
      for (const q of p.pieces) {
        const v = q.bodies[0].vertices;
        for (let i = 0; i < v.length; i += 3) {
          expect(v[i]).toBeGreaterThanOrEqual(-1e-6);
          expect(v[i]).toBeLessThanOrEqual(p.width + 1e-6);
        }
      }
    });
});

describe("keeping clear of the printer's corners and the prime tower", () => {
  const x1 = PRINTERS.find((q) => q.id === "bambu-x1")!;
  it("knows the X1 / P1's no-print corner (Bambu's profiles); the others have none", () => {
    expect(x1.bedExclude).toEqual([[0, 0, 18, 28]]);
    for (const id of ["bambu-a1", "bambu-x2d", "bambu-h2d", "bambu-h3c"]) expect(PRINTERS.find((q) => q.id === id)!.bedExclude, id).toBeUndefined();
  });
  it("finds the free parts of the bed", () => {
    expect(freeRooms(BED, [])).toEqual([[0, 0, 256, 256]]);
    const rooms = freeRooms(BED, [[0, 0, 18, 28], towerCorner(BED)]);
    for (const r of rooms) {
      expect(r[0] < 18 && r[1] < 28).toBe(false);
      expect(r[0] < 55 && r[3] > 201).toBe(false);
    }
    expect(rooms.map((r) => r.join(","))).toContain("55,0,256,256");
    expect(rooms.map((r) => r.join(","))).toContain("0,28,256,201");
    // A wide puzzle goes in the wide room, a tall one in the tall room.
    expect(bestRoom(rooms, 300, 100)).toEqual([0, 28, 256, 201]);
    expect(bestRoom(rooms, 100, 300)).toEqual([55, 0, 256, 256]);
  });
  it("puts the island in the room it was sized for, clear of the corners kept free", () => {
    const keepOut: BedRect[] = [...x1.bedExclude!, towerCorner(BED)];
    const p = makeIslandPuzzle(island, sw, W, H, { ...IN_PLACE, rooms: freeRooms(BED, keepOut) });
    expect(p.room).toBeDefined();
    const placed = platesInPlace(p.pieces, BED, p.room);
    expect(placed.fits).toBe(true);
    const b = plateBox(placed.plates[0]);
    for (const [a, c, d, e] of keepOut) expect(b.x0 < d && a < b.x1 && b.y0 < e && c < b.y1, `keeps out of ${[a, c, d, e]}`).toBe(false);
    expect(b.x0).toBeGreaterThanOrEqual(p.room![0] + BED_MARGIN - 1e-6);
    expect(b.x1).toBeLessThanOrEqual(p.room![2] - BED_MARGIN + 1e-6);
    expect(b.y0).toBeGreaterThanOrEqual(p.room![1] + BED_MARGIN - 1e-6);
    expect(b.y1).toBeLessThanOrEqual(p.room![3] - BED_MARGIN + 1e-6);
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
