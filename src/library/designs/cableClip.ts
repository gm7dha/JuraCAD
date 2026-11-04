/** A C-shaped clip that holds a cable against a wall or desk, with a screw hole — for 3D printing. */
import { lit, minus, neg, over, plus, times, type Ex } from "../ex";
import { countersunkHoleFeature, extrudeFeature, shapesSketch, sketchFeature } from "../sketchKit";
import type { Feature } from "../../model/types";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { circleBand, circleSegment, countersunkHoleVolume, mm, num, varsOf } from "./common";

const VARS = ["cable", "opening", "ring", "width", "base", "hole"];
const withHole = (v: DesignValues) => v.fixing !== "tape";

/**
 * Its sizes, seen from the side (x out from the wall, y along it; drawn on Top and made `width` thick upwards, so it
 * prints on its side). The base is x = −base…0, its front face on the Right plane where the screw head sits; the ring's
 * middle is at x = cable/2 + ring/2, so the ring sinks half its wall into the base; the opening faces away from the wall.
 */
export function clipSizes(v: Record<string, Ex>) {
  const { cable, ring, opening, hole } = v;
  const inner = over(cable, 2);
  const outer = plus(inner, ring);
  const cx = plus(inner, over(ring, 2));
  // The tab for the screw: beyond the ring, as long as the countersink plus a wall either side.
  const tab = plus(times(hole, 2), times(ring, 2));
  return {
    inner,
    outer,
    cx,
    /** The base runs from y = −outer to y = outer + tab (screw) or y = outer (sticky tape). */
    baseLow: neg(outer),
    baseHigh: (screw: boolean) => (screw ? plus(outer, tab) : outer),
    holeAt: plus(outer, over(tab, 2)),
    opening,
    countersink: times(hole, 2),
  };
}

export const cableClip: LibraryDesign = {
  id: "cable-clip",
  name: "Cable clip",
  description:
    "A C-shaped clip that a cable snaps into, on a flat base that screws to a wall or desk (or sticks on with tape). It prints lying on its side, so the ring is round and springy; the screw hole prints sideways, which small holes do fine.",
  category: "print",
  group: "Household",
  prefix: "clip",
  icon: '<path d="M10 10h5v28h-5z"/><path d="M33 17a9 9 0 1 0 0 14" /><path d="M15 24h3" opacity=".55"/><circle cx="12.5" cy="34" r="1.5"/>',
  inputs: [
    { key: "cable", label: "Cable diameter", kind: "length", default: 6, min: 1, max: 60, variable: true, help: "Measure the cable. The clip's hole is this size, so it grips." },
    { key: "opening", label: "Opening", kind: "length", default: 4.5, min: 0.5, max: 60, variable: true, help: "The gap the cable snaps through: a bit less than the cable, so it stays in." },
    { key: "ring", label: "Ring thickness", kind: "length", default: 2, min: 0.8, max: 20, variable: true },
    { key: "width", label: "Width", kind: "length", default: 10, min: 3, max: 200, variable: true },
    { key: "base", label: "Base thickness", kind: "length", default: 3, min: 1, max: 30, variable: true },
    { key: "hole", label: "Screw hole", kind: "length", default: 3.5, min: 1, max: 12, variable: true, help: "3.5 mm suits a 3 mm screw." },
    {
      key: "fixing",
      label: "Fixed with",
      kind: "choice",
      default: "screw",
      choices: [
        { value: "screw", label: "A screw (countersunk hole)" },
        { value: "tape", label: "Sticky tape (flat back, no hole)" },
      ],
    },
  ],
  problems: (v) => {
    const [d, gap, ring, w, base, hole] = VARS.map((k) => num(v, k));
    const out: string[] = [];
    if (gap >= d) out.push(`The opening must be smaller than the cable (less than ${mm(d)}), or the cable falls out.`);
    if (gap < d * 0.4) out.push(`The opening is too small to push the cable through: make it at least ${mm(d * 0.4)}.`);
    if (base < ring / 2 + 0.5) out.push(`The base must be at least ${mm(ring / 2 + 0.5)} thick to hold the ring.`);
    if (withHole(v)) {
      if (2 * hole + 2 > w) out.push(`The screw hole's countersink (${mm(2 * hole)}) doesn't fit across: make the clip at least ${mm(2 * hole + 2)} wide, or the hole smaller.`);
      if (hole / 2 + 0.8 > base) out.push(`The base is too thin for a countersunk hole of ${mm(hole)}: make it at least ${mm(hole / 2 + 0.8)} thick.`);
    }
    return out;
  },
  summary: (v) => `Holds a ${mm(num(v, "cable"))} cable; it snaps in through a ${mm(num(v, "opening"))} gap.`,
  make: (ctx) => {
    const { width, base, hole } = ctx.vars;
    const s = clipSizes(ctx.vars);
    const screw = withHole(ctx.values);
    const id = ctx.id("clip");
    const top = { kind: "default", name: "Top" } as const;
    const right = { kind: "default", name: "Right" } as const;
    const low = s.baseLow;
    const high = s.baseHigh(screw);
    const length = minus(high, low);
    const features: Feature[] = [
      sketchFeature(ctx.id("base-sketch"), "Base sketch", top, shapesSketch([{ type: "rectangle", center: [neg(over(base, 2)).t, over(plus(high, low), 2).t], width: base.t, height: length.t }], ctx.scope)),
      extrudeFeature(id, "Base", ctx.id("base-sketch"), { depth: width, operation: "new" }),
      sketchFeature(
        ctx.id("ring-sketch"),
        "Ring sketch",
        top,
        shapesSketch(
          [
            { type: "circle", center: [s.cx.t, "0"], diameter: times(s.outer, 2).t },
            { type: "circle", center: [s.cx.t, "0"], diameter: times(s.inner, 2).t },
          ],
          ctx.scope,
        ),
      ),
      extrudeFeature(ctx.id("ring"), "Ring", ctx.id("ring-sketch"), { depth: width, operation: "add" }),
      // The opening: a slot from the ring's middle out past its front.
      sketchFeature(ctx.id("opening-sketch"), "Opening sketch", top, shapesSketch([{ type: "rectangle", center: [plus(s.cx, over(plus(s.outer, lit(1)), 2)).t, "0"], width: plus(s.outer, lit(1)).t, height: s.opening.t }], ctx.scope)),
      extrudeFeature(ctx.id("opening"), "Opening", ctx.id("opening-sketch"), { operation: "remove", end: "throughAll" }),
    ];
    if (screw) {
      features.push(
        sketchFeature(ctx.id("hole-sketch"), "Screw hole sketch", right, shapesSketch([{ type: "circle", center: [s.holeAt.t, over(width, 2).t], diameter: hole.t }], ctx.scope)),
        countersunkHoleFeature(ctx.id("hole"), "Screw hole", ctx.id("hole-sketch"), hole, s.countersink),
      );
    }
    return { features, partNames: { [id]: ctx.name } };
  },
  preview: (v) => {
    const s = clipSizes(varsOf(v, VARS));
    const base = num(v, "base");
    const screw = withHole(v);
    const high = s.baseHigh(screw).v;
    const out: PreviewShape[] = [
      { kind: "poly", closed: true, points: [[-base, s.baseLow.v], [0, s.baseLow.v], [0, high], [-base, high]] },
      { kind: "circle", c: [s.cx.v, 0], r: s.outer.v },
      { kind: "circle", c: [s.cx.v, 0], r: s.inner.v },
      { kind: "poly", faint: true, points: [[s.cx.v, -s.opening.v / 2], [s.cx.v + s.outer.v + 1, -s.opening.v / 2]] },
      { kind: "poly", faint: true, points: [[s.cx.v, s.opening.v / 2], [s.cx.v + s.outer.v + 1, s.opening.v / 2]] },
    ];
    if (screw) out.push({ kind: "poly", faint: true, points: [[-base, s.holeAt.v], [0, s.holeAt.v]] });
    return out;
  },
};

/** For tests: the clip's volume (mm³). */
export function clipVolume(v: DesignValues): number {
  const s = clipSizes(varsOf(v, VARS));
  const [, , , w, base, hole] = VARS.map((k) => num(v, k));
  const screw = withHole(v);
  const [R, r, cx, g] = [s.outer.v, s.inner.v, s.cx.v, s.opening.v / 2];
  const rect = base * (s.baseHigh(screw).v - s.baseLow.v);
  // The ring, less the bit of it inside the base, less the opening's share of it.
  const ringArea = Math.PI * (R * R - r * r) - circleSegment(R, cx) - (circleBand(R, g) - circleBand(r, g));
  return (rect + ringArea) * w - (screw ? countersunkHoleVolume(hole, 2 * hole, base) : 0);
}
