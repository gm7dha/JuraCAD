/**
 * A desk organiser: a block with round or square cups for pens, brushes, scissors and rulers — a row of cups each of
 * its own size, or a grid of cups all one size. Made like the battery organiser: a block, the cups cut right through
 * it, then the floor put back underneath, so it prints as it stands with no supports.
 */
import { lit, plus, times, type Ex } from "../ex";
import { extrudeFeature, roundCorners, shapesSketch, sketchFeature } from "../sketchKit";
import { gridPatternFeature } from "../printKit";
import type { SketchData } from "../../sketch/types";
import type { DesignValues, LibraryDesign, MakeContext, PreviewShape } from "../types";
import { mm, num, roundedRect, roundedRectArea } from "./common";

const TOP = { kind: "default", name: "Top" } as const;
/** Cup sizes allowed (mm across), and how many in a row. */
export const CUP_LIMITS = { min: 10, max: 150, most: 8 };
const countOf = (v: DesignValues, k: string) => Math.max(1, Math.round(num(v, k)));
const square = (v: DesignValues) => v.shape === "square";
/** A square cup's corners (mm): rounded a quarter of its size, at most 4 mm. */
export const cupCorner = (d: number) => Math.min(4, d / 4);

/**
 * The most the block's corners can be rounded and still leave 0.8 mm of wall beside the end cups (measured along the
 * corner's diagonal, from the cup nearest it, as if it were right in the corner).
 */
export function cornerLimit(v: DesignValues): number {
  const L = organiserLayout(v);
  const w = num(v, "wall");
  const d = Math.min(L.cups[0].d, L.cups[L.cups.length - 1].d);
  const k = Math.SQRT2 - 1;
  if (square(v)) {
    const cc = cupCorner(d);
    return (Math.SQRT2 * (w + cc) - cc - 0.8) / k;
  }
  return (Math.SQRT2 * (w + d / 2) - d / 2 - 0.8) / k;
}

/** The row's cup sizes from the typed list ("60, 45, 45, 30"), or a plain-English problem. */
export function cupSizes(text: unknown): number[] | string {
  const parts = String(text ?? "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return "Type the cups' sizes, separated by commas (for example 60, 45, 45, 30).";
  const out: number[] = [];
  for (const s of parts) {
    const n = Number(s.replace(/mm$/i, ""));
    if (!Number.isFinite(n)) return `"${s}" isn't a size: type numbers in millimetres, separated by commas.`;
    if (n < CUP_LIMITS.min || n > CUP_LIMITS.max) return `Each cup must be ${CUP_LIMITS.min}–${CUP_LIMITS.max} mm across (${s} isn't).`;
    out.push(n);
  }
  if (out.length > CUP_LIMITS.most) return `At most ${CUP_LIMITS.most} cups in a row.`;
  return out;
}

/** Where the cups are and how big the block is (plain numbers; the block's corner at the origin). */
export function organiserLayout(v: DesignValues): { cups: { x: number; y: number; d: number }[]; size: [number, number] } {
  const w = num(v, "wall");
  if (v.layout === "grid") {
    const d = num(v, "size");
    const [c, r] = [countOf(v, "across"), countOf(v, "rows")];
    const cups = [];
    for (let j = 0; j < r; j++) for (let i = 0; i < c; i++) cups.push({ x: w + d / 2 + i * (d + w), y: w + d / 2 + j * (d + w), d });
    return { cups, size: [c * (d + w) + w, r * (d + w) + w] };
  }
  const sizes = cupSizes(v.sizes);
  const list = typeof sizes === "string" ? [40] : sizes;
  const deep = Math.max(...list);
  let x = w;
  const cups = list.map((d) => {
    const at = { x: x + d / 2, y: w + deep / 2, d };
    x += d + w;
    return at;
  });
  return { cups, size: [x, deep + 2 * w] };
}

function cupShapes(cups: { x: Ex; y: Ex; d: number }[], sq: boolean, scope: Record<string, number>): SketchData {
  if (!sq) return shapesSketch(cups.map((c) => ({ type: "circle", center: [c.x.t, c.y.t], diameter: String(c.d) })), scope);
  // Square cups of one size can share one rounding; a row of different sizes is rounded cup by cup.
  const sketches = cups.map((c) => roundCorners(shapesSketch([{ type: "rectangle", center: [c.x.t, c.y.t], width: String(c.d), height: String(c.d) }], scope), lit(cupCorner(c.d)), scope));
  return { points: sketches.flatMap((s) => s.points), curves: sketches.flatMap((s) => s.curves), constraints: sketches.flatMap((s) => s.constraints) };
}

function makeOrganiser(ctx: MakeContext) {
  const v = ctx.values;
  const { height, wall, floor, corner, size } = ctx.vars;
  const id = ctx.id("block");
  const grid = v.layout === "grid";
  let blockW: Ex;
  let blockD: Ex;
  let cups: { x: Ex; y: Ex; d: number }[];
  if (grid) {
    const [c, r] = [countOf(v, "across"), countOf(v, "rows")];
    const pitch = plus(size, wall);
    blockW = plus(times(pitch, c), wall);
    blockD = plus(times(pitch, r), wall);
    const first = plus(wall, times(size, 0.5));
    cups = [{ x: first, y: first, d: size.v }];
  } else {
    const list = cupSizes(v.sizes) as number[];
    const deep = Math.max(...list);
    let before = 0;
    cups = list.map((d, i) => {
      const at = { x: plus(lit(before + d / 2), times(wall, i + 1)), y: plus(lit(deep / 2), wall), d };
      before += d;
      return at;
    });
    blockW = plus(lit(before), times(wall, list.length + 1));
    blockD = plus(lit(deep), times(wall, 2));
  }
  const block = () => roundCorners(shapesSketch([{ type: "rectangle", corner: ["0", "0"], width: blockW.t, height: blockD.t }], ctx.scope), corner, ctx.scope);
  const through = plus(height, lit(1));
  const features = [
    sketchFeature(ctx.id("block-sketch"), "Block sketch", TOP, block()),
    extrudeFeature(id, "Block", ctx.id("block-sketch"), { depth: height, operation: "new" }),
  ];
  if (grid) {
    // One cup (its size is a variable), cut through and repeated.
    const sketch = square(v)
      ? roundCorners(shapesSketch([{ type: "rectangle", center: [cups[0].x.t, cups[0].y.t], width: size.t, height: size.t }], ctx.scope), lit(cupCorner(size.v)), ctx.scope)
      : shapesSketch([{ type: "circle", center: [cups[0].x.t, cups[0].y.t], diameter: size.t }], ctx.scope);
    features.push(
      sketchFeature(ctx.id("cup-sketch"), "Cup sketch", TOP, sketch),
      extrudeFeature(ctx.id("cup"), "Cup", ctx.id("cup-sketch"), { depth: through, operation: "remove" }),
    );
    const [c, r] = [countOf(v, "across"), countOf(v, "rows")];
    if (c * r > 1) features.push(gridPatternFeature(ctx.id("cups"), "Cups", [ctx.id("cup")], c, plus(size, wall), r, plus(size, wall)));
  } else {
    features.push(
      sketchFeature(ctx.id("cup-sketch"), "Cups sketch", TOP, cupShapes(cups, square(v), ctx.scope)),
      extrudeFeature(ctx.id("cup"), "Cups", ctx.id("cup-sketch"), { depth: through, operation: "remove" }),
    );
  }
  features.push(sketchFeature(ctx.id("floor-sketch"), "Floor sketch", TOP, block()), extrudeFeature(ctx.id("floor"), "Floor", ctx.id("floor-sketch"), { depth: floor, operation: "add" }));
  return { features, partNames: { [id]: ctx.name } };
}

export const deskOrganiser: LibraryDesign = {
  id: "desk-organiser",
  name: "Pen and desk organiser",
  description:
    "A tidy block of cups for pens, pencils, brushes, scissors and rulers: a row of cups each the size you choose, or a grid of cups all one size, round or square. It prints standing as it is, no supports.",
  category: "print",
  group: "Desk",
  prefix: "org",
  icon: '<rect x="4" y="16" width="40" height="24" rx="3"/><circle cx="13" cy="28" r="6"/><circle cx="27" cy="28" r="4.5"/><circle cx="38" cy="28" r="3"/><path d="M13 22V6M27 23V9" opacity=".55"/>',
  inputs: [
    {
      key: "layout",
      label: "Cups",
      kind: "choice",
      default: "row",
      choices: [
        { value: "row", label: "A row, each its own size" },
        { value: "grid", label: "A grid, all one size" },
      ],
    },
    { key: "sizes", label: "Cup sizes (row)", kind: "text", default: "60, 45, 45, 30", maxLength: 80, help: "Across each cup, in mm, left to right, separated by commas." },
    { key: "size", label: "Cup size (grid)", kind: "length", default: 40, min: 10, max: 150, variable: true },
    { key: "across", label: "Cups across (grid)", kind: "count", default: 3, min: 1, max: 12 },
    { key: "rows", label: "Rows (grid)", kind: "count", default: 2, min: 1, max: 12 },
    {
      key: "shape",
      label: "Shape",
      kind: "choice",
      default: "round",
      choices: [
        { value: "round", label: "Round" },
        { value: "square", label: "Square" },
      ],
    },
    { key: "height", label: "Height", kind: "length", default: 90, min: 15, max: 250, variable: true },
    { key: "wall", label: "Wall between cups", kind: "length", default: 2.4, min: 1.2, max: 20, variable: true },
    { key: "floor", label: "Floor thickness", kind: "length", default: 2, min: 0.8, max: 20, variable: true },
    { key: "corner", label: "Corner rounding", kind: "length", default: 4, min: 0, max: 50, variable: true, help: "The block's outside corners. 0 for square." },
  ],
  problems: (v) => {
    const out: string[] = [];
    if (v.layout !== "grid") {
      const s = cupSizes(v.sizes);
      if (typeof s === "string") return [s];
    } else if (countOf(v, "across") * countOf(v, "rows") < 1) out.push("Have at least one cup.");
    const L = organiserLayout(v);
    if (num(v, "corner") * 2 >= Math.min(...L.size)) out.push(`The corner rounding must be less than half the block's smaller side (${mm(Math.min(...L.size) / 2)}).`);
    if (num(v, "floor") > num(v, "height") - 10) out.push(`The floor must leave the cups at least 10 mm deep: make it at most ${mm(num(v, "height") - 10)}.`);
    const most = cornerLimit(v);
    if (num(v, "corner") > most) out.push(`Round the block's corners at most ${mm(Math.floor(most * 10) / 10)}, or they'd cut into the end cups.`);
    return out;
  },
  summary: (v) => {
    const L = organiserLayout(v);
    return `${L.cups.length} cup${L.cups.length === 1 ? "" : "s"}, ${L.cups.length && new Set(L.cups.map((c) => c.d)).size === 1 ? mm(L.cups[0].d) : "from " + mm(Math.min(...L.cups.map((c) => c.d))) + " to " + mm(Math.max(...L.cups.map((c) => c.d)))} across. The block is ${mm(L.size[0])} × ${mm(L.size[1])} and ${mm(num(v, "height"))} tall.`;
  },
  make: (ctx: MakeContext) => makeOrganiser(ctx),
  preview: (v) => {
    const L = organiserLayout(v);
    const [W, D] = L.size;
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: roundedRect(W, D, num(v, "corner"), W / 2, D / 2) }];
    for (const c of L.cups) out.push(square(v) ? { kind: "poly", closed: true, points: roundedRect(c.d, c.d, cupCorner(c.d), c.x, c.y) } : { kind: "circle", c: [c.x, c.y], r: c.d / 2 });
    return out;
  },
};

/** For tests: the block's volume (mm³). */
export function organiserVolume(v: DesignValues): number {
  const L = organiserLayout(v);
  const cup = (d: number) => (square(v) ? roundedRectArea(d, d, cupCorner(d)) : (Math.PI * d * d) / 4);
  return roundedRectArea(L.size[0], L.size[1], num(v, "corner")) * num(v, "height") - L.cups.reduce((n, c) => n + cup(c.d), 0) * (num(v, "height") - num(v, "floor"));
}
