/** The line a Revolve spins a sketch around. */
import { curvePoints, pointPos } from "./ops";
import type { SketchData } from "./types";

/** The sketch's own axes through its origin, or the id of a line in the sketch. */
export type RevolveAxis = "vertical" | "horizontal" | string;

type P2 = [number, number];

/** The axis as a point and direction in sketch coordinates. */
export function axisInSketch(data: SketchData, axis: RevolveAxis): { at: P2; dir: P2 } | null {
  if (axis === "vertical") return { at: [0, 0], dir: [0, 1] };
  if (axis === "horizontal") return { at: [0, 0], dir: [1, 0] };
  const line = data.curves.find((c) => c.id === axis && c.type === "line");
  if (!line) return null;
  const [a, b] = curvePoints(line).map((id) => pointPos(data, id));
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  return { at: a, dir: [dx / len, dy / len] };
}

/** The line a new revolve should spin around: the sketch's first construction line, if any. */
export function defaultAxis(data: SketchData): RevolveAxis {
  return data.curves.find((c) => c.type === "line" && c.construction)?.id ?? "vertical";
}

/** Plain-English name for an axis choice, for the Revolve dialog. */
export function axisLabel(data: SketchData, axis: RevolveAxis): string {
  if (axis === "vertical") return "Sketch's up–down axis (through the origin)";
  if (axis === "horizontal") return "Sketch's left–right axis (through the origin)";
  const lines = data.curves.filter((c) => c.type === "line");
  const i = lines.findIndex((c) => c.id === axis);
  if (i < 0) return "Missing line";
  return `${lines[i].construction ? "Construction line" : "Line"} ${i + 1}`;
}
