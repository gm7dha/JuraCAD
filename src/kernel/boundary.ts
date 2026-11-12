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
 * bending the same way (curvature). Then the patch is worked out first as a
 * Coons patch whose blend across the matched pair is Hermite: it leaves each
 * matched edge along the face carried on past the edge (the cross-boundary
 * direction, as long as the patch is across there) — quintic, with the face's
 * own bend across the edge, for curvature (its slope 0.6 as long, or it swings
 * out past the face's line); cubic for tangent. Each curve across (exactly
 * that blend, a Bézier curve; with V curves given, a close fit through the
 * Coons patch) is lofted along the pair — the filling, given only the edges
 * and G1, folded back over the face instead — so the surface really goes on
 * from the face; along the pair it passes through the curves' sampled points.
 */
import { assembleWire, cast, getOC, makeBezierCurve, makeBSplineApproximation, makeLine, measureLength, type Edge, type Face, type Shape3D, type Wire } from "replicad";
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
/** Points across and along the worked-out patch. */
const GRID = 33;
const ALONG = 33;
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
  const oc = getOC() as any;
  // Walk the pair the same way round (uncrossed), and the sides from the first curve to the second.
  const w0 = walkOf(pair[0].wire, false);
  const a0 = w0.at(0), a1 = w0.at(1);
  const b0 = takeVec(pair[1].wire.startPoint), b1 = takeVec(pair[1].wire.endPoint);
  const w1 = walkOf(pair[1].wire, dist(a0, b0) + dist(a1, b1) > dist(a0, b1) + dist(a1, b0));
  const c0s = w1.at(0), c1s = w1.at(1);
  const sideWalk = (start: Vec3, end: Vec3): Walk | null => {
    for (const c of sides) {
      const s0 = takeVec(c.wire.startPoint), s1 = takeVec(c.wire.endPoint);
      if (dist(s0, start) < MEET && dist(s1, end) < MEET) return walkOf(c.wire, false);
      if (dist(s1, start) < MEET && dist(s0, end) < MEET) return walkOf(c.wire, true);
    }
    return null;
  };
  const d0 = sideWalk(a0, c0s);
  const d1 = sideWalk(a1, c1s);
  if (sides.length > (d0 ? 1 : 0) + (d1 ? 1 : 0)) throw new Error("The other curves must join the ends of the two opposite curves.");
  const ss = Array.from({ length: ALONG }, (_, i) => i / (ALONG - 1));
  const ts = Array.from({ length: GRID }, (_, i) => i / (GRID - 1));
  const p0 = ss.map((s) => w0.at(s));
  const p1 = ss.map((s) => w1.at(s));
  const span = ss.map((_, i) => dist(p0[i], p1[i]));
  const size = Math.max(...span, dist(a0, a1));
  const reach = Math.max(1e-3, 0.05 * size);
  const quintic = pair.some((c) => c.match === "curvature");
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
  if (!agrees(d0, 0, 0, m0) || !agrees(d1, ALONG - 1, 0, m0) || !agrees(d0, 0, 1, m1) || !agrees(d1, ALONG - 1, 1, m1))
    throw new Error("The V curves must leave a smooth edge the way its face carries on past it. Leave the V curves out (the sides then follow the surface), or set that edge to just go through.");
  // Coons: the Hermite blend across, plus the sides' difference from its own sides (none where no side is given).
  const grid: Vec3[][] = ss.map((s, i) =>
    ts.map((t) => {
      let q = lv(i, t);
      const side0 = d0 ? sub(d0.at(t), lv(0, t)) : null;
      const side1 = d1 ? sub(d1.at(t), lv(ALONG - 1, t)) : null;
      if (side0) q = add(q, mul(side0, 1 - s));
      if (side1) q = add(q, mul(side1, s));
      return q;
    }),
  );
  // The patch itself: one curve across at each place along the pair — exactly the Hermite blend as a Bézier curve
  // (cubic or quintic), or, with sides given, a close fit through the Coons patch's points — lofted along the pair.
  const rows: Wire[] = [];
  const builder = new oc.BRepOffsetAPI_ThruSections(false, false, 1e-6);
  try {
    ss.forEach((_, i) => {
      let edge: Edge;
      if (!d0 && !d1) {
        const { p, v0, a0, v1, a1, q } = ends(i);
        const poles = quintic
          ? [p, add(p, mul(v0, 0.2)), add(add(p, mul(v0, 0.4)), mul(a0, 0.05)), add(sub(q, mul(v1, 0.4)), mul(a1, 0.05)), sub(q, mul(v1, 0.2)), q]
          : [p, add(p, mul(v0, 1 / 3)), sub(q, mul(v1, 1 / 3)), q];
        edge = makeBezierCurve(poles);
      } else edge = makeBSplineApproximation(grid[i], { tolerance: 1e-5, degMax: 8, degMin: 3 });
      rows.push(assembleWire([edge]));
      edge.delete();
    });
    builder.CheckCompatibility(false);
    for (const w of rows) builder.AddWire(w.wrapped);
    builder.Build();
    if (!builder.IsDone()) throw new Error("no");
    return cast(builder.Shape()) as Shape3D;
  } catch {
    throw new Error("Couldn't fit a surface through those curves meeting the faces smoothly. Try just going through them, or check the curves make one outline.");
  } finally {
    builder.delete();
    rows.forEach((w) => w.delete());
  }
}
