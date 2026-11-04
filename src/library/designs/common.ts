/** Small helpers shared by the designs. */
import { lit, type Ex } from "../ex";
import type { DesignValues } from "../types";

/** A number from the values (0 if it isn't one). */
export const num = (values: DesignValues, key: string): number => (typeof values[key] === "number" ? (values[key] as number) : Number(values[key]) || 0);

/** The variable-backed sizes as plain numbers (for previews and checks, where there are no variables yet). */
export function varsOf(values: DesignValues, keys: string[]): Record<string, Ex> {
  return Object.fromEntries(keys.map((k) => [k, lit(num(values, k))]));
}

/** "12.5" for messages. */
export const mm = (v: number) => `${Math.round(v * 100) / 100} mm`;

/** A rounded rectangle centred on (0, 0), as points (for previews). */
export function roundedRect(w: number, h: number, r: number, cx = 0, cy = 0): [number, number][] {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  const pts: [number, number][] = [];
  const corners: [number, number, number][] = [
    [w / 2 - rr, h / 2 - rr, 0],
    [-w / 2 + rr, h / 2 - rr, 90],
    [-w / 2 + rr, -h / 2 + rr, 180],
    [w / 2 - rr, -h / 2 + rr, 270],
  ];
  for (const [x, y, a0] of corners) {
    const steps = rr > 0 ? 6 : 0;
    for (let i = 0; i <= steps; i++) {
      const a = ((a0 + (90 * i) / Math.max(1, steps)) * Math.PI) / 180;
      pts.push([cx + x + rr * Math.cos(a), cy + y + rr * Math.sin(a)]);
    }
  }
  return pts;
}

/** Area of a rounded rectangle (mm²). */
export const roundedRectArea = (w: number, h: number, r: number) => w * h - (4 - Math.PI) * r * r;

/** Area inside a closed outline (mm², positive either way round). */
export function polygonArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/** The volume a countersunk hole takes out of a plate `thickness` thick: the hole, plus the cone (90°) round its top. */
export function countersunkHoleVolume(hole: number, countersink: number, thickness: number): number {
  const [r, R] = [hole / 2, countersink / 2];
  const h = R - r; // 90°: the cone is as deep as it is wide on each side
  return Math.PI * r * r * thickness + (Math.PI * h * (R * R + R * r + r * r)) / 3 - Math.PI * r * r * h;
}

/** Area of the half of a circle (radius R, centre at the origin) with x > 0, between the lines y = −h and y = h (h ≤ R). */
export function circleBand(R: number, h: number): number {
  return h * Math.sqrt(R * R - h * h) + R * R * Math.asin(h / R);
}

/** Area of the part of a circle (radius R) beyond a line `d` from its centre (0 ≤ d ≤ R). */
export function circleSegment(R: number, d: number): number {
  return R * R * Math.acos(d / R) - d * Math.sqrt(R * R - d * d);
}

/** A number kept to 6 decimals, so a size worked out from it reads exactly as its text says (angles' sines and cosines). */
export const sixPlaces = (n: number) => Math.round(n * 1e6) / 1e6;
