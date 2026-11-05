/**
 * A picture as a relief (pure): its brightness becomes height, so the Mountain puzzle's cubes can be made of a photo —
 * a face, a pet, a logo — instead of a mountain. Light parts stand high, dark parts low (or the other way round). The
 * picture's pixels are the "ground": one pixel = one unit across, and heights are set so the relief comes out the
 * asked-for number of mm tall on the finished puzzle.
 */
import type { HeightGrid } from "./elevation";
import { layoutFor, type MountainSpec } from "./mountainPuzzle";

export interface PhotoPixels {
  /** Brightness 0 (black) … 1 (white), row by row from the TOP of the picture, as a canvas gives it. */
  grey: Float32Array;
  width: number;
  height: number;
}

/** At most this many pixels a side are used (more only slows things down: a cube is ~30 mm). */
export const PHOTO_MAX_SIDE = 400;

/** Brightness from RGBA (see-through counts as white), the eye's weights. */
export function greyFromRgba(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): PhotoPixels {
  const grey = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const a = rgba[4 * i + 3] / 255;
    const y = (0.2126 * rgba[4 * i] + 0.7152 * rgba[4 * i + 1] + 0.0722 * rgba[4 * i + 2]) / 255;
    grey[i] = y * a + (1 - a);
  }
  return { grey, width, height };
}

/** A box blur of `r` pixels each way (r = 0: none), so speckle and JPEG noise don't become spikes. */
export function blurred(p: PhotoPixels, r: number): PhotoPixels {
  if (r <= 0) return p;
  const { width: w, height: h } = p;
  const pass = (src: Float32Array, dx: number, dy: number) => {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        let n = 0;
        for (let k = -r; k <= r; k++) {
          const xx = x + k * dx;
          const yy = y + k * dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          s += src[yy * w + xx];
          n++;
        }
        out[y * w + x] = s / n;
      }
    return out;
  };
  return { width: w, height: h, grey: pass(pass(p.grey, 1, 0), 0, 1) };
}

/**
 * The picture as heights for `makeMountainPuzzle`: the grid's south-west corner at (0, 0), one unit per pixel, the picture's
 * top row to the north. Heights run from 0 (darkest, or lightest with `invert`) to whatever gives `reliefMm` of relief
 * on the puzzle at this spec's size (worked out from `layoutFor`, with the height stretch left at 1).
 */
export function photoGrid(p: PhotoPixels, spec: MountainSpec, reliefMm: number, invert = false): HeightGrid {
  const { width: w, height: h } = p;
  const flat: HeightGrid = { e0: 0, n0: 0, spacing: 1, nx: w, ny: h, h: new Float32Array(w * h) };
  const k = layoutFor(flat, w - 1, h - 1, { ...spec, exaggeration: 1 }).k;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of p.grey) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
  const span = hi - lo > 1e-6 ? hi - lo : 1;
  const top = reliefMm / k;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const t = (p.grey[y * w + x] - lo) / span;
      // Row y from the top of the picture is grid row h − 1 − y from the south.
      out[(h - 1 - y) * w + x] = (invert ? 1 - t : t) * top;
    }
  return { ...flat, h: out };
}

/** The size to read a picture at: its own, shrunk so neither side is over PHOTO_MAX_SIDE. */
export function photoReadSize(width: number, height: number): [number, number] {
  const s = Math.min(1, PHOTO_MAX_SIDE / Math.max(width, height));
  return [Math.max(2, Math.round(width * s)), Math.max(2, Math.round(height * s))];
}
