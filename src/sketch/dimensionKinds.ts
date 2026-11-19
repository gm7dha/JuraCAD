/**
 * Switching what a sketch dimension measures without changing the shape (Onshape's right-click choices):
 * a circle's or arc's diameter ↔ radius, and a point's distance from a construction line ↔ that distance
 * doubled, measured as a diameter about the line (for revolve profiles: the size the turned part comes out).
 * Pure.
 */
import { evaluate } from "../model/expr";
import { dimensionLayout } from "./layout";
import { curveById, type EditResult } from "./ops";
import type { SketchConstraint, SketchData } from "./types";

/** A typed value scaled by k, kept readable: "10" × 2 = "20", "1 in" / 2 = "0.5 in", anything else "(…) * 2". */
export function scaledValue(value: string, k: 2 | 0.5): string {
  const plain = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(mm|cm|m|in)?\s*$/.exec(value);
  if (plain) {
    const n = Math.round(Number(plain[1]) * k * 1e6) / 1e6;
    return plain[2] ? `${n} ${plain[2]}` : String(n);
  }
  return k === 2 ? `(${value.trim()}) * 2` : `(${value.trim()}) / 2`;
}

/** Can this dimension be switched between diameter and radius? (A circle's or arc's.) */
export function canSwitchRound(s: SketchData, c: SketchConstraint | undefined): boolean {
  if (!c || (c.type !== "diameter" && c.type !== "radius")) return false;
  const k = curveById(s, c.refs[0]);
  return k?.type === "circle" || k?.type === "arc";
}

/** Can this dimension be measured as a diameter about its line (a point to a construction line)? */
export function canBeCentreline(s: SketchData, c: SketchConstraint | undefined): boolean {
  if (!c || c.type !== "pointLineDistance") return false;
  const line = curveById(s, c.refs[1]);
  return line?.type === "line" && (!!line.construction || !!c.doubled);
}

/** The same label place after the dimension changes (its anchor may move). */
function keepLabel(before: SketchData, c: SketchConstraint, next: SketchConstraint): SketchConstraint {
  const was = dimensionLayout(before, c);
  const now = dimensionLayout(before, { ...next, labelOffset: { x: 0, y: 0 } });
  if (!was || !now) return next;
  return { ...next, labelOffset: { x: was.label[0] - now.anchor[0], y: was.label[1] - now.anchor[1] } };
}

function replaced(s: SketchData, c: SketchConstraint, next: SketchConstraint): SketchData {
  return { ...s, constraints: s.constraints.map((k) => (k.id === c.id ? next : k)) };
}

/** Diameter → radius or radius → diameter, the size kept (half or twice the typed value). */
export function switchRoundDimension(s: SketchData, id: string): EditResult {
  const c = s.constraints.find((k) => k.id === id);
  if (!c || !canSwitchRound(s, c)) return { sketch: s, error: "Select a circle's or arc's dimension to switch between diameter and radius." };
  const toRadius = c.type === "diameter";
  const value = c.driven || c.value === undefined ? c.value : scaledValue(c.value, toRadius ? 0.5 : 2);
  if (value !== undefined && !evaluate(value).ok) return { sketch: s, error: "That dimension's value couldn't be worked out, so it can't be switched." };
  const next: SketchConstraint = { ...c, type: toRadius ? "radius" : "diameter", ...(value !== undefined ? { value } : {}) };
  return { sketch: replaced(s, c, next) };
}

/** Measure a point-to-construction-line distance as a diameter about the line (on), or plainly again (off). */
export function setCentrelineDimension(s: SketchData, id: string, on: boolean): EditResult {
  const c = s.constraints.find((k) => k.id === id);
  if (!c || !canBeCentreline(s, c)) return { sketch: s, error: "Select a dimension from a point to a construction line (the line the profile turns round)." };
  if (!!c.doubled === on) return { sketch: s };
  const value = c.driven || c.value === undefined ? c.value : scaledValue(c.value, on ? 2 : 0.5);
  if (value !== undefined && !evaluate(value).ok) return { sketch: s, error: "That dimension's value couldn't be worked out, so it can't be switched." };
  const { doubled: _was, ...rest } = c;
  void _was;
  const next: SketchConstraint = { ...rest, ...(on ? { doubled: true } : {}), ...(value !== undefined ? { value } : {}) };
  return { sketch: replaced(s, c, keepLabel(s, c, next)) };
}
