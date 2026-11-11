/**
 * Thin (Onshape's "Thin" option on Extrude, Revolve and Sweep): instead of
 * filling a sketch's closed shapes, make a wall of a set thickness along its
 * lines and curves. Pure 2D: each run of curves (open or closed, from
 * `findChains`) is offset in the sketch plane to each side, and the two sides
 * joined into closed outlines — an open run gets square-cut ends, a closed one
 * becomes a ring (an outer and an inner loop). Corners stay sharp (the offset
 * pieces are carried on until they meet, as Onshape does), arcs stay arcs.
 * Each run comes back as a sketch of its own (plain lines, arcs and circles
 * with no relations) that the ordinary solid code extrudes, revolves or
 * sweeps; the walls of separate runs are then joined.
 */
import { findChains, type Chain, type Pt, type Segment } from "./regions";
import { matchArea, missingAreasMessage, sketchAreas, type AreaPick } from "./areas";
import type { SketchArc, SketchCircle, SketchCurve, SketchData, SketchLine, SketchPoint } from "./types";

/** How thick the wall is and which way it goes, as the dialog sets it. */
export interface ThinSides {
  /** Thickness on the first side (the whole thickness, centred, with `midPlane`). */
  thickness: number;
  /** Thickness on the other side (unused with `midPlane`). */
  thickness2: number;
  /** Centred on the curves: half the thickness each side. */
  midPlane?: boolean;
  /** Swap the two sides. */
  flip?: boolean;
}

/**
 * The amounts each side of a run, as [left, right] of the way it's walked.
 * Open runs are walked from the end nearest the bottom left (lowest x, then
 * lowest y), so a line drawn left to right has its first side above it;
 * closed runs anticlockwise, so their first side is inside.
 */
export function thinAmounts(s: ThinSides): [number, number] {
  const [a, b] = s.midPlane ? [s.thickness / 2, s.thickness / 2] : [s.thickness, s.thickness2];
  return s.flip ? [b, a] : [a, b];
}

/** A piece of a run: a straight line, or an arc round `c` from angle `a0` by `sweep` (radians, + anticlockwise). */
export type Prim = { kind: "line"; a: Pt; b: Pt } | { kind: "arc"; c: Pt; r: number; a0: number; sweep: number };

const TAU = 2 * Math.PI;
const sub = (p: Pt, q: Pt): Pt => [p[0] - q[0], p[1] - q[1]];
const add = (p: Pt, q: Pt): Pt => [p[0] + q[0], p[1] + q[1]];
const mul = (p: Pt, k: number): Pt => [p[0] * k, p[1] * k];
const cross = (p: Pt, q: Pt) => p[0] * q[1] - p[1] * q[0];
const dotp = (p: Pt, q: Pt) => p[0] * q[0] + p[1] * q[1];
const dist = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const unit = (p: Pt): Pt => {
  const l = Math.hypot(p[0], p[1]);
  return [p[0] / l, p[1] / l];
};
/** An angle wrapped into (−π, π]. */
const wrap = (a: number) => {
  let x = a % TAU;
  if (x <= -Math.PI) x += TAU;
  if (x > Math.PI) x -= TAU;
  return x;
};

export const primStart = (p: Prim): Pt => (p.kind === "line" ? p.a : [p.c[0] + p.r * Math.cos(p.a0), p.c[1] + p.r * Math.sin(p.a0)]);
export const primEnd = (p: Prim): Pt => (p.kind === "line" ? p.b : [p.c[0] + p.r * Math.cos(p.a0 + p.sweep), p.c[1] + p.r * Math.sin(p.a0 + p.sweep)]);
/** The direction of travel at an angle round an arc. */
const arcTangent = (p: Extract<Prim, { kind: "arc" }>, angle: number): Pt => {
  const s = Math.sign(p.sweep) || 1;
  return [-Math.sin(angle) * s, Math.cos(angle) * s];
};
const startDir = (p: Prim): Pt => (p.kind === "line" ? unit(sub(p.b, p.a)) : arcTangent(p, p.a0));
const endDir = (p: Prim): Pt => (p.kind === "line" ? unit(sub(p.b, p.a)) : arcTangent(p, p.a0 + p.sweep));
const reversed = (p: Prim): Prim => (p.kind === "line" ? { kind: "line", a: p.b, b: p.a } : { ...p, a0: p.a0 + p.sweep, sweep: -p.sweep });

/** The thin wall only knows lines, arcs and circles: anything else is refused in plain words. */
export class ThinError extends Error {}

/** A run's pieces as lines and arcs (a whole circle comes back as null: it's handled on its own). */
export function primsOf(segments: Segment[]): Prim[] | null {
  const out: Prim[] = [];
  for (const s of segments) {
    if (s.kind === "line") {
      if (dist(s.from, s.to) > 1e-9) out.push({ kind: "line", a: s.from, b: s.to });
    } else if (s.kind === "arc") {
      const c = circumcentre(s.from, s.mid, s.to);
      if (!c) {
        out.push({ kind: "line", a: s.from, b: s.to });
        continue;
      }
      const r = dist(c, s.from);
      const ccw = cross(sub(s.mid, s.from), sub(s.to, s.mid)) > 0;
      const a0 = Math.atan2(s.from[1] - c[1], s.from[0] - c[0]);
      const a1 = Math.atan2(s.to[1] - c[1], s.to[0] - c[0]);
      let sweep = a1 - a0;
      if (ccw) while (sweep <= 0) sweep += TAU;
      else while (sweep >= 0) sweep -= TAU;
      out.push({ kind: "arc", c, r, a0, sweep });
    } else if (s.kind === "circle") {
      return null;
    } else {
      throw new ThinError("A thin wall can follow lines, arcs and circles, but not splines or ellipses yet. Draw the shape with lines and arcs instead.");
    }
  }
  return out;
}

function circumcentre(a: Pt, b: Pt, c: Pt): Pt | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}

/** A piece moved `d` to its left (minus: to its right), not yet trimmed at its ends. */
function shifted(p: Prim, d: number): Prim {
  if (p.kind === "line") {
    const t = unit(sub(p.b, p.a));
    const n: Pt = [-t[1] * d, t[0] * d];
    return { kind: "line", a: add(p.a, n), b: add(p.b, n) };
  }
  // Going anticlockwise, the left is towards the centre.
  const r = p.sweep > 0 ? p.r - d : p.r + d;
  if (r <= 1e-6) throw new ThinError(`The wall is too thick for an arc of radius ${round(p.r)} mm: it would close up on its centre. Make it thinner than ${round(p.r)} mm on that side, or the arc bigger.`);
  return { ...p, r };
}

const round = (x: number) => String(Math.round(x * 1000) / 1000);

/** Where two pieces, carried on as whole lines and circles, cross: every place. */
function crossings(p: Prim, q: Prim): Pt[] {
  if (p.kind === "line" && q.kind === "line") {
    const r = sub(p.b, p.a);
    const s = sub(q.b, q.a);
    const den = cross(r, s);
    if (Math.abs(den) < 1e-12 * Math.hypot(...r) * Math.hypot(...s)) return [];
    const t = cross(sub(q.a, p.a), s) / den;
    return [add(p.a, mul(r, t))];
  }
  if (p.kind === "arc" && q.kind === "arc") return circleCircle(p.c, p.r, q.c, q.r);
  const l = (p.kind === "line" ? p : q) as Extract<Prim, { kind: "line" }>;
  const c = (p.kind === "arc" ? p : q) as Extract<Prim, { kind: "arc" }>;
  return lineCircle(l.a, l.b, c.c, c.r);
}

function lineCircle(a: Pt, b: Pt, c: Pt, r: number): Pt[] {
  const d = unit(sub(b, a));
  const f = sub(a, c);
  const t0 = -dotp(f, d);
  const foot = add(a, mul(d, t0));
  const h2 = r * r - dotp(sub(foot, c), sub(foot, c));
  if (h2 < -1e-9 * r * r) return [];
  const h = Math.sqrt(Math.max(0, h2));
  return [add(foot, mul(d, h)), add(foot, mul(d, -h))];
}

function circleCircle(c1: Pt, r1: number, c2: Pt, r2: number): Pt[] {
  const d = dist(c1, c2);
  if (d < 1e-12) return [];
  if (d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const e = mul(sub(c2, c1), 1 / d);
  const m = add(c1, mul(e, a));
  return [add(m, [-e[1] * h, e[0] * h]), add(m, [e[1] * h, -e[0] * h])];
}

/** A piece with its start (or end) moved to `x`, a point on its line or circle. */
function withStart(p: Prim, x: Pt): Prim {
  if (p.kind === "line") return { ...p, a: x };
  const a = Math.atan2(x[1] - p.c[1], x[0] - p.c[0]);
  const delta = wrap(a - p.a0);
  return { ...p, a0: p.a0 + delta, sweep: p.sweep - delta };
}
function withEnd(p: Prim, x: Pt): Prim {
  if (p.kind === "line") return { ...p, b: x };
  const a = Math.atan2(x[1] - p.c[1], x[0] - p.c[0]);
  const delta = wrap(a - (p.a0 + p.sweep));
  return { ...p, sweep: p.sweep + delta };
}

/** Has trimming turned a piece round (a corner ate it up)? */
function turnedRound(before: Prim, after: Prim): boolean {
  if (before.kind === "line" && after.kind === "line") {
    const d = sub(after.b, after.a);
    return Math.hypot(...d) < 1e-7 || dotp(d, sub(before.b, before.a)) <= 0;
  }
  if (before.kind === "arc" && after.kind === "arc") return Math.abs(after.sweep) < 1e-9 || Math.sign(after.sweep) !== Math.sign(before.sweep) || Math.abs(after.sweep) >= TAU;
  return false;
}

/**
 * How far past a corner the outside of a wall may reach (× its thickness) before the corner is cut off square
 * instead — very sharp corners, as Onshape does.
 */
export const MITRE_LIMIT = 4;

/** A run's pieces moved to one side, and the short straight pieces (as points) that join some of them where a sharp corner was cut off. */
interface Offset {
  pieces: Prim[];
  /** After piece i: the corner points of a cut-off corner, in order (an empty list = one straight join). */
  bridges: Map<number, Pt[]>;
}

/**
 * A run moved `d` to its left (minus: right), corners joined sharp: each pair
 * of neighbouring pieces is carried on (or cut back) to where they meet, the
 * meeting point nearest the corner; an outside corner that would reach more
 * than `MITRE_LIMIT` × d past the corner is cut off square there, and pieces
 * that can't meet are joined by a straight piece.
 */
function offsetPieces(prims: Prim[], d: number, closed: boolean): Offset {
  if (Math.abs(d) < 1e-12) return { pieces: prims.slice(), bridges: new Map() };
  const moved = prims.map((p) => shifted(p, d));
  const out: Prim[] = moved.slice();
  const bridges = new Map<number, Pt[]>();
  const joints = closed ? prims.length : prims.length - 1;
  for (let i = 0; i < joints; i++) {
    const j = (i + 1) % prims.length;
    const corner = primEnd(prims[i]);
    const t1 = endDir(prims[i]);
    const t2 = startDir(prims[j]);
    const turn = cross(t1, t2);
    if (Math.abs(turn) < 1e-9 && dotp(t1, t2) > 0) {
      // Smooth: both offsets end at the same place (corner + d × the shared normal).
      const x = mul(add(primEnd(out[i]), primStart(out[j])), 0.5);
      out[i] = withEnd(out[i], x);
      out[j] = withStart(out[j], x);
      continue;
    }
    if (Math.abs(turn) < 1e-9) throw new ThinError("The sketch's lines double back on themselves at a corner, so there's no wall to make there. Separate the lines a little.");
    // On this side the corner opens out (the outside of the turn) or closes up (the inside).
    const opens = turn * d < 0;
    const best = crossings(out[i], out[j]).sort((p, q) => dist(p, corner) - dist(q, corner))[0];
    if (best && (!opens || dist(best, corner) <= MITRE_LIMIT * Math.abs(d) + 1e-9)) {
      out[i] = withEnd(out[i], best);
      out[j] = withStart(out[j], best);
      continue;
    }
    bridges.set(i, opens ? squareCut(primEnd(out[i]), t1, primStart(out[j]), t2, corner, best, d) : []);
  }
  for (let i = 0; i < out.length; i++) {
    if (turnedRound(moved[i], out[i])) {
      throw new ThinError("The wall is too thick for one of the short pieces of the sketch: the corners on either side of it meet. Make the wall thinner or that piece longer.");
    }
  }
  return { pieces: out, bridges };
}

/**
 * An outside corner cut off square `MITRE_LIMIT` × d from the corner: the two offset pieces carried on along
 * their directions to the cut. No points (a plain straight join) when that can't be done.
 */
function squareCut(end: Pt, t1: Pt, start: Pt, t2: Pt, corner: Pt, tip: Pt | undefined, d: number): Pt[] {
  const away = tip && dist(tip, corner) > 1e-9 ? unit(sub(tip, corner)) : unit(add(sub(end, corner), sub(start, corner)));
  if (!Number.isFinite(away[0])) return [];
  const c = MITRE_LIMIT * Math.abs(d);
  const a1 = dotp(t1, away);
  const a2 = dotp(t2, away);
  if (a1 < 1e-9 || a2 > -1e-9) return [];
  const s1 = (c - dotp(sub(end, corner), away)) / a1;
  const s2 = (dotp(sub(start, corner), away) - c) / a2;
  if (s1 < 0 || s2 < 0) return [];
  return [add(end, mul(t1, s1)), sub(start, mul(t2, s2))];
}

/** The pieces in order with their joins, as one list. */
function assemble(o: Offset): Prim[] {
  const all: Prim[] = [];
  o.pieces.forEach((p, i) => {
    all.push(p);
    const b = o.bridges.get(i);
    if (!b) return;
    const pts = [primEnd(p), ...b, primStart(o.pieces[(i + 1) % o.pieces.length])];
    all.push(...linesThrough(pts));
  });
  return all;
}

/** Straight pieces through points in turn (repeats skipped). */
function linesThrough(pts: Pt[]): Prim[] {
  const out: Prim[] = [];
  for (let k = 0; k + 1 < pts.length; k++) if (dist(pts[k], pts[k + 1]) > 1e-9) out.push({ kind: "line", a: pts[k], b: pts[k + 1] });
  return out;
}

/** A run moved `d` to its left (minus: right), corners joined sharp (see `offsetPieces`). */
export function offsetRun(prims: Prim[], d: number, closed: boolean): Prim[] {
  return assemble(offsetPieces(prims, d, closed));
}

/** Points round a run of pieces, for checking (arcs every 5° or so). */
function sampled(prims: Prim[]): Pt[] {
  const pts: Pt[] = [];
  for (const p of prims) {
    if (p.kind === "line") pts.push(p.a);
    else {
      const n = Math.max(4, Math.ceil(Math.abs(p.sweep) / (Math.PI / 36)));
      for (let k = 0; k < n; k++) {
        const a = p.a0 + (p.sweep * k) / n;
        pts.push([p.c[0] + p.r * Math.cos(a), p.c[1] + p.r * Math.sin(a)]);
      }
    }
  }
  return pts;
}

/** Does a closed outline cross itself (or another, when given)? Touching neighbours don't count. */
function outlineCrosses(a: Pt[], b?: Pt[]): boolean {
  const other = b ?? a;
  const scale = Math.max(1, ...a.map((p) => Math.max(Math.abs(p[0]), Math.abs(p[1]))));
  const eps = 1e-7 * scale;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const p2 = a[(i + 1) % a.length];
    for (let j = b ? 0 : i + 2; j < other.length; j++) {
      if (!b && i === 0 && j === other.length - 1) continue;
      const q = other[j];
      const q2 = other[(j + 1) % other.length];
      if (Math.max(p[0], p2[0]) < Math.min(q[0], q2[0]) - eps || Math.max(q[0], q2[0]) < Math.min(p[0], p2[0]) - eps) continue;
      if (Math.max(p[1], p2[1]) < Math.min(q[1], q2[1]) - eps || Math.max(q[1], q2[1]) < Math.min(p[1], p2[1]) - eps) continue;
      const r = sub(p2, p);
      const s = sub(q2, q);
      const den = cross(r, s);
      if (Math.abs(den) < 1e-15) continue;
      const t = cross(sub(q, p), s) / den;
      const u = cross(sub(q, p), r) / den;
      if (t > 1e-7 && t < 1 - 1e-7 && u > 1e-7 && u < 1 - 1e-7) return true;
    }
  }
  return false;
}

const TOO_THICK = "The wall is too thick for this shape: its sides would run into each other. Make it thinner.";

/** One closed outline of the wall, as lines and arcs (a whole circle: `circle`). */
export type ThinLoop = { prims: Prim[] } | { circle: { c: Pt; r: number } };

/** A run turned to go the other way. */
const backwards = (prims: Prim[]) => prims.slice().reverse().map(reversed);

/** The end nearest the bottom left first (lowest x, then lowest y). */
function fromBottomLeft(prims: Prim[]): Prim[] {
  const s = primStart(prims[0]);
  const e = primEnd(prims[prims.length - 1]);
  return e[0] < s[0] - 1e-9 || (Math.abs(e[0] - s[0]) <= 1e-9 && e[1] < s[1]) ? backwards(prims) : prims;
}

/** The two loops of a closed run's wall (its left side `left`, right `right`); checked. */
function ringLoops(prims: Prim[], left: number, right: number, mustTurn: 1 | -1): ThinLoop[] {
  const l = offsetRun(prims, left, true);
  const r = offsetRun(prims, -right, true);
  const loops = [l, r].map((x) => sampled(x));
  if (loops.some((x) => outlineCrosses(x)) || outlineCrosses(loops[0], loops[1])) throw new ThinError(TOO_THICK);
  // Neither side may have turned inside out.
  if (signedArea(loops[0]) * mustTurn <= 1e-9 || signedArea(loops[1]) * mustTurn <= 1e-9) throw new ThinError(TOO_THICK);
  return [{ prims: r }, { prims: l }];
}

/** A whole circle's ring: `inside` mm inwards, `outside` outwards. */
function circleRing(c: Extract<Segment, { kind: "circle" }>, inside: number, outside: number): ThinLoop[] {
  const inner = c.radius - inside;
  if (inner <= 1e-6) throw new ThinError(`The wall is too thick for a circle of radius ${round(c.radius)} mm: it would fill the middle. Make it thinner than ${round(c.radius)} mm on the inside (or flip it outside).`);
  return [{ circle: { c: c.center, r: c.radius + outside } }, { circle: { c: c.center, r: inner } }];
}

function checkAmounts([left, right]: [number, number]) {
  if (left < 0 || right < 0) throw new ThinError("The wall's thicknesses can't be less than 0.");
  if (left + right <= 1e-9) throw new ThinError("Give the wall a thickness (more than 0).");
}

/**
 * The closed outlines of the wall round one run on its own: for an open run one loop (its left offset, a square
 * end, its right offset back, a square end), walked from its bottom-left end; for a closed run two (each side),
 * walked anticlockwise so its first side is inside (`inward` false: clockwise, its first side outside).
 */
export function thinLoops(segments: Segment[], closed: boolean, amounts: [number, number], inward = true): ThinLoop[] {
  checkAmounts(amounts);
  const [left, right] = amounts;
  const raw = primsOf(segments);
  if (!raw) {
    const c = segments[0] as Extract<Segment, { kind: "circle" }>;
    return inward ? circleRing(c, left, right) : circleRing(c, right, left);
  }
  if (!raw.length) return [];
  if (closed) {
    const ccw = signedArea(sampled(raw)) > 0;
    const prims = ccw === inward ? raw : backwards(raw);
    return ringLoops(prims, left, right, inward ? 1 : -1);
  }
  const run: Run = { prims: fromBottomLeft(raw), closed: false };
  return [{ prims: openLoop(run, left, right, null, null) }];
}

function signedArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** The area inside a closed outline (mm²; for tests and checks). */
export function loopArea(loop: ThinLoop): number {
  if ("circle" in loop) return Math.PI * loop.circle.r ** 2;
  // The polygon through the corners, plus each arc's segment beyond its chord.
  const corners = loop.prims.map(primStart);
  let a = signedArea(corners);
  for (const p of loop.prims) if (p.kind === "arc") a += (p.r * p.r * (p.sweep - Math.sin(p.sweep))) / 2;
  return Math.abs(a);
}

/** A run of the sketch's curves, walked one way, as lines and arcs. */
interface Run {
  prims: Prim[];
  closed: boolean;
  /** A whole circle on its own. */
  circle?: Extract<Segment, { kind: "circle" }>;
}

/**
 * How one end of an open run meets the others at a junction (three or more curve ends at one place): where each
 * side of its wall stops, as the point its face runs to (`face`, trimmed or carried on to meet the neighbour's
 * face) and any corner points from there to the junction itself (`via`, for a corner cut off square).
 */
interface EndCap {
  node: Pt;
  /** Its side to the left of the way out of the junction, then to the right. */
  left: { face: Pt; via: Pt[] };
  right: { face: Pt; via: Pt[] };
}

/**
 * The wall's outline round an open run: its left side forward, the far end (square, or meeting the walls of the
 * other curves at a junction: `endCap`), its right side back, the near end (`startCap`).
 */
function openLoop(run: Run, left: number, right: number, startCap: EndCap | null, endCap: EndCap | null): Prim[] {
  const L = offsetPieces(run.prims, left, false);
  const R = offsetPieces(run.prims, -right, false);
  const last = run.prims.length - 1;
  // At the start the way out is along the run: its left is the run's left. At the end it's the other way round.
  if (startCap) {
    L.pieces[0] = withStart(L.pieces[0], startCap.left.face);
    R.pieces[0] = withStart(R.pieces[0], startCap.right.face);
  }
  if (endCap) {
    L.pieces[last] = withEnd(L.pieces[last], endCap.right.face);
    R.pieces[last] = withEnd(R.pieces[last], endCap.left.face);
  }
  for (const [o, d] of [[L, left], [R, -right]] as const) {
    for (const k of [0, last]) if (Math.abs(d) > 1e-12 && turnedRound(shifted(run.prims[k], d), o.pieces[k])) throw new ThinError(TOO_THICK);
  }
  const l = assemble(L);
  const r = assemble(R);
  const loop: Prim[] = [...l];
  const lEnd = primEnd(l[l.length - 1]);
  const rEnd = primEnd(r[r.length - 1]);
  loop.push(...linesThrough(endCap ? [lEnd, ...endCap.right.via, endCap.node, ...endCap.left.via.slice().reverse(), rEnd] : [lEnd, rEnd]));
  for (let i = r.length - 1; i >= 0; i--) loop.push(reversed(r[i]));
  const rStart = primStart(r[0]);
  const lStart = primStart(l[0]);
  loop.push(...linesThrough(startCap ? [rStart, ...startCap.right.via, startCap.node, ...startCap.left.via.slice().reverse(), lStart] : [rStart, lStart]));
  if (outlineCrosses(sampled(loop))) throw new ThinError(TOO_THICK);
  return loop;
}

const keyOf = (p: Pt) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
const segStart = (s: Segment): Pt | null => (s.kind === "circle" || s.kind === "ellipse" ? null : s.from);
const segEnd = (s: Segment): Pt | null => (s.kind === "circle" || s.kind === "ellipse" ? null : s.to);
function reversedSegment(s: Segment): Segment {
  switch (s.kind) {
    case "line":
      return { kind: "line", from: s.to, to: s.from };
    case "arc":
      return { kind: "arc", from: s.to, mid: s.mid, to: s.from };
    case "bezier":
      return { kind: "bezier", from: s.to, c1: s.c2, c2: s.c1, to: s.from };
    case "ellipseArc":
      return { ...s, from: s.to, to: s.from };
    default:
      return s;
  }
}

/**
 * The runs of a sketch's curves: closed rings and open runs as `findChains` finds them, and where three or more
 * curves meet (a junction) the curves of that group joined end to end through every point where just two of
 * them meet, so only real junctions split them. A run that comes back to its own start is closed.
 */
export function sketchRuns(chains: Chain[]): { segments: Segment[]; closed: boolean }[] {
  const out: { segments: Segment[]; closed: boolean }[] = [];
  const groups = new Map<number, Segment[][]>();
  for (const ch of chains) {
    if (!ch.branching) out.push({ segments: ch.segments, closed: ch.closed });
    else groups.set(ch.group ?? -1, [...(groups.get(ch.group ?? -1) ?? []), ch.segments]);
  }
  for (const pieces of groups.values()) {
    const count = new Map<string, number>();
    const at = new Map<string, number[]>();
    pieces.forEach((p, i) => {
      for (const e of [segStart(p[0]), segEnd(p[p.length - 1])]) {
        if (!e) continue;
        const k = keyOf(e);
        count.set(k, (count.get(k) ?? 0) + 1);
        at.set(k, [...(at.get(k) ?? []), i]);
      }
    });
    const used = new Set<number>();
    /** Walk on from piece i, leaving it at `from` (its start) or its end. */
    const walk = (first: number, reverse: boolean): Segment[] => {
      let segs = reverse ? pieces[first].slice().reverse().map(reversedSegment) : pieces[first];
      used.add(first);
      const run = [...segs];
      for (;;) {
        const end = segEnd(run[run.length - 1]);
        if (!end) break;
        const k = keyOf(end);
        if (count.get(k) !== 2) break;
        const next = (at.get(k) ?? []).find((j) => !used.has(j));
        if (next === undefined) break;
        const forward = keyOf(segStart(pieces[next][0])!) === k;
        segs = forward ? pieces[next] : pieces[next].slice().reverse().map(reversedSegment);
        used.add(next);
        run.push(...segs);
      }
      return run;
    };
    // Start from the ends that aren't pass-through points (junctions and loose ends), then whatever is left.
    pieces.forEach((p, i) => {
      if (used.has(i)) return;
      const s = segStart(p[0]);
      const e = segEnd(p[p.length - 1]);
      if (s && count.get(keyOf(s)) !== 2) out.push(closeUp(walk(i, false)));
      else if (e && count.get(keyOf(e)) !== 2) out.push(closeUp(walk(i, true)));
    });
    pieces.forEach((_p, i) => {
      if (!used.has(i)) out.push(closeUp(walk(i, false)));
    });
  }
  return out;
}

function closeUp(segments: Segment[]): { segments: Segment[]; closed: boolean } {
  const s = segStart(segments[0]);
  const e = segEnd(segments[segments.length - 1]);
  return { segments, closed: !!s && !!e && keyOf(s) === keyOf(e) };
}

/**
 * Which way an open run goes, so its first side faces the area it borders: if there's an area on just one side
 * of it, that side; else (areas both sides, or none) from its bottom-left end.
 */
function facing(prims: Prim[], areaAt: (p: Pt) => number, size: number): { prims: Prim[]; free: boolean } {
  const mid = prims[Math.floor(prims.length / 2)];
  let at: Pt, dir: Pt;
  if (mid.kind === "line") {
    at = mul(add(mid.a, mid.b), 0.5);
    dir = unit(sub(mid.b, mid.a));
  } else {
    const a = mid.a0 + mid.sweep / 2;
    at = [mid.c[0] + mid.r * Math.cos(a), mid.c[1] + mid.r * Math.sin(a)];
    dir = arcTangent(mid, a);
  }
  const eps = Math.max(1e-4, size * 1e-5);
  const n: Pt = [-dir[1], dir[0]];
  const left = areaAt(add(at, mul(n, eps))) >= 0;
  const right = areaAt(sub(at, mul(n, eps))) >= 0;
  if (left && !right) return { prims, free: false };
  if (right && !left) return { prims: backwards(prims), free: false };
  return { prims: fromBottomLeft(prims), free: !left && !right };
}

/**
 * Open runs with no area either side (a stub off a shape, a line carrying another on, the arms of a Y) take their
 * side from the wall they carry on from at a junction: the curve there with the smallest turn into them, keeping
 * the same side across the turn (walking in along it and out along this run, the first side stays on the same
 * hand). Runs settled so far are used first; a group of free runs with nothing settled starts from its first.
 */
function settleFreeRuns(runs: Run[], free: boolean[]): void {
  const ends = (r: Run) => {
    const last = r.prims.length - 1;
    return [
      { key: keyOf(primStart(r.prims[0])), atStart: true, out: startDir(r.prims[0]) },
      { key: keyOf(primEnd(r.prims[last])), atStart: false, out: mul(endDir(r.prims[last]), -1) },
    ];
  };
  const settled = runs.map((r, i) => !free[i] || !r.prims.length);
  for (;;) {
    let progress = false;
    for (let i = 0; i < runs.length; i++) {
      if (settled[i]) continue;
      let best: { turn: number; flip: boolean } | null = null;
      for (const mine of ends(runs[i])) {
        runs.forEach((other, j) => {
          if (j === i || !settled[j] || !other.prims.length) return;
          for (const theirs of ends(other)) {
            if (theirs.key !== mine.key) continue;
            // Walking in along theirs (against its way out) and out along mine.
            const turn = Math.abs(Math.atan2(cross(mul(theirs.out, -1), mine.out), dotp(mul(theirs.out, -1), mine.out)));
            // Their first side is on the right of their way out at their end (the run's left, walked in); mine is
            // on the left of my way out at my start. Same hand: my end here must be a start exactly when theirs isn't.
            const flip = mine.atStart === theirs.atStart;
            if (!best || turn < best.turn - 1e-9) best = { turn, flip };
          }
        });
      }
      if (best) {
        if (best.flip) runs[i] = { ...runs[i], prims: backwards(runs[i].prims) };
        settled[i] = true;
        progress = true;
      }
    }
    if (progress) continue;
    const next = settled.indexOf(false);
    if (next < 0) return;
    settled[next] = true;
  }
}

/** One curve end at a junction: which run, which end, and its faces' pieces and thicknesses on the way out. */
interface Arm {
  run: number;
  atStart: boolean;
  angle: number;
  out: Pt;
  /** Its offset pieces next to the junction, each side of the way out, and how thick that side is. */
  leftFace: Prim;
  rightFace: Prim;
  leftT: number;
  rightT: number;
  length: number;
}

const primLength = (p: Prim) => (p.kind === "line" ? dist(p.a, p.b) : Math.abs(p.sweep) * p.r);

/** Where one side of a curve's wall stops at a junction: the point its face runs to, then any corner points to the junction. */
interface SideEnd {
  face: Pt;
  via: Pt[];
}

const leftOf = (u: Pt): Pt => [-u[1], u[0]];
const rightOf = (u: Pt): Pt => [u[1], -u[0]];

/**
 * How the walls of two neighbouring curves at a junction (`a` then `b`, anticlockwise) end in the gap between
 * them. Each wall is square-ended at the junction to start with (so the walls together leave nothing out), then:
 * where the gap opens wider than a half turn, both facing sides are carried on to meet (cut square past
 * `MITRE_LIMIT`, or to a shared point halfway, when they can't meet), so the corner is filled; where it's
 * narrower, a wall facing into it whose neighbour's facing face lies behind its end is carried on to meet that
 * face, and a wall whose square end would reach past the far side of its neighbour's wall is cut back to it.
 */
function junctionGap(node: Pt, a: Arm, b: Arm): { a: SideEnd; b: SideEnd } {
  const pa = add(node, mul(leftOf(a.out), a.leftT));
  const pb = add(node, mul(rightOf(b.out), b.rightT));
  const square: { a: SideEnd; b: SideEnd } = { a: { face: pa, via: [] }, b: { face: pb, via: [] } };
  let gap = b.angle - a.angle;
  while (gap <= 1e-9) gap += TAU;
  if (Math.abs(gap - Math.PI) < 1e-6) return square;
  const nearest = (p: Prim, q: Prim) => crossings(p, q).sort((u, v) => dist(u, node) - dist(v, node))[0];
  if (gap > Math.PI) {
    if (a.leftT < 1e-12 && b.rightT < 1e-12) return square;
    const t = Math.max(a.leftT, b.rightT);
    const x = nearest(a.leftFace, b.rightFace);
    if (x && dist(x, node) <= MITRE_LIMIT * t + 1e-9 && dotp(sub(x, node), a.out) < 0.9 * a.length && dotp(sub(x, node), b.out) < 0.9 * b.length) {
      return { a: { face: x, via: [] }, b: { face: x, via: [] } };
    }
    const m = mul(add(pa, pb), 0.5);
    return { a: { face: pa, via: [m] }, b: { face: pb, via: [m] } };
  }
  // Narrower than a half turn: each wall stays on its own side of its neighbour — a square end reaching past the
  // far side of the neighbour's wall is cut back to it (so a line's wall doesn't spill across the other line into
  // the area beyond, or out of the shape).
  const result = { ...square };
  // A wall facing into the gap is carried on to meet the neighbour's facing face (its line, where it has no
  // thickness on this side) when that's behind its own end — so the two walls join along a face, not at a point.
  const meet = nearest(a.leftFace, b.rightFace);
  if (meet) {
    const alongA = dotp(sub(meet, node), a.out);
    const alongB = dotp(sub(meet, node), b.out);
    if (a.leftT > 1e-12 && alongA < -1e-9 && alongB > -1e-9 && alongB < 0.9 * b.length) result.a = { face: meet, via: [] };
    if (b.rightT > 1e-12 && alongB < -1e-9 && alongA > -1e-9 && alongA < 0.9 * a.length) result.b = { face: meet, via: [] };
  }
  const farA = rightOf(a.out);
  if (result.b === square.b && dotp(sub(pb, node), farA) > a.rightT + 1e-9) {
    const x = nearest(b.rightFace, a.rightFace);
    if (x && dotp(sub(x, node), b.out) > -1e-9 && dotp(sub(x, node), b.out) < 0.9 * b.length) result.b = { face: x, via: [] };
  }
  const farB = leftOf(b.out);
  if (result.a === square.a && dotp(sub(pa, node), farB) > b.leftT + 1e-9) {
    const x = nearest(a.leftFace, b.leftFace);
    if (x && dotp(sub(x, node), a.out) > -1e-9 && dotp(sub(x, node), a.out) < 0.9 * a.length) result.a = { face: x, via: [] };
  }
  return result;
}

function areasOf(data: SketchData): (p: Pt) => number {
  const map = sketchAreas(data);
  return (p) => map.areaAt(p);
}

export interface ThinOptions {
  /** A revolve's axis: the line with this id, and any solid line lying along `axis` (sketch x, y and direction), are left out. */
  keep?: string;
  axis?: { at: Pt; dir: Pt };
  /** Areas picked: the wall goes round just these (their outlines and holes); none = every curve. */
  areas?: (AreaPick | (number | string)[])[];
  verb?: string;
}

/** Solid curves lying on a revolve's axis (or the axis line itself) turned into construction, so no wall follows them. */
function withoutAxis(data: SketchData, opts: ThinOptions): SketchData {
  const pos = new Map(data.points.map((p) => [p.id, [p.x, p.y] as Pt]));
  pos.set("origin", [0, 0]);
  const onAxis = (c: SketchCurve) => {
    if (c.id === opts.keep) return true;
    if (!opts.axis || c.type !== "line") return false;
    const { at, dir } = opts.axis;
    return [c.p1, c.p2].every((id) => {
      const q = pos.get(id);
      return !!q && Math.abs(cross(sub(q, at), dir)) < 1e-6;
    });
  };
  if (!data.curves.some((c) => !c.construction && onAxis(c))) return data;
  return { ...data, curves: data.curves.map((c) => (!c.construction && onAxis(c) ? ({ ...c, construction: true } as SketchCurve) : c)) };
}

/**
 * A sketch with the wall's outlines for one run (`loops`), keeping the original's points and its construction
 * lines (the axis too, as construction) so axes and references still resolve.
 */
export function loopsSketch(original: SketchData, loops: ThinLoop[], kept: SketchData = original): SketchData {
  const points: SketchPoint[] = [...original.points];
  const curves: SketchCurve[] = kept.curves.filter((c) => c.construction);
  let n = 0;
  const point = (p: Pt) => {
    const id = `thin:p${n++}`;
    points.push({ id, x: p[0], y: p[1] });
    return id;
  };
  let k = 0;
  for (const loop of loops) {
    if ("circle" in loop) {
      curves.push({ id: `thin:c${k++}`, type: "circle", center: point(loop.circle.c), radius: loop.circle.r, construction: false } satisfies SketchCircle);
      continue;
    }
    const ids = loop.prims.map((p) => point(primStart(p)));
    loop.prims.forEach((p, i) => {
      const from = ids[i];
      const to = ids[(i + 1) % ids.length];
      if (p.kind === "line") curves.push({ id: `thin:c${k++}`, type: "line", p1: from, p2: to, construction: false } satisfies SketchLine);
      else {
        const centre = point(p.c);
        // Sketch arcs run anticlockwise from start to end.
        curves.push({ id: `thin:c${k++}`, type: "arc", center: centre, start: p.sweep > 0 ? from : to, end: p.sweep > 0 ? to : from, construction: false } satisfies SketchArc);
      }
    });
  }
  return { points, curves, constraints: [] };
}

/**
 * The wall's sketches, each holding closed outlines to build as usual. With areas picked: a ring round each
 * picked area's outline and holes, its first side into the area. Otherwise one piece per run of the sketch's
 * curves (`sketchRuns`): a closed run's first side inside it, an open run's towards the area it borders; where
 * runs meet at a junction their walls are carried on to meet each other's faces, so they join sharp with no
 * notches. Throws a ThinError (plain words) when it can't be made.
 */
export function thinSketches(data: SketchData, sides: ThinSides, opts: ThinOptions = {}): SketchData[] {
  const amounts = thinAmounts(sides);
  checkAmounts(amounts);
  const [left, right] = amounts;
  const drawn = withoutAxis({ points: data.points, curves: data.curves, constraints: [] }, opts);
  if (opts.areas?.length) {
    const map = sketchAreas(data);
    const chosen: number[] = [];
    let missing = 0;
    for (const p of opts.areas) {
      const i = matchArea(map, p);
      if (i < 0) missing++;
      else if (!chosen.includes(i)) chosen.push(i);
    }
    if (missing) throw new ThinError(missingAreasMessage(missing, opts.verb ?? "extrude"));
    const pieces: SketchData[] = [];
    for (const region of map.join(chosen)) {
      pieces.push(loopsSketch(data, thinLoops(region.outer.segments, true, amounts, true), drawn));
      for (const hole of region.holes) pieces.push(loopsSketch(data, thinLoops(hole.segments, true, amounts, false), drawn));
    }
    return pieces;
  }
  const { chains } = findChains(drawn, { branching: true });
  if (!chains.length) throw new ThinError("The sketch has no lines or curves to make a wall along (construction lines don't count).");
  let areaAt: ((p: Pt) => number) | null = null;
  const pts = data.points.map((p) => [p.x, p.y] as Pt);
  const size = pts.length ? Math.max(1, Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]))) : 1;
  const free: boolean[] = [];
  const runs: Run[] = sketchRuns(chains).map(({ segments, closed }) => {
    const raw = primsOf(segments);
    free.push(false);
    if (!raw) return { prims: [], closed: true, circle: segments[0] as Extract<Segment, { kind: "circle" }> };
    if (closed) return { prims: signedArea(sampled(raw)) > 0 ? raw : backwards(raw), closed: true };
    const f = facing(raw, areaAt ?? (areaAt = areasOf(drawn)), size);
    free[free.length - 1] = f.free;
    return { prims: f.prims, closed: false };
  });
  settleFreeRuns(runs, free);
  // Junctions: three or more curve ends at one place.
  const arms = new Map<string, { node: Pt; arms: Arm[] }>();
  const offsets = runs.map((r) => (r.circle || !r.prims.length ? null : { L: offsetPieces(r.prims, left, r.closed), R: offsetPieces(r.prims, -right, r.closed) }));
  runs.forEach((r, i) => {
    const o = offsets[i];
    if (!o) return;
    const last = r.prims.length - 1;
    const ends: [Pt, boolean][] = [[primStart(r.prims[0]), true], [primEnd(r.prims[last]), false]];
    for (const [node, atStart] of ends) {
      const out = atStart ? startDir(r.prims[0]) : mul(endDir(r.prims[last]), -1);
      const arm: Arm = atStart
        ? { run: i, atStart, angle: Math.atan2(out[1], out[0]), out, leftFace: o.L.pieces[0], rightFace: o.R.pieces[0], leftT: left, rightT: right, length: primLength(r.prims[0]) }
        : { run: i, atStart, angle: Math.atan2(out[1], out[0]), out, leftFace: o.R.pieces[last], rightFace: o.L.pieces[last], leftT: right, rightT: left, length: primLength(r.prims[last]) };
      const k = keyOf(node);
      const entry = arms.get(k) ?? { node, arms: [] };
      entry.arms.push(arm);
      arms.set(k, entry);
    }
  });
  const caps = new Map<string, EndCap>();
  const capKey = (run: number, atStart: boolean) => `${run}:${atStart ? "s" : "e"}`;
  for (const { node, arms: list } of arms.values()) {
    if (list.length < 3) continue;
    list.sort((p, q) => p.angle - q.angle);
    const gaps = list.map((a, i) => junctionGap(node, a, list[(i + 1) % list.length]));
    list.forEach((a, i) => {
      if (runs[a.run].closed) return;
      caps.set(capKey(a.run, a.atStart), { node, left: gaps[i].a, right: gaps[(i - 1 + list.length) % list.length].b });
    });
  }
  return runs.map((r, i) => {
    if (r.circle) return loopsSketch(data, circleRing(r.circle, left, right), drawn);
    if (r.closed) return loopsSketch(data, ringLoops(r.prims, left, right, 1), drawn);
    const loop = openLoop(r, left, right, caps.get(capKey(i, true)) ?? null, caps.get(capKey(i, false)) ?? null);
    return loopsSketch(data, [{ prims: loop }], drawn);
  });
}
