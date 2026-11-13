/**
 * Tidy map marks (pure): only lochs and reservoirs (no rivers, streams or tiny ponds), only motorways and trunk roads, and
 * only the main hill routes — joined into long routes, judged by how far they climb on the heights, or kept as signed
 * walking routes — never footways or paths through parks and towns. Thin lines; everything still there when asked for.
 */
import { describe, expect, it } from "vitest";
import { gridFrom } from "../src/terrain/elevation";
import { GROOVES } from "../src/terrain/groundMarks";
import { fetchCovers, ISLANDS, marksQuery } from "../src/terrain/islands";
import { ALL_MARKS, HILL_CLIMB, joinRoutes, LEAST_ROUTE, TIDY_MARKS } from "../src/terrain/mapMarks";
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
    expect(data.builtUp?.length).toBe(2);
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

  it("keeps motorways and trunk roads only", () => {
    const roads = tidy.lines.filter((l) => l.kind === "road");
    expect(roads.length).toBe(1);
    expect(near(roads[0].pts, 4000, 150)).toBe(true);
    expect(all.lines.filter((l) => l.kind === "road").length).toBe(3);
  });

  it("keeps the long climbing hill path, joined into one route, and the signed walking route", () => {
    const paths = printed.lines.filter((l) => l.kind === "path" || l.kind === "track");
    expect(paths.length).toBe(2);
    const up = paths.find((l) => near(l.pts, 200, 500))!;
    // All three pieces in one line, end to end (the side path left as its own, short, route).
    expect(near(up.pts, 1800, 1000)).toBe(true);
    expect(lineLength(up.pts)).toBeGreaterThan(1600);
    const walk = paths.find((l) => near(l.pts, 100, 2800))!;
    expect(walk).toBeTruthy();
    for (const p of paths) expect(lineLength(p.pts) * k).toBeGreaterThanOrEqual(LEAST_ROUTE);
  });

  it("leaves out footways, paths through parks and towns, flat tracks and short side paths", () => {
    const paths = printed.lines.filter((l) => l.kind === "path" || l.kind === "track");
    for (const [de, dn] of [
      [1800, 2000], // the footway's top
      [2300, 1500], // the park path
      [3800, 600], // the estate path
      [4000, 2900], // the flat track
      [1330, 1000], // the side path's end
    ])
      expect(paths.some((l) => near(l.pts, de, dn)), `${de}, ${dn}`).toBe(false);
    // All of them, asked for.
    expect(all.lines.filter((l) => l.kind === "path" || l.kind === "track").length).toBe(9);
  });

  it("without heights keeps only the signed walking routes", () => {
    const blind = featuresOnGrid(data, "water", TIDY_MARKS);
    const paths = blind.lines.filter((l) => l.kind === "path" || l.kind === "track");
    expect(paths.length).toBe(1);
    expect(near(paths[0].pts, 100, 2800)).toBe(true);
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

  it("draws paths, tracks and roads as thin, shallow lines", () => {
    for (const kind of ["path", "track", "road"] as const) {
      expect(GROOVES[kind].width).toBeCloseTo(0.6, 5);
      expect(GROOVES[kind].depth).toBeLessThanOrEqual(0.3);
    }
  });
});

describe("Fetching tidy marks", () => {
  const arran = ISLANDS[1];
  it("asks for no rivers or minor roads unless they're wanted, with walking routes and towns", () => {
    const q = marksQuery(arran.sw, arran.width, arran.height, "all")!;
    expect(q).not.toContain('"waterway"');
    expect(q).not.toContain("primary");
    expect(q).toContain("^(motorway|trunk)$");
    expect(q).toContain('"route"~"^(hiking|foot|walking)$"');
    expect(q).toContain('"landuse"="reservoir"');
    expect(q).not.toContain("footway");
    const everything = marksQuery(arran.sw, arran.width, arran.height, "all", ALL_MARKS)!;
    expect(everything).toContain('way["waterway"');
    expect(everything).toContain("primary");
    expect(everything).toContain("footway");
  });
  it("knows when a fetch already holds what's asked", () => {
    expect(fetchCovers({ detail: "all", choice: ALL_MARKS }, "water", TIDY_MARKS)).toBe(true);
    expect(fetchCovers({ detail: "water", choice: TIDY_MARKS }, "all", TIDY_MARKS)).toBe(false);
    expect(fetchCovers({ detail: "water", choice: TIDY_MARKS }, "water", { ...TIDY_MARKS, water: "all" })).toBe(false);
    expect(fetchCovers({ detail: "all", choice: TIDY_MARKS }, "all", { ...TIDY_MARKS, roads: "all" })).toBe(false);
    expect(fetchCovers({ detail: "all", choice: TIDY_MARKS }, "water", { ...TIDY_MARKS, roads: "all" })).toBe(true);
  });
});
