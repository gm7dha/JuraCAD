/** A phone / tablet stand for 3D printing: a side profile made as wide as the stand, printed lying on its side. */
import { extrudeFeature, outlineSketch, sketchFeature } from "../sketchKit";
import type { DesignInput, DesignValues, LibraryDesign } from "../types";
import { mm, num, polygonArea, varsOf } from "./common";
import { standProfile, trigOf, type StandSizes } from "./standProfile";

const VARS = ["slot", "lip", "back", "width", "thickness"];

/** The lean (degrees from the table): a whole number, changed with Edit design sizes. */
export const angleInput: DesignInput = {
  key: "angle",
  label: "Lean angle (degrees)",
  kind: "count",
  default: 65,
  min: 45,
  max: 85,
  help: "How far the screen leans back, measured from the table: 90 would be upright. 60–70 suits most people.",
};

export function standSizes(values: DesignValues, vars = varsOf(values, VARS), bar = vars.thickness): StandSizes {
  return { angle: num(values, "angle"), slot: vars.slot, lip: vars.lip, back: vars.back, bar };
}

/** Problems shared by both stands (sizes in mm). */
export function standProblems(v: DesignValues, bar: number): string[] {
  const [slot, lip, back] = ["slot", "lip", "back"].map((k) => num(v, k));
  const { cos } = trigOf(num(v, "angle"));
  const out: string[] = [];
  if (lip >= back) out.push(`The lip must be lower than the back rest is long (less than ${mm(back)}).`);
  if (back * cos < bar + 2) out.push(`The back rest is too short for the stand to lean: make it at least ${mm(Math.ceil(((bar + 2) / cos) * 10) / 10)} long, or the angle smaller.`);
  if (slot < 2) out.push("The slot must be at least 2 mm wide.");
  return out;
}

export const phoneStand: LibraryDesign = {
  id: "phone-stand",
  name: "Phone / tablet stand",
  description:
    "A stand that holds a phone or tablet leaning back, in a slot with a lip in front. It prints lying on its side — no overhangs and no supports, and the layers run along it so it's strong. For a tall tablet make the back rest longer so it doesn't tip.",
  category: "print",
  prefix: "stand",
  icon: '<path d="M6 38h34v-8h-5v4h-5l-9-24h-6l9 24H6z"/><path d="M22 10l10 26" opacity=".55"/>',
  inputs: [
    angleInput,
    { key: "slot", label: "Slot (device thickness)", kind: "length", default: 12, min: 2, max: 60, variable: true, help: "Your phone or tablet's thickness in its case, plus 1–2 mm." },
    { key: "width", label: "Width", kind: "length", default: 70, min: 10, max: 400, variable: true, help: "Left to right, as it stands on the table." },
    { key: "lip", label: "Lip height", kind: "length", default: 12, min: 2, max: 200, variable: true, help: "How high the front lip comes up the screen." },
    { key: "back", label: "Back rest length", kind: "length", default: 90, min: 20, max: 400, variable: true, help: "Along the slope, from the slot to the top." },
    { key: "thickness", label: "Thickness", kind: "length", default: 5, min: 1.5, max: 30, variable: true, help: "Of the base, the back rest and the lip." },
  ],
  problems: (v) => standProblems(v, num(v, "thickness")),
  summary: (v) => `Leans back at ${num(v, "angle")}°; it's ${mm(standFootprint(v))} deep on the table.`,
  make: (ctx) => {
    const id = ctx.id("stand");
    const p = standProfile(standSizes(ctx.values, ctx.vars));
    return {
      features: [
        sketchFeature(ctx.id("profile"), "Stand profile", { kind: "default", name: "Top" }, outlineSketch(p.outline, ctx.scope)),
        extrudeFeature(id, "Stand", ctx.id("profile"), { depth: ctx.vars.width, operation: "new" }),
      ],
      partNames: { [id]: ctx.name },
    };
  },
  preview: (v) => {
    const p = standProfile(standSizes(v));
    return [
      { kind: "poly", closed: true, points: p.outline.map(([x, y]) => [x.v, y.v]) },
      { kind: "text", at: [(p.rear.v + p.lipFront.v) / 2, -num(v, "back") * 0.12], text: `${num(v, "angle")}°, ${mm(num(v, "width"))} wide` },
    ];
  },
};

/** How deep the stand is on the table (mm). */
export function standFootprint(v: DesignValues): number {
  const p = standProfile(standSizes(v));
  return p.lipFront.v - p.rear.v;
}

/** For tests: the side profile's area (mm²). */
export const standProfileArea = (v: DesignValues, bar?: number) => {
  const vars = varsOf(v, VARS);
  const p = standProfile(standSizes(v, vars, bar === undefined ? vars.thickness : { t: String(bar), v: bar }));
  return polygonArea(p.outline.map(([x, y]) => [x.v, y.v]));
};
