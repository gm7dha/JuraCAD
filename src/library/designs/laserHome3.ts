/**
 * Laser designs for the home: a clock face, cord winders and a tealight holder. Each is flat plates, ready for Export
 * for laser.
 */
import { lit, times } from "../ex";
import { extrudeFeature, copyFeature, moveFeature, outlineSketch, shapesSketch, sketchFeature, placeFromOrigin } from "../sketchKit";
import { addTextBlock, blockContours, contoursBox, fontInput, fontOf, sizeForCaps, type TextBlock } from "../textKit";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import type { Feature } from "../../model/types";
import type { SketchData, SketchText } from "../../sketch/types";
import { sketchId } from "../../sketch/ops";
import { textContours } from "../../sketch/sketchText";
import type { Pt } from "../fingers";
import { engravedPlate } from "./engraved";
import { mm, num, roundedRect } from "./common";

type P2 = [number, number];
const TOP = { kind: "default", name: "Top" } as const;
const thickness = (def: number) => ({ key: "thickness", label: "Material thickness", kind: "length" as const, default: def, min: 0.5, max: 25, variable: true, help: "Measure your sheet: 3 mm plywood is often 2.8–3.2 mm." });
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

// ---------------------------------------------------------------------------
// Clock face

/** How far in from the edge the hour marks start (mm). */
export const CLOCK_EDGE = 5;
/** Room left clear round the centre hole for the movement's nut and the hands' hub (mm, beyond the hole). */
export const HUB_ROOM = 10;

export interface ClockLayout {
  R: number;
  hole: number;
  /** Hour marks: each [angle (degrees, anticlockwise from 3 o'clock), inner radius, outer radius]. */
  marks: [number, number, number][];
  /** The numbers, each a centred line of text. */
  numbers: TextBlock[];
  /** Marks as engraved bars (letter I) or scored lines. */
  style: "engrave" | "score" | "none";
}

export function clockLayout(v: DesignValues): ClockLayout {
  const R = num(v, "diameter") / 2;
  const m = num(v, "mark");
  const outer = R - CLOCK_EDGE;
  const style = v.marks === "score" ? "score" : v.marks === "none" ? "none" : "engrave";
  const marks: [number, number, number][] =
    style === "none" ? [] : Array.from({ length: 12 }, (_, h) => [r6(90 - 30 * h), outer - (h % 3 === 0 ? 1.5 * m : m), outer] as [number, number, number]);
  const h = num(v, "height");
  const show = v.numbers === "all" ? [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] : v.numbers === "quarters" ? [12, 3, 6, 9] : [];
  const ring = outer - (style === "none" ? 0 : 1.5 * m) - 3 - h * 0.85;
  const numbers = show.map((n): TextBlock => {
    const a = ((90 - 30 * (n % 12)) * Math.PI) / 180;
    return { font: fontOf(v), capHeight: h, lines: [String(n)], centre: [r6(ring * Math.cos(a)), r6(ring * Math.sin(a))] };
  });
  return { R, hole: num(v, "hole"), marks, numbers, style };
}

/** Engraved marks: a capital I, as tall as the mark, turned to point at the centre. */
function markTexts(s: SketchData, L: ClockLayout, font: "regular" | "bold"): SketchData {
  const points = [...s.points];
  const constraints = [...s.constraints];
  const texts: SketchText[] = [...(s.texts ?? [])];
  for (const [deg, r0, r1] of L.marks) {
    const a = (deg * Math.PI) / 180;
    const mid = (r0 + r1) / 2;
    const id = sketchId("p");
    const [x, y] = [r6(mid * Math.cos(a)), r6(mid * Math.sin(a))];
    points.push({ id, x, y });
    constraints.push(...placeFromOrigin(id, lit(x), lit(y)));
    texts.push({ id: sketchId("t"), anchor: id, value: "I", size: sizeForCaps(font, r1 - r0), angle: r6(deg - 90), font, anchorAt: "centre", construction: false });
  }
  return { ...s, points, constraints, texts };
}

function clockSketch(v: DesignValues, scope: Record<string, number>): SketchData {
  const L = clockLayout(v);
  const shapes: unknown[] = [{ type: "circle", center: [0, 0], diameter: 2 * L.R }, { type: "circle", center: [0, 0], diameter: L.hole }];
  if (L.style === "score") for (const [deg, r0, r1] of L.marks) {
    const a = (deg * Math.PI) / 180;
    shapes.push({ type: "line", from: [r6(r0 * Math.cos(a)), r6(r0 * Math.sin(a))], to: [r6(r1 * Math.cos(a)), r6(r1 * Math.sin(a))] });
  }
  let s = shapesSketch(shapes, scope);
  if (L.style === "engrave") s = markTexts(s, L, fontOf(v));
  for (const b of L.numbers) s = addTextBlock(s, b);
  return s;
}

/** Every letter outline of the clock (marks included), as the sketch will draw them. */
export function clockContours(v: DesignValues): P2[][] {
  const L = clockLayout(v);
  const s = markTexts({ points: [], curves: [], constraints: [] }, L.style === "engrave" ? L : { ...L, marks: [] }, fontOf(v));
  return [...(s.texts ?? []).flatMap((t) => textContours(s, t)), ...L.numbers.flatMap((b) => blockContours(b))];
}

function clockProblems(v: DesignValues): string[] {
  const L = clockLayout(v);
  const out: string[] = [];
  if (L.hole > L.R) return ["The centre hole is bigger than the clock."];
  const m = num(v, "mark");
  if (L.style !== "none" && L.R - CLOCK_EDGE - 1.5 * m < L.hole / 2 + HUB_ROOM) out.push("The hour marks are too long for the clock: make them shorter.");
  if (out.length || !L.numbers.length) return out;
  const boxes = L.numbers.map((b) => contoursBox(blockContours(b))).filter((b): b is [number, number, number, number] => b !== null);
  const reach = (b: [number, number, number, number]) => Math.max(...[[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]].map(([x, y]) => Math.hypot(x, y)));
  const near = (b: [number, number, number, number]) => Math.hypot(Math.max(b[0], 0, -b[2]), Math.max(b[1], 0, -b[3]));
  const markIn = L.R - CLOCK_EDGE - (L.style === "none" ? 0 : 1.5 * m);
  if (boxes.some((b) => reach(b) > markIn - 1)) out.push("The numbers are too big to fit inside the hour marks: make them smaller.");
  else if (boxes.some((b) => near(b) < L.hole / 2 + HUB_ROOM)) out.push("The numbers come too close to the centre: make them smaller or the clock bigger.");
  else if (boxes.some((a, i) => boxes.some((b, j) => j > i && a[0] < b[2] + 1 && b[0] < a[2] + 1 && a[1] < b[3] + 1 && b[1] < a[3] + 1))) out.push("The numbers run into each other: make them smaller or the clock bigger.");
  return out;
}

export const clockFace: LibraryDesign = {
  id: "clock-face",
  name: "Clock face",
  group: "Home",
  description:
    "A round clock face with hour marks, numbers if you like, and a hole in the middle for a battery quartz clock movement (the kind sold with hands). Export for laser: pick \"Clock sketch\" — outline red, centre hole blue, numbers engraved, and the marks engraved or scored.",
  category: "laser",
  prefix: "clock",
  laser: { sketch: { text: "engrave", open: "score" } },
  icon: '<circle cx="24" cy="24" r="19"/><path d="M24 8v4M24 36v4M8 24h4M36 24h4" /><path d="M24 24V15M24 24l6 4" /><circle cx="24" cy="24" r="1.5"/>',
  inputs: [
    { key: "diameter", label: "Diameter", kind: "length", default: 250, min: 80, max: 290, help: "The R1's bed is 300 mm deep." },
    { key: "hole", label: "Centre hole", kind: "length", default: 8, min: 3, max: 15, help: "Measure your movement's threaded tube: most need 7.5–8 mm." },
    { key: "marks", label: "Hour marks", kind: "choice", default: "engrave", choices: [
      { value: "engrave", label: "Engraved bars" },
      { value: "score", label: "Scored lines" },
      { value: "none", label: "None" },
    ] },
    { key: "mark", label: "Mark length", kind: "length", default: 12, min: 3, max: 60, help: "12, 3, 6 and 9 o'clock are half as long again." },
    { key: "numbers", label: "Numbers", kind: "choice", default: "all", choices: [
      { value: "all", label: "1 to 12" },
      { value: "quarters", label: "12, 3, 6, 9" },
      { value: "none", label: "None" },
    ] },
    { key: "height", label: "Number height", kind: "length", default: 18, min: 4, max: 80 },
    fontInput("bold"),
    thickness(3),
  ],
  problems: clockProblems,
  summary: (v) => {
    const L = clockLayout(v);
    return `${mm(2 * L.R)} across, ${mm(L.hole)} centre hole, ${L.marks.length} hour marks${L.numbers.length ? ` and ${L.numbers.length} numbers` : ""}.`;
  },
  make: (ctx) => engravedPlate(ctx, clockSketch(ctx.values, ctx.scope), [{ c: [0, 0], d: clockLayout(ctx.values).hole }], "Clock"),
  preview: (v) => {
    const L = clockLayout(v);
    const out: PreviewShape[] = [
      { kind: "circle", c: [0, 0], r: L.R },
      { kind: "circle", c: [0, 0], r: L.hole / 2 },
    ];
    if (L.style === "score") for (const [deg, r0, r1] of L.marks) {
      const a = (deg * Math.PI) / 180;
      out.push({ kind: "poly", points: [[r0 * Math.cos(a), r0 * Math.sin(a)], [r1 * Math.cos(a), r1 * Math.sin(a)]] });
    }
    out.push(...clockContours(v).map((c): PreviewShape => ({ kind: "poly", closed: true, points: c })));
    return out;
  },
};

// ---------------------------------------------------------------------------
// Cord winders

export interface WinderShape {
  /** The outline (anticlockwise, centred on 0, 0): an H — the cord winds round the waist between the two ends. */
  outline: P2[];
  /** How far apart neighbouring winders are drawn. */
  pitch: number;
}

/**
 * A winder `length` long and `width` wide: notches `depth` deep cut into both long sides between two ends `end` wide,
 * and a slit `slit` wide, as deep as the notch, down into the top of the right-hand end, to grip the cord's tail.
 */
export function winderShape(v: DesignValues): WinderShape {
  const [L, W, N, s] = [num(v, "length"), num(v, "width"), num(v, "notch"), num(v, "cord")];
  const E = Math.max(10, Math.round(L * 0.18));
  const [x0, x1, y0, y1] = [-L / 2, L / 2, -W / 2, W / 2];
  const slitX = x1 - E / 2;
  const outline: P2[] = [
    [x0, y0],
    [x0 + E, y0],
    [x0 + E, y0 + N],
    [x1 - E, y0 + N],
    [x1 - E, y0],
    [x1, y0],
    [x1, y1],
    [slitX + s / 2, y1],
    [slitX + s / 2, y1 - N],
    [slitX - s / 2, y1 - N],
    [slitX - s / 2, y1],
    [x1 - E, y1],
    [x1 - E, y1 - N],
    [x0 + E, y1 - N],
    [x0 + E, y1],
    [x0, y1],
  ].map(([x, y]) => [r6(x), r6(y)] as P2);
  return { outline, pitch: W + 5 };
}

export const cordWinder: LibraryDesign = {
  id: "cord-winder",
  name: "Cord winders",
  group: "Home",
  description:
    "Flat H-shaped winders to keep earphone, charger and fairy-light cables tidy: wind the cable round the middle and tuck its end into the slit. A set of them side by side. Export for laser: pick \"Winder sketch\" (or the parts). Plywood or 2–3 mm acrylic.",
  category: "laser",
  prefix: "winder",
  icon: '<path d="M8 10h8v8h16v-8h8v28h-8v-8H16v8H8z"/><path d="M36 10v5" /><path d="M16 22h16M16 26h16" opacity=".5"/>',
  inputs: [
    { key: "length", label: "Length", kind: "length", default: 70, min: 30, max: 300 },
    { key: "width", label: "Width", kind: "length", default: 40, min: 20, max: 200 },
    { key: "notch", label: "Notch depth", kind: "length", default: 10, min: 3, max: 80, help: "How deep the cable sits: deeper holds more." },
    { key: "cord", label: "Slit width", kind: "length", default: 2.5, min: 0.8, max: 10, help: "A little less than the cable's thickness, so it grips." },
    { key: "count", label: "How many", kind: "count", default: 4, min: 1, max: 12 },
    thickness(3),
  ],
  problems: (v) => {
    const [L, W, N, s] = [num(v, "length"), num(v, "width"), num(v, "notch"), num(v, "cord")];
    const E = Math.max(10, Math.round(L * 0.18));
    const out: string[] = [];
    if (2 * N > W - 8) out.push(`The notches are too deep for the width: at most ${mm((W - 8) / 2)}.`);
    if (L - 2 * E < 10) out.push("The winder is too short: make it longer.");
    if (s > E - 4) out.push(`The slit is too wide for the ends: at most ${mm(E - 4)}.`);
    return out;
  },
  summary: (v) => `${num(v, "count")} winder${num(v, "count") === 1 ? "" : "s"}, ${mm(num(v, "length"))} × ${mm(num(v, "width"))}.`,
  make: (ctx) => {
    const w = winderShape(ctx.values);
    const n = num(ctx.values, "count");
    let s: SketchData = { points: [], curves: [], constraints: [] };
    for (let i = 0; i < n; i++) {
      const o = outlineSketch(w.outline.map(([x, y]): Pt => [lit(x), lit(r6(y + i * w.pitch))]), ctx.scope);
      s = { ...s, points: [...s.points, ...o.points], curves: [...s.curves, ...o.curves], constraints: [...s.constraints, ...o.constraints] };
    }
    return engravedPlate(ctx, s, [], "Winder", n, ([, y]) => Math.max(0, Math.min(n - 1, Math.round(y / w.pitch))));
  },
  preview: (v) => {
    const w = winderShape(v);
    return Array.from({ length: num(v, "count") }, (_, i): PreviewShape => ({ kind: "poly", closed: true, points: w.outline.map(([x, y]) => [x, y + i * w.pitch]) }));
  },
};

// ---------------------------------------------------------------------------
// Tealight holder

/** Room round a tealight in its hole, all round (mm). */
export const TEALIGHT_ROOM = 0.75;

function holderShape(v: DesignValues, hole = 0): unknown[] {
  const size = num(v, "size");
  const outer = v.shape === "round" ? { type: "circle", center: [0, 0], diameter: size } : v.shape === "hexagon" ? { type: "polygon", center: [0, 0], sides: 6, diameter: size, across: "flats", angle: 0 } : { type: "rectangle", center: [0, 0], width: size, height: size };
  return hole > 0 ? [outer, { type: "circle", center: [0, 0], diameter: hole }] : [outer];
}

export const tealightHolder: LibraryDesign = {
  id: "tealight",
  name: "Tealight holder",
  group: "Home",
  description:
    "A holder for a tealight candle made of flat layers glued in a stack: a solid base, then rings with a hole the tealight drops into. Shown stacked; Export for laser lays the layers out flat. Only ever use it with tealights in their metal cups, never a bare flame on wood.",
  category: "laser",
  prefix: "tealight",
  icon: '<rect x="8" y="22" width="32" height="16" rx="2"/><path d="M16 22h16" /><path d="M24 20c-3-4 0-8 0-10 2 3 4 6 0 10z"/>',
  inputs: [
    { key: "shape", label: "Shape", kind: "choice", default: "hexagon", choices: [
      { value: "hexagon", label: "Six-sided" },
      { value: "round", label: "Round" },
      { value: "square", label: "Square" },
    ] },
    { key: "size", label: "Size", kind: "length", default: 70, min: 50, max: 280, help: "Across (flat to flat for six-sided)." },
    { key: "candle", label: "Tealight diameter", kind: "length", default: 38.5, min: 20, max: 80, help: "Most tealights are 38–39 mm across; the hole is 1.5 mm bigger." },
    { key: "rings", label: "Rings", kind: "count", default: 4, min: 1, max: 12, help: "Layers with a hole: 4 of 3 mm sheet hold a tealight 12 mm deep." },
    thickness(3),
  ],
  problems: (v) => {
    const hole = num(v, "candle") + 2 * TEALIGHT_ROOM;
    return num(v, "size") - hole < 10 ? [`The holder must be at least ${mm(hole + 10)} across for that tealight.`] : [];
  },
  summary: (v) => `${num(v, "rings") + 1} layers: a base and ${num(v, "rings")} ring${num(v, "rings") === 1 ? "" : "s"} with a ${mm(num(v, "candle") + 2 * TEALIGHT_ROOM)} hole.`,
  make: (ctx) => {
    const t = ctx.vars.thickness;
    const rings = num(ctx.values, "rings");
    const hole = num(ctx.values, "candle") + 2 * TEALIGHT_ROOM;
    const [base, ring] = [ctx.id("base"), ctx.id("ring")];
    const features: Feature[] = [
      sketchFeature(ctx.id("base-sketch"), "Base sketch", TOP, shapesSketch(holderShape(ctx.values), ctx.scope)),
      extrudeFeature(base, "Base", ctx.id("base-sketch"), { depth: t, operation: "new" }),
      sketchFeature(ctx.id("ring-sketch"), "Ring sketch", TOP, shapesSketch(holderShape(ctx.values, hole), ctx.scope)),
      extrudeFeature(ring, "Ring 1", ctx.id("ring-sketch"), { depth: t, operation: "new" }),
      moveFeature(ctx.id("ring-up"), "Ring 1 on the base", ring, { dz: t }),
    ];
    const partNames: Record<string, string> = { [base]: `${ctx.name} base`, [ring]: `${ctx.name} ring 1` };
    for (let i = 2; i <= rings; i++) {
      const id = ctx.id(`ring-${i}`);
      features.push(copyFeature(id, `Ring ${i}`, ring, { dz: times(t, i - 1) }));
      partNames[id] = `${ctx.name} ring ${i}`;
    }
    return { features, partNames };
  },
  preview: (v) => {
    const size = num(v, "size");
    const hole = num(v, "candle") + 2 * TEALIGHT_ROOM;
    const outline = (cx: number): PreviewShape =>
      v.shape === "round"
        ? { kind: "circle", c: [cx, 0], r: size / 2 }
        : v.shape === "hexagon"
          ? { kind: "poly", closed: true, points: Array.from({ length: 6 }, (_, k) => [cx + (size / Math.sqrt(3)) * Math.cos(((60 * k + 30) * Math.PI) / 180), (size / Math.sqrt(3)) * Math.sin(((60 * k + 30) * Math.PI) / 180)] as P2) }
          : { kind: "poly", closed: true, points: roundedRect(size, size, 0, cx) };
    return [outline(0), { kind: "text", at: [0, -size / 2 - 8], text: "base" }, outline(size + 10), { kind: "circle", c: [size + 10, 0], r: hole / 2 }, { kind: "text", at: [size + 10, -size / 2 - 8], text: `ring × ${num(v, "rings")}` }];
  },
};

