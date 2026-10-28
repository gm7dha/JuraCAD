/**
 * Trim, Split and Offset for splines, conics and ellipses. The pieces left
 * by Trim and Split follow the original curve exactly (a spline's pieces are
 * cut with de Casteljau's construction, a conic's are conics, an ellipse's
 * are parts of the same ellipse). An offset of a spline or ellipse is a
 * spline that stays within OFFSET_TOLERANCE of the true offset and follows
 * the original when it changes (see `offset` in solver.ts).
 */
import { evaluate } from "../model/expr";
import { crossings, curveParam, ellipseSpan, nearestParam, offsetParams, offsetPieces, OFFSET_TOLERANCE, pieceOf, splinePieces, splineThrough, tightestBend, type CurveParam, type P2 } from "./curves";
import { bezierAt, bezierD1, bezierD2, conicAt, conicBetween, cubicOn } from "./spline";
import { curveEnds, curvePoints, deleteItems, onCurveType, settle, sketchId, type EditResult } from "./ops";
import { offsetSpan, solveSketch } from "./solver";
import type { SketchConstraint, SketchCurve, SketchData, SketchEllipse, SketchPoint, SketchSpline } from "./types";

type Wavy = SketchSpline | SketchEllipse;

export const isWavy = (c?: SketchCurve): c is Wavy => c?.type === "spline" || c?.type === "ellipse";

const con = (type: SketchConstraint["type"], refs: string[], value?: string, extra?: number[]): SketchConstraint => ({
  id: sketchId("c"),
  type,
  refs,
  ...(value !== undefined ? { value } : {}),
  ...(extra !== undefined ? { extra } : {}),
});

const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The ids of a curve's two ends (its first and last points), for an open spline, conic or part of an ellipse. */
function endIds(c: Wavy): [string, string] {
  if (c.type === "ellipse") return [c.start!, c.end!];
  return [c.points[0], c.points[c.points.length - 1]];
}

/** What it is, for messages. */
const named = (c: Wavy) => (c.type === "ellipse" ? (c.start ? "part of an ellipse" : "ellipse") : c.conic !== undefined ? "conic" : "spline");

/**
 * Offset copies follow their original by where along it each point sits;
 * once the original is cut those places mean nothing, so the copy (or this
 * curve, if it was a copy) becomes an ordinary spline.
 */
function unlinkOffsets(s: SketchData, ids: Set<string>): SketchData {
  const freed = new Set<string>();
  const constraints = s.constraints.flatMap((k): SketchConstraint[] => {
    if (k.type !== "offset") return [k];
    const refs: string[] = [];
    const extra: number[] = [];
    for (let i = 0; i + 1 < k.refs.length; i += 2) {
      const [copy, orig] = [k.refs[i], k.refs[i + 1]];
      const curve = s.curves.find((c) => c.id === copy);
      if (curve?.type === "spline" && curve.offsetParams && (ids.has(copy) || ids.has(orig))) {
        freed.add(copy);
        continue;
      }
      refs.push(copy, orig);
      if (k.extra?.[i / 2] !== undefined) extra.push(k.extra[i / 2]);
    }
    if (!refs.length) return [];
    return [{ ...k, refs, ...(k.extra ? { extra } : {}) }];
  });
  const curves = s.curves.map((c) => {
    if (c.type !== "spline" || !freed.has(c.id)) return c;
    const { offsetParams: _gone, ...rest } = c;
    void _gone;
    return rest;
  });
  return { ...s, curves, constraints };
}

/**
 * Put a cut curve's pieces in place of the original and solve. Points that
 * were held on the original stay on whichever piece they're on (or are let go
 * if that stretch was cut away); other relations on it carry on to the piece
 * that still has the points they're about. Any that no longer make sense are
 * dropped rather than refusing the cut.
 */
function replaceWithPieces(before: SketchData, original: Wavy, pieces: SketchCurve[], points: SketchPoint[], what: string): EditResult {
  const unlinked = unlinkOffsets(before, new Set([original.id]));
  const draft: SketchData = { ...unlinked, points: [...unlinked.points, ...points], curves: unlinked.curves.flatMap((c) => (c.id === original.id ? pieces : [c])) };
  const paths = pieces.map((c) => ({ c, path: curveParam(draft, c) }));
  const pos = new Map<string, P2>(draft.points.map((p) => [p.id, [p.x, p.y]]));
  const onPiece = (pointId: string) => {
    const q = pos.get(pointId);
    if (!q) return undefined;
    let best: { id: string; d: number } | undefined;
    for (const { c, path } of paths) {
      const d = dist(path.at(nearestParam(path, q)), q);
      if (!best || d < best.d) best = { id: c.id, d };
    }
    return best && best.d < 1e-6 ? best.id : undefined;
  };
  // The points a relation is about: its own point refs, and the points of the other curves it names (a tangent's joint).
  const pointsOf = (refs: string[]) =>
    refs.flatMap((r) => {
      const c = draft.curves.find((k) => k.id === r && k.id !== original.id);
      return c ? curvePoints(c) : [r];
    });
  const pieceWithPoint = (refs: string[]) => {
    const pts = pointsOf(refs);
    return pieces.find((c) => c.id !== original.id && pts.some((r) => (c.type === "spline" ? c.points : c.type === "ellipse" ? [c.start, c.end] : []).includes(r)))?.id ?? pieces[0]?.id;
  };
  const constraints = draft.constraints.flatMap((k): SketchConstraint[] => {
    if (!k.refs.includes(original.id)) return [k];
    if (!pieces.length) return [];
    if (k.type === "pointOnCurve") {
      // A point that's now one of the pieces' own ends needs no holding.
      if (pieces.some((c) => curvePoints(c).includes(k.refs[0]))) return [];
      const on = onPiece(k.refs[0]);
      return on ? [{ ...k, refs: [k.refs[0], on] }] : [];
    }
    // Sizes and lengths of the whole curve no longer apply.
    if (k.type === "offset" || k.type === "equal") return [];
    const to = pieceWithPoint(k.refs);
    return [{ ...k, refs: k.refs.map((r) => (r === original.id ? to : r)) }];
  });
  let next = deleteItems({ ...draft, constraints }, []);
  const pieceIds = new Set(pieces.map((c) => c.id));
  for (let round = 0; round < 4; round++) {
    const r = solveSketch(next);
    if (r.ok) return { sketch: r.sketch };
    const failing = new Set(r.failing);
    const drop = next.constraints.filter((k) => failing.has(k.id) && k.refs.some((id) => pieceIds.has(id)));
    if (!drop.length) break;
    next = { ...next, constraints: next.constraints.filter((k) => !drop.includes(k)) };
  }
  return { sketch: before, error: `${what} would conflict with the sketch's other constraints or dimensions.` };
}

/** On failure, the sketch as it was before anything was added. */
const orBefore = (s: SketchData, r: EditResult): EditResult => (r.error ? { sketch: s, error: r.error } : r);

interface Cut {
  u: number;
  p: P2;
  by: string;
}

/** Where the other curves cross this one (by its parameter), nearest first along it. */
function cutsOn(s: SketchData, target: Wavy, path: CurveParam): Cut[] {
  const cuts: Cut[] = [];
  for (const other of s.curves) {
    if (other.id === target.id) continue;
    for (const x of crossings(path, curveParam(s, other))) cuts.push({ u: x.ua, p: x.p, by: other.id });
  }
  return cuts.sort((a, b) => a.u - b.u);
}

/** A new point at a cut, held on the curve that cuts there. */
function cutPoint(s: SketchData, cut: Cut): { point: SketchPoint; constraint: SketchConstraint | null; reused: boolean } {
  const other = s.curves.find((c) => c.id === cut.by)!;
  // Where the other curve ends right on this one (a T), cut at its end point: no new point needed.
  const end = curveEnds(other).find((id) => {
    const q = s.points.find((p) => p.id === id);
    return q && dist([q.x, q.y], cut.p) < 1e-6;
  });
  if (end) return { point: { id: end, x: cut.p[0], y: cut.p[1] }, constraint: null, reused: true };
  const id = sketchId("p");
  return { point: { id, x: cut.p[0], y: cut.p[1] }, constraint: con(onCurveType(other), [id, cut.by]), reused: false };
}

/**
 * Trim a spline, conic or ellipse: cut away the stretch between the nearest
 * crossings either side of the click (or all of it, if nothing crosses it).
 */
export function trimWavy(s: SketchData, target: Wavy, at: { x: number; y: number }): EditResult {
  const path = curveParam(s, target);
  const span = path.hi - path.lo;
  const eps = 1e-9 * Math.max(1, span);
  const click = nearestParam(path, [at.x, at.y]);
  const all = cutsOn(s, target, path);
  const newId = () => sketchId("p");
  if (path.closed) {
    // Distinct places round it.
    const cuts = all.filter((c, i) => i === 0 || c.u - all[i - 1].u > eps);
    if (cuts.length > 1 && Math.abs(cuts[0].u + span - cuts[cuts.length - 1].u) <= eps) cuts.pop();
    if (cuts.length < 2) return { sketch: deleteItems(s, [target.id]) };
    const after = cuts.find((c) => c.u > click) ?? cuts[0];
    const before = [...cuts].reverse().find((c) => c.u < click) ?? cuts[cuts.length - 1];
    // Keep from the crossing after the click round to the one before it.
    const a = cutPoint(s, after);
    const b = cutPoint(s, before);
    let u1 = before.u;
    while (u1 <= after.u + eps) u1 += span;
    const sk: SketchData = {
      ...s,
      points: [...s.points, ...[a, b].filter((k) => !k.reused).map((k) => k.point)],
      constraints: [...s.constraints, ...[a, b].flatMap((k) => (k.constraint ? [k.constraint] : []))],
    };
    const piece = pieceOf(sk, target, after.u, u1, a.point.id, b.point.id, target.id, newId);
    return orBefore(s, replaceWithPieces(sk, target, [piece.curve], piece.points, "Trimming there"));
  }
  const inside = all.filter((c) => c.u > path.lo + eps && c.u < path.hi - eps);
  if (!inside.length) return { sketch: deleteItems(s, [target.id]) };
  const before = [...inside].reverse().find((c) => c.u < click);
  const after = inside.find((c) => c.u > click);
  const [first, last] = endIds(target);
  const extraPoints: SketchPoint[] = [];
  const extraCons: SketchConstraint[] = [];
  const pieces: SketchCurve[] = [];
  const add = (c: Cut) => {
    const k = cutPoint(s, c);
    if (!k.reused) extraPoints.push(k.point);
    if (k.constraint) extraCons.push(k.constraint);
    return k.point.id;
  };
  const sk = (): SketchData => ({ ...s, points: [...s.points, ...extraPoints], constraints: [...s.constraints, ...extraCons] });
  if (before) {
    const id = add(before);
    const piece = pieceOf(sk(), target, path.lo, before.u, first, id, target.id, newId);
    pieces.push(piece.curve);
    extraPoints.push(...piece.points);
  }
  if (after) {
    const id = add(after);
    const piece = pieceOf(sk(), target, after.u, path.hi, id, last, before ? sketchId(target.type === "ellipse" ? "el" : "sp") : target.id, newId);
    pieces.push(piece.curve);
    extraPoints.push(...piece.points);
  }
  return orBefore(s, replaceWithPieces(sk(), target, pieces, [], "Trimming there"));
}

/** Split a spline, conic or part of an ellipse in two where it's clicked; both pieces follow the original exactly. */
export function splitWavy(s: SketchData, target: Wavy, at: { x: number; y: number }): EditResult & { lineIds: string[] } {
  const path = curveParam(s, target);
  if (path.closed)
    return {
      sketch: s,
      lineIds: [],
      error: `A closed ${target.type === "ellipse" ? "ellipse" : "spline"} has no ends to split between — use Trim to cut a piece out of it instead.`,
    };
  const span = path.hi - path.lo;
  let u = nearestParam(path, [at.x, at.y]);
  if (u - path.lo <= span * 0.02 || path.hi - u <= span * 0.02) return { sketch: s, lineIds: [], error: `Click further from the ${named(target)}'s ends to split it.` };
  // Right on one of a spline's own points: split there, at that point.
  let splitId: string | null = null;
  if (target.type === "spline" && target.conic === undefined && Math.abs(u - Math.round(u)) < 1e-6) {
    u = Math.round(u);
    splitId = target.points[u];
  }
  const points: SketchPoint[] = [];
  if (!splitId) {
    const p = path.at(u);
    splitId = sketchId("p");
    points.push({ id: splitId, x: p[0], y: p[1] });
  }
  const sk: SketchData = { ...s, points: [...s.points, ...points] };
  const [first, last] = endIds(target);
  const newId = () => sketchId("p");
  const secondId = sketchId(target.type === "ellipse" ? "el" : "sp");
  const a = pieceOf(sk, target, path.lo, u, first, splitId, target.id, newId);
  const b = pieceOf(sk, target, u, path.hi, splitId, last, secondId, newId);
  const r = orBefore(s, replaceWithPieces(sk, target, [a.curve, b.curve], [...a.points, ...b.points], "Splitting there"));
  return { ...r, lineIds: r.error ? [] : [target.id, secondId] };
}

/**
 * Offset a spline, conic or ellipse towards the side the pointer is on: a
 * spline that stays within OFFSET_TOLERANCE of the true offset, held that far
 * from the original by an offset dimension so it follows when the original
 * changes.
 */
export function offsetWavy(s: SketchData, target: Wavy, at: { x: number; y: number }, distanceText: string): EditResult & { curveIds: string[] } {
  const fail = (error: string) => ({ sketch: s, curveIds: [], error });
  const r = evaluate(distanceText);
  if (!r.ok) return fail(r.error);
  if (r.value <= 0) return fail("The offset distance must be more than 0.");
  const path = curveParam(s, target);
  const u = nearestParam(path, [at.x, at.y]);
  const q = path.at(u);
  const d = path.d1(u);
  // Which side: the curve's left (as it runs) or its right.
  const side = d[0] * (at.y - q[1]) - d[1] * (at.x - q[0]) >= 0 ? 1 : -1;
  const signed = side * r.value;
  if (tightestBend(path, side) * r.value >= 0.999)
    return fail(`That offset is more than the tightest bend of the ${named(target)} can take on that side — use a smaller distance, or offset the other way.`);
  const knots = target.type === "spline" && target.conic === undefined ? Array.from({ length: Math.round(path.hi - path.lo) + 1 }, (_, i) => path.lo + i) : undefined;
  const us = offsetParams(path, signed, OFFSET_TOLERANCE / 2, knots);
  const params = path.closed ? us.slice(0, -1) : us;
  const pieces = offsetPieces(path, signed, offsetSpan(path, params, path.closed));
  const ids = params.map(() => sketchId("p"));
  const at0 = pieces.map((b) => b[0]);
  if (!path.closed) at0.push(pieces[pieces.length - 1][3]);
  const points: SketchPoint[] = ids.map((id, i) => ({ id, x: at0[i][0], y: at0[i][1] }));
  const copyId = sketchId("sp");
  const copy: SketchSpline = { ...splineThrough(copyId, ids, pieces, path.closed, false), offsetParams: params };
  const keepApart: SketchConstraint = { ...con("offset", [copyId, target.id], distanceText, [side]), labelOffset: { x: 0, y: 0 } };
  const result = settle({ points: [...s.points, ...points], curves: [...s.curves, copy], constraints: [...s.constraints, keepApart] });
  return { ...result, curveIds: [copyId] };
}

// ---------------------------------------------------------------------------
// Extend

/** How far round (radians) a path may turn while it's carried on past its end, looking for something to reach. */
const EXTEND_TURN = Math.PI / 2;
/** The longest an extension may be, as a multiple of the sketch's size. */
const EXTEND_REACH = 10;

/** The sketch's size (its points' spread, at least 1 mm), to judge how far is too far. */
function sketchSize(s: SketchData): number {
  let lo = [0, 0], hi = [0, 0];
  for (const p of s.points) {
    lo = [Math.min(lo[0], p.x), Math.min(lo[1], p.y)];
    hi = [Math.max(hi[0], p.x), Math.max(hi[1], p.y)];
  }
  return Math.max(1, Math.hypot(hi[0] - lo[0], hi[1] - lo[1]));
}

/** The nearest crossing along a path ahead (past `minU`), with the other curves (and the curve's own other parts). */
function firstAhead(s: SketchData, ahead: CurveParam, skip: string | null, minU: number, ok: (c: { ua: number; p: P2; by: string }) => boolean = () => true) {
  let best: { ua: number; p: P2; by: string } | null = null;
  for (const other of s.curves) {
    if (other.id === skip) continue;
    for (const x of crossings(ahead, curveParam(s, other))) {
      const hit = { ua: x.ua, p: x.p, by: other.id };
      if (x.ua > minU && ok(hit) && (!best || x.ua < best.ua)) best = hit;
    }
  }
  return best;
}

/** Move an extended curve's end (and anything else listed) to its new place, hold it on what it reached, and solve. */
function finishExtend(s: SketchData, moves: Map<string, P2>, curves: SketchCurve[], curveId: string, endId: string, by: string, what: string): EditResult {
  const target = s.curves.find((c) => c.id === by)!;
  const points = s.points.map((p) => {
    const to = moves.get(p.id);
    return to ? { ...p, x: to[0], y: to[1] } : p;
  });
  // Reaching round to itself, the end needs no holding (it stays where the curve crosses itself).
  const constraints = by === curveId ? s.constraints : [...s.constraints, con(onCurveType(target), [endId, by])];
  const solved = solveSketch({ ...s, points, curves, constraints });
  // Refused when the constraints can't be met, or would only be met by pulling the end back (moving what it reached instead).
  const want = moves.get(endId)!;
  const got = solved.sketch.points.find((p) => p.id === endId);
  if (!solved.ok || !got || dist([got.x, got.y], want) > 1e-6)
    return { sketch: s, error: `That ${what}'s end is held where it is by its constraints, so it can't be extended. Remove what holds it (a fix or dimension on that end) first.` };
  return { sketch: solved.sketch };
}

/**
 * Extend a spline, conic or part of an ellipse from the end nearest the click
 * until it meets another curve (the nearest one ahead). A spline (or conic)
 * carries on naturally: its last piece continues just as it was curving, so
 * it stays smooth and keeps its shape up to the old end exactly. Part of an
 * ellipse carries on round its ellipse.
 */
export function extendWavy(s: SketchData, target: Wavy, at: { x: number; y: number }): EditResult {
  if (target.type === "ellipse") return extendEllipse(s, target, at);
  if (target.closed) return { sketch: s, error: "A closed spline has no ends to extend." };
  if (target.offsetParams)
    return { sketch: s, error: "That spline is an offset copy, so it follows its original: extend the original instead (the copy follows it)." };
  const kind = named(target);
  const [first, last] = endIds(target);
  const P = (id: string): P2 => {
    const q = s.points.find((p) => p.id === id);
    return q ? [q.x, q.y] : [0, 0];
  };
  const click: P2 = [at.x, at.y];
  const atEnd = dist(click, P(last)) <= dist(click, P(first));
  const endId = atEnd ? last : first;
  // The piece at that end, as a path by its own parameter t (0…1), to be carried on past t = 1 (or before t = 0).
  const conic = target.conic !== undefined && target.points.length === 3;
  const pieces = conic ? [] : splinePieces(s, target);
  const piece = atEnd ? pieces[pieces.length - 1] : pieces[0];
  const [a, apex, b] = conic ? target.points.map(P) : [];
  const f = conic
    ? (t: number) => conicAt(a, apex, b, target.conic!, t)
    : (t: number) => ({ p: bezierAt(piece, t), d1: bezierD1(piece, t), d2: bezierD2(piece, t) });
  // A conic's weights must stay positive where it's carried on (beyond that it would jump through infinity).
  const conicOk = (t: number) => {
    if (!conic) return true;
    const r = Math.min(0.99, Math.max(0.01, target.conic!));
    const w = r / (1 - r);
    return (1 - t) * (1 - t) + 2 * w * (1 - t) * t + t * t > 1e-6;
  };
  const e = atEnd ? 1 : 0;
  const sigma = atEnd ? 1 : -1;
  const d0 = f(e).d1;
  const speed0 = Math.hypot(d0[0], d0[1]);
  if (speed0 < 1e-12) return { sketch: s, error: `That ${kind} stops dead at its end, so there's no way to carry it on.` };
  // Walk out along the carried-on piece while it keeps heading roughly the same way, not too far.
  const reach = EXTEND_REACH * sketchSize(s);
  const step = 1 / 32;
  const vs = [0];
  let length = 0;
  let prev = f(e).p;
  for (let k = 1; k <= 32 * 64; k++) {
    const v = k * step;
    const t = e + sigma * v;
    if (!conicOk(t)) break;
    const here = f(t);
    const d = here.d1;
    const sp = Math.hypot(d[0], d[1]);
    if (sp < 1e-9 * speed0) break;
    const cos = (d[0] * d0[0] + d[1] * d0[1]) / (sp * speed0);
    if (cos < Math.cos(EXTEND_TURN)) break;
    length += dist(here.p, prev);
    prev = here.p;
    vs.push(v);
    if (length > reach) break;
  }
  if (vs.length < 2) return { sketch: s, error: `There's nothing ahead of that end for the ${kind} to reach.` };
  const ahead: CurveParam = {
    lo: 0,
    hi: vs[vs.length - 1],
    closed: false,
    at: (v) => f(e + sigma * v).p,
    d1: (v) => {
      const d = f(e + sigma * v).d1;
      return [sigma * d[0], sigma * d[1]];
    },
    d2: (v) => f(e + sigma * v).d2,
    samples: vs,
  };
  const endAt = P(endId);
  const hit = firstAhead(s, ahead, null, 1e-9, (c) => dist(c.p, endAt) > 1e-6);
  if (!hit) return { sketch: s, error: `There's nothing ahead of that end for the ${kind} to reach.` };
  const T = e + sigma * hit.ua;
  const moves = new Map<string, P2>([[endId, hit.p]]);
  let next: SketchCurve;
  if (conic) {
    const part = atEnd ? conicBetween(a, apex, b, target.conic!, 0, T) : conicBetween(a, apex, b, target.conic!, T, 1);
    moves.set(target.points[1], part.apex);
    next = { ...target, conic: part.rho };
  } else {
    const all = pieces.slice();
    if (atEnd) all[all.length - 1] = cubicOn(piece, 0, T);
    else all[0] = cubicOn(piece, T, 1);
    const { tangents: _t, tangentsIn: _ti, ...rest } = target;
    void _t;
    void _ti;
    next = { ...rest, ...splineThrough(target.id, target.points, all, false, target.construction) };
  }
  return finishExtend(s, moves, s.curves.map((c) => (c.id === target.id ? next : c)), target.id, endId, hit.by, kind);
}

/** Extend part of an ellipse round its ellipse, from the end nearest the click, to the next curve it meets. */
function extendEllipse(s: SketchData, target: SketchEllipse, at: { x: number; y: number }): EditResult {
  if (!target.start || !target.end) return { sketch: s, error: "A whole ellipse has no ends to extend." };
  const { t0, t1 } = ellipseSpan(s, target);
  const span = t1 - t0;
  const P = (id: string): P2 => {
    const q = s.points.find((p) => p.id === id);
    return q ? [q.x, q.y] : [0, 0];
  };
  const click: P2 = [at.x, at.y];
  const atEnd = dist(click, P(target.end)) <= dist(click, P(target.start));
  const endId = atEnd ? target.end : target.start;
  const { start: _s, end: _e, ...whole } = target;
  void _s;
  void _e;
  const round = curveParam(s, whole);
  const TAU = 2 * Math.PI;
  const wrap = (a: number) => ((a % TAU) + TAU) % TAU;
  // How far round past the end being extended: anticlockwise past its end, clockwise before its start.
  const ahead = (u: number) => (atEnd ? wrap(u - t1) : wrap(t0 - u));
  let best: { t: number; p: P2; by: string } | null = null;
  for (const other of s.curves) {
    if (other.id === target.id) continue;
    for (const x of crossings(round, curveParam(s, other))) {
      const t = ahead(x.ua);
      // Not the end itself, and not so far round it would meet its own other end.
      if (t > 1e-9 && t < TAU - span - 1e-9 && (!best || t < best.t)) best = { t, p: x.p, by: other.id };
    }
  }
  if (!best) return { sketch: s, error: "There's nothing further round that ellipse for it to reach." };
  return finishExtend(s, new Map([[endId, best.p]]), s.curves, target.id, endId, best.by, "part of an ellipse");
}
