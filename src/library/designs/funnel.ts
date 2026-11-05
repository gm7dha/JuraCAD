/**
 * A funnel: a 45° cone from the top down to a straight spout, with a short upright rim at the top. It prints standing
 * on its spout (the narrow end on the bed), so the cone leans out at exactly 45° — as steep an overhang as prints well
 * without supports. A revolved Front-plane profile (x = radius, y = height); the wall is `wall` thick square to the
 * cone, so the inside of the cone is √2 × wall in from the outside across, and meets the spout and rim a little higher.
 */
import { lit, minus, over, plus, times, type Ex } from "../ex";
import { outlineSketch, sketchFeature } from "../sketchKit";
import { revolveFeature } from "../printKit";
import type { Pt } from "../fingers";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { mm, num, sixPlaces, varsOf } from "./common";
import { revolvedVolume } from "./jar";

const VARS = ["top", "spout", "length", "wall", "rim"];
/** √2 − 1, to 6 places: how much higher the inside's corners are than the outside's, per mm of wall. */
export const RISE = sixPlaces(Math.SQRT2 - 1);

export function funnelProfile(vars: Record<string, Ex>): Pt[] {
  const { top, spout, length, wall, rim } = vars;
  const so = over(spout, 2);
  const to = over(top, 2);
  const k = times(wall, RISE);
  const coneTop = plus(length, minus(to, so));
  const zero = lit(0);
  return [
    [minus(so, wall), zero],
    [so, zero],
    [so, length],
    [to, coneTop],
    [to, plus(coneTop, rim)],
    [minus(to, wall), plus(coneTop, rim)],
    [minus(to, wall), plus(coneTop, k)],
    [minus(so, wall), plus(length, k)],
  ];
}

export const funnel: LibraryDesign = {
  id: "funnel",
  name: "Funnel",
  description:
    "A funnel for the kitchen, the garage or topping up the printer's resin and the car's screenwash. Choose how wide the top is and the spout's size and length; the cone slopes at 45° so it prints standing on its spout with no supports. Print it in PETG or PP for oils and hot liquids.",
  category: "print",
  group: "Household",
  prefix: "funnel",
  icon: '<path d="M6 8h36v3L28 25v15h-8V25L6 11z"/>',
  inputs: [
    { key: "top", label: "Top diameter", kind: "length", default: 100, min: 30, max: 250, variable: true, help: "Outside, across the top." },
    { key: "spout", label: "Spout diameter", kind: "length", default: 14, min: 6, max: 60, variable: true, help: "Outside, so it goes into a bottle neck this wide or more." },
    { key: "length", label: "Spout length", kind: "length", default: 30, min: 5, max: 150, variable: true },
    { key: "wall", label: "Wall thickness", kind: "length", default: 1.6, min: 0.8, max: 4, variable: true },
    { key: "rim", label: "Rim height", kind: "length", default: 6, min: 2, max: 30, variable: true, help: "The straight band round the top." },
  ],
  problems: (v) => {
    const [top, spout, , wall, rim] = VARS.map((k) => num(v, k));
    const out: string[] = [];
    if (spout < 2 * wall + 3) out.push(`The spout must be at least ${mm(2 * wall + 3)} across, to leave a hole through it.`);
    if (top < spout + 10) out.push(`The top must be at least ${mm(spout + 10)} across: 10 mm wider than the spout.`);
    if (rim < wall) out.push(`Make the rim at least ${mm(wall)} high (as thick as the wall).`);
    return out;
  },
  summary: (v) => {
    const [top, spout, length] = VARS.map((k) => num(v, k));
    return `1 part, ${mm(top)} across and ${mm(length + (top - spout) / 2 + num(v, "rim"))} tall; the hole through the spout is ${mm(spout - 2 * num(v, "wall"))}.${top > 180 ? " Check it fits your printer's bed (180 mm on an A1 mini, 256 mm on most others)." : ""}`;
  },
  make: (ctx) => {
    const id = ctx.id("funnel");
    return {
      features: [sketchFeature(ctx.id("profile"), "Funnel profile", { kind: "default", name: "Front" }, outlineSketch(funnelProfile(ctx.vars), ctx.scope)), revolveFeature(id, "Funnel", ctx.id("profile"), "new")],
      partNames: { [id]: ctx.name },
    };
  },
  preview: (v) => {
    const pts = funnelProfile(varsOf(v, VARS)).map(([x, y]): [number, number] => [x.v, y.v]);
    return [
      { kind: "poly", closed: true, points: pts },
      { kind: "poly", closed: true, points: pts.map(([x, y]): [number, number] => [-x, y]) },
      { kind: "text", at: [0, -8], text: "cut in half, as it prints" },
    ] as PreviewShape[];
  },
};

/** For tests: its volume (mm³). */
export const funnelVolume = (v: DesignValues) => revolvedVolume(funnelProfile(varsOf(v, VARS)).map(([x, y]): [number, number] => [x.v, y.v]));
