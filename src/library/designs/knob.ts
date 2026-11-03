/** A round grip knob for a shaft (a potentiometer, a clamp screw…), with finger notches round its edge. */
import { over } from "../ex";
import { circularPatternFeature, extrudeFeature, shapesSketch, sketchFeature } from "../sketchKit";
import type { LibraryDesign, PreviewShape } from "../types";
import { mm, num } from "./common";

const KEYS = ["diameter", "height", "shaft", "depth", "grips", "grip"];

/** Area of the overlap of two circles (radii R and r, centres d apart), mm². */
export function lensArea(R: number, r: number, d: number): number {
  if (d >= R + r) return 0;
  if (d <= Math.abs(R - r)) return Math.PI * Math.min(R, r) ** 2;
  const a = r * r * Math.acos((d * d + r * r - R * R) / (2 * d * r));
  const b = R * R * Math.acos((d * d + R * R - r * r) / (2 * d * R));
  const c = 0.5 * Math.sqrt((-d + r + R) * (d + r - R) * (d - r + R) * (d + r + R));
  return a + b - c;
}

export const knob: LibraryDesign = {
  id: "knob",
  name: "Grip knob",
  description: "A round knob with finger notches round its edge and a hole for a shaft underneath — for a potentiometer, a clamp or a jig screw. Prints flat side down.",
  madeBy: "3D printer",
  prefix: "knob",
  icon: '<circle cx="24" cy="24" r="15"/><circle cx="24" cy="9" r="2.5"/><circle cx="39" cy="24" r="2.5"/><circle cx="24" cy="39" r="2.5"/><circle cx="9" cy="24" r="2.5"/><circle cx="24" cy="24" r="4"/>',
  inputs: [
    { key: "diameter", label: "Diameter", kind: "length", default: 30, min: 5, max: 500, variable: true },
    { key: "height", label: "Height", kind: "length", default: 15, min: 2, max: 500, variable: true },
    { key: "shaft", label: "Shaft hole diameter", kind: "length", default: 6.2, min: 0.5, max: 400, variable: true, help: "A little over the shaft: 6.2 mm for a 6 mm potentiometer shaft." },
    { key: "depth", label: "Shaft hole depth", kind: "length", default: 12, min: 0.5, max: 500, variable: true },
    { key: "grips", label: "Notches", kind: "count", default: 12, min: 3, max: 60, variable: true },
    { key: "grip", label: "Notch size", kind: "length", default: 4, min: 0.5, max: 100, variable: true, help: "The diameter of each notch." },
  ],
  problems: (v) => {
    const [D, H, s, depth, n, g] = KEYS.map((k) => num(v, k));
    const out: string[] = [];
    if (!Number.isInteger(n)) out.push("The number of notches must be a whole number.");
    if (depth >= H) out.push(`The shaft hole must be shallower than the knob is high (less than ${mm(H)}).`);
    if (s >= D - g - 2) out.push(`The shaft hole is too big for this knob: make it less than ${mm(D - g - 2)}.`);
    if (g >= D / 2) out.push(`The notches must be smaller than half the diameter (less than ${mm(D / 2)}).`);
    else if (n >= 3 && D * Math.sin(Math.PI / n) <= g) out.push(`${n} notches of ${mm(g)} don't fit round a ${mm(D)} knob: use fewer or smaller notches.`);
    return out;
  },
  make: (ctx) => {
    const { diameter, height, shaft, depth, grips, grip } = ctx.vars;
    const top = { kind: "default", name: "Top" } as const;
    const id = ctx.id("knob");
    const circle = (x: string, d: string) => [{ type: "circle", center: [x, "0"], diameter: d }];
    return {
      features: [
        sketchFeature(ctx.id("body-sketch"), "Knob sketch", top, shapesSketch(circle("0", diameter.t), ctx.scope)),
        extrudeFeature(id, "Knob", ctx.id("body-sketch"), { depth: height, operation: "new" }),
        sketchFeature(ctx.id("notch-sketch"), "Notch sketch", top, shapesSketch(circle(over(diameter, 2).t, grip.t), ctx.scope)),
        extrudeFeature(ctx.id("notch"), "Notch", ctx.id("notch-sketch"), { operation: "remove", end: "throughAll" }),
        circularPatternFeature(ctx.id("notches"), "Notches", [ctx.id("notch")], grips),
        sketchFeature(ctx.id("shaft-sketch"), "Shaft hole sketch", top, shapesSketch(circle("0", shaft.t), ctx.scope)),
        extrudeFeature(ctx.id("shaft"), "Shaft hole", ctx.id("shaft-sketch"), { depth, operation: "remove" }),
      ],
      partNames: { [id]: ctx.name },
    };
  },
  preview: (v) => {
    const [D, , s, , n, g] = KEYS.map((k) => num(v, k));
    const out: PreviewShape[] = [{ kind: "circle", c: [0, 0], r: D / 2 }];
    const count = Math.max(0, Math.min(60, Math.round(n)));
    for (let i = 0; i < count; i++) {
      const a = (2 * Math.PI * i) / count;
      out.push({ kind: "circle", c: [(D / 2) * Math.cos(a), (D / 2) * Math.sin(a)], r: g / 2, faint: true });
    }
    out.push({ kind: "circle", c: [0, 0], r: s / 2 });
    return out;
  },
};

