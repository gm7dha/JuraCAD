/**
 * A wall pocket for a phone or a remote control: a back plate screwed to the wall with two countersunk screws above
 * the pocket, and an open-topped pocket in front, lower at the front so you can see the phone and lift it out — with
 * an optional slot in the floor for a charging cable. It prints standing as it hangs (pocket floor on the bed), so the
 * pocket is open at the top and needs no supports; the screw holes print sideways as small round holes.
 *
 * The back plate lies behind the Front plane (y = −plate…0), the pocket in front of it (y = 0…depth + wall); its holes
 * are drilled from the Front plane (the plate's front face) back into the plate, so the countersinks face the room.
 */
import { lit, minus, neg, plus, times, ZERO, type Ex } from "../ex";
import { countersunkHoleFeature, extrudeFeature, shapesSketch, sketchFeature } from "../sketchKit";
import type { DesignValues, LibraryDesign, MakeContext, PreviewShape } from "../types";
import { countersunkHoleVolume, mm, num, roundedRect } from "./common";
import { CLEAT_SCREW } from "./frenchCleat";

const TOP = { kind: "default", name: "Top" } as const;
const FRONT = { kind: "default", name: "Front" } as const;
/** The cable slot in the floor: how long (left to right) and, at most, how wide. */
export const CABLE_SLOT = { length: 16, width: 8 };
/** The screw holes: how far in from each side of the plate. */
export const POCKET_SCREW_IN = 10;

const VARS = ["width", "depth", "front", "back", "wall", "plate"];

function makePocket(ctx: MakeContext) {
  const { width, depth, front, back, wall, plate } = ctx.vars;
  const id = ctx.id("pocket");
  const outerW = plus(width, times(wall, 2));
  const rect = (x0: Ex, y0: Ex, w: Ex, h: Ex) => ({ type: "rectangle", corner: [x0.t, y0.t], width: w.t, height: h.t });
  const left = neg(times(outerW, 0.5));
  const outer = rect(left, neg(plate), outerW, plus(plate, depth, wall));
  const holeX = minus(times(outerW, 0.5), lit(POCKET_SCREW_IN));
  const holeZ = times(plus(front, back), 0.5);
  const drill = countersunkHoleFeature(ctx.id("screws"), "Screw holes", ctx.id("screws-sketch"), lit(CLEAT_SCREW.d), lit(CLEAT_SCREW.head));
  const features = [
    sketchFeature(ctx.id("plate-sketch"), "Back plate sketch", TOP, shapesSketch([rect(left, neg(plate), outerW, plate)], ctx.scope)),
    extrudeFeature(id, "Back plate", ctx.id("plate-sketch"), { depth: back, operation: "new" }),
    // Drilled from the plate's front face back towards the wall (the Front plane faces the wall, so flipped).
    sketchFeature(ctx.id("screws-sketch"), "Screw holes sketch", FRONT, shapesSketch([holeX, neg(holeX)].map((x) => ({ type: "circle", center: [x.t, holeZ.t], diameter: String(CLEAT_SCREW.d) })), ctx.scope)),
    { ...drill, hole: { ...drill.hole!, flip: true } },
    sketchFeature(ctx.id("floor-sketch"), "Pocket floor sketch", TOP, shapesSketch([outer], ctx.scope)),
    extrudeFeature(ctx.id("floor"), "Pocket floor", ctx.id("floor-sketch"), { depth: wall, operation: "add" }),
    sketchFeature(ctx.id("walls-sketch"), "Pocket walls sketch", TOP, shapesSketch([outer, rect(neg(times(width, 0.5)), ZERO, width, depth)], ctx.scope)),
    extrudeFeature(ctx.id("walls"), "Pocket walls", ctx.id("walls-sketch"), { depth: front, operation: "add" }),
  ];
  if (ctx.values.cable === true) {
    const w = slotWidth(ctx.values);
    const half = (CABLE_SLOT.length - w) / 2;
    features.push(
      sketchFeature(ctx.id("slot-sketch"), "Cable slot sketch", TOP, shapesSketch([{ type: "slot", from: [String(-half), times(depth, 0.5).t], to: [String(half), times(depth, 0.5).t], width: String(w) }], ctx.scope)),
      extrudeFeature(ctx.id("slot"), "Cable slot", ctx.id("slot-sketch"), { depth: plus(wall, lit(1)), operation: "remove" }),
    );
  }
  return { features, partNames: { [id]: ctx.name } };
}

/** The cable slot's width: 8 mm, or less in a shallow pocket (2 mm of floor each side). */
export const slotWidth = (v: DesignValues) => Math.min(CABLE_SLOT.width, num(v, "depth") - 4);

export const wallPocket: LibraryDesign = {
  id: "wall-pocket",
  name: "Wall pocket for a phone or remote",
  description:
    "A pocket that screws to the wall to keep a phone, a TV remote or glasses handy: a back plate with two countersunk screw holes above the pocket, and the front lower so things lift out easily. Add a slot in the floor for a charging cable. It prints standing up as it hangs, no supports.",
  category: "print",
  group: "Household",
  prefix: "pocket",
  icon: '<rect x="8" y="4" width="32" height="40" rx="2" opacity=".55"/><rect x="11" y="22" width="26" height="20" rx="1.5"/><circle cx="14" cy="12" r="2"/><circle cx="34" cy="12" r="2"/><path d="M21 42h6" opacity=".9"/>',
  inputs: [
    { key: "width", label: "Inside width", kind: "length", default: 82, min: 25, max: 300, variable: true, help: "A phone is about 75–80 mm wide; a remote 45–60 mm." },
    { key: "depth", label: "Inside depth", kind: "length", default: 16, min: 8, max: 150, variable: true, help: "Front to back: a phone in a case is about 12 mm thick, a remote 20–25 mm." },
    { key: "front", label: "Pocket height", kind: "length", default: 60, min: 15, max: 300, variable: true, help: "The front wall's height." },
    { key: "back", label: "Back plate height", kind: "length", default: 100, min: 30, max: 400, variable: true, help: "The screws go between the pocket and the top." },
    { key: "wall", label: "Wall thickness", kind: "length", default: 2, min: 1.2, max: 10, variable: true },
    { key: "plate", label: "Back plate thickness", kind: "length", default: 4, min: 3.5, max: 15, variable: true, help: "Thick enough for the screws' countersinks." },
    { key: "cable", label: "Cable slot", kind: "toggle", default: true, help: "A slot in the floor for a charging cable." },
  ],
  problems: (v) => {
    const [W, D, front, back] = VARS.map((k) => num(v, k));
    const out: string[] = [];
    if (back < front + CLEAT_SCREW.head + 6) out.push(`The back plate must be at least ${mm(front + CLEAT_SCREW.head + 6)} high, to have room for the screws above the pocket.`);
    if (W + 2 * num(v, "wall") < 2 * (POCKET_SCREW_IN + CLEAT_SCREW.head / 2) + 4) out.push(`Make it at least ${mm(2 * (POCKET_SCREW_IN + CLEAT_SCREW.head / 2) + 4 - 2 * num(v, "wall"))} wide inside, for two screws.`);
    if (v.cable === true && (D < 8 || W < CABLE_SLOT.length + 4)) out.push("The pocket is too small for a cable slot: make it bigger, or turn the slot off.");
    if (front <= num(v, "wall") + 5) out.push(`The pocket must be at least ${mm(num(v, "wall") + 5)} high.`);
    return out;
  },
  summary: (v) => `1 part: a pocket ${mm(num(v, "width"))} × ${mm(num(v, "depth"))} inside, ${mm(num(v, "front"))} high at the front, on a back plate ${mm(num(v, "back"))} high with two screw holes for 4 mm screws.`,
  make: makePocket,
  preview: (v) => {
    // Seen from the front.
    const [W, , front, back, wall] = VARS.map((k) => num(v, k));
    const Wo = W + 2 * wall;
    const out: PreviewShape[] = [
      { kind: "poly", closed: true, faint: true, points: roundedRect(Wo, back, 0, 0, back / 2) },
      { kind: "poly", closed: true, points: roundedRect(Wo, front, 0, 0, front / 2) },
    ];
    for (const s of [-1, 1]) out.push({ kind: "circle", c: [s * (Wo / 2 - POCKET_SCREW_IN), (front + back) / 2], r: CLEAT_SCREW.d / 2 }, { kind: "circle", c: [s * (Wo / 2 - POCKET_SCREW_IN), (front + back) / 2], r: CLEAT_SCREW.head / 2, faint: true });
    out.push({ kind: "text", at: [0, -8], text: "seen from the front" });
    return out;
  },
};

/** For tests: its volume (mm³). */
export function pocketVolume(v: DesignValues): number {
  const [W, D, front, back, wall, plate] = VARS.map((k) => num(v, k));
  const Wo = W + 2 * wall;
  let vol = Wo * plate * back - 2 * countersunkHoleVolume(CLEAT_SCREW.d, CLEAT_SCREW.head, plate) + Wo * (D + wall) * wall + (Wo * (D + wall) - W * D) * (front - wall);
  if (v.cable === true) {
    const w = slotWidth(v);
    vol -= ((CABLE_SLOT.length - w) * w + (Math.PI * w * w) / 4) * wall;
  }
  return vol;
}
