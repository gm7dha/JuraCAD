/**
 * Puzzle colours (pure): band edges on whole layers, pieces cut into one closed part per band that add up to the piece
 * with nothing between them, Bambu's paint codes, filament changes, full colour per corner (snow on gentle slopes only,
 * sides tinted by height), and the files — colour-band 3MF, colour-group 3MF, OBJ + MTL + PNG, VRML — well formed and
 * counted right; the plain plates' writer unchanged byte for byte.
 */
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { gridFrom } from "../src/terrain/elevation";
import {
  bandLevels,
  bandParts,
  colourProblems,
  colourWarnings,
  filamentSwaps,
  filaments,
  fullColours,
  heightOfZ,
  islandBands,
  LAYER_DEFAULT,
  mapOnPuzzle,
  mapRaster,
  MapKind,
  meshCheck,
  mountainBands,
  NO_MAP,
  paintCode,
  PATH_RED,
  PAINT_PENETRATION,
  ROAD_BLACK,
  palette,
  SEA_BLUE,
  SIDE_SHADE,
  sliceMesh,
  snappedCuts,
  tintAt,
  WATER_BLUE,
  zOfHeight,
  type ColourSpec,
  type HeightScale,
} from "../src/terrain/colour";
import { allItems, bandPlateFile, bandPuzzle, colour3mfModel, colourObjFiles, colourPuzzle, colourWrl, plateSwaps, pngStored, zipDeflated } from "../src/terrain/colourFiles";
import { ISLAND_DEFAULTS, makeIslandPuzzle } from "../src/terrain/islandPuzzle";
import { baseFor, makeMountainPuzzle, MOUNTAIN_DEFAULTS, type MountainSpec, type PuzzlePiece } from "../src/terrain/mountainPuzzle";
import { featuresOnGrid, readOsm } from "../src/terrain/osm";
import { GROOVES } from "../src/terrain/groundMarks";
import { gridToLatLon } from "../src/terrain/osGrid";
import { plate3mf, plateFiles, platesByLevel, platesFor } from "../src/terrain/puzzle3mf";
import { ColourCache } from "../src/terrain/colourJob";

const BED: [number, number, number] = [256, 256, 256];
const NO_MAP_RASTER = mapRaster(NO_MAP, 1, 1);

// The island and hill of the puzzles' own tests.
const IW = 6000;
const IH = 4000;
const isw = { e: 300000, n: 700000 };
const islandGrid = gridFrom(isw, IW, IH, 25, (e, n) => {
  const [x, y] = [(e - isw.e) / IW - 0.5, (n - isw.n) / IH - 0.5];
  const r = Math.hypot(x / 0.42, y / 0.4) + 0.15 * Math.sin(Math.atan2(y, x) * 3);
  return Math.max(0, (1 - r) * 400 + 60 * Math.sin(e / 300) * (1 - r));
});
const MW = 3000;
const MH = 2400;
const hill = gridFrom({ e: 200000, n: 770000 }, MW, MH, 20, (e, n) => 300 + 1000 * Math.exp(-(((e - 201500) / 800) ** 2 + ((n - 771200) / 650) ** 2)) + 40 * Math.sin(e / 170));

const island = makeIslandPuzzle(islandGrid, isw, IW, IH, { ...ISLAND_DEFAULTS, bed: BED, piece: 60 });
const islandScale: HeightScale = { z0: ISLAND_DEFAULTS.base, h0: 0, mmPerM: ISLAND_DEFAULTS.relief / Math.max(island.high, 1) };
const islandSpec = (mode: ColourSpec["mode"]): ColourSpec => ({ mode, bands: islandBands(island.high), base: SEA_BLUE, water: SEA_BLUE, layer: LAYER_DEFAULT });

const MSPEC: MountainSpec = { ...MOUNTAIN_DEFAULTS, bed: BED, cube: 40, snowline: null };
const mountain = makeMountainPuzzle(hill, MW, MH, MSPEC);
const mountainScale: HeightScale = { z0: baseFor(MSPEC), h0: mountain.layout.low, mmPerM: mountain.layout.k * MSPEC.exaggeration };
const mountainSpec = (mode: ColourSpec["mode"]): ColourSpec => ({
  mode,
  bands: mountainBands(mountain.layout.low, mountain.layout.high, 1000),
  base: null,
  water: WATER_BLUE,
  layer: LAYER_DEFAULT,
});

/** A simple well-formedness check: every tag closed in order, attributes quoted. */
function wellFormed(xml: string): boolean {
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|<\?xml[^?]*\?>/g;
  let m: RegExpExecArray | null;
  let at = 0;
  while ((m = re.exec(xml))) {
    if (xml.slice(at, m.index).includes("<")) return false;
    at = re.lastIndex;
    if (!m[2]) continue;
    if (m[1]) {
      if (stack.pop() !== m[2]) return false;
    } else if (!m[4]) stack.push(m[2]);
  }
  return stack.length === 0 && !xml.slice(at).includes("<");
}

/** The files in a zip, inflated where needed. */
function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const method = view.getUint16(at + 8, true);
    const size = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const extra = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLen));
    const body = bytes.subarray(at + 30 + nameLen + extra, at + 30 + nameLen + extra + size);
    out.set(name, method === 8 ? new Uint8Array(inflateRawSync(body)) : body);
    at += 30 + nameLen + extra + size;
  }
  return out;
}

const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b);

describe("band edges", () => {
  it("sit on whole layers of the piece as printed", () => {
    const levels = [
      { z: 3.07, filament: 2 },
      { z: 5.33, filament: 3 },
      { z: 5.38, filament: 4 },
      { z: 9.91, filament: 5 },
    ];
    for (const z0 of [0, 7.3, 41.15]) {
      const shifted = levels.map((l) => ({ ...l, z: l.z + z0 }));
      const { cuts } = snappedCuts(shifted, 1, z0, 0.2);
      for (const c of cuts) {
        const layers = (c.z - z0) / 0.2;
        expect(Math.abs(layers - Math.round(layers))).toBeLessThan(1e-9);
      }
      // 5.33 and 5.38 land on the same layer: the higher band wins.
      expect(cuts.map((c) => c.filament)).toEqual([2, 4, 5]);
    }
  });

  it("drops edges under the piece's underside and keeps the band that starts there", () => {
    const { below, cuts } = snappedCuts([{ z: 2, filament: 2 }, { z: 12, filament: 3 }, { z: 20.05, filament: 4 }], 1, 10, 0.2);
    expect(below).toBe(2);
    expect(cuts.map((c) => [Number(c.z.toFixed(6)), c.filament])).toEqual([
      [12, 3],
      [20, 4],
    ]);
  });

  it("turns ground heights into puzzle heights and back", () => {
    expect(zOfHeight(islandScale, 0)).toBe(ISLAND_DEFAULTS.base);
    expect(heightOfZ(islandScale, zOfHeight(islandScale, 123))).toBeCloseTo(123, 6);
    const { below, levels } = bandLevels(islandSpec("bands"), islandScale, filaments(islandSpec("bands")));
    expect(below).toBe(1); // the sea-blue base
    expect(levels[0].z).toBe(islandScale.z0);
    expect(levels.length).toBe(islandBands(island.high).length);
  });

  it("offers the usual colours", () => {
    expect(islandBands(500).map((b) => b.name)).toEqual(["Sand", "Green", "Brown", "Grey"]);
    expect(mountainBands(300, 1300, 1000).map((b) => b.name)).toEqual(["Green", "Brown", "Grey rock", "Snow"]);
    expect(mountainBands(300, 1300, 1000)[3]).toMatchObject({ from: 1000, snow: true });
    // Island: base and water share the sea blue, so one filament.
    expect(filaments(islandSpec("bands")).map((f) => f.uses.join("+"))).toEqual(["Base+Water", "Sand", "Green", "Brown", "Grey"]);
    expect(colourProblems(islandSpec("bands"))).toEqual([]);
    expect(colourProblems({ ...islandSpec("bands"), bands: islandBands(500).slice(0, 1) })[0]).toMatch(/between 2 and 8/);
    const many = { ...islandSpec("bands"), bands: [...islandBands(500), ...islandBands(500).map((b, i) => ({ ...b, from: 600 + i * 10, colour: `#00000${i}` }))].slice(0, 8), water: "#123456" };
    expect(colourProblems(many).some((p) => /at most 8/.test(p))).toBe(true);
  });
});

describe("cutting pieces into bands", () => {
  const checkParts = (pieces: PuzzlePiece[], banded: ReturnType<typeof bandPuzzle>) => {
    let cut = 0;
    for (const p of pieces) {
      const parts = banded.parts.get(p)!;
      let whole = 0;
      for (const b of p.bodies) whole += meshCheck(b.vertices, b.triangles).volume;
      let sum = 0;
      for (const part of parts) {
        const c = meshCheck(part.vertices, part.triangles);
        expect(c.open, `${p.name} part open`).toBe(0);
        expect(c.volume).toBeGreaterThan(0);
        sum += c.volume;
      }
      expect(Math.abs(sum - whole) / whole, p.name).toBeLessThan(1e-9);
      // No gap: each band starts where the one below it stops, and they share the corners there.
      const sorted = [...parts].sort((a, b) => a.low - b.low);
      for (let i = 1; i < sorted.length; i++) {
        cut++;
        const z = sorted[i].low;
        expect(Math.abs(sorted[i - 1].high - z)).toBeLessThan(1e-6);
        const at = (vs: number[]) => {
          const s = new Set<string>();
          for (let k = 0; k < vs.length; k += 3) if (Math.abs(vs[k + 2] - p.z0 - z) < 1e-9) s.add(`${vs[k].toFixed(6)},${vs[k + 1].toFixed(6)}`);
          return s;
        };
        const [below, above] = [at(sorted[i - 1].vertices), at(sorted[i].vertices)];
        expect(below.size).toBeGreaterThan(2);
        expect([...below].every((k) => above.has(k))).toBe(true);
        expect(below.size).toBe(above.size);
        // On a whole layer, give or take the little it's moved off the mesh's corners (well inside the layer).
        expect(Math.abs(z / LAYER_DEFAULT - Math.round(z / LAYER_DEFAULT))).toBeLessThan(0.25);
      }
    }
    return cut;
  };

  it("an island's pieces: every part closed, adding up to the piece, no gaps", () => {
    const ctx = { spec: islandSpec("bands"), scale: islandScale, map: NO_MAP_RASTER };
    const banded = bandPuzzle(island.pieces, ctx);
    expect(banded.uncut).toBe(0);
    expect(checkParts(island.pieces, banded)).toBeGreaterThan(island.pieces.length);
  });

  it("a mountain's pieces, cubes and tops alike", () => {
    const ctx = { spec: mountainSpec("bands"), scale: mountainScale, map: NO_MAP_RASTER };
    const banded = bandPuzzle(mountain.pieces, ctx);
    expect(banded.uncut).toBe(0);
    expect(checkParts(mountain.pieces, banded)).toBeGreaterThan(0);
  });

  it("a box cut anywhere, even through its corners' heights", () => {
    const v = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10];
    const t = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
    const slabs = sliceMesh(v, t, [0, 2.5, 10, 7]);
    const vols = slabs.map((s) => (s.triangles.length ? meshCheck(s.vertices, s.triangles) : { volume: 0, open: 0 }));
    expect(vols.every((c) => c.open === 0)).toBe(true);
    expect(vols.reduce((a, c) => a + c.volume, 0)).toBeCloseTo(1000, 6);
  });

  it("paints the map's water onto the ground and counts filament changes", () => {
    const water = mapRaster(
      { lines: [], shapes: [{ kind: "water", rings: [[[0, 0], [island.width, 0], [island.width, island.height], [0, island.height]]] }], woods: [] },
      island.width,
      island.height,
    );
    expect(water.water).toBe(true);
    const ctx = { spec: islandSpec("bands"), scale: islandScale, map: water };
    const banded = bandPuzzle(island.pieces.slice(0, 3), ctx);
    let painted = 0;
    for (const parts of banded.parts.values()) for (const p of parts) painted += p.paint ? p.paint.filter((f) => f === 1).length : 0;
    expect(painted).toBeGreaterThan(100);
    const plates = platesFor(island.pieces.slice(0, 3), BED);
    const swaps = plateSwaps(plates, banded, LAYER_DEFAULT);
    expect(swaps[0]).toBeGreaterThan(3);
    expect(swaps[0]).toBeLessThan(40);
  });

  it("filament changes: one per new band up a single piece, more where pieces differ", () => {
    expect(filamentSwaps([{ filament: 1, low: 0, high: 2 }, { filament: 2, low: 2, high: 4 }, { filament: 3, low: 4, high: 6 }], 0.2)).toBe(2);
    expect(filamentSwaps([{ filament: 1, low: 0, high: 2 }, { filament: 1, low: 0, high: 2 }], 0.2)).toBe(0);
    // Two pieces, out of step: both filaments on every layer from 1 mm.
    const two = filamentSwaps([{ filament: 1, low: 0, high: 1 }, { filament: 2, low: 1, high: 3 }, { filament: 2, low: 0, high: 3 }], 0.2);
    expect(two).toBeGreaterThanOrEqual(5);
  });

  it("writes Bambu's paint codes", () => {
    expect([1, 2, 3, 4, 8, 17, 18, 19].map(paintCode)).toEqual(["4", "8", "0C", "1C", "5C", "EC", "0FC", "1FC"]);
  });
});


describe("the map on the puzzle", () => {
  it("reads woods from a map file and finds water, roads and woods on the grid", () => {
    const base = { e: 201000, n: 770500 };
    let id = 0;
    const nodes: string[] = [];
    const node = (de: number, dn: number) => {
      const p = gridToLatLon({ e: base.e + de, n: base.n + dn });
      nodes.push(`<node id="${++id}" lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"/>`);
      return id;
    };
    const wood = [node(0, 0), node(1000, 0), node(1000, 1000), node(0, 1000)];
    const road = [node(0, 1500), node(1000, 1500)];
    const xml = `<osm version="0.6">${nodes.join("")}<way id="1">${[...wood, wood[0]].map((r) => `<nd ref="${r}"/>`).join("")}<tag k="natural" v="wood"/></way><way id="2">${road
      .map((r) => `<nd ref="${r}"/>`)
      .join("")}<tag k="highway" v="tertiary"/></way></osm>`;
    const data = readOsm(xml);
    expect(data.woods?.length).toBe(1);
    expect(data.shapes.length).toBe(0);
    const f = featuresOnGrid(data, "all");
    expect(f.woods?.length).toBe(1);
    expect(featuresOnGrid(data, "area").woods).toBeUndefined();
    const map = mapOnPuzzle(f, base.e - 100, base.n - 100, 0.1);
    const r = mapRaster(map, 120, 180);
    expect(r.kindAt(60, 60)).toBe(MapKind.Wood);
    expect(r.kindAt(60, 160)).toBe(MapKind.Road);
    expect(r.kindAt(60, 130)).toBe(MapKind.None);
    expect(r.water).toBe(false);
  });
});

describe("full colour", () => {
  it("colours every corner: tinted sides, shaded ground, snow only on gentle slopes above the line", () => {
    const spec = mountainSpec("full");
    const ctx = { spec, scale: mountainScale, map: NO_MAP_RASTER };
    const tops = mountain.pieces.filter((p) => p.top);
    let snowy = 0;
    let steepSnow = 0;
    let sides = 0;
    for (const p of tops) {
      const m = fullColours(p.bodies, ctx);
      expect(m.rgb.length).toBe(m.triangles.length * 3);
      expect(meshCheck(m.vertices, m.triangles).open).toBe(0);
      const V = m.vertices;
      for (let t = 0; t < m.triangles.length; t += 3) {
        const [a, b, c] = [m.triangles[t], m.triangles[t + 1], m.triangles[t + 2]];
        const u = [V[b * 3] - V[a * 3], V[b * 3 + 1] - V[a * 3 + 1], V[b * 3 + 2] - V[a * 3 + 2]];
        const w = [V[c * 3] - V[a * 3], V[c * 3 + 1] - V[a * 3 + 1], V[c * 3 + 2] - V[a * 3 + 2]];
        const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const nz = n[2] / Math.hypot(n[0], n[1], n[2]);
        for (let k = 0; k < 3; k++) {
          const i = m.triangles[t + k];
          const [r, g, bl] = [m.rgb[(t + k) * 3], m.rgb[(t + k) * 3 + 1], m.rgb[(t + k) * 3 + 2]];
          const white = r > 225 && g > 225 && bl > 225;
          const h = heightOfZ(mountainScale, V[i * 3 + 2]);
          if (Math.abs(nz) < 0.05) {
            // A side: the tint at its height, a little darker.
            const tint = tintAt(spec.bands, h);
            expect(Math.abs(r - Math.round(tint[0] * SIDE_SHADE))).toBeLessThanOrEqual(1);
            sides++;
          } else if (white && nz > 0.2) {
            snowy++;
            expect(h).toBeGreaterThan(1000 - 60);
            if (nz < 0.6) steepSnow++;
          }
        }
      }
    }
    expect(sides).toBeGreaterThan(100);
    expect(snowy).toBeGreaterThan(10);
    expect(steepSnow).toBe(0);
  });

  it("writes a colour-group 3MF, OBJ + MTL + palette PNG and VRML, all well formed and counted right", async () => {
    const spec = { ...islandSpec("full"), water: WATER_BLUE };
    const across = [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => ({ kind: "river" as const, pts: [[0, island.height * f], [island.width, island.height * f]] as [number, number][] }));
    const water = mapRaster({ lines: across, shapes: [], woods: [] }, island.width, island.height);
    const pieces = island.pieces.slice(0, 2);
    const coloured = colourPuzzle(pieces, { spec, scale: islandScale, map: water });
    const plates = platesFor(pieces, BED);
    const items = allItems(plates, coloured, BED[0]);
    const tris = items.reduce((n, it) => n + it.mesh.triangles.length / 3, 0);
    const verts = items.reduce((n, it) => n + it.mesh.vertices.length / 3, 0);

    const model = colour3mfModel(items, "Island & <test>");
    expect(wellFormed(model)).toBe(true);
    const colours = (model.match(/<m:color color="#[0-9A-F]{6}"\/>/g) ?? []).length;
    expect(colours).toBe(palette(Uint8Array.from(items.flatMap((it) => [...it.mesh.rgb]))).colours.length);
    const triangles = model.match(/<triangle [^>]*\/>/g) ?? [];
    expect(triangles.length).toBe(tris);
    for (const t of triangles.slice(0, 2000)) {
      const [, p1, p2, p3] = /p1="(\d+)" p2="(\d+)" p3="(\d+)"/.exec(t)!.map(Number);
      expect(Math.max(p1, p2, p3)).toBeLessThan(colours);
    }
    expect(model).toContain('xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"');
    // Some river blue on the ground.
    expect(model).toContain('<m:color color="#3C7CC0"/>');

    const { obj, mtl, png } = colourObjFiles(items, "Island puzzle");
    const vs = obj.split("\n").filter((l) => l.startsWith("v ")).length;
    const vts = obj.split("\n").filter((l) => l.startsWith("vt ")).length;
    const fs = obj.split("\n").filter((l) => l.startsWith("f "));
    expect(vs).toBe(verts);
    expect(fs.length).toBe(tris);
    for (const f of fs) {
      for (const c of f.slice(2).split(" ")) {
        const [v, vt] = c.split("/").map(Number);
        if (!(v >= 1 && v <= vs && vt >= 1 && vt <= vts)) throw new Error(`bad face ${f}`);
      }
    }
    expect(obj).toContain("mtllib Island puzzle.mtl");
    expect(mtl).toContain("map_Kd Island puzzle.png");
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(new DataView(png.buffer, png.byteOffset).getUint32(16)).toBe(256);

    const wrl = colourWrl(items, "Island");
    expect(wrl.startsWith("#VRML V2.0 utf8\n")).toBe(true);
    expect((wrl.match(/{/g) ?? []).length).toBe((wrl.match(/}/g) ?? []).length);
    expect((wrl.match(/\[/g) ?? []).length).toBe((wrl.match(/]/g) ?? []).length);
    const faces = (wrl.match(/^ {8}\d+ \d+ \d+ -1,$/gm) ?? []).length;
    expect(faces).toBe(tris * 2); // coordIndex and colorIndex
    expect((wrl.match(/DEF \w+ Transform/g) ?? []).length).toBe(items.length);

    // The zip opens with ordinary inflate and gives back the same text.
    const zip = await zipDeflated([{ name: "3D/3dmodel.model", data: model }]);
    expect(zip.length).toBeLessThan(model.length / 2);
    expect(text(unzip(zip).get("3D/3dmodel.model"))).toBe(model);
  });

  it("a stored PNG of any size", () => {
    const rgb = new Uint8Array(300 * 300 * 3).fill(7);
    const png = pngStored(300, 300, rgb);
    expect(png.length).toBeGreaterThan(rgb.length);
  });
});

describe("colour-band plates", () => {
  it("write a part per band with its filament and water painted, well formed (and compressed)", async () => {
    const water = mapRaster({ lines: [], shapes: [{ kind: "water", rings: [[[0, 0], [island.width / 2, 0], [island.width / 2, island.height], [0, island.height]]] }], woods: [] }, island.width, island.height);
    const ctx = { spec: islandSpec("bands"), scale: islandScale, map: water };
    const pieces = island.pieces.slice(0, 3);
    const banded = bandPuzzle(pieces, ctx);
    const [plate] = platesFor(pieces, BED);
    const files = unzip(await bandPlateFile(plate, "Bands", banded, ctx));
    const model = text(files.get("3D/3dmodel.model"));
    const config = text(files.get("Metadata/model_settings.config"));
    expect(wellFormed(model)).toBe(true);
    expect(wellFormed(config)).toBe(true);
    let parts = 0;
    let painted = 0;
    for (const p of pieces) for (const b of banded.parts.get(p)!) (parts++, (painted += b.paint ? b.paint.filter(Boolean).length : 0));
    expect((config.match(/<part id=/g) ?? []).length).toBe(parts);
    expect((model.match(/paint_color="4"/g) ?? []).length).toBe(painted);
    expect(painted).toBeGreaterThan(0);
    expect(config).toContain('<metadata key="extruder" value="2"/>');
    expect(model).toContain("Sand (filament 2)");
  });

  it("the plain plates' writer is unchanged, byte for byte", () => {
    const box = (x0: number, z0: number, s: number) => {
      const v: number[] = [];
      for (const z of [z0, z0 + s]) for (const [x, y] of [[x0, 0], [x0 + s, 0], [x0 + s, s], [x0, s]]) v.push(x, y, z);
      return { vertices: v, triangles: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7] };
    };
    const piece = (name: string, x: number): PuzzlePiece => ({
      name,
      col: 0,
      row: 0,
      layer: 0,
      top: true,
      z0: 0,
      height: 10,
      outline: [[x, 0], [x + 10, 0], [x + 10, 10], [x, 10]],
      key: null,
      pocket: null,
      bodies: [{ part: "rock", ...box(x, 0, 10) }, { part: "snow", ...box(x, 10, 2) }],
    });
    const plate = { pieces: [{ piece: piece("A1-1 & <x>", 0), move: [5, 5, 0] as [number, number, number] }, { piece: piece("B1-1", 20), move: [1.234567, 2, 0] as [number, number, number] }] };
    // The hash of what v0.52 wrote for this plate.
    expect(createHash("sha256").update(plate3mf(plate, 'Test "plate"')).digest("hex")).toBe("1d9e6116aef5c7dd853a5743022fd09ad2a596e2b7f7370287b175c45a4de2df");
    expect(plateFiles(plate, "x").model).not.toContain("paint_color");
  });
});

describe("review fixes", () => {
  const cube = (s: number) => {
    const v = [0, 0, 0, s, 0, 0, s, s, 0, 0, s, 0, 0, 0, s, s, 0, s, s, s, s, 0, s, s];
    const t = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
    return [{ part: "rock" as const, vertices: v, triangles: t }];
  };

  it("bands keep their order when one starts below the ground and the base has its own colour", () => {
    const spec: ColourSpec = {
      mode: "bands",
      bands: [
        { name: "A", colour: "#ff0000", from: 0 },
        { name: "B", colour: "#00ff00", from: -10 },
        { name: "C", colour: "#0000ff", from: 50 },
      ],
      base: "#000000",
      water: null,
      layer: 0.2,
    };
    const scale: HeightScale = { z0: 3, h0: 0, mmPerM: 0.1 };
    const fs = filaments(spec, false);
    const { levels } = bandLevels(spec, scale, fs);
    for (let i = 1; i < levels.length; i++) expect(levels[i].z).toBeGreaterThanOrEqual(levels[i - 1].z);
    const parts = bandParts(cube(10), 0, { spec, scale, map: NO_MAP_RASTER }).sort((a, b) => a.low - b.low);
    const name = (n: number) => fs.find((f) => f.n === n)!.uses.join("+");
    // The base under the ground (to 3 mm), then B — starting below the ground, it takes the ground from A — then C at 8 mm.
    expect(parts.map((p) => name(p.filament))).toEqual(["Base", "B", "C"]);
    expect(parts.map((p) => Number(p.high.toFixed(2)))).toEqual([3, 8, 10]);
    // Each slab's filament matches the band of its height.
    for (const p of parts) expect(meshCheck(p.vertices, p.triangles).open).toBe(0);
  });

  it("snaps to the first layer's height, then whole layers", () => {
    // Layer tops at 0.3 (the first layer), 0.5, 0.7, 0.9, 1.1…: 0.25 goes to 0.3, 1.05 to 1.1 — and the lower one first.
    const { cuts } = snappedCuts([{ z: 1.05, filament: 2 }, { z: 0.25, filament: 3 }], 1, 0, 0.2, 0.3);
    expect(cuts.map((c) => [Number(c.z.toFixed(6)), c.filament])).toEqual([
      [0.3, 3],
      [1.1, 2],
    ]);
  });

  it("puts a mountain's pieces of different heights on plates of their own, so plates need few filament changes", () => {
    const spec = { ...MSPEC, cube: 30 };
    const m = makeMountainPuzzle(hill, MW, MH, spec);
    const scale: HeightScale = { z0: baseFor(spec), h0: m.layout.low, mmPerM: m.layout.k * spec.exaggeration };
    const cs = { ...mountainSpec("bands"), bands: mountainBands(m.layout.low, m.layout.high, 1000), water: null };
    const banded = bandPuzzle(m.pieces, { spec: cs, scale, map: NO_MAP_RASTER });
    const mixed = plateSwaps(platesFor(m.pieces, BED), banded, cs.layer);
    const plates = platesByLevel(m.pieces, BED);
    // Every plate has one underside height.
    for (const pl of plates) expect(new Set(pl.pieces.map((x) => x.piece.z0.toFixed(4))).size).toBe(1);
    expect(plates.reduce((n, pl) => n + pl.pieces.length, 0)).toBe(m.pieces.length);
    const swaps = plateSwaps(plates, banded, cs.layer);
    for (const n of swaps) expect(n).toBeLessThanOrEqual(cs.bands.length - 1);
    expect(swaps.reduce((a, b) => a + b, 0)).toBeLessThan(mixed.reduce((a, b) => a + b, 0));
  });

  it("warns past one AMS's four filaments, and when no band starts within the ground", () => {
    expect(colourWarnings(islandSpec("bands"), true).some((w) => /one AMS holds 4/.test(w))).toBe(true);
    const four = { ...islandSpec("bands"), bands: islandBands(500).slice(0, 3) };
    expect(colourWarnings(four, true).some((w) => /AMS/.test(w))).toBe(false);
    const high = { ...four, bands: islandBands(5000) };
    expect(colourWarnings(high, true, [0, 300]).some((w) => /No band starts between 0 m and 300 m/.test(w))).toBe(true);
    expect(colourWarnings(four, true, [0, 500]).some((w) => /No band/.test(w))).toBe(false);
  });

  it("colours in a worker's cache: a change of colour alone doesn't cut the pieces again", () => {
    const cache = new ColourCache();
    const pieces = island.pieces.slice(0, 2).map((p) => ({ bodies: p.bodies, z0: p.z0, height: p.height, top: p.top }));
    const job = { id: 1, pieces, spec: islandSpec("bands"), scale: islandScale, map: NO_MAP, mapSize: [1, 1] as [number, number], mapId: 1 };
    const r1 = cache.run(job);
    expect("error" in r1).toBe(false);
    expect(cache.cuts).toBe(1);
    const recoloured = { ...islandSpec("bands"), bands: islandSpec("bands").bands.map((b, i) => (i === 1 ? { ...b, colour: "#123456", name: "Moss" } : b)) };
    const r2 = cache.run({ ...job, id: 2, pieces: undefined, spec: recoloured });
    expect(cache.cuts).toBe(1);
    if ("error" in r2 || r2.mode !== "bands") throw new Error("expected bands");
    expect(r2.preview.length).toBe(2);
    const higher = { ...islandSpec("bands"), bands: islandSpec("bands").bands.map((b, i) => (i === 2 ? { ...b, from: b.from + 50 } : b)) };
    cache.run({ ...job, id: 3, pieces: undefined, spec: higher });
    expect(cache.cuts).toBe(2);
    const full = cache.run({ ...job, id: 4, pieces: undefined, spec: islandSpec("full") });
    if ("error" in full || full.mode !== "full") throw new Error("expected full colour");
    expect(full.full.length).toBe(2);
  });
});

describe("red paths and black roads", () => {
  // The test island with a footpath, a track and a road pressed into it (OS grid metres).
  const mid = { e: isw.e + IW / 2, n: isw.n + IH / 2 };
  const features = {
    lines: [
      { kind: "path" as const, pts: [[mid.e - 1800, mid.n - 300], [mid.e, mid.n + 200], [mid.e + 1500, mid.n + 900]] as [number, number][] },
      { kind: "track" as const, pts: [[mid.e - 1000, mid.n - 1200], [mid.e + 800, mid.n - 900]] as [number, number][] },
      { kind: "road" as const, pts: [[mid.e - 2000, mid.n + 1100], [mid.e + 1200, mid.n - 600]] as [number, number][] },
    ],
    shapes: [],
    names: [],
  };
  const marked = makeIslandPuzzle(islandGrid, isw, IW, IH, { ...ISLAND_DEFAULTS, bed: BED, piece: 60 }, undefined, features);
  const pmap = mapOnPuzzle(features, isw.e, isw.n, marked.k);
  const raster = mapRaster(pmap, marked.width, marked.height);
  const scale: HeightScale = { z0: ISLAND_DEFAULTS.base, h0: 0, mmPerM: ISLAND_DEFAULTS.relief / Math.max(marked.high, 1) };
  const spec = (mode: ColourSpec["mode"]): ColourSpec => ({ ...islandSpec(mode), paths: PATH_RED, roads: ROAD_BLACK });
  const distTo = (x: number, y: number, pts: [number, number][]) => {
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
      best = Math.min(best, Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy));
    }
    return best;
  };

  it("the map knows it has paths and roads; they count as filaments and towards the AMS warning", () => {
    expect(raster.paths).toBe(true);
    expect(raster.roads).toBe(true);
    expect(raster.water).toBe(false);
    const fs = filaments(spec("bands"), raster);
    expect(fs.map((f) => f.uses.join("+"))).toEqual(["Base", "Sand", "Green", "Brown", "Grey", "Paths", "Roads"]);
    expect(filaments(spec("bands"), { water: true, paths: false, roads: false }).some((f) => f.uses.includes("Paths"))).toBe(false);
    expect(filaments({ ...spec("bands"), paths: null }, raster).some((f) => f.uses.includes("Paths"))).toBe(false);
    expect(colourWarnings(spec("bands"), raster).some((w) => /7 filaments/.test(w))).toBe(true);
  });

  it("paints only the grooves: path triangles on the footpath and track, road triangles on the road", () => {
    const ctx = { spec: spec("bands"), scale, map: raster };
    const fs = filaments(ctx.spec, raster);
    const pathN = fs.find((f) => f.uses.includes("Paths"))!.n;
    const roadN = fs.find((f) => f.uses.includes("Roads"))!.n;
    const banded = bandPuzzle(marked.pieces, ctx);
    let paths = 0;
    let roads = 0;
    const pathLines = pmap.lines.filter((l) => l.kind !== "road").map((l) => l.pts);
    const roadLine = pmap.lines.find((l) => l.kind === "road")!.pts;
    for (const parts of banded.parts.values())
      for (const p of parts) {
        if (!p.paint) continue;
        for (let t = 0; t < p.triangles.length; t += 3) {
          const f = p.paint[t / 3];
          if (!f) continue;
          const ids = [p.triangles[t], p.triangles[t + 1], p.triangles[t + 2]];
          const x = ids.reduce((s, i) => s + p.vertices[i * 3], 0) / 3;
          const y = ids.reduce((s, i) => s + p.vertices[i * 3 + 1], 0) / 3;
          if (f === pathN) {
            paths++;
            // Within the groove (half its width, plus the map grid's cell).
            expect(Math.min(...pathLines.map((l) => distTo(x, y, l)))).toBeLessThan(GROOVES.track.width / 2 + 0.25);
          } else if (f === roadN) {
            roads++;
            expect(distTo(x, y, roadLine)).toBeLessThan(GROOVES.road.width / 2 + 0.25);
          } else throw new Error(`unexpected paint ${f}`);
        }
        // Paint is on the layers where the painted triangles are.
        for (const r of p.paintRanges ?? []) expect(r.low).toBeGreaterThanOrEqual(p.low - 1e-6);
      }
    expect(paths).toBeGreaterThan(50);
    expect(roads).toBeGreaterThan(50);
    // Switched off: nothing painted.
    const off = bandPuzzle(marked.pieces.slice(0, 4), { ...ctx, spec: { ...ctx.spec, paths: null, roads: null } });
    for (const parts of off.parts.values()) for (const p of parts) expect(p.paint).toBeUndefined();
  });

  it("filament changes count paint on the layers it spans", () => {
    const flat = [{ filament: 1, low: 0, high: 2 }];
    expect(filamentSwaps(flat, 0.2)).toBe(0);
    // Red paint from 1 to 1.4 mm on a one-colour part: on and off it, about twice per layer there.
    const painted = filamentSwaps([{ filament: 1, low: 0, high: 2, paintRanges: [{ filament: 2, low: 1, high: 1.4 }] }], 0.2);
    expect(painted).toBeGreaterThanOrEqual(3);
    expect(painted).toBeLessThanOrEqual(6);
  });

  it("full colour: paths red and roads black", () => {
    const coloured = colourPuzzle(marked.pieces, { spec: spec("full"), scale, map: raster });
    let red = 0;
    let black = 0;
    for (const m of coloured.values())
      for (let c = 0; c < m.triangles.length; c++) {
        const i = m.triangles[c];
        const kind = raster.kindAt(m.vertices[i * 3], m.vertices[i * 3 + 1]);
        const [r, g, b] = [m.rgb[c * 3], m.rgb[c * 3 + 1], m.rgb[c * 3 + 2]];
        const t = c - (c % 3);
        const ids = [m.triangles[t], m.triangles[t + 1], m.triangles[t + 2]];
        const up = (() => {
          const V = m.vertices;
          const [a, bb, cc] = ids;
          const u = [V[bb * 3] - V[a * 3], V[bb * 3 + 1] - V[a * 3 + 1], V[bb * 3 + 2] - V[a * 3 + 2]];
          const w = [V[cc * 3] - V[a * 3], V[cc * 3 + 1] - V[a * 3 + 1], V[cc * 3 + 2] - V[a * 3 + 2]];
          const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
          return n[2] / Math.hypot(n[0], n[1], n[2]) > 0.5;
        })();
        if (!up) continue;
        if (kind === MapKind.Path || kind === MapKind.Track) {
          red++;
          expect(r > 150 && g < 70 && b < 70, `path corner ${r},${g},${b}`).toBe(true);
        } else if (kind === MapKind.Road) {
          black++;
          expect(Math.max(r, g, b), `road corner ${r},${g},${b}`).toBeLessThan(50);
        }
      }
    expect(red).toBeGreaterThan(50);
    expect(black).toBeGreaterThan(50);
  });
});

describe("map paint on mountains", () => {
  // The test hill with a footpath straight up its flank and over the top, and a road round its foot.
  const e0 = 200000;
  const n0 = 770000;
  const features = {
    lines: [
      { kind: "path" as const, pts: [[e0 + 300, n0 + 1200], [e0 + 1500, n0 + 1200], [e0 + 2700, n0 + 1150]] as [number, number][] },
      { kind: "road" as const, pts: [[e0 + 200, n0 + 300], [e0 + 2800, n0 + 400]] as [number, number][] },
    ],
    shapes: [],
    names: [],
  };
  const spec = { ...MSPEC, cube: 30 };
  const m = makeMountainPuzzle(hill, MW, MH, spec, features);
  const scale: HeightScale = { z0: baseFor(spec), h0: m.layout.low, mmPerM: m.layout.k * spec.exaggeration };
  const raster = mapRaster(mapOnPuzzle(features, m.layout.e0, m.layout.n0, m.layout.k), m.layout.cols * spec.cube, m.layout.rows * spec.cube);
  const cs: ColourSpec = { ...mountainSpec("bands"), paths: PATH_RED, roads: ROAD_BLACK };
  const ctx = { spec: cs, scale, map: raster };
  const banded = bandPuzzle(m.pieces, ctx);
  const fs = filaments(cs, raster);
  const pathN = fs.find((f) => f.uses.includes("Paths"))!.n;

  it("paints only the top pieces: pieces under them get none", () => {
    let lower = 0;
    let painted = 0;
    for (const p of m.pieces) {
      const parts = banded.parts.get(p)!;
      if (!p.top) {
        lower++;
        for (const part of parts) expect(part.paint, `${p.name} has paint`).toBeUndefined();
      } else painted += parts.filter((q) => q.paint).length;
    }
    expect(lower).toBeGreaterThan(5);
    expect(painted).toBeGreaterThan(3);
    // Full colour too: nothing red on a lower piece.
    for (const p of m.pieces.filter((q) => !q.top).slice(0, 10)) {
      const c = fullColours(p.bodies, { spec: { ...cs, mode: "full" }, scale, map: raster }, false);
      for (let i = 0; i < c.rgb.length; i += 3) expect(c.rgb[i] > 180 && c.rgb[i + 1] < 70).toBe(false);
    }
  });

  it("leaves no gaps on a steep flank: every face under the path that isn't a wall is painted", () => {
    let painted = 0;
    let gaps = 0;
    for (const p of m.pieces.filter((q) => q.top))
      for (const part of banded.parts.get(p)!) {
        const V = part.vertices;
        for (let t = 0; t < part.triangles.length; t += 3) {
          const [a, b, c] = [part.triangles[t], part.triangles[t + 1], part.triangles[t + 2]];
          const u = [V[b * 3] - V[a * 3], V[b * 3 + 1] - V[a * 3 + 1], V[b * 3 + 2] - V[a * 3 + 2]];
          const w = [V[c * 3] - V[a * 3], V[c * 3 + 1] - V[a * 3 + 1], V[c * 3 + 2] - V[a * 3 + 2]];
          const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
          const nz = n[2] / Math.hypot(n[0], n[1], n[2]);
          if (nz <= 0.05) continue;
          const zs = [a, b, c].map((i) => V[i * 3 + 2]);
          // A cut face inside the piece (flat at the part's top, with a band above).
          if (zs.every((z) => Math.abs(z - (part.high + p.z0)) < 1e-9) && part.high + p.z0 < p.z0 + p.height - 1e-6 && zs.every((z) => Math.abs(z - zs[0]) < 1e-12)) continue;
          const x = (V[a * 3] + V[b * 3] + V[c * 3]) / 3;
          const y = (V[a * 3 + 1] + V[b * 3 + 1] + V[c * 3 + 1]) / 3;
          if (raster.kindAt(x, y) !== MapKind.Path) continue;
          if (part.paint?.[t / 3] === pathN) painted++;
          else gaps++;
        }
      }
    expect(painted).toBeGreaterThan(100);
    expect(gaps).toBe(0);
  });

  it("counts paint three layers into the part (Bambu's top paint penetration) and says how many changes the paths cost", () => {
    expect(PAINT_PENETRATION).toBe(3);
    const plates = platesByLevel(m.pieces, BED);
    const all = plateSwaps(plates, banded, cs.layer);
    const off = plateSwaps(plates, banded, cs.layer, fs.filter((f) => f.uses.includes("Paths") || f.uses.includes("Roads")).map((f) => f.n));
    expect(off.reduce((a, b) => a + b, 0)).toBeLessThan(all.reduce((a, b) => a + b, 0));
    // Lower pieces' plates: no paint, so the same either way.
    plates.forEach((pl, i) => {
      if (pl.pieces.every((x) => !x.piece.top)) expect(all[i]).toBe(off[i]);
    });
  });
});
