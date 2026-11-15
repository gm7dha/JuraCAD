/**
 * Variable fillet: OpenCascade's BRepFilletAPI_MakeFillet with a radius law per edge. Each picked edge is added
 * (OpenCascade joins edges that meet smoothly into one run, a "contour"); every run with radius points gets, on
 * each of its edges, a list of (share of that edge, radius) worked out from the run-wide radii (runRadii /
 * edgeRadii in src/model/variableFillet.ts), so neighbouring edges agree where they meet. Runs without points keep
 * the main radius. The run's direction and each edge's place in it come from OpenCascade itself (FirstVertex,
 * RelativeAbscissa — shares of the run's length), so a point is put at the right end however the edge comes back.
 *
 * (The Law_Function overloads, Add(L, E) and SetRadius(L, IC, IinC), don't build in this OpenCascade build; the
 * (parameter, radius) array overloads do, so straight steps between points are given as close samples.)
 */
import { cast, getOC, type Edge, type Shape3D } from "replicad";
import type { Vec3 } from "../geometry/topoRef";
import { edgeRadii, runRadii } from "../model/variableFillet";

/** A radius point on one of the edges: `at` from the end nearer `a` (the pick's `a` as stored) towards `b`. */
export interface EdgeRadiusPoint {
  at: number;
  radius: number;
  a: Vec3;
  b: Vec3;
}

const dist = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

/* eslint-disable @typescript-eslint/no-explicit-any */
function vertexPoint(oc: any, v: any): Vec3 {
  const p = oc.BRep_Tool.Pnt(v);
  const out: Vec3 = [p.X(), p.Y(), p.Z()];
  p.delete();
  return out;
}

/** The edge's vertices (each a new wrapper: the caller deletes them). */
function edgeVertices(oc: any, e: any): any[] {
  const out: any[] = [];
  const ex = new oc.TopExp_Explorer(e, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  try {
    for (; ex.More(); ex.Next()) {
      const current = ex.Current();
      out.push(oc.TopoDS.Vertex(current));
      current.delete?.();
    }
  } finally {
    ex.delete();
  }
  return out;
}

/**
 * Fillets `edges` of `shape`: edges with points vary as told, the rest (and the ends of runs with no point there)
 * use `main`. Throws (a VariableFilletError's plain words, or a bare Error) when it can't be made.
 */
export function variableFillet(shape: Shape3D, edges: { edge: Edge; points: EdgeRadiusPoint[] }[], main: number, straight: boolean): Shape3D {
  const oc = getOC() as any;
  const builder = new oc.BRepFilletAPI_MakeFillet(shape.wrapped, oc.ChFi3d_FilletShape.ChFi3d_Rational);
  const arrays: any[] = [];
  // Wrappers OpenCascade hands back (the contours' edges): JuraCAD rebuilds often, so every one is freed.
  const fetched: any[] = [];
  try {
    for (const { edge } of edges) builder.Add(edge.wrapped);
    const contours = builder.NbContours();
    for (let ic = 1; ic <= contours; ic++) {
      const n = builder.NbEdges(ic);
      const closed = !!builder.Closed(ic);
      // Each edge's span of the run, from the vertex nearer the run's start.
      const spans: { edge: any; u0: number; u1: number; p0: Vec3; p1: Vec3 }[] = [];
      for (let j = 1; j <= n; j++) {
        const e = builder.Edge(ic, j);
        fetched.push(e);
        const vs = edgeVertices(oc, e);
        const ends = vs.map((v) => ({ p: vertexPoint(oc, v), u: builder.RelativeAbscissa(ic, v) as number }));
        vs.forEach((v) => v.delete());
        if (ends.length < 2) ends.push({ ...ends[0] });
        if (n === 1 && closed) {
          ends[0].u = 0;
          ends[1].u = 1;
        } else if (closed && j === n) {
          // A closed run's seam is at 0: its last edge ends there, at 1.
          for (const end of ends) if (end.u < 1e-9) end.u = 1;
        }
        const [s, t] = ends[0].u <= ends[1].u ? [ends[0], ends[1]] : [ends[1], ends[0]];
        spans.push({ edge: e, u0: s.u, u1: t.u, p0: s.p, p1: t.p });
      }
      // The points on this run, as shares of the run.
      const runPoints: { u: number; r: number }[] = [];
      for (const span of spans) {
        const mine = edges.find((x) => x.points.length && x.edge.wrapped.IsSame(span.edge));
        if (!mine) continue;
        for (const p of mine.points) {
          const startIsA = n === 1 && closed ? true : dist(span.p0, p.a) + dist(span.p1, p.b) <= dist(span.p0, p.b) + dist(span.p1, p.a);
          const share = startIsA ? p.at : 1 - p.at;
          runPoints.push({ u: span.u0 + share * (span.u1 - span.u0), r: p.radius });
        }
      }
      if (!runPoints.length) {
        builder.SetRadius(main, ic, 1);
        continue;
      }
      const radii = runRadii(runPoints, main, closed);
      spans.forEach((span, k) => {
        const law = edgeRadii(radii, span.u0, span.u1, straight);
        if (law.length < 2) return;
        const arr = new oc.NCollection_Array1_gp_Pnt2d(1, law.length);
        arrays.push(arr);
        law.forEach(([x, r], i) => {
          const p = new oc.gp_Pnt2d(x, r);
          arr.SetValue(i + 1, p);
          p.delete();
        });
        builder.SetRadius(arr, ic, k + 1);
      });
    }
    const progress = new oc.Message_ProgressRange();
    builder.Build(progress);
    progress.delete();
    if (!builder.IsDone()) throw new Error("fillet not done");
    return cast(builder.Shape()) as Shape3D;
  } finally {
    arrays.forEach((a) => a.delete());
    fetched.forEach((e) => e.delete?.());
    builder.delete();
  }
}
