/**
 * The flat pattern as simple line shapes (like a drawing sheet), for showing
 * it and saving it as DXF or SVG: the outline and holes to cut, and the bend
 * lines (centre lines, on their own layer in the DXF).
 */
import type { Prim } from "../drawing/sheet";
import type { FlatPatternData } from "../kernel/protocol";

const MARGIN = 5;

/** The flat pattern's overall size (mm). */
export function flatSize(flat: Pick<FlatPatternData, "outline">): { width: number; height: number; min: [number, number] } {
  const xs = flat.outline.map((p) => p[0]);
  const ys = flat.outline.map((p) => p[1]);
  if (!xs.length) return { width: 0, height: 0, min: [0, 0] };
  const min: [number, number] = [Math.min(...xs), Math.min(...ys)];
  return { width: Math.max(...xs) - min[0], height: Math.max(...ys) - min[1], min };
}

/** Lines to draw, moved so the pattern sits `MARGIN` mm in from the bottom-left corner; and the page size. */
export function flatPrims(flat: FlatPatternData): { prims: Prim[]; size: [number, number] } {
  const { width, height, min } = flatSize(flat);
  const at = (p: [number, number]) => [p[0] - min[0] + MARGIN, p[1] - min[1] + MARGIN];
  const prims: Prim[] = [
    { kind: "path", points: flat.outline.flatMap(at), closed: true, style: "visible" },
    ...flat.holes.map((h): Prim => ({ kind: "path", points: h.flatMap(at), closed: true, style: "visible" })),
    ...(flat.cuts ?? []).map((c): Prim => ({ kind: "path", points: [...at(c[0]), ...at(c[1])], style: "visible" })),
    ...flat.bendLines.map((b): Prim => ({ kind: "path", points: [...at(b[0]), ...at(b[1])], style: "centre" })),
  ];
  return { prims, size: [width + 2 * MARGIN, height + 2 * MARGIN] };
}
