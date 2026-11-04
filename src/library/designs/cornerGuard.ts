/**
 * A corner protector for the corner of a table top or shelf: a cap that slips over the corner, covering it top,
 * bottom and both edges. It prints lying on one of its sides, so it needs no supports; print it in TPU for a soft
 * bumper, or PLA/PETG for a hard cap.
 */
import { lit, plus, times, type Ex } from "../ex";
import { extrudeFeature, outlineSketch, shapesSketch, sketchFeature } from "../sketchKit";
import type { Pt } from "../fingers";
import type { DesignValues, LibraryDesign } from "../types";
import { mm, num, varsOf } from "./common";

const VARS = ["board", "arm", "wall", "fit"];

/**
 * Seen as printed: x along one edge of the corner, y through the board's thickness. It's a C (the slot the board goes
 * in, open at the end), made `arm` tall; then a full plate `wall` thick at the bottom closes the other edge.
 */
export function cornerOutline(vars: Record<string, Ex>): Pt[] {
  const { board, arm, wall, fit } = vars;
  const slot = plus(board, times(fit, 2));
  const z = lit(0);
  const top = plus(slot, times(wall, 2));
  return [
    [z, z],
    [arm, z],
    [arm, wall],
    [wall, wall],
    [wall, plus(wall, slot)],
    [arm, plus(wall, slot)],
    [arm, top],
    [z, top],
  ];
}

export const cornerGuard: LibraryDesign = {
  id: "corner-guard",
  name: "Corner protector",
  description:
    "A cap for the sharp corner of a table, desk or shelf — kinder to heads and knees, and it saves the corner from knocks. Measure the board's thickness. It prints lying on its side, no supports. Print it in TPU (flexible) for a soft bumper, or PLA/PETG for a hard cap; a dab of glue or a strip of double-sided tape holds it on.",
  category: "print",
  group: "Household",
  prefix: "corner",
  icon: '<path d="M8 10h30v8H16v12h22v8H8z"/>',
  inputs: [
    { key: "board", label: "Board thickness", kind: "length", default: 18, min: 3, max: 80, variable: true, help: "The table top or shelf, top to bottom." },
    { key: "arm", label: "Size", kind: "length", default: 30, min: 10, max: 150, variable: true, help: "How far it reaches along each edge." },
    { key: "wall", label: "Wall thickness", kind: "length", default: 3, min: 1, max: 15, variable: true },
    { key: "fit", label: "Fit", kind: "length", default: 0.2, min: 0, max: 2, variable: true, help: "Room round the board, each side. 0 for a tight push fit (in TPU)." },
  ],
  problems: (v) => (num(v, "arm") <= num(v, "wall") + 3 ? [`It must reach more than ${mm(num(v, "wall") + 3)} along the edges.`] : []),
  summary: (v) => `Fits a board ${mm(num(v, "board"))} thick; ${mm(num(v, "arm"))} along each edge and ${mm(num(v, "board") + 2 * num(v, "fit") + 2 * num(v, "wall"))} tall.`,
  make: (ctx) => {
    const { arm, wall, board, fit } = ctx.vars;
    const top = { kind: "default", name: "Top" } as const;
    const id = ctx.id("guard");
    const tall = plus(board, times(fit, 2), times(wall, 2));
    return {
      features: [
        sketchFeature(ctx.id("sketch"), "Corner protector sketch", top, outlineSketch(cornerOutline(ctx.vars), ctx.scope)),
        extrudeFeature(id, "Corner protector", ctx.id("sketch"), { depth: arm, operation: "new" }),
        sketchFeature(ctx.id("end-sketch"), "Corner end sketch", top, shapesSketch([{ type: "rectangle", corner: ["0", "0"], width: arm.t, height: tall.t }], ctx.scope)),
        extrudeFeature(ctx.id("end"), "Corner end", ctx.id("end-sketch"), { depth: wall, operation: "add" }),
      ],
      partNames: { [id]: ctx.name },
    };
  },
  preview: (v) => {
    const pts = cornerOutline(varsOf(v, VARS)).map(([x, y]): [number, number] => [x.v, y.v]);
    return [
      { kind: "poly", closed: true, points: pts },
      { kind: "text", at: [num(v, "arm") / 2, -num(v, "arm") * 0.2], text: "as printed, from above" },
    ];
  },
};

/** For tests: its volume (mm³). */
export function cornerVolume(v: DesignValues): number {
  const [board, arm, wall, fit] = VARS.map((k) => num(v, k));
  const slot = board + 2 * fit;
  const c = arm * (slot + 2 * wall) - (arm - wall) * slot;
  return c * arm + (arm - wall) * slot * wall;
}
