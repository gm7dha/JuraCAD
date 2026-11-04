/**
 * Shelf support pins, for the rows of holes inside cupboards and bookcases (5 mm in most European furniture, 1/4" in
 * American, or any size): a round pin that goes into the hole, on a small block whose flat top the shelf rests on.
 * Each prints standing on its block with the pin pointing up, so the pin comes out properly round.
 */
import { lit, plus, times, type Ex } from "../ex";
import { copyFeature, extrudeFeature, shapesSketch, sketchFeature } from "../sketchKit";
import type { Feature } from "../../model/types";
import type { DesignValues, LibraryDesign, MakeContext, PreviewShape } from "../types";
import { mm, num, roundedRect } from "./common";

const TOP = { kind: "default", name: "Top" } as const;
/** The block reaches this far below the pin and above it (mm), so the shelf rests just above the pin. */
export const PIN_BLOCK = { below: 3, above: 1 };
/** The space between pins as they're laid out. */
export const PIN_GAP = 5;

export const PIN_HOLES: Record<string, { label: string; d: number }> = {
  "5": { label: "5 mm (most European furniture)", d: 5 },
  "6.35": { label: '1/4" (6.35 mm)', d: 6.35 },
  "3": { label: "3 mm", d: 3 },
  custom: { label: "Another size", d: 0 },
};

export const holeOf = (v: DesignValues) => (v.hole === "custom" ? num(v, "diameter") : (PIN_HOLES[String(v.hole)] ?? PIN_HOLES["5"]).d);
/** The pin's diameter: the hole less the fit each side. */
export const pinDiameter = (v: DesignValues) => Math.round((holeOf(v) - 2 * num(v, "fit")) * 1e6) / 1e6;
const countOf = (v: DesignValues) => Math.max(1, Math.round(num(v, "count")));

function makePins(ctx: MakeContext) {
  const v = ctx.values;
  const { length, ledge, width } = ctx.vars;
  const d = pinDiameter(v);
  const first = ctx.id("pin");
  const features: Feature[] = [
    sketchFeature(ctx.id("block-sketch"), "Block sketch", TOP, shapesSketch([{ type: "rectangle", corner: [times(width, -0.5).t, String(-(d / 2 + PIN_BLOCK.below))], width: width.t, height: String(d + PIN_BLOCK.below + PIN_BLOCK.above) }], ctx.scope)),
    extrudeFeature(first, "Block", ctx.id("block-sketch"), { depth: ledge, operation: "new" }),
    sketchFeature(ctx.id("peg-sketch"), "Pin sketch", TOP, shapesSketch([{ type: "circle", center: ["0", "0"], diameter: String(d) }], ctx.scope)),
    extrudeFeature(ctx.id("peg"), "Pin", ctx.id("peg-sketch"), { depth: plus(ledge, length), operation: "add" }),
  ];
  const partNames: Record<string, string> = { [first]: `${ctx.name} 1` };
  const step: Ex = plus(width, lit(PIN_GAP));
  for (let i = 1; i < countOf(v); i++) {
    const id = ctx.id(`pin${i + 1}`);
    features.push(copyFeature(id, `Pin ${i + 1}`, first, { dx: times(step, i) }));
    partNames[id] = `${ctx.name} ${i + 1}`;
  }
  return { features, partNames };
}

export const shelfPins: LibraryDesign = {
  id: "shelf-pins",
  name: "Shelf support pins",
  description:
    "Replacement pins for the adjustable shelves in cupboards and bookcases: a round pin for the hole and a little block with a flat top for the shelf to sit on. Choose the hole size (5 mm in most European furniture, 1/4\" in American) and how many. They print standing up, so the pins come out round.",
  category: "print",
  group: "Household",
  prefix: "pins",
  icon: '<rect x="6" y="24" width="14" height="14" rx="1.5"/><path d="M10 24V10h6v14" opacity=".55"/><rect x="28" y="24" width="14" height="14" rx="1.5"/><path d="M32 24V10h6v14" opacity=".55"/>',
  inputs: [
    { key: "hole", label: "Shelf holes", kind: "choice", default: "5", choices: Object.entries(PIN_HOLES).map(([value, h]) => ({ value, label: h.label })) },
    { key: "diameter", label: "Hole size", kind: "length", default: 5, min: 2, max: 15, help: "For another size: measure across the hole." },
    { key: "fit", label: "Fit", kind: "length", default: 0.1, min: 0, max: 0.5, help: "How much smaller the pin is than the hole, each side." },
    { key: "length", label: "Pin length", kind: "length", default: 8, min: 3, max: 30, variable: true, help: "How far it goes into the hole." },
    { key: "ledge", label: "Ledge depth", kind: "length", default: 10, min: 4, max: 40, variable: true, help: "How far the block stands out from the side — the shelf rests on this." },
    { key: "width", label: "Ledge width", kind: "length", default: 10, min: 4, max: 40, variable: true },
    { key: "count", label: "How many", kind: "count", default: 4, min: 1, max: 24 },
  ],
  problems: (v) => {
    const out: string[] = [];
    const d = pinDiameter(v);
    if (d < 1.5) out.push("The pin would be too thin: make the hole bigger or the fit smaller.");
    if (num(v, "width") < d + 2) out.push(`The ledge must be at least ${mm(d + 2)} wide, a millimetre wider than the pin each side.`);
    return out;
  },
  summary: (v) => `${countOf(v)} part${countOf(v) === 1 ? "" : "s"}: pins ${mm(pinDiameter(v))} across for ${mm(holeOf(v))} holes, ${mm(num(v, "length"))} long, on ledges ${mm(num(v, "width"))} × ${mm(num(v, "ledge"))}.`,
  make: makePins,
  preview: (v) => {
    const d = pinDiameter(v);
    const w = num(v, "width");
    const out: PreviewShape[] = [];
    for (let i = 0; i < countOf(v); i++) {
      const x = i * (w + PIN_GAP);
      out.push({ kind: "poly", closed: true, points: roundedRect(w, d + PIN_BLOCK.below + PIN_BLOCK.above, 0, x, (PIN_BLOCK.above - PIN_BLOCK.below) / 2) }, { kind: "circle", c: [x, 0], r: d / 2 });
    }
    return out;
  },
};

/** For tests: each pin's volume (mm³). */
export function pinVolume(v: DesignValues): number {
  const d = pinDiameter(v);
  return num(v, "width") * (d + PIN_BLOCK.below + PIN_BLOCK.above) * num(v, "ledge") + (Math.PI * d * d * num(v, "length")) / 4;
}
