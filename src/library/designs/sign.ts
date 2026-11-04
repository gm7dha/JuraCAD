/**
 * A name plate or sign: a plate with words standing up from it (or cut into it), an optional border, and either two
 * countersunk screw holes or a separate foot with a slot that holds it upright on a desk or shelf. The words are
 * ordinary sketch Text on the plate's top face (`textKit`), so they print facing up — no supports — and can be changed
 * in the sketch afterwards like any text.
 */
import { lit, minus, plus, times, type Ex } from "../ex";
import { countersunkHoleFeature, extrudeFeature, roundCorners, shapesSketch, sketchFeature } from "../sketchKit";
import { topFacePlane } from "../printKit";
import { addTextBlock, blockContours, contoursBox, fontInput, fontOf, linesOf, type TextBlock } from "../textKit";
import type { Feature } from "../../model/types";
import type { SketchData } from "../../sketch/types";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { countersunkHoleVolume, mm, num, roundedRect, roundedRectArea } from "./common";
import { wordsInput, wordsProblems } from "./stencil";

const TOP = { kind: "default", name: "Top" } as const;
/** The border: how far in from the edge, and how wide. */
export const BORDER_IN = 3;
export const BORDER_WIDE = 2;
/** Screw holes (for 3.5–4 mm wood screws): across, the countersink, and how far in from the ends (clear of the border). */
export const SIGN_HOLE = { d: 4, head: 8, in: 10 };
/** The stand: how long (a share of the plate's width), deep and high, the slot's depth, and the room each side of the plate in it. */
export const STAND = { share: 0.7, depth: 24, height: 10, slot: 8, room: 0.15, gap: 10 };

const raisedOf = (v: DesignValues) => v.style !== "recessed";
/** The words, in the middle of the room left for them (above the slot, on a plate with a foot). */
const blockOf = (v: DesignValues): TextBlock => {
  const room = wordsRoom(v);
  return { font: fontOf(v), capHeight: num(v, "height"), lines: linesOf(v.words), centre: [0, Math.round(((room[2] + room[3]) / 2) * 1e6) / 1e6] };
};

/** A rounded rectangle centred on the origin (a corner of 0 or less: square). */
function rounded(w: Ex, h: Ex, r: Ex, scope: Record<string, number>, cy: Ex = lit(0)): SketchData {
  return roundCorners(shapesSketch([{ type: "rectangle", center: ["0", cy.t], width: w.t, height: h.t }], scope), r, scope);
}

/** The space the words must stay inside: [left, right, bottom, top] (mm, from the plate's middle). */
export function wordsRoom(v: DesignValues): [number, number, number, number] {
  const [w, h] = [num(v, "width"), num(v, "plate")];
  const edge = v.border === true ? BORDER_IN + BORDER_WIDE + 1.5 : 3;
  let x = w / 2 - edge;
  if (v.mount === "holes") x = Math.min(x, w / 2 - SIGN_HOLE.in - SIGN_HOLE.head / 2 - 1.5);
  const bottom = v.mount === "stand" ? -h / 2 + Math.max(edge, STAND.slot + 1.5) : -h / 2 + edge;
  return [-x, x, bottom, h / 2 - edge];
}

export const sign: LibraryDesign = {
  id: "sign",
  name: "Name plate / sign",
  description:
    "A plate with words standing up from it (or cut into it), for a door, a desk, a shelf label or a workshop sign. Add a border, two countersunk screw holes to fix it up, or a little foot that holds it upright. It prints flat with the words on top, no supports. To make the words a different colour, have your slicer change filament at the layer where they start.",
  category: "print",
  group: "Desk",
  prefix: "sign",
  icon: '<rect x="4" y="12" width="40" height="22" rx="3"/><rect x="7" y="15" width="34" height="16" rx="1.5" opacity=".5"/><path d="M12 28v-10l4 6 4-6v10M25 18v10M29 18h6M32 18v10" opacity=".9"/>',
  inputs: [
    wordsInput("WORKSHOP", { multiline: true, maxLength: 80 }),
    fontInput("bold"),
    { key: "height", label: "Letter height", kind: "length", default: 14, min: 3, max: 150, help: "How tall the capital letters are." },
    {
      key: "style",
      label: "Words",
      kind: "choice",
      default: "raised",
      choices: [
        { value: "raised", label: "Raised (stand up from the plate)" },
        { value: "recessed", label: "Recessed (cut into the plate)" },
      ],
    },
    { key: "width", label: "Plate width", kind: "length", default: 140, min: 20, max: 400, variable: true },
    { key: "plate", label: "Plate height", kind: "length", default: 40, min: 10, max: 300, variable: true },
    { key: "thickness", label: "Plate thickness", kind: "length", default: 3, min: 1.2, max: 20, variable: true },
    { key: "relief", label: "Letter depth", kind: "length", default: 1.2, min: 0.4, max: 10, variable: true, help: "How far the words stand up (or are cut in). 1–1.5 mm reads well." },
    { key: "corner", label: "Corner rounding", kind: "length", default: 8, min: 0, max: 100, variable: true },
    { key: "border", label: "Border", kind: "toggle", default: true, help: "A thin frame round the edge, raised or cut in like the words." },
    {
      key: "mount",
      label: "Fixing",
      kind: "choice",
      default: "none",
      choices: [
        { value: "none", label: "None (glue or tape)" },
        { value: "holes", label: "Two screw holes" },
        { value: "stand", label: "A foot to stand it up" },
      ],
    },
  ],
  problems: (v) => {
    const out = wordsProblems(v);
    const [w, h, t, relief, corner] = ["width", "plate", "thickness", "relief", "corner"].map((k) => num(v, k));
    if (corner * 2 > Math.min(w, h)) out.push(`The corner rounding must be at most half the plate's smaller side (${mm(Math.min(w, h) / 2)}).`);
    if (!raisedOf(v) && relief > t - 0.6) out.push(`Recessed words must be at least 0.6 mm shallower than the plate is thick: make the letter depth at most ${mm(t - 0.6)}.`);
    if (v.mount === "holes" && t < SIGN_HOLE.head / 2 - SIGN_HOLE.d / 2 + 0.8) out.push(`A plate for countersunk screws must be at least ${mm(SIGN_HOLE.head / 2 - SIGN_HOLE.d / 2 + 0.8)} thick.`);
    if (v.mount === "holes" && w < 2 * (SIGN_HOLE.in + SIGN_HOLE.head) + 10) out.push(`The plate is too narrow for two screw holes: make it at least ${mm(2 * (SIGN_HOLE.in + SIGN_HOLE.head) + 10)} wide.`);
    if (v.border === true && corner > 0 && corner <= BORDER_IN + BORDER_WIDE) out.push(`With a border, round the corners more than ${mm(BORDER_IN + BORDER_WIDE)} (or not at all).`);
    if (v.mount === "stand" && h < STAND.slot + 10) out.push(`The plate must be at least ${mm(STAND.slot + 10)} high to stand in its foot.`);
    if (!out.length) {
      const box = contoursBox(blockContours(blockOf(v)));
      const room = wordsRoom(v);
      if (box && (box[0] < room[0] || box[2] > room[1] || box[1] < room[2] || box[3] > room[3]))
        out.push(`The words don't fit on the plate: make the letters smaller, or the plate bigger (the words are ${mm(box[2] - box[0])} × ${mm(box[3] - box[1])}).`);
    }
    return out;
  },
  summary: (v) => {
    const box = contoursBox(blockContours(blockOf(v)));
    const parts = v.mount === "stand" ? "2 parts: the plate and its foot." : "1 part.";
    return `${parts} The words are ${box ? `${mm(box[2] - box[0])} wide, ` : ""}${raisedOf(v) ? "standing" : "cut"} ${mm(num(v, "relief"))} ${raisedOf(v) ? "up" : "in"}.`;
  },
  make: (ctx) => {
    const v = ctx.values;
    const { width, plate, thickness, relief, corner } = ctx.vars;
    const id = ctx.id("plate");
    const face = topFacePlane("Plate top", id, thickness, [0, 0], [0.5, 0.5, 1]);
    // The words (and the border's two outlines) on the plate's top face: their even–odd shapes are the ring and the letters.
    let words: SketchData = { points: [], curves: [], constraints: [] };
    if (v.border === true) {
      const outerIn = lit(2 * BORDER_IN);
      const innerIn = lit(2 * (BORDER_IN + BORDER_WIDE));
      const outer = rounded(minus(width, outerIn), minus(plate, outerIn), corner.v > 0 ? minus(corner, lit(BORDER_IN)) : lit(0), ctx.scope);
      const inner = rounded(minus(width, innerIn), minus(plate, innerIn), corner.v > 0 ? minus(corner, lit(BORDER_IN + BORDER_WIDE)) : lit(0), ctx.scope);
      words = { points: [...outer.points, ...inner.points], curves: [...outer.curves, ...inner.curves], constraints: [...outer.constraints, ...inner.constraints] };
    }
    words = addTextBlock(words, blockOf(v));
    const features: Feature[] = [
      sketchFeature(ctx.id("plate-sketch"), "Plate sketch", TOP, rounded(width, plate, corner, ctx.scope)),
      extrudeFeature(id, "Plate", ctx.id("plate-sketch"), { depth: thickness, operation: "new" }),
      sketchFeature(ctx.id("words-sketch"), "Words sketch", face, words),
      raisedOf(v)
        ? extrudeFeature(ctx.id("words"), "Raised words", ctx.id("words-sketch"), { depth: relief, operation: "add" })
        : extrudeFeature(ctx.id("words"), "Cut-in words", ctx.id("words-sketch"), { depth: relief, operation: "remove", flip: true }),
    ];
    const partNames: Record<string, string> = { [id]: ctx.name };
    if (v.mount === "holes") {
      const x = minus(times(width, 0.5), lit(SIGN_HOLE.in));
      const holes = [x, minus(lit(0), x)].map((cx) => ({ type: "circle", center: [cx.t, "0"], diameter: String(SIGN_HOLE.d) }));
      features.push(
        sketchFeature(ctx.id("holes-sketch"), "Screw holes sketch", topFacePlane("Plate top", id, thickness, [0, 0], [0.5, 0.5, 1]), shapesSketch(holes, ctx.scope)),
        countersunkHoleFeature(ctx.id("holes"), "Screw holes", ctx.id("holes-sketch"), lit(SIGN_HOLE.d), lit(SIGN_HOLE.head)),
      );
    }
    if (v.mount === "stand") {
      const foot = ctx.id("foot");
      const at = minus(lit(0), plus(times(plate, 0.5), lit(STAND.gap + STAND.depth / 2)));
      const slot = plus(thickness, raisedOf(v) ? relief : lit(0), lit(2 * STAND.room));
      features.push(
        sketchFeature(ctx.id("foot-sketch"), "Foot sketch", TOP, rounded(times(width, STAND.share), lit(STAND.depth), lit(3), ctx.scope, at)),
        extrudeFeature(foot, "Foot", ctx.id("foot-sketch"), { depth: lit(STAND.height), operation: "new" }),
        sketchFeature(
          ctx.id("slot-sketch"),
          "Slot sketch",
          topFacePlane("Foot top", foot, lit(STAND.height), [0, at.v], [0.5, 0.5, 1]),
          shapesSketch([{ type: "rectangle", center: ["0", at.t], width: plus(times(width, STAND.share), lit(2)).t, height: slot.t }], ctx.scope),
        ),
        extrudeFeature(ctx.id("slot"), "Slot", ctx.id("slot-sketch"), { depth: lit(STAND.slot), operation: "remove", flip: true }),
      );
      partNames[foot] = `${ctx.name} foot`;
    }
    return { features, partNames };
  },
  preview: (v) => {
    const [w, h, corner] = [num(v, "width"), num(v, "plate"), num(v, "corner")];
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: roundedRect(w, h, corner) }];
    if (v.border === true) {
      out.push({ kind: "poly", closed: true, faint: true, points: roundedRect(w - 2 * BORDER_IN, h - 2 * BORDER_IN, Math.max(0, corner - BORDER_IN)) });
      out.push({ kind: "poly", closed: true, faint: true, points: roundedRect(w - 2 * (BORDER_IN + BORDER_WIDE), h - 2 * (BORDER_IN + BORDER_WIDE), Math.max(0, corner - BORDER_IN - BORDER_WIDE)) });
    }
    for (const c of blockContours(blockOf(v))) out.push({ kind: "poly", closed: true, points: c });
    if (v.mount === "holes") for (const s of [-1, 1]) out.push({ kind: "circle", c: [s * (w / 2 - SIGN_HOLE.in), 0], r: SIGN_HOLE.d / 2 }, { kind: "circle", c: [s * (w / 2 - SIGN_HOLE.in), 0], r: SIGN_HOLE.head / 2, faint: true });
    if (v.mount === "stand") out.push({ kind: "poly", closed: true, faint: true, points: roundedRect(w * STAND.share, STAND.depth, 3, 0, -(h / 2 + STAND.gap + STAND.depth / 2)) });
    return out;
  },
};

/** For tests: the plate's volume (and the foot's), given the letters' area (mm², from their outlines). */
export function signVolumes(v: DesignValues, ink: number): { plate: number; foot: number } {
  const [w, h, t, relief, corner] = ["width", "plate", "thickness", "relief", "corner"].map((k) => num(v, k));
  let ring = 0;
  if (v.border === true) ring = roundedRectArea(w - 2 * BORDER_IN, h - 2 * BORDER_IN, Math.max(0, corner - BORDER_IN)) - roundedRectArea(w - 2 * (BORDER_IN + BORDER_WIDE), h - 2 * (BORDER_IN + BORDER_WIDE), Math.max(0, corner - BORDER_IN - BORDER_WIDE));
  let plate = roundedRectArea(w, h, corner) * t + (raisedOf(v) ? 1 : -1) * (ink + ring) * relief;
  if (v.mount === "holes") plate -= 2 * countersunkHoleVolume(SIGN_HOLE.d, SIGN_HOLE.head, t);
  let foot = 0;
  if (v.mount === "stand") {
    const L = w * STAND.share;
    foot = roundedRectArea(L, STAND.depth, 3) * STAND.height - L * (t + (raisedOf(v) ? relief : 0) + 2 * STAND.room) * STAND.slot;
  }
  return { plate, foot };
}
