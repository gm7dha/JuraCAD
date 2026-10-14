/**
 * Millimetres or inches. Everything is stored and built in millimetres; the
 * document's unit only changes what's shown and what a plain number typed into
 * a length box means.
 *
 * Typed lengths are saved with their unit, so switching units never changes
 * the model: in inches, typing "2" saves "2 in" (and the box shows "2");
 * an older plain "20" (millimetres) shows as "20 mm".
 */
import { evaluate, hasUnitsOrNames } from "./expr";

export type LengthUnit = "mm" | "in";

const FACTOR: Record<LengthUnit, number> = { mm: 1, in: 25.4 };

let current: LengthUnit = "mm";

/** The document's unit (kept in sync by the store). */
export function setLengthUnit(unit: LengthUnit): void {
  current = unit;
}
export function lengthUnit(): LengthUnit {
  return current;
}

/** Millimetres in the shown unit. */
export function toUnit(mm: number, unit: LengthUnit = current): number {
  return mm / FACTOR[unit];
}

/** Shown-unit amount in millimetres. */
export function fromUnit(value: number, unit: LengthUnit = current): number {
  return value * FACTOR[unit];
}

/** Decimal places worth showing: 2 for millimetres, 3 for inches. */
export const placesFor = (unit: LengthUnit = current) => (unit === "in" ? 3 : 2);

/** A plain number in the shown unit, rounded (no unit name), e.g. "12.5" or "0.492". */
export function lengthNumber(mm: number, unit: LengthUnit = current, places = placesFor(unit)): string {
  const f = 10 ** places;
  const r = Math.round(toUnit(mm, unit) * f) / f;
  return String(Object.is(r, -0) ? 0 : r);
}

/** A length with its unit, e.g. "12.5 mm" or "0.492 in". */
export function formatLength(mm: number, unit: LengthUnit = current, places = unit === "in" ? 4 : 3): string {
  return `${lengthNumber(mm, unit, places)} ${unit}`;
}

/** An area, e.g. "12.5 mm²" or "0.019 in²". */
export function formatArea(mm2: number, unit: LengthUnit = current): string {
  const f = 10 ** (unit === "in" ? 4 : 2);
  return `${Math.round((mm2 / FACTOR[unit] ** 2) * f) / f} ${unit}²`;
}

/** A volume, e.g. "1250 mm³" or "0.076 in³". */
export function formatVolume(mm3: number, unit: LengthUnit = current): string {
  const f = 10 ** (unit === "in" ? 3 : 1);
  return `${Math.round((mm3 / FACTOR[unit] ** 3) * f) / f} ${unit}³`;
}

/** A plain number (or sum) typed without units or variable names, that works out. */
const plain = (text: string) => text.trim() !== "" && !hasUnitsOrNames(text) && evaluate(text, {}).ok;
const isNumber = (text: string) => /^\s*(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(text);

/** What to save for a length typed in the shown unit. */
export function storeLength(typed: string, unit: LengthUnit = current): string {
  if (unit === "mm" || !plain(typed)) return typed;
  return isNumber(typed) ? `${typed} in` : `(${typed}) in`;
}

/** What to show in a length box for a saved length (the reverse of storeLength). */
export function showLength(stored: string, unit: LengthUnit = current): string {
  if (unit === "mm") return stored;
  for (const [pre, post] of [
    ["", " in"],
    ["(", ") in"],
  ]) {
    if (stored.startsWith(pre) && stored.endsWith(post)) {
      const inner = stored.slice(pre.length, stored.length - post.length);
      if (storeLength(inner, unit) === stored) return inner;
    }
  }
  // A plain number saved in millimetres (nothing to say for 0).
  if (!plain(stored)) return stored;
  const r = evaluate(stored, {});
  return r.ok && r.value === 0 ? stored : `${stored.trimEnd()} mm`;
}

/** The value to start a new length at (e.g. a new sketch dimension): rounded, in the shown unit. */
export function startingLength(mm: number, unit: LengthUnit = current): string {
  return storeLength(lengthNumber(mm, unit), unit);
}
