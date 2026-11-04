/** A printable box with a separate lid that fits over it, for 3D printing. */
import { DEFAULT_FITS } from "../../model/printSettings";
import { lit, minus, plus, times, ZERO, type Ex } from "../ex";
import { extrudeFeature, moveFeature, roundCorners, shapesSketch, sketchFeature } from "../sketchKit";
import type { Feature } from "../../model/types";
import type { SketchData } from "../../sketch/types";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { mm, num, roundedRect, roundedRectArea, varsOf } from "./common";

const VARS = ["width", "depth", "height", "wall", "lid", "clearance", "radius"];
/** The space between the box and the lid when the lid is shown beside it (mm). */
export const LID_GAP = 10;

/** A rectangle centred on (cx, 0), its corners rounded (radius 0 or less: square). */
function rounded(cx: Ex, w: Ex, d: Ex, r: Ex, scope: Record<string, number>): SketchData {
  return roundCorners(shapesSketch([{ type: "rectangle", center: [cx.t, "0"], width: w.t, height: d.t }], scope), r, scope);
}

const ring = (a: SketchData, b: SketchData): SketchData => ({ points: [...a.points, ...b.points], curves: [...a.curves, ...b.curves], constraints: [...a.constraints, ...b.constraints] });

/** Every size of the box and its lid, worked out from the inputs (as expressions when they're variables). */
export function boxLidSizes(vars: Record<string, Ex>) {
  const { width, depth, wall, clearance: c, radius } = vars;
  const twoWalls = times(wall, 2);
  const twoGaps = times(c, 2);
  return {
    /** The lid's inside: the box's outside plus the clearance all round. */
    lidInner: { w: plus(width, twoGaps), d: plus(depth, twoGaps), r: plus(radius, c) },
    lidOuter: { w: plus(width, twoGaps, twoWalls), d: plus(depth, twoGaps, twoWalls), r: plus(radius, c, wall) },
    boxInner: { w: minus(width, twoWalls), d: minus(depth, twoWalls), r: minus(radius, wall) },
    /** Where the lid's middle is when it's shown beside the box. */
    besideAt: plus(width, c, wall, lit(LID_GAP)),
  };
}

export const boxLid: LibraryDesign = {
  id: "box-lid",
  name: "Box with lid",
  description:
    "A box with rounded corners and a separate lid that slips over the top. The lid is shown beside the box, upside down, ready to print — both print flat with no supports. The gap round the lid is the printed snug fit.",
  category: "print",
  group: "Storage",
  prefix: "lidbox",
  icon: '<path d="M8 24c0-2 1-3 3-3h18c2 0 3 1 3 3v12c0 2-1 3-3 3H11c-2 0-3-1-3-3z"/><path d="M6 15c0-2 1-3 3-3h22c2 0 3 1 3 3v3H6z" opacity=".55"/><path d="M36 30h6v9h-6z" opacity=".55"/>',
  inputs: [
    { key: "width", label: "Width", kind: "length", default: 80, min: 10, max: 1000, variable: true, help: "The box's outside, left to right." },
    { key: "depth", label: "Depth", kind: "length", default: 60, min: 10, max: 1000, variable: true, help: "The box's outside, front to back." },
    { key: "height", label: "Height", kind: "length", default: 40, min: 5, max: 1000, variable: true, help: "The box without its lid." },
    { key: "wall", label: "Wall thickness", kind: "length", default: 2, min: 0.8, max: 20, variable: true, help: "Walls, floor and the lid's top. 2 mm is sturdy with a 0.4 mm nozzle." },
    { key: "lid", label: "Lid height", kind: "length", default: 12, min: 2, max: 1000, variable: true, help: "How tall the lid is, its top included." },
    {
      key: "clearance",
      label: "Fit clearance",
      kind: "length",
      default: DEFAULT_FITS.snug,
      min: 0.1,
      max: 2,
      variable: true,
      help: `The gap between the box and the lid on each side. ${DEFAULT_FITS.snug} mm is a snug fit; try ${DEFAULT_FITS.sliding}–${DEFAULT_FITS.loose} mm if it's too tight.`,
    },
    { key: "radius", label: "Corner radius", kind: "length", default: 5, min: 0, max: 500, variable: true, help: "The box's outside corners. 0 for square corners." },
    {
      key: "placement",
      label: "Lid",
      kind: "choice",
      default: "beside",
      choices: [
        { value: "beside", label: "Beside the box, ready to print" },
        { value: "on", label: "Sitting on the box" },
      ],
      help: "Sitting on the box shows how they go together; put it beside the box again before printing.",
    },
  ],
  problems: (v) => {
    const [w, d, h, wall, lid, , r] = VARS.map((k) => num(v, k));
    const out: string[] = [];
    const small = Math.min(w, d);
    if (wall * 2 >= small - 2) out.push(`The walls are too thick for a box ${mm(small)} across: make them less than ${mm((small - 2) / 2)}.`);
    if (wall >= h - 1) out.push(`The box must be taller than its floor: make it more than ${mm(wall + 1)} high.`);
    if (lid <= wall + 1) out.push(`The lid must be taller than its top (${mm(wall)}): make it at least ${mm(wall + 1)}, so it has sides that go over the box.`);
    if (lid - wall >= h) out.push(`The lid's sides (${mm(lid - wall)}) must be shorter than the box is high (${mm(h)}).`);
    if (r * 2 >= small) out.push(`The corner radius must be less than half the smaller side (${mm(small / 2)}).`);
    return out;
  },
  summary: (v) => {
    const s = boxLidSizes(varsOf(v, VARS));
    return `2 parts. The lid is ${mm(s.lidOuter.w.v)} × ${mm(s.lidOuter.d.v)} outside, ${mm(s.lidInner.w.v)} × ${mm(s.lidInner.d.v)} inside.`;
  },
  make: (ctx) => {
    const { width, depth, height, wall, lid, radius } = ctx.vars;
    const s = boxLidSizes(ctx.vars);
    const top = { kind: "default", name: "Top" } as const;
    const on = ctx.values.placement === "on";
    // The lid is made upside down (its top on the bed), beside the box or — to be turned over — on the origin.
    const at = on ? ZERO : s.besideAt;
    const boxOuter = rounded(ZERO, width, depth, radius, ctx.scope);
    const boxInner = rounded(ZERO, s.boxInner.w, s.boxInner.d, s.boxInner.r, ctx.scope);
    const lidOuter = rounded(at, s.lidOuter.w, s.lidOuter.d, s.lidOuter.r, ctx.scope);
    const lidInner = rounded(at, s.lidInner.w, s.lidInner.d, s.lidInner.r, ctx.scope);
    const box = ctx.id("box");
    const lidId = ctx.id("lid");
    const features: Feature[] = [
      sketchFeature(ctx.id("floor-sketch"), "Box floor sketch", top, boxOuter),
      extrudeFeature(box, "Box floor", ctx.id("floor-sketch"), { depth: wall, operation: "new" }),
      sketchFeature(ctx.id("walls-sketch"), "Box walls sketch", top, ring(boxOuter, boxInner)),
      extrudeFeature(ctx.id("walls"), "Box walls", ctx.id("walls-sketch"), { depth: height, operation: "add" }),
      sketchFeature(ctx.id("lid-top-sketch"), "Lid top sketch", top, lidOuter),
      extrudeFeature(lidId, "Lid top", ctx.id("lid-top-sketch"), { depth: wall, operation: "new" }),
      sketchFeature(ctx.id("lid-sides-sketch"), "Lid sides sketch", top, ring(lidOuter, lidInner)),
      extrudeFeature(ctx.id("lid-sides"), "Lid sides", ctx.id("lid-sides-sketch"), { depth: lid, operation: "add" }),
    ];
    // Turned over and lowered onto the box: its top's underside rests on the box's rim.
    if (on) features.push(moveFeature(ctx.id("lid-on"), "Lid on the box", lidId, { rx: lit(180), dz: plus(minus(height, lid), wall) }));
    return { features, partNames: { [box]: `${ctx.name}: box`, [lidId]: `${ctx.name}: lid` } };
  },
  preview: (v: DesignValues) => {
    const vars = varsOf(v, VARS);
    const s = boxLidSizes(vars);
    const [w, d, h, wall, lid, , r] = VARS.map((k) => num(v, k));
    const x = s.besideAt.v;
    const out: PreviewShape[] = [
      { kind: "poly", closed: true, points: roundedRect(w, d, r) },
      { kind: "poly", closed: true, faint: true, points: roundedRect(w - 2 * wall, d - 2 * wall, r - wall) },
      { kind: "poly", closed: true, points: roundedRect(s.lidOuter.w.v, s.lidOuter.d.v, s.lidOuter.r.v, x) },
      { kind: "poly", closed: true, faint: true, points: roundedRect(s.lidInner.w.v, s.lidInner.d.v, s.lidInner.r.v, x) },
    ];
    const below = -Math.max(s.lidOuter.d.v, w) / 2 - Math.max(w, d) * 0.1;
    out.push({ kind: "text", at: [0, below], text: `box, ${mm(h)} high` }, { kind: "text", at: [x, below], text: `lid, ${mm(lid)} high` });
    return out;
  },
};

/** For tests: the volume of the box and of the lid (mm³). */
export function boxLidVolumes(v: DesignValues): { box: number; lid: number } {
  const s = boxLidSizes(varsOf(v, VARS));
  const [w, d, h, wall, lid, , r] = VARS.map((k) => num(v, k));
  const area = (x: { w: Ex; d: Ex; r: Ex }) => roundedRectArea(x.w.v, x.d.v, Math.max(0, x.r.v));
  const outer = roundedRectArea(w, d, r);
  const inner = area(s.boxInner);
  const lidOuter = area(s.lidOuter);
  return { box: outer * wall + (outer - inner) * (h - wall), lid: lidOuter * wall + (lidOuter - area(s.lidInner)) * (lid - wall) };
}

