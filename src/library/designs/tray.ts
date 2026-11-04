/** An open-topped box or tray with rounded corners, for 3D printing. */
import { minus, times, type Ex } from "../ex";
import { extrudeFeature, roundCorners, shapesSketch, sketchFeature } from "../sketchKit";
import type { DesignValues, LibraryDesign } from "../types";
import type { SketchData } from "../../sketch/types";
import { mm, num, roundedRect } from "./common";

const VARS = ["width", "depth", "height", "wall", "floor", "radius"];

/** A rectangle centred on the origin, its corners rounded (radius 0 or less: square). */
function rounded(w: Ex, d: Ex, r: Ex, scope: Record<string, number>): SketchData {
  return roundCorners(shapesSketch([{ type: "rectangle", center: ["0", "0"], width: w.t, height: d.t }], scope), r, scope);
}

export const tray: LibraryDesign = {
  id: "tray",
  name: "Open box / tray",
  description: "An open-topped box with rounded corners, for 3D printing: storage trays, drawer organisers, pots.",
  category: "print",
  group: "Storage",
  prefix: "tray",
  icon: '<path d="M8 20c0-2 1-3 3-3h26c2 0 3 1 3 3v14c0 2-1 3-3 3H11c-2 0-3-1-3-3z"/><path d="M12 20h24v12H12z" opacity=".55"/>',
  inputs: [
    { key: "width", label: "Width", kind: "length", default: 100, min: 5, max: 1000, variable: true, help: "Outside, left to right." },
    { key: "depth", label: "Depth", kind: "length", default: 70, min: 5, max: 1000, variable: true, help: "Outside, front to back." },
    { key: "height", label: "Height", kind: "length", default: 30, min: 1, max: 1000, variable: true },
    { key: "wall", label: "Wall thickness", kind: "length", default: 2, min: 0.4, max: 50, variable: true, help: "2 mm is sturdy with a 0.4 mm nozzle." },
    { key: "floor", label: "Floor thickness", kind: "length", default: 2, min: 0.4, max: 50, variable: true },
    { key: "radius", label: "Corner radius", kind: "length", default: 6, min: 0, max: 500, variable: true, help: "0 for square corners." },
  ],
  problems: (v) => {
    const [w, d, h, wall, floor, r] = VARS.map((k) => num(v, k));
    const out: string[] = [];
    const small = Math.min(w, d);
    if (wall * 2 >= small - 1) out.push(`The walls are too thick for a tray ${mm(small)} across: make them less than ${mm((small - 1) / 2)}.`);
    if (floor >= h) out.push(`The floor (${mm(floor)}) must be thinner than the tray is high (${mm(h)}).`);
    if (r * 2 >= small) out.push(`The corner radius must be less than half the smaller side (${mm(small / 2)}).`);
    return out;
  },
  make: (ctx) => {
    const { width, depth, height, wall, floor, radius } = ctx.vars;
    const outer = rounded(width, depth, radius, ctx.scope);
    const inner = rounded(minus(width, times(wall, 2)), minus(depth, times(wall, 2)), minus(radius, wall), ctx.scope);
    const top = { kind: "default", name: "Top" } as const;
    const ring: SketchData = { points: [...outer.points, ...inner.points], curves: [...outer.curves, ...inner.curves], constraints: [...outer.constraints, ...inner.constraints] };
    const id = ctx.id("tray");
    return {
      features: [
        sketchFeature(ctx.id("floor-sketch"), "Floor sketch", top, outer),
        extrudeFeature(id, "Floor", ctx.id("floor-sketch"), { depth: floor, operation: "new" }),
        sketchFeature(ctx.id("walls-sketch"), "Walls sketch", top, ring),
        extrudeFeature(ctx.id("walls"), "Walls", ctx.id("walls-sketch"), { depth: height, operation: "add" }),
      ],
      partNames: { [id]: ctx.name },
    };
  },
  preview: (v: DesignValues) => {
    const [w, d, h, wall, , r] = VARS.map((k) => num(v, k));
    return [
      { kind: "poly", closed: true, points: roundedRect(w, d, r) },
      { kind: "poly", closed: true, faint: true, points: roundedRect(w - 2 * wall, d - 2 * wall, r - wall) },
      { kind: "text", at: [0, -d / 2 - Math.max(w, d) * 0.08], text: `${mm(w)} × ${mm(d)} × ${mm(h)} high` },
    ];
  },
};
