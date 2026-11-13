/**
 * More curve features' geometry (see model/curves.ts): Offset curve (edges moved a set distance across a face),
 * Isocline (where a face slopes at a set angle to a direction) and Trim curve (a curve cut back to where it first
 * meets a face, a plane or another curve). The contouring itself is pure, in geometry/isoContour.ts.
 */
import { assembleWire, cast, getOC, type Edge, type Face, type Shape3D, type Wire } from "replicad";
import { contourRuns, insidePieces, joinRuns, thinRun, type P2 } from "../geometry/isoContour";
import { chainEdges, interpolatedEdge, takeVec } from "./curves";
import { nearestOnFace } from "./faceBlend";
import { edgesOf } from "./topology";

type Vec3 = [number, number, number];
/* eslint-disable @typescript-eslint/no-explicit-any */

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => scale(a, 1 / (len(a) || 1));
const dist = (a: Vec3, b: Vec3) => len(sub(a, b));

/** A face's surface for walking on: the nearest point on it (untrimmed) and the face's outward normal there. */
function surfaceOf(face: Face): { at: (q: Vec3) => { p: Vec3; n: Vec3 } | null; free: () => void } {
  const oc = getOC() as any;
  const surface = oc.BRep_Tool.Surface(face.wrapped);
  const props = new oc.BRepGProp_Face(face.wrapped, false);
  const at = (q: Vec3) => {
    const pnt = new oc.gp_Pnt(q[0], q[1], q[2]);
    const proj = new oc.GeomAPI_ProjectPointOnSurf(pnt, surface, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad);
    const on = new oc.gp_Pnt();
    const nv = new oc.gp_Vec();
    try {
      if (proj.NbPoints() < 1) return null;
      const { U, V } = proj.LowerDistanceParameters(0, 0);
      props.Normal(U, V, on, nv);
      if (nv.Magnitude() < 1e-12) return null;
      return { p: [on.X(), on.Y(), on.Z()] as Vec3, n: unit([nv.X(), nv.Y(), nv.Z()]) };
    } finally {
      nv.delete();
      on.delete();
      proj.delete();
      pnt.delete();
    }
  };
  return { at, free: () => props.delete() };
}

/** Whether a point lies on the face itself (not just on its surface beyond the face's edges). */
function onFace(face: Face, p: Vec3, tol = 1e-4): boolean {
  const q = nearestOnFace(face, p);
  return !!q && dist(p, q) <= tol;
}

/** The shape of an offset made by OpenCascade's planar offset (BRepOffsetAPI_MakeOffset), as wires; null if it fails. */
function planarOffset(spine: Face | Wire, by: number, open: boolean): Wire[] | null {
  const oc = getOC() as any;
  let op: any;
  try {
    op = new oc.BRepOffsetAPI_MakeOffset(spine.wrapped, oc.GeomAbs_JoinType.GeomAbs_Arc, open);
    op.Perform(by, 0);
    if (!op.IsDone()) return null;
    const shape = cast(op.Shape()) as unknown as Shape3D;
    try {
      const wires = chainEdges(edgesOf(shape));
      return wires.length ? wires : null;
    } finally {
      shape.delete();
    }
  } catch {
    return null;
  } finally {
    op?.delete();
  }
}

/** Is the first edge's middle of these wires on the face? */
function wiresOnFace(face: Face, wires: Wire[]): boolean {
  const mid = takeVec(wires[0].pointAt(0.5));
  return onFace(face, mid);
}

/**
 * A closed wire lying on a flat face moved `d` across it, exactly (lines stay lines, arcs arcs): into the face, or
 * `out` of it. Null when OpenCascade can't (the caller then walks it across).
 */
function planarLoopOffset(face: Face, spine: Face | Wire, d: number, out: boolean): Wire[] | null {
  for (const by of [-d, d]) {
    const w = planarOffset(spine, by, false);
    if (!w) continue;
    if (wiresOnFace(face, w) !== out) return w;
    w.forEach((x) => x.delete());
  }
  return null;
}

/**
 * A wire on a face walked `d` across the face, square to the wire, point by point along the surface (so on a round
 * face it follows the face round), then a spline fitted through the points.
 */
function walkedOffset(face: Face, wire: Wire, d: number, out: boolean): Wire {
  const surf = surfaceOf(face);
  try {
    const closed = wire.isClosed;
    const length = (() => {
      let s = 0;
      let prev = takeVec(wire.pointAt(0));
      for (let i = 1; i <= 64; i++) {
        const q = takeVec(wire.pointAt(i / 64));
        s += dist(prev, q);
        prev = q;
      }
      return s;
    })();
    const N = Math.max(24, Math.min(200, Math.ceil(length / 1.5)));
    const count = closed ? N : N + 1;
    const starts: { p: Vec3; t: Vec3 }[] = [];
    for (let i = 0; i < count; i++) starts.push({ p: takeVec(wire.pointAt(i / N)), t: unit(takeVec(wire.tangentAt(i / N))) });
    // Which way is into the face: tried from the middle, a little way across.
    const mid = starts[Math.floor(starts.length / 2)];
    const here = surf.at(mid.p);
    if (!here) throw new Error("Couldn't find the face under the edges. Pick the face they lie on.");
    const across0 = unit(cross(here.n, mid.t));
    const tryStep = Math.min(d, 0.05);
    const probe = surf.at(add(mid.p, scale(across0, tryStep)));
    const into = !!probe && onFace(face, probe.p, 1e-5);
    const sign = (into ? 1 : -1) * (out ? -1 : 1);
    const steps = Math.max(4, Math.ceil(d / 0.5));
    const h = d / steps;
    const pts: Vec3[] = [];
    for (const s of starts) {
      let at = surf.at(s.p);
      if (!at) throw new Error("Couldn't walk across the face from one of the edges.");
      let dir = scale(unit(cross(at.n, s.t)), sign);
      let p = at.p;
      for (let k = 0; k < steps; k++) {
        const next = surf.at(add(p, scale(dir, h)));
        if (!next) throw new Error("The offset runs off the face's surface. Use a smaller distance.");
        const moved = sub(next.p, p);
        p = next.p;
        // Carry the direction on along the surface.
        const along = len(moved) > 1e-12 ? unit(moved) : dir;
        dir = unit(sub(along, scale(next.n, dot(along, next.n))));
        at = next;
      }
      pts.push(p);
    }
    for (let i = 1; i < pts.length; i++) if (dist(pts[i], pts[i - 1]) < 1e-7) throw new Error("The offset folds over itself here. Use a smaller distance.");
    return chainEdges([interpolatedEdge(pts, closed)])[0];
  } finally {
    surf.free();
  }
}

/**
 * Offset curve: `edges` (or, with none, every edge round the face) moved `d` across `face` — into it, or `out` of it.
 * Flat faces' closed loops are exact; everything else is walked across the surface.
 */
export function offsetOnFace(face: Face, edges: Edge[], d: number, out: boolean): Wire[] {
  if (!(d > 1e-9)) throw new Error("The distance must be more than 0.");
  const flat = face.geomType === "PLANE";
  if (!edges.length && flat) {
    const exact = planarLoopOffset(face, face, d, out);
    if (exact) return exact;
  }
  // The edges (or the face's own, less a round face's seam, which runs along its side) joined into runs.
  let list = edges;
  if (!list.length) {
    const oc = getOC() as any;
    list = edgesOf(face).filter((e) => {
      const seam = oc.BRep_Tool.IsClosed(e.wrapped, face.wrapped);
      if (seam) e.delete();
      return !seam;
    });
    const seen: Edge[] = [];
    list = list.filter((e) => {
      if (seen.some((x) => x.isSame(e))) {
        e.delete();
        return false;
      }
      seen.push(e);
      return true;
    });
  }
  const wires = chainEdges(list);
  const outWires: Wire[] = [];
  try {
    for (const w of wires) {
      const exact = flat && w.isClosed ? planarLoopOffset(face, w, d, out) : null;
      if (exact) outWires.push(...exact);
      else outWires.push(walkedOffset(face, w, d, out));
    }
  } catch (e) {
    outWires.forEach((w) => w.delete());
    throw e;
  } finally {
    wires.forEach((w) => w.delete());
  }
  return outWires;
}

/** A face's outline in its own (u, v) parameters, as short straight pieces (for telling what's on the face). */
function uvPieces(face: Face): [P2, P2][] {
  const oc = getOC() as any;
  const out: [P2, P2][] = [];
  for (const e of edgesOf(face)) {
    let c: any;
    try {
      c = new oc.BRepAdaptor_Curve2d(e.wrapped, face.wrapped);
      const t0 = c.FirstParameter();
      const t1 = c.LastParameter();
      const n = 24;
      let prev: P2 | null = null;
      for (let k = 0; k <= n; k++) {
        const q = c.Value(t0 + ((t1 - t0) * k) / n);
        const p: P2 = [q.X(), q.Y()];
        q.delete();
        if (prev) out.push([prev, p]);
        prev = p;
      }
    } catch {
      // an edge with no curve on the face (shouldn't happen)
    } finally {
      c?.delete();
      e.delete();
    }
  }
  return out;
}

/**
 * Isocline: the lines on a face where its outward normal makes the slope given with a direction — n·dir = `sine`
 * (sine = sin of the angle: 0 = where the face is upright to the direction, its outline seen along it). Sampled on
 * the face's (u, v) grid, contoured, each crossing found exactly, and splines fitted through the lines.
 */
export function isoclineWires(face: Face, dir: Vec3, sine: number, gridSize = 96): Wire[] {
  const oc = getOC() as any;
  const d = unit(dir);
  const props = new oc.BRepGProp_Face(face.wrapped, false);
  const pnt = new oc.gp_Pnt();
  const vec = new oc.gp_Vec();
  try {
    const { uMin, uMax, vMin, vMax } = face.UVBounds;
    const eps = 1e-7;
    const pieces = uvPieces(face);
    const nu = gridSize + 1;
    const nv = gridSize + 1;
    const U = (i: number) => uMin + (uMax - uMin) * (eps + ((1 - 2 * eps) * i) / gridSize);
    const V = (j: number) => vMin + (vMax - vMin) * (eps + ((1 - 2 * eps) * j) / gridSize);
    const f = (u: number, v: number) => {
      props.Normal(u, v, pnt, vec);
      const m = vec.Magnitude();
      if (m < 1e-12) return NaN;
      return (vec.X() * d[0] + vec.Y() * d[1] + vec.Z() * d[2]) / m - sine;
    };
    const values = new Float64Array(nu * nv);
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const u = U(i);
        const v = V(j);
        values[i + j * nu] = insidePieces([u, v], pieces) ? f(u, v) : NaN;
      }
    }
    const refine = (a: P2, b: P2, fa: number, fb: number): P2 => {
      let lo = 0;
      let hi = 1;
      let flo = fa;
      for (let k = 0; k < 40; k++) {
        const m = (lo + hi) / 2;
        const fm = f(a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m);
        if (!Number.isFinite(fm)) break;
        if (fm > 0 === flo > 0) {
          lo = m;
          flo = fm;
        } else hi = m;
      }
      void fb;
      const t = (lo + hi) / 2;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    };
    const runs = contourRuns({ nu, nv, u: U, v: V, values }, refine);
    const point = (q: P2): Vec3 => {
      props.Normal(q[0], q[1], pnt, vec);
      return [pnt.X(), pnt.Y(), pnt.Z()];
    };
    const in3d = runs.map((r) => ({ points: r.points.map(point), closed: r.closed }));
    const joined = joinRuns(in3d, 1e-3);
    const out: Wire[] = [];
    for (const r of joined) {
      const pts = thinRun(r.points, 0.02, 400);
      if (pts.length < 2) continue;
      if (r.closed && pts.length < 3) continue;
      try {
        out.push(...chainEdges([interpolatedEdge(pts, r.closed)]));
      } catch {
        // too short to fit
      }
    }
    return out;
  } finally {
    vec.delete();
    pnt.delete();
    props.delete();
  }
}

/** How far a point is from a shape (a face, a plane's sheet, a curve). */
function gapTo(shape: { wrapped: unknown }, p: Vec3): number {
  const oc = getOC() as any;
  const pt = new oc.gp_Pnt(p[0], p[1], p[2]);
  const vertex = new oc.BRepBuilderAPI_MakeVertex(pt);
  const ds = new oc.BRepExtrema_DistShapeShape();
  try {
    ds.LoadS1(vertex.Vertex());
    ds.LoadS2(shape.wrapped);
    if (!ds.Perform() || ds.NbSolution() === 0) return Infinity;
    return ds.Value();
  } finally {
    ds.delete();
    vertex.delete();
    pt.delete();
  }
}

/**
 * Trim curve: a wire cut where it first meets `bound` (faces, a plane's sheet or another curve), walking from its
 * start — or, with `keepEnd`, from its end (the result still runs the wire's way). Throws a plain message when they
 * don't meet.
 */
export function trimWire(wire: Wire, bound: { wrapped: unknown }, keepEnd: boolean): Wire {
  const oc = getOC() as any;
  const splitter = new oc.BRepAlgoAPI_Splitter();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  let pieces: Edge[];
  try {
    args.Append(wire.wrapped);
    tools.Append(bound.wrapped);
    splitter.SetArguments(args);
    splitter.SetTools(tools);
    splitter.Build();
    if (splitter.HasErrors()) throw new Error("Couldn't find where the curve meets that.");
    const result = cast(splitter.Shape()) as unknown as Shape3D;
    pieces = edgesOf(result);
    result.delete();
  } finally {
    splitter.delete();
    args.delete();
    tools.delete();
  }
  const tol = 1e-4;
  const left = pieces.map((e) => ({ e, ends: [takeVec(e.startPoint), takeVec(e.endPoint)] as [Vec3, Vec3] }));
  const kept: Edge[] = [];
  try {
    let cur = takeVec(keepEnd ? wire.endPoint : wire.startPoint);
    let met = false;
    while (left.length) {
      const k = left.findIndex((x) => dist(x.ends[0], cur) <= tol || dist(x.ends[1], cur) <= tol);
      if (k < 0) break;
      const [{ e, ends }] = left.splice(k, 1);
      kept.push(e);
      cur = dist(ends[0], cur) <= tol ? ends[1] : ends[0];
      if (gapTo(bound, cur) <= tol) {
        met = true;
        break;
      }
    }
    if (!met) throw new Error("The curve doesn't meet that face, plane or curve, so there's nothing to cut it back to.");
    // In the wire's own order (the split pieces keep their direction), so the result runs the wire's way.
    return assembleWire(keepEnd ? [...kept].reverse() : kept);
  } finally {
    kept.forEach((e) => e.delete());
    left.forEach((x) => x.e.delete());
  }
}
