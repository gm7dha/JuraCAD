/**
 * A hose / vacuum adapter joining two different sizes: a straight tube at each end and a 45° cone between them, so it
 * prints standing on its first end with no supports whichever end is bigger. Each end either goes *into* a hose or
 * pipe (the size given is the adapter's outside there) or fits *over* one (the size given is its inside, plus a fit).
 * It's a revolved profile (Front plane: x = radius, y = height). The cone's wall is the wall thickness measured
 * across — square to the slope it's 0.7 × that, so the cone is never thinner than about 1 mm at the smallest wall.
 */
import { lit, plus } from "../ex";
import { outlineSketch, sketchFeature } from "../sketchKit";
import { revolveFeature } from "../printKit";
import type { Pt } from "../fingers";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { mm, num } from "./common";
import { revolvedVolume } from "./jar";

const fitChoice = (key: string, label: string, def: string) => ({
  key,
  label,
  kind: "choice" as const,
  default: def,
  choices: [
    { value: "into", label: "Goes into it (size = outside)" },
    { value: "over", label: "Fits over it (size = inside)" },
  ],
});

/** One end's outside and inside radius (mm). */
function endRadii(d: number, how: unknown, wall: number, fit: number): [number, number] {
  if (how === "over") {
    const inside = d / 2 + fit;
    return [inside + wall, inside];
  }
  return [d / 2, d / 2 - wall];
}

/** The adapter's radii and heights (mm): end A at the bottom, then the cone, then end B. */
export function adapterSizes(v: DesignValues) {
  const wall = num(v, "wall");
  const fit = num(v, "fit");
  const [aOut, aIn] = endRadii(num(v, "a"), v.aFits, wall, fit);
  const [bOut, bIn] = endRadii(num(v, "b"), v.bFits, wall, fit);
  const cone = Math.abs(bOut - aOut);
  return { wall, aOut, aIn, bOut, bIn, cone };
}

/** The profile, round from the axis: outside up, inside back down. */
export function adapterProfile(v: DesignValues, lengths: { a: { t: string; v: number }; b: { t: string; v: number } }): Pt[] {
  const s = adapterSizes(v);
  const r = (x: number) => lit(Math.round(x * 1e6) / 1e6);
  const zero = lit(0);
  const coneTop = plus(lengths.a, lit(s.cone));
  const top = plus(coneTop, lengths.b);
  if (s.cone < 1e-6) return [[r(s.aIn), zero], [r(s.aOut), zero], [r(s.aOut), top], [r(s.aIn), top]];
  return [
    [r(s.aIn), zero],
    [r(s.aOut), zero],
    [r(s.aOut), lengths.a],
    [r(s.bOut), coneTop],
    [r(s.bOut), top],
    [r(s.bIn), top],
    [r(s.bIn), coneTop],
    [r(s.aIn), lengths.a],
  ];
}

export const hoseAdapter: LibraryDesign = {
  id: "hose-adapter",
  name: "Hose / vacuum adapter",
  description:
    "Joins two hoses, pipes or fittings of different sizes — a vacuum hose to a sander's dust port, a pond pump to a hose, a fan to a duct. Each end either pushes into its hose or fits over its pipe; measure carefully (a calliper is best). A 45° cone joins the two, so it prints standing up without supports. PETG or ASA for anything wet or warm.",
  category: "print",
  group: "Workshop",
  prefix: "hose",
  icon: '<path d="M12 4h12v14l8 8v18H20V28l-8-8z"/><path d="M15 4v15l8 8v17" opacity=".5"/>',
  inputs: [
    { key: "a", label: "First end size", kind: "length", default: 32, min: 4, max: 200, help: "The end it stands on to print." },
    fitChoice("aFits", "First end", "into"),
    { key: "aLength", label: "First end length", kind: "length", default: 30, min: 5, max: 200, variable: true },
    { key: "b", label: "Second end size", kind: "length", default: 40, min: 4, max: 200 },
    fitChoice("bFits", "Second end", "over"),
    { key: "bLength", label: "Second end length", kind: "length", default: 30, min: 5, max: 200, variable: true },
    { key: "wall", label: "Wall thickness", kind: "length", default: 2, min: 1.2, max: 10 },
    { key: "fit", label: "Fit over a pipe", kind: "length", default: 0.2, min: 0, max: 2, help: "Added to the inside of an end that fits over something, each side." },
  ],
  problems: (v) => {
    const s = adapterSizes(v);
    const out: string[] = [];
    if (s.aIn < 1 || s.bIn < 1) out.push("An end that goes into a hose must be more than twice the wall thickness across (plus 2 mm), or there's no hole through it.");
    return out;
  },
  summary: (v) => {
    const s = adapterSizes(v);
    const fmt = (o: number, i: number) => `${mm(2 * o)} outside, ${mm(2 * i)} inside`;
    return `First end ${fmt(s.aOut, s.aIn)}; second end ${fmt(s.bOut, s.bIn)}; ${mm(num(v, "aLength") + s.cone + num(v, "bLength"))} tall.`;
  },
  make: (ctx) => {
    const id = ctx.id("adapter");
    const front = { kind: "default", name: "Front" } as const;
    return {
      features: [
        sketchFeature(ctx.id("profile"), "Adapter profile", front, outlineSketch(adapterProfile(ctx.values, { a: ctx.vars.aLength, b: ctx.vars.bLength }), ctx.scope)),
        revolveFeature(id, "Adapter", ctx.id("profile"), "new"),
      ],
      partNames: { [id]: ctx.name },
    };
  },
  preview: (v) => {
    const pts = adapterProfile(v, { a: lit(num(v, "aLength")), b: lit(num(v, "bLength")) }).map(([x, y]) => [x.v, y.v] as [number, number]);
    return [
      { kind: "poly", closed: true, points: pts },
      { kind: "poly", closed: true, points: pts.map(([x, y]) => [-x, y] as [number, number]) },
      { kind: "poly", faint: true, points: [[0, 0], [0, Math.max(...pts.map((p) => p[1]))]] },
    ] as PreviewShape[];
  },
};

/** For tests: its volume (mm³). */
export const adapterVolume = (v: DesignValues) =>
  revolvedVolume(adapterProfile(v, { a: lit(num(v, "aLength")), b: lit(num(v, "bLength")) }).map(([x, y]) => [x.v, y.v] as [number, number]));
