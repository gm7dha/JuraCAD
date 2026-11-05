/**
 * Ground heights for an area of the OS grid (pure apart from the tile loader handed in): the free "Terrain Tiles" on
 * Amazon's open data (Mapzen's terrarium format — heights coded into a picture's colours, ~20–30 m apart in Britain,
 * from OS Terrain 50 / SRTM), read into a regular grid of heights in metres, square to the OS grid so it lines up with
 * an OS map.
 */
import { gridToLatLon, type GridPoint } from "./osGrid";

/** Where the tiles come from; {z}/{x}/{y} filled in. Served with CORS, so a web page may read them. */
export const TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
/** The zoom level read: about 20 m a pixel in Scotland — as fine as the data itself is. */
export const TILE_ZOOM = 12;
/** The most tiles fetched for one area (each is 256 × 256 pixels, ~70 kB). */
export const MAX_TILES = 64;

/** One tile's pixels, RGBA as a canvas gives them. */
export interface TilePixels {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

export type TileLoader = (z: number, x: number, y: number) => Promise<TilePixels>;

/** A height (m) from a terrarium pixel's colour. */
export const terrariumHeight = (r: number, g: number, b: number): number => r * 256 + g + b / 256 - 32768;

/** Latitude/longitude → world pixel position at a zoom (Web Mercator, 256-pixel tiles). */
export function worldPixel(lat: number, lon: number, z: number): [number, number] {
  const size = 256 * 2 ** z;
  const s = Math.sin((lat * Math.PI) / 180);
  return [((lon + 180) / 360) * size, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size];
}

/** Heights on a regular grid square to the OS grid: node (i, j) is at e0 + i·spacing, n0 + j·spacing. */
export interface HeightGrid {
  e0: number;
  n0: number;
  spacing: number;
  nx: number;
  ny: number;
  /** Row by row from the south: h[j * nx + i]. */
  h: Float32Array;
}

/** The height at a grid position, smoothly between nodes (clamped to the grid's edge). */
export function heightAt(g: HeightGrid, e: number, n: number): number {
  const fx = Math.min(Math.max((e - g.e0) / g.spacing, 0), g.nx - 1);
  const fy = Math.min(Math.max((n - g.n0) / g.spacing, 0), g.ny - 1);
  const i = Math.min(Math.floor(fx), g.nx - 2);
  const j = Math.min(Math.floor(fy), g.ny - 2);
  const [tx, ty] = [fx - Math.max(i, 0), fy - Math.max(j, 0)];
  if (g.nx < 2 || g.ny < 2) return g.h[0] ?? 0;
  const at = (a: number, b: number) => g.h[b * g.nx + a];
  return (at(i, j) * (1 - tx) + at(i + 1, j) * tx) * (1 - ty) + (at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx) * ty;
}

/** Lowest and highest height in the grid. */
export function heightRange(g: HeightGrid): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of g.h) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/** The tiles an area needs: [x, y] at TILE_ZOOM. */
export function tilesFor(sw: GridPoint, width: number, height: number, z = TILE_ZOOM): [number, number][] {
  const corners = [
    [sw.e, sw.n],
    [sw.e + width, sw.n],
    [sw.e, sw.n + height],
    [sw.e + width, sw.n + height],
  ].map(([e, n]) => {
    const ll = gridToLatLon({ e, n });
    return worldPixel(ll.lat, ll.lon, z);
  });
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  // One pixel of room all round, for the smooth sampling at the very edge.
  const [x0, x1] = [Math.floor((Math.min(...xs) - 1) / 256), Math.floor((Math.max(...xs) + 1) / 256)];
  const [y0, y1] = [Math.floor((Math.min(...ys) - 1) / 256), Math.floor((Math.max(...ys) + 1) / 256)];
  const out: [number, number][] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([x, y]);
  return out;
}

/** What's wrong with an area (plain English), before anything is fetched. */
export function areaProblem(sw: GridPoint | null, width: number, height: number): string | null {
  if (!sw) return "That isn't a grid reference I can read — try one like NN 166 712.";
  if (!(width >= 200 && height >= 200)) return "The area must be at least 200 m across.";
  if (width > 40000 || height > 40000) return "The area can be at most 40 km across.";
  if (sw.e < 0 || sw.n < 0 || sw.e + width > 700000 || sw.n + height > 1300000) return "That area runs off the OS grid.";
  const n = tilesFor(sw, width, height).length;
  if (n > MAX_TILES) return `That area needs ${n} map tiles of height data — make it smaller (at most ${MAX_TILES}).`;
  return null;
}

/**
 * Read the heights of an area (`sw` = its south-west corner, `width` east × `height` north, metres) into a grid
 * `spacing` metres apart (default: about the data's own spacing). Tiles come from `load`.
 */
export async function readHeights(load: TileLoader, sw: GridPoint, width: number, height: number, spacing?: number): Promise<HeightGrid> {
  const z = TILE_ZOOM;
  const step = spacing ?? Math.max(10, Math.min(width, height) / 400);
  const nx = Math.max(2, Math.ceil(width / step) + 1);
  const ny = Math.max(2, Math.ceil(height / step) + 1);
  const tiles = new Map<string, TilePixels>();
  await Promise.all(
    tilesFor(sw, width + step, height + step, z).map(async ([x, y]) => {
      tiles.set(`${x}/${y}`, await load(z, x, y));
    }),
  );
  const pixel = (px: number, py: number): number => {
    const tx = Math.floor(px / 256);
    const ty = Math.floor(py / 256);
    const t = tiles.get(`${tx}/${ty}`);
    if (!t) return 0;
    const ix = Math.min(Math.max(Math.floor(px - tx * 256), 0), t.width - 1);
    const iy = Math.min(Math.max(Math.floor(py - ty * 256), 0), t.height - 1);
    const k = (iy * t.width + ix) * 4;
    return terrariumHeight(t.data[k], t.data[k + 1], t.data[k + 2]);
  };
  // Square cells, `step` apart, covering the whole area (the last row/column may reach a little past it).
  const sx = step;
  const sy = step;
  const h = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const ll = gridToLatLon({ e: sw.e + i * sx, n: sw.n + j * sy });
      // Pixel centres are at +0.5: sample smoothly between the four nearest.
      const [wx, wy] = worldPixel(ll.lat, ll.lon, z);
      const [fx, fy] = [wx - 0.5, wy - 0.5];
      const [x0, y0] = [Math.floor(fx), Math.floor(fy)];
      const [ax, ay] = [fx - x0, fy - y0];
      const v = (pixel(x0, y0) * (1 - ax) + pixel(x0 + 1, y0) * ax) * (1 - ay) + (pixel(x0, y0 + 1) * (1 - ax) + pixel(x0 + 1, y0 + 1) * ax) * ay;
      // The sea is coded as depths: a puzzle's base is the shore.
      h[j * nx + i] = Math.max(v, 0);
    }
  return { e0: sw.e, n0: sw.n, spacing: step, nx, ny, h };
}

/** A grid made from a height function — for tests and previews. */
export function gridFrom(sw: GridPoint, width: number, height: number, spacing: number, f: (e: number, n: number) => number): HeightGrid {
  const nx = Math.ceil(width / spacing) + 1;
  const ny = Math.ceil(height / spacing) + 1;
  const h = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = f(sw.e + i * spacing, sw.n + j * spacing);
  return { e0: sw.e, n0: sw.n, spacing, nx, ny, h };
}
