/**
 * The Island puzzle's area (pure): from an OpenStreetMap file (its export box on the OS grid, checked the island's
 * way), and trimmed in from each side before the island is built — the Mountain puzzle's trims (`cropGrid`), so the
 * land kept, "put together" sizing and the map marks all see only what's left. No trim = the very same grid and corner,
 * so the puzzle is made exactly as before.
 */
import { areaProblem, zoomFor, type HeightGrid } from "./elevation";
import { cropGrid, type Trim } from "./mountainCrop";
import type { GridPoint } from "./osGrid";
import { keepLand, landByCoast, onlyCells, type Coast, type IslandLand, type IslandOnly } from "./islandPuzzle";
import { LEFT_OUT } from "./coastline";
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

/** Which land to keep, decided on the whole area loaded before a trim (see `trimmedIsland`). */
export interface LandRule {
  sea: number;
  land: IslandLand;
  only?: IslandOnly;
  /** OpenStreetMap's coastline, when it's used to tell land from sea (see makeIslandPuzzle). */
  coast?: Coast;
}

/**
 * The heights and area the island is built from: the area loaded less what's trimmed off each side.
 *
 * A trim is only a frame: "every island" and a list island's own land are decided on the WHOLE area loaded (`rule`),
 * not on the trimmed one — else a trim cutting through the island would make its cut edge "the area's edge" and drop
 * it as mainland (or try to cut a list island free from its own cut edge). So with a trim and such a rule the land left
 * out is lowered to the sea in the trimmed heights, `decided` is set (build with land "all" and no `only`), and what
 * keepLand said about it is in `notes`. No trim = the very same grid and corner (byte-identical puzzle).
 */
export function trimmedIsland(
  area: IslandArea,
  grid: HeightGrid,
  trim: Trim,
  rule?: LandRule,
): IslandArea & { grid: HeightGrid; decided: boolean; notes: string[] } {
  const c = cropGrid(grid, area.width, area.height, trim);
  if (c.grid === grid) return { grid, sw: area.sw, width: area.width, height: area.height, decided: false, notes: [] };
  let from = grid;
  let decided = false;
  const notes: string[] = [];
  if (rule && (rule.only || rule.land === "islands")) {
    const { nx, ny, h, spacing } = grid;
    // The samples sit on the grid's points: cell i covers e0 + (i ± ½) × spacing.
    const cellSw = { e: grid.e0 - spacing / 2, n: grid.n0 - spacing / 2 };
    const byCoast = rule.coast ? landByCoast(rule.coast, cellSw, spacing, nx, ny, (c) => h[c]) : null;
    const isLand = byCoast ? new Uint8Array(byCoast) : new Uint8Array(nx * ny);
    if (!byCoast) for (let i = 0; i < isLand.length; i++) isLand[i] = h[i] > rule.sea ? 1 : 0;
    try {
      const only = rule.only && onlyCells(rule.only, cellSw, spacing);
      keepLand(isLand, nx, ny, rule.land, notes, only, (c) => (byCoast ? Math.max(h[c], rule.sea) : h[c]));
      const lowered = new Float32Array(h);
      // By the coastline, land left out goes far below the sea (the coastline would call it land again).
      if (byCoast) {
        for (let i = 0; i < isLand.length; i++) if (byCoast[i] && !isLand[i]) lowered[i] = LEFT_OUT;
      } else for (let i = 0; i < isLand.length; i++) if (h[i] > rule.sea && !isLand[i]) lowered[i] = Math.min(0, h[i]);
      from = { ...grid, h: lowered };
      decided = true;
    } catch {
      // No land at all: the build says so.
    }
  }
  const t = from === grid ? c : cropGrid(from, area.width, area.height, trim);
  return { grid: t.grid, sw: { e: area.sw.e + t.west, n: area.sw.n + t.south }, width: t.width, height: t.height, decided, notes };
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
