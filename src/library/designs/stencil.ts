/**
 * A stencil: a sheet with words cut out of it, and bridges keeping the middles
 * of letters such as O, A, B, D, P, R, 4, 6, 8, 9 and 0 joined to the sheet
 * (bridges.ts works out where). The sheet is a plate; the letters are cut
 * through it from a sketch of ordinary Text; the bridges are added back from
 * a sketch of small rectangles — so Export for laser of the part gives the
 * red outline and blue letter holes, islands attached.
 */
import { lit, minus, plus, type Ex } from "../ex";
import type { Pt } from "../fingers";
import { planBridges, type BridgePlan } from "../bridges";
import { extrudeFeature, outlineSketch, sketchFeature, shapesSketch } from "../sketchKit";
import { addTextBlock, blockContours, contoursBox, fontInput, fontOf, linesOf, missingLetters, type TextBlock } from "../textKit";
import type { DesignInput, DesignValues, LibraryDesign, PreviewShape } from "../types";
import { mm, num, varsOf } from "./common";

const VARS = ["margin", "thickness"];
const TOP = { kind: "default", name: "Top" } as const;

/** The words input the text designs share. */
export const wordsInput = (def: string, opts: { label?: string; multiline?: boolean; maxLength?: number; optional?: boolean; help?: string } = {}): DesignInput => ({
  key: "words",
  label: opts.label ?? "Words",
  kind: "text",
  default: def,
  ...(opts.multiline ? { multiline: true } : {}),
  maxLength: opts.maxLength ?? 40,
  ...(opts.optional ? { optional: true } : {}),
  help: opts.help ?? (opts.multiline ? "Press Enter for a new line." : undefined),
});

/** Plain-English problems with words in a font. */
export function wordsProblems(values: DesignValues): string[] {
  const missing = missingLetters(fontOf(values), String(values.words ?? ""));
  return missing ? [`The font hasn't got these letters: ${missing}. Use plain letters, numbers and punctuation.`] : [];
}

const blockOf = (values: DesignValues): TextBlock => ({ font: fontOf(values), capHeight: num(values, "height"), lines: linesOf(values.words) });

// Working out bridges takes a moment for long words, and the preview asks on every key: keep the last few.
const plans = new Map<string, { contours: Pt2[][]; plan: BridgePlan }>();
type Pt2 = [number, number];

/** The letters' outlines and their bridges for these values. */
export function stencilPlan(values: DesignValues): { contours: Pt2[][]; plan: BridgePlan } {
  const key = JSON.stringify([values.words, values.font, values.height, values.bridge, values.steady]);
  const known = plans.get(key);
  if (known) return known;
  const contours = blockContours(blockOf(values));
  const plan = planBridges(contours, { width: num(values, "bridge"), perIsland: values.steady === true ? 2 : 1 });
  if (plans.size > 20) plans.clear();
  const out = { contours, plan };
  plans.set(key, out);
  return out;
}

/** The sheet's corners: the letters' box and the margin all round. */
function sheetCorners(values: DesignValues, margin: Ex): Pt[] {
  const box = contoursBox(stencilPlan(values).contours) ?? [-10, -10, 10, 10];
  const r = (v: number) => lit(Math.round(v * 1000) / 1000);
  const [x0, y0, x1, y1] = [minus(r(box[0]), margin), minus(r(box[1]), margin), plus(r(box[2]), margin), plus(r(box[3]), margin)];
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

export const stencil: LibraryDesign = {
  id: "stencil",
  name: "Stencil",
  group: "Signs and stamps",
  description:
    "Words cut out of a sheet, to paint or spray through. The middles of letters like O, A, B and 8 are kept on by thin bridges, so they don't fall out. Export for laser: pick the stencil part (red outline, blue letters). Card, thin plastic or 3 mm plywood all work.",
  category: "laser",
  prefix: "stencil",
  icon: '<rect x="4" y="12" width="40" height="24" rx="1.5"/><path d="M10 30V18h5a3 3 0 0 1 0 6h-5M14 24l4 6"/><ellipse cx="27" cy="24" rx="4.5" ry="6"/><path d="M27 17.5v3M27 27.5v3" stroke-width="2.6" opacity=".6"/><path d="M34 18h6M37 18v12"/>',
  inputs: [
    wordsInput("HELLO", { multiline: true }),
    fontInput("bold"),
    { key: "height", label: "Letter height", kind: "length", default: 30, min: 5, max: 400, help: "How tall the capital letters are." },
    { key: "bridge", label: "Bridge width", kind: "length", default: 2, min: 0.5, max: 20, help: "The strips holding the middles of letters. Wider is stronger; 1.5–3 mm suits card or plywood." },
    { key: "steady", label: "Two bridges per middle", kind: "toggle", default: false, help: "On opposite sides, so big letters' middles don't wobble." },
    { key: "margin", label: "Sheet margin", kind: "length", default: 15, min: 3, max: 500, variable: true, help: "Sheet left round the words." },
    { key: "thickness", label: "Sheet thickness", kind: "length", default: 1, min: 0.1, max: 12, variable: true },
  ],
  problems: (v) => {
    const out = wordsProblems(v);
    if (out.length) return out;
    if (num(v, "bridge") > num(v, "height") / 3) out.push(`The bridges are too wide for letters this size: at most ${mm(num(v, "height") / 3)}.`);
    if (num(v, "margin") < num(v, "bridge") + 1) out.push(`Leave a margin of at least ${mm(num(v, "bridge") + 1)} round the words.`);
    if (out.length) return out;
    const { contours, plan } = stencilPlan(v);
    if (!contours.length) return ["Type some letters to cut."];
    if (plan.bridges.length > 100) out.push("That's too many letter middles for one stencil (over 100 bridges): use fewer words.");
    if (plan.unheld.length) out.push(`${plan.unheld.length === 1 ? "One letter's middle" : `${plan.unheld.length} letters' middles`} can't be held with bridges this wide: try narrower bridges, bigger letters or the other font.`);
    return out;
  },
  summary: (v) => {
    const { plan } = stencilPlan(v);
    const c = sheetCorners(v, lit(num(v, "margin")));
    const size = `${mm(c[1][0].v - c[0][0].v)} × ${mm(c[2][1].v - c[0][1].v)}`;
    return plan.islands.length ? `A ${size} sheet; ${plan.islands.length} letter middle${plan.islands.length === 1 ? "" : "s"} held by ${plan.bridges.length} bridge${plan.bridges.length === 1 ? "" : "s"}.` : `A ${size} sheet; no letter middles need bridges.`;
  },
  make: (ctx) => {
    const { plan } = stencilPlan(ctx.values);
    const sheet = ctx.id("sheet");
    const features = [
      sketchFeature(ctx.id("sheet-sketch"), "Sheet sketch", TOP, outlineSketch(sheetCorners(ctx.values, ctx.vars.margin), ctx.scope)),
      extrudeFeature(sheet, "Sheet", ctx.id("sheet-sketch"), { depth: ctx.vars.thickness, operation: "new" }),
      sketchFeature(ctx.id("letters-sketch"), "Letters sketch", TOP, addTextBlock({ points: [], curves: [], constraints: [] }, blockOf(ctx.values))),
      extrudeFeature(ctx.id("letters"), "Letters", ctx.id("letters-sketch"), { operation: "remove", end: "throughAll" }),
    ];
    if (plan.bridges.length) {
      const rects = plan.bridges.map((b) => ({ type: "rectangle", corner: [b.box[0], b.box[1]], width: Math.round((b.box[2] - b.box[0]) * 1e6) / 1e6, height: Math.round((b.box[3] - b.box[1]) * 1e6) / 1e6 }));
      features.push(
        sketchFeature(ctx.id("bridges-sketch"), "Bridges sketch", TOP, shapesSketch(rects, ctx.scope)),
        // Added back to the sheet (the latest part, not `apart`), joining each middle to it.
        extrudeFeature(ctx.id("bridges"), "Bridges", ctx.id("bridges-sketch"), { depth: ctx.vars.thickness, operation: "add" }),
      );
    }
    return { features, partNames: { [sheet]: ctx.name } };
  },
  preview: (v) => {
    const { contours, plan } = stencilPlan(v);
    const corners = sheetCorners(v, lit(num(v, "margin"))).map(([x, y]) => [x.v, y.v] as [number, number]);
    return [
      { kind: "poly", closed: true, points: corners },
      ...contours.map((c): PreviewShape => ({ kind: "poly", closed: true, points: c })),
      ...plan.bridges.map((b): PreviewShape => ({
        kind: "poly",
        closed: true,
        faint: true,
        points: [
          [b.box[0], b.box[1]],
          [b.box[2], b.box[1]],
          [b.box[2], b.box[3]],
          [b.box[0], b.box[3]],
        ],
      })),
    ];
  },
};

/** For tests: the sheet's size from plain values. */
export const stencilSheet = (v: DesignValues) => sheetCorners(v, varsOf(v, VARS).margin).map(([x, y]) => [x.v, y.v] as [number, number]);
