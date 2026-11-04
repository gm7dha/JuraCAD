/**
 * Rubber stamps. The words (and a border, if wanted) are drawn mirrored, so
 * the printed stamp reads the right way.
 *
 * Laser: a plate of stamp rubber. Its "Stamp sketch" holds the outline, the
 * border (two outlines) and the words; Export for laser engraves its
 * background — everything inside the outline except the border and letters —
 * and cuts the outline (the design's laser setting, `background`). The 3D
 * plate shows the same: the background is cut away `relief` deep from its top
 * face, the sketch's own even–odd shapes (outline minus border, inside the
 * border minus letters, the letters' holes).
 *
 * 3D printing: a block with the border and letters raised on top, and a round
 * handle printed beside it to glue on the back.
 */
import { lit, over, plus, type Ex } from "../ex";
import { extrudeFeature, shapesSketch, sketchFeature } from "../sketchKit";
import { addTextBlock, blockContours, contoursBox, fontInput, fontOf, linesOf, type TextBlock } from "../textKit";
import type { DesignInput, DesignValues, LibraryDesign, MakeContext, PreviewShape } from "../types";
import { mm, num, roundedRect } from "./common";
import { wordsInput, wordsProblems } from "./stencil";
import type { SketchData } from "../../sketch/types";

const TOP = { kind: "default", name: "Top" } as const;
type P2 = [number, number];

const shapeInput: DesignInput = {
  key: "shape",
  label: "Shape",
  kind: "choice",
  default: "rectangle",
  choices: [
    { value: "rectangle", label: "Rectangle" },
    { value: "round", label: "Round" },
  ],
};

const sharedInputs: DesignInput[] = [
  wordsInput("MADE BY\nHAND", { multiline: true, maxLength: 120 }),
  fontInput("bold"),
  { key: "height", label: "Letter height", kind: "length", default: 6, min: 1.5, max: 80, help: "How tall the capital letters are." },
  shapeInput,
  { key: "width", label: "Stamp width", kind: "length", default: 50, min: 10, max: 300, help: "A round stamp's diameter." },
  { key: "depth", label: "Stamp height", kind: "length", default: 25, min: 10, max: 300, help: "Top to bottom (not used for a round stamp)." },
  { key: "border", label: "Border", kind: "toggle", default: true },
  { key: "line", label: "Border line width", kind: "length", default: 1.2, min: 0.4, max: 10 },
  { key: "edge", label: "Space round the edge", kind: "length", default: 2, min: 0.5, max: 30, help: "Between the outline and the border." },
];

const round = (v: DesignValues) => v.shape === "round";
const sizeOf = (v: DesignValues): P2 => (round(v) ? [num(v, "width"), num(v, "width")] : [num(v, "width"), num(v, "depth")]);
const blockOf = (v: DesignValues): TextBlock => ({ font: fontOf(v), capHeight: num(v, "height"), lines: linesOf(v.words), mirror: true });

/** The outline, the border's two outlines (or none) and where the words must fit. */
export function stampLayout(v: DesignValues) {
  const [w, h] = sizeOf(v);
  const edge = num(v, "edge");
  const line = v.border !== false ? num(v, "line") : 0;
  const outer: P2 = [w - 2 * edge, h - 2 * edge];
  const inner: P2 = [outer[0] - 2 * line, outer[1] - 2 * line];
  // Room for the words: inside the border, 1 mm clear of it (or of the outline's edge space).
  const room: P2 = [inner[0] - 2, inner[1] - 2];
  return { size: [w, h] as P2, border: v.border !== false ? { outer, inner } : null, room };
}

/** One rectangle or circle, centred on the origin, as a shape for shapesSketch. */
const shape = (v: DesignValues, [w, h]: P2) => (round(v) ? { type: "circle", center: [0, 0], diameter: w } : { type: "rectangle", center: [0, 0], width: w, height: h });

function stampProblems(v: DesignValues): string[] {
  const out = wordsProblems(v);
  if (out.length) return out;
  const L = stampLayout(v);
  if (!(L.room[0] > 2 && L.room[1] > 2)) return ["The border and edge space leave no room for words: make the stamp bigger."];
  const contours = blockContours(blockOf(v));
  const box = contoursBox(contours);
  if (!box) return ["Type some words for the stamp."];
  const fits = round(v) ? contours.every((c) => c.every(([x, y]) => Math.hypot(x, y) <= L.room[0] / 2)) : box[2] - box[0] <= L.room[0] && box[3] - box[1] <= L.room[1];
  if (!fits) out.push(`The words don't fit inside the ${L.border ? "border" : "stamp"}: they're ${mm(box[2] - box[0])} × ${mm(box[3] - box[1])}. Make the letters smaller or the stamp bigger.`);
  return out;
}

/** The outline, border and mirrored words, as one sketch (the laser stamp's). */
export function stampSketch(v: DesignValues, withOutline: boolean): SketchData {
  const L = stampLayout(v);
  const shapes = [...(withOutline ? [shape(v, L.size)] : []), ...(L.border ? [shape(v, L.border.outer), shape(v, L.border.inner)] : [])];
  const base: SketchData = shapes.length ? shapesSketch(shapes, {}) : { points: [], curves: [], constraints: [] };
  return addTextBlock(base, blockOf(v));
}

function preview(v: DesignValues, handle?: { d: number; at: number }): PreviewShape[] {
  const L = stampLayout(v);
  const outline = (s: P2, faint = false): PreviewShape =>
    round(v) ? { kind: "circle", c: [0, 0], r: s[0] / 2, faint } : { kind: "poly", closed: true, points: roundedRect(s[0], s[1], 0), faint };
  const out: PreviewShape[] = [outline(L.size)];
  if (L.border) out.push(outline(L.border.outer), outline(L.border.inner));
  out.push(...blockContours(blockOf(v)).map((c): PreviewShape => ({ kind: "poly", closed: true, points: c })));
  out.push({ kind: "text", at: [0, -L.size[1] / 2 - 4], text: "mirrored, so it prints the right way" });
  if (handle) out.push({ kind: "circle", c: [handle.at, 0], r: handle.d / 2, faint: true }, { kind: "text", at: [handle.at, 0], text: "handle" });
  return out;
}

export const rubberStamp: LibraryDesign = {
  id: "rubber-stamp",
  name: "Rubber stamp",
  group: "Signs and stamps",
  description:
    "Words (and a border) to laser-engrave into stamp rubber: the background is engraved away, leaving the letters raised, and they're mirrored so the stamp prints the right way round. Export for laser: pick \"Stamp sketch\" — it engraves the background and cuts the outline. Use laser-safe rubber made for stamps.",
  category: "laser",
  prefix: "stamp",
  icon: '<rect x="6" y="14" width="36" height="20" rx="1"/><rect x="9" y="17" width="30" height="14" opacity=".55"/><path d="M30 20v8h-3.5a2.5 2.5 0 0 1 0-5H30M25 28l-3 0M20 20v8h-4"/>',
  inputs: [
    ...sharedInputs,
    { key: "thickness", label: "Rubber thickness", kind: "length", default: 2.3, min: 0.5, max: 10, variable: true },
    { key: "relief", label: "Engrave depth", kind: "length", default: 1, min: 0.2, max: 5, variable: true, help: "How deep the background is engraved (set by your laser's power and speed; this is for the 3D view)." },
  ],
  laser: { "stamp-sketch": { background: true } },
  problems: (v) => {
    const out = stampProblems(v);
    if (!out.length && num(v, "relief") >= num(v, "thickness")) out.push(`The engrave depth must be less than the rubber's thickness (${mm(num(v, "thickness"))}).`);
    return out;
  },
  summary: (v) => {
    const [w, h] = sizeOf(v);
    return `${round(v) ? `A ${mm(w)} round` : `A ${mm(w)} × ${mm(h)}`} stamp; ${linesOf(v.words).length} line${linesOf(v.words).length === 1 ? "" : "s"} of words, mirrored.`;
  },
  make: (ctx) => {
    const v = ctx.values;
    const plate = ctx.id("plate");
    return {
      features: [
        sketchFeature(ctx.id("plate-sketch"), "Plate sketch", TOP, shapesSketch([shape(v, stampLayout(v).size)], ctx.scope)),
        // Downwards from the Top plane, so the stamp's face is on the plane, where its sketch is.
        extrudeFeature(plate, "Plate", ctx.id("plate-sketch"), { depth: ctx.vars.thickness, operation: "new", flip: true }),
        sketchFeature(ctx.id("stamp-sketch"), "Stamp sketch", TOP, stampSketch(v, true)),
        // The sketch's closed shapes are the background (outline − border, inside the border − letters, letter holes).
        extrudeFeature(ctx.id("background"), "Engraved background", ctx.id("stamp-sketch"), { depth: ctx.vars.relief, operation: "remove", flip: true }),
      ],
      partNames: { [plate]: ctx.name },
    };
  },
  preview: (v) => preview(v),
};

const HANDLE_GAP = 10;

export const printedStamp: LibraryDesign = {
  id: "printed-stamp",
  name: "Stamp with handle",
  description:
    "A stamp to 3D print: a block with mirrored words (and a border) standing up on its face, so it prints the right way round, and a round handle to glue on the back. Print the face with fine layers; TPU gives a softer, crisper print.",
  category: "print",
  prefix: "pstamp",
  icon: '<rect x="6" y="26" width="36" height="8" rx="1"/><path d="M12 26v-3h6v3M22 26v-3h4v3M30 26v-3h6v3"/><path d="M18 18v-6a6 6 0 0 1 12 0v6z" opacity=".6"/>',
  inputs: [
    ...sharedInputs,
    { key: "base", label: "Block thickness", kind: "length", default: 5, min: 1.5, max: 40, variable: true },
    { key: "relief", label: "Letter height above the block", kind: "length", default: 1.5, min: 0.4, max: 10, variable: true, help: "How far the words stand up." },
    { key: "grip", label: "Handle diameter", kind: "length", default: 20, min: 8, max: 80, variable: true },
    { key: "tall", label: "Handle height", kind: "length", default: 30, min: 8, max: 150, variable: true },
  ],
  problems: (v) => stampProblems(v),
  summary: (v) => `2 parts: the stamp block (words stand ${mm(num(v, "relief"))} up) and a handle to glue on its back.`,
  make: (ctx: MakeContext) => {
    const v = ctx.values;
    const block = ctx.id("block");
    const handle = ctx.id("handle");
    const at: Ex = plus(lit(stampLayout(v).size[0] / 2 + HANDLE_GAP), over(ctx.vars.grip, 2));
    return {
      features: [
        sketchFeature(ctx.id("block-sketch"), "Block sketch", TOP, shapesSketch([shape(v, stampLayout(v).size)], ctx.scope)),
        extrudeFeature(block, "Block", ctx.id("block-sketch"), { depth: ctx.vars.base, operation: "new" }),
        sketchFeature(ctx.id("words-sketch"), "Words sketch", TOP, stampSketch(v, false)),
        // From the bed up through the block and out of its top (the border's ring and the letters).
        extrudeFeature(ctx.id("words"), "Raised words", ctx.id("words-sketch"), { depth: plus(ctx.vars.base, ctx.vars.relief), operation: "add" }),
        sketchFeature(ctx.id("handle-sketch"), "Handle sketch", TOP, shapesSketch([{ type: "circle", center: [at.t, "0"], diameter: ctx.vars.grip.t }], ctx.scope)),
        extrudeFeature(handle, "Handle", ctx.id("handle-sketch"), { depth: ctx.vars.tall, operation: "new" }),
      ],
      partNames: { [block]: `${ctx.name} block`, [handle]: `${ctx.name} handle` },
    };
  },
  preview: (v) => preview(v, { d: num(v, "grip"), at: stampLayout(v).size[0] / 2 + HANDLE_GAP + num(v, "grip") / 2 }),
};
