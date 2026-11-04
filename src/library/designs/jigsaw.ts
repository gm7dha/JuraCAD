/**
 * A jigsaw puzzle to cut on a laser: a board of the given size, with rows × columns of pieces whose edges carry
 * classic round tabs (src/library/puzzle.ts). One sketch: the border (red, outside cut) and the cuts between the pieces
 * (blue, inside cuts — the laser does them first, so the board stays put). In 3D it's the board, one plate
 * hanging down from the Top plane, with the puzzle sketch drawn on its top face.
 */
import { sketchId } from "../../sketch/ops";
import type { SketchArc, SketchData, SketchLine, SketchPoint } from "../../sketch/types";
import { allEdges, edgePolyline, makePuzzle, puzzleProblems, type P2, type PuzzleSpec } from "../puzzle";
import { extrudeFeature, shapesSketch, sketchFeature } from "../sketchKit";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { mm, num } from "./common";

const TOP = { kind: "default", name: "Top" } as const;

export function puzzleSpec(v: DesignValues): PuzzleSpec {
  return { width: num(v, "width"), height: num(v, "height"), rows: num(v, "rows"), columns: num(v, "columns"), tab: num(v, "tab") / 100, seed: num(v, "seed"), minNeck: num(v, "thickness") };
}

/**
 * The puzzle as one sketch: the border as lines from one piece corner to the next (so every cut ends on a corner of
 * it), and each edge between pieces as a line, three arcs and a line, ending exactly where its neighbours do. The
 * points are left free (a sketch of thousands of fixed points would be slow to check); "Edit design sizes" makes it
 * again exactly.
 */
export function puzzleSketch(spec: PuzzleSpec): SketchData {
  const p = makePuzzle(spec);
  const points: SketchPoint[] = [];
  const curves: (SketchLine | SketchArc)[] = [];
  const ids = new Map<string, string>();
  const pointAt = (q: P2): string => {
    const key = `${q[0].toFixed(5)},${q[1].toFixed(5)}`;
    let id = ids.get(key);
    if (!id) {
      id = sketchId("p");
      ids.set(key, id);
      points.push({ id, x: q[0], y: q[1] });
    }
    return id;
  };
  const fresh = (q: P2) => {
    const id = sketchId("p");
    points.push({ id, x: q[0], y: q[1] });
    return id;
  };
  const line = (a: P2, b: P2) => curves.push({ id: sketchId("l"), type: "line", p1: pointAt(a), p2: pointAt(b), construction: false });
  // The border, corner to corner of the pieces along it.
  const { rows, columns } = spec;
  const xs = Array.from({ length: columns + 1 }, (_, c) => c * p.pw);
  const ys = Array.from({ length: rows + 1 }, (_, r) => r * p.ph);
  for (let c = 0; c < columns; c++) {
    line([xs[c], 0], [xs[c + 1], 0]);
    line([xs[c], spec.height], [xs[c + 1], spec.height]);
  }
  for (let r = 0; r < rows; r++) {
    line([0, ys[r]], [0, ys[r + 1]]);
    line([spec.width, ys[r]], [spec.width, ys[r + 1]]);
  }
  for (const e of allEdges(p)) {
    line(e.points[0], e.points[1]);
    for (const a of e.arcs) curves.push({ id: sketchId("a"), type: "arc", center: fresh(a.centre), start: pointAt(a.start), end: pointAt(a.end), construction: false });
    line(e.points[4], e.points[5]);
  }
  return { points, curves, constraints: [] };
}

export const jigsaw: LibraryDesign = {
  id: "jigsaw",
  name: "Jigsaw puzzle",
  group: "Toys and gifts",
  description:
    "A jigsaw puzzle with classic round tabs that lock together. Change the pattern number for a different set of pieces. Export for laser: pick \"Puzzle sketch\" — the cuts between pieces are blue (cut first) and the border red. Engrave or glue a picture on the sheet first. Each cut is shared by the two pieces either side, so how snugly they fit is set by how thin your laser cuts.",
  category: "laser",
  prefix: "puzzle",
  laser: { sketch: { open: "cut" } },
  icon: '<path d="M6 6h16v6a3 3 0 1 0 0 6v4H16a3 3 0 1 1-6 0H6z"/><path d="M26 6h16v16h-6a3 3 0 1 0-6 0h-4v-6a3 3 0 1 1 0-6z" opacity=".7"/><path d="M6 26h4a3 3 0 1 0 6 0h6v16H6z" opacity=".7"/><path d="M26 26h4a3 3 0 1 1 6 0h6v16H26v-6a3 3 0 1 0 0-6z"/>',
  inputs: [
    { key: "width", label: "Width", kind: "length", default: 200, min: 30, max: 580 },
    { key: "height", label: "Height", kind: "length", default: 150, min: 30, max: 290, help: "The R1's bed is 600 × 300 mm." },
    { key: "rows", label: "Rows", kind: "count", default: 4, min: 1, max: 20 },
    { key: "columns", label: "Columns", kind: "count", default: 5, min: 1, max: 30 },
    { key: "tab", label: "Tab size", kind: "count", default: 25, min: 15, max: 32, help: "How far each tab pokes into the next piece, as a percentage of a piece's width." },
    { key: "seed", label: "Pattern number", kind: "count", default: 1, min: 0, max: 999999, help: "Any number: each gives a different arrangement of tabs, and the same number always gives the same puzzle." },
    { key: "thickness", label: "Material thickness", kind: "length", default: 3, min: 0.5, max: 25, variable: true, help: "Measure your sheet: 3 mm plywood is often 2.8–3.2 mm." },
  ],
  problems: (v) => puzzleProblems(puzzleSpec(v)),
  summary: (v) => {
    const s = puzzleSpec(v);
    return `${s.rows * s.columns} pieces, each about ${mm(s.width / s.columns)} × ${mm(s.height / s.rows)}.`;
  },
  make: (ctx) => {
    const board = ctx.id("board");
    const spec = puzzleSpec(ctx.values);
    // The board is its own plain rectangle (the puzzle's many areas would be slow to pick); the puzzle sketch on top
    // of it shows where the cuts go and is what Export for laser uses.
    const boardSketch = shapesSketch([{ type: "rectangle", corner: [0, 0], width: spec.width, height: spec.height }], ctx.scope);
    return {
      features: [
        sketchFeature(ctx.id("board-sketch"), "Board sketch", TOP, boardSketch),
        extrudeFeature(board, "Board", ctx.id("board-sketch"), { depth: ctx.vars.thickness, operation: "new", flip: true }),
        sketchFeature(ctx.id("sketch"), "Puzzle sketch", TOP, puzzleSketch(spec)),
      ],
      partNames: { [board]: ctx.name },
    };
  },
  preview: (v) => {
    const s = puzzleSpec(v);
    if (puzzleProblems(s).length) return [{ kind: "poly", closed: true, points: [[0, 0], [s.width, 0], [s.width, s.height], [0, s.height]] }];
    const p = makePuzzle(s);
    return [
      { kind: "poly", closed: true, points: [[0, 0], [s.width, 0], [s.width, s.height], [0, s.height]] },
      ...allEdges(p).map((e): PreviewShape => ({ kind: "poly", points: edgePolyline(e, 6) })),
    ];
  },
};
