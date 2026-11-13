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
  usualBandCount,
  WATER_BLUE,
  type ColourSpec,
  type HeightScale,
} from "../src/terrain/colour";
import { allItems, bandPlateFile, bandPuzzle, colour3mfModel, colourPuzzle } from "../src/terrain/colourFiles";
import { gridFrom } from "../src/terrain/elevation";
import { ISLAND_DEFAULTS, makeIslandPuzzle } from "../src/terrain/islandPuzzle";
import { platesFor } from "../src/terrain/puzzle3mf";

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
    expect(BAMBU_LINES).toEqual(["PLA Basic", "PLA Matte", "PLA Silk+"]);
    expect(BAMBU_COLOURS.length).toBeGreaterThan(60);
    const lines = BAMBU_COLOURS.map((c) => c.line);
    expect(lines.indexOf("PLA Matte")).toBeGreaterThan(lines.lastIndexOf("PLA Basic"));
    expect(lines.indexOf("PLA Silk+")).toBeGreaterThan(lines.lastIndexOf("PLA Matte"));
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
    for (const n of [4, 5, 6]) {
      for (const b of islandBands(500, n)) expect(ours.has(b.colour), `island ${n}: ${b.name}`).toBe(true);
      for (const b of mountainBands(200, 1200, 1000, n)) expect(ours.has(b.colour), `mountain ${n}: ${b.name}`).toBe(true);
    }
  });
  it("name the spools in the filament list", () => {
    const spec: ColourSpec = { mode: "bands", bands: islandBands(500), base: SEA_BLUE, water: SEA_BLUE, layer: 0.2 };
    const fs = filaments(spec);
    expect(fs[0].spool).toBe("Marine Blue (PLA Matte)");
    expect(fs[1].spool).toBe("Desert Tan (PLA Matte)");
    // A spool picked where two share a colour; your own colour has none.
    const black = filaments({ ...spec, bands: [...spec.bands, { name: "Peat", colour: "#000000", from: 450 }], spools: { "#000000": "11101" } });
    expect(black.find((f) => f.colour === "#000000")!.spool).toBe("Charcoal (PLA Matte)");
    expect(filaments({ ...spec, base: "#123456" })[0].spool).toBeUndefined();
  });
});

describe("Eight filaments", () => {
  it("offer more usual bands with two AMS units, as many as fit beside the base, water, paths and roads", () => {
    expect(usualBandCount(4, 3)).toBe(4);
    expect(usualBandCount(8, 3)).toBe(5);
    expect(usualBandCount(8, 1)).toBe(6);
    expect(usualBandCount(8, 0)).toBe(6);
    expect(islandBands(500, 5).map((b) => b.name)).toEqual(["Sand", "Lowland green", "Green", "Brown", "Grey"]);
    expect(islandBands(500, 6).map((b) => b.name)).toEqual(["Sand", "Lowland green", "Green", "Olive", "Brown", "Grey"]);
    // The four of one AMS are as before.
    expect(islandBands(500, 4).map((b) => [b.name, b.from])).toEqual(islandBands(500).map((b) => [b.name, b.from]));
    const m6 = mountainBands(200, 1200, 1000, 6);
    expect(m6.map((b) => b.name)).toEqual(["Lowland green", "Green", "Brown", "Grey rock", "Scree", "Snow"]);
    expect(m6[m6.length - 1]).toMatchObject({ from: 1000, snow: true });
    for (const n of [5, 6]) {
      const b = islandBands(500, n);
      for (let i = 1; i < b.length; i++) expect(b[i].from).toBeGreaterThan(b[i - 1].from);
    }
  });

  const spec: ColourSpec = { mode: "bands", bands: islandBands(island.high, usualBandCount(8, 3)), base: SEA_BLUE, water: SEA_BLUE, paths: PATH_RED, roads: ROAD_BLACK, layer: 0.2 };
  it("fit in eight: five bands, sea blue, red paths and black roads — warned about with one AMS only", () => {
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
