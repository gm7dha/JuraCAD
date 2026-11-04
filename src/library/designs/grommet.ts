/**
 * A desk cable grommet: a sleeve that drops into a round hole in a desk (a lip stops it falling through) and a cap
 * with a slot for the cables. Both print flat side down — the sleeve on its lip, the cap on its top — no supports.
 */
import { lit, minus, over, plus, times, type Ex } from "../ex";
import { extrudeFeature, shapesSketch, sketchFeature } from "../sketchKit";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { mm, num, varsOf } from "./common";

const VARS = ["hole", "depth", "wall", "lip", "fit", "slot"];
/** Room between the sleeve and the cap on the bed (mm). */
export const GROMMET_GAP = 10;
/** How tall the cap's plug is, below its top (mm). */
export const PLUG = 6;

/** Its sizes: diameters across, and where the cap sits. */
export function grommetSizes(vars: Record<string, Ex>) {
  const { hole, wall, lip, fit, slot } = vars;
  const lipD = plus(hole, times(lip, 2));
  const sleeveOut = minus(hole, times(fit, 2));
  const sleeveIn = minus(sleeveOut, times(wall, 2));
  const plugOut = minus(sleeveIn, times(fit, 2));
  const plugIn = minus(plugOut, times(wall, 2));
  const capAt = plus(lipD, lit(GROMMET_GAP));
  // The cable slot: from just inside the plug's wall out past the cap's edge.
  const slotFrom = minus(over(plugIn, 2), lit(1));
  const slotTo = plus(over(lipD, 2), lit(1));
  return { lipD, sleeveOut, sleeveIn, plugOut, plugIn, capAt, slot, slotLength: minus(slotTo, slotFrom), slotMiddle: plus(capAt, over(plus(slotFrom, slotTo), 2)) };
}

export const grommet: LibraryDesign = {
  id: "grommet",
  name: "Desk cable grommet",
  description:
    "A tidy cover for a cable hole in a desk: a sleeve that drops into the hole, with a lip that stops it falling through, and a cap with a slot for the cables. Measure the hole in the desk (60 mm and 80 mm are common). Both parts print flat side down, with no supports.",
  category: "print",
  group: "Household",
  prefix: "grommet",
  icon: '<circle cx="24" cy="24" r="17"/><circle cx="24" cy="24" r="12"/><path d="M33 21h8v6h-8z"/>',
  inputs: [
    { key: "hole", label: "Desk hole", kind: "length", default: 60, min: 20, max: 200, variable: true, help: "The hole in the desk, across." },
    { key: "depth", label: "Desk thickness", kind: "length", default: 20, min: 5, max: 80, variable: true, help: "The sleeve is this long below its lip." },
    { key: "lip", label: "Lip", kind: "length", default: 5, min: 2, max: 30, variable: true, help: "How far the lip reaches over the desk round the hole." },
    { key: "wall", label: "Wall thickness", kind: "length", default: 2, min: 1, max: 10, variable: true },
    { key: "slot", label: "Cable slot", kind: "length", default: 16, min: 4, max: 100, variable: true, help: "How wide the gap in the cap is." },
    { key: "fit", label: "Fit", kind: "length", default: 0.3, min: 0, max: 2, variable: true, help: "The gap round the sleeve in the desk, and round the cap in the sleeve." },
  ],
  problems: (v) => {
    const [hole, , wall, , fit, slot] = VARS.map((k) => num(v, k));
    const out: string[] = [];
    const s = grommetSizes(varsOf(v, VARS));
    if (s.plugIn.v < 8) out.push(`The hole is too small for these walls: make it at least ${mm(hole + 8 - s.plugIn.v)} across, or the walls thinner.`);
    if (slot >= s.plugIn.v - 2) out.push(`The cable slot must be narrower than ${mm(s.plugIn.v - 2)}.`);
    if (fit * 2 >= wall * 2) out.push("The fit is too big for these walls.");
    return out;
  },
  summary: (v) => {
    const s = grommetSizes(varsOf(v, VARS));
    return `2 parts: a sleeve ${mm(s.sleeveOut.v)} across (for a ${mm(num(v, "hole"))} hole) with a ${mm(s.lipD.v)} lip, and a cap with a ${mm(num(v, "slot"))} cable slot.`;
  },
  make: (ctx) => {
    const { wall, depth } = ctx.vars;
    const s = grommetSizes(ctx.vars);
    const top = { kind: "default", name: "Top" } as const;
    const ring = (x: Ex, a: Ex, b: Ex) => [
      { type: "circle", center: [x.t, "0"], diameter: a.t },
      { type: "circle", center: [x.t, "0"], diameter: b.t },
    ];
    const sleeve = ctx.id("sleeve");
    const cap = ctx.id("cap");
    const zero = lit(0);
    return {
      features: [
        sketchFeature(ctx.id("lip-sketch"), "Sleeve lip sketch", top, shapesSketch(ring(zero, s.lipD, s.sleeveIn), ctx.scope)),
        extrudeFeature(sleeve, "Sleeve lip", ctx.id("lip-sketch"), { depth: wall, operation: "new" }),
        sketchFeature(ctx.id("tube-sketch"), "Sleeve sketch", top, shapesSketch(ring(zero, s.sleeveOut, s.sleeveIn), ctx.scope)),
        extrudeFeature(ctx.id("tube"), "Sleeve", ctx.id("tube-sketch"), { depth: plus(wall, depth), operation: "add" }),
        sketchFeature(ctx.id("cap-sketch"), "Cap sketch", top, shapesSketch([{ type: "circle", center: [s.capAt.t, "0"], diameter: s.lipD.t }], ctx.scope)),
        extrudeFeature(cap, "Cap", ctx.id("cap-sketch"), { depth: wall, operation: "new" }),
        sketchFeature(ctx.id("plug-sketch"), "Cap plug sketch", top, shapesSketch(ring(s.capAt, s.plugOut, s.plugIn), ctx.scope)),
        extrudeFeature(ctx.id("plug"), "Cap plug", ctx.id("plug-sketch"), { depth: plus(wall, lit(PLUG)), operation: "add" }),
        sketchFeature(ctx.id("slot-sketch"), "Cable slot sketch", top, shapesSketch([{ type: "rectangle", center: [s.slotMiddle.t, "0"], width: s.slotLength.t, height: s.slot.t }], ctx.scope)),
        extrudeFeature(ctx.id("slot"), "Cable slot", ctx.id("slot-sketch"), { depth: plus(wall, lit(PLUG + 1)), operation: "remove" }),
      ],
      partNames: { [sleeve]: `${ctx.name}: sleeve`, [cap]: `${ctx.name}: cap` },
    };
  },
  preview: (v) => {
    const s = grommetSizes(varsOf(v, VARS));
    const x = s.capAt.v;
    const half = s.slot.v / 2;
    const out: PreviewShape[] = [
      { kind: "circle", c: [0, 0], r: s.lipD.v / 2 },
      { kind: "circle", c: [0, 0], r: s.sleeveOut.v / 2, faint: true },
      { kind: "circle", c: [0, 0], r: s.sleeveIn.v / 2 },
      { kind: "circle", c: [x, 0], r: s.lipD.v / 2 },
      { kind: "circle", c: [x, 0], r: s.plugIn.v / 2, faint: true },
      { kind: "poly", closed: true, points: [[s.slotMiddle.v - s.slotLength.v / 2, -half], [x + s.lipD.v / 2 + 1, -half], [x + s.lipD.v / 2 + 1, half], [s.slotMiddle.v - s.slotLength.v / 2, half]] },
      { kind: "text", at: [0, -s.lipD.v * 0.62], text: "sleeve" },
      { kind: "text", at: [x, -s.lipD.v * 0.62], text: "cap" },
    ];
    return out;
  },
};

/** For tests: the sleeve's volume (mm³). */
export function sleeveVolume(v: DesignValues): number {
  const s = grommetSizes(varsOf(v, VARS));
  const area = (d: number) => Math.PI * (d / 2) ** 2;
  const [wall, depth] = [num(v, "wall"), num(v, "depth")];
  return (area(s.lipD.v) - area(s.sleeveIn.v)) * wall + (area(s.sleeveOut.v) - area(s.sleeveIn.v)) * depth;
}
