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
