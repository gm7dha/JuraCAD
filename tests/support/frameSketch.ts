/** Sketches of straight lines for the frame tests. */
import type { SketchData } from "../../src/sketch/types";

/** Lines through the points in turn (closed: back to the first). */
export function polySketch(pts: [number, number][], closed = true): SketchData {
  const points = pts.map(([x, y], i) => ({ id: `p${i}`, x, y }));
  const n = closed ? pts.length : pts.length - 1;
  const curves = Array.from({ length: n }, (_, i) => ({ id: `l${i}`, type: "line" as const, p1: `p${i}`, p2: `p${(i + 1) % pts.length}`, construction: false }));
  return { points, curves, constraints: [] };
}
