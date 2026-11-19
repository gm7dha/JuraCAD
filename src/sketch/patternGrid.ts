/**
 * Two-direction linear sketch pattern (Onshape's linear pattern with a second
 * direction): the row the first direction makes, repeated along the second.
 * Every copy is an ordinary pattern copy (patternMove), so the grid follows
 * the originals when they move or change size.
 */
import { evaluate } from "../model/expr";
import type { EditResult } from "./ops";
import { patternCurves, type SketchPatternOptions } from "./tools";
import type { SketchData } from "./types";

export interface SecondDirection {
  count: number;
  spacing: number;
  angle: number;
}

/** The second direction's boxes, as numbers (null when it's off), or what's wrong with them. */
export function readSecondDirection(set: { pattern2: boolean; pattern2Count: number; pattern2Spacing: string; pattern2Angle: string }): SecondDirection | string | null {
  if (!set.pattern2) return null;
  const spacing = evaluate(set.pattern2Spacing);
  if (!spacing.ok) return `Second direction's spacing: ${spacing.error}`;
  const angle = evaluate(set.pattern2Angle);
  if (!angle.ok) return `Second direction's angle: ${angle.error}`;
  return { count: set.pattern2Count, spacing: spacing.value, angle: angle.value };
}

/** A linear pattern in the first direction, then all of it (originals and copies) repeated along the second. */
export function patternGrid(s: SketchData, curveIds: string[], first: SketchPatternOptions, second: SecondDirection): EditResult & { curveIds: string[] } {
  if (first.kind !== "linear") return { sketch: s, curveIds: [], error: "A second direction is for patterns in a row." };
  const one = patternCurves(s, curveIds, first);
  if (one.error) return one;
  const two = patternCurves(one.sketch, [...curveIds, ...one.curveIds], { kind: "linear", count: second.count, spacing: second.spacing, angle: second.angle });
  if (two.error) return { sketch: s, curveIds: [], error: two.error.replace("The number of copies", "The second direction's number of copies").replace("Give the copies", "Give the second direction") };
  return { sketch: two.sketch, curveIds: [...one.curveIds, ...two.curveIds] };
}
