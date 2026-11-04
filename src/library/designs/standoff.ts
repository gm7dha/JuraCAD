/**
 * A hex standoff (spacer) with a hole right through for a screw at each end — modelled thread, a hole for the screw to
 * cut its own thread, or a clear hole for a screw to pass through. It prints standing up, so the hole comes out round.
 */
import { lit, plus, times, type Ex } from "../ex";
import { extrudeFeature, shapesSketch, sketchFeature } from "../sketchKit";
import { nutHoleDiameter, roundFace, threadFeature, threadOverlap, rodDiameter } from "../printKit";
import type { Feature } from "../../model/types";
import type { DesignValues, LibraryDesign } from "../types";
import { hexArea, PRINT_SIZES, printFastener } from "./boltSizes";
import { maxFit, minOverlap } from "./boltSet";
import { mm, num } from "./common";

const sizeOf = (v: DesignValues) => printFastener(String(v.size));

/** The hole's diameter for these values (before any thread is cut). */
export function standoffHole(v: DesignValues, fit: Ex = lit(num(v, "fit"))): Ex {
  const f = sizeOf(v);
  if (v.hole === "thread") return nutHoleDiameter(lit(f.d), f.pitch, fit);
  if (v.hole === "tap") return lit(Math.round((f.d - 0.75 * f.pitch) * 100) / 100);
  return plus(lit(f.d + 0.2), times(fit, 2));
}

export const standoff: LibraryDesign = {
  id: "standoff",
  name: "Hex standoff",
  description:
    "A six-sided spacer to hold a circuit board, a panel or a shelf a set distance off another, with a screw going into each end. The hole can have a real thread, be sized for the screw to cut its own thread in the plastic (the strongest for small screws), or be a plain clear hole for a longer screw to pass through. It prints standing up, so the hole comes out round.",
  category: "print",
  group: "Fixings",
  prefix: "standoff",
  icon: '<path d="M14 8h20l6 16-6 16H14L8 24z"/><circle cx="24" cy="24" r="5"/>',
  inputs: [
    { key: "size", label: "Screw size", kind: "choice", default: "M4", choices: PRINT_SIZES.map((s) => ({ value: s, label: s })) },
    { key: "length", label: "Length", kind: "length", default: 20, min: 2, max: 200, variable: true },
    {
      key: "hole",
      label: "Hole",
      kind: "choice",
      default: "tap",
      choices: [
        { value: "tap", label: "For the screw to cut its own thread" },
        { value: "thread", label: "Modelled thread (M6 and up print best)" },
        { value: "clear", label: "Clear: the screw passes through" },
      ],
    },
    { key: "fit", label: "Printed fit", kind: "length", default: 0.2, min: 0, max: 1, variable: true, help: "A modelled thread's gap, or the room round a screw in a clear hole." },
  ],
  problems: (v) => {
    const f = sizeOf(v);
    const out: string[] = [];
    if (v.hole === "thread") {
      const hole = standoffHole(v).v;
      const rod = rodDiameter(lit(f.d), f.pitch, lit(num(v, "fit"))).v;
      if (threadOverlap(rod, hole) < minOverlap(f.pitch)) out.push(`With a ${mm(num(v, "fit"))} fit an ${f.name} thread would hardly catch a printed bolt: make the fit at most ${mm(Math.max(0, maxFit(f.pitch)))}, or choose another kind of hole.`);
      if (num(v, "length") < 2 * f.pitch) out.push(`A threaded standoff must be at least ${mm(2 * f.pitch)} long.`);
    }
    return out;
  },
  summary: (v) => {
    const f = sizeOf(v);
    return `${mm(f.flats)} across the flats, ${mm(num(v, "length"))} long; the hole is ${mm(standoffHole(v).v)} across${v.hole === "thread" ? ` with an ${f.name} × ${f.pitch} thread` : ""}.`;
  },
  make: (ctx) => {
    const f = sizeOf(ctx.values);
    const { length, fit } = ctx.vars;
    const sk = ctx.id("sketch");
    const id = ctx.id("standoff");
    const features: Feature[] = [
      sketchFeature(
        sk,
        "Standoff sketch",
        { kind: "default", name: "Top" },
        shapesSketch(
          [
            { type: "polygon", center: ["0", "0"], sides: 6, diameter: String(f.flats), across: "flats" },
            { type: "circle", center: ["0", "0"], diameter: standoffHole(ctx.values, fit).t },
          ],
          ctx.scope,
        ),
      ),
      extrudeFeature(id, "Standoff", sk, { depth: length, operation: "new" }),
    ];
    if (ctx.values.hole === "thread") features.push(threadFeature(ctx.id("thread"), "Standoff thread", roundFace(id, [0, 0, length.v / 2], [0.5, 0.5, 0.5]), f.pitch, lit(0)));
    return { features, partNames: { [id]: `${ctx.name} ${f.name}` } };
  },
  preview: (v) => {
    const f = sizeOf(v);
    const r = f.flats / Math.sqrt(3);
    return [
      { kind: "poly", closed: true, points: Array.from({ length: 6 }, (_, i): [number, number] => [r * Math.cos((Math.PI / 3) * i), r * Math.sin((Math.PI / 3) * i)]) },
      { kind: "circle", c: [0, 0], r: standoffHole(v).v / 2 },
      { kind: "text", at: [0, -f.flats * 0.75], text: `${mm(num(v, "length"))} long` },
    ];
  },
};

/** For tests: its volume without a modelled thread (mm³). */
export const standoffVolume = (v: DesignValues) => (hexArea(sizeOf(v).flats) - Math.PI * (standoffHole(v).v / 2) ** 2) * num(v, "length");
