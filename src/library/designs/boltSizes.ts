/**
 * Sizes for printed bolts, nuts, washers and standoffs: the standard metric ones (M3–M12, from model/fasteners.ts:
 * ISO coarse pitch, hex across the flats, head and nut heights, washer sizes) and a custom size worked out in the same
 * proportions. Pure, so the library (and its tests) never load the geometry engine.
 */
import { FASTENER_SIZES, fastenerSize } from "../../model/fasteners";

/** ISO metric coarse pitches by nominal diameter (mm) — the same table as kernel/thread.ts `ISO_COARSE`. */
export const ISO_COARSE_PITCH: [number, number][] = [
  [2, 0.4],
  [2.5, 0.45],
  [3, 0.5],
  [4, 0.7],
  [5, 0.8],
  [6, 1],
  [8, 1.25],
  [10, 1.5],
  [12, 1.75],
  [14, 2],
  [16, 2],
  [20, 2.5],
  [24, 3],
];

/** The coarse pitch of the nearest standard size (for a custom diameter's suggested pitch). */
export function coarsePitch(d: number): number {
  let best = ISO_COARSE_PITCH[0];
  for (const row of ISO_COARSE_PITCH) if (Math.abs(row[0] - d) < Math.abs(best[0] - d)) best = row;
  return best[1];
}

export interface PrintFastener {
  /** "M8", or "16 mm" for a custom size. */
  name: string;
  d: number;
  pitch: number;
  /** Hex head and nut, across the flats. */
  flats: number;
  /** Hex head height. */
  head: number;
  /** Nut height. */
  nut: number;
  washerHole: number;
  washerOd: number;
  washerThickness: number;
  /** Socket (Allen key) head: diameter, height, key across the flats, socket depth. */
  socket: { dk: number; k: number; s: number; t: number };
}

/** The standard sizes offered: M3 … M12. */
export const PRINT_SIZES = FASTENER_SIZES.map((s) => s.name);

const half = (x: number) => Math.round(x * 2) / 2;
const tenth = (x: number) => Math.round(x * 10) / 10;

/** A printable washer is at least this thick (thinner ones are only two or three layers). */
export const MIN_WASHER = 0.8;

/**
 * A size's measurements: a standard one from the table, or a custom diameter and pitch in the standard's proportions
 * (hex 1.5 d + 1 across the flats, head 0.65 d, nut 0.85 d, washer 2 d across and 0.2 d thick).
 */
export function printFastener(size: string, customD = 16, customPitch = 2): PrintFastener {
  const s = fastenerSize(size);
  if (s) {
    return {
      name: s.name,
      d: s.d,
      pitch: s.pitch,
      flats: s.flats,
      head: s.head,
      nut: s.nut,
      washerHole: s.washerHole,
      washerOd: s.washerOd,
      washerThickness: Math.max(MIN_WASHER, s.washerThickness),
      socket: { dk: s.socketCap.dk, k: s.socketCap.k, s: s.socketCap.s!, t: s.socketCap.t! },
    };
  }
  const d = customD;
  return {
    name: `${Math.round(d * 100) / 100} mm`,
    d,
    pitch: customPitch,
    flats: half(1.5 * d + 1),
    head: tenth(0.65 * d),
    nut: tenth(0.85 * d),
    washerHole: tenth(1.05 * d + 0.1),
    washerOd: half(2 * d),
    washerThickness: Math.max(MIN_WASHER, tenth(0.2 * d)),
    socket: { dk: half(1.5 * d + 1), k: d, s: half(0.75 * d), t: tenth(0.5 * d) },
  };
}

/** Across the corners of a hexagon `flats` across the flats. */
export const acrossCorners = (flats: number) => (flats * 2) / Math.sqrt(3);

/** Area of a hexagon `flats` across the flats. */
export const hexArea = (flats: number) => (Math.sqrt(3) / 2) * flats * flats;
