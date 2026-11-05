/**
 * Simplify: tidying a part into real faces (OpenCascade side; the shape
 * recognising is pure, in src/geometry/meshSimplify.ts).
 *
 *  - Stage 1, always: OpenCascade's ShapeUpgrade_UnifySameDomain joins faces
 *    lying on the same surface, and edges on the same curve. That alone
 *    mends STEP files whose faces are split into pieces.
 *  - Stage 2, for parts made of triangles (an STL, or a STEP made from one):
 *    the plan from planMesh is built as a new solid from exact planes,
 *    cylinders, cones and spheres bounded by exact lines and arcs, sewn
 *    together. It's kept only if it's a sound closed solid with about the same
 *    volume; otherwise stage 1's result is kept and the summary says so.
 */
import { cast, getOC, measureVolume, type Shape3D } from "replicad";

import { NOTHING_TO_TIDY, planMesh, TOO_DETAILED, type MeshPlan, type PlanCurve, type PlanOptions } from "../geometry/meshSimplify";
import { canonicalX, dot, frameOf, sub, surfaceDistance, unit, type TorusSurface, type Vec3 } from "../geometry/shapeFit";
import { weld } from "../geometry/threeMf";
import { SIMPLIFY_TOLERANCES, type SimplifiedFace, type SimplifyLevel, type SimplifySummary, type SimplifyTolerances } from "../model/simplify";
import { facesOf, solidsOf } from "./topology";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Freed in reverse order when a build is done. */
class Bin {
  private items: { delete(): void }[] = [];
  keep<T extends { delete(): void }>(x: T): T {
    this.items.push(x);
    return x;
  }
  empty() {
    for (const x of this.items.reverse()) {
      try {
        x.delete();
      } catch {
        /* already gone */
      }
    }
    this.items = [];
  }
}

/**
 * Faces on the same surface and edges on the same curve joined (OpenCascade's
 * UnifySameDomain). `tol` loosens it to the level's tolerances — only for
 * shapes made of facets, whose flat pieces are only nearly in line; exact
 * shapes use OpenCascade's own tight tolerances, so faces that really are at
 * an angle are never joined. A new shape (the input is left alone).
 */
export function unifyShape(shape: Shape3D, tol?: SimplifyTolerances): Shape3D {
  const oc = getOC() as any;
  const unify = new oc.ShapeUpgrade_UnifySameDomain(shape.wrapped, true, true, true);
  try {
    if (tol) {
      unify.SetLinearTolerance(tol.distance);
      unify.SetAngularTolerance(tol.angle);
    }
    unify.Build();
    return cast(unify.Shape()) as Shape3D;
  } finally {
    unify.delete();
  }
}

/** Whether a shape passes OpenCascade's check. */
function soundShape(shape: Shape3D): boolean {
  const oc = getOC() as any;
  try {
    const check = new oc.BRepCheck_Analyzer(shape.wrapped, true, false, false);
    const ok = check.IsValid();
    check.delete();
    return ok;
  } catch {
    return false;
  }
}

const volumeOf = (shape: Shape3D): number | null => {
  try {
    const v = measureVolume(shape);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
};

/**
 * unifyShape, checked: the result is kept only if it's sound and holds the
 * same volume (to 1 part in a million; a surface has none, so only soundness
 * counts). Otherwise a copy of the input comes back, with `ok` false.
 */
export function checkedUnify(shape: Shape3D, tol?: SimplifyTolerances): { shape: Shape3D; ok: boolean } {
  const solid = solidsOf(shape);
  const isSolid = solid.length > 0;
  solid.forEach((x) => x.delete());
  const before = isSolid ? volumeOf(shape) : null;
  let out: Shape3D | null = null;
  try {
    out = unifyShape(shape, tol);
    const after = isSolid ? volumeOf(out) : null;
    const same = !isSolid || (before !== null && after !== null && Math.abs(after - before) <= 1e-6 * Math.abs(before) + 1e-6);
    if (same && soundShape(out)) return { shape: out, ok: true };
  } catch {
    /* fall through */
  }
  out?.delete();
  // Loosened tolerances (facets) failing, OpenCascade's own may still join something safely.
  if (tol) {
    const strict = checkedUnify(shape);
    if (strict.ok) return strict;
    strict.shape.delete();
  }
  return { shape: shape.clone(), ok: false };
}

/**
 * Whether a shape is made of facets: many faces, nearly all flat with only
 * straight edges (triangles, or flat areas of them already joined — as an
 * ordinary STL import does). Such a shape gets stage 2.
 */
export function isFaceted(shape: Shape3D): boolean {
  const oc = getOC() as any;
  const faces = facesOf(shape);
  try {
    if (faces.length < 20) return false;
    let flat = 0;
    for (const f of faces) {
      const surf = new oc.BRepAdaptor_Surface(f.wrapped, false);
      const plane = surf.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane;
      surf.delete();
      if (!plane) continue;
      const ex = new oc.TopExp_Explorer(f.wrapped, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      let straight = true;
      for (; ex.More() && straight; ex.Next()) {
        const c = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(ex.Current()));
        straight = c.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line;
        c.delete();
      }
      ex.delete();
      if (straight) flat++;
    }
    return flat >= 0.9 * faces.length;
  } finally {
    faces.forEach((f) => f.delete());
  }
}

const pnt = (bin: Bin, p: Vec3) => bin.keep(new (getOC() as any).gp_Pnt(p[0], p[1], p[2]));
const dir = (bin: Bin, d: Vec3) => bin.keep(new (getOC() as any).gp_Dir(d[0], d[1], d[2]));

function makeCurveEdge(bin: Bin, c: PlanCurve): any {
  const oc = getOC() as any;
  if (c.kind === "line") {
    const mk = bin.keep(new oc.BRepBuilderAPI_MakeEdge(pnt(bin, c.from), pnt(bin, c.to)));
    if (!mk.IsDone()) throw new Error("line");
    return bin.keep(mk.Edge());
  }
  // The circle starts at `from`, so a whole circle's one corner sits there.
  const x = unit(sub(c.from, c.centre));
  const xdir: Vec3 = Math.abs(dot(x, c.normal)) < 0.9 ? unit(sub(x, [c.normal[0] * dot(x, c.normal), c.normal[1] * dot(x, c.normal), c.normal[2] * dot(x, c.normal)])) : frameOf(c.normal)[0];
  const ax = bin.keep(new oc.gp_Ax2(pnt(bin, c.centre), dir(bin, c.normal), dir(bin, xdir)));
  const circ = bin.keep(new oc.gp_Circ(ax, c.radius));
  const mk = c.full ? bin.keep(new oc.BRepBuilderAPI_MakeEdge(circ)) : bin.keep(new oc.BRepBuilderAPI_MakeEdge(circ, pnt(bin, c.from), pnt(bin, c.to)));
  if (!mk.IsDone()) throw new Error("arc");
  return bin.keep(mk.Edge());
}

/** An unbounded face on the plan face's surface, for its Geom_Surface. */
function surfaceOf(bin: Bin, s: MeshPlan["faces"][number]["surface"], poleAxis?: Vec3): any {
  const oc = getOC() as any;
  switch (s.kind) {
    case "plane": {
      const pln = bin.keep(new oc.gp_Pln(pnt(bin, s.origin), dir(bin, s.normal)));
      const f = bin.keep(new oc.BRepBuilderAPI_MakeFace(pln));
      return oc.BRep_Tool.Surface(bin.keep(f.Face()));
    }
    case "cylinder": {
      const u = canonicalX(s.axis);
      const ax = bin.keep(new oc.gp_Ax3(pnt(bin, s.origin), dir(bin, s.axis), dir(bin, u)));
      return new oc.Geom_CylindricalSurface(ax, s.radius);
    }
    case "cone": {
      const u = canonicalX(s.axis);
      const ax = bin.keep(new oc.gp_Ax3(pnt(bin, s.origin), dir(bin, s.axis), dir(bin, u)));
      return new oc.Geom_ConicalSurface(ax, Math.atan(s.slope), s.radius);
    }
    case "torus": {
      // (OpenCascade's torus surface type isn't available here on its own: take it from a torus solid's face.)
      const ax = bin.keep(new oc.gp_Ax2(pnt(bin, s.origin), dir(bin, s.axis), dir(bin, canonicalX(s.axis))));
      const maker = bin.keep(new oc.BRepPrimAPI_MakeTorus(ax, s.major, s.minor));
      const solid = bin.keep(maker.Shape());
      const ex = new oc.TopExp_Explorer(solid, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      const face = bin.keep(oc.TopoDS.Face(ex.Current()));
      ex.delete();
      return oc.BRep_Tool.Surface(face);
    }
    case "sphere": {
      const a = poleAxis ?? [0, 0, 1];
      const ax = bin.keep(new oc.gp_Ax3(pnt(bin, s.centre), dir(bin, a), dir(bin, canonicalX(a))));
      return new oc.Geom_SphericalSurface(ax, s.radius);
    }
  }
}

/**
 * A round face bounded only by whole circles square to its axis (a hole, a
 * boss, a ball's cap or band): the range of its surface's v between them, as
 * OpenCascade measures it. Null for any other face (made from its outline).
 */
function bandOf(face: MeshPlan["faces"][number], curves: PlanCurve[]): { axis?: Vec3; v0: number; v1: number } | null {
  const s = face.surface;
  if (s.kind === "plane") return null;
  const circles = face.loops.map((l) => (l.length === 1 ? curves[l[0].curve] : null));
  if (circles.some((c) => !c || c.kind !== "arc" || !c.full)) return null;
  const arcs = circles as Extract<PlanCurve, { kind: "arc" }>[];
  if (s.kind === "sphere") {
    const a = arcs.length ? arcs[0].normal : ([0, 0, 1] as Vec3);
    if (arcs.some((c) => Math.abs(dot(c.normal, a)) < 1 - 1e-9)) return null;
    const lat = (p: Vec3) => Math.asin(Math.max(-1, Math.min(1, dot(sub(p, s.centre), a) / s.radius)));
    const vs = arcs.map((c) => lat(c.centre));
    if (vs.length === 0) return { axis: a, v0: -Math.PI / 2, v1: Math.PI / 2 };
    if (vs.length === 1) return lat(face.sample) > vs[0] ? { axis: a, v0: vs[0], v1: Math.PI / 2 } : { axis: a, v0: -Math.PI / 2, v1: vs[0] };
    if (vs.length === 2) return { axis: a, v0: Math.min(...vs), v1: Math.max(...vs) };
    return null;
  }
  if (arcs.length !== 2 || arcs.some((c) => Math.abs(dot(c.normal, s.axis)) < 1 - 1e-9)) return null;
  if (s.kind === "torus") {
    // Round the tube: v from the outside (0) up over the top; the face is the stretch that holds the sample.
    const vOf = (p: Vec3) => {
      const d = sub(p, s.origin);
      const h = dot(d, s.axis);
      const rho = Math.hypot(...sub(d, [s.axis[0] * h, s.axis[1] * h, s.axis[2] * h]));
      return Math.atan2(h, rho - s.major);
    };
    const circlePoint = (c: Extract<PlanCurve, { kind: "arc" }>) => c.from;
    const [a, b] = arcs.map((c) => vOf(circlePoint(c)));
    const vs = vOf(face.sample);
    const turn = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return turn(vs - a) < turn(b - a) ? { v0: a, v1: a + turn(b - a) } : { v0: b, v1: b + turn(a - b) };
  }
  // Along a cone's side, v is measured on the slant.
  const k = s.kind === "cone" ? Math.hypot(1, s.slope) : 1;
  const vs = arcs.map((c) => dot(sub(c.centre, s.origin), s.axis) * k);
  return { v0: Math.min(...vs), v1: Math.max(...vs) };
}

/** The solid a plan describes, or a reason it couldn't be made soundly. */
export function solidFromPlan(plan: MeshPlan, tol: SimplifyTolerances): Shape3D | string {
  const oc = getOC() as any;
  const bin = new Bin();
  try {
    const edges = plan.curves.map((c) => makeCurveEdge(bin, c));
    const sewing = bin.keep(new oc.BRepBuilderAPI_Sewing(Math.max(1e-4, tol.distance / 5), true, true, true, false));
    for (const face of plan.faces) {
      const band = bandOf(face, plan.curves);
      if (band) {
        const surface = surfaceOf(bin, face.surface, band.axis);
        const mk = bin.keep(new oc.BRepBuilderAPI_MakeFace(surface, 0, 2 * Math.PI, band.v0, band.v1, 1e-7));
        if (!mk.IsDone()) return "A round face couldn't be made.";
        const f = bin.keep(mk.Face());
        sewing.Add(face.forward ? f : bin.keep(f.Reversed()));
        continue;
      }
      const surface = surfaceOf(bin, face.surface);
      const fix = bin.keep(new oc.ShapeFix_Face());
      // Built on the surface's own side (ShapeFix_Face can't close a reversed face's loops), then turned round.
      fix.Init(surface, 1e-6, true);
      for (const loop0 of face.loops) {
        const loop = face.forward ? loop0 : [...loop0].reverse().map((u) => ({ ...u, reversed: !u.reversed }));
        const mk = bin.keep(new oc.BRepBuilderAPI_MakeWire());
        for (const use of loop) {
          const e = use.reversed ? bin.keep(oc.TopoDS.Edge(edges[use.curve].Reversed())) : edges[use.curve];
          mk.Add(e);
        }
        if (!mk.IsDone()) return "A face's outline didn't join up.";
        fix.Add(bin.keep(mk.Wire()));
      }
      fix.Perform();
      const res = bin.keep(fix.Result());
      sewing.Add(face.forward ? res : bin.keep(res.Reversed()));
    }
    sewing.Perform();
    const sewn = cast(sewing.SewedShape()) as Shape3D;
    bin.keep(sewn);
    const shells: any[] = [];
    const ex = new oc.TopExp_Explorer(sewn.wrapped, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; ex.More(); ex.Next()) shells.push(bin.keep(oc.TopoDS.Shell(ex.Current())));
    ex.delete();
    if (!shells.length) {
      // A single closed face (a whole ball) isn't put in a shell by sewing.
      const builder = bin.keep(new oc.TopoDS_Builder());
      const shell = bin.keep(new oc.TopoDS_Shell());
      builder.MakeShell(shell);
      const fx = new oc.TopExp_Explorer(sewn.wrapped, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      for (; fx.More(); fx.Next()) builder.Add(shell, fx.Current());
      fx.delete();
      shells.push(shell);
    }
    if (shells.length !== 1) return `The faces sewed into ${shells.length} pieces, not one.`;
    const fixer = bin.keep(new oc.ShapeFix_Solid());
    let solid = cast(fixer.SolidFromShell(shells[0])) as Shape3D;
    try {
      if (measureVolume(solid) < 0) {
        const flipped = cast(solid.wrapped.Reversed()) as Shape3D;
        solid.delete();
        solid = flipped;
      }
      const check = new oc.BRepCheck_Analyzer(solid.wrapped, true, false, false);
      const valid = check.IsValid();
      check.delete();
      if (!valid) throw new Error("The rebuilt part didn't pass OpenCascade's check.");
      const volume = measureVolume(solid);
      if (!(Math.abs(volume - plan.volume) <= 0.02 * Math.abs(plan.volume))) throw new Error(`The rebuilt part's volume (${volume.toFixed(1)} mm³) is too far from the original's (${plan.volume.toFixed(1)} mm³).`);
      if (solidsOf(solid).length !== 1) throw new Error("not one solid");
    } catch (e) {
      solid.delete();
      return e instanceof Error ? e.message : "The rebuilt part isn't sound.";
    }
    return solid;
  } catch (e) {
    return e instanceof Error && e.message ? `Couldn't rebuild a face (${e.message}).` : "Couldn't rebuild the faces.";
  } finally {
    bin.empty();
  }
}

/** What each face of a shape is, for the summary. */
export function describeFaces(shape: Shape3D, meshPoints: Vec3[] = [], tori: TorusSurface[] = []): SimplifiedFace[] {
  const oc = getOC() as any;
  const T = oc.GeomAbs_SurfaceType;
  const out: SimplifiedFace[] = [];
  const faces = facesOf(shape);
  for (const f of faces) {
    const s = new oc.BRepAdaptor_Surface(f.wrapped, true);
    try {
      const type = s.GetType();
      if (type === T.GeomAbs_Plane) {
        // Left as facets when one of the plan's facet faces lies on it (its plane, inside its box).
        let mesh = false;
        if (meshPoints.length) {
          const pl = s.Plane();
          const loc = pl.Location();
          const ax = pl.Axis();
          const d = ax.Direction();
          const o: Vec3 = [loc.X(), loc.Y(), loc.Z()];
          const n: Vec3 = [d.X(), d.Y(), d.Z()];
          [d, ax, loc, pl].forEach((x) => x.delete());
          const box = f.boundingBox.bounds;
          const e = 1e-3;
          mesh = meshPoints.some((p) => Math.abs(dot(sub(p, o), n)) < e && [0, 1, 2].every((k) => p[k] >= box[0][k] - e && p[k] <= box[1][k] + e));
        }
        out.push(mesh ? { kind: "plane", mesh: true } : { kind: "plane" });
        continue;
      }
      const kind: SimplifiedFace["kind"] = type === T.GeomAbs_Cylinder ? "cylinder" : type === T.GeomAbs_Cone ? "cone" : type === T.GeomAbs_Sphere ? "sphere" : type === T.GeomAbs_Torus ? "torus" : "other";
      if (kind === "other") {
        out.push({ kind });
        continue;
      }
      if (kind === "torus") {
        // Its sizes from the torus it was built on (OpenCascade's torus type isn't available here).
        const p = new oc.gp_Pnt();
        s.D0((s.FirstUParameter() + s.LastUParameter()) / 2, (s.FirstVParameter() + s.LastVParameter()) / 2, p);
        const at: Vec3 = [p.X(), p.Y(), p.Z()];
        p.delete();
        const t = tori.find((x) => surfaceDistance(x, at) < 1e-3);
        out.push({ kind, radius: t?.minor, full: s.LastUParameter() - s.FirstUParameter() >= 2 * Math.PI - 1e-3 });
        continue;
      }
      const u0 = s.FirstUParameter();
      const u1 = s.LastUParameter();
      const v0 = s.FirstVParameter();
      const v1 = s.LastVParameter();
      const full = u1 - u0 >= 2 * Math.PI - 1e-3;
      // Inwards (a hole) when the face's outward normal points towards the axis.
      const p = new oc.gp_Pnt();
      const du = new oc.gp_Vec();
      const dv = new oc.gp_Vec();
      s.D1((u0 + u1) / 2, (v0 + v1) / 2, p, du, dv);
      const n0 = du.Crossed(dv);
      const reversed = f.wrapped.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
      let n: Vec3 = [n0.X(), n0.Y(), n0.Z()];
      if (reversed) n = [-n[0], -n[1], -n[2]];
      let radius: number | undefined;
      let concave = false;
      const at: Vec3 = [p.X(), p.Y(), p.Z()];
      if (kind === "cone") {
        // (OpenCascade's cone type isn't available here; the summary only counts cones.)
      } else if (kind === "cylinder") {
        const g = s.Cylinder();
        const ax = g.Axis();
        const loc = ax.Location();
        const d = ax.Direction();
        const o: Vec3 = [loc.X(), loc.Y(), loc.Z()];
        const a: Vec3 = [d.X(), d.Y(), d.Z()];
        const rel = sub(at, o);
        const radial = sub(rel, [a[0] * dot(rel, a), a[1] * dot(rel, a), a[2] * dot(rel, a)]);
        concave = dot(radial, n) < 0;
        radius = g.Radius();
        loc.delete();
        d.delete();
        ax.delete();
        g.delete();
      } else {
        const g = s.Sphere();
        radius = g.Radius();
        const c = g.Location();
        concave = dot(sub(at, [c.X(), c.Y(), c.Z()]), n) < 0;
        c.delete();
        g.delete();
      }
      [p, du, dv, n0].forEach((x) => x.delete());
      out.push({ kind, radius, full, concave });
    } finally {
      s.delete();
    }
  }
  faces.forEach((f) => f.delete());
  return out;
}

const faceCount = (shape: Shape3D) => {
  const fs = facesOf(shape);
  fs.forEach((f) => f.delete());
  return fs.length;
};

export interface Simplified {
  shape: Shape3D;
  summary: SimplifySummary;
}

/** A closed welded triangle mesh as a solid of exact faces, or a reason it couldn't be. */
export interface MeshSolid {
  shape: Shape3D;
  /** Where the faces left as facets are (a point on each). */
  meshPoints: Vec3[];
  /** Round faces were looked for but none could be kept (only flat faces were rebuilt). */
  flatOnly: boolean;
  /** Round faces found but given back as facets. */
  gaveUp: number;
  tori: TorusSurface[];
}

/** A closed welded triangle mesh as a solid of exact faces, or a reason it couldn't be (TOO_DETAILED, NOTHING_TO_TIDY…). */
export function solidFromMesh(vertices: ArrayLike<number>, triangles: ArrayLike<number>, tol: SimplifyTolerances, options: PlanOptions = {}): MeshSolid | string {
  let reason = "";
  let gaveUp = 0;
  // With round faces first; if that doesn't give a sound solid, flat faces only (always possible for a sound mesh).
  for (const flatOnly of [false, true]) {
    const plan = planMesh(vertices, triangles, tol, { ...options, flatOnly });
    if (typeof plan === "string") return plan;
    if (!flatOnly) gaveUp = plan.faces.filter((f) => f.surface.kind !== "plane").length;
    const solid = solidFromPlan(plan, tol);
    if (typeof solid !== "string") {
      // The flat pieces nothing simpler fitted; tidied with OpenCascade's own tolerances (only what's truly in line), checked.
      const tidy = checkedUnify(solid);
      solid.delete();
      return {
        shape: tidy.shape,
        meshPoints: plan.faces.filter((f) => f.mesh).map((f) => f.sample),
        flatOnly,
        gaveUp: flatOnly ? gaveUp : plan.gaveUp,
        tori: plan.faces.flatMap((f) => (f.surface.kind === "torus" ? [f.surface] : [])),
      };
    }
    reason = solid;
  }
  return reason;
}

/** The triangles of a faceted shape (each face's own triangulation), welded. */
function trianglesOf(shape: Shape3D): { vertices: number[]; triangles: number[] } {
  const m = shape.mesh({ tolerance: 0.01, angularTolerance: 0.1 });
  return weld(m.vertices, m.triangles);
}

/** The summary for a solid rebuilt from a mesh. */
export function meshSummary(facesBefore: number, r: MeshSolid): SimplifySummary {
  return {
    facesBefore,
    faces: describeFaces(r.shape, r.meshPoints, r.tori),
    recognised: !r.flatOnly,
    ...(r.flatOnly ? { fellBack: true } : {}),
    ...(r.gaveUp ? { gaveUp: r.gaveUp } : {}),
  };
}

/** A faceted skin (a STEP file's triangles not made into a solid) as a solid of real faces, if it closes up. */
export function solidFromFacets(shape: Shape3D, level: SimplifyLevel): Simplified | null {
  if (!isFaceted(shape)) return null;
  const tol = SIMPLIFY_TOLERANCES[level];
  const before = faceCount(shape);
  const mesh = trianglesOf(shape);
  const rebuilt = solidFromMesh(mesh.vertices, mesh.triangles, tol);
  if (typeof rebuilt === "string") return null;
  return { shape: rebuilt.shape, summary: meshSummary(before, rebuilt) };
}

/** Stage 1 alone (faceted shapes with the level's tolerances, exact ones with OpenCascade's own), with its summary. */
function joinedOnly(shape: Shape3D, before: number, tol: SimplifyTolerances | undefined, extra: Partial<SimplifySummary>): Simplified {
  const joined = checkedUnify(shape, tol);
  return {
    shape: joined.shape,
    summary: { facesBefore: before, faces: describeFaces(joined.shape), recognised: false, ...extra, ...(joined.ok ? {} : { unchanged: true }) },
  };
}

/**
 * Simplify one solid (or surface): stage 1 always, and for one made of
 * triangles stage 2 as well. The input is left alone; the result is new.
 * Every step is checked: what isn't sound (or changes the volume) isn't kept.
 */
export function simplifyShape(shape: Shape3D, level: SimplifyLevel, options: PlanOptions = {}): Simplified {
  const tol = SIMPLIFY_TOLERANCES[level];
  const before = faceCount(shape);
  const solids = solidsOf(shape);
  const solid = solids.length === 1;
  solids.forEach((s) => s.delete());
  const faceted = isFaceted(shape);
  if (solid && faceted) {
    const mesh = trianglesOf(shape);
    const rebuilt = solidFromMesh(mesh.vertices, mesh.triangles, tol, options);
    if (typeof rebuilt !== "string") return { shape: rebuilt.shape, summary: meshSummary(before, rebuilt) };
    if (rebuilt === TOO_DETAILED) return { shape: shape.clone(), summary: { facesBefore: before, faces: describeFaces(shape), recognised: false, tooDetailed: true } };
    return joinedOnly(shape, before, tol, rebuilt === NOTHING_TO_TIDY ? { nothingFound: true } : { fellBack: true });
  }
  return joinedOnly(shape, before, faceted ? tol : undefined, {});
}

/* eslint-enable @typescript-eslint/no-explicit-any */
