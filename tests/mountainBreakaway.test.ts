/**
 * The Mountain puzzle printed all in one go with breakaway layers, now in colour bands too (pure): band parts closed and
 * their edges on the print's own layers as stacked, the breakaway parts on a filament of their own that clashes with
 * nothing, the second nozzle's filament map, nozzle changes; and the puzzle's material (Bambu lines) — the usual colours
 * moved to the line's nearest, spools named after it, advice for the breakaway filament. The usual PLA writes exactly what
 * it wrote before.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gridFrom } from "../src/terrain/elevation";
import { breakawayParts, freeBreakawaySlot, layerPlates, nozzleSwitches, stackedPartRanges, stackWithBreakaway, togetherPlate, unliftedPlate } from "../src/terrain/mountainInPlace";
import { baseFor, makeMountainPuzzle, MOUNTAIN_DEFAULTS, type MountainSpec, type PuzzlePiece } from "../src/terrain/mountainPuzzle";
import { bandPlateFiles, FILAMENT, plateFiles, platesByLevel } from "../src/terrain/puzzle3mf";
import { bandPuzzle, platedParts, plateSwaps } from "../src/terrain/colourFiles";
import { filamentSwaps, filaments, GROUND_BROWN, type BandPart, mapRaster, meshCheck, mountainBands, NO_MAP, PATH_RED, ROAD_BLACK, USUAL_SPOOLS, usualColour, WATER_BLUE } from "../src/terrain/colour";
import { breakawayAdvice, changeMaterial, inMaterial, matchNotes, MATERIAL_CHOICES, USUAL_MATERIAL } from "../src/terrain/puzzleMaterial";
import { PRINTERS } from "../src/model/printBed";

const W = 4000;
const H = 3000;
const hill = gridFrom({ e: 200000, n: 770000 }, W, H, 20, (e, n) => 300 + 1000 * Math.exp(-(((e - 201800) / 900) ** 2 + ((n - 771500) / 700) ** 2)) + 40 * Math.sin(e / 170));
const SPEC: MountainSpec = { ...MOUNTAIN_DEFAULTS, bed: [256, 256, 256], snowline: 1000 };
const BED: [number, number, number] = [256, 256, 256];
const h16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

describe("the usual PLA writes what it wrote before", () => {
  // Hashes of what main (v0.12x, before colour bands could be stacked) wrote for these plates.
  it("plain stacked plate and colour-band plates are unchanged", () => {
    const puzzle = makeMountainPuzzle(hill, W, H, SPEC);
    const pl = togetherPlate(stackWithBreakaway(puzzle, 0.2), BED);
    const f = plateFiles(pl.plates[0], "t", undefined, FILAMENT);
    expect([h16(f.model), h16(f.config)]).toEqual(["6132ab9c40259f5c", "77dbd4ed76b4d2dd"]);
    const pz = makeMountainPuzzle(hill, W, H, { ...SPEC, snowline: null });
    const spec = usualColour(mountainBands(pz.layout.low, pz.layout.high, 1000), WATER_BLUE);
    const ctx = { spec, scale: { z0: baseFor(pz.spec), h0: pz.layout.low, mmPerM: pz.layout.k * pz.spec.exaggeration }, map: mapRaster(NO_MAP, 100, 100) };
    const banded = bandPuzzle(pz.pieces, ctx);
    const plates = platesByLevel(pz.pieces, BED);
    const lp = layerPlates(pz.pieces, BED).plates;
    expect(plateSwaps(plates, banded, 0.2).join(",")).toBe("0,0,2,2,2");
    expect(plateSwaps(lp, banded, 0.2).join(",")).toBe("0,2,2");
    const fs = (p: (typeof plates)[number]) => {
      const r = bandPlateFiles(p, "b", (x) => (banded.parts.get(x) ?? []).map((b) => ({ ...b, label: "x" })), (n) => String(n));
      return h16(r.model) + h16(r.config);
    };
    expect([fs(plates[0]), fs(plates[plates.length - 1]), fs(lp[1])]).toEqual(["a7f0861b6093183ac631aa92af0ca090", "38725a32599ed4b4e88d2e144b5d6445", "28caa3828a7a2eeae473485c895fa304"]);
  });
});

describe("all in one go in colour bands", () => {
  const pz = makeMountainPuzzle(hill, W, H, { ...SPEC, snowline: null });
  const layer = 0.16;
  const first = 0.2;
  const spec = { ...usualColour(mountainBands(pz.layout.low, pz.layout.high, 1000), WATER_BLUE), layer, firstLayer: first, stacked: true };
  const ctx = { spec, scale: { z0: baseFor(pz.spec), h0: pz.layout.low, mmPerM: pz.layout.k * pz.spec.exaggeration }, map: mapRaster(NO_MAP, 100, 100) };
  const stacked = stackWithBreakaway(pz, layer, first);
  const banded = bandPuzzle(pz.pieces, ctx);
  const used = filaments(spec, ctx.map).map((f) => f.n);
  const slot = freeBreakawaySlot(used, false);
  const plate = unliftedPlate(togetherPlate(stacked, BED).plates[0], stacked);
  const all = { parts: new Map<PuzzlePiece, BandPart[]>([...banded.parts, ...breakawayParts(stacked, slot)]), uncut: banded.uncut };

  it("puts every piece and breakaway layer on the plate, the pieces the puzzle's own, lifted by their layer's lift", () => {
    expect(banded.uncut).toBe(0);
    expect(plate.pieces.length).toBe(stacked.pieces.length);
    for (const { piece, move } of plate.pieces) {
      if (piece.bodies.some((b) => b.part === "breakaway")) continue;
      expect(pz.pieces).toContain(piece);
      expect(move[2]).toBeCloseTo(stacked.lifts[piece.layer], 9);
    }
  });

  it("cuts closed band parts whose edges lie on the print's own layers as stacked", () => {
    const boundary = (z: number) => z < 1e-6 || Math.abs((z - first) / layer - Math.round((z - first) / layer)) < 1e-6;
    const parts = platedParts(plate, all);
    expect(parts.length).toBeGreaterThan(pz.pieces.length);
    for (const { piece } of plate.pieces) for (const p of all.parts.get(piece) ?? []) expect(meshCheck(p.vertices, p.triangles).open).toBe(0);
    // Every band's bottom (heights from the bed) is a print layer boundary.
    let checked = 0;
    for (const p of parts) {
      if (p.filament === slot) continue;
      expect(boundary(p.low)).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("gives the breakaway layers the next free filament and clashes with none of the bands", () => {
    expect(slot).toBe(Math.max(...used) + 1);
    expect(used).not.toContain(slot);
    expect(freeBreakawaySlot([1, 2], true)).toBe(3);
    expect(freeBreakawaySlot([1], true)).toBe(3);
    expect(freeBreakawaySlot([1, 2, 3, 4, 5], false)).toBe(6);
    const parts = platedParts(plate, all);
    expect(parts.filter((p) => p.filament === slot).length).toBe(stacked.pieces.length - pz.pieces.length);
  });

  it("counts the breakaway layers' filament changes, or nozzle changes on the second nozzle", () => {
    const withB = plateSwaps([plate], all, layer)[0];
    const without = plateSwaps([plate], banded, layer)[0];
    expect(withB).toBeGreaterThan(without);
    const nozzle = nozzleSwitches(platedParts(plate, all), layer, slot);
    expect(nozzle).toBeGreaterThan(0);
    expect(nozzle % 2).toBe(0);
  });

  it("writes the second nozzle's filament map only when asked", () => {
    const parts = (x: (typeof plate.pieces)[number]["piece"]) => (all.parts.get(x) ?? []).map((b) => ({ ...b, label: "x" }));
    const plain = bandPlateFiles(plate, "b", parts, String);
    expect(plain.config).not.toContain("filament_map");
    const nozzles = Array.from({ length: slot }, (_, i) => (i + 1 === slot ? 2 : 1));
    const two = bandPlateFiles(plate, "b", parts, String, undefined, nozzles);
    expect(two.config).toContain('<metadata key="filament_map_mode" value="Manual"/>');
    expect(two.config).toContain(`<metadata key="filament_maps" value="${nozzles.join(" ")}"/>`);
    expect(two.model).toBe(plain.model);
  });
});

describe("nozzle changes", () => {
  it("counts a plain stacked puzzle's snow as filament changes and its breakaway layers as nozzle changes", () => {
    const puzzle = makeMountainPuzzle(hill, W, H, SPEC);
    const st = stackWithBreakaway(puzzle, 0.2);
    const parts = stackedPartRanges(st, FILAMENT);
    expect(parts.some((p) => p.filament === FILAMENT.snow)).toBe(true);
    expect(nozzleSwitches(parts, 0.2, FILAMENT.breakaway)).toBeGreaterThan(0);
    expect(filamentSwaps(parts.filter((p) => p.filament !== FILAMENT.breakaway), 0.2)).toBeGreaterThan(0);
  });

  it("counts a change each way on layers that use both nozzles", () => {
    const parts = [
      { filament: 1, low: 0, high: 1 },
      { filament: 3, low: 1, high: 1.2 },
      { filament: 1, low: 1.2, high: 2 },
    ];
    expect(nozzleSwitches(parts, 0.2, 3)).toBe(2);
    expect(nozzleSwitches([{ filament: 1, low: 0, high: 1 }], 0.2, 3)).toBe(0);
    // Both on one layer: there and back over two layers = one change each.
    expect(nozzleSwitches([{ filament: 1, low: 0, high: 0.4 }, { filament: 3, low: 0, high: 0.4 }], 0.2, 3)).toBe(2);
  });
});

describe("the X2D's second nozzle", () => {
  it("reaches x 20.5–256 and 256 mm up (Bambu Studio's X2D profile)", () => {
    const x2d = PRINTERS.find((p) => p.id === "bambu-x2d")!;
    expect(x2d.secondNozzle).toEqual({ name: "aux", missing: [[0, 0, 20.5, 256]], height: 256, usual: true });
    // The H2D: both nozzles reach 320 mm up (left 320, right 325).
    expect(PRINTERS.find((p) => p.id === "bambu-h2d")!.secondNozzle!.height).toBe(320);
    expect(x2d.size[0] - x2d.secondNozzle!.missing[0][2]).toBe(x2d.bothNozzles![0]);
  });
});

describe("the puzzle's material", () => {
  const bands = mountainBands(0, 1000, 800);
  const usual = { bands: bands.map((b) => b.colour), base: GROUND_BROWN, water: WATER_BLUE, paths: PATH_RED, roads: ROAD_BLACK };

  it("moves the usual colours to PETG HF's nearest, named after their PETG HF spools", () => {
    const pla = usualColour(bands, WATER_BLUE);
    const petg = changeMaterial(pla, usual, USUAL_MATERIAL, "PETG HF", USUAL_SPOOLS);
    const fs = filaments(petg, true);
    expect(fs.length).toBe(7);
    // The base stays a brown (not Upland's grey).
    expect(fs.find((f) => f.uses.includes("Base"))!.spool).toBe("Peanut Brown (PETG HF)");
    expect(fs.find((f) => f.uses.includes("Lowland"))!.spool).toBe("Forest Green (PETG HF)");
    for (const f of fs) expect(f.spool).toMatch(/\(PETG HF\)$/);
    expect(fs.find((f) => f.uses.includes("Snow"))!.spool).toBe("White (PETG HF)");
    expect(fs.find((f) => f.uses.includes("Roads"))!.spool).toBe("Black (PETG HF)");
    expect(inMaterial(WATER_BLUE, "PETG HF").spool?.name).toBe("Lake Blue");
    // Back to the usual PLA: exactly the usual colours and spools again.
    expect(changeMaterial(petg, usual, "PETG HF", USUAL_MATERIAL, USUAL_SPOOLS)).toEqual(pla);
  });

  it("keeps colours picked by hand", () => {
    const pla = { ...usualColour(bands, WATER_BLUE), base: "#123456" };
    const petg = changeMaterial(pla, usual, USUAL_MATERIAL, "PETG Basic", USUAL_SPOOLS);
    expect(petg.base).toBe("#123456");
    expect(petg.bands[0].colour).not.toBe(pla.bands[0].colour);
  });

  it("offers solid colours only", () => {
    expect(MATERIAL_CHOICES.flatMap((m) => m.lines)).toEqual(["PLA Basic", "PLA Matte", "PETG HF", "PETG Basic", "PETG Matte", "ABS", "ASA"]);
  });

  it("says when two usual colours land on one spool", () => {
    const notes = matchNotes(
      bands.map((b) => ({ name: b.name, hex: b.colour })).concat([{ name: "the base", hex: GROUND_BROWN }]),
      "ASA",
    );
    expect(notes.some((n) => /print in one filament/.test(n))).toBe(true);
    expect(matchNotes(bands.map((b) => ({ name: b.name, hex: b.colour })), "PETG HF").some((n) => /one filament/.test(n))).toBe(false);
  });

  it("says when a line has nothing close", () => {
    expect(matchNotes([{ name: "the base", hex: GROUND_BROWN }], USUAL_MATERIAL)).toEqual([]);
    const far = matchNotes([{ name: "x", hex: "#ff00ff" }], "ABS");
    expect(far.length).toBe(1);
  });

  it("advises the breakaway filament that suits the material", () => {
    expect(breakawayAdvice(USUAL_MATERIAL).filament).toBe("Support for PLA");
    expect(breakawayAdvice("PETG HF").filament).toBe("Support for PLA/PETG");
    expect(breakawayAdvice("PETG HF").words).toContain("PLA Basic");
    expect(breakawayAdvice("ABS").filament).toBe("Support for ABS");
  });
});

describe("put together, the puzzle fits the room it's centred in", () => {
  // Rooms (centred on a 256 × 256 bed) the keep-outs leave; at 100% rounding to whole cubes used to pass them.
  const rooms: [number, number, number, number][] = [
    [20.5, 55, 235.5, 201],
    [55, 0, 201, 256],
    [5, 0, 251, 256],
  ];
  for (const room of rooms)
    for (const cube of [20, 25, 30]) {
      it(`a ${room[2] - room[0]} × ${room[3] - room[1]} room with ${cube} mm cubes`, () => {
        const spec: MountainSpec = { ...SPEC, cube, scale: 1, inRoom: true, bed: [room[2] - room[0], room[3] - room[1], 256] };
        const pz = makeMountainPuzzle(hill, W, H, spec);
        expect(layerPlates(pz.pieces, BED, room).fits).toBe(true);
        expect(togetherPlate(stackWithBreakaway(pz, 0.2), BED, room).fits).toBe(true);
      });
    }
  it("leaves laid-out puzzles as they were", () => {
    const a = makeMountainPuzzle(hill, W, H, { ...SPEC, bed: [215, 146, 256] });
    expect([a.layout.cols, a.layout.rows]).toEqual([6, 5]);
    const b = makeMountainPuzzle(hill, W, H, { ...SPEC, bed: [215, 146, 256], inRoom: true });
    expect([b.layout.cols, b.layout.rows]).toEqual([6, 4]);
  });
});
