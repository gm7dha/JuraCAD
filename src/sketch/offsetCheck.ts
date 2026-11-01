/**
 * Offset copies that cross themselves: offsetting a shape too far inwards
 * (or a curve too far on the inside of a tight bend) makes the copy fold
 * back over itself — loops, corners crossing over, or a side turned the
 * wrong way round. The offset is kept (it may be what was wanted while
 * sketching), but the sketch panel says so in plain English.
 *
 * Pure: a sketch in, notes out. Cheap enough to run on every change: the
 * copies are laid out as short straight pieces and only pieces whose boxes
 * overlap are compared (sorted by their left edges).
 */
import { curveParam } from "./curves";
import { offsetWarnings } from "./solver";
import type { SketchConstraint, SketchCurve, SketchData } from "./types";

type P2 = [number, number];
const TAU = 2 * Math.PI;

/** More short pieces than this in one offset aren't checked (it would slow every change down). */
const MAX_PIECES = 20000;

/** A short straight piece of a copy: its ends, and which copy and how far along it it is. */
interface Piece {
  a: P2;
  b: P2;
  curve: number;
  k: number;
  x0: number;
  x1: number;
}

const near = (p: P2, q: P2) => Math.abs(p[0] - q[0]) <= 1e-9 && Math.abs(p[1] - q[1]) <= 1e-9;

/** Do two short pieces cross (or overlap), other than where they share an end? */
function piecesCross(p: Piece, q: Piece): boolean {
  if (near(p.a, q.a) || near(p.a, q.b) || near(p.b, q.a) || near(p.b, q.b)) return false;
  const r: P2 = [p.b[0] - p.a[0], p.b[1] - p.a[1]];
  const e: P2 = [q.b[0] - q.a[0], q.b[1] - q.a[1]];
  const w: P2 = [q.a[0] - p.a[0], q.a[1] - p.a[1]];
  const den = r[0] * e[1] - r[1] * e[0];
  const size = Math.max(Math.hypot(...r), Math.hypot(...e), 1e-12);
  if (Math.abs(den) < 1e-12 * size * size) {
    // Lying along each other: crossing if they're on one line and overlap.
    if (Math.abs(w[0] * r[1] - w[1] * r[0]) > 1e-9 * size) return false;
    const rr = r[0] * r[0] + r[1] * r[1];
    if (rr < 1e-24) return false;
    const t0 = (w[0] * r[0] + w[1] * r[1]) / rr;
    const t1 = t0 + (e[0] * r[0] + e[1] * r[1]) / rr;
    return Math.max(t0, t1) > 1e-9 && Math.min(t0, t1) < 1 - 1e-9;
  }
  const t = (w[0] * e[1] - w[1] * e[0]) / den;
  const u = (w[0] * r[1] - w[1] * r[0]) / den;
  return t > -1e-12 && t < 1 + 1e-12 && u > -1e-12 && u < 1 + 1e-12;
}

/** The copies of one offset dimension, with what each was copied from. */
function copiesOf(s: SketchData, k: SketchConstraint): { copy: SketchCurve; orig: SketchCurve }[] {
  const out: { copy: SketchCurve; orig: SketchCurve }[] = [];
  for (let i = 0; i + 1 < k.refs.length; i += 2) {
    const copy = s.curves.find((c) => c.id === k.refs[i]);
    const orig = s.curves.find((c) => c.id === k.refs[i + 1]);
    if (copy && orig) out.push({ copy, orig });
  }
  return out;
}

const pos = (s: SketchData, id: string): P2 => {
  const p = s.points.find((q) => q.id === id);
  return p ? [p.x, p.y] : [0, 0];
};

/** How far round an arc goes (radians, anticlockwise from start to end). */
function sweepOf(s: SketchData, c: Extract<SketchCurve, { type: "arc" }>): number {
  const o = pos(s, c.center);
  const a = pos(s, c.start), b = pos(s, c.end);
  let sw = Math.atan2(b[1] - o[1], b[0] - o[0]) - Math.atan2(a[1] - o[1], a[0] - o[0]);
  while (sw <= 0) sw += TAU;
  return sw;
}

/** Has a copy turned the wrong way round (a line running backwards, or an arc going the long way round)? */
function turnedOver(s: SketchData, copy: SketchCurve, orig: SketchCurve): boolean {
  if (copy.type === "line" && orig.type === "line") {
    const a = pos(s, copy.p1), b = pos(s, copy.p2), c = pos(s, orig.p1), d = pos(s, orig.p2);
    return (b[0] - a[0]) * (d[0] - c[0]) + (b[1] - a[1]) * (d[1] - c[1]) < -1e-12;
  }
  if (copy.type === "arc" && orig.type === "arc") return Math.abs(sweepOf(s, copy) - sweepOf(s, orig)) > Math.PI;
  return false;
}

/** Does this offset's copy (all its pieces together) cross itself or fold back? */
export function offsetCrossesItself(s: SketchData, k: SketchConstraint): boolean {
  const pairs = copiesOf(s, k);
  if (pairs.some(({ copy, orig }) => turnedOver(s, copy, orig))) return true;
  const pieces: Piece[] = [];
  for (let ci = 0; ci < pairs.length; ci++) {
    const c = pairs[ci].copy;
    // A circle (or whole ellipse) copy can't cross itself.
    if (c.type === "circle" || (c.type === "ellipse" && !c.start)) continue;
    let path: P2[];
    try {
      const p = curveParam(s, c);
      path = (c.type === "line" ? [p.lo, p.hi] : p.samples).map((u) => p.at(u));
    } catch {
      continue;
    }
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i], b = path[i + 1];
      if (near(a, b)) continue;
      pieces.push({ a, b, curve: ci, k: i, x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]) });
    }
    if (pieces.length > MAX_PIECES) return false;
  }
  pieces.sort((p, q) => p.x0 - q.x0);
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const y0 = Math.min(p.a[1], p.b[1]), y1 = Math.max(p.a[1], p.b[1]);
    for (let j = i + 1; j < pieces.length && pieces[j].x0 <= p.x1 + 1e-9; j++) {
      const q = pieces[j];
      // Neighbours along the same copy meet at their shared end.
      if (q.curve === p.curve && Math.abs(q.k - p.k) === 1) continue;
      if (Math.max(q.a[1], q.b[1]) < y0 - 1e-9 || Math.min(q.a[1], q.b[1]) > y1 + 1e-9) continue;
      if (piecesCross(p, q)) return true;
    }
  }
  return false;
}

/** What to say about an offset copy that crosses itself. */
export const CROSSING_NOTE =
  "An offset copy crosses over itself: the distance is too big for the shape in places, so it folds back on itself and won't make a clean outline. Use a smaller distance, or offset to the other side.";

/**
 * Every plain-English note about the sketch's offset copies: ones that can't
 * follow their original any more (offsetWarnings), and ones that cross themselves.
 */
export function offsetNotes(s: SketchData): string[] {
  if (!s.constraints.some((k) => k.type === "offset")) return [];
  const crossing = s.constraints.some((k) => k.type === "offset" && offsetCrossesItself(s, k));
  // A copy offset past its original's tightest bend folds back there: saying it crosses itself covers that.
  return crossing ? [CROSSING_NOTE] : offsetWarnings(s);
}
