/**
 * A spool holder that turns on a 608 skateboard bearing (22 mm outside, 8 mm bore, 7 mm wide — the commonest bearing
 * there is): a round base with an 8 mm pin standing up on a small shoulder, and a hub that the spool lies on, its
 * centring ring in the spool's hole. The bearing is pressed into the hub from underneath and slides over the pin. The
 * spool lies flat and turns as the printer pulls — good on a shelf above the printer or for a dry box.
 *
 * The press fit is the Print settings' kind (DEFAULT_FITS.press; "how much bigger than the thing that goes in to make
 * a hole"): the hub's pocket is 22 + fit across (printed holes come out a little small, so that grips the bearing) and
 * the pin is 8 − fit (printed pins come out a little big). The shoulder (11 mm) touches only the bearing's inner ring
 * and lifts the hub 2 mm clear of the base; a ledge over the pocket (a 19.5 mm hole above it) sits on the outer ring
 * and prints as a short overhang. Both parts print as they're used: the base pin up, the hub ring up.
 */
import { DEFAULT_FITS } from "../../model/printSettings";
import { lit, minus, over, plus, type Ex } from "../ex";
import { extrudeFeature, shapesSketch, sketchFeature } from "../sketchKit";
import type { Feature } from "../../model/types";
import type { DesignValues, LibraryDesign, MakeContext, PreviewShape } from "../types";
import { mm, num, varsOf } from "./common";

const TOP = { kind: "default", name: "Top" } as const;
/** A 608 bearing (mm). */
export const BEARING = { outside: 22, bore: 8, width: 7 };
/** The base: its thickness, the shoulder under the bearing's inner ring (across, high). */
export const SPOOL_BASE = { thickness: 4, shoulder: 11, lift: 2 };
/** The hub: its plate's thickness, the centring ring's height above it, and the hole above the bearing. */
export const SPOOL_HUB = { plate: 3, ring: 15, opening: 19.5 };
/** Space between the two parts on the bed. */
export const SPOOL_GAP = 10;

const VARS = ["hole", "hub", "base", "fit"];
const circle = (cx: Ex, d: Ex) => ({ type: "circle", center: [cx.t, "0"], diameter: d.t });

/** Where the hub's middle is, along x (beside the base). */
export const hubAt = (vars: Record<string, Ex>) => plus(over(vars.base, 2), over(vars.hub, 2), lit(SPOOL_GAP));

function makeSpool(ctx: MakeContext) {
  const { hole, hub, base, fit } = ctx.vars;
  const baseId = ctx.id("base");
  const hubId = ctx.id("hub");
  const hx = hubAt(ctx.vars);
  const zero = lit(0);
  const sk = (role: string, name: string, shape: unknown) => sketchFeature(ctx.id(role), name, TOP, shapesSketch([shape], ctx.scope));
  const features: Feature[] = [
    sk("base-sketch", "Base sketch", circle(zero, base)),
    extrudeFeature(baseId, "Base", ctx.id("base-sketch"), { depth: lit(SPOOL_BASE.thickness), operation: "new" }),
    sk("shoulder-sketch", "Shoulder sketch", circle(zero, lit(SPOOL_BASE.shoulder))),
    extrudeFeature(ctx.id("shoulder"), "Shoulder", ctx.id("shoulder-sketch"), { depth: lit(SPOOL_BASE.thickness + SPOOL_BASE.lift), operation: "add" }),
    sk("pin-sketch", "Pin sketch", circle(zero, minus(lit(BEARING.bore), fit))),
    extrudeFeature(ctx.id("pin"), "Pin", ctx.id("pin-sketch"), { depth: lit(SPOOL_BASE.thickness + SPOOL_BASE.lift + BEARING.width), operation: "add" }),
    sk("plate-sketch", "Hub plate sketch", circle(hx, hub)),
    extrudeFeature(hubId, "Hub", ctx.id("plate-sketch"), { depth: lit(SPOOL_HUB.plate), operation: "new" }),
    sk("ring-sketch", "Centring ring sketch", circle(hx, minus(hole, lit(1)))),
    extrudeFeature(ctx.id("ring"), "Centring ring", ctx.id("ring-sketch"), { depth: lit(SPOOL_HUB.plate + SPOOL_HUB.ring), operation: "add" }),
    sk("opening-sketch", "Middle hole sketch", circle(hx, lit(SPOOL_HUB.opening))),
    extrudeFeature(ctx.id("opening"), "Middle hole", ctx.id("opening-sketch"), { operation: "remove", end: "throughAll" }),
    sk("pocket-sketch", "Bearing pocket sketch", circle(hx, plus(lit(BEARING.outside), fit))),
    extrudeFeature(ctx.id("pocket"), "Bearing pocket", ctx.id("pocket-sketch"), { depth: lit(BEARING.width), operation: "remove" }),
  ];
  return { features, partNames: { [baseId]: `${ctx.name}: base`, [hubId]: `${ctx.name}: hub` } };
}

export const bearingSpoolHolder: LibraryDesign = {
  id: "bearing-spool-holder",
  name: "Spool holder on a bearing",
  description:
    "A turntable for a reel of filament that spins smoothly on one 608 skateboard bearing: a round base with a pin, and a hub the spool lies on with a ring that fits its hole. Press the bearing into the hub (a vice or a gentle tap), drop it over the pin and lay the spool on. The bearing's fit comes from the press fit in Print settings. Both parts print flat, no supports.",
  category: "print",
  group: "Workshop",
  prefix: "turntable",
  icon: '<rect x="4" y="38" width="40" height="5" rx="1"/><rect x="21" y="26" width="6" height="12" opacity=".6"/><path d="M6 22h36v4H6z"/><path d="M16 14h16v8H16z" opacity=".75"/>',
  inputs: [
    { key: "hole", label: "Spool hole", kind: "length", default: 53, min: 30, max: 110, variable: true, help: "Across the hole in the middle of your spools: most are 52–56 mm. The ring is 1 mm smaller." },
    { key: "hub", label: "Hub diameter", kind: "length", default: 100, min: 40, max: 200, variable: true, help: "The plate the spool lies on." },
    { key: "base", label: "Base diameter", kind: "length", default: 90, min: 30, max: 200, variable: true, help: "Wider is steadier." },
    { key: "fit", label: "Press fit", kind: "length", default: DEFAULT_FITS.press, min: -0.2, max: 0.5, variable: true, help: `The pocket is 22 mm + this, the pin 8 mm − this. ${DEFAULT_FITS.press} mm is Print settings' press fit; more if the bearing won't go in.` },
  ],
  problems: (v) => {
    const [hole, hub] = VARS.map((k) => num(v, k));
    const out: string[] = [];
    if (hole - 1 < BEARING.outside + 4) out.push(`The spool hole must be at least ${mm(BEARING.outside + 5)} across, for a ring round the bearing.`);
    if (hub < hole + 10) out.push(`The hub must be at least ${mm(hole + 10)} across, 10 mm wider than the spool's hole.`);
    return out;
  },
  summary: (v) => {
    const fit = num(v, "fit");
    return `2 parts and one 608 bearing: the pocket is ${mm(BEARING.outside + fit)} across, the pin ${mm(BEARING.bore - fit)}; the spool's hole fits over a ${mm(num(v, "hole") - 1)} ring.`;
  },
  make: makeSpool,
  preview: (v) => {
    const vars = varsOf(v, VARS);
    const hx = hubAt(vars).v;
    return [
      { kind: "circle", c: [0, 0], r: vars.base.v / 2 },
      { kind: "circle", c: [0, 0], r: (BEARING.bore - vars.fit.v) / 2 },
      { kind: "circle", c: [hx, 0], r: vars.hub.v / 2 },
      { kind: "circle", c: [hx, 0], r: (vars.hole.v - 1) / 2, faint: true },
      { kind: "circle", c: [hx, 0], r: (BEARING.outside + vars.fit.v) / 2 },
    ] as PreviewShape[];
  },
};

/** For tests: the base's and hub's volumes (mm³). */
export function bearingSpoolVolumes(v: DesignValues): { base: number; hub: number } {
  const [hole, hub, base, fit] = VARS.map((k) => num(v, k));
  const disc = (d: number, h: number) => (Math.PI * d * d * h) / 4;
  const T = SPOOL_BASE.thickness;
  return {
    base: disc(base, T) + disc(SPOOL_BASE.shoulder, SPOOL_BASE.lift) + disc(BEARING.bore - fit, BEARING.width),
    hub: disc(hub, SPOOL_HUB.plate) + disc(hole - 1, SPOOL_HUB.ring) - disc(BEARING.outside + fit, BEARING.width) - disc(SPOOL_HUB.opening, SPOOL_HUB.plate + SPOOL_HUB.ring - BEARING.width),
  };
}
