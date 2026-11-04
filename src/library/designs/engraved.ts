/**
 * Flat plates with words engraved into them, to cut on a laser: coasters, a
 * name or key tag, a ruler. Each is one sketch — the outline, any holes, the
 * words (ordinary Text) and any lines — so Export for laser of that sketch
 * gives the red outline, blue holes and engraved words in one go. In 3D the
 * plate is made of the sketch's areas (all but the holes), downwards from the
 * Top plane, and the letters are cut a little way into its top face.
 */
import { lit } from "../ex";
import { addLines, pickAreas, onLetters } from "../laserKit";
import { extrudeFeature, roundCorners, shapesSketch, sketchFeature } from "../sketchKit";
import { addTextBlock, blockContours, contoursBox, fontInput, fontOf, insidePolygon, linesOf, type TextBlock } from "../textKit";
import type { DesignValues, LibraryDesign, MadeDesign, MakeContext, PreviewShape } from "../types";
import type { SketchData } from "../../sketch/types";
import type { Feature } from "../../model/types";
import { mm, num, roundedRect } from "./common";
import { wordsInput, wordsProblems } from "./stencil";

const TOP = { kind: "default", name: "Top" } as const;
type P2 = [number, number];
/** How deep the words are cut into the 3D plate (the laser's power and speed decide the real depth). */
export const ENGRAVE_DEPTH = 0.4;

/**
 * A plate (or a set of them) from one sketch: each plate from its areas (all but the holes), then its letters
 * engraved. Each plate is its own New extrude followed by its own engraving — a plain Remove, which cuts only the
 * latest part, the plate just made — so the engraving never reaches the user's parts or anything else in the studio.
 * `pieceOf` says which plate a point of the sketch belongs to (a set of coasters side by side).
 */
function engravedPlate(ctx: MakeContext, sketch: SketchData, holes: { c: P2; d: number }[], label: string, count = 1, pieceOf: (p: P2) => number = () => 0): MadeDesign {
  const sk = ctx.id("sketch");
  const inHole = (p: P2) => holes.some((h) => Math.hypot(p[0] - h.c[0], p[1] - h.c[1]) < h.d / 2);
  const keeps = Array.from({ length: count }, (_, i) => [(p: P2) => !inHole(p) && pieceOf(p) === i, (p: P2, letters: number) => onLetters(p, letters) && pieceOf(p) === i]).flat();
  const { sketch: data, picks } = pickAreas(sketch, sk, ...keeps);
  const features: Feature[] = [sketchFeature(sk, `${label} sketch`, TOP, data)];
  const partNames: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const [body, letters] = [picks[2 * i], picks[2 * i + 1]];
    const plate = ctx.id(i ? `plate-${i + 1}` : "plate");
    const name = count > 1 ? `${label} ${i + 1}` : label;
    // Downwards, so the top face is on the Top plane, where the words are.
    features.push(extrudeFeature(plate, name, sk, { depth: ctx.vars.thickness, operation: "new", flip: true, areas: body }));
    if (letters.length) features.push(extrudeFeature(ctx.id(i ? `words-${i + 1}` : "words"), count > 1 ? `Engraved words ${i + 1}` : "Engraved words", sk, { depth: lit(ENGRAVE_DEPTH), operation: "remove", flip: true, areas: letters }));
    partNames[plate] = count > 1 ? `${ctx.name} ${i + 1}` : ctx.name;
  }
  return { features, partNames };
}

const thickness = (def: number) => ({ key: "thickness", label: "Material thickness", kind: "length" as const, default: def, min: 0.5, max: 25, variable: true, help: "Measure your sheet: 3 mm plywood is often 2.8–3.2 mm." });

/** Does every letter outline sit inside the outline (given as a test), clear of the holes? */
function wordsFit(contours: P2[][], inside: (p: P2) => boolean): boolean {
  return contours.every((c) => c.every(inside));
}

// ---------------------------------------------------------------------------
// Coasters

function coasterOutline(v: DesignValues, cx: number): unknown {
  const size = num(v, "size");
  if (v.shape === "round") return { type: "circle", center: [cx, 0], diameter: size };
  if (v.shape === "hexagon") return { type: "polygon", center: [cx, 0], sides: 6, diameter: size, across: "flats", angle: 0 };
  return { type: "rectangle", center: [cx, 0], width: size, height: size };
}

const coasterPitch = (v: DesignValues) => num(v, "size") + 5;
const coasterText = (v: DesignValues, cx: number): TextBlock => ({ font: fontOf(v), capHeight: num(v, "height"), lines: linesOf(v.words), centre: [cx, 0] });

function coasterInside(v: DesignValues): (p: P2) => boolean {
  const r = num(v, "size") / 2 - 3;
  if (v.shape === "round") return ([x, y]) => Math.hypot(x, y) <= r;
  if (v.shape === "hexagon") return ([x, y]) => [0, 60, 120].every((a) => Math.abs(x * Math.cos((a * Math.PI) / 180) + y * Math.sin((a * Math.PI) / 180)) <= r);
  return ([x, y]) => Math.max(Math.abs(x), Math.abs(y)) <= r - Math.max(0, num(v, "corner")) * 0.3;
}

export const coaster: LibraryDesign = {
  id: "coaster",
  name: "Coasters",
  group: "Home",
  description:
    "A set of round, square or six-sided coasters with words engraved in the middle. Export for laser: pick \"Coaster sketch\" for the cut outlines and the engraving together. 3 mm plywood, cork or acrylic.",
  category: "laser",
  prefix: "coaster",
  laser: { sketch: { text: "engrave" } },
  icon: '<circle cx="17" cy="24" r="12"/><circle cx="17" cy="24" r="8" opacity=".45"/><path d="M13 24h8" /><rect x="31" y="14" width="14" height="20" rx="3" opacity=".7"/>',
  inputs: [
    { key: "shape", label: "Shape", kind: "choice", default: "round", choices: [
      { value: "round", label: "Round" },
      { value: "square", label: "Square" },
      { value: "hexagon", label: "Six-sided" },
    ] },
    { key: "size", label: "Size", kind: "length", default: 95, min: 30, max: 300, help: "Across (flat to flat for six-sided)." },
    { key: "corner", label: "Corner rounding", kind: "length", default: 8, min: 0, max: 50, help: "Square coasters only." },
    { key: "count", label: "How many", kind: "count", default: 4, min: 1, max: 12 },
    wordsInput("CHEERS", { multiline: true, optional: true, maxLength: 60, help: "Engraved in the middle. Leave empty for plain coasters; Enter for a new line." }),
    fontInput("bold"),
    { key: "height", label: "Letter height", kind: "length", default: 12, min: 2, max: 100 },
    thickness(3),
  ],
  problems: (v) => {
    const out = wordsProblems(v);
    if (v.shape === "square" && num(v, "corner") > num(v, "size") / 2 - 1) out.push(`The corner rounding must be less than ${mm(num(v, "size") / 2 - 1)}.`);
    const contours = blockContours(coasterText(v, 0));
    if (!out.length && contours.length && !wordsFit(contours, coasterInside(v))) out.push("The words don't fit on the coaster: make the letters smaller.");
    return out;
  },
  summary: (v) => `${num(v, "count")} coaster${num(v, "count") === 1 ? "" : "s"}, ${mm(num(v, "size"))} across${linesOf(v.words).length ? ", words engraved" : ""}.`,
  make: (ctx) => {
    const v = ctx.values;
    const n = num(v, "count");
    let s = shapesSketch(Array.from({ length: n }, (_, i) => coasterOutline(v, i * coasterPitch(v))), ctx.scope);
    if (v.shape === "square" && num(v, "corner") > 0) s = roundCorners(s, lit(num(v, "corner")), ctx.scope);
    for (let i = 0; i < n; i++) s = addTextBlock(s, coasterText(v, i * coasterPitch(v)));
    return engravedPlate(ctx, s, [], "Coaster", n, ([x]) => Math.max(0, Math.min(n - 1, Math.round(x / coasterPitch(v)))));
  },
  preview: (v) => {
    const out: PreviewShape[] = [];
    const size = num(v, "size");
    for (let i = 0; i < num(v, "count"); i++) {
      const cx = i * coasterPitch(v);
      if (v.shape === "round") out.push({ kind: "circle", c: [cx, 0], r: size / 2 });
      else if (v.shape === "hexagon") out.push({ kind: "poly", closed: true, points: Array.from({ length: 6 }, (_, k) => [cx + (size / Math.sqrt(3)) * Math.cos(((60 * k + 30) * Math.PI) / 180), (size / Math.sqrt(3)) * Math.sin(((60 * k + 30) * Math.PI) / 180)] as P2) });
      else out.push({ kind: "poly", closed: true, points: roundedRect(size, size, num(v, "corner"), cx) });
      out.push(...blockContours(coasterText(v, cx)).map((c): PreviewShape => ({ kind: "poly", closed: true, points: c })));
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Name / key tag

function tagLayout(v: DesignValues) {
  const [w, h, d] = [num(v, "width"), num(v, "depth"), num(v, "hole")];
  const hole: { c: P2; d: number } | null = d > 0 ? { c: [-w / 2 + 3 + d / 2, 0], d } : null;
  const left = hole ? hole.c[0] + d / 2 + 2 : -w / 2 + 3;
  const right = w / 2 - 3;
  return { w, h, hole, text: { font: fontOf(v), capHeight: num(v, "height"), lines: linesOf(v.words), centre: [(left + right) / 2, 0] as P2 }, room: [left, -h / 2 + 2, right, h / 2 - 2] as const };
}

export const nameTag: LibraryDesign = {
  id: "name-tag",
  name: "Name or key tag",
  group: "Signs and stamps",
  description:
    "A tag with a hole for a key ring or lanyard and a name engraved on it — for keys, bags, pet beds or plant pots. Export for laser: pick \"Tag sketch\" (red outline, blue hole, engraved words).",
  category: "laser",
  prefix: "tag",
  laser: { sketch: { text: "engrave" } },
  icon: '<rect x="4" y="16" width="40" height="16" rx="5"/><circle cx="11" cy="24" r="2.5"/><path d="M19 21v6M19 24h5M24 21v6M28 21h6M31 21v6M37 21v6h4" opacity=".7"/>',
  inputs: [
    wordsInput("SAM", { multiline: true, maxLength: 40 }),
    fontInput("bold"),
    { key: "height", label: "Letter height", kind: "length", default: 8, min: 2, max: 60 },
    { key: "width", label: "Tag length", kind: "length", default: 60, min: 20, max: 300 },
    { key: "depth", label: "Tag height", kind: "length", default: 20, min: 8, max: 200 },
    { key: "corner", label: "Corner rounding", kind: "length", default: 5, min: 0, max: 50 },
    { key: "hole", label: "Hole diameter", kind: "length", default: 5, min: 0, max: 30, help: "0 for no hole." },
    thickness(3),
  ],
  problems: (v) => {
    const out = wordsProblems(v);
    const L = tagLayout(v);
    if (num(v, "corner") > Math.min(L.w, L.h) / 2 - 0.5) out.push(`The corner rounding must be less than ${mm(Math.min(L.w, L.h) / 2 - 0.5)}.`);
    if (L.hole && L.hole.d > L.h - 4) out.push(`The hole is too big for the tag: at most ${mm(L.h - 4)}.`);
    if (out.length) return out;
    const box = contoursBox(blockContours(L.text));
    if (box && (box[0] < L.room[0] || box[2] > L.room[2] || box[1] < L.room[1] || box[3] > L.room[3])) out.push(`The words don't fit on the tag (they're ${mm(box[2] - box[0])} long): make the letters smaller or the tag longer.`);
    return out;
  },
  summary: (v) => `A ${mm(num(v, "width"))} × ${mm(num(v, "depth"))} tag${num(v, "hole") > 0 ? " with a hole" : ""}.`,
  make: (ctx) => {
    const L = tagLayout(ctx.values);
    let s = shapesSketch([{ type: "rectangle", center: [0, 0], width: L.w, height: L.h }], ctx.scope);
    if (num(ctx.values, "corner") > 0) s = roundCorners(s, lit(num(ctx.values, "corner")), ctx.scope);
    if (L.hole) s = joinShapes(s, shapesSketch([{ type: "circle", center: L.hole.c, diameter: L.hole.d }], ctx.scope));
    s = addTextBlock(s, L.text);
    return engravedPlate(ctx, s, L.hole ? [L.hole] : [], "Tag");
  },
  preview: (v) => {
    const L = tagLayout(v);
    return [
      { kind: "poly", closed: true, points: roundedRect(L.w, L.h, num(v, "corner")) },
      ...(L.hole ? [{ kind: "circle", c: L.hole.c, r: L.hole.d / 2 } as PreviewShape] : []),
      ...blockContours(L.text).map((c): PreviewShape => ({ kind: "poly", closed: true, points: c })),
    ];
  },
};

/** Two sketches' points, curves and dimensions together. */
function joinShapes(a: SketchData, b: SketchData): SketchData {
  return { ...a, points: [...a.points, ...b.points], curves: [...a.curves, ...b.curves], constraints: [...a.constraints, ...b.constraints] };
}

// ---------------------------------------------------------------------------
// Ruler

/** The ruler's marks: one per millimetre from 0 to the length, longer every 5 and 10 (each [x, length]). */
export function rulerMarks(length: number, width: number): [number, number][] {
  const out: [number, number][] = [];
  for (let x = 0; x <= length + 1e-9; x++) out.push([x, x % 10 === 0 ? Math.min(10, width * 0.4) : x % 5 === 0 ? Math.min(7, width * 0.28) : Math.min(4, width * 0.16)]);
  return out;
}

/** How far in from the edge the marks start (so they don't touch the outline, which would split it). */
export const MARK_GAP = 0.5;
const RULER_END = 6;

function rulerLayout(v: DesignValues) {
  const [length, width] = [num(v, "length"), num(v, "width")];
  const marks = rulerMarks(length, width);
  const size = Math.min(4, width * 0.15);
  const numbers: TextBlock[] = [];
  for (let cm = 0; cm * 10 <= length; cm++) numbers.push({ font: "regular", capHeight: size, lines: [String(cm)], centre: [cm * 10, MARK_GAP + Math.min(10, width * 0.4) + 1.5 + size / 2] });
  const hole = v.hole !== false ? { c: [length + RULER_END + 6, width / 2] as P2, d: 6 } : null;
  const right = length + RULER_END + (hole ? 12 : 0);
  return { length, width, marks, numbers, hole, x0: -RULER_END, x1: right };
}

export const ruler: LibraryDesign = {
  id: "ruler",
  name: "Ruler",
  group: "Workshop",
  description:
    "A straight ruler with millimetre marks and centimetre numbers. Export for laser: pick \"Ruler sketch\" — the marks are scored (light green lines), the numbers engraved and the outline cut. Check the first one against a good ruler: lasers are very accurate, but test your settings.",
  category: "laser",
  prefix: "ruler",
  icon: '<rect x="3" y="18" width="42" height="12" rx="1"/><path d="M7 30v-6M11 30v-3M15 30v-3M19 30v-6M23 30v-3M27 30v-3M31 30v-6M35 30v-3M39 30v-3" />',
  inputs: [
    { key: "length", label: "Length", kind: "length", default: 150, min: 20, max: 580, help: "Marked length (the ruler is a little longer)." },
    { key: "width", label: "Width", kind: "length", default: 30, min: 15, max: 100 },
    { key: "hole", label: "Hanging hole", kind: "toggle", default: true },
    thickness(3),
  ],
  laser: { sketch: { open: "score", text: "engrave" } },
  problems: () => [],
  summary: (v) => `${Math.floor(num(v, "length")) + 1} marks, numbered every 10 mm.`,
  make: (ctx) => {
    const L = rulerLayout(ctx.values);
    let s = shapesSketch([{ type: "rectangle", corner: [L.x0, 0], width: L.x1 - L.x0, height: L.width }, ...(L.hole ? [{ type: "circle", center: L.hole.c, diameter: L.hole.d }] : [])], ctx.scope);
    s = addLines(s, L.marks.map(([x, len]) => ({ points: [[x, MARK_GAP], [x, MARK_GAP + len]] as P2[] })));
    for (const b of L.numbers) s = addTextBlock(s, b);
    return engravedPlate(ctx, s, L.hole ? [L.hole] : [], "Ruler");
  },
  preview: (v) => {
    const L = rulerLayout(v);
    return [
      { kind: "poly", closed: true, points: [[L.x0, 0], [L.x1, 0], [L.x1, L.width], [L.x0, L.width]] },
      ...(L.hole ? [{ kind: "circle", c: L.hole.c, r: L.hole.d / 2 } as PreviewShape] : []),
      ...L.marks.map(([x, len]): PreviewShape => ({ kind: "poly", points: [[x, MARK_GAP], [x, MARK_GAP + len]] })),
      ...L.numbers.flatMap((b) => blockContours(b)).map((c): PreviewShape => ({ kind: "poly", closed: true, points: c })),
    ];
  },
};

/** For tests: is a point on a letter of a coaster's words? */
export const onCoasterLetter = (v: DesignValues, p: P2) => blockContours(coasterText(v, 0)).filter((c) => insidePolygon(p, c)).length % 2 === 1;
export const tagLayoutOf = tagLayout;
export const rulerLayoutOf = rulerLayout;
