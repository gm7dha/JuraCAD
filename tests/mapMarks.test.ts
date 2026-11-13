/**
 * Tidy map marks (pure): only lochs and reservoirs (no rivers, streams or tiny ponds), only motorways, trunk roads and A roads (or trunk roads only), and
 * only the main hill routes — joined into long routes, judged by how far they climb on the heights, or kept as signed
 * walking routes — never footways or paths through parks and towns. Thin lines; everything still there when asked for.
 */
import { describe, expect, it } from "vitest";
import { gridFrom } from "../src/terrain/elevation";
import { GROOVES, THIN_GROOVE, thinDepth } from "../src/terrain/groundMarks";
import { fetchCovers, ISLANDS, marksQuery } from "../src/terrain/islands";
import { ALL_MARKS, HILL_CLIMB, hillRoutes, joinRoutes, LEAST_ROUTE, TIDY_MARKS, type MarkLine } from "../src/terrain/mapMarks";
import { featuresAtScale, featuresOnGrid, lineLength, LEAST_LOCH, readOsm, ringArea } from "../src/terrain/osm";
import { hillOsm } from "./support/osmSample";

const sw = { e: 201000, n: 770500 };
// A hill 1000 m high at (1800, 1000) from the map's corner, on 300 m ground.
const hill = gridFrom(sw, 4000, 3000, 20, (e, n) => 300 + 700 * Math.exp(-(((e - 202800) / 900) ** 2 + ((n - 771500) / 700) ** 2)));
const data = readOsm(hillOsm());
const near = (pts: [number, number][], de: number, dn: number) => pts.some(([e, n]) => Math.hypot(e - sw.e - de, n - sw.n - dn) < 2);

describe("Reading what tidy marks need", () => {
  it("knows walking routes, flowing water and towns' streets and parks", () => {
    expect(data.lines.filter((l) => l.hike).length).toBe(1);
    expect(data.lines.find((l) => l.highway === "trunk")).toBeTruthy();
    expect(data.shapes.filter((s) => s.kind === "water" && s.flowing).length).toBe(1);
    expect(data.builtUp?.length).toBe(1);
    expect(data.parks?.length).toBe(1);
    expect(data.lines.find((l) => l.highway === "sidewalk")).toBeTruthy();
  });
});

describe("Tidy marks", () => {
  const tidy = featuresOnGrid(data, "all", TIDY_MARKS, hill);
  const all = featuresOnGrid(data, "all", ALL_MARKS, hill);
  const k = 0.05; // 4 km = 200 mm
  const printed = featuresAtScale(tidy, k).features;

  it("keeps lochs and reservoirs only: no rivers, canals, riverbanks or tiny ponds", () => {
    expect(tidy.lines.some((l) => l.kind === "river" || l.kind === "stream")).toBe(false);
    const water = printed.shapes.filter((s) => s.kind === "water");
    expect(water.length).toBe(1);
    expect(near(water[0].rings[0], 300, 1800)).toBe(true);
    // The pond (10 × 10 m = 0.25 mm² here) is too small to print; the reservoir (600 mm²) isn't.
    expect(tidy.shapes.filter((s) => s.kind === "water").length).toBe(2);
    expect(ringArea(water[0].rings[0]) * k * k).toBeGreaterThan(LEAST_LOCH);
    // Asked for everything, the rivers, canal and riverbank come back.
    expect(all.lines.filter((l) => l.kind === "river").length).toBe(2);
    expect(all.shapes.filter((s) => s.kind === "water").length).toBe(3);
  });

  it("keeps motorways, trunk roads and A roads by default; only trunk roads, or every road, when asked", () => {
    const roads = tidy.lines.filter((l) => l.kind === "road");
    expect(roads.length).toBe(2);
    expect(roads.some((l) => near(l.pts, 4000, 150))).toBe(true);
    expect(roads.some((l) => near(l.pts, 4000, 1550))).toBe(true);
    const trunk = featuresOnGrid(data, "all", { ...TIDY_MARKS, roads: "trunk" }, hill).lines.filter((l) => l.kind === "road");
    expect(trunk.length).toBe(1);
    expect(near(trunk[0].pts, 4000, 150)).toBe(true);
    expect(trunk.every((l) => l.thin)).toBe(true);
    expect(all.lines.filter((l) => l.kind === "road").length).toBe(4);
  });

  it("keeps the long climbing hill path, joined into one route, the public footpath, the park's hill path and the signed walking route", () => {
    const paths = printed.lines.filter((l) => l.kind === "path" || l.kind === "track");
    expect(paths.length).toBe(4);
    expect(paths.every((l) => l.thin)).toBe(true);
    expect(paths.some((l) => near(l.pts, 2600, 600) && near(l.pts, 2000, 1100))).toBe(true);
    expect(paths.some((l) => near(l.pts, 2300, 1500))).toBe(true);
    const up = paths.find((l) => near(l.pts, 200, 500))!;
    // All three pieces in one line, end to end (the side path left as its own, short, route).
    expect(near(up.pts, 1800, 1000)).toBe(true);
    expect(lineLength(up.pts)).toBeGreaterThan(1600);
    const walk = paths.find((l) => near(l.pts, 100, 2800))!;
    expect(walk).toBeTruthy();
    for (const p of paths) expect(lineLength(p.pts) * k).toBeGreaterThanOrEqual(LEAST_ROUTE);
  });

  it("leaves out pavements, paths in towns, flat tracks and short side paths", () => {
    const paths = printed.lines.filter((l) => l.kind === "path" || l.kind === "track");
    for (const [de, dn] of [
      [1800, 2000], // the pavement's top
      [3800, 600], // the estate path
      [4000, 2900], // the flat track
      [1330, 1000], // the side path's end
    ])
      expect(paths.some((l) => near(l.pts, de, dn)), `${de}, ${dn}`).toBe(false);
    // All of them, asked for.
    expect(all.lines.filter((l) => l.kind === "path" || l.kind === "track").length).toBe(10);
    // Everything chosen looks as it always did: no thin lines.
    expect(all.lines.some((l) => l.thin)).toBe(false);
  });

  it("without heights keeps only the signed walking routes", () => {
    const blind = featuresOnGrid(data, "water", TIDY_MARKS);
    const paths = blind.lines.filter((l) => l.kind === "path" || l.kind === "track");
    expect(paths.length).toBe(1);
    expect(near(paths[0].pts, 100, 2800)).toBe(true);
  });

  it("judges paths in parks, tracks, footways, steps and towns by their own rules", () => {
    // Ground rising 0.5 m per metre north: 300 m to 1800 m; the highest ground is above 1350 m.
    const ramp = gridFrom(sw, 4000, 3000, 20, (_e, n) => 300 + (n - sw.n) * 0.5);
    const up = (de: number, dn0: number, dn1: number): [number, number][] => [
      [sw.e + de, sw.n + dn0],
      [sw.e + de, sw.n + (dn0 + dn1) / 2],
      [sw.e + de, sw.n + dn1],
    ];
    const square = (e0: number, n0: number, e1: number, n1: number): [number, number][] => [
      [sw.e + e0, sw.n + n0],
      [sw.e + e1, sw.n + n0],
      [sw.e + e1, sw.n + n1],
      [sw.e + e0, sw.n + n1],
    ];
    const areas = { towns: [square(3500, 0, 4000, 3000)], parks: [square(0, 0, 1000, 3000)], woods: [square(2000, 0, 2500, 3000)] };
    const kept = (l: MarkLine) => hillRoutes([l], areas, ramp).length === 1;
    // 100 m up onto the highest ground: enough outside a park, not in one; 400 m in a park is enough.
    expect(kept({ kind: "path", highway: "path", pts: up(1500, 2000, 2200) })).toBe(true);
    expect(kept({ kind: "path", highway: "path", pts: up(500, 2000, 2200) })).toBe(false);
    expect(kept({ kind: "path", highway: "path", pts: up(500, 1000, 1800) })).toBe(true);
    expect(kept({ kind: "path", highway: "path", hike: true, pts: up(500, 2000, 2050) })).toBe(true);
    // Tracks: 400 m up is enough, but not through woods; 200 m isn't.
    expect(kept({ kind: "track", highway: "track", pts: up(1500, 1000, 1800) })).toBe(true);
    expect(kept({ kind: "track", highway: "track", pts: up(2200, 1000, 1800) })).toBe(false);
    expect(kept({ kind: "track", highway: "track", pts: up(1500, 1000, 1400) })).toBe(false);
    // A footway climbing is a hill path; a pavement never is.
    expect(kept({ kind: "path", highway: "footway", pts: up(1500, 1000, 1800) })).toBe(true);
    expect(kept({ kind: "path", highway: "sidewalk", pts: up(1500, 1000, 1800) })).toBe(false);
    // A town beats even a signed route.
    expect(kept({ kind: "path", highway: "path", hike: true, pts: up(3700, 1000, 1800) })).toBe(false);
    // Steps join the pieces of a route either side of them.
    const pieces: MarkLine[] = [
      { kind: "path", highway: "path", pts: up(1500, 1000, 1200) },
      { kind: "path", highway: "steps", pts: up(1500, 1200, 1250) },
      { kind: "path", highway: "path", pts: up(1500, 1250, 1500) },
    ];
    const routes = hillRoutes(pieces, areas, ramp);
    expect(routes.length).toBe(1);
    expect(lineLength(routes[0].pts)).toBeCloseTo(500, 3);
  });

  it("joins pieces straight on through a junction", () => {
    const routes = joinRoutes([
      { kind: "path", pts: [[0, 0], [10, 0]] },
      { kind: "path", pts: [[20, 0], [10, 0]] },
      { kind: "path", pts: [[10, 0], [10, 5]] },
    ]);
    expect(routes.length).toBe(2);
    expect(routes.find((r) => r.pts.length === 3)!.pts).toEqual([[0, 0], [10, 0], [20, 0]]);
    expect(HILL_CLIMB).toBe(150);
  });

  it("draws tidy paths and roads as thin lines two layers deep, everything else as before", () => {
    expect(THIN_GROOVE).toEqual({ width: 0.6, depth: 0.4 });
    expect(GROOVES.path).toEqual({ width: 1.0, depth: 0.5 });
    expect(GROOVES.road).toEqual({ width: 1.8, depth: 0.6 });
    expect(tidy.lines.filter((l) => l.kind === "road").every((l) => l.thin)).toBe(true);
    // Full depth wherever a sample lands within two thirds of the half-width.
    expect(thinDepth(0)).toBe(0.4);
    expect(thinDepth(0.2)).toBeCloseTo(0.4, 9);
    expect(thinDepth(0.3)).toBe(0);
  });
});

describe("Fetching tidy marks", () => {
  const arran = ISLANDS[1];
  it("asks for no rivers or minor roads unless they're wanted, with walking routes and towns", () => {
    const q = marksQuery(arran.sw, arran.width, arran.height, "all")!;
    expect(q).not.toContain('"waterway"');
    // A roads by default (Arran's A841), not B roads or minor roads.
    expect(q).toContain("^(motorway|trunk|primary)$");
    expect(q).not.toContain("secondary");
    expect(marksQuery(arran.sw, arran.width, arran.height, "all", { ...TIDY_MARKS, roads: "trunk" })).toContain("^(motorway|trunk)$");
    expect(q).toContain('"route"~"^(hiking|foot|walking)$"');
    expect(q).toContain('"landuse"="reservoir"');
    expect(q).toContain("footway");
    expect(q).toContain('"landuse"="forest"');
    const everything = marksQuery(arran.sw, arran.width, arran.height, "all", ALL_MARKS)!;
    expect(everything).toContain('way["waterway"');
    expect(everything).toContain("primary");
    expect(everything).toContain("footway");
  });
  it("knows when a fetch already holds what's asked", () => {
    // Everything fetched covers everything but the hill routes (which need the woods too).
    expect(fetchCovers({ detail: "all", choice: ALL_MARKS }, "water", { ...TIDY_MARKS, paths: "all" })).toBe(true);
    expect(fetchCovers({ detail: "all", choice: ALL_MARKS }, "water", TIDY_MARKS)).toBe(false);
    expect(fetchCovers({ detail: "all", choice: TIDY_MARKS }, "all", { ...TIDY_MARKS, paths: "all" })).toBe(true);
    expect(fetchCovers({ detail: "water", choice: TIDY_MARKS }, "all", TIDY_MARKS)).toBe(false);
    expect(fetchCovers({ detail: "water", choice: TIDY_MARKS }, "water", { ...TIDY_MARKS, water: "all" })).toBe(false);
    expect(fetchCovers({ detail: "all", choice: TIDY_MARKS }, "all", { ...TIDY_MARKS, roads: "all" })).toBe(false);
    expect(fetchCovers({ detail: "all", choice: { ...TIDY_MARKS, roads: "trunk" } }, "all", TIDY_MARKS)).toBe(false);
    expect(fetchCovers({ detail: "all", choice: TIDY_MARKS }, "all", { ...TIDY_MARKS, roads: "trunk" })).toBe(true);
    expect(fetchCovers({ detail: "all", choice: TIDY_MARKS }, "water", { ...TIDY_MARKS, roads: "all" })).toBe(true);
  });
});
