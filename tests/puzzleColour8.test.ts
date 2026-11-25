/**
 * Eight filaments (two AMS units) and Bambu Lab's real PLA colours (pure): the usual colour sets are Bambu spools, more
 * bands are offered with eight slots and still fit beside the sea, red paths and black roads, the warnings count to the
 * slots there are, and the banded 3MF and the full-colour files carry all eight.
 */
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { BAMBU_COLOURS, BAMBU_LINES, bambu, spoolFor, spoolLabel } from "../src/terrain/bambuColours";
import {
  colourProblems,
  colourWarnings,
  filaments,
  followedBands,
  islandBands,
  ISLAND_COLOURS,
  mapOnPuzzle,
  mapRaster,
  MOST_FILAMENTS,
  mountainBands,
  MOUNTAIN_COLOURS,
  PATH_RED,
  ROAD_BLACK,
  SEA_BLUE,
  SPARE_COLOURS,
  GROUND_BROWN,
  usualColour,
  WATER_BLUE,
  type ColourSpec,
  type HeightScale,
} from "../src/terrain/colour";
import { allItems, bandPlateFile, bandPuzzle, colour3mfModel, colourPuzzle } from "../src/terrain/colourFiles";
import { gridFrom } from "../src/terrain/elevation";
import { ISLAND_DEFAULTS, makeIslandPuzzle } from "../src/terrain/islandPuzzle";
import { platesFor } from "../src/terrain/puzzle3mf";
import { amsSlotsOf } from "../src/app/printerSetting";

const BED: [number, number, number] = [256, 256, 256];
const IW = 6000;
const IH = 4000;
const isw = { e: 300000, n: 700000 };
const grid = gridFrom(isw, IW, IH, 25, (e, n) => {
  const [x, y] = [(e - isw.e) / IW - 0.5, (n - isw.n) / IH - 0.5];
  const r = Math.hypot(x / 0.42, y / 0.4) + 0.15 * Math.sin(Math.atan2(y, x) * 3);
  return Math.max(0, (1 - r) * 400 + 60 * Math.sin(e / 300) * (1 - r));
});
const mid = { e: isw.e + IW / 2, n: isw.n + IH / 2 };
const features = {
  lines: [
    { kind: "path" as const, pts: [[mid.e - 1800, mid.n - 300], [mid.e, mid.n + 200], [mid.e + 1500, mid.n + 900]] as [number, number][] },
    { kind: "road" as const, pts: [[mid.e - 2000, mid.n + 1100], [mid.e + 1200, mid.n - 600]] as [number, number][] },
  ],
  shapes: [{ kind: "water" as const, rings: [[[mid.e - 900, mid.n - 700], [mid.e - 300, mid.n - 700], [mid.e - 300, mid.n - 200], [mid.e - 900, mid.n - 200]]] as [number, number][][] }],
  names: [],
};
const island = makeIslandPuzzle(grid, isw, IW, IH, { ...ISLAND_DEFAULTS, bed: BED, piece: 60 }, undefined, features);
const raster = mapRaster(mapOnPuzzle(features, isw.e, isw.n, island.k), island.width, island.height);
const scale: HeightScale = { z0: ISLAND_DEFAULTS.base, h0: 0, mmPerM: ISLAND_DEFAULTS.relief / Math.max(island.high, 1) };

function unzip(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const method = view.getUint16(at + 8, true);
    const size = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const extra = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLen));
    const body = bytes.subarray(at + 30 + nameLen + extra, at + 30 + nameLen + extra + size);
    out.set(name, new TextDecoder().decode(method === 8 ? new Uint8Array(inflateRawSync(body)) : body));
    at += 30 + nameLen + extra + size;
  }
  return out;
}

describe("Bambu Lab's PLA colours", () => {
  it("are Bambu Studio's own list: PLA Basic, then Matte, then Silk+, named, with codes and colours", () => {
    expect(BAMBU_LINES.slice(0, 3)).toEqual(["PLA Basic", "PLA Matte", "PLA Silk+"]);
    expect(BAMBU_COLOURS.length).toBeGreaterThan(60);
    const lines = BAMBU_COLOURS.map((c) => c.line);
    expect(lines.indexOf("PLA Matte")).toBeGreaterThan(lines.lastIndexOf("PLA Basic"));
    expect(lines.indexOf("PLA Silk+")).toBeGreaterThan(lines.lastIndexOf("PLA Matte"));
    // The other materials come after them, so a colour is named after a PLA Basic/Matte/Silk+ spool first.
    expect(lines.findIndex((l) => !["PLA Basic", "PLA Matte", "PLA Silk+"].includes(l))).toBeGreaterThan(lines.lastIndexOf("PLA Silk+"));
    for (const c of BAMBU_COLOURS) {
      expect(c.hex, c.name).toMatch(/^#[0-9a-f]{6}$/);
      expect(c.code, c.name).toMatch(/^\d{5}$/);
    }
    expect(new Set(BAMBU_COLOURS.map((c) => c.code)).size).toBe(BAMBU_COLOURS.length);
    // A few well-known ones.
    expect(bambu("PLA Basic", "Jade White")).toBe("#ffffff");
    expect(bambu("PLA Basic", "Bambu Green")).toBe("#00ae42");
    expect(bambu("PLA Basic", "Cobalt Blue")).toBe("#0056b8");
    expect(bambu("PLA Matte", "Charcoal")).toBe("#000000");
    expect(() => bambu("PLA Basic", "Tartan")).toThrow();
  });
  it("name the spool for a colour: the one picked, else the first with it (PLA Basic first)", () => {
    expect(spoolLabel(spoolFor("#000000")!)).toBe("Black (PLA Basic)");
    expect(spoolLabel(spoolFor("#000000", "11101")!)).toBe("Charcoal (PLA Matte)");
    // A code that isn't that colour is ignored.
    expect(spoolFor("#00AE42", "11101")!.name).toBe("Bambu Green");
    expect(spoolFor("#123456")).toBeUndefined();
  });
  it("make up the usual colour sets, so the preview looks like the print", () => {
    const ours = new Set(BAMBU_COLOURS.map((c) => c.hex));
    for (const hex of [SEA_BLUE, WATER_BLUE, PATH_RED, ROAD_BLACK, ...SPARE_COLOURS, ...ISLAND_COLOURS.map((c) => c[1]), ...MOUNTAIN_COLOURS.map((c) => c[1])]) expect(ours.has(hex), hex).toBe(true);
    for (const b of islandBands(500)) expect(ours.has(b.colour), `island: ${b.name}`).toBe(true);
    for (const b of mountainBands(200, 1200, 1000)) expect(ours.has(b.colour), `mountain: ${b.name}`).toBe(true);
    expect(ours.has(GROUND_BROWN)).toBe(true);
    // Spare colours aren't the usual ones (so "+ Add a band" offers something new).
    for (const hex of SPARE_COLOURS) expect([GROUND_BROWN, ...ISLAND_COLOURS.map((c) => c[1])]).not.toContain(hex);
  });
  it("name the spools in the filament list", () => {
    const spec: ColourSpec = { mode: "bands", bands: islandBands(500), base: SEA_BLUE, water: SEA_BLUE, layer: 0.2 };
    const fs = filaments(spec);
    expect(fs[0].spool).toBe("Marine Blue (PLA Matte)");
    expect(fs[1].spool).toBe("Dark Green (PLA Matte)");
    // A spool picked where two share a colour; your own colour has none.
    const black = filaments({ ...spec, bands: [...spec.bands, { name: "Peat", colour: "#000000", from: 450 }], spools: { "#000000": "11101" } });
    expect(black.find((f) => f.colour === "#000000")!.spool).toBe("Charcoal (PLA Matte)");
    expect(filaments({ ...spec, base: "#123456" })[0].spool).toBeUndefined();
  });
});

describe("Eight filaments", () => {
  it("start with the owner's colours: Dark Brown ground, Lowland Dark Green, Upland Nardo Grey, Snow Ivory White", () => {
    const usual = usualColour(islandBands(500), SEA_BLUE);
    expect(usual.mode).toBe("bands");
    expect(usual.bands.map((b) => [b.name, b.from])).toEqual([["Lowland", 0], ["Upland", 230], ["Snow", 380]]);
    const fs = filaments(usual, raster);
    expect(fs.map((f) => [f.uses.join("+"), f.spool])).toEqual([
      ["Base", "Dark Brown (PLA Matte)"],
      ["Lowland", "Dark Green (PLA Matte)"],
      ["Upland", "Nardo Gray (PLA Matte)"],
      ["Snow", "Ivory White (PLA Matte)"],
      ["Water", "Marine Blue (PLA Matte)"],
      ["Paths", "Red (PLA Basic)"],
      ["Roads", "Black (PLA Basic)"],
    ]);
    // Seven filaments: nothing to warn about with eight slots, the usual now.
    expect(colourWarnings(usual, raster, null, 8)).toEqual([]);
    expect(colourWarnings(usual, raster, null, 4).join(" ")).toMatch(/7 filaments, and one AMS holds 4/);
    const m = mountainBands(200, 1200, 1000);
    expect(m.map((b) => [b.name, b.from])).toEqual([["Lowland", 200], ["Upland", 500], ["Snow", 1000]]);
    expect(m[2]).toMatchObject({ snow: true });
    expect(filaments(usualColour(m, WATER_BLUE), true).map((f) => f.colour)).toEqual([GROUND_BROWN, ...m.map((b) => b.colour), WATER_BLUE, PATH_RED, ROAD_BLACK]);
  });

  // The usual colours plus a sand band at the coast: eight filaments.
  const usual = usualColour(islandBands(island.high), SEA_BLUE);
  const spec: ColourSpec = { ...usual, bands: [usual.bands[0], { name: "Grass", colour: bambu("PLA Matte", "Grass Green"), from: Math.round(island.high * 0.2) }, ...usual.bands.slice(1)] };
  it("fit in eight: four bands, brown ground, sea blue, red paths and black roads — warned about with one AMS only", () => {
    expect(raster.paths && raster.roads && raster.water).toBe(true);
    const fs = filaments(spec, raster);
    expect(fs.length).toBe(MOST_FILAMENTS);
    expect(fs.map((f) => f.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(colourProblems(spec, raster)).toEqual([]);
    expect(colourWarnings(spec, raster, null, 8)).toEqual([]);
    expect(colourWarnings(spec, raster, null, 4).join(" ")).toMatch(/8 filaments, and one AMS holds 4/);
    expect(colourWarnings(spec, raster).join(" ")).toMatch(/one AMS holds 4/);
  });
  it("go into the banded 3MF as filaments 1 to 8 (parts and painted paths and roads)", async () => {
    const ctx = { spec, scale, map: raster };
    const banded = bandPuzzle(island.pieces, ctx);
    const extruders = new Set<number>();
    const paints = new Set<string>();
    for (const plate of platesFor(island.pieces, BED)) {
      const files = unzip(await bandPlateFile(plate, "Eight", banded, ctx));
      const config = files.get("Metadata/model_settings.config")!;
      const model = files.get("3D/3dmodel.model")!;
      for (const m of config.matchAll(/<metadata key="extruder" value="(\d+)"\/>/g)) extruders.add(Number(m[1]));
      for (const m of model.matchAll(/paint_color="([0-9A-F]+)"/g)) paints.add(m[1]);
    }
    expect(Math.max(...extruders)).toBeLessThanOrEqual(8);
    expect(Math.min(...extruders)).toBeGreaterThanOrEqual(1);
    // Bands as parts (at least the lower ones; the top band may be too small to reach on this island).
    for (const n of [1, 2, 3, 4]) expect(extruders.has(n), `filament ${n}`).toBe(true);
    // Paths (filament 7) and roads (8) painted on: Bambu's codes "4C" and "5C" (n − 3 in hex, then C).
    expect(paints.has("4C")).toBe(true);
    expect(paints.has("5C")).toBe(true);
  });
  it("show in full colour too", () => {
    // The pieces the path and the road cross.
    const pieces = island.pieces.filter((p) => p.bodies[0].vertices.some((_, i, v) => i % 3 === 0 && raster.kindAt(v[i], v[i + 1]) === 2 || raster.kindAt(v[i], v[i + 1]) === 4)).slice(0, 6);
    const coloured = colourPuzzle(pieces, { spec: { ...spec, mode: "full" }, scale, map: raster });
    const model = colour3mfModel(allItems(platesFor(pieces, BED), coloured, BED[0]), "Eight");
    expect(model).toContain("<m:colorgroup");
    // Red paths and black roads among the colours (shaded, so near them).
    const colours = [...model.matchAll(/<m:color color="#([0-9A-F]{6})"\/>/g)].map((m) => [0, 2, 4].map((k) => parseInt(m[1].slice(k, k + 2), 16)));
    expect(colours.some(([r, g, b]) => r > 120 && g < 70 && b < 70)).toBe(true);
    expect(colours.some(([r, g, b]) => Math.max(r, g, b) < 40)).toBe(true);
  });
});

describe("The usual bands follow the ground", () => {
  it("while they're still the usual ones, never once changed by hand", () => {
    const first = islandBands(500);
    const later = islandBands(900);
    // Untouched: the new ground's bands.
    expect(followedBands(first, first, later)).toBe(later);
    // The same ground again (a rebuild): nothing to do.
    expect(followedBands(first, first, islandBands(500))).toBeNull();
    // Changed by hand (a height or a colour): left alone.
    expect(followedBands([first[0], { ...first[1], from: 300 }, first[2]], first, later)).toBeNull();
    expect(followedBands([first[0], first[1], { ...first[2], colour: "#123456" }], first, later)).toBeNull();
    // Put back with "Usual colours and heights" (a new array, the same bands): they follow again.
    expect(followedBands(islandBands(500), first, later)).toBe(later);
  });
  it("8 filament slots unless 4 were chosen, on every printer", () => {
    expect(amsSlotsOf({ printer: "bambu-a1-mini" })).toBe(8);
    expect(amsSlotsOf({ printer: "bambu-x2d" })).toBe(8);
    expect(amsSlotsOf({ printer: "bambu-x2d", amsSlots: 4 })).toBe(4);
    expect(amsSlotsOf({ printer: "bambu-p1s", amsSlots: 4 })).toBe(4);
  });
});
