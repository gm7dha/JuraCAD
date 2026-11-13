/**
 * Frames (pure): Onshape's Frame — profiles along sketch lines and arcs, one part per member, with the corners
 * mitred, butted or coped — and the maths behind Trim frame, Gusset and the cut list. The solids are made in
 * kernel/frame.ts from the plan worked out here.
 *
 * A member is a run of path curves: each line or arc, or (with "Merge tangent segments", the default) a run of them
 * carrying on smoothly from one to the next. Its profile stands square to the path with its "up" (y) along the
 * sketch's normal and its "across" (x) in the sketch's plane, then is turned by the profile angle.
 *
 * Corners: where two members' ends meet, a mitre (each cut along the plane halfway between them); where three or more
 * meet, or a member ends against the side of another (a T), a butt joint (one member runs through to the others'
 * far side; the others stop at its side). Each can be set to Mitre (two members only), Butt, Coped (the others cut
 * to the shape of the one running through) or None (left square at the corner point). A gap leaves room at mitres
 * and butt joints. Cuts are kept as half-spaces ("keep n·(x − o) ≥ 0") with how far each end was lengthened first,
 * so cut lengths come straight from the profile's points.
 */
import { planeFrame, toWorld, type SketchPlane } from "../sketch/planes";
import type { SketchData } from "../sketch/types";
import type { TopoPick } from "../geometry/topoRef";
import type { FrameCornerType, FrameDef, FrameMemberInfo, GussetDef, TrimFrameDef } from "./frameTypes";
import { profilePoints, reachAlong, type P2, type ProfileShape } from "./frameProfiles";
import { massGrams } from "./materials";

export type V3 = [number, number, number];

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 0];
};
const dist = (a: V3, b: V3) => len(sub(a, b));

/** Ends closer than this are the same corner (mm). */
export const JOIN_TOL = 1e-3;
/** Corners turning less than this (degrees) count as carrying straight on. */
const STRAIGHT_DEG = 0.5;

/** A path curve in 3D: a line from a to b, or an arc from a turning `angle` (radians, > 0) about `axis` through `c`. */
export type PathSeg =
  | { kind: "line"; id: string; a: V3; b: V3; n: V3 }
  | { kind: "arc"; id: string; a: V3; b: V3; c: V3; axis: V3; angle: number; r: number; n: V3 }
  | CurveSeg;

/**
 * Any other curve (a part's curved edge, or a piece of a curve feature such as a helix), as samples along it: points,
 * unit tangents and its exact length. The solid follows the real edge (kernel/frame.ts); the samples carry the
 * profile's axes along it — turning as little as it can, or with `normals` (the curve's own bending, for a helix)
 * keeping its place relative to them. `reversed` = walked the other way from the edge it came from.
 */
export interface CurveSeg {
  kind: "curve";
  id: string;
  a: V3;
  b: V3;
  n: V3;
  pts: V3[];
  tans: V3[];
  length: number;
  closed?: boolean;
  normals?: V3[];
  reversed?: boolean;
}

/** Where a segment is going at its start (t = 0) or end (t = 1). */
export function segTangent(s: PathSeg, atEnd: boolean): V3 {
  if (s.kind === "line") return unit(sub(s.b, s.a));
  if (s.kind === "curve") return atEnd ? s.tans[s.tans.length - 1] : s.tans[0];
  const p = atEnd ? s.b : s.a;
  return unit(cross(s.axis, sub(p, s.c)));
}

export function segLength(s: PathSeg): number {
  return s.kind === "line" ? dist(s.a, s.b) : s.kind === "curve" ? s.length : s.r * s.angle;
}

/** A whole circle or a closed curve: a member on its own, with no ends. */
export const isLoopSeg = (s: PathSeg) => (s.kind === "arc" && s.angle >= 2 * Math.PI - 1e-9) || (s.kind === "curve" && !!s.closed);

function reversedSeg(s: PathSeg): PathSeg {
  if (s.kind === "line") return { ...s, a: s.b, b: s.a };
  if (s.kind === "curve")
    return {
      ...s,
      a: s.b,
      b: s.a,
      pts: [...s.pts].reverse(),
      tans: [...s.tans].reverse().map((t) => mul(t, -1)),
      ...(s.normals ? { normals: [...s.normals].reverse() } : {}),
      ...(s.reversed ? { reversed: undefined } : { reversed: true }),
    };
  return { ...s, a: s.b, b: s.a, axis: mul(s.axis, -1) };
}

/** Householder reflection of v in the plane square to u (u·u = c). */
const reflect = (v: V3, u: V3, c: number): V3 => (c > 1e-24 ? sub(v, mul(u, (2 / c) * dot(u, v))) : v);

/**
 * The profile's axes carried along a curve segment, from its start to its end (or back): kept at the same angle to the
 * curve's own bending (`normals`), else turned as little as possible (double reflection, Wang et al. 2008 — exactly
 * undone going back).
 */
function carryCurve(s: CurveSeg, f: Axes, back: boolean): Axes {
  const T = s.tans;
  const last = T.length - 1;
  if (s.normals) {
    const [i, j] = back ? [last, 0] : [0, last];
    const N0 = s.normals[i];
    const B0 = cross(T[i], N0);
    const th = Math.atan2(dot(f.x, B0), dot(f.x, N0));
    const N1 = s.normals[j];
    const B1 = cross(T[j], N1);
    const x = unit(add(mul(N1, Math.cos(th)), mul(B1, Math.sin(th))));
    return { x, y: cross(T[j], x) };
  }
  const P = s.pts;
  let r = f.x;
  const step = (i: number, fwd: boolean) => {
    const v1 = sub(P[i + 1], P[i]);
    const c1 = dot(v1, v1);
    const tL = reflect(T[i], v1, c1);
    const v2 = sub(T[i + 1], tL);
    const c2 = dot(v2, v2);
    r = fwd ? reflect(reflect(r, v1, c1), v2, c2) : reflect(reflect(r, v2, c2), v1, c1);
  };
  if (!back) for (let i = 0; i < last; i++) step(i, true);
  else for (let i = last - 1; i >= 0; i--) step(i, false);
  const t = back ? T[0] : T[last];
  // Kept square to the path (sampling leaves a tiny lean).
  const x = unit(sub(r, mul(t, dot(r, t))));
  return { x, y: cross(t, x) };
}

/** The lines, arcs and circles of a sketch in 3D (construction lines left out), and what was left out. */
export function sketchPathSegments(sketchId: string, plane: SketchPlane, data: SketchData, items?: string[]): { segs: PathSeg[]; skipped: number } {
  const frame = planeFrame(plane);
  const pos = (id: string): V3 | null => {
    if (id === "origin") return toWorld(frame, 0, 0);
    const p = data.points.find((q) => q.id === id);
    return p ? toWorld(frame, p.x, p.y) : null;
  };
  const want = items ? new Set(items) : null;
  const segs: PathSeg[] = [];
  let skipped = 0;
  for (const c of data.curves) {
    if (want && !want.has(c.id)) continue;
    if (c.construction) continue;
    const id = `${sketchId}/${c.id}`;
    if (c.type === "line") {
      const a = pos(c.p1);
      const b = pos(c.p2);
      if (a && b && dist(a, b) > JOIN_TOL) segs.push({ kind: "line", id, a, b, n: frame.n });
    } else if (c.type === "arc") {
      const cc = pos(c.center);
      const a = pos(c.start);
      const b = pos(c.end);
      if (!cc || !a || !b) continue;
      const r = dist(cc, a);
      const u = unit(sub(a, cc));
      const w = cross(frame.n, u);
      const q = sub(b, cc);
      let ang = Math.atan2(dot(q, w), dot(q, u));
      if (ang <= 1e-9) ang += 2 * Math.PI;
      if (r > JOIN_TOL) segs.push({ kind: "arc", id, a, b: add(cc, mul(add(mul(u, Math.cos(ang)), mul(w, Math.sin(ang))), r)), c: cc, axis: frame.n, angle: ang, r, n: frame.n });
    } else if (c.type === "circle") {
      const cc = pos(c.center);
      if (!cc || !(c.radius > JOIN_TOL)) continue;
      const a = add(cc, mul(frame.u, c.radius));
      segs.push({ kind: "arc", id, a, b: a, c: cc, axis: frame.n, angle: 2 * Math.PI, r: c.radius, n: frame.n });
    } else skipped++;
  }
  return { segs, skipped };
}

/** A point of a circle through three points (its centre), or null when they're in a line. */
function circumcentre(a: V3, b: V3, c: V3): V3 | null {
  const u = sub(b, a);
  const v = sub(c, a);
  const w = cross(u, v);
  const ww = dot(w, w);
  if (ww < 1e-18) return null;
  const k = add(mul(cross(w, u), dot(v, v)), mul(cross(v, w), dot(u, u)));
  return add(a, mul(k, 1 / (2 * ww)));
}

/**
 * One edge (of a part, or of a curve feature) as a path segment, from points and unit tangents sampled evenly along
 * it (the same direction as the points run) and its exact length: a line when it's straight, an arc when it's part
 * of (or a whole) circle, else a curve carrying the samples. `frenet` keeps the profile turning with the curve's own
 * bending (a helix). `n` (the "sketch normal" the profile's up starts from) is filled in by `withPathNormal`.
 */
export function edgeSegment(id: string, pts: V3[], tans: V3[], length: number, opts: { frenet?: boolean } = {}): PathSeg | null {
  if (pts.length < 2 || !(length > JOIN_TOL)) return null;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const closed = dist(a, b) < JOIN_TOL;
  const tol = Math.max(1e-6, length * 1e-7) * 10;
  const n0: V3 = [0, 0, 1];
  if (!closed) {
    const t = unit(sub(b, a));
    const off = Math.max(...pts.map((p) => len(sub(sub(p, a), mul(t, dot(sub(p, a), t))))));
    if (off < tol && Math.abs(dist(a, b) - length) < tol * 10) return { kind: "line", id, a, b, n: n0 };
  }
  // A circle or part of one: every sample the same distance from a centre, in one plane.
  const m = pts.length;
  const c = closed ? circumcentre(pts[0], pts[Math.floor(m / 3)], pts[Math.floor((2 * m) / 3)]) : circumcentre(a, pts[Math.floor(m / 2)], b);
  if (c) {
    const r = dist(a, c);
    const axis0 = unit(cross(sub(pts[1], c), sub(pts[Math.max(2, Math.floor(m / 2))], c)));
    const axis = dot(cross(axis0, sub(a, c)), tans[0]) >= 0 ? axis0 : mul(axis0, -1);
    const round = pts.every((p) => Math.abs(dist(p, c) - r) < tol * 10 && Math.abs(dot(sub(p, c), axis)) < tol * 10);
    if (round && len(axis) > 0.5) {
      let angle = 2 * Math.PI;
      if (!closed) {
        const u = unit(sub(a, c));
        const w = cross(axis, u);
        const q = sub(b, c);
        angle = Math.atan2(dot(q, w), dot(q, u));
        if (angle <= 1e-9) angle += 2 * Math.PI;
      }
      if (Math.abs(r * angle - length) < Math.max(1e-3, length * 1e-4)) return { kind: "arc", id, a, b: closed ? a : b, c, axis, angle, r, n: axis };
    }
  }
  const seg: CurveSeg = { kind: "curve", id, a, b: closed ? a : b, n: n0, pts, tans, length, ...(closed ? { closed: true } : {}) };
  if (opts.frenet) {
    // The curve's own bending: the part of the tangent's change square to it.
    const normals = tans.map((t, i) => {
      const d = sub(tans[Math.min(m - 1, i + 1)], tans[Math.max(0, i - 1)]);
      return unit(sub(d, mul(t, dot(d, t))));
    });
    if (normals.every((x) => len(x) > 0.5)) {
      seg.normals = normals;
      // Up starts across the bending (a helix's rail stands along its axis, its side facing the middle).
      seg.n = cross(tans[0], normals[0]);
    }
  }
  return seg;
}

/**
 * The "sketch normal" for path pieces not from a sketch (part edges, curves), so profiles stand as they would in a
 * sketch: the plane they lie in when they all lie in one (turned to face up, else +Y, else +X), else straight up (Z).
 * Arcs keep their own axis, and curves following their bending keep theirs.
 */
export function withPathNormal(segs: PathSeg[]): PathSeg[] {
  const pts = segs.flatMap((s) => (s.kind === "curve" ? s.pts : s.kind === "arc" ? [s.a, s.b, add(s.c, mul(unit(sub(s.a, s.c)), -s.r)), s.c] : [s.a, s.b]));
  let n: V3 = [0, 0, 1];
  if (pts.length >= 3) {
    const p0 = pts[0];
    const p1 = pts.reduce((best, p) => (dist(p, p0) > dist(best, p0) ? p : best), p0);
    const e = unit(sub(p1, p0));
    const off = (p: V3) => len(sub(sub(p, p0), mul(e, dot(sub(p, p0), e))));
    const p2 = pts.reduce((best, p) => (off(p) > off(best) ? p : best), p0);
    const size = Math.max(dist(p1, p0), 1);
    const c = unit(cross(sub(p1, p0), sub(p2, p0)));
    if (len(c) > 0.5 && off(p2) > size * 1e-6 && pts.every((p) => Math.abs(dot(sub(p, p0), c)) < size * 1e-6 + 1e-6)) {
      n = Math.abs(c[2]) > 1e-9 ? (c[2] < 0 ? mul(c, -1) : c) : Math.abs(c[1]) > 1e-9 ? (c[1] < 0 ? mul(c, -1) : c) : c[0] < 0 ? mul(c, -1) : c;
    }
  }
  const facing = (v: V3): V3 => {
    const lead = Math.abs(v[2]) > 1e-9 ? v[2] : Math.abs(v[1]) > 1e-9 ? v[1] : v[0];
    return lead < 0 ? mul(v, -1) : v;
  };
  return segs.map((s) => {
    if (s.kind === "line" || (s.kind === "curve" && !s.normals)) return { ...s, n };
    if (s.kind === "arc") return { ...s, n: Math.abs(dot(s.axis, n)) > 1 - 1e-9 ? n : facing(s.axis) };
    return s;
  });
}

/** A profile frame: across (x) and up (y), square to the path. */
export interface Axes {
  x: V3;
  y: V3;
}

/** A frame member: path segments in order, end to end, and how its profile stands at its start. */
export interface Member {
  segs: PathSeg[];
  closed: boolean;
  /** The profile's axes at the start (carried along the path: unchanged along lines, turned with arcs). */
  start: Axes;
  /** Its curve that comes first in the path (names the part, so ids stay put when other lines change). */
  key: string;
  /** Where that curve is in the path (members are listed in this order). */
  order: number;
}

/** Turn v about the unit axis k by `angle` radians. */
function rotate(v: V3, k: V3, angle: number): V3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kv = cross(k, v);
  const d = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * d, v[1] * c + kv[1] * s + k[1] * d, v[2] * c + kv[2] * s + k[2] * d];
}

/** The profile's axes at the start of each segment, then at the member's end. */
export function segFrames(m: Member): Axes[] {
  const out: Axes[] = [m.start];
  let f = m.start;
  for (const s of m.segs) {
    if (s.kind === "arc") f = { x: rotate(f.x, s.axis, s.angle), y: rotate(f.y, s.axis, s.angle) };
    else if (s.kind === "curve") f = carryCurve(s, f, false);
    out.push(f);
  }
  return out;
}

/** The axes at the member's start that give `at` at its end (carried back along it). */
function startFromEnd(m: Member, at: Axes): Axes {
  let f = at;
  for (let i = m.segs.length - 1; i >= 0; i--) {
    const s = m.segs[i];
    if (s.kind === "arc") f = { x: rotate(f.x, s.axis, -s.angle), y: rotate(f.y, s.axis, -s.angle) };
    else if (s.kind === "curve") f = carryCurve(s, f, true);
  }
  return f;
}

/** The axes carried round a corner from going along t1 to going along t2 (the least turn; a U-turn turns about up). */
function carryRound(f: Axes, t1: V3, t2: V3): Axes {
  const c = dot(t1, t2);
  if (c > 1 - 1e-12) return f;
  if (c < -1 + 1e-9) return { x: mul(f.x, -1), y: f.y };
  const k = unit(cross(t1, t2));
  const ang = Math.acos(Math.max(-1, Math.min(1, c)));
  return { x: rotate(f.x, k, ang), y: rotate(f.y, k, ang) };
}

/** The profile's axes where the path goes along `t` in a sketch with normal `n`: across in the sketch's plane, up along its normal. */
export function profileAxes(t: V3, n: V3): Axes {
  let x = unit(cross(n, t));
  if (len(x) < 0.5) x = unit(cross(Math.abs(t[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], t));
  return { x, y: cross(t, x) };
}

export const memberStart = (m: Member) => m.segs[0].a;
export const memberEnd = (m: Member) => m.segs[m.segs.length - 1].b;
const endPoint = (m: Member, end: 0 | 1) => (end === 0 ? memberStart(m) : memberEnd(m));
/** The direction out of a member's end, away from its corner. */
export function outOf(m: Member, end: 0 | 1): V3 {
  return end === 0 ? segTangent(m.segs[0], false) : mul(segTangent(m.segs[m.segs.length - 1], true), -1);
}
/** The curve id ("sketch/curve") at a member's end, as Butt / Coped's `through` names it. */
export function endCurveId(m: Member, end: 0 | 1): string {
  return end === 0 ? m.segs[0].id : m.segs[m.segs.length - 1].id;
}
export const memberLength = (m: Member) => m.segs.reduce((t, s) => t + segLength(s), 0);
function reversedMember(m: Member): Member {
  const segs = [...m.segs].reverse().map(reversedSeg);
  const flipped: Member = { ...m, segs };
  return { ...flipped, start: startFromEnd(flipped, segFrames(m)[m.segs.length]) };
}

const COS_STRAIGHT = Math.cos((STRAIGHT_DEG * Math.PI) / 180);

/** An end of a segment at a point of the path. */
interface SegEnd {
  i: number;
  end: 0 | 1;
}

/**
 * Join the path's segments into members: each segment its own, or (with `merge`) runs carrying on smoothly. Where
 * three or more meet, only one straight-on pair carries on (the longest), so a post split where a rail meets it is
 * one post, and a + crossing is one long member with two ending on its sides. Straight lines carrying on straight
 * become one line.
 */
export function buildMembers(segs: PathSeg[], merge: boolean): Member[] {
  const nodes: { p: V3; ends: SegEnd[] }[] = [];
  segs.forEach((s, i) => {
    for (const end of [0, 1] as const) {
      const p = end === 0 ? s.a : s.b;
      if (isLoopSeg(s)) continue;
      const n = nodes.find((x) => dist(x.p, p) < JOIN_TOL);
      if (n) n.ends.push({ i, end });
      else nodes.push({ p, ends: [{ i, end }] });
    }
  });
  const away = (e: SegEnd) => (e.end === 0 ? segTangent(segs[e.i], false) : mul(segTangent(segs[e.i], true), -1));
  // Which segment end carries on into which.
  const next = new Map<string, SegEnd>();
  const k = (e: SegEnd) => `${e.i}:${e.end}`;
  /** A point inside a line of the path (not at its ends): rails meeting there stop at its side, they don't carry on through. */
  const onASide = (p: V3) =>
    segs.some((s) => {
      if (s.kind !== "line") return false;
      const t = segTangent(s, false);
      const d = dot(sub(p, s.a), t);
      return d > JOIN_TOL * 10 && d < segLength(s) - JOIN_TOL * 10 && dist(add(s.a, mul(t, d)), p) < JOIN_TOL;
    });
  if (merge) {
    for (const n of nodes) {
      if (onASide(n.p)) continue;
      let best: [SegEnd, SegEnd] | null = null;
      let bestLen = -1;
      for (let a = 0; a < n.ends.length; a++) {
        for (let b = a + 1; b < n.ends.length; b++) {
          const ea = n.ends[a];
          const eb = n.ends[b];
          if (ea.i === eb.i) continue;
          if (dot(away(ea), away(eb)) > -COS_STRAIGHT) continue;
          // Where three or more meet, only straight lines carry on.
          if (n.ends.length > 2 && (segs[ea.i].kind !== "line" || segs[eb.i].kind !== "line")) continue;
          const l = segLength(segs[ea.i]) + segLength(segs[eb.i]);
          if (l > bestLen + 1e-9) {
            best = [ea, eb];
            bestLen = l;
          }
        }
      }
      if (best) {
        next.set(k(best[0]), best[1]);
        next.set(k(best[1]), best[0]);
      }
    }
  }
  const used = new Set<number>();
  const members: Member[] = [];
  const walk = (first: number, from: 0 | 1): { chain: PathSeg[]; idx: number[]; closed: boolean } => {
    // Walk from segment `first` leaving its `from` end's other end.
    const chain: PathSeg[] = [];
    const idx: number[] = [];
    let i = first;
    let entered: 0 | 1 = from;
    for (;;) {
      used.add(i);
      idx.push(i);
      chain.push(entered === 0 ? segs[i] : reversedSeg(segs[i]));
      const leave: SegEnd = { i, end: entered === 0 ? 1 : 0 };
      const to = next.get(k(leave));
      if (!to) return { chain, idx, closed: false };
      if (to.i === first) return { chain, idx, closed: true };
      if (used.has(to.i)) return { chain, idx, closed: false };
      i = to.i;
      entered = to.end;
    }
  };
  const order = segs.map((_, i) => i);
  // Chains first from free ends, then whatever is left (loops).
  for (const i of order) {
    if (used.has(i)) continue;
    const s = segs[i];
    if (isLoopSeg(s)) {
      used.add(i);
      members.push(asMember([s], [i], true));
      continue;
    }
    // Start at a free end of this chain: walk back from i to find it.
    let start = i;
    let from: 0 | 1 = 0;
    const seen = new Set<number>([i]);
    for (;;) {
      const back = next.get(k({ i: start, end: from }));
      if (!back || seen.has(back.i)) break;
      seen.add(back.i);
      start = back.i;
      from = back.end === 0 ? 1 : 0;
    }
    const r = walk(start, from);
    members.push(asMember(r.chain, r.idx, r.closed && r.chain.length > 1));
  }
  function asMember(chain: PathSeg[], idx: number[], closed: boolean): Member {
    // Straight lines carrying on straight: one line.
    const parts: { s: PathSeg; i: number }[] = [];
    const firstIdx = Math.min(...idx);
    chain.forEach((s, j) => {
      const last = parts[parts.length - 1];
      if (last && last.s.kind === "line" && s.kind === "line" && dot(segTangent(last.s, false), segTangent(s, false)) > COS_STRAIGHT) {
        last.s = { ...last.s, b: s.b, id: idx[j] < last.i ? s.id : last.s.id };
        last.i = Math.min(last.i, idx[j]);
      } else parts.push({ s, i: idx[j] });
    });
    if (closed && parts.length > 1) {
      const a = parts[0];
      const z = parts[parts.length - 1];
      if (a.s.kind === "line" && z.s.kind === "line" && dot(segTangent(z.s, false), segTangent(a.s, false)) > COS_STRAIGHT) {
        a.s = { ...a.s, a: z.s.a, id: z.i < a.i ? z.s.id : a.s.id };
        a.i = Math.min(a.i, z.i);
        parts.pop();
      }
    }
    const fused = parts.map((x) => x.s);
    const t0 = segTangent(fused[0], false);
    return { segs: fused, closed, start: profileAxes(t0, fused[0].n), key: segs[firstIdx].id, order: firstIdx };
  }
  return members.sort((a, b) => a.order - b.order);
}

/**
 * Walk each connected path so its members run on from one to the next (a line drawn the other way round is turned)
 * and carry the profile's axes round the corners, so a profile set to one side stays on the same side all round and
 * sections match at mitres — also between lines in different sketches. Where a loop comes back with the profile
 * turned differently, a note says so.
 */
export function orientMembers(members: Member[]): { members: Member[]; notes: string[] } {
  const ms = members.map((m) => ({ ...m }));
  const nodeOf: { p: V3; ends: { member: number; end: 0 | 1 }[] }[] = [];
  ms.forEach((m, i) => {
    if (m.closed) return;
    for (const end of [0, 1] as const) {
      const p = endPoint(m, end);
      const n = nodeOf.find((x) => dist(x.p, p) < JOIN_TOL);
      if (n) n.ends.push({ member: i, end });
      else nodeOf.push({ p, ends: [{ member: i, end }] });
    }
  });
  // Directions: run on through corners where just two meet.
  const dirDone = new Set<number>();
  for (let root = 0; root < ms.length; root++) {
    if (dirDone.has(root)) continue;
    dirDone.add(root);
    const queue = [root];
    while (queue.length) {
      const a = queue.shift()!;
      for (const end of [0, 1] as const) {
        if (ms[a].closed) continue;
        const node = nodeOf.find((n) => n.ends.some((e) => e.member === a && e.end === end));
        if (!node || node.ends.length !== 2) continue;
        const other = node.ends.find((e) => !(e.member === a && e.end === end))!;
        if (other.member === a || dirDone.has(other.member)) continue;
        // a arrives here at its end 1 → the other should leave from its start; a leaves from its start → the other should arrive.
        if (other.end === end) {
          ms[other.member] = reversedMember(ms[other.member]);
          for (const n of nodeOf) for (const e of n.ends) if (e.member === other.member) e.end = e.end === 0 ? 1 : 0;
        }
        dirDone.add(other.member);
        queue.push(other.member);
      }
    }
  }
  // Axes: carried from member to member through every corner, from the first member of each connected path.
  const axesDone = new Set<number>();
  const arriving = (i: number, end: 0 | 1) => mul(outOf(ms[i], end), -1);
  const atEnd = (i: number, end: 0 | 1) => {
    const f = segFrames(ms[i]);
    return end === 0 ? f[0] : f[f.length - 1];
  };
  const notes: string[] = [];
  for (let root = 0; root < ms.length; root++) {
    if (axesDone.has(root)) continue;
    axesDone.add(root);
    const queue = [root];
    while (queue.length) {
      const a = queue.shift()!;
      for (const end of [0, 1] as const) {
        if (ms[a].closed) continue;
        const node = nodeOf.find((n) => n.ends.some((e) => e.member === a && e.end === end));
        // Only through corners where two meet (a chain): where three or more meet, each keeps its own sketch's way up.
        if (!node || node.ends.length !== 2) continue;
        for (const o of node.ends) {
          if (o.member === a) continue;
          // Going into the corner along a, out along o.
          const carried = carryRound(atEnd(a, end), arriving(a, end), outOf(ms[o.member], o.end));
          if (axesDone.has(o.member)) {
            {
              const have = atEnd(o.member, o.end);
              if (dot(have.x, carried.x) < 0.999 || dot(have.y, carried.y) < 0.999) {
                const p = node.p.map((v) => Math.round(v * 100) / 100).join(", ");
                const note = `The profile couldn't be kept facing the same way all round: at (${p}) it turns over between two lengths. Check that corner (Mirror or the profile angle may help).`;
                if (!notes.includes(note)) notes.push(note);
              }
            }
            continue;
          }
          const m = ms[o.member];
          ms[o.member] = { ...m, start: o.end === 0 ? carried : startFromEnd(m, carried) };
          axesDone.add(o.member);
          queue.push(o.member);
        }
      }
    }
  }
  return { members: ms, notes };
}

/** A member end, seen from its corner. */
interface EndRef {
  member: number;
  end: 0 | 1;
}

export interface FrameCorner {
  key: string;
  at: V3;
  /** Members ending here. */
  ends: EndRef[];
  /** A T: the member whose side the ends meet (it doesn't end here), and its segment there. */
  on?: number;
  onSeg?: number;
  /** Two members carrying straight on through here (the others meet their side): they run on, square to each other. */
  run?: [number, number];
  /** As built (after the user's choice and what's possible). */
  type: FrameCornerType;
  /** The member that runs through (butt / coped). */
  through?: number;
  /** The types that can be chosen here. */
  choices: FrameCornerType[];
  /** The angle between the members (degrees; 180 = straight on). Two members only. */
  angle?: number;
}

/** How one member end is finished: lengthened by `extend` along its own direction, then cut by `cuts`. */
export interface EndCut {
  extend: number;
  cuts: { n: V3; o: V3 }[];
  /** Cut to the outside of these members (coped). */
  cope?: number[];
  /** For the cut list: degrees from square, or coped. */
  label: number | "coped";
}

export interface MemberPlan {
  member: Member;
  ends: [EndCut, EndCut];
  /** Profile axes at the start of each segment, then at the end. */
  frames: Axes[];
  straight: boolean;
  /** The centre line's length. */
  pathLength: number;
}

export interface FramePlan {
  members: MemberPlan[];
  corners: FrameCorner[];
  /** Things to tell (a profile turning over at a corner, a member ending on the side of a curve). */
  notes: string[];
}

/** Where a point lies on a member's line segment (not at its ends): that segment, or null. */
function onLineSeg(m: Member, p: V3): number | null {
  for (let i = 0; i < m.segs.length; i++) {
    const s = m.segs[i];
    if (s.kind !== "line") continue;
    const t = segTangent(s, false);
    const L = segLength(s);
    const d = dot(sub(p, s.a), t);
    if (d < JOIN_TOL * 10 || d > L - JOIN_TOL * 10) continue;
    if (dist(add(s.a, mul(t, d)), p) < JOIN_TOL) return i;
  }
  return null;
}

/** Whether a point lies inside an arc of a member (not at its ends). */
function onArc(m: Member, p: V3): boolean {
  return m.segs.some((s) => {
    if (s.kind !== "arc") return false;
    const q = sub(p, s.c);
    if (Math.abs(dot(q, s.axis)) > JOIN_TOL || Math.abs(len(q) - s.r) > JOIN_TOL) return false;
    const u = unit(sub(s.a, s.c));
    const w = cross(s.axis, u);
    let ang = Math.atan2(dot(q, w), dot(q, u));
    if (ang < 0) ang += 2 * Math.PI;
    return ang > 1e-6 && ang < s.angle - 1e-6;
  });
}

/** A corner's key: the curves meeting there (sorted), and the one a T meets the side of. */
export function cornerKey(ids: string[], on?: string): string {
  return [...ids].sort().join("+") + (on ? `|on:${on}` : "");
}

/** The corners of a set of members (where ends meet, Ts, and straight runs others meet), with their default types. */
export function findCorners(members: Member[]): { corners: Omit<FrameCorner, "type" | "through">[]; notes: string[] } {
  const groups: { at: V3; ends: EndRef[] }[] = [];
  members.forEach((m, i) => {
    if (m.closed) return;
    for (const end of [0, 1] as const) {
      const p = endPoint(m, end);
      const g = groups.find((x) => dist(x.at, p) < JOIN_TOL);
      if (g) g.ends.push({ member: i, end });
      else groups.push({ at: p, ends: [{ member: i, end }] });
    }
  });
  const out: Omit<FrameCorner, "type" | "through">[] = [];
  const notes: string[] = [];
  for (const g of groups) {
    const ids = g.ends.map((e) => endCurveId(members[e.member], e.end));
    const mine = new Set(g.ends.map((e) => e.member));
    // Ends against the side of another member: a T (any number of them).
    let on = -1;
    let onSeg = -1;
    for (let i = 0; i < members.length && on < 0; i++) {
      if (mine.has(i)) continue;
      const s = onLineSeg(members[i], g.at);
      if (s !== null) {
        on = i;
        onSeg = s;
      }
    }
    if (on >= 0) {
      out.push({ key: cornerKey(ids, members[on].segs[onSeg].id), at: g.at, ends: g.ends, on, onSeg, choices: ["butt", "coped", "none"] });
      continue;
    }
    if (members.some((m, i) => !mine.has(i) && onArc(m, g.at))) {
      const p = g.at.map((v) => Math.round(v * 100) / 100).join(", ");
      notes.push(`A length ends on the side of a curved one at (${p}); it's left square there — trim it with Trim frame.`);
      continue;
    }
    if (g.ends.length === 1) continue;
    const dirs = g.ends.map((e) => outOf(members[e.member], e.end));
    if (g.ends.length >= 3) {
      // Two carrying straight on: they run on through, the rest meet their side.
      let run: [number, number] | undefined;
      let best = -1;
      for (let a = 0; a < g.ends.length; a++)
        for (let b = a + 1; b < g.ends.length; b++) {
          const ma = members[g.ends[a].member];
          const mb = members[g.ends[b].member];
          const sa = g.ends[a].end === 0 ? ma.segs[0] : ma.segs[ma.segs.length - 1];
          const sb = g.ends[b].end === 0 ? mb.segs[0] : mb.segs[mb.segs.length - 1];
          if (sa.kind !== "line" || sb.kind !== "line" || dot(dirs[a], dirs[b]) > -COS_STRAIGHT) continue;
          const l = memberLength(ma) + memberLength(mb);
          if (l > best) {
            best = l;
            run = [g.ends[a].member, g.ends[b].member];
          }
        }
      if (run) {
        out.push({ key: cornerKey(ids), at: g.at, ends: g.ends, run, choices: ["butt", "coped", "none"] });
        continue;
      }
    }
    let angle: number | undefined;
    if (g.ends.length === 2) angle = (Math.acos(Math.max(-1, Math.min(1, dot(dirs[0], dirs[1])))) * 180) / Math.PI;
    // Three or more: a mitre too where every pair meets at a real corner (none carrying straight on, none too sharp).
    const mitres = g.ends.length === 2 || mitreable(dirs);
    out.push({ key: cornerKey(ids), at: g.at, ends: g.ends, ...(angle !== undefined ? { angle } : {}), choices: mitres ? ["mitre", "butt", "coped", "none"] : ["butt", "coped", "none"] });
  }
  return { corners: out, notes };
}

/** The smallest angle (degrees) between any two of these directions out of a corner. */
export function sharpestPair(dirs: V3[]): number {
  let least = 180;
  for (let a = 0; a < dirs.length; a++)
    for (let b = a + 1; b < dirs.length; b++) least = Math.min(least, (Math.acos(Math.max(-1, Math.min(1, dot(dirs[a], dirs[b])))) * 180) / Math.PI);
  return least;
}

/** Can three or more members be mitred together here: no two carrying straight on, none meeting too sharply. */
export function mitreable(dirs: V3[]): boolean {
  if (dirs.length < 3) return dirs.length === 2;
  for (let a = 0; a < dirs.length; a++) for (let b = a + 1; b < dirs.length; b++) if (dot(dirs[a], dirs[b]) < -COS_STRAIGHT) return false;
  return sharpestPair(dirs) >= SHARPEST;
}

/** The usual type of a corner: a mitre between two members (none if they carry straight on), a butt joint otherwise. */
function defaultType(c: Omit<FrameCorner, "type" | "through">): FrameCornerType {
  if (c.on !== undefined || c.run) return "butt";
  if (c.ends.length === 2) return (c.angle ?? 0) > 180 - STRAIGHT_DEG ? "none" : "mitre";
  return "butt";
}

/**
 * Which member runs through a butt joint when nobody chose: the longest; between equal lengths, the one going most
 * along X, then Y, then Z (so a cube's front and back rails run through, its side rails and uprights stop); then the
 * first in the path.
 */
function usualThrough(members: Member[], ends: EndRef[]): number {
  const score = (e: EndRef) => {
    const d = outOf(members[e.member], e.end).map(Math.abs);
    const axis = d[0] >= d[1] - 1e-9 && d[0] >= d[2] - 1e-9 ? 0 : d[1] >= d[2] - 1e-9 ? 1 : 2;
    return { len: Math.round(memberLength(members[e.member]) * 100) / 100, axis, order: members[e.member].order };
  };
  return [...ends].sort((p, q) => {
    const a = score(p);
    const b = score(q);
    return b.len - a.len || a.axis - b.axis || a.order - b.order;
  })[0].member;
}

/** Too sharp to mitre or butt (degrees between the members). */
export const SHARPEST = 10;

/** The members (oriented) and corners (as chosen, else the usual) of a frame's path, and notes. */
export function frameLayout(segs: PathSeg[], def: Pick<FrameDef, "noMerge" | "corners">): { members: Member[]; corners: FrameCorner[]; notes: string[] } {
  const oriented = orientMembers(buildMembers(segs, !def.noMerge));
  const members = oriented.members;
  const found = findCorners(members);
  const corners = found.corners.map((c): FrameCorner => {
    const chosen = def.corners?.find((x) => x.key === c.key);
    const type = chosen && c.choices.includes(chosen.type) ? chosen.type : defaultType(c);
    if (type !== "butt" && type !== "coped") return { ...c, type };
    let through: number;
    if (c.on !== undefined) through = c.on;
    else if (c.run) through = c.run[0];
    else through = c.ends.find((e) => endCurveId(members[e.member], e.end) === chosen?.through)?.member ?? usualThrough(members, c.ends);
    return { ...c, type, through };
  });
  return { members, corners, notes: [...oriented.notes, ...found.notes] };
}

/**
 * The whole plan: members, corners as chosen (`def.corners`, else the usual) and each member end's cuts, for a
 * placed profile and a gap (mm). A plain message when it can't be made.
 */
export function planFrame(segs: PathSeg[], def: Pick<FrameDef, "noMerge" | "corners">, shape: ProfileShape, gap: number): FramePlan | string {
  if (!segs.length) return "Pick the sketch lines or arcs (or part edges, or curves) for the frame to follow.";
  const { members, corners, notes } = frameLayout(segs, def);
  const plans: MemberPlan[] = members.map((m) => ({
    member: m,
    ends: [
      { extend: 0, cuts: [], label: 0 },
      { extend: 0, cuts: [], label: 0 },
    ],
    frames: segFrames(m),
    straight: m.segs.length === 1 && m.segs[0].kind === "line",
    pathLength: memberLength(m),
  }));
  const axesAt = (mi: number, end: 0 | 1) => {
    const f = plans[mi].frames;
    return end === 0 ? f[0] : f[f.length - 1];
  };
  const reachOf = (ax: Axes, dir: V3) => reachAlong(shape, dot(dir, ax.x), dot(dir, ax.y));
  for (const c of corners) {
    if (c.type === "none") continue;
    if (c.angle !== undefined && c.angle < SHARPEST) return `Two members meet at a very sharp corner (${Math.round(c.angle)}°). Set that corner to None, or change the path.`;
    if (c.type === "mitre") {
      // Each end cut along the plane halfway between it and every other member there (two: one plane each; a cube's
      // corner: two each, so the three meet without overlapping).
      const dirs = c.ends.map((e) => outOf(members[e.member], e.end));
      if (dirs.length > 2 && sharpestPair(dirs) < SHARPEST) return `Members meet at a very sharp corner (${Math.round(sharpestPair(dirs))}°). Set that corner to Butt or None, or change the path.`;
      c.ends.forEach((e, i) => {
        const d = dirs[i];
        const cut = plans[e.member].ends[e.end];
        let label = 0;
        dirs.forEach((o, j) => {
          if (j === i) return;
          const n = unit(sub(d, o));
          const mq = reachOf(axesAt(e.member, e.end), n);
          cut.extend = Math.max(cut.extend, Math.max(0, (mq - gap / 2) / dot(n, d)) + 1);
          cut.cuts.push({ n, o: add(c.at, mul(n, gap / 2)) });
          label = Math.max(label, angleFromSquare(n, d));
        });
        cut.label = label;
      });
      continue;
    }
    // Butt or coped: `through` runs on; the others stop at its side (coped: at its middle, then cut to its outline).
    const T = c.through!;
    const tEnd = c.on === undefined && !c.run ? c.ends.find((e) => e.member === T) : undefined;
    let dT: V3;
    let tAxes: Axes;
    if (c.on !== undefined) {
      const s = members[T].segs[c.onSeg!];
      dT = segTangent(s, false);
      tAxes = plans[T].frames[c.onSeg!];
    } else {
      const e = c.ends.find((x) => x.member === T)!;
      dT = outOf(members[T], e.end);
      tAxes = axesAt(T, e.end);
    }
    const runs = new Set(c.run ?? []);
    const copeWith = c.run ? [...c.run] : [T];
    let tBest: { extend: number; cut: { n: V3; o: V3 } } | null = null;
    for (const e of c.ends) {
      if (e.member === T || runs.has(e.member)) continue;
      const dO = outOf(members[e.member], e.end);
      const u0 = sub(dO, mul(dT, dot(dO, dT)));
      if (len(u0) < 1e-6) continue; // straight on: nothing to butt against
      const u = unit(u0);
      const hT = c.type === "coped" ? 0 : reachAlong(shape, dot(u, tAxes.x), dot(u, tAxes.y)) + gap;
      const cut = plans[e.member].ends[e.end];
      const mq = reachOf(axesAt(e.member, e.end), mul(u, -1));
      cut.extend = Math.max(cut.extend, Math.max(0, (mq - hT) / dot(u, dO)) + 1);
      cut.cuts.push({ n: u, o: add(c.at, mul(u, hT)) });
      if (c.type === "coped") {
        cut.cope = [...(cut.cope ?? []), ...copeWith];
        cut.label = "coped";
      } else cut.label = angleFromSquare(u, dO);
      if (tEnd) {
        // The one running through reaches the far side of this one.
        const w0 = sub(mul(dT, -1), mul(dO, dot(mul(dT, -1), dO)));
        if (len(w0) < 1e-6) continue;
        const w = unit(w0);
        const hO = reachOf(axesAt(e.member, e.end), w);
        const minWQ = -reachAlong(shape, -dot(w, tAxes.x), -dot(w, tAxes.y));
        const ext = Math.max(0, (hO - minWQ) / dot(w, mul(dT, -1))) + 1;
        if (!tBest || ext > tBest.extend) tBest = { extend: ext, cut: { n: mul(w, -1), o: add(c.at, mul(w, hO)) } };
      }
    }
    if (tEnd && tBest) {
      const cut = plans[T].ends[tEnd.end];
      cut.extend = Math.max(cut.extend, tBest.extend);
      cut.cuts.push(tBest.cut);
      cut.label = angleFromSquare(tBest.cut.n, dT);
    }
  }
  return { members: plans, corners, notes };
}

/** Degrees between a cut and a square cut, for a member going along `d` (to 0.1°). */
export function angleFromSquare(n: V3, d: V3): number {
  const c = Math.min(1, Math.abs(dot(unit(n), unit(d))));
  return Math.round((Math.acos(c) * 180) / Math.PI * 10) / 10;
}

/** One straight member as it is to measure: its start, direction, path length, profile axes and the cuts on it. */
export interface StraightMember {
  start: V3;
  dir: V3;
  length: number;
  x: V3;
  y: V3;
  extend: [number, number];
  /** Keep n·(p − o) ≥ 0. */
  cuts: { n: V3; o: V3 }[];
  /** Coped ends: cut to the outline of a member crossing there (its axis through `at`, profile axes x/y). */
  copes: { end: 0 | 1; at: V3; x: V3; y: V3; shape: ProfileShape }[];
}

/** The profile's outside only (no slots, no holes), as copes and trims meet it. */
export function envelopeOf(shape: ProfileShape): ProfileShape {
  return { label: shape.label, regions: (shape.outline ?? shape.regions.map((r) => r.outer)).map((outer) => ({ outer, holes: [] })) };
}

/** Inside the profile's outlines, or on them (within 1 µm). */
function insideLoops(shape: ProfileShape, p: P2): boolean {
  if (onLoops(shape, p)) return true;
  let inside = false;
  for (const r of shape.regions) {
    const l = r.outer;
    if (l.kind === "circle") {
      if (Math.hypot(p[0] - l.c[0], p[1] - l.c[1]) < l.r) inside = !inside;
      continue;
    }
    for (let i = 0, j = l.pts.length - 1; i < l.pts.length; j = i++) {
      const a = l.pts[i];
      const b = l.pts[j];
      if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
  }
  return inside;
}

function onLoops(shape: ProfileShape, p: P2): boolean {
  const tol = 1e-6;
  for (const r of shape.regions) {
    const l = r.outer;
    if (l.kind === "circle") {
      if (Math.abs(Math.hypot(p[0] - l.c[0], p[1] - l.c[1]) - l.r) < tol) return true;
      continue;
    }
    for (let i = 0; i < l.pts.length; i++) {
      const a = l.pts[i];
      const b = l.pts[(i + 1) % l.pts.length];
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const L2 = ex * ex + ey * ey || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / L2));
      if (Math.hypot(a[0] + ex * t - p[0], a[1] + ey * t - p[1]) < tol) return true;
    }
  }
  return false;
}

/** Where the 2D line p0 + s·v crosses the profile's outlines (values of s). */
function crossings(shape: ProfileShape, p0: P2, v: P2): number[] {
  const out: number[] = [];
  for (const r of shape.regions) {
    const l = r.outer;
    if (l.kind === "circle") {
      const dx = p0[0] - l.c[0];
      const dy = p0[1] - l.c[1];
      const A = v[0] * v[0] + v[1] * v[1];
      const B = 2 * (dx * v[0] + dy * v[1]);
      const C = dx * dx + dy * dy - l.r * l.r;
      const D = B * B - 4 * A * C;
      if (A > 1e-12 && D >= 0) out.push((-B - Math.sqrt(D)) / (2 * A), (-B + Math.sqrt(D)) / (2 * A));
      continue;
    }
    for (let i = 0; i < l.pts.length; i++) {
      const a = l.pts[i];
      const b = l.pts[(i + 1) % l.pts.length];
      const e: P2 = [b[0] - a[0], b[1] - a[1]];
      const den = v[0] * e[1] - v[1] * e[0];
      if (Math.abs(den) < 1e-12) continue;
      const w: P2 = [a[0] - p0[0], a[1] - p0[1]];
      const s = (w[0] * e[1] - w[1] * e[0]) / den;
      const t = (w[0] * v[1] - w[1] * v[0]) / den;
      if (t >= 0 && t <= 1) out.push(s);
    }
  }
  return out;
}

/** Where a straight member's material reaches along its axis, from its start: [first point, last point], or null. */
export function memberRange(m: StraightMember, shape: ProfileShape): [number, number] | null {
  const pts = profilePoints(shape, 128);
  let lo = Infinity;
  let hi = -Infinity;
  for (const [px, py] of pts) {
    const Q = add(mul(m.x, px), mul(m.y, py));
    const base = add(m.start, Q);
    let a = -m.extend[0];
    let b = m.length + m.extend[1];
    let gone = false;
    for (const c of m.cuts) {
      const nd = dot(c.n, m.dir);
      const k = dot(c.n, sub(base, c.o));
      if (nd > 1e-9) a = Math.max(a, -k / nd);
      else if (nd < -1e-9) b = Math.min(b, -k / nd);
      else if (k < -1e-9) gone = true;
    }
    for (const cp of m.copes) {
      const at2 = (s: number): P2 => {
        const p = sub(add(base, mul(m.dir, s)), cp.at);
        return [dot(p, cp.x), dot(p, cp.y)];
      };
      const p0 = at2(0);
      const v: P2 = [dot(m.dir, cp.x), dot(m.dir, cp.y)];
      const xs = crossings(cp.shape, p0, v).sort((u, w) => u - w);
      if (cp.end === 0 && insideLoops(cp.shape, at2(a))) {
        const next = xs.find((s) => s > a + 1e-9);
        if (next !== undefined) a = next;
      }
      if (cp.end === 1 && insideLoops(cp.shape, at2(b))) {
        const prev = [...xs].reverse().find((s) => s < b - 1e-9);
        if (prev !== undefined) b = prev;
      }
    }
    if (gone || b < a) continue;
    lo = Math.min(lo, a);
    hi = Math.max(hi, b);
  }
  return hi > lo ? [lo, hi] : null;
}

/** The cut length of a straight member: from the furthest point at one end to the furthest at the other (mm). */
export function cutLength(m: StraightMember, shape: ProfileShape): number {
  const r = memberRange(m, shape);
  return r ? r[1] - r[0] : 0;
}


/** A plan's straight member ready to measure (cuts from both ends; copes to the outline of the member(s) running through). */
export function straightMember(plan: FramePlan, i: number, shape: ProfileShape): StraightMember | null {
  const p = plan.members[i];
  if (!p.straight) return null;
  const s = p.member.segs[0];
  const copes: StraightMember["copes"] = [];
  const env = envelopeOf(shape);
  for (const end of [0, 1] as const) {
    for (const t of p.ends[end].cope ?? []) {
      const corner = plan.corners.find((c) => c.ends.some((e) => e.member === i && e.end === end));
      const at = corner?.at ?? (end === 0 ? s.a : s.b);
      const tp = plan.members[t];
      const tEnd = corner?.ends.find((e) => e.member === t)?.end;
      const ax = corner?.on === t && corner.onSeg !== undefined ? tp.frames[corner.onSeg] : tEnd === 1 ? tp.frames[tp.frames.length - 1] : tp.frames[0];
      copes.push({ end, at, x: ax.x, y: ax.y, shape: env });
    }
  }
  return {
    start: s.a,
    dir: segTangent(s, false),
    length: segLength(s),
    x: p.frames[0].x,
    y: p.frames[0].y,
    extend: [p.ends[0].extend, p.ends[1].extend],
    cuts: [...p.ends[0].cuts, ...p.ends[1].cuts],
    copes,
  };
}

/** A member's centre line as points (with its lengthened ends), for measuring a curved member. */
export function centreLine(p: MemberPlan): V3[] {
  const m = p.member;
  const pts: V3[] = [];
  const t0 = segTangent(m.segs[0], false);
  if (!m.closed && p.ends[0].extend > 0) pts.push(add(m.segs[0].a, mul(t0, -p.ends[0].extend)));
  for (const s of m.segs) {
    if (s.kind === "line") pts.push(s.a);
    else if (s.kind === "curve") pts.push(...s.pts.slice(0, -1));
    else {
      const n = Math.max(8, Math.ceil(s.angle / (Math.PI / 64)));
      for (let k = 0; k < n; k++) pts.push(add(s.c, rotate(sub(s.a, s.c), s.axis, (s.angle * k) / n)));
    }
  }
  const last = m.segs[m.segs.length - 1];
  pts.push(last.b);
  if (!m.closed && p.ends[1].extend > 0) pts.push(add(last.b, mul(segTangent(last, true), p.ends[1].extend)));
  return pts;
}

/** A polyline's length. */
export function polylineLength(pts: V3[]): number {
  let t = 0;
  for (let i = 1; i < pts.length; i++) t += dist(pts[i - 1], pts[i]);
  return t;
}

/** The part of a polyline where n·(p − o) ≥ 0 (the longest stretch). */
export function clipPolyline(pts: V3[], n: V3, o: V3): V3[] {
  const side = (p: V3) => dot(n, sub(p, o));
  const runs: V3[][] = [];
  let cur: V3[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const sp = side(p);
    if (i > 0) {
      const q = pts[i - 1];
      const sq = side(q);
      if ((sq < 0) !== (sp < 0)) {
        const x = add(q, mul(sub(p, q), sq / (sq - sp)));
        if (sp < 0) {
          cur.push(x);
          runs.push(cur);
          cur = [];
        } else cur.push(x);
      }
    }
    if (sp >= 0) cur.push(p);
  }
  if (cur.length) runs.push(cur);
  return runs.sort((a, b) => polylineLength(b) - polylineLength(a))[0] ?? [];
}

/** What a member's cut list line says. */
export function memberInfo(plan: FramePlan, i: number, shape: ProfileShape, frameId: string, usual?: string): FrameMemberInfo {
  const p = plan.members[i];
  const sm = straightMember(plan, i, shape);
  const length = sm ? cutLength(sm, shape) : p.pathLength + (p.member.closed ? 0 : p.ends[0].extend + p.ends[1].extend);
  return {
    frame: frameId,
    member: i + 1,
    profile: shape.label,
    length: Math.round(length * 100) / 100,
    ends: [p.ends[0].label, p.ends[1].label],
    ...(sm ? {} : { curved: true }),
    ...(usual ? { usual } : {}),
  };
}

/** Which end of a straight member a cut keeping n·(p − o) ≥ 0 trims: the end n points away from. */
export const trimmedEnd = (m: StraightMember, n: V3): 0 | 1 => (dot(m.dir, n) > 0 ? 0 : 1);

/** A straight member trimmed by a plane (keeping n·(p − o) ≥ 0): the new cut list line. */
export function trimmedInfo(info: FrameMemberInfo, m: StraightMember, shape: ProfileShape, cut: { n: V3; o: V3 }): { info: FrameMemberInfo; member: StraightMember } {
  const member = { ...m, cuts: [...m.cuts, cut] };
  const end = trimmedEnd(m, cut.n);
  const ends: FrameMemberInfo["ends"] = [...info.ends];
  ends[end] = angleFromSquare(cut.n, m.dir);
  return { info: { ...info, length: Math.round(cutLength(member, shape) * 100) / 100, ends }, member };
}

/**
 * Gusset: the triangular plate in the inside corner between two straight members meeting at an end of each, or one
 * ending on the other's side (then `flip` picks which side of it): its corners (3, or 4 with the inside corner cut
 * off) and its normal; the plate is `thickness` thick, centred on the plane through both members. Or a plain message.
 */
export function gussetOutline(a: StraightMember, b: StraightMember, shapeA: ProfileShape, shapeB: ProfileShape, size: number, chamfer: number, flip = false): { pts: V3[]; n: V3; angle: number } | string {
  const endsOf = (m: StraightMember): [V3, V3][] => [
    [m.start, m.dir],
    [add(m.start, mul(m.dir, m.length)), mul(m.dir, -1)],
  ];
  const onSide = (m: StraightMember, p: V3) => {
    const d = dot(sub(p, m.start), m.dir);
    return d > JOIN_TOL * 10 && d < m.length - JOIN_TOL * 10 && dist(add(m.start, mul(m.dir, d)), p) < JOIN_TOL * 10;
  };
  let best: { p: V3; da: V3; db: V3; ma: StraightMember; mb: StraightMember; sa: ProfileShape; sb: ProfileShape } | null = null;
  for (const [pa, da] of endsOf(a)) for (const [pb, db] of endsOf(b)) if (dist(pa, pb) < JOIN_TOL * 10 && !best) best = { p: pa, da, db, ma: a, mb: b, sa: shapeA, sb: shapeB };
  // One ending on the side of the other: the plate goes along the one it meets (one way or, flipped, the other).
  if (!best) for (const [pb, db] of endsOf(b)) if (!best && onSide(a, pb)) best = { p: pb, da: flip ? mul(a.dir, -1) : a.dir, db, ma: a, mb: b, sa: shapeA, sb: shapeB };
  if (!best) for (const [pa, da] of endsOf(a)) if (!best && onSide(b, pa)) best = { p: pa, da: flip ? mul(b.dir, -1) : b.dir, db: da, ma: b, mb: a, sa: shapeB, sb: shapeA };
  if (!best) return "These two members don't meet at a corner (an end of each in the same place, or one ending on the other's side). Pick two that do.";
  const { p, da, db, ma, mb, sa, sb } = best;
  const c = dot(da, db);
  const angle = (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
  if (angle < SHARPEST || angle > 170) return `The members meet at ${Math.round(angle)}°, too ${angle < 90 ? "sharp" : "flat"} a corner for a gusset.`;
  const s = Math.sqrt(1 - c * c);
  const uA = unit(sub(db, mul(da, c)));
  const uB = unit(sub(da, mul(db, c)));
  const hA = reachAlong(sa, dot(uA, ma.x), dot(uA, ma.y));
  const hB = reachAlong(sb, dot(uB, mb.x), dot(uB, mb.y));
  // In the plane: e1 = da, e2 = uA; the inside corner where both inner faces meet.
  const x = (hB + c * hA) / s;
  const C = add(p, add(mul(da, x), mul(uA, hA)));
  if (!(size > chamfer)) return "The gusset's size must be more than its chamfer.";
  const pts = chamfer > 0 ? [add(C, mul(da, chamfer)), add(C, mul(da, size)), add(C, mul(db, size)), add(C, mul(db, chamfer))] : [C, add(C, mul(da, size)), add(C, mul(db, size))];
  return { pts, n: unit(cross(da, db)), angle };
}

/** A gusset plate's volume (mm³). */
export function gussetVolume(size: number, chamfer: number, angleDeg: number, thickness: number): number {
  const s = Math.sin((angleDeg * Math.PI) / 180);
  return 0.5 * (size * size - chamfer * chamfer) * s * thickness;
}

/* ---------------------------------------------------------------- cut list */

/** What a profile family is usually made of: aluminium extrusion, steel sections, timber (oak's weight); own sketches PLA. */
export function usualMaterial(kind: FrameDef["profile"]["kind"]): string {
  return kind === "extrusion" ? "aluminium" : kind === "timber" ? "oak" : kind === "sketch" ? "pla" : "steel";
}

export interface CutListPart {
  id: string;
  name: string;
  frame?: FrameMemberInfo;
  volume?: number;
}

export interface CutListRow {
  profile: string;
  /** mm, to 0.1. */
  length: number;
  /** "45° / 45°", "square / square", "coped / 45°". */
  ends: string;
  quantity: number;
  parts: string[];
  /** Grams each (from the part's volume and material), when known. */
  massEach?: number;
  curved?: boolean;
}

export interface CutListTotal {
  profile: string;
  quantity: number;
  /** mm. */
  length: number;
  mass?: number;
}

const endWord = (e: number | "coped") => (e === "coped" ? "coped" : e === 0 ? "square" : `${e}°`);

/** The cut list: identical members (same profile, length to 0.1 mm and end cuts) grouped, and totals per profile. */
export function cutList(parts: CutListPart[], massOf?: (part: CutListPart) => number | undefined): { rows: CutListRow[]; totals: CutListTotal[] } {
  const rows: CutListRow[] = [];
  for (const p of parts) {
    if (!p.frame) continue;
    const f = p.frame;
    const length = Math.round(f.length * 10) / 10;
    const pair = [endWord(f.ends[0]), endWord(f.ends[1])].sort();
    const ends = `${pair[0]} / ${pair[1]}`;
    const row = rows.find((r) => r.profile === f.profile && r.length === length && r.ends === ends && !!r.curved === !!f.curved);
    const m = massOf?.(p);
    if (row) {
      row.quantity++;
      row.parts.push(p.name);
    } else rows.push({ profile: f.profile, length, ends, quantity: 1, parts: [p.name], ...(m !== undefined ? { massEach: m } : {}), ...(f.curved ? { curved: true } : {}) });
  }
  rows.sort((a, b) => a.profile.localeCompare(b.profile) || b.length - a.length);
  const totals: CutListTotal[] = [];
  for (const r of rows) {
    let t = totals.find((x) => x.profile === r.profile);
    if (!t) totals.push((t = { profile: r.profile, quantity: 0, length: 0 }));
    t.quantity += r.quantity;
    t.length = Math.round((t.length + r.length * r.quantity) * 10) / 10;
    if (r.massEach !== undefined) t.mass = (t.mass ?? 0) + r.massEach * r.quantity;
  }
  return { rows, totals };
}

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** The cut list as CSV text (a header row, a line per group, then the totals). */
export function cutListCsv(list: { rows: CutListRow[]; totals: CutListTotal[] }): string {
  const lines = [["Item", "Quantity", "Profile", "Cut length (mm)", "End cuts", "Mass each (g)", "Parts"].join(",")];
  list.rows.forEach((r, i) => {
    lines.push([String(i + 1), String(r.quantity), csvCell(r.profile), r.length.toFixed(1) + (r.curved ? " (along the curve)" : ""), csvCell(r.ends), r.massEach !== undefined ? r.massEach.toFixed(1) : "", csvCell(r.parts.join("; "))].join(","));
  });
  lines.push("");
  lines.push(["Profile", "Pieces", "Total length (mm)", "Total mass (g)"].join(","));
  for (const t of list.totals) lines.push([csvCell(t.profile), String(t.quantity), t.length.toFixed(1), t.mass !== undefined ? t.mass.toFixed(1) : ""].join(","));
  return lines.join("\n") + "\n";
}

/* ---------------------------------------------------------------- reading files */

const FRAME_KINDS = new Set(["extrusion", "box", "angle", "tube", "flat", "timber"]);
const ANCHOR_KEYS = new Set(["centre", "top", "bottom", "left", "right", "topLeft", "topRight", "bottomLeft", "bottomRight"]);
const CORNER_TYPES = new Set(["mitre", "butt", "coped", "none"]);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A frame's settings from a saved file (odd values fall back; null when there's nothing usable). */
export function parseFrameDef(raw: unknown, readPick?: (v: unknown) => TopoPick | null): FrameDef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const paths = (Array.isArray(r.paths) ? r.paths : [])
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && typeof (p as Record<string, unknown>).sketch === "string")
    .map((p) => ({ sketch: p.sketch as string, ...(Array.isArray(p.items) ? { items: strs(p.items) } : {}) }));
  const pr = (r.profile ?? {}) as Record<string, unknown>;
  const profile: FrameDef["profile"] =
    pr.kind === "sketch" && typeof pr.sketch === "string"
      ? { kind: "sketch", sketch: pr.sketch }
      : typeof pr.kind === "string" && FRAME_KINDS.has(pr.kind) && typeof pr.size === "string"
        ? { kind: pr.kind as Exclude<FrameDef["profile"]["kind"], "sketch">, size: pr.size }
        : { kind: "extrusion", size: "2020" };
  const corners = (Array.isArray(r.corners) ? r.corners : [])
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .filter((c) => typeof c.key === "string" && typeof c.type === "string" && CORNER_TYPES.has(c.type))
    .map((c) => ({ key: c.key as string, type: c.type as FrameCornerType, ...(typeof c.through === "string" ? { through: c.through } : {}) }));
  const edges = readPick && Array.isArray(r.edges) ? r.edges.map(readPick).filter((p): p is TopoPick => !!p && p.ref.kind === "edge") : [];
  const curves = [...new Set(strs(r.curves))];
  return {
    paths,
    profile,
    ...(typeof r.anchor === "string" && ANCHOR_KEYS.has(r.anchor) && r.anchor !== "centre" ? { anchor: r.anchor as FrameDef["anchor"] } : {}),
    ...(r.mirror === true ? { mirror: true } : {}),
    ...(r.noMerge === true ? { noMerge: true } : {}),
    ...(corners.length ? { corners } : {}),
    ...(edges.length ? { edges } : {}),
    ...(curves.length ? { curves } : {}),
  };
}

/** Trim frame's settings from a file (`plane` read by the caller's plane reader). */
export function parseTrimFrame(raw: unknown, readPlane: (v: unknown) => SketchPlane | null): TrimFrameDef {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const plane = r.plane ? readPlane(r.plane) : null;
  return {
    parts: strs(r.parts),
    ...(plane ? { plane } : {}),
    ...(typeof r.to === "string" ? { to: r.to } : {}),
    ...(r.flip === true ? { flip: true } : {}),
    ...(r.picking === "target" || r.picking === "members" || r.picking === "targetPart" ? { picking: r.picking } : {}),
  };
}

export function parseGusset(raw: unknown): GussetDef {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { parts: strs(r.parts).slice(0, 2), ...(r.chamfer === true ? { chamfer: true } : {}), ...(r.flip === true ? { flip: true } : {}) };
}

/** What a frame, trim or gusset needs from other features: sketches (all needed, the path a list) and parts. */
export function frameUses(f: { frame?: FrameDef; trimFrame?: TrimFrameDef; gusset?: GussetDef }): { pathSketches: string[]; pathCurves: string[]; pathParts: string[]; sketches: string[]; parts: string[]; trimParts: string[]; planeRef?: string } {
  const pathSketches = f.frame ? [...new Set(f.frame.paths.map((p) => p.sketch))] : [];
  const pathCurves = f.frame?.curves ?? [];
  const pathParts = (f.frame?.edges ?? []).map((e) => e.partId);
  const sketches = f.frame?.profile.kind === "sketch" ? [f.frame.profile.sketch] : [];
  const parts = [...(f.gusset?.parts ?? []), ...(f.trimFrame?.to ? [f.trimFrame.to] : [])];
  const plane = f.trimFrame?.plane;
  return { pathSketches, pathCurves, pathParts, sketches, parts, trimParts: f.trimFrame?.parts ?? [], ...(plane?.kind === "face" && plane.planeRef ? { planeRef: plane.planeRef } : {}) };
}

/** The cut list of a Part Studio's parts, weighed with each part's material (or the profile's usual one). */
export function frameCutList(parts: CutListPart[], materials: Record<string, string> | undefined): { rows: CutListRow[]; totals: CutListTotal[] } {
  return cutList(parts, (p) => (p.volume !== undefined && p.frame ? massGrams(p.volume, materials?.[p.id] ?? p.frame.usual) : undefined));
}

/** The cut list as plain lines (for Claude and the dialog's copy). */
export function cutListLines(list: { rows: CutListRow[]; totals: CutListTotal[] }): string[] {
  if (!list.rows.length) return ["There are no frame members (make some with a Frame feature)."];
  const kg = (g: number) => (g >= 1000 ? `${Math.round(g / 10) / 100} kg` : `${Math.round(g)} g`);
  return [
    ...list.rows.map((r, i) => `${i + 1}. ${r.quantity} × ${r.profile}, ${r.length.toFixed(1)} mm${r.curved ? " along the curve" : ""}, ends ${r.ends}${r.massEach !== undefined ? `, ${kg(r.massEach)} each` : ""} (${r.parts.join(", ")})`),
    ...list.totals.map((t) => `Total ${t.profile}: ${t.quantity} piece${t.quantity === 1 ? "" : "s"}, ${(t.length / 1000).toFixed(3)} m${t.mass !== undefined ? `, ${kg(t.mass)}` : ""}`),
  ];
}

/** The corners of a frame's path as they'll be built (type and the member running through), for the dialog, with the members. */
export function frameCornersFor(segs: PathSeg[], def: Pick<FrameDef, "noMerge" | "corners">): { corners: FrameCorner[]; members: Member[] } {
  const l = frameLayout(segs, def);
  return { corners: l.corners, members: l.members };
}

/**
 * A sketch line clicked while a Frame is open: left out of the path if it's on it (a whole sketch becomes "all its
 * curves but that one"), put back (or the sketch added with just it) if not.
 */
export function togglePathLine(def: FrameDef, features: { id: string; type: string; sketch?: { data: SketchData } }[], sketch: string, line: string): FrameDef {
  const path = def.paths.find((p) => p.sketch === sketch);
  const all = (features.find((f) => f.id === sketch)?.sketch?.data.curves ?? []).filter((c) => !c.construction && (c.type === "line" || c.type === "arc" || c.type === "circle")).map((c) => c.id);
  let paths: FrameDef["paths"];
  if (!path) paths = [...def.paths, { sketch, items: [line] }];
  else {
    const items = path.items ?? all;
    const next = items.includes(line) ? items.filter((x) => x !== line) : [...items, line];
    const whole = all.every((id) => next.includes(id));
    paths = next.length ? def.paths.map((p) => (p.sketch === sketch ? (whole ? { sketch } : { sketch, items: next }) : p)) : def.paths.filter((p) => p.sketch !== sketch);
  }
  return { ...def, paths };
}

/** A part edge clicked while a Frame is open: followed by the frame (added to its edges), or left out again. */
export function togglePathEdge(def: FrameDef, pick: TopoPick, same: (a: TopoPick, b: TopoPick) => boolean): FrameDef {
  const list = def.edges ?? [];
  const at = list.findIndex((e) => same(e, pick));
  const edges = at >= 0 ? list.filter((_, i) => i !== at) : [...list, { partId: pick.partId, ref: pick.ref }];
  const { edges: _old, ...rest } = def;
  return edges.length ? { ...rest, edges } : rest;
}

/** A curve feature clicked while a Frame is open: followed (added) or left out again. */
export function togglePathCurve(def: FrameDef, curve: string): FrameDef {
  const list = def.curves ?? [];
  const curves = list.includes(curve) ? list.filter((c) => c !== curve) : [...list, curve];
  const { curves: _old, ...rest } = def;
  return curves.length ? { ...rest, curves } : rest;
}

/** Ids of path segments from part edges ("<part>/e<k>", k = the edge's place in `def.edges`) and curve features ("<curve>/<piece>.<edge>"). */
export const edgeSegId = (partId: string, k: number) => `${partId}/e${k}`;
export const curveSegId = (curveId: string, wire: number, edge: number) => `${curveId}/${wire}.${edge}`;
