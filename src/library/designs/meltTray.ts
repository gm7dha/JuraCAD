/**
 * Wax melt / soap tray: a block with rows × columns of cavities (round, heart, star or square), printed open side up.
 * Each cavity is a ruled Loft from its floor outline to its full-size top outline: the floor outline is the top one
 * shrunk towards its middle by k, chosen so that even the face nearest the middle tilts by the draft
 * (k = 1 − depth · tan(draft) / d, d = the nearest side's distance from the middle) — every other face tilts more.
 * One cavity is made, then a Linear pattern copies it across the grid.
 */
import { lit } from "../ex";
import { gridPatternFeature, levelPlane, loftFeature } from "../printKit";
import { extrudeFeature, shapesSketch, sketchFeature } from "../sketchKit";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { mm, num } from "./common";
import { CONCRETE_ADVICE, ml, WAX_ADVICE, WAX_DENSITY, grams } from "./mouldKit";
import { areaOf, rectShape, type P2 } from "./printShapes";

export type MeltShape = "round" | "heart" | "star" | "square";
const SHAPES: { value: MeltShape; label: string }[] = [
  { value: "round", label: "Round" },
  { value: "heart", label: "Heart" },
  { value: "star", label: "Star" },
  { value: "square", label: "Square" },
];

const six = (n: number) => Math.round(n * 1e6) / 1e6;

/** A cavity's top outline, `size` across, centred on (0, 0), anticlockwise (null = a circle). */
export function meltOutline(shape: MeltShape, size: number): P2[] | null {
  switch (shape) {
    case "round":
      return null;
    case "square":
      return [
        [-size / 2, -size / 2],
        [size / 2, -size / 2],
        [size / 2, size / 2],
        [-size / 2, size / 2],
      ];
    case "star":
      return Array.from({ length: 10 }, (_, i): P2 => {
        const a = Math.PI / 2 + (Math.PI * i) / 5;
        const r = (i % 2 ? 0.45 : 1) * (size / 2);
        return [r * Math.cos(a), r * Math.sin(a)];
      });
    case "heart": {
      // Two round lobes (radius r, centres ±0.7r apart from the middle) and straight sides down to the point, so the
      // dip between the lobes is gentle enough for the draft.
      const r = size / 3.4;
      const tip: P2 = [0, -2.3 * r];
      const lobe = (cx: number) => {
        const [dx, dy] = [tip[0] - cx, tip[1]];
        const L = Math.hypot(dx, dy);
        const base = Math.atan2(dy, dx);
        const swing = Math.acos(r / L);
        const notch = Math.atan2(Math.sqrt(r * r - cx * cx), -cx);
        return { cx, touch: cx > 0 ? base + swing : base - swing, notch };
      };
      const [right, left] = [lobe(0.7 * r), lobe(-0.7 * r)];
      const arc = (c: { cx: number }, from: number, to: number, steps: number) => Array.from({ length: steps + 1 }, (_, i): P2 => [c.cx + r * Math.cos(from + ((to - from) * i) / steps), r * Math.sin(from + ((to - from) * i) / steps)]);
      const rTouch = right.touch < 0 ? right.touch : right.touch - 2 * Math.PI;
      const lTouch = left.touch > left.notch ? left.touch : left.touch + 2 * Math.PI;
      const pts: P2[] = [tip, ...arc(right, rTouch, right.notch, 20), ...arc(left, left.notch, lTouch, 20).slice(1)];
      const ys = pts.map((q) => q[1]);
      const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
      return pts.map(([x, y]): P2 => [x, y - cy]);
    }
  }
}

/** The nearest any side's line comes to the point c (the radius for a circle); ≤ 0 if c doesn't see every side from inside. */
export function nearestSide(pts: P2[] | null, size: number, c: P2 = [0, 0]): number {
  if (!pts) return size / 2;
  let d = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [a, b] = [pts[i], pts[(i + 1) % pts.length]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    d = Math.min(d, ((a[0] - c[0]) * (b[1] - c[1]) - (a[1] - c[1]) * (b[0] - c[0])) / len);
  }
  return d;
}

/** The point the cavity shrinks towards: where its nearest side is furthest away (a grid search inside its box). */
export function shrinkCentre(pts: P2[] | null, size: number): P2 {
  if (!pts) return [0, 0];
  let best: P2 = [0, 0];
  let most = nearestSide(pts, size);
  for (let i = 0; i <= 40; i++)
    for (let j = 0; j <= 40; j++) {
      const c: P2 = [Math.round(((i - 20) / 40) * size * 1e4) / 1e4, Math.round(((j - 20) / 40) * size * 1e4) / 1e4];
      const d = nearestSide(pts, size, c);
      if (d > most + 1e-9) [best, most] = [c, d];
    }
  return best;
}

export function meltPlan(v: DesignValues) {
  const shape = (SHAPES.some((s) => s.value === v.shape) ? v.shape : "round") as MeltShape;
  const [size, depth, draft, wall, floor] = ["size", "depth", "draft", "wall", "floor"].map((k) => num(v, k));
  const [cols, rows] = [Math.max(1, Math.round(num(v, "columns"))), Math.max(1, Math.round(num(v, "rows")))];
  const top = meltOutline(shape, size);
  const centre = shrinkCentre(top, size);
  const d = nearestSide(top, size, centre);
  const k = 1 - (depth * Math.tan((draft * Math.PI) / 180)) / d;
  const pitch = size + wall;
  const W = cols * size + (cols + 1) * wall;
  const L = rows * size + (rows + 1) * wall;
  const area = top ? areaOf(top) : (Math.PI * size * size) / 4;
  /** One cavity: a frustum, so depth × A × (1 + k + k²) / 3. */
  const cavity = (depth * area * (1 + k + k * k)) / 3;
  const first: P2 = [-W / 2 + wall + size / 2, -L / 2 + wall + size / 2];
  return { shape, size, depth, draft, wall, floor, cols, rows, top, centre, d, k, pitch, W, L, height: floor + depth, cavity, first, area };
}

export const meltTrayVolume = (v: DesignValues) => {
  const p = meltPlan(v);
  return p.W * p.L * p.height - p.cols * p.rows * p.cavity;
};

/** The cavity's outline scaled by s about its middle and moved to (x, y). */
const scaled = (p: ReturnType<typeof meltPlan>, s: number, x: number, y: number) =>
  p.top
    ? { type: "outline", closed: true, points: p.top.map(([px, py]) => [String(six(x + p.centre[0] + s * (px - p.centre[0]))), String(six(y + p.centre[1] + s * (py - p.centre[1])))]) }
    : { type: "circle", center: [String(six(x)), String(six(y))], diameter: String(six(s * p.size)) };

export const meltTray: LibraryDesign = {
  id: "wax-melt-tray",
  name: "Wax melt / soap tray",
  description:
    "A tray of little moulds for wax melts, soap, bath bombs or chocolate-style treats: rounds, hearts, stars or squares in rows and columns. The cavities taper slightly towards the bottom so the melts pop out — pop the tray in the freezer for ten minutes first if they stick. Prints flat, open side up, no supports. " +
    `${WAX_ADVICE} For soap or plaster: ${CONCRETE_ADVICE.replace("Filament: ", "")}`,
  category: "print",
  group: "Moulds and casting",
  prefix: "melts",
  icon: '<rect x="4" y="12" width="40" height="24" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="14" cy="24" r="5"/><path d="M24 20l1.6 3.2 3.4.5-2.5 2.4.6 3.4-3.1-1.6-3.1 1.6.6-3.4-2.5-2.4 3.4-.5z"/><rect x="31" y="19" width="10" height="10" rx="1"/>',
  inputs: [
    { key: "shape", label: "Shape", kind: "choice", default: "round", choices: SHAPES.map((c) => ({ ...c })) },
    { key: "size", label: "Size", kind: "length", default: 35, min: 15, max: 100, help: "Across each cavity at the top." },
    { key: "depth", label: "Depth", kind: "length", default: 15, min: 5, max: 40 },
    { key: "columns", label: "Columns", kind: "count", default: 3, min: 1, max: 8 },
    { key: "rows", label: "Rows", kind: "count", default: 2, min: 1, max: 8 },
    { key: "draft", label: "Draft", kind: "length", default: 3, min: 1, max: 10, help: "Degrees the sides lean in towards the bottom." },
    { key: "wall", label: "Wall between", kind: "length", default: 2.4, min: 1.6, max: 10 },
    { key: "floor", label: "Floor", kind: "length", default: 1.6, min: 1, max: 5 },
  ],
  problems: (v) => {
    const p = meltPlan(v);
    const out: string[] = [];
    if (p.k < 0.6) out.push(`Too deep for a ${p.shape} this size with this draft: make it at most ${mm((0.4 * p.d) / Math.tan((p.draft * Math.PI) / 180))} deep, or bigger.`);
    if (Math.max(p.W, p.L) > 250) out.push(`The tray would be ${mm(Math.max(p.W, p.L))} across, too big for most beds: use fewer rows or columns.`);
    return out;
  },
  summary: (v) => {
    const p = meltPlan(v);
    const n = p.cols * p.rows;
    return `1 tray, ${mm(p.W)} × ${mm(p.L)} × ${mm(p.height)}: ${n} cavities of ${ml(p.cavity)} ml each — ${ml(n * p.cavity)} ml in all, about ${grams(n * p.cavity, WAX_DENSITY)} of wax.`;
  },
  make: (ctx) => {
    const p = meltPlan(ctx.values);
    const id = ctx.id("tray");
    const grow = 1 + (1 - p.k) / p.depth;
    return {
      features: [
        sketchFeature(ctx.id("tray-sketch"), "Tray sketch", { kind: "default", name: "Top" }, shapesSketch([rectShape(-p.W / 2, -p.L / 2, p.W, p.L)], ctx.scope)),
        extrudeFeature(id, "Tray", ctx.id("tray-sketch"), { depth: lit(p.height), operation: "new" }),
        sketchFeature(ctx.id("floor-sketch"), "Cavity floor", levelPlane(`${mm(p.floor)} up`, p.floor), shapesSketch([scaled(p, p.k, ...p.first)], ctx.scope)),
        sketchFeature(ctx.id("top-sketch"), "Cavity top", levelPlane(`${mm(p.height)} up`, p.height), shapesSketch([scaled(p, 1, ...p.first)], ctx.scope)),
        sketchFeature(ctx.id("past-sketch"), "Cavity past the top", levelPlane(`${mm(p.height + 1)} up`, p.height + 1), shapesSketch([scaled(p, grow, ...p.first)], ctx.scope)),
        loftFeature(ctx.id("cavity"), "Cavity", [ctx.id("floor-sketch"), ctx.id("top-sketch"), ctx.id("past-sketch")], "remove"),
        ...(p.cols * p.rows > 1 ? [gridPatternFeature(ctx.id("cavities"), "Cavities", [ctx.id("cavity")], p.cols, lit(p.pitch), p.rows, lit(p.pitch))] : []),
      ],
      partNames: { [id]: ctx.name },
    };
  },
  preview: (v) => {
    const p = meltPlan(v);
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: [[-p.W / 2, -p.L / 2], [p.W / 2, -p.L / 2], [p.W / 2, p.L / 2], [-p.W / 2, p.L / 2]] }];
    for (let i = 0; i < p.cols; i++)
      for (let j = 0; j < p.rows; j++) {
        const [x, y] = [p.first[0] + i * p.pitch, p.first[1] + j * p.pitch];
        for (const [s, faint] of [[1, false], [p.k, true]] as const)
          out.push(p.top ? { kind: "poly", closed: true, faint, points: p.top.map(([a, b]): [number, number] => [x + p.centre[0] + s * (a - p.centre[0]), y + p.centre[1] + s * (b - p.centre[1])]) } : { kind: "circle", faint, c: [x, y], r: (s * p.size) / 2 });
      }
    return out;
  },
};
