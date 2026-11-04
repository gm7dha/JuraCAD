/**
 * A hanging ornament or keyring: a star, heart, circle or snowflake with a name engraved on it and a hole to hang it
 * by. One sketch (outline, hole, words), made like the engraved plates (engraved.ts): Export for laser of "Ornament
 * sketch" gives the red outline, blue hole and engraved words.
 *
 * The shapes, sized by `size` across (S, R = S/2):
 *  - star: five points, the inner corners at 0.45 R;
 *  - heart: two round lobes (radius 0.28 S, centres 0.22 S either side of the middle) and two straight sides, each
 *    touching its lobe exactly (tangent), meeting at a point 0.62 S below the lobes' centres;
 *  - snowflake: a hexagonal middle (0.4 R to its flats) with six arms 0.14 R wide, each with a pair of side branches at
 *    60°; the top arm ends in a round eye for the hole.
 */
import { lit } from "../ex";
import type { Pt } from "../fingers";
import { outlineSketch, shapesSketch } from "../sketchKit";
import { addTextBlock, blockContours, fontInput, fontOf, insidePolygon, linesOf, type TextBlock } from "../textKit";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import type { SketchArc, SketchData, SketchLine, SketchPoint } from "../../sketch/types";
import { sketchId } from "../../sketch/ops";
import { engravedPlate } from "./engraved";
import { mm, num } from "./common";
import { wordsInput, wordsProblems } from "./stencil";

type P2 = [number, number];
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const at = (p: P2): P2 => [r6(p[0]), r6(p[1])];

/** One piece of an outline: a straight line to `to`, or an arc round `centre` (anticlockwise) to `to`. */
export type PathStep = { to: P2; centre?: P2 };

export interface OrnamentShape {
  /** The outline as steps from `start` (closed: the last step ends at `start`). Null for the circle. */
  start: P2;
  steps: PathStep[];
  /** The circle's radius (circle only). */
  circle?: number;
  hole: { c: P2; d: number } | null;
  /** Where the words go. */
  centre: P2;
}

const rot = (p: P2, deg: number): P2 => {
  const a = (deg * Math.PI) / 180;
  return [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)];
};

function starShape(R: number, d: number): OrnamentShape {
  const ri = 0.45 * R;
  const pts: P2[] = Array.from({ length: 10 }, (_, k) => {
    const a = ((90 + 36 * k) * Math.PI) / 180;
    const r = k % 2 ? ri : R;
    return at([r * Math.cos(a), r * Math.sin(a)]);
  });
  const s36 = Math.sin((36 * Math.PI) / 180);
  const c36 = Math.cos((36 * Math.PI) / 180);
  // In the top point, as high as leaves 2 mm round the hole: the point is ri·sin36 wide each side at ri·cos36 high.
  const y = R - ((d / 2 + 2) * (R - ri * c36)) / (ri * s36) - d / 2;
  return { start: pts[0], steps: [...pts.slice(1), pts[0]].map((to) => ({ to })), hole: d > 0 ? { c: [0, r6(y)], d } : null, centre: [0, 0] };
}

/** Where a line from `p` touches a circle (centre c, radius r): the touching point on the outer side (bigger |x|). */
function tangentPoint(p: P2, c: P2, r: number): P2 {
  const [dx, dy] = [p[0] - c[0], p[1] - c[1]];
  const D = Math.hypot(dx, dy);
  const base = Math.atan2(dy, dx);
  const turn = Math.acos(r / D);
  const options = [base + turn, base - turn].map((a): P2 => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  return options.sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]))[0];
}

function heartShape(S: number, d: number): OrnamentShape {
  const r = 0.28 * S;
  const c = S / 2 - r;
  const cusp: P2 = at([0, Math.sqrt(r * r - c * c)]);
  const tip: P2 = [0, r6(-0.62 * S)];
  const tr = at(tangentPoint(tip, [c, 0], r));
  const tl: P2 = [-tr[0], tr[1]];
  return {
    start: tip,
    steps: [{ to: tr }, { to: cusp, centre: [r6(c), 0] }, { to: tl, centre: [r6(-c), 0] }, { to: tip }],
    hole: d > 0 ? { c: [0, r6(cusp[1] - 2.5 - d / 2)], d } : null,
    centre: [0, r6(-0.12 * S)],
  };
}

/** How far apart the cut edges of an ornament must stay (mm), and its snowflake's eye from the branches beside it. */
export const EDGE_ROOM = 1.5;
const FLAKE_ROOM = EDGE_ROOM;

function distanceToSegment(p: P2, a: P2, b: P2): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** The snowflake's sizes, as shares of its radius. */
export const FLAKE = { hub: 0.4, arm: 0.07, branchAt: 0.62, branch: 0.22 };

function flakeShape(R: number, d: number): OrnamentShape {
  const h = FLAKE.arm * R;
  const F = FLAKE.hub * R;
  const p = FLAKE.branchAt * R;
  const l = FLAKE.branch * R;
  const re = Math.max(d / 2 + 2, h * 1.5);
  const eye = R - re;
  const dir: P2 = [0.5, -Math.sqrt(3) / 2];
  const nrm: P2 = [Math.sqrt(3) / 2, 0.5];
  const branchEnd = (side: 1 | -1): P2 => [p + l * dir[0] + side * h * nrm[0], l * dir[1] + side * h * nrm[1]];
  // One arm along +x, from the hub's corner below it to the corner above it (anticlockwise round the whole flake).
  const branch: P2[] = [[p - h / Math.sqrt(3), -h], branchEnd(-1), branchEnd(1), [p + h * Math.sqrt(3), -h]];
  const lower: PathStep[] = [{ to: [F, -h] }, ...branch.map((to) => ({ to }))];
  // The top arm's eye must stay clear of its side branches (a big hole on a small flake would run into them): if it
  // doesn't, that arm goes without them.
  const eyeGap = Math.min(...branch.slice(0, -1).map((q, i) => distanceToSegment([eye, 0], q, branch[i + 1]))) - re;
  const topLower: PathStep[] = eyeGap >= FLAKE_ROOM ? lower : [{ to: [F, -h] }];
  const flip = (q: P2): P2 => [q[0], -q[1]];
  const upperOf = (l: PathStep[]): PathStep[] => [...l].reverse().map((s) => ({ to: flip(s.to) }));
  const corner: P2 = [F, F / Math.sqrt(3)];
  const steps: PathStep[] = [];
  for (let k = 0; k < 6; k++) {
    const deg = 90 + 60 * k;
    const own = k === 0 ? topLower : lower;
    const arm: PathStep[] = [...own];
    if (k === 0) {
      // The top arm ends in the eye (a round end bigger than the arm, for the hole).
      const x = eye - Math.sqrt(re * re - h * h);
      arm.push({ to: [x, -h] }, { to: [x, h], centre: [eye, 0] });
    } else arm.push({ to: [R, -h] }, { to: [R, h] });
    arm.push(...upperOf(own), { to: corner });
    steps.push(...arm.map((s) => ({ to: at(rot(s.to, deg)), ...(s.centre ? { centre: at(rot(s.centre, deg)) } : {}) })));
  }
  const start = at(rot(corner, 30));
  steps[steps.length - 1] = { to: start };
  return { start, steps, hole: d > 0 ? { c: [0, r6(eye)], d } : null, centre: [0, 0] };
}

export function ornamentShape(v: DesignValues): OrnamentShape {
  const S = num(v, "size");
  const d = num(v, "hole");
  if (v.shape === "heart") return heartShape(S, d);
  if (v.shape === "snowflake") return flakeShape(S / 2, d);
  if (v.shape === "circle") return { start: [0, 0], steps: [], circle: S / 2, hole: d > 0 ? { c: [0, r6(S / 2 - 2.5 - d / 2)], d } : null, centre: [0, r6(-d / 2)] };
  return starShape(S / 2, d);
}

/** Points along an arc from a to b, anticlockwise round c. */
function arcBetween(a: P2, b: P2, c: P2, n = 24): P2[] {
  const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
  let a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
  while (a1 <= a0) a1 += 2 * Math.PI;
  return Array.from({ length: n }, (_, i) => {
    const t = a0 + ((a1 - a0) * (i + 1)) / n;
    return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)] as P2;
  });
}

/** The outline as a polygon (arcs in short pieces), anticlockwise. */
export function ornamentPolygon(s: OrnamentShape): P2[] {
  if (s.circle) return Array.from({ length: 96 }, (_, i) => [s.circle! * Math.cos((i * Math.PI) / 48), s.circle! * Math.sin((i * Math.PI) / 48)] as P2);
  const out: P2[] = [];
  let from = s.start;
  for (const step of s.steps) {
    if (step.centre) out.push(...arcBetween(from, step.to, step.centre));
    else out.push(step.to);
    from = step.to;
  }
  return out;
}

/** The outline's sketch: lines and arcs end to end (a star's corners dimensioned, the curved shapes' points left free). */
function outlineOf(s: OrnamentShape, scope: Record<string, number>): SketchData {
  if (s.circle) return shapesSketch([{ type: "circle", center: [0, 0], diameter: 2 * s.circle }], scope);
  if (s.steps.every((x) => !x.centre)) return outlineSketch(s.steps.map((x): Pt => [lit(x.to[0]), lit(x.to[1])]), scope);
  const points: SketchPoint[] = [];
  const curves: (SketchLine | SketchArc)[] = [];
  const add = (p: P2) => {
    const id = sketchId("p");
    points.push({ id, x: p[0], y: p[1] });
    return id;
  };
  const first = add(s.start);
  let from = first;
  s.steps.forEach((step, i) => {
    const to = i === s.steps.length - 1 ? first : add(step.to);
    if (step.centre) curves.push({ id: sketchId("a"), type: "arc", center: add(step.centre), start: from, end: to, construction: false });
    else curves.push({ id: sketchId("l"), type: "line", p1: from, p2: to, construction: false });
    from = to;
  });
  return { points, curves, constraints: [] };
}

/** The outline and hole as a sketch (no words). */
export function ornamentSketch(s: OrnamentShape, scope: Record<string, number> = {}): SketchData {
  const sk = outlineOf(s, scope);
  if (!s.hole) return sk;
  const h = shapesSketch([{ type: "circle", center: s.hole.c, diameter: s.hole.d }], scope);
  return { ...sk, points: [...sk.points, ...h.points], curves: [...sk.curves, ...h.curves], constraints: [...sk.constraints, ...h.constraints] };
}

const wordsOf = (v: DesignValues, s: OrnamentShape): TextBlock => ({ font: fontOf(v), capHeight: num(v, "height"), lines: linesOf(v.words), centre: s.centre });

function distanceToPolygon(p: P2, poly: P2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) best = Math.min(best, distanceToSegment(p, poly[i], poly[(i + 1) % poly.length]));
  return best;
}

function segmentsCross(a: P2, b: P2, c: P2, d: P2): boolean {
  const side = (o: P2, p: P2, q: P2) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const [d1, d2, d3, d4] = [side(c, d, a), side(c, d, b), side(a, b, c), side(a, b, d)];
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Each step of an outline as a polyline from where the last ended (arcs in short pieces). */
export function stepPolylines(s: OrnamentShape): P2[][] {
  let from = s.start;
  return s.steps.map((step) => {
    const pts = [from, ...(step.centre ? arcBetween(from, step.to, step.centre, 12) : [step.to])];
    from = step.to;
    return pts;
  });
}

/**
 * How close an outline comes to itself (mm): the least distance between any two of its pieces that don't meet end to
 * end — 0 where it crosses itself. A circle can't.
 */
export function outlineGap(s: OrnamentShape): number {
  if (s.circle) return Infinity;
  const runs = stepPolylines(s);
  const n = runs.length;
  let best = Infinity;
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const [a, b] = [runs[i], runs[j]];
      for (let u = 0; u + 1 < a.length; u++)
        for (let w = 0; w + 1 < b.length; w++) {
          if (segmentsCross(a[u], a[u + 1], b[w], b[w + 1])) return 0;
          best = Math.min(best, distanceToSegment(a[u], b[w], b[w + 1]), distanceToSegment(a[u + 1], b[w], b[w + 1]), distanceToSegment(b[w], a[u], a[u + 1]), distanceToSegment(b[w + 1], a[u], a[u + 1]));
        }
    }
  return best;
}

/** Room the words must leave to the edge and the hole (mm). */
export const WORDS_ROOM = 1.5;

function ornamentProblems(v: DesignValues): string[] {
  const out = wordsProblems(v);
  if (out.length) return out;
  const s = ornamentShape(v);
  const poly = ornamentPolygon(s);
  const gap = outlineGap(s);
  if (gap < EDGE_ROOM) return [gap === 0 ? `The ${String(v.shape)}'s outline would cross itself at this size: make it bigger or the hole smaller.` : `Parts of the ${String(v.shape)} would be only ${mm(gap)} wide — too thin to cut: make it bigger or the hole smaller.`];
  const contours = blockContours(wordsOf(v, s));
  const ok = (p: P2) => insidePolygon(p, poly) && distanceToPolygon(p, poly) >= WORDS_ROOM && (!s.hole || Math.hypot(p[0] - s.hole.c[0], p[1] - s.hole.c[1]) >= s.hole.d / 2 + WORDS_ROOM);
  if (s.hole && !(insidePolygon(s.hole.c, poly) && distanceToPolygon(s.hole.c, poly) >= s.hole.d / 2 + 1.5)) out.push(`The hole is too big for the ${String(v.shape)}: make it smaller or the shape bigger.`);
  else if (contours.some((c) => !c.every(ok))) out.push(`The words don't fit on the ${String(v.shape)}: make the letters smaller or the shape bigger.`);
  return out;
}

export const ornament: LibraryDesign = {
  id: "ornament",
  name: "Ornament or keyring",
  group: "Toys and gifts",
  description:
    "A star, heart, circle or snowflake with a name engraved on it and a hole to hang it from — a Christmas tree decoration, a gift tag or a keyring. Export for laser: pick \"Ornament sketch\" (red outline, blue hole, engraved name).",
  category: "laser",
  prefix: "ornament",
  laser: { sketch: { text: "engrave" } },
  icon: '<path d="M24 6l5 11 12 1-9 8 3 12-11-6-11 6 3-12-9-8 12-1z"/><circle cx="24" cy="12" r="1.8"/>',
  inputs: [
    { key: "shape", label: "Shape", kind: "choice", default: "star", choices: [
      { value: "star", label: "Star" },
      { value: "heart", label: "Heart" },
      { value: "circle", label: "Circle" },
      { value: "snowflake", label: "Snowflake" },
    ] },
    { key: "size", label: "Size", kind: "length", default: 80, min: 25, max: 280, help: "Across." },
    wordsInput("NOEL", { optional: true, maxLength: 20, help: "Engraved in the middle; leave empty for none." }),
    fontInput("bold"),
    { key: "height", label: "Letter height", kind: "length", default: 7, min: 2, max: 60 },
    { key: "hole", label: "Hanging hole", kind: "length", default: 4, min: 0, max: 20, help: "0 for no hole; 4–5 mm takes a ribbon, a key ring needs about 4." },
    { key: "thickness", label: "Material thickness", kind: "length", default: 3, min: 0.5, max: 25, variable: true, help: "Measure your sheet: 3 mm plywood is often 2.8–3.2 mm." },
  ],
  problems: ornamentProblems,
  summary: (v) => `A ${String(v.shape)} ${mm(num(v, "size"))} across${linesOf(v.words).length ? `, "${linesOf(v.words).join(" ")}" engraved` : ""}${num(v, "hole") > 0 ? ", with a hanging hole" : ""}.`,
  make: (ctx) => {
    const s = ornamentShape(ctx.values);
    const sk = addTextBlock(ornamentSketch(s, ctx.scope), wordsOf(ctx.values, s));
    return engravedPlate(ctx, sk, s.hole ? [s.hole] : [], "Ornament");
  },
  preview: (v) => {
    const s = ornamentShape(v);
    return [
      s.circle ? { kind: "circle", c: [0, 0], r: s.circle } : { kind: "poly", closed: true, points: ornamentPolygon(s) },
      ...(s.hole ? [{ kind: "circle", c: s.hole.c, r: s.hole.d / 2 } as PreviewShape] : []),
      ...blockContours(wordsOf(v, s)).map((c): PreviewShape => ({ kind: "poly", closed: true, points: c })),
    ];
  },
};
