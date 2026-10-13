/** How many holes a sketch marks (points placed on their own, plus solid circle centres). Shared by the dialog and engine. */
import { pointPos } from "./ops";
import type { SketchData } from "./types";

export function holePositionsIn(data: SketchData): [number, number][] {
  const out: [number, number][] = [];
  const add = (p: [number, number]) => {
    if (!out.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-6)) out.push(p);
  };
  data.points.filter((p) => p.standalone).forEach((p) => add([p.x, p.y]));
  for (const c of data.curves) if (c.type === "circle" && !c.construction) add(pointPos(data, c.center));
  return out;
}

export const holePositionCount = (data: SketchData) => holePositionsIn(data).length;
