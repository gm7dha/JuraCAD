/**
 * A plant pot with drainage holes, and a saucer it stands in. Both are revolved profiles (Front plane: x = radius,
 * y = height): the pot widens towards the top (at most 45°, so it prints without supports) and has a hole in the
 * middle of its floor and a ring of holes round it; the saucer has ribs on its floor that the pot stands on, so water
 * drains out from under it, and its wall stays `gap` clear of the pot all the way round. The ribs sit between the
 * holes (ribs at 0°, 360/n°…, holes half a step round), so none is blocked. The saucer is printed beside the pot.
 */
import { lit, minus, over, plus, times, type Ex } from "../ex";
import { circularPatternFeature, extrudeFeature, moveFeature, outlineSketch, shapesSketch, sketchFeature } from "../sketchKit";
import { revolveFeature } from "../printKit";
import type { Pt } from "../fingers";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { circleBand, mm, num, sixPlaces, varsOf } from "./common";
import { revolvedVolume } from "./jar";

const VARS = ["top", "bottom", "height", "wall", "floor", "gap", "saucer"];
/** The saucer's floor and wall thickness, its ribs' height and width, and the room between pot and saucer on the bed. */
export const SAUCER = { floor: 2, wall: 2, rib: 2.5, ribWidth: 2.5, apart: 10 };
/** Drainage holes: across (mm), and the ring's radius as a share of the pot's bottom radius. */
export const DRAIN = { d: 6, ring: 0.55 };
/** Where the ribs start, as a share of the pot's bottom radius. */
export const RIB_START = 0.3;

const holesOf = (v: DesignValues) => Math.max(3, Math.round(num(v, "holes")));
/** a ÷ b, both sizes. */
const ratio = (a: Ex, b: Ex): Ex => ({ t: `(${a.t}) / (${b.t})`, v: a.v / b.v });

/** The pot's and saucer's radii and heights (mm, as expressions of the variables). */
export function potSizes(vars: Record<string, Ex>) {
  const { top, bottom, height, wall, floor, gap, saucer } = vars;
  const rb = over(bottom, 2);
  const rt = over(top, 2);
  /** The pot stands on the ribs: its bottom this high above the bed in the saucer. */
  const standsAt = lit(SAUCER.floor + SAUCER.rib);
  /** The pot's outside where it passes the saucer's rim, and the saucer's inside there (the gap clear of it). */
  const atRim = plus(rb, times(minus(rt, rb), ratio(minus(saucer, standsAt), height)));
  const saucerIn = plus(atRim, gap);
  const saucerOut = plus(saucerIn, lit(SAUCER.wall));
  return { rb, rt, height, wall, floor, saucer, standsAt, atRim, saucerIn, saucerOut, ring: times(rb, DRAIN.ring), ribFrom: times(rb, RIB_START) };
}

export function potProfile(vars: Record<string, Ex>): Pt[] {
  const s = potSizes(vars);
  const zero = lit(0);
  return [
    [zero, zero],
    [s.rb, zero],
    [s.rt, s.height],
    [minus(s.rt, s.wall), s.height],
    [minus(s.rb, s.wall), s.floor],
    [zero, s.floor],
  ];
}

export function saucerProfile(vars: Record<string, Ex>): Pt[] {
  const s = potSizes(vars);
  const zero = lit(0);
  return [
    [zero, zero],
    [s.saucerOut, zero],
    [s.saucerOut, s.saucer],
    [s.saucerIn, s.saucer],
    [s.saucerIn, lit(SAUCER.floor)],
    [zero, lit(SAUCER.floor)],
  ];
}

const values = (pts: Pt[]): [number, number][] => pts.map(([x, y]) => [x.v, y.v]);

export const plantPot: LibraryDesign = {
  id: "plant-pot",
  name: "Plant pot and saucer",
  description:
    "A round plant pot that widens towards the top, with drainage holes in its floor, and a saucer for it to stand in. Ribs in the saucer hold the pot up off the water so it drains, and there's a gap all round so it lifts out easily. Both print standing up beside each other, no supports. PETG copes best with water and sun.",
  category: "print",
  group: "Garden",
  prefix: "pot",
  icon: '<path d="M10 10h28l-4 26H14z"/><path d="M6 38h36v4H6z" opacity=".7"/><circle cx="20" cy="33" r="1.2"/><circle cx="28" cy="33" r="1.2"/>',
  inputs: [
    { key: "top", label: "Top diameter", kind: "length", default: 110, min: 30, max: 250, variable: true, help: "Outside, at the rim." },
    { key: "bottom", label: "Bottom diameter", kind: "length", default: 80, min: 25, max: 250, variable: true },
    { key: "height", label: "Height", kind: "length", default: 95, min: 20, max: 250, variable: true },
    { key: "wall", label: "Wall thickness", kind: "length", default: 2, min: 1, max: 6, variable: true },
    { key: "floor", label: "Floor thickness", kind: "length", default: 2.5, min: 1, max: 8, variable: true },
    { key: "holes", label: "Drainage holes round the middle one", kind: "count", default: 6, min: 3, max: 12 },
    { key: "saucer", label: "Saucer height", kind: "length", default: 16, min: 8, max: 60, variable: true },
    { key: "gap", label: "Gap round the pot", kind: "length", default: 3, min: 0.5, max: 20, variable: true, help: "Between the pot and the saucer's rim." },
  ],
  problems: (v) => {
    const [top, bottom, height, wall, floor, , saucer] = VARS.map((k) => num(v, k));
    const out: string[] = [];
    if (top < bottom) out.push("The top must be at least as wide as the bottom (so the pot prints without supports).");
    else if ((top - bottom) / 2 > height) out.push(`The sides would lean out more than 45° and need supports: make the pot at least ${mm((top - bottom) / 2)} tall, or the top narrower.`);
    if (floor >= height - 5) out.push("The floor is too thick for a pot this short.");
    if (saucer <= SAUCER.floor + SAUCER.rib + 3) out.push(`The saucer must be at least ${mm(SAUCER.floor + SAUCER.rib + 3)} high.`);
    if (saucer >= height * 0.6) out.push(`The saucer is nearly as tall as the pot: make it lower than ${mm(height * 0.6)}.`);
    const rb = bottom / 2;
    if (rb * DRAIN.ring + DRAIN.d / 2 > rb - wall - 1.5) out.push("The pot's bottom is too small for its drainage holes.");
    const n = holesOf(v);
    // Holes half a step from the ribs: the gap between a hole's edge and a rib's side must be there.
    if (rb * DRAIN.ring * Math.sin(Math.PI / n) < DRAIN.d / 2 + SAUCER.ribWidth / 2 + 1) out.push(`${n} holes are too close together for a pot this small: use fewer.`);
    return out;
  },
  summary: (v) => {
    const s = potSizes(varsOf(v, VARS));
    return `2 parts. The pot holds about ${Math.round(potInside(v) / 1000)} ml; the saucer is ${mm(2 * s.saucerOut.v)} across, ${mm(num(v, "gap"))} clear of the pot at its rim, and ${holesOf(v) + 1} drainage holes.`;
  },
  make: (ctx) => {
    const s = potSizes(ctx.vars);
    const n = holesOf(ctx.values);
    const front = { kind: "default", name: "Front" } as const;
    const top = { kind: "default", name: "Top" } as const;
    const pot = ctx.id("pot");
    const saucer = ctx.id("saucer");
    const half = Math.PI / n;
    const [c, sn] = [sixPlaces(Math.cos(half)), sixPlaces(Math.sin(half))];
    const below = plus(s.floor, lit(1));
    return {
      features: [
        sketchFeature(ctx.id("pot-sketch"), "Pot profile", front, outlineSketch(potProfile(ctx.vars), ctx.scope)),
        revolveFeature(pot, "Pot", ctx.id("pot-sketch"), "new"),
        sketchFeature(ctx.id("middle-sketch"), "Middle drain hole sketch", top, shapesSketch([{ type: "circle", center: ["0", "0"], diameter: String(DRAIN.d) }], ctx.scope)),
        extrudeFeature(ctx.id("middle"), "Middle drain hole", ctx.id("middle-sketch"), { depth: below, operation: "remove" }),
        sketchFeature(ctx.id("drain-sketch"), "Drain hole sketch", top, shapesSketch([{ type: "circle", center: [times(s.ring, c).t, times(s.ring, sn).t], diameter: String(DRAIN.d) }], ctx.scope)),
        extrudeFeature(ctx.id("drain"), "Drain hole", ctx.id("drain-sketch"), { depth: below, operation: "remove" }),
        circularPatternFeature(ctx.id("drains"), "Drain holes", [ctx.id("drain")], lit(n)),
        sketchFeature(ctx.id("saucer-sketch"), "Saucer profile", front, outlineSketch(saucerProfile(ctx.vars), ctx.scope)),
        revolveFeature(saucer, "Saucer", ctx.id("saucer-sketch"), "new"),
        sketchFeature(
          ctx.id("rib-sketch"),
          "Rib sketch",
          top,
          shapesSketch([{ type: "rectangle", corner: [s.ribFrom.t, String(-SAUCER.ribWidth / 2)], width: minus(plus(s.saucerIn, lit(SAUCER.wall / 2)), s.ribFrom).t, height: String(SAUCER.ribWidth) }], ctx.scope),
        ),
        extrudeFeature(ctx.id("rib"), "Rib", ctx.id("rib-sketch"), { depth: s.standsAt, operation: "add" }),
        circularPatternFeature(ctx.id("ribs"), "Ribs", [ctx.id("rib")], lit(n)),
        // Made round the same axis, then moved beside the pot to print.
        moveFeature(ctx.id("saucer-beside"), "Saucer beside the pot", saucer, { dx: plus(s.rt, s.saucerOut, lit(SAUCER.apart)) }),
      ],
      partNames: { [pot]: `${ctx.name}: pot`, [saucer]: `${ctx.name}: saucer` },
    };
  },
  preview: (v) => {
    const vars = varsOf(v, VARS);
    const s = potSizes(vars);
    const mirror = (pts: [number, number][], dx: number, dz = 0): [number, number][] => [...pts.map(([x, y]): [number, number] => [dx + x, y + dz]), ...pts.slice().reverse().map(([x, y]): [number, number] => [dx - x, y + dz])];
    return [
      { kind: "poly", closed: true, points: mirror(values(saucerProfile(vars)).slice(1, -1), 0) },
      { kind: "poly", closed: true, points: mirror(values(potProfile(vars)).slice(1, -1), 0, s.standsAt.v) },
      { kind: "text", at: [0, -8], text: "the pot standing in its saucer" },
    ] as PreviewShape[];
  },
};

/** The pot's inside (mm³): water it holds up to the rim. */
export function potInside(v: DesignValues): number {
  const p = values(potProfile(varsOf(v, VARS)));
  return revolvedVolume([[0, p[4][1]], p[4], p[3], [0, p[3][1]]]);
}

/** For tests: the pot's and saucer's volumes (mm³). */
export function potVolumes(v: DesignValues): { pot: number; saucer: number } {
  const vars = varsOf(v, VARS);
  const s = potSizes(vars);
  const n = holesOf(v);
  const hole = Math.PI * (DRAIN.d / 2) ** 2 * s.floor.v;
  // Each rib inside the saucer's wall: its strip, from where it starts out to the wall's round inside.
  const ribArea = circleBand(s.saucerIn.v, SAUCER.ribWidth / 2) - s.ribFrom.v * SAUCER.ribWidth;
  return {
    pot: revolvedVolume(values(potProfile(vars))) - (n + 1) * hole,
    saucer: revolvedVolume(values(saucerProfile(vars))) + n * ribArea * SAUCER.rib,
  };
}
