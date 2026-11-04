/**
 * A flat-pack phone stand to cut on a laser: a side profile and two feet that slot together (cross halving joints).
 * Shown put together; each piece is a flat panel, ready for Export for laser.
 */
import { minus, over, plus, ZERO, type Ex } from "../ex";
import type { Pt } from "../fingers";
import { copyFeature, extrudeFeature, outlineSketch, sketchFeature } from "../sketchKit";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { mm, num, polygonArea, varsOf } from "./common";
import { angleInput, standProblems } from "./phoneStand";
import { standProfile } from "./standProfile";

const VARS = ["slot", "lip", "back", "bar", "thickness", "foot", "kerf"];

/**
 * The profile (seen from the front, x forwards, z up) with a notch up from its bottom edge for each foot, and the
 * feet (seen from the side, y across, z up) with a notch down from their top. The front foot goes right under the slot's
 * back corner (x = 0…thickness, the profile's origin), where the side is just one bar tall: so the foot's top is flush with
 * the slot's floor and the phone stands on it across the foot's whole length. It's drawn on the Right plane and made
 * `thickness` thick from there; the back foot is a copy moved back, a bar's width in from the back. The notches are drawn
 * `kerf` narrower than the sheet (half each side), so they're snug once the laser has burnt that away.
 */
export function flatStandShapes(values: DesignValues, vars: Record<string, Ex> = varsOf(values, VARS)) {
  const { bar, thickness: t, foot, kerf } = vars;
  const p = standProfile({ angle: num(values, "angle"), slot: vars.slot, lip: vars.lip, back: vars.back, bar });
  const half = over(t, 2);
  const notch = over(bar, 2);
  const inset = over(kerf, 2);
  const backAt = minus(plus(p.rear, bar), half);
  const [first, ...rest] = p.outline;
  const notchAt = (x0: Ex): Pt[] => [
    [plus(x0, inset), ZERO],
    [plus(x0, inset), notch],
    [minus(plus(x0, t), inset), notch],
    [minus(plus(x0, t), inset), ZERO],
  ];
  const profile: Pt[] = [first, ...notchAt(backAt), ...notchAt(ZERO), ...rest];
  const left = minus(half, over(foot, 2));
  const right = plus(half, over(foot, 2));
  const footShape: Pt[] = [
    [left, ZERO],
    [right, ZERO],
    [right, bar],
    [minus(t, inset), bar],
    [minus(t, inset), notch],
    [inset, notch],
    [inset, bar],
    [left, bar],
  ];
  return { profile, foot: footShape, backAt, slotFront: p.slotFront };
}

export const flatStand: LibraryDesign = {
  id: "flat-stand",
  name: "Flat-pack phone stand",
  description:
    "A phone stand cut from flat sheet: a side profile and two feet that slot together, no glue needed. The phone stands on the front foot, right across its length, so it can't roll off sideways. Shown put together; each piece has a big flat face, ready for Export for laser. Measure your sheet for the slots, and set the kerf allowance for your laser.",
  category: "laser",
  prefix: "fstand",
  icon: '<path d="M6 34h30l-10-24h-5l10 24" /><path d="M10 30v8M30 30v8" opacity=".55"/><path d="M4 38h10M24 38h12" />',
  inputs: [
    angleInput,
    { key: "slot", label: "Slot (phone thickness)", kind: "length", default: 12, min: 2, max: 60, variable: true, help: "Your phone's thickness in its case, plus 1–2 mm." },
    { key: "lip", label: "Lip height", kind: "length", default: 10, min: 2, max: 200, variable: true },
    { key: "back", label: "Back rest length", kind: "length", default: 90, min: 20, max: 400, variable: true, help: "Along the slope, from the slot to the top." },
    { key: "bar", label: "Bar width", kind: "length", default: 15, min: 5, max: 100, variable: true, help: "How wide the profile's strips are (and how tall the feet)." },
    { key: "foot", label: "Foot length", kind: "length", default: 80, min: 20, max: 400, variable: true, help: "Left to right: how wide a base it stands on." },
    { key: "thickness", label: "Material thickness", kind: "length", default: 3, min: 1, max: 12, variable: true, help: "Measure your sheet: 3 mm plywood is often 2.8–3.2 mm." },
    { key: "kerf", label: "Kerf allowance", kind: "length", default: 0, min: 0, max: 1, variable: true, help: "How much your laser burns away (often 0.1–0.2 mm). The slots are drawn this much narrower so the pieces fit snugly." },
  ],
  problems: (v) => {
    const [slot, , , bar, t, foot] = VARS.map((k) => num(v, k));
    const out = standProblems(v, bar);
    const along = slot / Math.sin((num(v, "angle") * Math.PI) / 180);
    if (along < t + 1) out.push(`The slot is too narrow for the front foot under it: make it at least ${mm(Math.ceil((t + 1) * Math.sin((num(v, "angle") * Math.PI) / 180) * 10) / 10)} wide.`);
    if (bar < 2 * t + 2) out.push(`The bars must be at least ${mm(2 * t + 2)} wide for the slots in them.`);
    if (foot < 2 * bar) out.push(`The feet must be at least ${mm(2 * bar)} long, so it doesn't fall over sideways.`);
    if (!out.length) {
      const s = flatStandShapes(v);
      if (s.backAt.v + t >= -1) out.push("The back rest is too short for the back foot: make it longer.");
    }
    return out;
  },
  summary: () => "3 pieces: the side profile and two feet.",
  make: (ctx) => {
    const s = flatStandShapes(ctx.values, ctx.vars);
    const t = ctx.vars.thickness;
    const side = ctx.id("side");
    const frontFoot = ctx.id("front-foot");
    const backFoot = ctx.id("back-foot");
    return {
      features: [
        sketchFeature(ctx.id("side-sketch"), "Side sketch", { kind: "default", name: "Front" }, outlineSketch(s.profile, ctx.scope)),
        // The Front plane faces −Y: flip so the profile is y = 0…thickness, where the feet's notches are.
        extrudeFeature(side, "Side", ctx.id("side-sketch"), { depth: t, operation: "new", flip: true }),
        sketchFeature(ctx.id("foot-sketch"), "Foot sketch", { kind: "default", name: "Right" }, outlineSketch(s.foot, ctx.scope)),
        extrudeFeature(frontFoot, "Front foot", ctx.id("foot-sketch"), { depth: t, operation: "new" }),
        copyFeature(backFoot, "Back foot", frontFoot, { dx: s.backAt }),
      ],
      partNames: { [side]: `${ctx.name} side`, [frontFoot]: `${ctx.name} front foot`, [backFoot]: `${ctx.name} back foot` },
    };
  },
  preview: (v) => {
    const s = flatStandShapes(v);
    const pts = s.profile.map(([x, y]) => [x.v, y.v] as [number, number]);
    const xs = pts.map((p) => p[0]);
    const gap = num(v, "bar");
    const x0 = Math.max(...xs) + gap;
    const footPts = s.foot.map(([y, z]) => [y.v, z.v] as [number, number]);
    const fx = x0 - Math.min(...footPts.map((p) => p[0]));
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: pts }];
    for (const [i, text] of ["front foot", "back foot"].entries()) {
      const dy = i * (num(v, "bar") + gap);
      out.push({ kind: "poly", closed: true, points: footPts.map(([a, b]) => [a + fx, b + dy]) });
      out.push({ kind: "text", at: [fx + (footPts[0][0] + footPts[1][0]) / 2, dy + num(v, "bar") + gap / 2], text });
    }
    out.push({ kind: "text", at: [(Math.min(...xs) + Math.max(...xs)) / 2, -gap], text: "side" });
    return out;
  },
};

/** For tests: the areas of the side and of one foot (mm²). */
export function flatStandAreas(v: DesignValues): { side: number; foot: number } {
  const s = flatStandShapes(v);
  const flat = (pts: Pt[]) => polygonArea(pts.map(([x, y]) => [x.v, y.v]));
  return { side: flat(s.profile), foot: flat(s.foot) };
}
