/**
 * OpenStreetMap files (pure): latitude/longitude onto the OS grid, reading an .osm file's area, paths, rivers,
 * lochs (with islands), buildings and names, the three levels of detail, and those features pressed into a printed
 * mountain puzzle — grooves where paths run, flat water, every part still a closed mesh.
 */
import { describe, expect, it } from "vitest";
import { weld } from "../src/geometry/threeMf";
import { gridFrom } from "../src/terrain/elevation";
import { groundMarks, GROOVES, WATER_DROP } from "../src/terrain/groundMarks";
import { makeMountainPuzzle, MOUNTAIN_DEFAULTS, type Body } from "../src/terrain/mountainPuzzle";
import { gridToLatLon, latLonToGrid, parseGridRef } from "../src/terrain/osGrid";
import { sampleOsm } from "./support/osmSample";
import { featuresOnGrid, featureSummary, osmArea, OsmError, readOsm } from "../src/terrain/osm";

describe("Latitude/longitude onto the OS grid", () => {
  it("is the exact way back from gridToLatLon (within 1 cm), and puts Ben Nevis where the map does", () => {
    for (const ref of ["NN 16667 71283", "SH 60971 54366", "TQ 30080 80390", "NC 20000 30000", "SX 50000 60000"]) {
      const g = parseGridRef(ref)!;
      const back = latLonToGrid(gridToLatLon(g));
      expect(Math.abs(back.e - g.e), ref).toBeLessThan(0.01);
      expect(Math.abs(back.n - g.n), ref).toBeLessThan(0.01);
    }
    const ben = latLonToGrid({ lat: 56.79685, lon: -5.00368 });
    expect(Math.abs(ben.e - 216667)).toBeLessThan(10);
    expect(Math.abs(ben.n - 771283)).toBeLessThan(10);
  });
});

describe("Reading an OpenStreetMap file", () => {
  const data = readOsm(sampleOsm());

  it("finds the area, the lines, the loch with its island, the building and the names", () => {
    expect(data.lines.map((l) => l.kind).sort()).toEqual(["path", "road", "stream"]);
    const loch = data.shapes.find((s) => s.kind === "water")!;
    expect(loch.rings.length).toBe(2);
    expect(loch.name).toBe("Lochan Meall");
    expect(data.shapes.filter((s) => s.kind === "building").length).toBe(1);
    expect(data.names.map((n) => n.text).sort()).toEqual(["CIC Hut", "Sgùrr & Beinn 1044 m"]);
    const a = osmArea(data);
    if (typeof a === "string") throw new Error(a);
    // The grid-aligned box inside the export box (the grid is turned about 2.5° there): a little smaller, never bigger.
    expect(a.sw.e).toBeGreaterThanOrEqual(201000);
    expect(a.sw.n).toBeGreaterThanOrEqual(770500);
    expect(a.width).toBeGreaterThan(3600);
    expect(a.width).toBeLessThanOrEqual(4000);
    expect(a.height).toBeGreaterThan(2600);
    expect(a.height).toBeLessThanOrEqual(3000);
  });

  it("keeps as much as asked for", () => {
    expect(featuresOnGrid(data, "area")).toEqual({ lines: [], shapes: [], names: [] });
    const water = featuresOnGrid(data, "water");
    expect(water.lines.map((l) => l.kind).sort()).toEqual(["path", "stream"]);
    expect(water.shapes.map((s) => s.kind)).toEqual(["water"]);
    expect(water.names).toEqual([]);
    const all = featuresOnGrid(data, "all");
    expect(all.lines.length).toBe(3);
    expect(all.shapes.length).toBe(2);
    expect(all.names.map((n) => n.kind).sort()).toEqual(["hut", "peak", "water"]);
    // The loch's name sits in the water, not on its island.
    const name = all.names.find((n) => n.kind === "water")!.at;
    expect(name[0]).toBeGreaterThan(201000 + 2800);
    expect(name[0]).toBeLessThan(201000 + 3500);
    expect(featureSummary(water)).toBe("1 path or track, 1 river or stream, 1 loch or reservoir");
    // On the grid within a metre of where they were put.
    const p = water.lines.find((l) => l.kind === "path")!.pts[1];
    expect(Math.abs(p[0] - 202500)).toBeLessThan(1);
    expect(Math.abs(p[1] - 772000)).toBeLessThan(1);
  });

  it("says plainly when a file won't do", () => {
    expect(() => readOsm("<svg></svg>")).toThrow(OsmError);
    expect(() => readOsm('<osm version="0.6"></osm>')).toThrow(OsmError);
    const paris = readOsm('<osm><bounds minlat="48.85" minlon="2.29" maxlat="48.86" maxlon="2.30"/><node id="1" lat="48.855" lon="2.295"/></osm>');
    expect(typeof osmArea(paris)).toBe("string");
  });
});

function closed(b: Body): number {
  const m = weld(b.vertices, b.triangles);
  const edges = new Map<string, number>();
  for (let t = 0; t < m.triangles.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const key = `${m.triangles[t + k]}>${m.triangles[t + ((k + 1) % 3)]}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  let open = 0;
  for (const [key, n] of edges) {
    const [a, c] = key.split(">");
    if (n !== 1 || edges.get(`${c}>${a}`) !== 1) open++;
  }
  return open;
}

describe("Map features on a printed puzzle", () => {
  const sw = { e: 201000, n: 770500 };
  const hill = gridFrom(sw, 4000, 3000, 20, (e, n) => 300 + 700 * Math.exp(-(((e - 202800) / 900) ** 2 + ((n - 771500) / 700) ** 2)));
  const all = featuresOnGrid(readOsm(sampleOsm()), "all");

  it("presses grooves along lines, sets water flat below its shore and raises buildings", () => {
    const flat = () => 50;
    const k = 0.05;
    const m = groundMarks(all, sw.e, sw.n, k, 200, 150, flat);
    const at = (de: number, dn: number) => m.apply(de * k, dn * k, 50);
    // On the path's corner, and a few mm off it.
    expect(at(1500, 1500)).toBeCloseTo(50 - GROOVES.path.depth, 1);
    expect(at(1500, 1600)).toBe(50);
    // In the loch, but not on its island.
    expect(at(3000, 700)).toBeCloseTo(50 - WATER_DROP, 5);
    expect(at(3150, 850)).toBe(50);
    // The hut is 40 m (2 mm) across: raised.
    expect(at(520, 1015)).toBeGreaterThan(50.5);
  });

  it("keeps every part a closed mesh, with the grooves in the ground", () => {
    const spec = { ...MOUNTAIN_DEFAULTS, bed: [256, 256, 256] as [number, number, number], snowline: 800 };
    const plain = makeMountainPuzzle(hill, 4000, 3000, spec);
    const marked = makeMountainPuzzle(hill, 4000, 3000, spec, all);
    for (const p of marked.pieces) for (const b of p.bodies) expect(closed(b), `${p.name} ${b.part}`).toBe(0);
    // The lowest point of the ground is lower with the grooves and water in it.
    const lowest = (pz: typeof plain) => {
      let low = Infinity;
      for (const p of pz.pieces) if (p.top) for (const b of p.bodies) for (let i = 2; i < b.vertices.length; i += 3) if (b.vertices[i] > p.z0 + pz.keys.depth + 0.01) low = Math.min(low, b.vertices[i]);
      return low;
    };
    expect(lowest(marked)).toBeLessThan(lowest(plain));
  });
});
