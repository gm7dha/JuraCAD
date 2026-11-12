/**
 * The geometry of curve features (see model/curves.ts): helices (on a cylinder or, tapered, a cone), Bézier
 * bridging curves, splines through points, curves where shapes meet (sections), sketches pushed out into
 * sheets to project, edges joined end to end, and polylines to draw them.
 */
import { assembleWire, cast, getOC, makeBezierCurve, makeCompound, makePolygon, measureLength, Edge, type Face, type Shape3D, type Wire } from "replicad";
import { edgesOf } from "./topology";

type Vec3 = [number, number, number];
/* eslint-disable @typescript-eslint/no-explicit-any */

const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Read a replicad vector into numbers, freeing it. */
export function takeVec(v: { x: number; y: number; z: number; delete(): void }): Vec3 {
  const r: Vec3 = [v.x, v.y, v.z];
  v.delete();
  return r;
}

/** A direction square to `z` (the same one each time for the same `z`). */
export function squareTo(z: Vec3): Vec3 {
  const r: Vec3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const d = dot(r, z);
  return unit([r[0] - z[0] * d, r[1] - z[1] * d, r[2] - z[2] * d]);
}

export interface HelixSpec {
  /** Where it starts on the axis, and the axis (up). */
  origin: Vec3;
  axis: Vec3;
  /** The direction from the axis to the start point. */
  x: Vec3;
  /** Radius at the start and at the top. */
  r0: number;
  r1: number;
  height: number;
  turns: number;
  clockwise?: boolean;
}

/**
 * A helix as one exact edge: a straight line in the unrolled (angle, height) plane of a cylinder — or, when the
 * radius changes, of a cone (a tapered helix: the radius grows evenly with the height, the pitch stays the same).
 */
export function helixWire(h: HelixSpec): Wire {
  if (!(h.r0 > 1e-6) && !(h.r1 > 1e-6)) throw new Error("The helix needs a radius: pick a start point away from the axis, or give it a diameter.");
  if (!(h.r0 >= 0) || !(h.r1 >= 0)) throw new Error("The taper is too steep: the helix would shrink past its axis before the top. Use less taper or less height.");
  const oc = getOC() as any;
  const made: any[] = [];
  const keep = <T>(x: T): T => {
    made.push(x);
    return x;
  };
  try {
    const z = unit(h.axis);
    // The start direction square to the axis.
    const x0 = h.x;
    const xd = dot(x0, z);
    let x: Vec3 = [x0[0] - z[0] * xd, x0[1] - z[1] * xd, x0[2] - z[2] * xd];
    x = Math.hypot(...x) > 1e-9 ? unit(x) : squareTo(z);
    const ax3 = keep(new oc.gp_Ax3(keep(new oc.gp_Pnt(...h.origin)), keep(new oc.gp_Dir(...z)), keep(new oc.gp_Dir(...x))));
    const tapered = Math.abs(h.r1 - h.r0) > 1e-9;
    const semi = tapered ? Math.atan2(h.r1 - h.r0, h.height) : 0;
    // Along the cone's side, the height is v·cos(semi).
    const vLen = tapered ? h.height / Math.cos(semi) : h.height;
    const surface = keep(tapered ? new oc.Geom_ConicalSurface(ax3, semi, h.r0) : new oc.Geom_CylindricalSurface(ax3, h.r0));
    const u1 = (h.clockwise ? -1 : 1) * 2 * Math.PI * h.turns;
    const seg = keep(new oc.GC_MakeSegment2d(keep(new oc.gp_Pnt2d(0, 0)), keep(new oc.gp_Pnt2d(u1, vLen))));
    const edge = keep(keep(new oc.BRepBuilderAPI_MakeEdge(keep(seg.Value()), surface)).Edge());
    const w = keep(new oc.BRepBuilderAPI_MakeWire(edge)).Wire();
    oc.BRepLib.BuildCurves3d(w);
    return cast(w) as Wire;
  } finally {
    made.reverse().forEach((m) => {
      try {
        m.delete();
      } catch {
        // already freed
      }
    });
  }
}

/** An edge along a Bézier curve through these control points (a straight line for two). */
export function bezierEdge(points: Vec3[]): Edge {
  return makeBezierCurve(points);
}

/** A smooth spline through these points in order (closed: back round to the first, smoothly). */
export function interpolatedEdge(points: Vec3[], closed: boolean): Edge {
  const oc = getOC() as any;
  const flat = new oc.NCollection_Array1_gp_Pnt(1, points.length);
  const made: any[] = [flat];
  try {
    points.forEach((p, i) => {
      const q = new oc.gp_Pnt(...p);
      made.push(q);
      flat.SetValue(i + 1, q);
    });
    // (Held by OpenCascade's handle once given to the fit, so it isn't freed here.)
    const arr = new oc.NCollection_HArray1_gp_Pnt(flat);
    const fit = new oc.GeomAPI_Interpolate(arr, closed, 1e-7);
    made.push(fit);
    fit.Perform();
    if (!fit.IsDone()) throw new Error("Couldn't fit a spline through those points. Check no two are at the same place.");
    const maker = new oc.BRepBuilderAPI_MakeEdge(fit.Curve());
    made.push(maker);
    return new Edge(maker.Edge());
  } finally {
    made.reverse().forEach((m) => m.delete());
  }
}

/** The edges where two shapes meet (OpenCascade's section). The caller deletes them. */
export function sectionEdges(a: { wrapped: unknown }, b: { wrapped: unknown }): Edge[] {
  const oc = getOC() as any;
  const op = new oc.BRepAlgoAPI_Section(a.wrapped, b.wrapped, true);
  let out: Shape3D | null = null;
  try {
    if (!op.IsDone()) return [];
    out = cast(op.Shape()) as unknown as Shape3D;
    return edgesOf(out);
  } catch {
    return [];
  } finally {
    out?.delete();
    op.delete();
  }
}

/** A big flat square on a plane, round `centre`, `reach` from it each way (to cut shapes with the plane). */
export function planeSheet(origin: Vec3, u: Vec3, v: Vec3, centre: Vec3, reach: number): Face {
  const n = cross(u, v);
  const h = dot([centre[0] - origin[0], centre[1] - origin[1], centre[2] - origin[2]], n);
  const c: Vec3 = [centre[0] - h * n[0], centre[1] - h * n[1], centre[2] - h * n[2]];
  const at = (a: number, b: number): Vec3 => [c[0] + a * u[0] + b * v[0], c[1] + a * u[1] + b * v[1], c[2] + a * u[2] + b * v[2]];
  return makePolygon([at(-reach, -reach), at(reach, -reach), at(reach, reach), at(-reach, reach)]);
}

/** A wire pushed out both ways along `dir` by `reach`, as a sheet (to find where it would land on faces). */
export function sheetAlong(wire: Wire, dir: Vec3, reach: number): Shape3D {
  const oc = getOC() as any;
  const d = unit(dir);
  const moved = wire.clone().translate([-d[0] * reach, -d[1] * reach, -d[2] * reach]) as Wire;
  const vec = new oc.gp_Vec(d[0] * 2 * reach, d[1] * 2 * reach, d[2] * 2 * reach);
  const prism = new oc.BRepPrimAPI_MakePrism(moved.wrapped, vec, false, true);
  try {
    return cast(prism.Shape()) as unknown as Shape3D;
  } finally {
    prism.delete();
    vec.delete();
    moved.delete();
  }
}

/** One shape holding several (deleting it leaves them alone). */
export function compoundOf(shapes: { wrapped: unknown }[]): Shape3D {
  return makeCompound(shapes.map((s) => cast((s as { wrapped: any }).wrapped)) as never) as unknown as Shape3D;
}

/** An edge's (or wire's) two ends. */
export function endsOf(c: Edge | Wire): [Vec3, Vec3] {
  return [takeVec(c.startPoint), takeVec(c.endPoint)];
}

/**
 * Edges joined end to end into runs (in any order, either way round), each run a wire. Ends within `tol` meet.
 * Takes the edges over (they're freed once in wires).
 */
export function chainEdges(edges: Edge[], tol = 1e-4): Wire[] {
  const left = edges.map((e) => ({ e, ends: endsOf(e) }));
  const runs: Edge[][] = [];
  while (left.length) {
    const first = left.shift()!;
    const run = [first.e];
    let head = first.ends[0];
    let tail = first.ends[1];
    let grew = true;
    while (grew && dist(head, tail) > tol) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const { e, ends } = left[i];
        if (dist(ends[0], tail) <= tol || dist(ends[1], tail) <= tol) {
          tail = dist(ends[0], tail) <= tol ? ends[1] : ends[0];
          run.push(e);
        } else if (dist(ends[0], head) <= tol || dist(ends[1], head) <= tol) {
          head = dist(ends[0], head) <= tol ? ends[1] : ends[0];
          run.unshift(e);
        } else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    runs.push(run);
  }
  return runs.map((run) => {
    try {
      return assembleWire(run);
    } finally {
      run.forEach((e) => e.delete());
    }
  });
}

/** Points along an edge, close enough to draw it smoothly (flat x, y, z…). */
export function edgePolyline(e: Edge): number[] {
  let length = 0;
  try {
    length = measureLength(e);
  } catch {
    length = 0;
  }
  const n = e.geomType === "LINE" ? 1 : Math.max(24, Math.min(2000, Math.ceil(length / 0.6)));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(...takeVec(e.pointAt(i / n)));
  return out;
}

/**
 * A wire as one polyline, walked the way the wire runs (its edges in order, each the right way round), so its first
 * and last points are the wire's start and end — the drawn line and the engine's ends always agree.
 */
export function wirePolyline(w: Wire): number[] {
  const oc = getOC() as any;
  const curve = new oc.BRepAdaptor_CompCurve(w.wrapped, true);
  try {
    const C0 = oc.GeomAbs_Shape.GeomAbs_C0;
    const n = curve.NbIntervals(C0);
    const knots = new oc.NCollection_Array1_double(1, n + 1);
    curve.Intervals(knots, C0);
    const out: number[] = [];
    const at = (u: number) => {
      const p = curve.Value(u);
      const q: Vec3 = [p.X(), p.Y(), p.Z()];
      p.delete();
      return q;
    };
    for (let i = 1; i <= n; i++) {
      const a = knots.Value(i);
      const b = knots.Value(i + 1);
      // How long this piece is (roughly), for how many points it needs.
      let rough = 0;
      let prev = at(a);
      for (let k = 1; k <= 16; k++) {
        const q = at(a + ((b - a) * k) / 16);
        rough += dist(prev, q);
        prev = q;
      }
      const type = curve.GetType();
      const straight = n === 1 && type === oc.GeomAbs_CurveType.GeomAbs_Line;
      const steps = straight ? 1 : Math.max(24, Math.min(2000, Math.ceil(rough / 0.6)));
      for (let k = i === 1 ? 0 : 1; k <= steps; k++) out.push(...at(a + ((b - a) * k) / steps));
    }
    knots.delete();
    return out;
  } finally {
    curve.delete();
  }
}

/** Each edge of a shape as a polyline. */
export function shapePolylines(shape: { wrapped: unknown }): number[][] {
  const edges = edgesOf(shape);
  try {
    return edges.map(edgePolyline);
  } finally {
    edges.forEach((e) => e.delete());
  }
}

/**
 * At one end (0 = start, 1 = end, by the curve's own parameter) of an edge or wire: the point, the direction the
 * curve runs there (towards higher parameter) and its curvature vector (finite differences; good to ~1e-4).
 */
export function endFrame(c: Edge | Wire, end: 0 | 1): { p: Vec3; t: Vec3; k: Vec3 } {
  const s = end === 0 ? 1 : -1;
  const h = 1e-4;
  const at = (q: number): Vec3 => takeVec(c.pointAt(end === 0 ? q : 1 - q));
  const r0 = at(0);
  const r1 = at(h);
  const r2 = at(2 * h);
  const r3 = at(3 * h);
  // One-sided differences (second order): r' and r'' at the end, in the direction walked from it.
  const d1: Vec3 = [0, 1, 2].map((i) => (-3 * r0[i] + 4 * r1[i] - r2[i]) / (2 * h)) as Vec3;
  const d2: Vec3 = [0, 1, 2].map((i) => (2 * r0[i] - 5 * r1[i] + 4 * r2[i] - r3[i]) / (h * h)) as Vec3;
  const t = unit(d1);
  const s2 = dot(d1, d1);
  const k: Vec3 = s2 > 1e-24 ? ([0, 1, 2].map((i) => (d2[i] - t[i] * dot(d2, t)) / s2) as Vec3) : [0, 0, 0];
  return { p: r0, t: [t[0] * s, t[1] * s, t[2] * s], k };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The same wire walked the other way. */
export function reversedWire(w: Wire): Wire {
  return cast((w.wrapped as unknown as { Reversed(): unknown }).Reversed() as never) as Wire;
}
