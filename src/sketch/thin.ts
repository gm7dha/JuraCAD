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
import { findChains, type Pt, type Segment } from "./regions";
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

/** How far past a corner its offset may reach before it's cut off square instead (very sharp corners). */
const MITRE_LIMIT = 50;

/**
 * A run moved `d` to its left (minus: right), corners joined sharp: each pair
 * of neighbouring pieces is carried on (or cut back) to where they meet, the
 * meeting point nearest the corner; where they can't meet, or would only meet
 * far beyond a very sharp corner, a short straight piece bridges the gap.
 */
export function offsetRun(prims: Prim[], d: number, closed: boolean): Prim[] {
  if (Math.abs(d) < 1e-12) return prims.slice();
  const moved = prims.map((p) => shifted(p, d));
  const out: Prim[] = moved.slice();
  /** Bridging pieces, put after piece i. */
  const bridges = new Map<number, Extract<Prim, { kind: "line" }>>();
  const joints = closed ? prims.length : prims.length - 1;
  for (let i = 0; i < joints; i++) {
    const j = (i + 1) % prims.length;
    const corner = primEnd(prims[i]);
    const t1 = endDir(prims[i]);
    const t2 = startDir(prims[j]);
    const turn = cross(t1, t2);
    if (Math.abs(turn) < 1e-9 && dotp(t1, t2) > 0) {
      // Smooth: both offsets end at the same place (corner + d × the shared normal), unless both are arcs of different centres.
      const x = mul(add(primEnd(out[i]), primStart(out[j])), 0.5);
      out[i] = withEnd(out[i], x);
      out[j] = withStart(out[j], x);
      continue;
    }
    if (Math.abs(turn) < 1e-9) throw new ThinError("The sketch's lines double back on themselves at a corner, so there's no wall to make there. Separate the lines a little.");
    const options = crossings(out[i], out[j]);
    const best = options.sort((p, q) => dist(p, corner) - dist(q, corner))[0];
    if (!best || dist(best, corner) > MITRE_LIMIT * Math.abs(d) + 1e-9) {
      bridges.set(i, { kind: "line", a: primEnd(out[i]), b: primStart(out[j]) });
      continue;
    }
    out[i] = withEnd(out[i], best);
    out[j] = withStart(out[j], best);
  }
  for (let i = 0; i < out.length; i++) {
    if (turnedRound(moved[i], out[i])) {
      throw new ThinError("The wall is too thick for one of the short pieces of the sketch: the corners on either side of it meet. Make the wall thinner or that piece longer.");
    }
  }
  const all: Prim[] = [];
  out.forEach((p, i) => {
    all.push(p);
    const b = bridges.get(i);
    if (b && dist(b.a, b.b) > 1e-9) all.push(b);
  });
  return all;
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

/**
 * The closed outlines of the wall round one run: for an open run one loop
 * (its left offset, a square end, its right offset back, a square end); for a
 * closed run two (each side), or one when a side has no thickness (the run
 * itself is then that side).
 */
export function thinLoops(segments: Segment[], closed: boolean, [left, right]: [number, number]): ThinLoop[] {
  if (left < 0 || right < 0) throw new ThinError("The wall's thicknesses can't be less than 0.");
  if (left + right <= 1e-9) throw new ThinError("Give the wall a thickness (more than 0).");
  const raw = primsOf(segments);
  if (!raw) {
    // A whole circle, walked anticlockwise: its left is inside.
    const c = segments[0] as Extract<Segment, { kind: "circle" }>;
    const inner = c.radius - left;
    if (inner <= 1e-6) throw new ThinError(`The wall is too thick for a circle of radius ${round(c.radius)} mm: it would fill the middle. Make it thinner than ${round(c.radius)} mm on the inside (or flip it outside).`);
    const loops: ThinLoop[] = [{ circle: { c: c.center, r: c.radius + right } }];
    loops.push({ circle: { c: c.center, r: inner } });
    return loops;
  }
  if (!raw.length) return [];
  let prims = raw;
  if (closed) {
    // Anticlockwise, so the first side is inside.
    if (signedArea(sampled(prims)) < 0) prims = prims.slice().reverse().map(reversed);
  } else {
    // From the end nearest the bottom left.
    const s = primStart(prims[0]);
    const e = primEnd(prims[prims.length - 1]);
    if (e[0] < s[0] - 1e-9 || (Math.abs(e[0] - s[0]) <= 1e-9 && e[1] < s[1])) prims = prims.slice().reverse().map(reversed);
  }
  const l = offsetRun(prims, left, closed);
  const r = offsetRun(prims, -right, closed);
  if (closed) {
    const loops = [l, r].map((x) => sampled(x));
    if (loops.some((x) => outlineCrosses(x)) || outlineCrosses(loops[0], loops[1])) throw new ThinError(TOO_THICK);
    // The inside loop must still go round the same way (else it has turned inside out).
    if (signedArea(loops[0]) <= 1e-9) throw new ThinError(TOO_THICK);
    return [{ prims: r }, { prims: l }];
  }
  const loop: Prim[] = [...l];
  const lEnd = primEnd(l[l.length - 1]);
  const rEnd = primEnd(r[r.length - 1]);
  if (dist(lEnd, rEnd) > 1e-9) loop.push({ kind: "line", a: lEnd, b: rEnd });
  for (let i = r.length - 1; i >= 0; i--) loop.push(reversed(r[i]));
  const rStart = primStart(r[0]);
  const lStart = primStart(l[0]);
  if (dist(rStart, lStart) > 1e-9) loop.push({ kind: "line", a: rStart, b: lStart });
  if (outlineCrosses(sampled(loop))) throw new ThinError(TOO_THICK);
  return [{ prims: loop }];
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

/**
 * A sketch with the wall's outlines for one run (`loops`), keeping the
 * original's points and its construction lines (and `keep`, a revolve's axis
 * line, as construction) so axes and references still resolve.
 */
export function loopsSketch(original: SketchData, loops: ThinLoop[], keep?: string): SketchData {
  const points: SketchPoint[] = [...original.points];
  const curves: SketchCurve[] = original.curves.filter((c) => c.construction || c.id === keep).map((c) => (c.id === keep && !c.construction ? ({ ...c, construction: true } as SketchCurve) : c));
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
 * The wall's sketches: one per run of the sketch's (non-construction) curves,
 * each holding that run's closed outlines. `keep` = a revolve's axis line,
 * left out of the wall. Throws a ThinError (plain words) when it can't be made.
 */
export function thinSketches(data: SketchData, sides: ThinSides, keep?: string): SketchData[] {
  const amounts = thinAmounts(sides);
  const drawn: SketchData = { points: data.points, curves: data.curves.map((c) => (c.id === keep && !c.construction ? ({ ...c, construction: true } as SketchCurve) : c)), constraints: [] };
  const { chains } = findChains(drawn, { branching: true });
  if (!chains.length) throw new ThinError("The sketch has no lines or curves to make a wall along (construction lines don't count).");
  return chains.map((ch) => loopsSketch(data, thinLoops(ch.segments, ch.closed, amounts), keep));
}
