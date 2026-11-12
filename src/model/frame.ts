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
  | { kind: "arc"; id: string; a: V3; b: V3; c: V3; axis: V3; angle: number; r: number; n: V3 };

/** Where a segment is going at its start (t = 0) or end (t = 1). */
export function segTangent(s: PathSeg, atEnd: boolean): V3 {
  if (s.kind === "line") return unit(sub(s.b, s.a));
  const p = atEnd ? s.b : s.a;
  return unit(cross(s.axis, sub(p, s.c)));
}

export function segLength(s: PathSeg): number {
  return s.kind === "line" ? dist(s.a, s.b) : s.r * s.angle;
}

function reversedSeg(s: PathSeg): PathSeg {
  if (s.kind === "line") return { ...s, a: s.b, b: s.a };
  return { ...s, a: s.b, b: s.a, axis: mul(s.axis, -1) };
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

/** A frame member: path segments in order, end to end. */
export interface Member {
  segs: PathSeg[];
  closed: boolean;
}

/** Join the path's segments into members (each segment its own, or runs carrying on smoothly when `merge`). */
export function buildMembers(segs: PathSeg[], merge: boolean): Member[] {
  if (!merge) return segs.map((s) => ({ segs: [s], closed: s.kind === "arc" && s.angle >= 2 * Math.PI - 1e-9 }));
  const used = new Set<number>();
  const ends = (i: number) => [segs[i].a, segs[i].b];
  // Ends of other segments at a point.
  const at = (p: V3) => {
    const out: { i: number; end: 0 | 1 }[] = [];
    segs.forEach((s, i) => {
      if (dist(s.a, p) < JOIN_TOL) out.push({ i, end: 0 });
      if (dist(s.b, p) < JOIN_TOL) out.push({ i, end: 1 });
    });
    return out;
  };
  const smoothWith = (s: PathSeg, atEnd: boolean, o: PathSeg, oEnd: 0 | 1) => {
    const t = segTangent(s, atEnd);
    const to = segTangent(o, oEnd === 1);
    const along = oEnd === 0 ? to : mul(to, -1);
    const turn = (Math.acos(Math.max(-1, Math.min(1, dot(atEnd ? t : mul(t, -1), atEnd ? along : mul(along, -1))))) * 180) / Math.PI;
    return turn < STRAIGHT_DEG && dot(s.n, o.n) > 0.9999;
  };
  const members: Member[] = [];
  for (let start = 0; start < segs.length; start++) {
    if (used.has(start)) continue;
    used.add(start);
    const chain: PathSeg[] = [segs[start]];
    const self = segs[start];
    if (self.kind === "arc" && self.angle >= 2 * Math.PI - 1e-9) {
      members.push({ segs: chain, closed: true });
      continue;
    }
    // Grow forwards from the last end, then backwards from the first.
    for (const forward of [true, false]) {
      for (;;) {
        const tip = forward ? chain[chain.length - 1] : chain[0];
        const p = forward ? tip.b : tip.a;
        const there = at(p);
        if (there.length !== 2) break;
        const next = there.find((e) => !(segs[e.i] === tip && e.end === (forward ? 1 : 0)));
        if (!next || used.has(next.i)) break;
        const o = segs[next.i];
        if (!smoothWith(tip, forward, o, next.end)) break;
        used.add(next.i);
        // Turned to run the chain's way.
        const turned = forward ? (next.end === 0 ? o : reversedSeg(o)) : next.end === 1 ? o : reversedSeg(o);
        if (forward) chain.push(turned);
        else chain.unshift(turned);
      }
    }
    void ends;
    const closed = chain.length > 1 && dist(chain[0].a, chain[chain.length - 1].b) < JOIN_TOL;
    members.push({ segs: chain, closed });
  }
  return members;
}

/** The profile's axes at a place where the path goes along `t` in a sketch with normal `n`: across (x) and up (y). */
export function profileAxes(t: V3, n: V3): { x: V3; y: V3 } {
  let x = unit(cross(n, t));
  if (len(x) < 0.5) x = unit(cross(Math.abs(t[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], t));
  return { x, y: cross(t, x) };
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
  /** A T: the member whose side the end meets (it doesn't end here). */
  on?: number;
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
  /** Cut to the outside of this member (coped). */
  cope?: number;
  /** For the cut list: degrees from square, or coped. */
  label: number | "coped";
}

export interface MemberPlan {
  member: Member;
  /** Segment id at each end (for corner keys), and the end points and directions out of each end. */
  ends: [EndCut, EndCut];
  /** Profile axes at each end. */
  axes: [{ x: V3; y: V3 }, { x: V3; y: V3 }];
  straight: boolean;
  /** The centre line's length. */
  pathLength: number;
}

export interface FramePlan {
  members: MemberPlan[];
  corners: FrameCorner[];
}

export const memberStart = (m: Member) => m.segs[0].a;
export const memberEnd = (m: Member) => m.segs[m.segs.length - 1].b;
/** The direction out of a member's end, away from its corner. */
export function outOf(m: Member, end: 0 | 1): V3 {
  return end === 0 ? segTangent(m.segs[0], false) : mul(segTangent(m.segs[m.segs.length - 1], true), -1);
}
const endPoint = (m: Member, end: 0 | 1) => (end === 0 ? memberStart(m) : memberEnd(m));
const endSegId = (m: Member, end: 0 | 1) => (end === 0 ? m.segs[0].id : m.segs[m.segs.length - 1].id);

function axesAt(m: Member, end: 0 | 1, angle0: { x: V3; y: V3 }[]) {
  void angle0;
  const s = end === 0 ? m.segs[0] : m.segs[m.segs.length - 1];
  return profileAxes(segTangent(s, end === 1), s.n);
}

/** Where on a straight member a point lies: its distance along, or null if off it or at an end. */
function onStraight(m: Member, p: V3): number | null {
  if (m.segs.length !== 1 || m.segs[0].kind !== "line") return null;
  const a = m.segs[0].a;
  const t = segTangent(m.segs[0], false);
  const L = segLength(m.segs[0]);
  const s = dot(sub(p, a), t);
  if (s < JOIN_TOL * 10 || s > L - JOIN_TOL * 10) return null;
  return dist(add(a, mul(t, s)), p) < JOIN_TOL ? s : null;
}

/** A corner's key: the curves meeting there (sorted), and the one a T meets the side of. */
export function cornerKey(ids: string[], on?: string): string {
  return [...ids].sort().join("+") + (on ? `|on:${on}` : "");
}

/** The corners of a set of members (where ends meet, and Ts), with their default types. */
export function findCorners(members: Member[]): Omit<FrameCorner, "type" | "through">[] {
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
  for (const g of groups) {
    const ids = g.ends.map((e) => endSegId(members[e.member], e.end));
    if (g.ends.length === 1) {
      // A free end against the side of a straight member: a T.
      const on = members.findIndex((m, i) => i !== g.ends[0].member && onStraight(m, g.at) !== null);
      if (on < 0) continue;
      out.push({ key: cornerKey(ids, members[on].segs[0].id), at: g.at, ends: g.ends, on, choices: ["butt", "coped", "none"] });
      continue;
    }
    let angle: number | undefined;
    if (g.ends.length === 2) {
      const da = outOf(members[g.ends[0].member], g.ends[0].end);
      const db = outOf(members[g.ends[1].member], g.ends[1].end);
      angle = (Math.acos(Math.max(-1, Math.min(1, dot(da, db)))) * 180) / Math.PI;
    }
    out.push({ key: cornerKey(ids), at: g.at, ends: g.ends, ...(angle !== undefined ? { angle } : {}), choices: g.ends.length === 2 ? ["mitre", "butt", "coped", "none"] : ["butt", "coped", "none"] });
  }
  return out;
}

/** The usual type of a corner: a mitre between two members (none if they carry straight on), a butt joint otherwise. */
function defaultType(c: Omit<FrameCorner, "type" | "through">): FrameCornerType {
  if (c.on !== undefined) return "butt";
  if (c.ends.length === 2) return (c.angle ?? 0) > 180 - STRAIGHT_DEG ? "none" : "mitre";
  return "butt";
}

/** Too sharp to mitre or butt (degrees between the members). */
export const SHARPEST = 10;

/**
 * The whole plan: members, corners as chosen (`def.corners`, else the usual) and each member end's cuts, for a
 * placed profile and a gap (mm). A plain message when it can't be made.
 */
export function planFrame(segs: PathSeg[], def: Pick<FrameDef, "noMerge" | "corners">, shape: ProfileShape, gap: number): FramePlan | string {
  if (!segs.length) return "Pick the sketch lines or arcs for the frame to follow.";
  const members = buildMembers(segs, !def.noMerge);
  const raw = findCorners(members);
  const plans: MemberPlan[] = members.map((m) => ({
    member: m,
    ends: [
      { extend: 0, cuts: [], label: 0 },
      { extend: 0, cuts: [], label: 0 },
    ],
    axes: [axesAt(m, 0, []), axesAt(m, 1, [])],
    straight: m.segs.every((s) => s.kind === "line") && m.segs.length === 1,
    pathLength: m.segs.reduce((t, s) => t + segLength(s), 0),
  }));
  const reachOf = (mi: number, end: 0 | 1, dir: V3) => {
    const ax = plans[mi].axes[end];
    return reachAlong(shape, dot(dir, ax.x), dot(dir, ax.y));
  };
  const corners: FrameCorner[] = [];
  for (const c of raw) {
    const chosen = def.corners?.find((x) => x.key === c.key);
    let type = chosen && c.choices.includes(chosen.type) ? chosen.type : defaultType(c);
    const memberOfId = (id?: string) => {
      if (!id) return undefined;
      if (c.on !== undefined && members[c.on].segs.some((s) => s.id === id)) return c.on;
      return c.ends.find((e) => endSegId(members[e.member], e.end) === id)?.member;
    };
    let through = c.on ?? memberOfId(chosen?.through) ?? c.ends[0].member;
    if (c.on !== undefined) through = c.on;
    const corner: FrameCorner = { ...c, type, ...(type === "butt" || type === "coped" ? { through } : {}) };
    corners.push(corner);
    if (type === "none") continue;
    if (c.angle !== undefined && c.angle < SHARPEST) return `Two members meet at a very sharp corner (${Math.round(c.angle)}°). Set that corner to None, or change the path.`;
    if (type === "mitre") {
      const [ea, eb] = c.ends;
      const da = outOf(members[ea.member], ea.end);
      const db = outOf(members[eb.member], eb.end);
      const m = unit(sub(da, db));
      for (const [e, n, d] of [
        [ea, m, da],
        [eb, mul(m, -1), db],
      ] as const) {
        const cut = plans[e.member].ends[e.end];
        const mq = reachOf(e.member, e.end, n);
        cut.extend = Math.max(cut.extend, Math.max(0, (mq - gap / 2) / dot(n, d)) + 1);
        cut.cuts.push({ n, o: add(c.at, mul(n, gap / 2)) });
        cut.label = angleFromSquare(n, d);
      }
      continue;
    }
    // Butt or coped: `through` runs on; the others stop at its side (coped: at its middle, then cut to its shape).
    const T = through;
    const tEnd = c.ends.find((e) => e.member === T);
    const dT = tEnd ? outOf(members[T], tEnd.end) : segTangent(members[T].segs[0], false);
    const tAxes = tEnd ? plans[T].axes[tEnd.end] : plans[T].axes[0];
    let tBest: { extend: number; cut: { n: V3; o: V3 } } | null = null;
    for (const e of c.ends) {
      if (e.member === T) continue;
      const dO = outOf(members[e.member], e.end);
      const u0 = sub(dO, mul(dT, dot(dO, dT)));
      if (len(u0) < 1e-6) continue; // straight on: nothing to butt against
      const u = unit(u0);
      const hT = type === "coped" ? 0 : reachAlong(shape, dot(u, tAxes.x), dot(u, tAxes.y)) + gap;
      const cut = plans[e.member].ends[e.end];
      const mq = reachOf(e.member, e.end, mul(u, -1));
      // s ≥ (hT − u·Q)/(u·dO) for every point Q; the most negative wants the end lengthened.
      cut.extend = Math.max(cut.extend, Math.max(0, (mq - hT) / dot(u, dO)) + 1);
      cut.cuts.push({ n: u, o: add(c.at, mul(u, hT)) });
      if (type === "coped") {
        cut.cope = T;
        cut.label = "coped";
      } else cut.label = angleFromSquare(u, dO);
      if (tEnd) {
        // The one running through reaches the far side of this one.
        const w0 = sub(mul(dT, -1), mul(dO, dot(mul(dT, -1), dO)));
        if (len(w0) < 1e-6) continue;
        const w = unit(w0);
        const ax = plans[e.member].axes[e.end];
        const hO = reachAlong(shape, dot(w, ax.x), dot(w, ax.y));
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
  return { members: plans, corners };
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

function insideLoops(shape: ProfileShape, p: P2): boolean {
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

/** The cut length of a straight member: from the furthest point at one end to the furthest at the other (mm). */
export function cutLength(m: StraightMember, shape: ProfileShape): number {
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
  return hi > lo ? hi - lo : 0;
}

/** A plan's straight member ready to measure (cuts from both ends; copes to the member running through). */
export function straightMember(plan: FramePlan, i: number, shape: ProfileShape): StraightMember | null {
  const p = plan.members[i];
  if (!p.straight) return null;
  const s = p.member.segs[0];
  const copes: StraightMember["copes"] = [];
  for (const end of [0, 1] as const) {
    const t = p.ends[end].cope;
    if (t === undefined) continue;
    const corner = plan.corners.find((c) => c.ends.some((e) => e.member === i && e.end === end));
    const tp = plan.members[t];
    const tEnd = corner?.ends.find((e) => e.member === t)?.end ?? 0;
    copes.push({ end, at: corner?.at ?? s.a, x: tp.axes[tEnd].x, y: tp.axes[tEnd].y, shape });
  }
  return {
    start: s.a,
    dir: segTangent(s, false),
    length: segLength(s),
    x: p.axes[0].x,
    y: p.axes[0].y,
    extend: [p.ends[0].extend, p.ends[1].extend],
    cuts: [...p.ends[0].cuts, ...p.ends[1].cuts],
    copes,
  };
}

/** What a member's cut list line says. */
export function memberInfo(plan: FramePlan, i: number, shape: ProfileShape, frameId: string, usual?: string): FrameMemberInfo {
  const p = plan.members[i];
  const sm = straightMember(plan, i, shape);
  const open = !p.member.closed;
  const length = sm ? cutLength(sm, shape) : p.pathLength + (open ? p.ends[0].extend + p.ends[1].extend : 0);
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

/** Which end of a straight member a trim plane is nearer, and the new line for the cut list. */
export function trimmedInfo(info: FrameMemberInfo, m: StraightMember, shape: ProfileShape, cut: { n: V3; o: V3 }): { info: FrameMemberInfo; member: StraightMember } {
  const member = { ...m, cuts: [...m.cuts, cut] };
  const mid = add(m.start, mul(m.dir, m.length / 2));
  // The cut keeps the side n points to: it trims the end that n points away from.
  const end: 0 | 1 = dot(m.dir, cut.n) > 0 ? 0 : 1;
  void mid;
  const ends: FrameMemberInfo["ends"] = [...info.ends];
  ends[end] = angleFromSquare(cut.n, m.dir);
  return { info: { ...info, length: Math.round(cutLength(member, shape) * 100) / 100, ends }, member };
}

/**
 * Gusset: the triangular plate in the inside corner between two straight members meeting at an end of each (or one
 * ending on the other's side): its corners (3, or 4 with the inside corner cut off) and its normal; the plate is
 * `thickness` thick, centred on the plane through both members. Or a plain message.
 */
export function gussetOutline(a: StraightMember, b: StraightMember, shapeA: ProfileShape, shapeB: ProfileShape, size: number, chamfer: number): { pts: V3[]; n: V3; angle: number } | string {
  const endsA: [V3, V3][] = [
    [a.start, a.dir],
    [add(a.start, mul(a.dir, a.length)), mul(a.dir, -1)],
  ];
  const endsB: [V3, V3][] = [
    [b.start, b.dir],
    [add(b.start, mul(b.dir, b.length)), mul(b.dir, -1)],
  ];
  let best: { p: V3; da: V3; db: V3 } | null = null;
  for (const [pa, da] of endsA) for (const [pb, db] of endsB) if (dist(pa, pb) < JOIN_TOL * 10 && !best) best = { p: pa, da, db };
  if (!best) return "These two members don't meet at a corner (an end of each in the same place). Pick two that do.";
  const { p, da, db } = best;
  const c = dot(da, db);
  const angle = (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
  if (angle < SHARPEST || angle > 170) return `The members meet at ${Math.round(angle)}°, too ${angle < 90 ? "sharp" : "flat"} a corner for a gusset.`;
  const s = Math.sqrt(1 - c * c);
  const uA = unit(sub(db, mul(da, c)));
  const uB = unit(sub(da, mul(db, c)));
  const hA = reachAlong(shapeA, dot(uA, a.x), dot(uA, a.y));
  const hB = reachAlong(shapeB, dot(uB, b.x), dot(uB, b.y));
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
export function parseFrameDef(raw: unknown): FrameDef | null {
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
  return {
    paths,
    profile,
    ...(typeof r.anchor === "string" && ANCHOR_KEYS.has(r.anchor) && r.anchor !== "centre" ? { anchor: r.anchor as FrameDef["anchor"] } : {}),
    ...(r.mirror === true ? { mirror: true } : {}),
    ...(r.noMerge === true ? { noMerge: true } : {}),
    ...(corners.length ? { corners } : {}),
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
  return { parts: strs(r.parts).slice(0, 2), ...(r.chamfer === true ? { chamfer: true } : {}) };
}

/** What a frame, trim or gusset needs from other features: sketches (all needed, the path a list) and parts. */
export function frameUses(f: { frame?: FrameDef; trimFrame?: TrimFrameDef; gusset?: GussetDef }): { pathSketches: string[]; sketches: string[]; parts: string[]; trimParts: string[]; planeRef?: string } {
  const pathSketches = f.frame ? [...new Set(f.frame.paths.map((p) => p.sketch))] : [];
  const sketches = f.frame?.profile.kind === "sketch" ? [f.frame.profile.sketch] : [];
  const parts = [...(f.gusset?.parts ?? []), ...(f.trimFrame?.to ? [f.trimFrame.to] : [])];
  const plane = f.trimFrame?.plane;
  return { pathSketches, sketches, parts, trimParts: f.trimFrame?.parts ?? [], ...(plane?.kind === "face" && plane.planeRef ? { planeRef: plane.planeRef } : {}) };
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

/**
 * The corners of a frame's path as they'll be built (type and the member running through), for the dialog: worked out
 * with a 1 mm square stand-in profile (corners don't depend on the profile), with the members' numbers.
 */
export function frameCornersFor(segs: PathSeg[], def: Pick<FrameDef, "noMerge" | "corners">): { corners: FrameCorner[]; members: Member[] } {
  const square: ProfileShape = { label: "", regions: [{ outer: { kind: "poly", pts: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] }, holes: [] }] };
  const plan = planFrame(segs, def, square, 0);
  const members = buildMembers(segs, !def.noMerge);
  if (typeof plan !== "string") return { corners: plan.corners, members };
  return { corners: findCorners(members).map((c) => ({ ...c, type: "none" as const })), members };
}

/** The curve id ("sketch/curve") at a member's end, as Butt / Coped's `through` names it. */
export function endCurveId(m: Member, end: 0 | 1): string {
  return end === 0 ? m.segs[0].id : m.segs[m.segs.length - 1].id;
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
