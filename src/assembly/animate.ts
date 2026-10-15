/**
 * Animating a mate: sweep one of its movements (a hinge's angle, a slider's
 * distance…) back and forth to see the mechanism move, like Onshape's
 * Animate. The mate's saved values don't change.
 */
import type { Mate } from "../model/types";
import { MATE_TYPES, mateLimits, mateValues } from "./mates";

export interface AnimationRange {
  key: string;
  from: number;
  to: number;
}

/** What a mate's animation sweeps: its first movement, between its limits (or a full turn / ±20 mm either side). */
export function animationRange(mate: Mate): AnimationRange | null {
  const def = MATE_TYPES[mate.type].values.find((d) => d.free);
  if (!def) return null;
  const { limits } = mateLimits(mate);
  const l = limits[def.key];
  if (l && Number.isFinite(l.min) && Number.isFinite(l.max) && l.max > l.min) return { key: def.key, from: l.min, to: l.max };
  const now = mateValues(mate).values[def.key] ?? 0;
  if (def.unit === "°") return { key: def.key, from: Number.isFinite(l?.min ?? NaN) ? l!.min : now, to: Number.isFinite(l?.max ?? NaN) ? l!.max : now + 360 };
  return { key: def.key, from: Number.isFinite(l?.min ?? NaN) ? l!.min : now - 20, to: Number.isFinite(l?.max ?? NaN) ? l!.max : now + 20 };
}

/** One full there-and-back sweep takes this long (ms). */
export const SWEEP_MS = 4000;

/** The mate's values `ms` into the animation: easing out and back along the range. */
export function animatedValues(mate: Mate, range: AnimationRange, ms: number): Record<string, string> {
  const t = (ms % SWEEP_MS) / SWEEP_MS;
  const v = range.from + (range.to - range.from) * (1 - Math.cos(2 * Math.PI * t)) / 2;
  return { ...mate.values, [range.key]: String(Math.round(v * 1000) / 1000) };
}
