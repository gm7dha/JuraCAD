/**
 * The flat pattern as simple line shapes (like a drawing sheet), for showing
 * it and saving it as DXF or SVG: the outline and holes to cut, and the bend
 * lines (centre lines, on their own layer in the DXF).
 */
import type { Prim } from "../drawing/sheet";
import type { FlatPatternData, ViewProjection } from "../kernel/protocol";

const MARGIN = 5;

/** The flat pattern's overall size (mm). */
export function flatSize(flat: Pick<FlatPatternData, "outline" | "boundary">): { width: number; height: number; min: [number, number] } {
  const pts = flat.boundary ? flat.boundary.flat() : flat.outline;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  if (!xs.length) return { width: 0, height: 0, min: [0, 0] };
  const min: [number, number] = [Math.min(...xs), Math.min(...ys)];
  return { width: Math.max(...xs) - min[0], height: Math.max(...ys) - min[1], min };
}

/** Lines to draw, moved so the pattern sits `MARGIN` mm in from the bottom-left corner; and the page size. */
export function flatPrims(flat: FlatPatternData): { prims: Prim[]; size: [number, number] } {
  const { width, height, min } = flatSize(flat);
  const at = (p: [number, number]) => [p[0] - min[0] + MARGIN, p[1] - min[1] + MARGIN];
  const cutLines: Prim[] = flat.boundary
    ? flat.boundary.map((c): Prim => ({ kind: "path", points: [...at(c[0]), ...at(c[1])], style: "visible" }))
    : [
        { kind: "path", points: flat.outline.flatMap(at), closed: true, style: "visible" },
        ...flat.holes.map((h): Prim => ({ kind: "path", points: h.flatMap(at), closed: true, style: "visible" })),
        ...(flat.cuts ?? []).map((c): Prim => ({ kind: "path", points: [...at(c[0]), ...at(c[1])], style: "visible" })),
      ];
  const prims: Prim[] = [
    ...cutLines,
    ...flat.bendLines.map((b): Prim => ({ kind: "path", points: [...at(b[0]), ...at(b[1])], style: "centre" })),
  ];
  return { prims, size: [width + 2 * MARGIN, height + 2 * MARGIN] };
}

/** A flat pattern as a drawing view: its outline, holes and cuts as lines, with its bends. */
export function flatProjection(flat: FlatPatternData): ViewProjection {
  const closed = (pts: [number, number][]) => (pts.length ? [...pts, pts[0]].flat() : []);
  const visible = (
    flat.boundary ? flat.boundary.map(([a, b]) => [...a, ...b]) : [closed(flat.outline), ...flat.holes.map(closed), ...(flat.cuts ?? []).map(([a, b]) => [...a, ...b])]
  ).filter((l) => l.length >= 4);
  const xs = visible.flatMap((l) => l.filter((_, i) => i % 2 === 0));
  const ys = visible.flatMap((l) => l.filter((_, i) => i % 2 === 1));
  return {
    kind: "flat",
    visible,
    hidden: [],
    circles: [],
    points: flat.boundary ? flat.boundary.flat().flat() : flat.outline.flat(),
    bounds: xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null,
    bends: flat.bends.map((b) => ({ line: [...b.line[0], ...b.line[1]] as [number, number, number, number], angle: b.angle, radius: b.radius, up: b.up })),
  };
}


type P2 = [number, number];

/** Drop line pieces that appear twice (either way round): they're shared by two neighbouring faces. */
export function outsideOnly(pieces: [P2, P2][]): [P2, P2][] {
  const key = (p: P2) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`;
  const count = new Map<string, number>();
  const k = ([a, b]: [P2, P2]) => [key(a), key(b)].sort().join("|");
  for (const s of pieces) count.set(k(s), (count.get(k(s)) ?? 0) + 1);
  return pieces.filter((s) => count.get(k(s)) === 1);
}
