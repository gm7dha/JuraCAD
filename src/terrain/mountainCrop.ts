/**
 * Trimming the Mountain puzzle's area in from each side (pure), before it's laid out — so the smaller area is sized
 * to the bed by the usual rules (`layoutFor`: whole cubes, centred). Trims are shares of the side they come off, cut
 * to whole steps of the height data, so the heights left are exactly the ones read (nothing is resampled). The grid
 * keeps its place on the map (its corner moves), so map marks and the top view still line up.
 */
import type { HeightGrid } from "./elevation";
import type { PhotoPixels } from "./photoRelief";

/** How much comes off each side, as a share of the whole width (east, west) or height (north, south): 0 … `MOST_TRIM`. */
export interface Trim {
  n: number;
  e: number;
  s: number;
  w: number;
}

export const NO_TRIM: Trim = { n: 0, e: 0, s: 0, w: 0 };
/** At most this much off one side. */
export const MOST_TRIM = 0.45;
/** At least this share of each way is always left. */
export const LEAST_LEFT = 0.1;

export const noTrim = (t: Trim) => !t.n && !t.e && !t.s && !t.w;

/** The two trims of one way, each kept to 0…MOST_TRIM and together leaving at least LEAST_LEFT. */
function pair(a: number, b: number): [number, number] {
  const clean = (v: number) => (Number.isFinite(v) ? Math.min(MOST_TRIM, Math.max(0, v)) : 0);
  let [x, y] = [clean(a), clean(b)];
  const most = 1 - LEAST_LEFT;
  if (x + y > most) [x, y] = [(x * most) / (x + y), (y * most) / (x + y)];
  return [x, y];
}

/** The trims as whole steps of `step` off a side `length` long: [steps off the start, steps off the end]. */
function steps(length: number, step: number, a: number, b: number): [number, number] {
  const [x, y] = pair(a, b);
  return [Math.floor((x * length) / step + 1e-9), Math.floor((y * length) / step + 1e-9)];
}

/**
 * The area left after trimming: its grid (the same object when nothing is trimmed) and size, and how far (in the
 * grid's units) its south-west corner moved from the old one's.
 */
export function cropGrid(grid: HeightGrid, width: number, height: number, trim: Trim): { grid: HeightGrid; width: number; height: number; west: number; south: number } {
  if (noTrim(trim)) return { grid, width, height, west: 0, south: 0 };
  const sp = grid.spacing;
  const [iw, ie] = steps(width, sp, trim.w, trim.e);
  const [is, inn] = steps(height, sp, trim.s, trim.n);
  const w2 = Math.max(sp, width - (iw + ie) * sp);
  const h2 = Math.max(sp, height - (is + inn) * sp);
  const nx = Math.max(2, Math.min(grid.nx - iw, Math.ceil(w2 / sp - 1e-9) + 1));
  const ny = Math.max(2, Math.min(grid.ny - is, Math.ceil(h2 / sp - 1e-9) + 1));
  const h = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = grid.h[Math.min(grid.ny - 1, j + is) * grid.nx + Math.min(grid.nx - 1, i + iw)];
  return { grid: { e0: grid.e0 + iw * sp, n0: grid.n0 + is * sp, spacing: sp, nx, ny, h }, width: w2, height: h2, west: iw * sp, south: is * sp };
}

/**
 * A picture trimmed the same way (whole pixels; rows run from the picture's TOP, so north comes off the first rows):
 * the pixels left, and how many came off the west and the south (the bottom).
 */
export function cropPixels(p: PhotoPixels, trim: Trim): { pixels: PhotoPixels; west: number; south: number } {
  if (noTrim(trim)) return { pixels: p, west: 0, south: 0 };
  const [iw, ie] = steps(p.width - 1, 1, trim.w, trim.e);
  const [is, inn] = steps(p.height - 1, 1, trim.s, trim.n);
  const w = Math.max(2, p.width - iw - ie);
  const h = Math.max(2, p.height - is - inn);
  const grey = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grey[y * w + x] = p.grey[(y + inn) * p.width + x + iw];
  return { pixels: { grey, width: w, height: h }, west: iw, south: is };
}
