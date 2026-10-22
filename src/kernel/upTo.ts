/**
 * "Up to" ends for extrudes and holes: stopping at a curved or slanted face,
 * at the next face met, or at a part. Each is done the same dependable way: a
 * long extrude is cut up by what it should stop at (the face, or the parts),
 * and only the piece that starts at the sketch is kept.
 */
import { cast, getOC, makeCylinder, type Face, type Shape3D } from "replicad";

import { solidsOf } from "./topology";

type Vec3 = [number, number, number];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Pieces closer than this to the sketch (mm) count as starting at it. */
const TOUCH = 1e-3;

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The shortest distance between two shapes (Infinity if OpenCascade can't say). */
export function shapeDistance(a: { wrapped: unknown }, b: { wrapped: unknown }): number {
  const oc = getOC() as any;
  const dist = new oc.BRepExtrema_DistShapeShape();
  try {
    dist.LoadS1(a.wrapped);
    dist.LoadS2(b.wrapped);
    return dist.Perform() && dist.NbSolution() > 0 ? dist.Value() : Infinity;
  } finally {
    dist.delete();
  }
}

/** A square flat face `half` mm each way from `centre`, square-on to `n`. */
function squareFace(centre: Vec3, n: Vec3, half: number): Face {
  const oc = getOC() as any;
  const p = new oc.gp_Pnt(centre[0], centre[1], centre[2]);
  const d = new oc.gp_Dir(n[0], n[1], n[2]);
  const pln = new oc.gp_Pln(p, d);
  const maker = new oc.BRepBuilderAPI_MakeFace(pln, -half, half, -half, half);
  try {
    return cast(maker.Face()) as Face;
  } finally {
    maker.delete();
    pln.delete();
    d.delete();
    p.delete();
  }
}

/** The box round a shape (min and max corners). */
function boxOf(shape: Shape3D): [Vec3, Vec3] {
  const b = shape.boundingBox;
  const [lo, hi] = b.bounds as [Vec3, Vec3];
  b.delete();
  return [lo, hi];
}

/**
 * How far a shape reaches along the unit direction `n`, measured from the
 * plane through `origin` square-on to it: [nearest, furthest]. Exact on curved
 * faces too (worked out as distances to two big flat faces either side).
 */
export function extentAlong(shape: Shape3D, origin: Vec3, n: Vec3): [number, number] {
  const [lo, hi] = boxOf(shape);
  const mid: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const t = dot(sub(mid, origin), n);
  const far = diag + 10;
  const at = (s: number): Vec3 => [mid[0] + n[0] * s, mid[1] + n[1] * s, mid[2] + n[2] * s];
  const below = squareFace(at(-far), n, far);
  const above = squareFace(at(far), n, far);
  try {
    return [t - far + shapeDistance(shape, below), t + far - shapeDistance(shape, above)];
  } finally {
    below.delete();
    above.delete();
  }
}

/**
 * A face made bigger, so it reaches right across an extrude: its whole
 * surface for planes, cylinders, cones, spheres and rings (tori), trimmed to
 * `size` mm. Other curved faces (splines) are used as they are.
 */
export function extendedFace(face: Face, size: number): Face {
  const oc = getOC() as any;
  const adaptor = new oc.BRepAdaptor_Surface(face.wrapped, true);
  let maker: any = null;
  try {
    const kind = face.geomType;
    const twoPi = 2 * Math.PI;
    if (kind === "PLANE") maker = new oc.BRepBuilderAPI_MakeFace(adaptor.Plane(), -size, size, -size, size);
    else if (kind === "CYLINDRE") maker = new oc.BRepBuilderAPI_MakeFace(adaptor.Cylinder(), 0, twoPi, -size, size);
    else if (kind === "CONE") maker = new oc.BRepBuilderAPI_MakeFace(adaptor.Cone(), 0, twoPi, -size, size);
    else if (kind === "SPHERE") maker = new oc.BRepBuilderAPI_MakeFace(adaptor.Sphere(), 0, twoPi, -Math.PI / 2, Math.PI / 2);
    else if (kind === "TORUS") maker = new oc.BRepBuilderAPI_MakeFace(adaptor.Torus(), 0, twoPi, 0, twoPi);
    if (maker && maker.IsDone()) return cast(maker.Face()) as Face;
    return face.clone() as Face;
  } catch {
    return face.clone() as Face;
  } finally {
    maker?.delete();
    adaptor.delete();
  }
}

/** Pieces of a shape that start at the sketch plane (through `origin`, facing `n`). */
function startingPieces(shape: Shape3D, origin: Vec3, n: Vec3): { piece: Shape3D; far: number }[] {
  const out: { piece: Shape3D; far: number }[] = [];
  for (const piece of solidsOf(shape)) {
    const [near, far] = extentAlong(piece, origin, n);
    if (near < TOUCH) out.push({ piece, far });
    else piece.delete();
  }
  return out;
}

function joined(pieces: Shape3D[]): Shape3D {
  let out = pieces[0];
  for (const p of pieces.slice(1)) {
    const next = out.fuse(p);
    if (out !== pieces[0]) out.delete();
    out = next;
  }
  if (out !== pieces[0]) pieces.forEach((p) => p.delete());
  return out;
}

/**
 * Up to a face: `long` (an extrude `length` mm from the sketch plane along
 * `n`) is cut where it meets the face, and the piece from the sketch to the
 * face is kept. `offset` moves a flat face's stop past it (minus: short of it).
 */
export function upToFaceSolid(long: Shape3D, origin: Vec3, n: Vec3, length: number, face: Face, offset: number): Shape3D {
  const size = 4 * length + 10;
  let cutter = extendedFace(face, size);
  try {
    if (Math.abs(offset) > 1e-9) {
      if (face.geomType !== "PLANE") throw new Error("An offset only works with a flat face. Set the offset to 0, or pick a flat face.");
      // Past the face means further along the extrude.
      const fn = face.normalAt();
      const fnv: Vec3 = [fn.x, fn.y, fn.z];
      fn.delete();
      const s = Math.sign(dot(fnv, n)) || 1;
      cutter = cutter.translate([fnv[0] * offset * s, fnv[1] * offset * s, fnv[2] * offset * s]) as Face;
    }
    const split = splitWith(long, cutter);
    const kept = startingPieces(split, origin, n);
    split.delete();
    if (kept.length === 0) throw new Error("The face is level with the sketch, so there's nothing to extrude. Pick another face.");
    if (kept.some((k) => k.far > length - 1e-3)) {
      kept.forEach((k) => k.piece.delete());
      throw new Error("The face doesn't reach right across the sketch going that way, so the extrude would never stop. Flip the direction, pick a bigger face, or use Up to part.");
    }
    return joined(kept.map((k) => k.piece));
  } finally {
    cutter.delete();
  }
}

/** A shape cut up by a face (all its pieces, as one compound). */
function splitWith(shape: Shape3D, tool: Face): Shape3D {
  const oc = getOC() as any;
  const splitter = new oc.BRepAlgoAPI_Splitter();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  try {
    args.Append(shape.wrapped);
    tools.Append(tool.wrapped);
    splitter.SetArguments(args);
    splitter.SetTools(tools);
    splitter.Build();
    if (splitter.HasErrors()) throw new Error("Couldn't find where the extrude meets that face. Try another face.");
    return cast(splitter.Shape()) as Shape3D;
  } finally {
    splitter.delete();
    args.delete();
    tools.delete();
  }
}

/**
 * Up to the next face, or up to a part. `long` runs `length` mm from the
 * sketch plane along `n`. Where it starts in the open it stops on meeting
 * `parts` ("air": for adding, and for Up to part); where it starts inside them
 * it stops on coming out ("material": for cutting through the first wall).
 */
export function upToPartsSolid(long: Shape3D, origin: Vec3, n: Vec3, length: number, parts: Shape3D[], keep: "air" | "material", what: string): Shape3D {
  if (parts.length === 0) throw new Error("There are no parts for it to stop at yet. Use a set depth instead.");
  let rest: Shape3D = long.clone();
  let inside: Shape3D[] = [];
  try {
    if (keep === "air") {
      for (const p of parts) {
        const next = rest.cut(p);
        rest.delete();
        rest = next;
      }
    } else {
      inside = parts.map((p) => long.intersect(p) as Shape3D);
    }
    const kept = keep === "air" ? startingPieces(rest, origin, n) : inside.flatMap((s) => startingPieces(s, origin, n));
    if (kept.length === 0) {
      throw new Error(
        keep === "air"
          ? `The sketch starts inside ${what}, so there's nothing in between. Flip the direction, or use Remove to cut up to the next face.`
          : "Going that way the sketch starts in the open, so there's nothing to cut. Flip the direction, or sketch on the part's face.",
      );
    }
    if (kept.some((k) => k.far > length - 1e-3)) {
      kept.forEach((k) => k.piece.delete());
      throw new Error(`Some of the sketch never meets ${what} going that way, so the extrude would never stop. Flip the direction, move the sketch, or use a set depth.`);
    }
    return joined(kept.map((k) => k.piece));
  } finally {
    rest.delete();
    inside.forEach((s) => s.delete());
  }
}

/**
 * The stretches of solid material along a drill: a round bar of `radius`
 * from `at` going `length` mm along the unit direction `dir`, cut by the part.
 * Each stretch is [from, to] in mm along the drill, nearest first.
 */
export function materialRuns(part: Shape3D, at: Vec3, dir: Vec3, radius: number, length: number): [number, number][] {
  const bar = makeCylinder(radius, length, at, dir);
  let common: Shape3D | null = null;
  try {
    common = bar.intersect(part) as Shape3D;
    const runs: [number, number][] = [];
    for (const piece of solidsOf(common)) {
      try {
        runs.push(extentAlong(piece, at, dir));
      } finally {
        piece.delete();
      }
    }
    runs.sort((a, b) => a[0] - b[0]);
    // Pieces that overlap along the drill (side by side round it) make one stretch.
    const merged: [number, number][] = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], r[1]);
      else merged.push([Math.max(0, r[0]), r[1]]);
    }
    return merged;
  } finally {
    bar.delete();
    common?.delete();
  }
}

/* eslint-enable @typescript-eslint/no-explicit-any */
