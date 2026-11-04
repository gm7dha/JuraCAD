/**
 * Calibration and test prints, to find out what a printer and filament can do — and so what to put in the printed
 * fit settings the other designs use:
 *  - Fit test: a plate of holes, each a bit bigger than the peg that comes with it (0.1, 0.2 … 0.5 mm each side),
 *    numbered in raised figures. The one the peg slides into snugly is your "snug" fit; a looser one "sliding".
 *  - Overhang test: fins leaning further and further over (20° … 70° from upright), to see where they start to droop.
 *  - Bridge test: a deck over gaps of 10 … 50 mm, to see how far your printer bridges cleanly.
 * Each lies flat on the bed; the numbers stand 0.6 mm up from the base (switch them off if your printer can't do small text).
 */
import { lit, type Ex } from "../ex";
import { extrudeFeature, outlineSketch, shapesSketch, sketchFeature } from "../sketchKit";
import { topFacePlane } from "../printKit";
import { addTextBlock, blockContours, contoursBox, inkArea, type TextBlock } from "../textKit";
import type { Feature } from "../../model/types";
import type { SketchData } from "../../sketch/types";
import type { DesignInput, DesignValues, LibraryDesign, MakeContext, PreviewShape } from "../types";
import { mm, num, roundedRect, sixPlaces } from "./common";

const TOP = { kind: "default", name: "Top" } as const;
const FRONT = { kind: "default", name: "Front" } as const;
/** The raised numbers: how tall the capitals (figures) are and how far they stand up. */
export const LABEL = { height: 4, raise: 0.6 };
/** The base the fins and bridges stand on: how thick. */
export const TEST_BASE = 2;

const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** The steps from `from` to `to` (inclusive), `step` apart. */
export function steps(from: number, to: number, step: number): number[] {
  if (!(step > 0) || to < from) return [];
  const n = Math.round((to - from) / step + 1e-9) + 1;
  return Array.from({ length: n }, (_, i) => r3(from + i * step));
}
const label = (n: number) => String(n).replace(/^0\./, "0.");
const labelsOn = (v: DesignValues) => v.labels !== false;
const labelBlock = (text: string, at: [number, number]): TextBlock => ({ font: "bold", capHeight: LABEL.height, lines: [text], centre: [sixPlaces(at[0]), sixPlaces(at[1])] });

/** The labels' sketch: each as ordinary Text, its middle where given. */
function labelsSketch(labels: { text: string; at: [number, number] }[]): SketchData {
  let s: SketchData = { points: [], curves: [], constraints: [] };
  for (const l of labels) s = addTextBlock(s, labelBlock(l.text, l.at));
  return s;
}

/** The labels' area (mm², for volumes) and the widest one (mm). */
export function labelsInk(labels: { text: string; at: [number, number] }[]): { area: number; widest: number } {
  let area = 0;
  let widest = 0;
  for (const l of labels) {
    const c = blockContours(labelBlock(l.text, l.at));
    area += inkArea(c);
    const b = contoursBox(c);
    if (b) widest = Math.max(widest, b[2] - b[0]);
  }
  return { area, widest };
}

const rangeInputs = (unit: string, from: number, to: number, step: number, min: number, max: number, stepMin: number): DesignInput[] => [
  { key: "from", label: "From", kind: "length", default: from, min, max, help: `The first ${unit}.` },
  { key: "to", label: "To", kind: "length", default: to, min, max, help: `The last ${unit}.` },
  { key: "step", label: "Step", kind: "length", default: step, min: stepMin, max: max - min },
];
const labelsInput: DesignInput = { key: "labels", label: "Raised numbers", kind: "toggle", default: true, help: "Numbers on the base, so you know which is which." };
const rangeProblems = (v: DesignValues, most: number, unit: string): string[] => {
  const s = steps(num(v, "from"), num(v, "to"), num(v, "step"));
  if (num(v, "to") < num(v, "from")) return ["“To” must be at least “From”."];
  if (s.length > most) return [`That's ${s.length} steps: have at most ${most} (a bigger step, or a shorter range of ${unit}).`];
  return [];
};

// ---------------------------------------------------------------------------------------------------------------
// Fit test

/** The fit test's holes and its peg (plate corner at the origin). */
export function fitPlan(v: DesignValues) {
  const peg = num(v, "peg");
  const t = num(v, "thickness");
  const gaps = steps(num(v, "from"), num(v, "to"), num(v, "step"));
  const biggest = peg + 2 * Math.max(0, ...gaps);
  const pitch = r3(biggest + 5);
  const labelRoom = labelsOn(v) ? LABEL.height + 3 : 0;
  const y = r3(3 + labelRoom + biggest / 2);
  const holes = gaps.map((c, i) => ({ c, d: r3(peg + 2 * c), x: r3(3 + pitch * (i + 0.5)), y }));
  const plate: [number, number] = [r3(gaps.length * pitch + 6), r3(y + biggest / 2 + 3)];
  const labels = labelsOn(v) ? holes.map((h) => ({ text: label(h.c), at: [h.x, 2 + labelRoom / 2] as [number, number] })) : [];
  // The peg: a disc to hold it by, then the peg itself, standing beside the plate.
  const pegAt: [number, number] = [r3(plate[0] + 5 + (peg + 6) / 2), y];
  return { peg, t, gaps, holes, plate, labels, pegAt, base: 2, pegHeight: r3(t + 6) };
}

function makeFitTest(ctx: MakeContext) {
  const p = fitPlan(ctx.values);
  const plate = ctx.id("plate");
  const peg = ctx.id("peg");
  const features: Feature[] = [
    sketchFeature(ctx.id("plate-sketch"), "Plate sketch", TOP, shapesSketch([{ type: "rectangle", corner: ["0", "0"], width: String(p.plate[0]), height: String(p.plate[1]) }], ctx.scope)),
    extrudeFeature(plate, "Plate", ctx.id("plate-sketch"), { depth: lit(p.t), operation: "new" }),
  ];
  if (p.labels.length)
    features.push(
      sketchFeature(ctx.id("labels-sketch"), "Numbers sketch", topFacePlane("Plate top", plate, lit(p.t), [p.plate[0] / 2, p.plate[1] / 2], [0.5, 0.5, 1]), labelsSketch(p.labels)),
      extrudeFeature(ctx.id("labels"), "Numbers", ctx.id("labels-sketch"), { depth: lit(LABEL.raise), operation: "add" }),
    );
  features.push(
    sketchFeature(ctx.id("holes-sketch"), "Holes sketch", TOP, shapesSketch(p.holes.map((h) => ({ type: "circle", center: [String(h.x), String(h.y)], diameter: String(h.d) })), ctx.scope)),
    extrudeFeature(ctx.id("holes"), "Holes", ctx.id("holes-sketch"), { depth: lit(p.t + 1), operation: "remove" }),
    sketchFeature(ctx.id("peg-base-sketch"), "Peg base sketch", TOP, shapesSketch([{ type: "circle", center: p.pegAt.map(String), diameter: String(p.peg + 6) }], ctx.scope)),
    extrudeFeature(peg, "Peg base", ctx.id("peg-base-sketch"), { depth: lit(p.base), operation: "new" }),
    sketchFeature(ctx.id("peg-sketch"), "Peg sketch", TOP, shapesSketch([{ type: "circle", center: p.pegAt.map(String), diameter: String(p.peg) }], ctx.scope)),
    extrudeFeature(ctx.id("peg-rod"), "Peg", ctx.id("peg-sketch"), { depth: lit(p.base + p.pegHeight), operation: "add" }),
  );
  return { features, partNames: { [plate]: `${ctx.name}: plate`, [peg]: `${ctx.name}: peg` } };
}

export const fitTest: LibraryDesign = {
  id: "fit-test",
  name: "Fit (tolerance) test",
  description:
    "Find your printer's fits: a plate of holes, each a little bigger than the peg that comes with it — 0.1, 0.2, 0.3, 0.4 and 0.5 mm all round, numbered — and the peg. Try the peg in each: the first it goes into firmly is your snug fit, an easy slide your sliding fit. Put those numbers into the printed fit settings (Hole › Printed fit) and the library's Fit boxes.",
  category: "print",
  group: "Test prints",
  prefix: "fit",
  icon: '<rect x="3" y="14" width="36" height="20" rx="1.5"/><circle cx="10" cy="24" r="3"/><circle cx="21" cy="24" r="3.5"/><circle cx="32" cy="24" r="4"/><circle cx="43" cy="24" r="3" opacity=".55"/>',
  inputs: [
    { key: "peg", label: "Peg diameter", kind: "length", default: 10, min: 3, max: 40 },
    ...rangeInputs("gap (each side of the peg)", 0.1, 0.5, 0.1, 0, 2, 0.02),
    { key: "thickness", label: "Plate thickness", kind: "length", default: 4, min: 1.5, max: 20 },
    labelsInput,
  ],
  problems: (v) => rangeProblems(v, 10, "gaps"),
  summary: (v) => {
    const p = fitPlan(v);
    return `2 parts: a plate ${mm(p.plate[0])} × ${mm(p.plate[1])} with ${p.holes.length} holes from ${mm(p.holes[0]?.d ?? 0)} to ${mm(p.holes[p.holes.length - 1]?.d ?? 0)}, and a ${mm(p.peg)} peg.`;
  },
  make: makeFitTest,
  preview: (v) => {
    const p = fitPlan(v);
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: roundedRect(p.plate[0], p.plate[1], 0, p.plate[0] / 2, p.plate[1] / 2) }];
    for (const h of p.holes) out.push({ kind: "circle", c: [h.x, h.y], r: h.d / 2 });
    for (const l of p.labels) out.push({ kind: "text", at: l.at, text: l.text });
    out.push({ kind: "circle", c: p.pegAt, r: (p.peg + 6) / 2, faint: true }, { kind: "circle", c: p.pegAt, r: p.peg / 2 });
    return out;
  },
};

/** For tests: the plate's and peg's volumes (mm³). */
export function fitVolumes(v: DesignValues): { plate: number; peg: number } {
  const p = fitPlan(v);
  const plate = p.plate[0] * p.plate[1] * p.t - p.holes.reduce((n, h) => n + (Math.PI * h.d * h.d) / 4, 0) * p.t + labelsInk(p.labels).area * LABEL.raise;
  const peg = (Math.PI / 4) * ((p.peg + 6) ** 2 * p.base + p.peg ** 2 * p.pegHeight);
  return { plate, peg };
}

// ---------------------------------------------------------------------------------------------------------------
// Overhang test

/**
 * The fins, seen from the front (x along, z up): each a slab `thick` thick (square to itself) leaning `angle` from
 * upright, standing on the base and reaching 1 mm down into it. Its underside — the overhang being tested — runs from
 * (x, base) up to (x + height × tan(angle), base + height).
 */
export function overhangPlan(v: DesignValues) {
  const angles = steps(num(v, "from"), num(v, "to"), num(v, "step"));
  const [H, W, p] = [num(v, "fin"), num(v, "width"), num(v, "thick")];
  const labelRoom = labelsOn(v) ? LABEL.height + 3 : 3;
  let x = 4;
  const fins = angles.map((a) => {
    const tan = sixPlaces(Math.tan((a * Math.PI) / 180));
    const T = sixPlaces(p / Math.cos((a * Math.PI) / 180));
    const foot = r3(x + T);
    const fin = { angle: a, tan, T, x: foot, reach: sixPlaces(H * tan) };
    x = foot + fin.reach + 4;
    return fin;
  });
  const length = r3(x);
  const labels = labelsOn(v) ? fins.map((f) => ({ text: String(f.angle), at: [f.x + (f.reach - f.T) / 2, -W - labelRoom / 2] as [number, number] })) : [];
  return { fins, length, height: H, width: W, labelRoom, labels };
}

function finOutline(f: { tan: number; T: number; x: number; reach: number }, H: number): [Ex, Ex][] {
  const b = TEST_BASE;
  const pts: [number, number][] = [
    [f.x - f.tan, b - 1],
    [f.x + f.reach, b + H],
    [f.x + f.reach - f.T, b + H],
    [f.x - f.tan - f.T, b - 1],
  ];
  return pts.map(([x, z]) => [lit(sixPlaces(x)), lit(sixPlaces(z))]);
}

/** A test's base (Top plane, behind the Front plane, its front strip for the numbers) and its numbers. */
function baseWithLabels(ctx: MakeContext, length: number, deep: number, labels: { text: string; at: [number, number] }[]): Feature[] {
  const base = ctx.id("base");
  const out: Feature[] = [
    sketchFeature(ctx.id("base-sketch"), "Base sketch", TOP, shapesSketch([{ type: "rectangle", corner: ["0", String(-deep)], width: String(length), height: String(deep) }], ctx.scope)),
    extrudeFeature(base, "Base", ctx.id("base-sketch"), { depth: lit(TEST_BASE), operation: "new" }),
  ];
  if (labels.length)
    out.push(
      sketchFeature(ctx.id("labels-sketch"), "Numbers sketch", topFacePlane("Base top", base, lit(TEST_BASE), [length / 2, -deep / 2], [0.5, 0.5, 1]), labelsSketch(labels)),
      extrudeFeature(ctx.id("labels"), "Numbers", ctx.id("labels-sketch"), { depth: lit(LABEL.raise), operation: "add" }),
    );
  return out;
}

export const overhangTest: LibraryDesign = {
  id: "overhang-test",
  name: "Overhang test",
  description:
    "See how far your printer can lean a wall over before it droops: a row of fins leaning 20°, 30° … 70° from upright, numbered on the base. Most printers manage 45° cleanly; the last fin that still looks good tells you how much overhang your designs can have without supports.",
  category: "print",
  group: "Test prints",
  prefix: "overhang",
  icon: '<path d="M3 40h42"/><path d="M6 40l2-14h3l-2 14M16 40l5-14h3l-5 14M28 40l9-14h3l-9 14" />',
  inputs: [
    ...rangeInputs("angle (degrees from upright)", 20, 70, 10, 5, 80, 1),
    { key: "fin", label: "Fin height", kind: "length", default: 10, min: 3, max: 40 },
    { key: "width", label: "Fin width", kind: "length", default: 10, min: 4, max: 40, help: "Front to back." },
    { key: "thick", label: "Fin thickness", kind: "length", default: 2, min: 0.8, max: 10, help: "Square to the slope." },
    labelsInput,
  ],
  problems: (v) => {
    const out = rangeProblems(v, 12, "angles");
    if (!out.length && num(v, "to") > 80) out.push("Keep the angles at 80° or less.");
    return out;
  },
  summary: (v) => {
    const p = overhangPlan(v);
    return `1 part, ${mm(p.length)} long: ${p.fins.length} fins from ${p.fins[0]?.angle ?? 0}° to ${p.fins[p.fins.length - 1]?.angle ?? 0}° from upright.${p.length > 250 ? " Check it fits your printer's bed." : ""}`;
  },
  make: (ctx) => {
    const p = overhangPlan(ctx.values);
    const features = baseWithLabels(ctx, p.length, p.width + p.labelRoom, p.labels);
    const fins = p.fins.map((f) => outlineSketch(finOutline(f, p.height), ctx.scope));
    const s: SketchData = { points: fins.flatMap((f) => f.points), curves: fins.flatMap((f) => f.curves), constraints: fins.flatMap((f) => f.constraints) };
    features.push(sketchFeature(ctx.id("fins-sketch"), "Fins sketch", FRONT, s), extrudeFeature(ctx.id("fins"), "Fins", ctx.id("fins-sketch"), { depth: lit(p.width), operation: "add" }));
    return { features, partNames: { [ctx.id("base")]: ctx.name } };
  },
  preview: (v) => {
    const p = overhangPlan(v);
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: [[0, 0], [p.length, 0], [p.length, TEST_BASE], [0, TEST_BASE]] }];
    for (const f of p.fins) out.push({ kind: "poly", closed: true, points: finOutline(f, p.height).map(([x, z]) => [x.v, Math.max(z.v, TEST_BASE)]) });
    for (const f of p.fins) out.push({ kind: "text", at: [f.x + (f.reach - f.T) / 2, -5], text: `${f.angle}°` });
    return out;
  },
};

/** For tests: its volume (mm³). */
export function overhangVolume(v: DesignValues): number {
  const p = overhangPlan(v);
  return p.length * (p.width + p.labelRoom) * TEST_BASE + p.fins.reduce((n, f) => n + f.T * p.height, 0) * p.width + labelsInk(p.labels).area * LABEL.raise;
}

// ---------------------------------------------------------------------------------------------------------------
// Bridge test

/** The bridge test, seen from the front: pillars `pillar` wide, the deck over the gaps between them. */
export function bridgePlan(v: DesignValues) {
  const spans = steps(num(v, "from"), num(v, "to"), num(v, "step"));
  const [P, gap, deck, W] = [num(v, "pillar"), num(v, "gap"), num(v, "deck"), num(v, "width")];
  const labelRoom = labelsOn(v) ? LABEL.height + 3 : 3;
  let x = P;
  const gaps = spans.map((s) => {
    const g = { span: s, x0: r3(x), x1: r3(x + s) };
    x = x + s + P;
    return g;
  });
  const length = r3(x);
  const labels = labelsOn(v) ? gaps.map((g) => ({ text: String(g.span), at: [(g.x0 + g.x1) / 2, -W - labelRoom / 2] as [number, number] })) : [];
  return { gaps, length, pillar: P, under: gap, deck, width: W, labelRoom, labels };
}

/** The pillars and deck as one outline, seen from the front (x along, z up), reaching 1 mm down into the base. */
function combOutline(p: ReturnType<typeof bridgePlan>): [Ex, Ex][] {
  const b = TEST_BASE;
  const top = b + p.under + p.deck;
  const pts: [number, number][] = [[0, b - 1], [0, top], [p.length, top], [p.length, b - 1]];
  for (const g of [...p.gaps].reverse()) pts.push([g.x1, b - 1], [g.x1, b + p.under], [g.x0, b + p.under], [g.x0, b - 1]);
  return pts.map(([x, z]) => [lit(sixPlaces(x)), lit(sixPlaces(z))]);
}

export const bridgeTest: LibraryDesign = {
  id: "bridge-test",
  name: "Bridge test",
  description:
    "See how far your printer can bridge — print a flat layer across empty air: a thin deck over gaps of 10, 20 … 50 mm between pillars, numbered on the base. The widest gap that still prints flat and tidy underneath is how far your designs can bridge without supports.",
  category: "print",
  group: "Test prints",
  prefix: "bridge",
  icon: '<path d="M3 40h42"/><path d="M4 40V22h40v18h-4V26h-8v14h-4V26H12v14H8V26" />',
  inputs: [
    ...rangeInputs("gap", 10, 50, 10, 2, 150, 1),
    { key: "pillar", label: "Pillar width", kind: "length", default: 4, min: 2, max: 20 },
    { key: "gap", label: "Height under the deck", kind: "length", default: 5, min: 1, max: 40 },
    { key: "deck", label: "Deck thickness", kind: "length", default: 1, min: 0.4, max: 5 },
    { key: "width", label: "Width", kind: "length", default: 10, min: 4, max: 60, help: "Front to back." },
    labelsInput,
  ],
  problems: (v) => rangeProblems(v, 10, "gaps"),
  summary: (v) => {
    const p = bridgePlan(v);
    return `1 part, ${mm(p.length)} long: a deck over ${p.gaps.length} gaps from ${mm(p.gaps[0]?.span ?? 0)} to ${mm(p.gaps[p.gaps.length - 1]?.span ?? 0)}.${p.length > 250 ? " Check it fits your printer's bed." : ""}`;
  },
  make: (ctx) => {
    const p = bridgePlan(ctx.values);
    const features = baseWithLabels(ctx, p.length, p.width + p.labelRoom, p.labels);
    features.push(sketchFeature(ctx.id("deck-sketch"), "Pillars and deck sketch", FRONT, outlineSketch(combOutline(p), ctx.scope)), extrudeFeature(ctx.id("deck"), "Pillars and deck", ctx.id("deck-sketch"), { depth: lit(p.width), operation: "add" }));
    return { features, partNames: { [ctx.id("base")]: ctx.name } };
  },
  preview: (v) => {
    const p = bridgePlan(v);
    const out: PreviewShape[] = [
      { kind: "poly", closed: true, points: [[0, 0], [p.length, 0], [p.length, TEST_BASE], [0, TEST_BASE]] },
      { kind: "poly", closed: true, points: combOutline(p).map(([x, z]) => [x.v, Math.max(z.v, TEST_BASE)]) },
    ];
    for (const g of p.gaps) out.push({ kind: "text", at: [(g.x0 + g.x1) / 2, -5], text: String(g.span) });
    return out;
  },
};

/** For tests: its volume (mm³). */
export function bridgeVolume(v: DesignValues): number {
  const p = bridgePlan(v);
  const pillars = p.gaps.length + 1;
  return p.length * (p.width + p.labelRoom) * TEST_BASE + (p.length * p.deck + pillars * p.pillar * p.under) * p.width + labelsInk(p.labels).area * LABEL.raise;
}
