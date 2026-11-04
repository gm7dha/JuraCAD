/** A round spacer or washer. */
import { extrudeFeature, shapesSketch, sketchFeature } from "../sketchKit";
import type { LibraryDesign } from "../types";
import { mm, num } from "./common";

export const spacer: LibraryDesign = {
  id: "spacer",
  name: "Spacer / washer",
  description: "A round spacer or washer with a hole through the middle — to lift a board off a panel, or pack out a screw.",
  category: "print",
  group: "Fixings",
  prefix: "spacer",
  icon: '<circle cx="24" cy="24" r="15"/><circle cx="24" cy="24" r="6"/>',
  inputs: [
    { key: "outer", label: "Outside diameter", kind: "length", default: 12, min: 1, max: 1000, variable: true },
    { key: "hole", label: "Hole diameter", kind: "length", default: 3.4, min: 0.5, max: 1000, variable: true, help: "A little over the screw: 3.4 mm for M3, 4.5 for M4, 5.5 for M5." },
    { key: "thickness", label: "Thickness", kind: "length", default: 5, min: 0.2, max: 1000, variable: true },
  ],
  problems: (v) => (num(v, "hole") >= num(v, "outer") - 0.8 ? [`The hole must be at least 0.8 mm smaller than the outside (less than ${mm(num(v, "outer") - 0.8)}), or the ring is too thin to print.`] : []),
  make: (ctx) => {
    const { outer, hole, thickness } = ctx.vars;
    const sk = ctx.id("sketch");
    const id = ctx.id("spacer");
    const data = shapesSketch(
      [
        { type: "circle", center: ["0", "0"], diameter: outer.t },
        { type: "circle", center: ["0", "0"], diameter: hole.t },
      ],
      ctx.scope,
    );
    return {
      features: [sketchFeature(sk, "Spacer sketch", { kind: "default", name: "Top" }, data), extrudeFeature(id, "Spacer", sk, { depth: thickness, operation: "new" })],
      partNames: { [id]: ctx.name },
    };
  },
  preview: (v) => [
    { kind: "circle", c: [0, 0], r: num(v, "outer") / 2 },
    { kind: "circle", c: [0, 0], r: num(v, "hole") / 2 },
    { kind: "text", at: [0, -num(v, "outer") * 0.62], text: `${mm(num(v, "thickness"))} thick` },
  ],
};
