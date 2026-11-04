/** An L-shaped shelf bracket with screw holes in both arms and optional gussets. */
import { lit, minus, over, plus, ZERO, type Ex } from "../ex";
import { extrudeFeature, linearPatternFeature, outlineSketch, shapesSketch, sketchFeature } from "../sketchKit";
import type { Feature } from "../../model/types";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { mm, num } from "./common";

const holeCount = (v: DesignValues) => Math.max(0, Math.min(2, Math.round(Number(v.holes) || 0)));

/** Where the holes go along an arm `length` long (from the corner): its free part's middle, ± half the spacing. */
function holeSpots(length: Ex, t: Ex, spacing: Ex, n: number): Ex[] {
  const middle = plus(t, over(minus(length, t), 2));
  if (n === 1) return [middle];
  if (n === 2) return [minus(middle, over(spacing, 2)), plus(middle, over(spacing, 2))];
  return [];
}

export const bracket: LibraryDesign = {
  id: "bracket",
  name: "Shelf bracket",
  description: "An L-bracket for shelves and corners, with screw holes in both arms and optional triangular gussets for strength. Prints lying on its side.",
  category: "print",
  prefix: "bracket",
  icon: '<path d="M10 8h6v24h22v6H10z"/><path d="M16 26l8-8v14" opacity=".55"/><circle cx="13" cy="16" r="1.5"/><circle cx="30" cy="35" r="1.5"/>',
  inputs: [
    { key: "base", label: "Bottom arm length", kind: "length", default: 60, min: 5, max: 1000, variable: true },
    { key: "upright", label: "Upright arm length", kind: "length", default: 60, min: 5, max: 1000, variable: true },
    { key: "width", label: "Width", kind: "length", default: 30, min: 3, max: 1000, variable: true },
    { key: "thickness", label: "Thickness", kind: "length", default: 4, min: 0.8, max: 100, variable: true },
    {
      key: "holes",
      label: "Holes in each arm",
      kind: "choice",
      default: "2",
      choices: [
        { value: "0", label: "None" },
        { value: "1", label: "One" },
        { value: "2", label: "Two" },
      ],
    },
    { key: "hole", label: "Hole diameter", kind: "length", default: 4.5, min: 0.5, max: 100, variable: true, help: "4.5 mm suits a 4 mm wood screw." },
    { key: "spacing", label: "Hole spacing", kind: "length", default: 25, min: 1, max: 1000, variable: true, help: "Centre to centre, along each arm (with two holes)." },
    { key: "gussets", label: "Gussets", kind: "toggle", default: true, help: "Triangles at both sides that stop it bending." },
    { key: "gusset", label: "Gusset size", kind: "length", default: 25, min: 1, max: 1000, variable: true },
  ],
  problems: (v) => {
    const [a, b, w, t, d, s, g] = ["base", "upright", "width", "thickness", "hole", "spacing", "gusset"].map((k) => num(v, k));
    const n = holeCount(v);
    const out: string[] = [];
    if (t * 2 >= Math.min(a, b)) out.push(`The arms must be longer than twice the thickness (more than ${mm(2 * t)}).`);
    if (n > 0) {
      const need = d + (n === 2 ? s : 0) + 1;
      if (need > Math.min(a, b) - t) out.push(`The holes${n === 2 ? " and their spacing" : ""} don't fit on the arms: make the arms at least ${mm(need + t)} long, or the holes ${n === 2 ? "closer together or " : ""}smaller.`);
      if (d >= w - 1) out.push(`The holes must be smaller than the bracket is wide (less than ${mm(w - 1)}).`);
      if (v.gussets !== false && w / 2 - d / 2 <= t + 0.5) out.push(`With gussets the holes need more room across: make it wider than ${mm(d + 2 * t + 1)}.`);
    }
    if (v.gussets !== false) {
      if (g >= Math.min(a, b) - t) out.push(`The gussets must be smaller than the arms (less than ${mm(Math.min(a, b) - t)}).`);
      if (w < 3 * t) out.push(`It's too narrow for two gussets: make it at least ${mm(3 * t)} wide.`);
    }
    return out;
  },
  make: (ctx) => {
    const { base, upright, width, thickness: t, hole, spacing, gusset } = ctx.vars;
    const n = holeCount(ctx.values);
    const id = ctx.id("bracket");
    const front = { kind: "default", name: "Front" } as const;
    const profile = outlineSketch(
      [
        [ZERO, ZERO],
        [base, ZERO],
        [base, t],
        [t, t],
        [t, upright],
        [ZERO, upright],
      ],
      ctx.scope,
    );
    // The profile is on the Front plane (facing −Y): flip so the width goes along +Y.
    const features: Feature[] = [sketchFeature(ctx.id("profile"), "Profile", front, profile), extrudeFeature(id, "Bracket", ctx.id("profile"), { depth: width, operation: "new", flip: true })];
    const mid = over(width, 2);
    if (n > 0) {
      const circle = (x: Ex, y: Ex) => ({ type: "circle", center: [x.t, y.t], diameter: hole.t });
      features.push(
        sketchFeature(ctx.id("base-holes-sketch"), "Bottom holes sketch", { kind: "default", name: "Top" }, shapesSketch(holeSpots(base, t, spacing, n).map((x) => circle(x, mid)), ctx.scope)),
        extrudeFeature(ctx.id("base-holes"), "Bottom holes", ctx.id("base-holes-sketch"), { operation: "remove", end: "throughAll" }),
        sketchFeature(ctx.id("upright-holes-sketch"), "Upright holes sketch", { kind: "default", name: "Right" }, shapesSketch(holeSpots(upright, t, spacing, n).map((z) => circle(mid, z)), ctx.scope)),
        extrudeFeature(ctx.id("upright-holes"), "Upright holes", ctx.id("upright-holes-sketch"), { operation: "remove", end: "throughAll" }),
      );
    }
    if (ctx.values.gussets !== false) {
      const tri = outlineSketch(
        [
          [t, t],
          [plus(t, gusset), t],
          [t, plus(t, gusset)],
        ],
        ctx.scope,
      );
      features.push(
        sketchFeature(ctx.id("gusset-sketch"), "Gusset sketch", front, tri),
        extrudeFeature(ctx.id("gusset"), "Gusset", ctx.id("gusset-sketch"), { depth: t, operation: "add", flip: true }),
        linearPatternFeature(ctx.id("gussets"), "Gusset on the other side", [ctx.id("gusset")], "y", lit(2), minus(width, t)),
      );
    }
    return { features, partNames: { [id]: ctx.name } };
  },
  preview: (v) => {
    const [a, b, w, t, d, s, g] = ["base", "upright", "width", "thickness", "hole", "spacing", "gusset"].map((k) => num(v, k));
    const n = holeCount(v);
    const out: PreviewShape[] = [
      { kind: "poly", closed: true, points: [[0, 0], [a, 0], [a, t], [t, t], [t, b], [0, b]] },
    ];
    if (v.gussets !== false) out.push({ kind: "poly", closed: true, faint: true, points: [[t, t], [t + g, t], [t, t + g]] });
    // Seen from above: the bottom arm, beside the side view.
    const x0 = a + Math.max(a, b) * 0.15;
    out.push({ kind: "poly", closed: true, points: [[x0, 0], [x0 + a, 0], [x0 + a, w], [x0, w]] });
    out.push({ kind: "poly", faint: true, points: [[x0 + t, 0], [x0 + t, w]] });
    for (const x of holeSpots(lit(a), lit(t), lit(s), n)) out.push({ kind: "circle", c: [x0 + x.v, w / 2], r: d / 2 });
    out.push({ kind: "text", at: [a / 2, -Math.max(a, b) * 0.1], text: "side" }, { kind: "text", at: [x0 + a / 2, -Math.max(a, b) * 0.1], text: "from above" });
    return out;
  },
};

/** For tests: hole positions along an arm. */
export const bracketHoleSpots = (length: number, t: number, spacing: number, n: number) => holeSpots(lit(length), lit(t), lit(spacing), n).map((e) => e.v);
