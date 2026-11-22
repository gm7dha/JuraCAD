/**
 * The Island puzzle's area (pure): from an OpenStreetMap file (its export box on the OS grid, checked the island's
 * way), and trimmed in from each side before the island is built — the Mountain puzzle's trims (`cropGrid`), so the
 * land kept, "put together" sizing and the map marks all see only what's left. No trim = the very same grid and corner,
 * so the puzzle is made exactly as before.
 */
import { areaProblem, zoomFor, type HeightGrid } from "./elevation";
import { cropGrid, type Trim } from "./mountainCrop";
import type { GridPoint } from "./osGrid";
import { osmArea, type OsmData } from "./osm";

/** The widest island area (m): all of Great Britain. */
export const ISLAND_MOST = 1_300_000;

export interface IslandArea {
  sw: GridPoint;
  width: number;
  height: number;
}

/** The area an OpenStreetMap file covers, ready for the island's heights, or a plain reason why not. */
export function osmIslandArea(data: OsmData, name: string): (IslandArea & { name: string }) | string {
  const a = osmArea(data, "the Island puzzle");
  if (typeof a === "string") return a;
  return areaProblem(a.sw, a.width, a.height, ISLAND_MOST, zoomFor(a.sw, a.width, a.height)) ?? { ...a, name };
}

/** The heights and area the island is built from: the area loaded less what's trimmed off each side. */
export function trimmedIsland(area: IslandArea, grid: HeightGrid, trim: Trim): IslandArea & { grid: HeightGrid } {
  const c = cropGrid(grid, area.width, area.height, trim);
  if (c.grid === grid) return { grid, sw: area.sw, width: area.width, height: area.height };
  return { grid: c.grid, sw: { e: area.sw.e + c.west, n: area.sw.n + c.south }, width: c.width, height: c.height };
}

/** Whether `inner` lies within `outer` (to a metre), so a map fetched for `outer` covers it. */
export function areaInside(inner: IslandArea, outer: IslandArea): boolean {
  const slack = 1;
  return (
    inner.sw.e >= outer.sw.e - slack &&
    inner.sw.n >= outer.sw.n - slack &&
    inner.sw.e + inner.width <= outer.sw.e + outer.width + slack &&
    inner.sw.n + inner.height <= outer.sw.n + outer.height + slack
  );
}
