/**
 * Mountain / photo relief in one piece (pure): a solid relief model instead of a puzzle — one closed mesh (plus a snow
 * part above the snow line) over the layout's rectangle, the ground on top at base + height, paths cut in and still
 * closed, colour bands splitting it into closed parts that add up; the puzzle itself unchanged without the option.
 */
import { describe, expect, it } from "vitest";
import { bandParts, filaments, LAYER_DEFAULT, mapOnPuzzle, mapRaster, meshCheck, mountainBands, GROUND_BROWN, WATER_BLUE, type ColourSpec } from "../src/terrain/colour";
import { gridFrom, heightAt } from "../src/terrain/elevation";
import { baseFor, layoutFor, makeMountainPuzzle, mountainChecks, MOUNTAIN_DEFAULTS, ONE_PIECE_BASE, ONE_PIECE_UNIT, type MountainSpec } from "../src/terrain/mountainPuzzle";
import { featuresAtScale, type MapFeatures } from "../src/terrain/osm";
import { closedMesh } from "../src/terrain/waterPart";
import { weld } from "../src/geometry/threeMf";
import { bestRoom, centredRooms, platesFor, towerCorner, type BedRect } from "../src/terrain/puzzle3mf";
import { layerPlates } from "../src/terrain/mountainInPlace";
import { PRINTERS } from "../src/model/printBed";
import { makeBorder } from "../src/terrain/mountainBorder";

type XY = [number, number];
const BED: [number, number, number] = [256, 256, 256];
const sw = { e: 201000, n: 770500 };
const [W, H] = [4000, 3000];
const hill = gridFrom(sw, W, H, 20, (e, n) => 300 + 700 * Math.exp(-(((e - 202800) / 900) ** 2 + ((n - 771500) / 700) ** 2)) + 30 * Math.sin(e / 170));
const SPEC: MountainSpec = { ...MOUNTAIN_DEFAULTS, bed: BED, onePiece: true };
const closed = (b: { vertices: number[]; triangles: number[] }) => closedMesh(weld(b.vertices, b.triangles));

describe("mountain in one piece", () => {
  it("is one closed solid over the layout's rectangle, the ground on top at base + height", () => {
    const m = makeMountainPuzzle(hill, W, H, SPEC);
    expect(m.pieces.length).toBe(1);
    expect(m.layers).toBe(1);
    expect(m.spec.cube).toBe(ONE_PIECE_UNIT);
    const [p] = m.pieces;
    expect(p.bodies.length).toBe(1);
    expect(p.bodies[0].part).toBe("rock");
    expect(p.key).toBeNull();
    expect(p.pocket).toBeNull();
    const b = p.bodies[0];
    expect(closed(b)).toBe(true);
    const c = meshCheck(b.vertices, b.triangles);
    expect(c.open).toBe(0);
    expect(c.volume).toBeGreaterThan(0);
    // Its footprint: exactly the layout's rectangle (in whole mm).
    const L = m.layout;
    const [Wm, Hm] = [L.cols * ONE_PIECE_UNIT, L.rows * ONE_PIECE_UNIT];
    let [x0, y0, x1, y1, z0] = [Infinity, Infinity, -Infinity, -Infinity, Infinity];
    for (let i = 0; i < b.vertices.length; i += 3) {
      x0 = Math.min(x0, b.vertices[i]);
      x1 = Math.max(x1, b.vertices[i]);
      y0 = Math.min(y0, b.vertices[i + 1]);
      y1 = Math.max(y1, b.vertices[i + 1]);
      z0 = Math.min(z0, b.vertices[i + 2]);
    }
    expect(x0).toBe(0);
    expect(y0).toBe(0);
    expect(x1).toBeCloseTo(Wm, 9);
    expect(y1).toBeCloseTo(Hm, 9);
    expect(z0).toBe(0);
    // Fills the bed less 10 mm (to the nearest mm), and a solid's volume: about base × area plus the ground.
    expect(Math.max(Wm, Hm)).toBeGreaterThan(BED[0] - 12);
    // The top at a grid corner: base + (h − low) × k × stretch.
    const base = baseFor(SPEC);
    expect(base).toBe(SPEC.base);
    const top = new Map<string, number>();
    for (let i = 0; i < b.vertices.length; i += 3) {
      const key = `${b.vertices[i].toFixed(6)},${b.vertices[i + 1].toFixed(6)}`;
      top.set(key, Math.max(top.get(key) ?? -Infinity, b.vertices[i + 2]));
    }
    let checked = 0;
    for (const [key, z] of top) {
      const [x, y] = key.split(",").map(Number);
      if (x < 5 || y < 5 || x > Wm - 5 || y > Hm - 5 || checked > 200) continue;
      const want = base + (heightAt(hill, L.e0 + x / L.k, L.n0 + y / L.k) - L.low) * L.k * SPEC.exaggeration;
      expect(Math.abs(z - want), key).toBeLessThan(1e-6);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
    // One plate.
    expect(platesFor(m.pieces, BED).length).toBe(1);
  });

  it("splits at the snow line into closed rock and snow parts", () => {
    const m = makeMountainPuzzle(hill, W, H, { ...SPEC, snowline: 800 });
    const [p] = m.pieces;
    expect(p.bodies.map((b) => b.part).sort()).toEqual(["rock", "snow"]);
    for (const b of p.bodies) {
      expect(closed(b), b.part).toBe(true);
      expect(meshCheck(b.vertices, b.triangles).volume, b.part).toBeGreaterThan(0);
    }
  });

  it("with paths cut in it's still closed, and the grooves go down", () => {
    const L = makeMountainPuzzle(hill, W, H, SPEC).layout;
    const at = (x: number, y: number): XY => [L.e0 + x / L.k, L.n0 + y / L.k];
    const lines: MapFeatures["lines"] = [
      { kind: "path", pts: Array.from({ length: 60 }, (_, i): XY => at(20 + i * 3, 40 + 15 * Math.sin(i / 8))), thin: true, ids: ["1"] },
      { kind: "road", pts: [at(10, 120), at(220, 130)], thin: true, ids: ["2"] },
    ];
    const plain = makeMountainPuzzle(hill, W, H, SPEC);
    const m = makeMountainPuzzle(hill, W, H, { ...SPEC, snowline: 800 }, { lines, shapes: [], names: [] });
    for (const b of m.pieces[0].bodies) expect(closed(b), b.part).toBe(true);
    const vol = (q: typeof m) => q.pieces[0].bodies.reduce((s, b) => s + meshCheck(b.vertices, b.triangles).volume, 0);
    const lost = vol(plain) - vol(m);
    expect(lost).toBeGreaterThan(5);
  });

  it("colour bands split it into closed parts that add up", () => {
    const m = makeMountainPuzzle(hill, W, H, SPEC);
    const L = m.layout;
    const scale = { z0: baseFor(m.spec), h0: L.low, mmPerM: L.k * SPEC.exaggeration };
    const map = mapRaster(mapOnPuzzle(featuresAtScale({ lines: [], shapes: [], names: [] }, L.k).features, L.e0, L.n0, L.k), L.cols, L.rows);
    const cspec: ColourSpec = { mode: "bands", bands: mountainBands(L.low, L.high, 800), base: GROUND_BROWN, water: WATER_BLUE, layer: LAYER_DEFAULT };
    expect(filaments(cspec, map).length).toBeGreaterThan(2);
    const [p] = m.pieces;
    const parts = bandParts(p.bodies, p.z0, { spec: cspec, scale, map });
    expect(parts.length).toBeGreaterThan(2);
    const whole = meshCheck(p.bodies[0].vertices, p.bodies[0].triangles).volume;
    let sum = 0;
    for (const part of parts) {
      const c = meshCheck(part.vertices, part.triangles);
      expect(c.open).toBe(0);
      sum += c.volume;
    }
    expect(Math.abs(sum - whole) / whole).toBeLessThan(1e-9);
  });

  it("only checks the stretch, the scale and the printer's height", () => {
    const L = layoutFor(hill, W, H, { ...SPEC, cube: 10 });
    expect(L.cols * ONE_PIECE_UNIT).toBeGreaterThan(200);
    // Tiny cubes would be refused as a puzzle; in one piece the cube size doesn't matter.
    expect(mountainChecks({ ...SPEC, cube: 10 }, L).problems).toEqual([]);
    expect(mountainChecks({ ...SPEC, onePiece: undefined, cube: 10 }, layoutFor(hill, W, H, { ...SPEC, onePiece: undefined, cube: 10 })).problems.length).toBeGreaterThan(0);
    // Too tall for the printer.
    const tall = { ...SPEC, exaggeration: 5, bed: [256, 256, 40] as [number, number, number] };
    expect(mountainChecks(tall, layoutFor(hill, W, H, tall)).problems.join(" ")).toMatch(/taller than the printer/);
    expect(baseFor({ ...SPEC, base: 0.5 })).toBe(ONE_PIECE_BASE);
  });

  it("a border goes round it, every piece closed", () => {
    const m = makeMountainPuzzle(hill, W, H, SPEC);
    const border = makeBorder(m, "Ben Test");
    expect(border.problems).toEqual([]);
    expect(border.pieces.length).toBeGreaterThan(3);
    for (const q of border.pieces) for (const b of q.bodies) expect(meshCheck(b.vertices, b.triangles).open, q.name).toBe(0);
  });

  // The reviewer's steep, craggy mountain (5 × 4 km).
  const [SW, SH] = [5000, 4000];
  const steep = gridFrom(sw, SW, SH, 20, (e, n) => {
    const [x, y] = [(e - sw.e) / SW, (n - sw.n) / SH];
    const r = Math.hypot(x - 0.5, y - 0.5);
    return 100 + 1200 * Math.max(0, 1 - r * 2.2) ** 0.5 + (x > 0.6 && x < 0.62 ? 300 : 0) + 80 * Math.sin(e / 60) * Math.cos(n / 75);
  });

  it("can't be bigger than the bed: scale over 100% is refused", () => {
    const big = { ...SPEC, scale: 2 };
    const L = layoutFor(steep, SW, SH, big);
    const problems = mountainChecks(big, L).problems.join(" ");
    expect(problems).toMatch(/at most|between 20% and 100%/);
    expect(problems).toMatch(/bigger than the bed/);
    expect(() => makeMountainPuzzle(steep, SW, SH, big)).toThrow();
    const ok = makeMountainPuzzle(steep, SW, SH, SPEC);
    expect(ok.layout.cols * ONE_PIECE_UNIT).toBeLessThanOrEqual(BED[0]);
    expect(ok.layout.rows * ONE_PIECE_UNIT).toBeLessThanOrEqual(BED[1]);
  });

  it("sized and centred clear of the X1's no-print corner and the prime tower's corner", () => {
    const x1 = PRINTERS.find((p) => p.id === "bambu-x1")!;
    const bed = x1.size as [number, number, number];
    const keepOut: BedRect[] = [...(x1.bedExclude ?? []), towerCorner(bed)];
    const room = bestRoom(centredRooms(bed, keepOut), SW, SH);
    const spec = { ...SPEC, bed: [room[2] - room[0], room[3] - room[1], bed[2]] as [number, number, number], snowline: 900 };
    const m = makeMountainPuzzle(steep, SW, SH, spec);
    const placed = layerPlates(m.pieces, bed, room);
    expect(placed.fits).toBe(true);
    expect(placed.plates.length).toBe(1);
    const [{ move }] = placed.plates[0].pieces;
    const [W0, H0] = [m.layout.cols * ONE_PIECE_UNIT, m.layout.rows * ONE_PIECE_UNIT];
    const box: BedRect = [move[0], move[1], move[0] + W0, move[1] + H0];
    // Centred on the bed, and clear of every kept-out corner.
    expect(Math.abs(box[0] + box[2] - bed[0])).toBeLessThan(1e-6);
    expect(Math.abs(box[1] + box[3] - bed[1])).toBeLessThan(1e-6);
    for (const k of keepOut) expect(box[0] >= k[2] || box[2] <= k[0] || box[1] >= k[3] || box[3] <= k[1], JSON.stringify(k)).toBe(true);
  });

  it("the steep mountain with snow and every kind of mark: closed, and so are its colour bands", () => {
    const L0 = makeMountainPuzzle(steep, SW, SH, SPEC).layout;
    const at = (x: number, y: number): XY => [L0.e0 + x / L0.k, L0.n0 + y / L0.k];
    const ring = (cx: number, cy: number, r: number, m = 24): XY[] => Array.from({ length: m }, (_, i) => at(cx + r * Math.cos((i / m) * 2 * Math.PI), cy + r * Math.sin((i / m) * 2 * Math.PI)));
    const f: MapFeatures = {
      lines: [
        { kind: "path", pts: Array.from({ length: 80 }, (_, i): XY => at(10 + i * 2.8, 60 + 30 * Math.sin(i / 7))), thin: true, ids: ["1"] },
        { kind: "road", pts: [at(5, 200), at(120, 180), at(240, 210)], thin: true, ids: ["2"] },
        { kind: "track", pts: [at(128, 5), at(128, 240)], ids: ["3"] },
        { kind: "river", pts: [at(5, 30), at(240, 20)], ids: ["4"] },
      ],
      shapes: [
        { kind: "water", rings: [ring(60, 150, 12)] },
        { kind: "water", rings: [ring(200, 80, 8, 7)] },
        { kind: "building", rings: [[at(30, 30), at(34, 30), at(34, 34), at(30, 34)]] },
      ],
      names: [],
    };
    const m = makeMountainPuzzle(steep, SW, SH, { ...SPEC, snowline: 900, printLayer: { layer: 0.2 } }, f);
    for (const b of m.pieces[0].bodies) expect(closed(b), b.part).toBe(true);
    const L = m.layout;
    const flat = makeMountainPuzzle(steep, SW, SH, { ...SPEC, printLayer: { layer: 0.2 } }, f);
    const scale = { z0: baseFor(flat.spec), h0: L.low, mmPerM: L.k * SPEC.exaggeration };
    const map = mapRaster(mapOnPuzzle(featuresAtScale(f, L.k).features, L.e0, L.n0, L.k), L.cols * flat.spec.cube, L.rows * flat.spec.cube);
    const cspec: ColourSpec = { mode: "bands", bands: mountainBands(L.low, L.high, 900), base: GROUND_BROWN, water: WATER_BLUE, layer: LAYER_DEFAULT, paths: "#ff0000", roads: "#000000" };
    const parts = bandParts(flat.pieces[0].bodies, flat.pieces[0].z0, { spec: cspec, scale, map });
    expect(parts.length).toBeGreaterThan(3);
    for (const part of parts) expect(closed(part), `filament ${part.filament}`).toBe(true);
  });

  it("leaves the puzzle exactly as it was without the option", () => {
    const a = makeMountainPuzzle(hill, W, H, { ...MOUNTAIN_DEFAULTS, bed: BED, snowline: 800 });
    const b = makeMountainPuzzle(hill, W, H, { ...MOUNTAIN_DEFAULTS, bed: BED, snowline: 800, onePiece: false });
    expect(b.pieces.length).toBe(a.pieces.length);
    expect(a.pieces.length).toBeGreaterThan(20);
    a.pieces.forEach((p, i) => p.bodies.forEach((x, j) => expect(b.pieces[i].bodies[j].vertices).toEqual(x.vertices)));
  });
});
