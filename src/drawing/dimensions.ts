/**
 * Dimensions on drawing views: finding their points again after the part
 * changes, measuring, and drawing them (extension lines, arrows, the number).
 * Sizes on paper follow ISO 129 roughly: 3.5 mm text, 3 mm arrows.
 */
import { lengthNumber } from "../model/units";
import type { ViewProjection } from "../kernel/protocol";
import type { Dimension, DimPoint } from "../model/types";
import type { Prim } from "./sheet";

type P2 = [number, number];

export const TEXT_SIZE = 3.5;
const ARROW = 3;
const GAP = 1;
const OVERSHOOT = 2;

const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** "40", "12.5", "0.25" in the design's units (up to 2 decimal places in mm, 3 in inches; no trailing zeros). */
export function formatSize(v: number): string {
  return lengthNumber(v);
}

function boundsOf(p: ViewProjection): [number, number, number, number] {
  return p.bounds ?? [0, 0, 1, 1];
}

/** A point on a view, remembered both where it is and as a fraction across the view. */
export function dimPoint(at: P2, p: ViewProjection): DimPoint {
  const [x0, y0, x1, y1] = boundsOf(p);
  const fx = x1 > x0 ? (at[0] - x0) / (x1 - x0) : 0.5;
  const fy = y1 > y0 ? (at[1] - y0) / (y1 - y0) : 0.5;
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return { at: [r(at[0]), r(at[1])], rel: [r(fx), r(fy)] };
}

/** Points a dimension can snap to: ends of edges and centres of circles (each once). */
export function snapPoints(p: ViewProjection): P2[] {
  const out: P2[] = [];
  const add = (x: number, y: number) => {
    if (!out.some((q) => Math.abs(q[0] - x) < 1e-6 && Math.abs(q[1] - y) < 1e-6)) out.push([x, y]);
  };
  for (let i = 0; i + 1 < p.points.length; i += 2) add(p.points[i], p.points[i + 1]);
  for (const c of p.circles) add(c.cx, c.cy);
  return out;
}

function findPoint(want: DimPoint, p: ViewProjection): { at: P2; found: boolean } {
  const pts = snapPoints(p);
  const exact = pts.find((q) => dist(q, want.at) < 1e-6);
  if (exact) return { at: exact, found: true };
  const [x0, y0, x1, y1] = boundsOf(p);
  const expected: P2 = [x0 + want.rel[0] * (x1 - x0), y0 + want.rel[1] * (y1 - y0)];
  const size = Math.hypot(x1 - x0, y1 - y0);
  let best: P2 | null = null;
  let bestD = Math.max(0.2 * size, 0.5);
  for (const q of pts) {
    const d = dist(q, expected);
    if (d < bestD) {
      best = q;
      bestD = d;
    }
  }
  return best ? { at: best, found: true } : { at: want.at, found: false };
}

function findCircle(want: DimPoint, r: number, p: ViewProjection): { at: P2; r: number; found: boolean } {
  const exact = p.circles.find((c) => dist([c.cx, c.cy], want.at) < 1e-6 && Math.abs(c.r - r) < 1e-6);
  if (exact) return { at: [exact.cx, exact.cy], r: exact.r, found: true };
  const [x0, y0, x1, y1] = boundsOf(p);
  const expected: P2 = [x0 + want.rel[0] * (x1 - x0), y0 + want.rel[1] * (y1 - y0)];
  const size = Math.hypot(x1 - x0, y1 - y0);
  let best: { at: P2; r: number } | null = null;
  let bestScore = Math.max(0.2 * size, 0.5);
  for (const c of p.circles) {
    const score = dist([c.cx, c.cy], expected) + Math.abs(c.r - r) * 0.5;
    if (score < bestScore) {
      best = { at: [c.cx, c.cy], r: c.r };
      bestScore = score;
    }
  }
  return best ? { ...best, found: true } : { at: want.at, r, found: false };
}

export interface ResolvedDim {
  a: P2;
  b?: P2;
  /** Angles: the second edge's ends. */
  c?: P2;
  d?: P2;
  r?: number;
  /** False when what it measured can't be found any more (it's drawn where it was). */
  found: boolean;
}

/** Where a dimension's points are on the view as the part is now. */
export function resolveDim(dim: Dimension, p: ViewProjection): ResolvedDim {
  if (dim.type === "diameter" || dim.type === "radius") {
    const c = findCircle(dim.a, dim.r ?? 0, p);
    return { a: c.at, r: c.r, found: c.found };
  }
  const a = findPoint(dim.a, p);
  const b = dim.b ? findPoint(dim.b, p) : a;
  if (dim.type === "angle" && dim.c && dim.d) {
    const c = findPoint(dim.c, p);
    const d = findPoint(dim.d, p);
    return { a: a.at, b: b.at, c: c.at, d: d.at, found: a.found && b.found && c.found && d.found };
  }
  return { a: a.at, b: b.at, found: a.found && b.found };
}

/** The size a dimension shows (mm). */
export function measureDim(dim: Dimension, r: ResolvedDim): number {
  const b = r.b ?? r.a;
  switch (dim.type) {
    case "horizontal":
      return Math.abs(b[0] - r.a[0]);
    case "vertical":
      return Math.abs(b[1] - r.a[1]);
    case "aligned":
      return dist(r.a, b);
    case "diameter":
      return 2 * (r.r ?? 0);
    case "radius":
      return r.r ?? 0;
    case "ordinate":
      return dim.axis === "v" ? Math.abs(b[1] - r.a[1]) : Math.abs(b[0] - r.a[0]);
    case "angle": {
      const g = r.c && r.d ? angleGeometry(r.a, b, r.c, r.d, dim.rays) : null;
      return g ? g.degrees : 0;
    }
  }
}

/**
 * Where two edges (a–b and c–d) meet and the directions of the two arms of
 * the angle measured between them (`rays` picks which of the four angles).
 */
export function angleGeometry(a: P2, b: P2, c: P2, d: P2, rays: [number, number] = [1, 1]): { vertex: P2; u1: P2; u2: P2; degrees: number } | null {
  const d1: P2 = [b[0] - a[0], b[1] - a[1]];
  const d2: P2 = [d[0] - c[0], d[1] - c[1]];
  const l1 = Math.hypot(...d1);
  const l2 = Math.hypot(...d2);
  if (l1 < EPS || l2 < EPS) return null;
  const cr = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(cr) < 1e-9 * l1 * l2) return null;
  const t = ((c[0] - a[0]) * d2[1] - (c[1] - a[1]) * d2[0]) / cr;
  const vertex: P2 = [a[0] + d1[0] * t, a[1] + d1[1] * t];
  const u1: P2 = [(d1[0] / l1) * rays[0], (d1[1] / l1) * rays[0]];
  const u2: P2 = [(d2[0] / l2) * rays[1], (d2[1] / l2) * rays[1]];
  const degrees = (Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]))) * 180) / Math.PI;
  return { vertex, u1, u2, degrees };
}

/** An angle dimension's arms and arc radius (paper mm) for the pointer at `cursor` (all in sheet mm): the angle the pointer is in. */
export function placeAngle(a: P2, b: P2, c: P2, d: P2, cursor: P2): { rays: [number, number]; offset: number } | null {
  const g = angleGeometry(a, b, c, d);
  if (!g) return null;
  const w: P2 = [cursor[0] - g.vertex[0], cursor[1] - g.vertex[1]];
  const s = (u: P2) => (u[0] * w[0] + u[1] * w[1] >= 0 ? 1 : -1);
  return { rays: [s(g.u1), s(g.u2)], offset: Math.max(4, Math.round(Math.hypot(...w) * 10) / 10) };
}

export function dimLabel(dim: Dimension, value: number): string {
  const base =
    dim.type === "angle"
      ? `${Math.round(value * 10) / 10}°`
      : dim.type === "diameter"
        ? `Ø${formatSize(value)}`
        : dim.type === "radius"
          ? `R${formatSize(value)}`
          : formatSize(value);
  const t = dim.tolerance;
  const tol = !t ? "" : Math.abs(t.plus - t.minus) < 1e-9 ? ` ±${formatSize(t.plus)}` : ` +${formatSize(t.plus)}/−${formatSize(t.minus)}`;
  return `${dim.prefix ?? ""}${base}${tol}${dim.suffix ?? ""}`;
}

/** How far (paper mm) a number has to be lifted off its line before it counts as moved off it. */
const OFF_LINE = 1;

/**
 * Where a length dimension's line is (sheet mm): its ends, the direction it
 * runs, the way extension lines go, and which way is "up" for its number.
 */
export function dimensionLine(dim: Dimension, pa: P2, pb: P2): { along: P2; across: P2; la: P2; lb: P2; angle: number; up: P2 } {
  let along: P2;
  let across: P2;
  if (dim.type === "horizontal") {
    along = [1, 0];
    across = [0, 1];
  } else if (dim.type === "vertical") {
    along = [0, 1];
    across = [-1, 0];
  } else {
    const d = dist(pa, pb) || 1;
    along = [(pb[0] - pa[0]) / d, (pb[1] - pa[1]) / d];
    across = [-along[1], along[0]];
  }
  const h = (p: P2) => p[0] * across[0] + p[1] * across[1];
  // The line sits `offset` beyond the furthest point (or before the nearest, if negative).
  const base = dim.offset >= 0 ? Math.max(h(pa), h(pb)) + dim.offset : Math.min(h(pa), h(pb)) + dim.offset;
  const onLine = (p: P2): P2 => [p[0] + across[0] * (base - h(p)), p[1] + across[1] * (base - h(p))];
  const angle = readable((Math.atan2(along[1], along[0]) * 180) / Math.PI);
  const rad = (angle * Math.PI) / 180;
  // "Above" the line, as you'd read the text.
  const up: P2 = [-Math.sin(rad), Math.cos(rad)];
  return { along, across, la: onLine(pa), lb: onLine(pb), angle, up };
}

/**
 * Shift-dragging a length dimension's number: move just the number, anywhere
 * (the dimension line stays put). Returns how far along and off the line it is.
 */
export function dragDimensionText(dim: Dimension, a: P2, b: P2, cursor: P2): { textAlong: number; textAcross: number } {
  const { along, la, lb, up } = dimensionLine(dim, a, b);
  const mid: P2 = [(la[0] + lb[0]) / 2, (la[1] + lb[1]) / 2];
  const d: P2 = [cursor[0] - mid[0], cursor[1] - mid[1]];
  const r = (v: number) => Math.round(v * 10) / 10;
  const alongBy = d[0] * along[0] + d[1] * along[1];
  // The cursor holds the middle of the number.
  const acrossBy = d[0] * up[0] + d[1] * up[1] - 1.2 - TEXT_SIZE * 0.35;
  return { textAlong: Math.abs(alongBy) < 2 ? 0 : r(alongBy), textAcross: Math.abs(acrossBy) <= OFF_LINE ? 0 : r(acrossBy) };
}

/** A filled arrowhead with its tip at `tip`, pointing along `dir`. */
function arrow(tip: P2, dir: P2): Prim {
  const l = Math.hypot(dir[0], dir[1]) || 1;
  const u: P2 = [dir[0] / l, dir[1] / l];
  const back: P2 = [tip[0] - u[0] * ARROW, tip[1] - u[1] * ARROW];
  const w = ARROW / 6;
  return { kind: "path", points: [tip[0], tip[1], back[0] - u[1] * w, back[1] + u[0] * w, back[0] + u[1] * w, back[1] - u[0] * w], closed: true, fill: true, style: "thin" };
}

/** Text angle that reads left to right (or bottom to top). */
function readable(angle: number): number {
  let a = angle;
  while (a > 90) a -= 180;
  while (a <= -90) a += 180;
  return a;
}

export interface DimDrawing {
  prims: Prim[];
  /** Where the number sits on the sheet (for picking and dragging). */
  label: P2;
}

/**
 * Draw a dimension on the sheet. `at` turns a view point into sheet
 * millimetres; `value` is what it measures.
 */
export function drawDimension(dim: Dimension, r: ResolvedDim, at: (p: P2) => P2, value: number, callout?: string[] | null): DimDrawing {
  const text = dimLabel(dim, value);
  const prims: Prim[] = [];
  if (dim.type === "diameter" || dim.type === "radius") {
    // A hole callout: several lines stacked above the leader's shoulder (prefix on the first, suffix on the last).
    const lines = callout?.length ? callout.map((l, i, all) => `${i === 0 ? (dim.prefix ?? "") : ""}${l}${i === all.length - 1 ? (dim.suffix ?? "") : ""}`) : [text];
    const c = at(r.a);
    const edge = at([r.a[0] + (r.r ?? 0), r.a[1]]);
    const rad = dist(c, edge);
    const ang = ((dim.angle ?? 45) * Math.PI) / 180;
    const u: P2 = [Math.cos(ang), Math.sin(ang)];
    const onCircle: P2 = [c[0] + u[0] * rad, c[1] + u[1] * rad];
    const out = Math.max(dim.offset, 2);
    const elbow: P2 = [onCircle[0] + u[0] * out, onCircle[1] + u[1] * out];
    const side = u[0] >= 0 ? 1 : -1;
    const shoulder = 2 + Math.max(...lines.map((l) => l.length)) * TEXT_SIZE * 0.55;
    const end: P2 = [elbow[0] + side * shoulder, elbow[1]];
    const start: P2 = dim.type === "diameter" ? [c[0] - u[0] * rad, c[1] - u[1] * rad] : c;
    prims.push({ kind: "path", points: [start[0], start[1], elbow[0], elbow[1], end[0], end[1]], style: "thin" });
    prims.push(arrow(onCircle, [-u[0], -u[1]]));
    if (dim.type === "diameter") prims.push(arrow(start, u));
    const label: P2 = [(elbow[0] + end[0]) / 2, elbow[1] + 1];
    lines.forEach((l, i) => prims.push({ kind: "text", x: label[0], y: label[1] + (lines.length - 1 - i) * TEXT_SIZE * 1.5, text: l, size: TEXT_SIZE, anchor: "middle" }));
    return { prims, label };
  }

  if (dim.type === "angle" && r.b && r.c && r.d) {
    const [pa0, pb0, pc0, pd0] = [at(r.a), at(r.b), at(r.c), at(r.d)];
    const g = angleGeometry(pa0, pb0, pc0, pd0, dim.rays);
    if (g) {
      const R = Math.max(dim.offset, 4);
      let a1 = Math.atan2(g.u1[1], g.u1[0]);
      let a2 = Math.atan2(g.u2[1], g.u2[0]);
      // The shorter way round from one arm to the other.
      let sweep = a2 - a1;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep < -Math.PI) sweep += 2 * Math.PI;
      if (sweep < 0) [a1, a2, sweep] = [a2, a1, -sweep];
      const pts: number[] = [];
      const n = Math.max(6, Math.ceil(sweep / 0.08));
      for (let i = 0; i <= n; i++) {
        const t = a1 + (sweep * i) / n;
        pts.push(g.vertex[0] + R * Math.cos(t), g.vertex[1] + R * Math.sin(t));
      }
      prims.push({ kind: "path", points: pts, style: "thin" });
      const end1: P2 = [g.vertex[0] + R * Math.cos(a1), g.vertex[1] + R * Math.sin(a1)];
      const end2: P2 = [g.vertex[0] + R * Math.cos(a2), g.vertex[1] + R * Math.sin(a2)];
      prims.push(arrow(end1, [Math.sin(a1), -Math.cos(a1)]), arrow(end2, [-Math.sin(a2), Math.cos(a2)]));
      // Extension lines from each edge out to the arc where the arc passes beyond it.
      const extend = (p: P2, q: P2, end: P2, u: P2) => {
        const reach = Math.max(...[p, q].map((x) => (x[0] - g.vertex[0]) * u[0] + (x[1] - g.vertex[1]) * u[1]));
        if (reach < R - GAP) {
          const from: P2 = [g.vertex[0] + u[0] * (Math.max(reach, 0) + GAP), g.vertex[1] + u[1] * (Math.max(reach, 0) + GAP)];
          prims.push({ kind: "path", points: [from[0], from[1], end[0] + u[0] * 1.5, end[1] + u[1] * 1.5], style: "thin" });
        }
      };
      const arm1: P2 = [Math.cos(a1), Math.sin(a1)];
      const arm2: P2 = [Math.cos(a2), Math.sin(a2)];
      const firstIs1 = Math.abs(Math.atan2(g.u1[1], g.u1[0]) - a1) < 1e-9 || Math.abs(Math.abs(Math.atan2(g.u1[1], g.u1[0]) - a1) - 2 * Math.PI) < 1e-9;
      extend(firstIs1 ? pa0 : pc0, firstIs1 ? pb0 : pd0, end1, arm1);
      extend(firstIs1 ? pc0 : pa0, firstIs1 ? pd0 : pb0, end2, arm2);
      const mid = a1 + sweep / 2;
      const label: P2 = [g.vertex[0] + (R + 3) * Math.cos(mid), g.vertex[1] + (R + 3) * Math.sin(mid) - TEXT_SIZE * 0.35];
      prims.push({ kind: "text", x: label[0], y: label[1], text, size: TEXT_SIZE, anchor: "middle" });
      return { prims, label };
    }
  }

  const pa = at(r.a);
  const pb = at(r.b ?? r.a);
  if (dim.type === "ordinate") {
    // A leader from the point out to the side, with the distance from the datum at its end
    // (across: the leader runs up or down and the number reads upwards; up-and-down: it runs sideways).
    const vertical = dim.axis !== "v";
    const across: P2 = vertical ? [0, 1] : [-1, 0];
    const h = (p: P2) => p[0] * across[0] + p[1] * across[1];
    const base = dim.offset >= 0 ? Math.max(h(pa), h(pb)) + dim.offset : Math.min(h(pa), h(pb)) + dim.offset;
    const sign = Math.sign(base - h(pb)) || 1;
    const end: P2 = [pb[0] + across[0] * (base - h(pb)), pb[1] + across[1] * (base - h(pb))];
    const start: P2 = [pb[0] + across[0] * sign * GAP, pb[1] + across[1] * sign * GAP];
    prims.push({ kind: "path", points: [start[0], start[1], end[0], end[1]], style: "thin" });
    // The number just beyond the end of the leader, reading away from the part.
    const out: P2 = [across[0] * sign, across[1] * sign];
    const label: P2 = [end[0] + out[0] * 1, end[1] + out[1] * 1];
    if (vertical) {
      prims.push({ kind: "text", x: label[0] + TEXT_SIZE * 0.35, y: label[1], text, size: TEXT_SIZE, anchor: sign > 0 ? "start" : "end", rotate: 90 });
    } else {
      prims.push({ kind: "text", x: label[0], y: label[1] - TEXT_SIZE * 0.35, text, size: TEXT_SIZE, anchor: sign > 0 ? "end" : "start" });
    }
    return { prims, label };
  }
  const { along, across, la, lb, angle, up } = dimensionLine(dim, pa, pb);
  const sign = Math.sign(dim.offset) || 1;
  for (const [p, q] of [
    [pa, la],
    [pb, lb],
  ] as [P2, P2][]) {
    const len = dist(p, q);
    if (len < GAP) continue;
    const s: P2 = [p[0] + across[0] * sign * GAP, p[1] + across[1] * sign * GAP];
    const e: P2 = [q[0] + across[0] * sign * OVERSHOOT, q[1] + across[1] * sign * OVERSHOOT];
    prims.push({ kind: "path", points: [s[0], s[1], e[0], e[1]], style: "thin" });
  }
  prims.push({ kind: "path", points: [la[0], la[1], lb[0], lb[1]], style: "thin" });
  const dir: P2 = [lb[0] - la[0], lb[1] - la[1]];
  if (Math.hypot(dir[0], dir[1]) > 2 * ARROW) {
    prims.push(arrow(la, [-dir[0], -dir[1]]), arrow(lb, dir));
  } else {
    // Too short for arrows inside: point them in from outside.
    prims.push(arrow(la, dir), arrow(lb, [-dir[0], -dir[1]]));
  }
  // The number sits in the middle, unless it's been slid along the line (it can go past the ends:
  // the dimension line then carries on out to it) or moved off it (a thin leader joins it back).
  const shift = dim.textAlong ?? 0;
  const lift = dim.textAcross ?? 0;
  const mid: P2 = [(la[0] + lb[0]) / 2 + along[0] * shift, (la[1] + lb[1]) / 2 + along[1] * shift];
  const offLine = Math.abs(lift) > OFF_LINE;
  if (offLine) {
    // From the nearest point of the dimension line to the near edge of the number.
    const t = (p: P2) => (p[0] - la[0]) * along[0] + (p[1] - la[1]) * along[1];
    const len = t(lb);
    const k = Math.max(Math.min(t(mid), Math.max(len, 0)), Math.min(len, 0));
    const foot: P2 = [la[0] + along[0] * k, la[1] + along[1] * k];
    const reach = lift > 0 ? lift + 0.6 : lift + 1.2 + TEXT_SIZE * 0.9;
    const tip: P2 = [mid[0] + up[0] * reach, mid[1] + up[1] * reach];
    prims.push({ kind: "path", points: [foot[0], foot[1], tip[0], tip[1]], style: "thin" });
  } else if (shift !== 0) {
    const t = (p: P2) => p[0] * along[0] + p[1] * along[1];
    const lo = Math.min(t(la), t(lb));
    const hi = Math.max(t(la), t(lb));
    const half = (text.length * TEXT_SIZE * 0.55) / 2 + 1;
    const tm = t(mid);
    const from = tm - half < lo ? tm - half : tm + half > hi ? tm + half : null;
    if (from !== null) {
      const edge = from < lo ? lo : hi;
      const at = (v: number): P2 => [la[0] + along[0] * (v - t(la)), la[1] + along[1] * (v - t(la))];
      const [p, q] = [at(edge), at(from)];
      prims.push({ kind: "path", points: [p[0], p[1], q[0], q[1]], style: "thin" });
    }
  }
  const raise = 1.2 + (offLine ? lift : 0);
  const label: P2 = [mid[0] + up[0] * raise, mid[1] + up[1] * raise];
  prims.push({ kind: "text", x: label[0], y: label[1], text, size: TEXT_SIZE, anchor: "middle", ...(angle !== 0 ? { rotate: angle } : {}) });
  return { prims, label };
}

/**
 * Which kind of length dimension, and how far out, for points a and b (sheet
 * mm) and where the pointer is: above or below them gives a horizontal one,
 * beside them a vertical one, and in between a slanted (aligned) one.
 */
export function placeLength(a: P2, b: P2, cursor: P2, force?: "horizontal" | "vertical"): { type: "horizontal" | "vertical" | "aligned"; offset: number } {
  const minX = Math.min(a[0], b[0]);
  const maxX = Math.max(a[0], b[0]);
  const minY = Math.min(a[1], b[1]);
  const maxY = Math.max(a[1], b[1]);
  const flatX = maxX - minX < 1e-6;
  const flatY = maxY - minY < 1e-6;
  const horizontal = () => ({ type: "horizontal" as const, offset: cursor[1] >= maxY ? cursor[1] - maxY : cursor[1] < minY ? cursor[1] - minY : 8 });
  // Vertical dimension lines are measured with "across" pointing left (−x).
  const vertical = () => ({ type: "vertical" as const, offset: cursor[0] <= minX ? minX - cursor[0] : cursor[0] > maxX ? maxX - cursor[0] : 8 });
  if (force === "horizontal") return horizontal();
  if (force === "vertical") return vertical();
  if (flatY && !flatX) return horizontal();
  if (flatX && !flatY) return vertical();
  const outY = cursor[1] > maxY ? cursor[1] - maxY : cursor[1] < minY ? minY - cursor[1] : 0;
  const outX = cursor[0] > maxX ? cursor[0] - maxX : cursor[0] < minX ? minX - cursor[0] : 0;
  if (outY > 0 || outX > 0) return outY >= outX ? horizontal() : vertical();
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const across: P2 = [-(b[1] - a[1]) / d, (b[0] - a[0]) / d];
  const h = (p: P2) => p[0] * across[0] + p[1] * across[1];
  const t = h(cursor) - Math.max(h(a), h(b));
  return { type: "aligned", offset: t >= 0 ? t : h(cursor) - Math.min(h(a), h(b)) };
}

/** New offset (and leader angle for circles) when a dimension's number is dragged to `cursor` (sheet mm). */
export function dragDimension(
  dim: Dimension,
  a: P2,
  b: P2 | null,
  rad: number,
  cursor: P2,
  cd?: [P2, P2] | null,
): { offset: number; angle?: number; textAlong?: number; rays?: [number, number] } {
  if (dim.type === "angle" && b && cd) {
    const p = placeAngle(a, b, cd[0], cd[1], cursor);
    if (p) return p;
  }
  if (dim.type === "diameter" || dim.type === "radius") {
    const angle = (Math.atan2(cursor[1] - a[1], cursor[0] - a[0]) * 180) / Math.PI;
    return { offset: Math.max(2, Math.round((dist(cursor, a) - rad) * 10) / 10), angle: Math.round(angle) };
  }
  const q = b ?? a;
  const r = (v: number) => Math.round(v * 10) / 10;
  // Lengths: the number also slides along the line (snapping back to the middle near it).
  const slide = (dir: P2) => {
    const v = (cursor[0] - (a[0] + q[0]) / 2) * dir[0] + (cursor[1] - (a[1] + q[1]) / 2) * dir[1];
    return Math.abs(v) < 2 ? 0 : r(v);
  };
  if (dim.type === "horizontal" || (dim.type === "ordinate" && dim.axis !== "v")) {
    const minY = Math.min(a[1], q[1]);
    const maxY = Math.max(a[1], q[1]);
    const offset = r(cursor[1] >= (minY + maxY) / 2 ? cursor[1] - maxY : cursor[1] - minY);
    return dim.type === "ordinate" ? { offset } : { offset, textAlong: slide([1, 0]) };
  }
  if (dim.type === "vertical" || dim.type === "ordinate") {
    const minX = Math.min(a[0], q[0]);
    const maxX = Math.max(a[0], q[0]);
    const offset = r(cursor[0] <= (minX + maxX) / 2 ? minX - cursor[0] : maxX - cursor[0]);
    return dim.type === "ordinate" ? { offset } : { offset, textAlong: slide([0, 1]) };
  }
  const d = dist(a, q) || 1;
  const across: P2 = [-(q[1] - a[1]) / d, (q[0] - a[0]) / d];
  return { offset: r(cursor[0] * across[0] + cursor[1] * across[1] - (a[0] * across[0] + a[1] * across[1])), textAlong: slide([(q[0] - a[0]) / d, (q[1] - a[1]) / d]) };
}

// ---------------------------------------------------------------------------
// Smart dimensioning: what two clicks measure (like Onshape's single Dimension tool)

/** Something clicked on a view: a corner or end, an edge, or a circle. */
export type DimTarget = { kind: "point"; at: P2 } | { kind: "line"; a: P2; b: P2 } | { kind: "circle"; centre: P2; r: number; full: boolean };

const EPS = 1e-6;
const isFlat = (l: { a: P2; b: P2 }) => Math.abs(l.b[1] - l.a[1]) < EPS * Math.max(1, dist(l.a, l.b));
const isUpright = (l: { a: P2; b: P2 }) => Math.abs(l.b[0] - l.a[0]) < EPS * Math.max(1, dist(l.a, l.b));
const nearerEnd = (l: { a: P2; b: P2 }, p: P2): P2 => (dist(l.a, p) <= dist(l.b, p) ? l.a : l.b);
const pointOf = (t: DimTarget): P2 | null => (t.kind === "point" ? t.at : t.kind === "circle" ? t.centre : null);

/** True when two clicks picked the same thing. */
export function sameTarget(x: DimTarget, y: DimTarget): boolean {
  if (x.kind !== y.kind) return false;
  if (x.kind === "point" && y.kind === "point") return dist(x.at, y.at) < EPS;
  if (x.kind === "circle" && y.kind === "circle") return dist(x.centre, y.centre) < EPS && Math.abs(x.r - y.r) < EPS;
  if (x.kind === "line" && y.kind === "line") return (dist(x.a, y.a) < EPS && dist(x.b, y.b) < EPS) || (dist(x.a, y.b) < EPS && dist(x.b, y.a) < EPS);
  return false;
}

/**
 * The distance two clicked things make: between two points or hole centres;
 * from a point or hole centre straight across to a level or upright edge;
 * or between two parallel level (or upright) edges. Returns the two points
 * to dimension between and which way to measure, or why it can't.
 */
export function pairFor(first: DimTarget, second: DimTarget): { a: P2; b: P2; force?: "horizontal" | "vertical" } | { error: string } {
  const p1 = pointOf(first);
  const p2 = pointOf(second);
  if (p1 && p2) return dist(p1, p2) < EPS ? { error: "Those are in the same place — click something else." } : { a: p1, b: p2 };
  const slanted = "For a slanted edge, click its end points instead.";
  if (first.kind === "line" && second.kind === "line") {
    // The two ends nearest each other, so the extension lines are short.
    const ends = [first.a, first.b].flatMap((p) => [second.a, second.b].map((q) => [p, q] as [P2, P2]));
    const [a, b] = ends.reduce((m, e) => (dist(e[0], e[1]) < dist(m[0], m[1]) ? e : m));
    if (isFlat(first) && isFlat(second)) return { a, b, force: "vertical" };
    if (isUpright(first) && isUpright(second)) return { a, b, force: "horizontal" };
    return { error: "Those edges aren't parallel. Click two level or two upright edges, or their corners." };
  }
  const line = first.kind === "line" ? first : (second as { kind: "line"; a: P2; b: P2 });
  const p = (p1 ?? p2)!;
  if (isFlat(line)) return { a: p, b: nearerEnd(line, p), force: "vertical" };
  if (isUpright(line)) return { a: p, b: nearerEnd(line, p), force: "horizontal" };
  return { error: slanted };
}
