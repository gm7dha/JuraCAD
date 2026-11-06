/**
 * What the casting moulds share besides their outsides (mouldSurface.ts): stacks of sections made into level sketches
 * and ruled Lofts, flat sketches of several outlines, the cast's volume and weight, and the filament and release advice.
 */
import type { Scope } from "../../model/expr";
import type { Feature } from "../../model/types";
import type { SketchData } from "../../sketch/types";
import { lit } from "../ex";
import { levelPlane, loftFeature } from "../printKit";
import { outlineSketch, shapesSketch, sketchFeature } from "../sketchKit";
import type { MakeContext } from "../types";
import { mm } from "./common";
import type { Section } from "./mouldSurface";
import type { P2 } from "./printShapes";

/** Grams per millilitre: soy/paraffin wax, and concrete or Jesmonite (about the same). */
export const WAX_DENSITY = 0.9;
export const CONCRETE_DENSITY = 2.1;
/** Liquid silicone rubber (for a master's mould). */
export const SILICONE_DENSITY = 1.1;

/** mm³ → ml, to one place. */
export const ml = (mm3: number) => Math.round(mm3 / 100) / 10;
/** "about 120 g" from mm³ and a density. */
export const grams = (mm3: number, density: number) => `${Math.round((mm3 / 1000) * density)} g`;

/** The cast's size and weight for the summary. */
export const waxLine = (mm3: number) => `${ml(mm3)} ml of wax — about ${grams(mm3, WAX_DENSITY)} (soy wax is about ${WAX_DENSITY} g/ml)`;
export const concreteLine = (mm3: number) => `${ml(mm3)} ml of concrete or Jesmonite — about ${grams(mm3, CONCRETE_DENSITY)} (about ${CONCRETE_DENSITY} g/ml)`;

/** Advice that ends each description. */
export const WAX_ADVICE =
  "Filament: print it in PETG — soy wax is usually poured at about 55–70 °C and paraffin hotter (let paraffin cool to about 70–75 °C before pouring it into PETG), and PLA starts to soften at about 55–60 °C, so PLA only suits cool-poured soy wax, used carefully. A light spray of mould release or silicone spray helps the candle come out.";
export const CONCRETE_ADVICE =
  "Filament: PLA or PETG both work. Wipe the inside with a release agent (vaseline, cooking spray or a proper release spray) before every pour, and sand or smooth the inside first: every layer line shows on the cast.";
export const MASTER_ADVICE =
  "For many casts, print a master instead and make a silicone mould from it: silicone picks up every detail, bends to let go of the cast, and lasts for dozens of pours.";

const six = (n: number) => Math.round(n * 1e6) / 1e6;

/** One loop of a flat sketch: a section's circle or polygon, moved by (dx, dy). */
export function loopSketch(s: Section, scope: Scope, dx = 0, dy = 0): SketchData {
  if (s.r !== undefined) return shapesSketch([{ type: "circle", center: [String(six(dx)), String(six(dy))], diameter: String(six(2 * s.r)) }], scope);
  return outlineSketch(s.pts!.map(([x, y]) => [lit(six(x + dx)), lit(six(y + dy))]), scope);
}

/** Several loops in one sketch (a ring = an outline and a hole; holes in a plate…), every point dimensioned. */
export function loopsSketch(loops: SketchData[]): SketchData {
  return { points: loops.flatMap((l) => l.points), curves: loops.flatMap((l) => l.curves), constraints: loops.flatMap((l) => l.constraints) };
}

/** A circle as a section (for loopSketch), anywhere. */
export const circleAt = (r: number, z = 0): Section => ({ z, r });
/** A polygon as a section. */
export const polygonAt = (pts: P2[], z = 0): Section => ({ z, pts });

/** A stack of sections as level sketches and a ruled Loft through them (New, Add or Remove). */
export function stackFeatures(ctx: MakeContext, role: string, label: string, stack: Section[], operation: "new" | "add" | "remove"): Feature[] {
  const sketches = stack.map((s, i) => sketchFeature(ctx.id(`${role}-${i}`), `${label} ${i + 1}`, levelPlane(`${mm(s.z)} up`, s.z), loopSketch(s, ctx.scope)));
  const loft = loftFeature(ctx.id(role), label, sketches.map((s) => s.id), operation);
  return [...sketches, operation === "new" ? { ...loft, apart: true } : loft];
}

/** A Loft through sketches already made (the two halves of a mould share the cavity's sketches). */
export function loftThrough(ctx: MakeContext, role: string, label: string, sketchRoles: string[], operation: "new" | "add" | "remove"): Feature {
  const loft = loftFeature(ctx.id(role), label, sketchRoles.map((r) => ctx.id(r)), operation);
  return operation === "new" ? { ...loft, apart: true } : loft;
}

/** Just the level sketches of a stack (for lofts made later). */
export function stackSketches(ctx: MakeContext, role: string, label: string, stack: Section[]): { features: Feature[]; roles: string[] } {
  const roles = stack.map((_, i) => `${role}-${i}`);
  return { features: stack.map((s, i) => sketchFeature(ctx.id(roles[i]), `${label} ${i + 1}`, levelPlane(`${mm(s.z)} up`, s.z), loopSketch(s, ctx.scope))), roles };
}
