/**
 * A knurled thumb knob that a hex nut or a bolt's hex head presses into: a round knob with fine grip notches round its
 * edge, a clear hole for the screw right through, and a hex pocket in its top as wide as the nut (across the flats,
 * from the fastener table) plus a press fit. Push a nut in for a knob that screws onto a threaded rod or bolt, or a
 * bolt head-first for a thumb screw. The pocket opens upwards, so it prints cleanly without supports.
 */
import { lit, plus, times } from "../ex";
import { circularPatternFeature, extrudeFeature, shapesSketch, sketchFeature } from "../sketchKit";
import { topFacePlane } from "../printKit";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { acrossCorners, hexArea, PRINT_SIZES, printFastener } from "./boltSizes";
import { mm, num } from "./common";
import { lensArea } from "./knob";

/** The sizes offered: M3 to M8. */
export const KNOB_SIZES = PRINT_SIZES.filter((s) => Number(s.slice(1)) <= 8);
/** Grip notches: across, and about how far apart round the edge (mm). */
export const KNURL = { d: 2.4, pitch: 4 };
/** How much bigger the screw's hole is than the screw (mm, across). */
export const SCREW_ROOM = 0.4;

const sizeOf = (v: DesignValues) => printFastener(String(v.size));
/** How many notches round a knob of this diameter. */
export const knurlCount = (d: number) => Math.max(8, Math.min(90, Math.round((Math.PI * d) / KNURL.pitch)));
/** How deep the pocket is: the nut's or the head's height (from the fastener table). */
export const pocketDepth = (v: DesignValues) => (v.holds === "head" ? sizeOf(v).head : sizeOf(v).nut);

export const thumbKnob: LibraryDesign = {
  id: "thumb-knob",
  name: "Knurled thumb knob",
  description:
    "A grippy knob with a hex pocket that a nut (or a bolt's head) presses into — for jigs, clamps, a printer's bed screws or anything you tighten by hand. The pocket is the nut's size from the standard plus a press fit, so it stays put; a drop of glue makes it permanent. It prints pocket up, no supports. Press the nut in with a vice or a gentle tap.",
  category: "print",
  group: "Fixings",
  prefix: "thumb",
  icon: '<circle cx="24" cy="24" r="16"/><path d="M24 15l7.8 4.5v9L24 33l-7.8-4.5v-9z" opacity=".6"/><circle cx="24" cy="24" r="3.2"/>',
  inputs: [
    { key: "size", label: "Screw size", kind: "choice", default: "M5", choices: KNOB_SIZES.map((s) => ({ value: s, label: s })) },
    {
      key: "holds",
      label: "Takes",
      kind: "choice",
      default: "nut",
      choices: [
        { value: "nut", label: "A hex nut (a knob)" },
        { value: "head", label: "A bolt's hex head (a thumb screw)" },
      ],
    },
    { key: "diameter", label: "Knob diameter", kind: "length", default: 28, min: 10, max: 120 },
    { key: "height", label: "Knob height", kind: "length", default: 10, min: 4, max: 60, variable: true },
    { key: "fit", label: "Press fit", kind: "length", default: 0.1, min: 0, max: 0.5, variable: true, help: "How much bigger the pocket is than the nut, each side. 0.1 mm presses in snugly; more if it's too tight." },
  ],
  problems: (v) => {
    const f = sizeOf(v);
    const out: string[] = [];
    const D = num(v, "diameter");
    const need = acrossCorners(f.flats + 2 * num(v, "fit")) + 2 * 2 + KNURL.d;
    if (D < need) out.push(`An ${f.name} ${v.holds === "head" ? "head" : "nut"} needs a knob at least ${mm(Math.ceil(need))} across.`);
    if (num(v, "height") < pocketDepth(v) + 1.2) out.push(`The knob must be at least ${mm(pocketDepth(v) + 1.2)} tall to hold the ${v.holds === "head" ? "head" : "nut"} with a floor under it.`);
    return out;
  },
  summary: (v) => {
    const f = sizeOf(v);
    return `A ${mm(num(v, "diameter"))} knob with ${knurlCount(num(v, "diameter"))} grip notches. The pocket is ${mm(f.flats + 2 * num(v, "fit"))} across the flats and ${mm(pocketDepth(v))} deep, for an ${f.name} ${v.holds === "head" ? "bolt head" : "nut"} (${mm(f.flats)}).`;
  },
  make: (ctx) => {
    const f = sizeOf(ctx.values);
    const { height, fit } = ctx.vars;
    const D = num(ctx.values, "diameter");
    const top = { kind: "default", name: "Top" } as const;
    const id = ctx.id("knob");
    const depth = lit(pocketDepth(ctx.values));
    return {
      features: [
        sketchFeature(ctx.id("body-sketch"), "Knob sketch", top, shapesSketch([{ type: "circle", center: ["0", "0"], diameter: String(D) }], ctx.scope)),
        extrudeFeature(id, "Knob", ctx.id("body-sketch"), { depth: height, operation: "new" }),
        sketchFeature(ctx.id("notch-sketch"), "Grip notch sketch", top, shapesSketch([{ type: "circle", center: [String(D / 2), "0"], diameter: String(KNURL.d) }], ctx.scope)),
        extrudeFeature(ctx.id("notch"), "Grip notch", ctx.id("notch-sketch"), { operation: "remove", end: "throughAll" }),
        circularPatternFeature(ctx.id("notches"), "Grip notches", [ctx.id("notch")], lit(knurlCount(D))),
        sketchFeature(ctx.id("hole-sketch"), "Screw hole sketch", top, shapesSketch([{ type: "circle", center: ["0", "0"], diameter: String(f.d + SCREW_ROOM) }], ctx.scope)),
        extrudeFeature(ctx.id("hole"), "Screw hole", ctx.id("hole-sketch"), { depth: plus(height, lit(1)), operation: "remove" }),
        sketchFeature(
          ctx.id("pocket-sketch"),
          "Pocket sketch",
          topFacePlane("Knob top", id, height, [0, 0], [0.5, 0.5, 1]),
          shapesSketch([{ type: "polygon", center: ["0", "0"], sides: 6, diameter: plus(lit(f.flats), times(fit, 2)).t, across: "flats" }], ctx.scope),
        ),
        extrudeFeature(ctx.id("pocket"), `${f.name} ${ctx.values.holds === "head" ? "head" : "nut"} pocket`, ctx.id("pocket-sketch"), { depth, operation: "remove", flip: true }),
      ],
      partNames: { [id]: `${ctx.name} ${f.name}` },
    };
  },
  preview: (v) => {
    const f = sizeOf(v);
    const D = num(v, "diameter");
    const n = knurlCount(D);
    const out: PreviewShape[] = [{ kind: "circle", c: [0, 0], r: D / 2 }];
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      out.push({ kind: "circle", c: [(D / 2) * Math.cos(a), (D / 2) * Math.sin(a)], r: KNURL.d / 2, faint: true });
    }
    const r = acrossCorners(f.flats + 2 * num(v, "fit")) / 2;
    out.push({ kind: "poly", closed: true, points: Array.from({ length: 6 }, (_, i): [number, number] => [r * Math.cos((Math.PI / 3) * i), r * Math.sin((Math.PI / 3) * i)]) });
    out.push({ kind: "circle", c: [0, 0], r: (f.d + SCREW_ROOM) / 2 });
    return out;
  },
};

/** For tests: the knob's volume (mm³). */
export function thumbKnobVolume(v: DesignValues): number {
  const f = sizeOf(v);
  const D = num(v, "diameter");
  const H = num(v, "height");
  const depth = pocketDepth(v);
  const hole = Math.PI * ((f.d + SCREW_ROOM) / 2) ** 2;
  return (Math.PI * (D / 2) ** 2 - knurlCount(D) * lensArea(D / 2, KNURL.d / 2, D / 2)) * H - hole * (H - depth) - hexArea(f.flats + 2 * num(v, "fit")) * depth;
}
