/**
 * Boundary surface (Onshape's): a surface through boundary curves in two
 * directions — up to two each way, round one patch. Curves that don't close
 * the outline (two opposite curves, or two plus one) are joined end to end.
 *
 * With no side matched, OpenCascade's filling (BRepOffsetAPI_MakeFilling, as
 * Fill uses) spans the curves (straight lines closing the outline), the curves
 * as its edges, so it passes exactly through them.
 *
 * A part edge's side may carry on the face beside it smoothly (tangent) or
 * bending the same way (curvature). Then the patch is worked out as a Coons
 * patch whose blend across the matched pair is Hermite: it leaves each matched
 * edge along the face carried on past the edge (the cross-boundary direction,
 * as long as the patch is across there) — quintic, with the face's own bend
 * across the edge, for curvature (its slope 0.6 as long, or it swings out past
 * the face's line); cubic for tangent. That patch is made one B-spline surface
 * by tensor-product interpolation (across with the blend's exact end slopes,
 * then along through every place where either curve's pieces join), refined —
 * within a fixed budget — until every curve is within 1e-4 mm of the surface's
 * edge between the places taken. (OpenCascade's filling, given the edges and
 * G1, folded back over the face; with the patch as its starting surface it
 * crashes in this build on curved edges; lofting rows wiggled.)
 */
import { cast, getOC, makeLine, measureLength, type Edge, type Face, type Shape3D, type Wire } from "replicad";
import { chainEdges, endsOf, takeVec } from "./curves";
import { edgesOf, facesOf } from "./topology";
import { nearestOnFace } from "./faceBlend";

type Vec3 = [number, number, number];
/* eslint-disable @typescript-eslint/no-explicit-any */

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** One boundary curve: its wire (the caller frees it), and, for a part's edge, the face beside it to meet. */
export interface BoundaryInput {
  wire: Wire;
  face?: Face | null;
  match?: "tangent" | "curvature";
}

/** How close ends must be to count as meeting. */
const MEET = 1e-3;
/** Places across and along the worked-out patch to start with, the most it may take, and the rounds of doubling. */
const GRID = 17;
const ALONG = 33;
const MOST_ALONG = 1025;
const MOST_ACROSS = 129;
const ROUNDS = 7;
/** How closely a smooth-sided patch must keep to its curves (mm). */
const TOLERANCE = 1e-4;
/** How far a curvature-matched side's slope reaches, as a share of the way across. */
const CURVATURE_REACH = 0.6;

/**
 * The surface through the curves (u then v, up to two each way). Throws a plain message when they can't make one.
 * `u`/`v` are how many of `curves` go each way (the first `u` are U).
 */
export function boundarySurface(curves: BoundaryInput[], u: number, v: number): Shape3D {
  if (u > 2 || v > 2) throw new Error("Pick at most two curves each way (U and V): the two opposite sides of the patch.");
  if (u + v < 2) throw new Error("Pick at least two boundary curves: two opposite sides, or the curves all round the patch.");
  if (u === 1 && v === 1) throw new Error("With one curve each way the outline can't close. Pick the opposite side in either direction too.");
  for (const c of curves) if (c.match && !c.face) throw new Error("Tangent and curvature match the face beside a part's edge, so they're only for part edges.");
  if (curves.some((c) => c.match)) return matchedPatch(curves, u, v);
  const oc = getOC() as any;
  const pieces = edgePieces(curves);
  const made: Edge[] = [];
  try {
    // Join them up; close the outline with straight lines where curves don't meet.
    const runs = chainEdges(pieces.map((p) => p.edge.clone() as Edge), MEET);
    const ends = runs.map((w) => (w.isClosed ? null : endsOf(w)));
    runs.forEach((w) => w.delete());
    if (runs.length === 1 && !ends[0]) {
      // Closed already.
    } else if (runs.length === 1 && ends[0]) {
      made.push(makeLine(ends[0][1], ends[0][0]));
    } else if (runs.length === 2 && ends[0] && ends[1]) {
      const [a0, a1] = ends[0];
      const [b0, b1] = ends[1];
      // Join each end to the nearer of the other's, the way that doesn't cross over.
      if (dist(a0, b0) + dist(a1, b1) <= dist(a0, b1) + dist(a1, b0)) {
        made.push(makeLine(a0, b0), makeLine(a1, b1));
      } else made.push(makeLine(a0, b1), makeLine(a1, b0));
    } else {
      throw new Error("The curves don't make one outline: each must meet the next end to end (or pick two opposite sides only, which are joined by straight lines).");
    }
    const filling = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 1e-2, 0.1, 8, 9);
    try {
      for (const p of pieces) filling.Add(p.edge.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
      for (const e of made) filling.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
      const out = built(filling);
      if (!out) throw new Error("no");
      return out;
    } catch {
      throw new Error("Couldn't fit a surface through those curves. Check they make one outline (U curves opposite each other, V curves joining their ends).");
    } finally {
      filling.delete();
    }
  } finally {
    pieces.forEach((p) => p.edge.delete());
    made.forEach((e) => e.delete());
  }
}

/** Every curve's edges (with which curve each came from), the caller frees them. */
function edgePieces(curves: BoundaryInput[]): { edge: Edge; from: number }[] {
  const pieces: { edge: Edge; from: number }[] = [];
  curves.forEach((c, i) => {
    for (const e of edgesOf(c.wire)) {
      let l = 0;
      try {
        l = measureLength(e);
      } catch {
        l = 0;
      }
      if (l > 1e-6) pieces.push({ edge: e, from: i });
      else e.delete();
    }
  });
  if (!pieces.length) throw new Error("The curves have no length.");
  return pieces;
}

/** A filling built, as one shape with at least a face (null if not). */
function built(filling: any): Shape3D | null {
  filling.Build();
  if (!filling.IsDone()) return null;
  const out = cast(filling.Shape()) as Shape3D;
  const faces = facesOf(out);
  const any = faces.length > 0;
  faces.forEach((f) => f.delete());
  if (!any) {
    out.delete();
    return null;
  }
  return out;
}

/** A curve walked 0…1 (either way round). */
interface Walk {
  at: (s: number) => Vec3;
  /** Its direction there (as walked). */
  along: (s: number) => Vec3;
}

function walkOf(w: Wire, reversed: boolean): Walk {
  const f = (s: number) => (reversed ? 1 - s : s);
  return {
    at: (s) => takeVec(w.pointAt(f(s))),
    along: (s) => {
      const t = takeVec(w.tangentAt(f(s)));
      return reversed ? mul(t, -1) : t;
    },
  };
}

/**
 * Across a matched curve, at each place along it: the way on past it along the face carried on (a unit direction,
 * away from the face), and the face's bend that way (a second derivative per mm², along the face's normal).
 */
function acrossFace(walk: Walk, face: Face, ss: number[], reach: number): { out: Vec3[]; bend: Vec3[] } {
  const out: Vec3[] = [];
  const normals: Vec3[] = [];
  for (const s of ss) {
    const p = walk.at(s);
    let n: Vec3;
    try {
      n = unit(takeVec(face.normalAt(p)));
    } catch {
      throw new Error("Couldn't tell which way the face beside an edge goes.");
    }
    normals.push(n);
    out.push(unit(cross(walk.along(s), n)));
  }
  // Away from the face: a little way one side is on it, the other isn't. Decided in the middle, kept all along.
  const mid = Math.floor(ss.length / 2);
  const pm = walk.at(ss[mid]);
  const gap = (q: Vec3) => {
    const r = nearestOnFace(face, q);
    return r ? dist(r, q) : Infinity;
  };
  const eps = Math.min(0.05, reach * 0.05);
  const ahead = gap(add(pm, mul(out[mid], eps)));
  const behind = gap(sub(pm, mul(out[mid], eps)));
  if (ahead < behind) out[mid] = mul(out[mid], -1);
  for (let i = mid + 1; i < out.length; i++) if (dot(out[i], out[i - 1]) < 0) out[i] = mul(out[i], -1);
  for (let i = mid - 1; i >= 0; i--) if (dot(out[i], out[i + 1]) < 0) out[i] = mul(out[i], -1);
  // The bend: how far the face drops away from its tangent plane a little way back from the edge (a parabola y = κh²/2).
  const bend = ss.map((s, i) => {
    const p = walk.at(s);
    const h = reach;
    const back = nearestOnFace(face, sub(p, mul(out[i], h)));
    if (!back) return [0, 0, 0] as Vec3;
    const y = dot(sub(back, p), normals[i]);
    return mul(normals[i], (2 * y) / (h * h));
  });
  return { out, bend };
}

/** Hermite blends on 0…1: cubic (ends and slopes) or quintic (also second derivatives). */
function hermite(t: number, p0: Vec3, v0: Vec3, a0: Vec3, p1: Vec3, v1: Vec3, a1: Vec3, quintic: boolean): Vec3 {
  if (!quintic) {
    const t2 = t * t, t3 = t2 * t;
    return add(add(mul(p0, 2 * t3 - 3 * t2 + 1), mul(v0, t3 - 2 * t2 + t)), add(mul(p1, -2 * t3 + 3 * t2), mul(v1, t3 - t2)));
  }
  const t2 = t * t, t3 = t2 * t, t4 = t3 * t, t5 = t4 * t;
  const h0 = 1 - 10 * t3 + 15 * t4 - 6 * t5;
  const h1 = t - 6 * t3 + 8 * t4 - 3 * t5;
  const h2 = 0.5 * t2 - 1.5 * t3 + 1.5 * t4 - 0.5 * t5;
  const h3 = 0.5 * t3 - t4 + 0.5 * t5;
  const h4 = -4 * t3 + 7 * t4 - 3 * t5;
  const h5 = 10 * t3 - 15 * t4 + 6 * t5;
  return add(add(add(mul(p0, h0), mul(v0, h1)), add(mul(a0, h2), mul(a1, h3))), add(mul(v1, h4), mul(p1, h5)));
}

/**
 * A patch with matched sides: a Coons patch, Hermite across the matched pair (see the top), made a B-spline surface
 * through its grid of points.
 */
function matchedPatch(curves: BoundaryInput[], u: number, _v: number): Shape3D {
  const U = curves.slice(0, u);
  const V = curves.slice(u);
  const matchedU = U.some((c) => c.match);
  const matchedV = V.some((c) => c.match);
  if (matchedU && matchedV) throw new Error("Smooth sides can only be on one pair of opposite curves (the two U curves, or the two V curves).");
  // The matched pair runs across the patch (c0 → c1); the others are its sides.
  const [pair, sides] = matchedU ? [U, V] : [V, U];
  if (pair.length !== 2) throw new Error("A smooth side needs the curve opposite it too: pick two curves that way (U or V), the matched one among them.");
  for (const c of pair) {
    if (!c.match) continue;
    const es = edgesOf(c.wire);
    const one = es.length === 1;
    es.forEach((e) => e.delete());
    if (!one) throw new Error("A smooth side must be one edge of a part.");
  }
  // Walk the pair the same way round (uncrossed), and the sides from the first curve to the second.
  const w0 = walkOf(pair[0].wire, false);
  const a0 = w0.at(0), a1 = w0.at(1);
  const b0 = takeVec(pair[1].wire.startPoint), b1 = takeVec(pair[1].wire.endPoint);
  const flipped1 = dist(a0, b0) + dist(a1, b1) > dist(a0, b1) + dist(a1, b0);
  const w1 = walkOf(pair[1].wire, flipped1);
  const c0s = w1.at(0), c1s = w1.at(1);
  const sideOf = (start: Vec3, end: Vec3): { walk: Walk; wire: Wire; reversed: boolean } | null => {
    for (const c of sides) {
      const s0 = takeVec(c.wire.startPoint), s1 = takeVec(c.wire.endPoint);
      if (dist(s0, start) < MEET && dist(s1, end) < MEET) return { walk: walkOf(c.wire, false), wire: c.wire, reversed: false };
      if (dist(s1, start) < MEET && dist(s0, end) < MEET) return { walk: walkOf(c.wire, true), wire: c.wire, reversed: true };
    }
    return null;
  };
  const side0 = sideOf(a0, c0s);
  const side1 = sideOf(a1, c1s);
  const d0 = side0?.walk ?? null;
  const d1 = side1?.walk ?? null;
  if (sides.length > (d0 ? 1 : 0) + (d1 ? 1 : 0)) throw new Error("The other curves must join the ends of the two opposite curves.");
  for (const c of curves) if (hasCorner(c.wire)) throw new Error("A curve with a sharp corner can't be one side of a smooth boundary surface (the surface would have to fold there). Use curves without corners, or set the edge to just go through.");
  const quintic = pair.some((c) => c.match === "curvature");
  const joins = [...new Set([...breaks(pair[0].wire, false), ...breaks(pair[1].wire, flipped1)].map((x) => Math.round(x * 1e9) / 1e9))].sort((a, b) => a - b);
  // The patch is one B-spline surface made from points of the worked-out (Hermite / Coons) patch: interpolated across
  // at each place along (exact end slopes where nothing else is given, so it leaves a smooth edge as the blend does),
  // then those curves' poles interpolated along. Its edges are interpolations of the curves' own points, so more
  // places along (and across, for V curves) are taken — twice as many each time, within a fixed budget — until every
  // curve is within TOLERANCE of the surface's edge, measured between the places taken (never at them).
  let along = ALONG;
  let acrossN = GRID;
  let last = Infinity;
  for (let round = 0; round < ROUNDS; round++) {
    const built = patchWith(along, acrossN);
    if (built.gapAlong <= TOLERANCE && built.gapAcross <= TOLERANCE) return built.face();
    last = Math.max(built.gapAlong, built.gapAcross);
    // Gaps shrink about as the fourth power of the spacing: go straight to about enough (at least twice as many).
    const grow = (n: number, gap: number) => {
      const want = (n - 1) * Math.max(2, 1.6 * Math.pow(gap / TOLERANCE, 0.25));
      let m = n;
      while (m - 1 < want) m = 2 * m - 1;
      return m;
    };
    if (built.gapAlong > TOLERANCE) along = grow(along, built.gapAlong);
    if (built.gapAcross > TOLERANCE) acrossN = grow(acrossN, built.gapAcross);
    if (along > MOST_ALONG || acrossN > MOST_ACROSS) break;
  }
  throw new Error(`Couldn't keep the surface on its curves closely enough (it strays ${last.toFixed(4)} mm). Try simpler curves, or set the edge to just go through.`);

  function patchWith(target: number, acrossN: number): { gapAlong: number; gapAcross: number; face: () => Shape3D } {
    // Along: the places where either curve's pieces join (so each stretch between is smooth), each stretch split evenly.
    const ss = spread(joins, target);
    const along = ss.length;
    // Across: closer together near the two curves (cosine spacing), where the bend is matched.
    const ts = Array.from({ length: acrossN }, (_, j) => (1 - Math.cos((Math.PI * j) / (acrossN - 1))) / 2);
    const p0 = ss.map((s) => w0.at(s));
    const p1 = ss.map((s) => w1.at(s));
    const span = ss.map((_, i) => dist(p0[i], p1[i]));
    const size = Math.max(...span, dist(a0, a1));
    const reach = Math.max(1e-3, 0.05 * size);
    // Cross-boundary slopes (the patch's way across, as long as it is across) and bends at each end of the pair.
    const across = (c: BoundaryInput, walk: Walk, sign: number) => {
      if (!c.match || !c.face) return null;
      const { out, bend } = acrossFace(walk, c.face, ss, reach);
      return {
        // As long as the patch is across there (a curvature match a little less, or it swings out past the face's line).
        v: out.map((d, i) => mul(d, sign * span[i] * (c.match === "curvature" ? CURVATURE_REACH : 1))),
        // Bending as the face does: the second derivative across, along its normal, κ × the slope squared.
        a: c.match === "curvature" ? bend.map((b, i) => mul(b, (span[i] * CURVATURE_REACH) ** 2)) : null,
      };
    };
    const m0 = across(pair[0], w0, 1);
    const m1 = across(pair[1], w1, -1);
    const ends = (i: number) => {
      const straight = sub(p1[i], p0[i]);
      const v0 = m0?.v[i] ?? straight;
      const v1 = m1?.v[i] ?? straight;
      // An end without a curvature to match bends as the plain (cubic) blend would there.
      const a0 = m0?.a?.[i] ?? add(add(mul(p0[i], -6), mul(v0, -4)), add(mul(p1[i], 6), mul(v1, -2)));
      const a1 = m1?.a?.[i] ?? add(add(mul(p0[i], 6), mul(v0, 2)), add(mul(p1[i], -6), mul(v1, 4)));
      return { p: p0[i], v0, a0, v1, a1, q: p1[i] };
    };
    const lv = (i: number, t: number): Vec3 => {
      const e = ends(i);
      return hermite(t, e.p, e.v0, e.a0, e.q, e.v1, e.a1, quintic);
    };
    // V curves given must leave a smooth edge the way the face carries on, or the patch can't do both.
    const agrees = (side: Walk | null, i: number, at: 0 | 1, m: typeof m0) => {
      if (!side || !m) return true;
      const t = side.along(at);
      const want = at === 0 ? m.v[i] : mul(m.v[i], -1);
      return dot(unit(t), unit(want)) * (at === 0 ? 1 : -1) > Math.cos((10 * Math.PI) / 180);
    };
    if (!agrees(d0, 0, 0, m0) || !agrees(d1, along - 1, 0, m0) || !agrees(d0, 0, 1, m1) || !agrees(d1, along - 1, 1, m1))
      throw new Error("The V curves must leave a smooth edge the way its face carries on past it. Leave the V curves out (the sides then follow the surface), or set that edge to just go through.");
    // Coons: the Hermite blend across, plus the sides' difference from its own sides (none where no side is given).
    const coons = (s: number, i: number, t: number): Vec3 => {
      let q = lv(i, t);
      if (d0) q = add(q, mul(sub(d0.at(t), lv(0, t)), 1 - s));
      if (d1) q = add(q, mul(sub(d1.at(t), lv(along - 1, t)), s));
      return q;
    };
    // Across at each place along: interpolated (with the blend's end slopes when there are no V curves to add in).
    const rows = ss.map((s, i) => {
      const e = ends(i);
      return interpolate(ts.map((t) => coons(s, i, t)), ts, d0 || d1 ? undefined : [e.v0, e.v1]);
    });
    // Along: each pole of those curves interpolated (the same knots everywhere, so they make one surface).
    const poleCount = rows[0].poles.length;
    const cols = Array.from({ length: poleCount }, (_, k) => interpolate(rows.map((r) => r.poles[k]), ss));
    const surface = { u: cols[0], v: rows[0], poles: cols.map((c) => c.poles) };
    const at = (s: number, t: number) => bsplineSurfaceAt(surface, s, t);
    // How far the curves stray from the surface's edges, between the places taken.
    let gapAlong = 0;
    for (let i = 0; i + 1 < along; i++)
      for (const f of [0.25, 0.5, 0.75]) {
        const s = ss[i] + (ss[i + 1] - ss[i]) * f;
        gapAlong = Math.max(gapAlong, dist(at(s, 0), w0.at(s)), dist(at(s, 1), w1.at(s)));
      }
    let gapAcross = 0;
    for (let j = 0; j + 1 < acrossN; j++)
      for (const f of [0.25, 0.5, 0.75]) {
        const t = ts[j] + (ts[j + 1] - ts[j]) * f;
        if (d0) gapAcross = Math.max(gapAcross, dist(at(0, t), d0.at(t)));
        if (d1) gapAcross = Math.max(gapAcross, dist(at(1, t), d1.at(t)));
      }
    return { gapAlong, gapAcross, face: () => makeBSplineFace(surface) };
  }
}

/** Where a curve's pieces join (its 3rd derivative may jump), as shares 0…1 of the way along as walked; with 0 and 1. */
function breaks(w: Wire, reversed: boolean): number[] {
  const oc = getOC() as any;
  const curve = new oc.BRepAdaptor_CompCurve(w.wrapped, false);
  try {
    const C3 = oc.GeomAbs_Shape.GeomAbs_C3;
    const n = curve.NbIntervals(C3);
    const knots = new oc.NCollection_Array1_double(1, n + 1);
    curve.Intervals(knots, C3);
    const a = curve.FirstParameter();
    const b = curve.LastParameter();
    const out: number[] = [];
    for (let i = 1; i <= n + 1; i++) {
      const x = (knots.Value(i) - a) / (b - a);
      out.push(reversed ? 1 - x : x);
    }
    knots.delete();
    return [0, 1, ...out].filter((x) => x >= 0 && x <= 1);
  } finally {
    curve.delete();
  }
}

/** About `target` places from 0 to 1 including every join, each stretch between joins split evenly. */
function spread(joins: number[], target: number): number[] {
  const out: number[] = [0];
  for (let i = 0; i + 1 < joins.length; i++) {
    const [a, b] = [joins[i], joins[i + 1]];
    if (b - a < 1e-9) continue;
    const k = Math.max(1, Math.ceil((b - a) * (target - 1) - 1e-9));
    for (let j = 1; j <= k; j++) out.push(a + ((b - a) * j) / k);
  }
  return out;
}

/** A B-spline curve's poles, knots (with multiplicities) and degree. */
interface Spline {
  poles: Vec3[];
  knots: number[];
  mults: number[];
  degree: number;
}

/** OpenCascade's cubic interpolation through points at the given parameters (with end slopes if given). */
function interpolate(points: Vec3[], params: number[], slopes?: [Vec3, Vec3]): Spline {
  const oc = getOC() as any;
  const made: any[] = [];
  try {
    const flat = new oc.NCollection_Array1_gp_Pnt(1, points.length);
    const pars = new oc.NCollection_Array1_double(1, params.length);
    made.push(flat, pars);
    points.forEach((p, i) => {
      const q = new oc.gp_Pnt(p[0], p[1], p[2]);
      made.push(q);
      flat.SetValue(i + 1, q);
      pars.SetValue(i + 1, params[i]);
    });
    // (Held by OpenCascade's handles once given to the fit, so they aren't freed here.)
    const fit = new oc.GeomAPI_Interpolate(new oc.NCollection_HArray1_gp_Pnt(flat), new oc.NCollection_HArray1_double(pars), false, 1e-9);
    made.push(fit);
    if (slopes) {
      const a = new oc.gp_Vec(...slopes[0]);
      const b = new oc.gp_Vec(...slopes[1]);
      made.push(a, b);
      fit.Load(a, b, false);
    }
    fit.Perform();
    if (!fit.IsDone()) throw new Error("Couldn't fit the surface through its curves.");
    const c = fit.Curve();
    const poles: Vec3[] = [];
    for (let i = 1; i <= c.NbPoles(); i++) {
      const p = c.Pole(i);
      poles.push([p.X(), p.Y(), p.Z()]);
      p.delete();
    }
    const knots: number[] = [];
    const mults: number[] = [];
    for (let i = 1; i <= c.NbKnots(); i++) {
      knots.push(c.Knot(i));
      mults.push(c.Multiplicity(i));
    }
    return { poles, knots, mults, degree: c.Degree() };
  } finally {
    made.reverse().forEach((m) => m.delete());
  }
}

/** A spline's full knot sequence (each knot repeated by its multiplicity), kept with it. */
const sequences = new WeakMap<Spline, number[]>();
function knotSequence(spline: Spline): number[] {
  let seq = sequences.get(spline);
  if (!seq) {
    seq = [];
    for (let i = 0; i < spline.knots.length; i++) for (let m = 0; m < spline.mults[i]; m++) seq.push(spline.knots[i]);
    sequences.set(spline, seq);
  }
  return seq;
}

/** The B-spline basis functions not zero at x: the first pole's index and their values (The NURBS Book, A2.2). */
function basisAt(spline: Spline, x: number): { first: number; values: number[] } {
  const U = knotSequence(spline);
  const p = spline.degree;
  const n = U.length - p - 2; // last pole's index
  const u = Math.min(Math.max(x, U[p]), U[n + 1]);
  // The knot span holding u (binary search).
  let span: number;
  if (u >= U[n + 1]) span = n;
  else {
    let lo = p;
    let hi = n + 1;
    span = (lo + hi) >> 1;
    while (u < U[span] || u >= U[span + 1]) {
      if (u < U[span]) hi = span;
      else lo = span;
      span = (lo + hi) >> 1;
    }
  }
  const N = [1];
  const left = [0];
  const right = [0];
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[span + 1 - j];
    right[j] = U[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const temp = N[r] / (right[r + 1] + left[j - r]);
      N[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    N[j] = saved;
  }
  return { first: span - p, values: N };
}

/** A point of the tensor-product surface (u along: the columns' basis; v across: the rows'). */
function bsplineSurfaceAt(sf: { u: Spline; v: Spline; poles: Vec3[][] }, s: number, t: number): Vec3 {
  const bu = basisAt(sf.u, s);
  const bv = basisAt(sf.v, t);
  const out: Vec3 = [0, 0, 0];
  bu.values.forEach((wu, l) => {
    bv.values.forEach((wv, k) => {
      const p = sf.poles[bv.first + k][bu.first + l];
      out[0] += wu * wv * p[0];
      out[1] += wu * wv * p[1];
      out[2] += wu * wv * p[2];
    });
  });
  return out;
}

/** The surface as a face (OpenCascade's B-spline surface: poles u × v, its knots). */
function makeBSplineFace(sf: { u: Spline; v: Spline; poles: Vec3[][] }): Shape3D {
  const oc = getOC() as any;
  const made: any[] = [];
  const array = (xs: number[], ctor: string) => {
    const a = new oc[ctor](1, xs.length);
    xs.forEach((x, i) => a.SetValue(i + 1, x));
    made.push(a);
    return a;
  };
  try {
    const nu = sf.u.poles.length;
    const nv = sf.v.poles.length;
    const poles = new oc.NCollection_Array2_gp_Pnt(1, nu, 1, nv);
    made.push(poles);
    for (let l = 0; l < nu; l++)
      for (let k = 0; k < nv; k++) {
        const p = sf.poles[k][l];
        const q = new oc.gp_Pnt(p[0], p[1], p[2]);
        made.push(q);
        poles.SetValue(l + 1, k + 1, q);
      }
    const surface = new oc.Geom_BSplineSurface(poles, array(sf.u.knots, "NCollection_Array1_double"), array(sf.v.knots, "NCollection_Array1_double"), array(sf.u.mults, "NCollection_Array1_int"), array(sf.v.mults, "NCollection_Array1_int"), sf.u.degree, sf.v.degree, false, false);
    const face = new oc.BRepBuilderAPI_MakeFace(surface, 1e-6);
    made.push(face);
    if (!face.IsDone()) throw new Error("Couldn't make the surface.");
    return cast(face.Face()) as Shape3D;
  } finally {
    made.reverse().forEach((m) => m.delete());
  }
}

/** Does a curve turn sharply where two of its edges meet (more than 1°)? */
function hasCorner(w: Wire): boolean {
  const es = edgesOf(w);
  try {
    if (es.length < 2) return false;
    const endsOfEdge = es.map((e) => ({
      a: takeVec(e.startPoint),
      b: takeVec(e.endPoint),
      ta: unit(takeVec(e.tangentAt(0))),
      tb: unit(takeVec(e.tangentAt(1))),
    }));
    for (let i = 0; i < es.length; i++)
      for (let j = 0; j < es.length; j++) {
        if (i === j) continue;
        const p = endsOfEdge[i], q = endsOfEdge[j];
        // p's end meeting q's start (or end): their directions there must agree.
        for (const [pt, pd] of [[p.b, p.tb], [p.a, mul(p.ta, -1)]] as [Vec3, Vec3][])
          for (const [qt, qd] of [[q.a, q.ta], [q.b, mul(q.tb, -1)]] as [Vec3, Vec3][])
            if (dist(pt, qt) < MEET && dot(pd, qd) < Math.cos(Math.PI / 180)) return true;
      }
    return false;
  } finally {
    es.forEach((e) => e.delete());
  }
}
