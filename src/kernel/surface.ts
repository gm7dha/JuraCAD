/**
 * Surfaces: thin skins with no inside, made the same ways as solids
 * (extruding, revolving, sweeping or lofting a sketch) but from its curves —
 * open runs as well as closed shapes — and from edges of parts (Fill). A
 * surface part can be thickened into a solid, or several can be closed up
 * into one (Enclose). All with OpenCascade.
 */
import { basicFaceExtrusion, cast, getOC, loft, makeCompound, makeNonPlanarFace, makeSolid, revolution, Vector, type Edge, type Face, type Shape3D, type Wire, assembleWire, makeFace } from "replicad";

import { planeFrame, toWorld, type SketchPlane } from "../sketch/planes";
import { findChains, type Chain } from "../sketch/regions";
import { axisInSketch, type RevolveAxis } from "../sketch/axis";
import type { SketchData } from "../sketch/types";
import { release, segmentsWire } from "./extrude";
import { pathWire } from "./sweep";
import { edgesOf, facesOf } from "./topology";

type Vec3 = [number, number, number];

/** The sketch's runs of curves as wires (closed and open), with their plane's frame. */
function sketchWires(plane: SketchPlane, data: SketchData, what: string): { wires: Wire[]; chains: Chain[]; frame: ReturnType<typeof planeFrame> } {
  const { chains, problems } = findChains(data);
  if (chains.length === 0) {
    throw new Error(`The sketch has no lines or curves to ${what}.${problems.length ? ` ${problems.join(" ")}` : " Draw an outline — it needn't be closed for a surface."}`);
  }
  const frame = planeFrame(plane);
  return { wires: chains.map((c) => segmentsWire(c.segments, frame, 0)), chains, frame };
}

/** One shape from several (a compound when there's more than one), freeing the pieces. */
function joined(pieces: Shape3D[]): Shape3D {
  if (pieces.length === 1) return pieces[0];
  const out = makeCompound(pieces) as Shape3D;
  return out;
}

/** OpenCascade can sweep a wire the same way as a face; the result is a shell rather than a solid. */
const asFace = (w: Wire) => w as unknown as Face;

/** Each run of the sketch's curves pushed `depth` along the plane's normal: a skin with no ends. */
export function extrudeSurface(plane: SketchPlane, data: SketchData, opts: { depth: number; end: "blind" | "symmetric"; flip: boolean }): Shape3D {
  const { wires, frame } = sketchWires(plane, data, "extrude");
  const sign = opts.flip ? -1 : 1;
  const n = frame.n;
  const start = opts.end === "symmetric" ? (-opts.depth / 2) * sign : 0;
  const vector = new Vector([n[0] * opts.depth * sign, n[1] * opts.depth * sign, n[2] * opts.depth * sign]);
  try {
    const pieces = wires.map((w) => {
      const moved = start ? w.translate([n[0] * start, n[1] * start, n[2] * start]) : w;
      try {
        return basicFaceExtrusion(asFace(moved), vector);
      } finally {
        if (moved !== w) release(moved);
      }
    });
    return joined(pieces);
  } finally {
    release(vector, ...wires);
  }
}

/** Each run of the sketch's curves spun round the axis: a skin. */
export function revolveSurface(plane: SketchPlane, data: SketchData, opts: { axis: RevolveAxis; angle: number; flip: boolean }): Shape3D {
  if (!(opts.angle > 0) || opts.angle > 360) throw new Error("The angle must be more than 0° and at most 360°.");
  const axis = axisInSketch(data, opts.axis);
  if (!axis) throw new Error("The line to spin around isn't in the sketch any more. Pick another axis.");
  const { wires, chains, frame } = sketchWires(plane, data, "revolve");
  // Everything that's revolved must lie on one side of the axis, or the surface would pass through itself.
  const side = (p: [number, number]) => axis.dir[0] * (p[1] - axis.at[1]) - axis.dir[1] * (p[0] - axis.at[0]);
  const sides = chains.flatMap((c) =>
    c.segments.flatMap((sg) => {
      if ("from" in sg) return [side(sg.from), side(sg.to), ...("mid" in sg ? [side(sg.mid)] : [])];
      const r = sg.kind === "circle" ? sg.radius : Math.max(sg.rx, sg.ry);
      return [side(sg.center) + r, side(sg.center) - r];
    }),
  );
  if (sides.some((v) => v > 1e-6) && sides.some((v) => v < -1e-6)) {
    release(...wires);
    throw new Error("The outline crosses the line it spins around. Keep it all on one side of the axis.");
  }
  const origin = toWorld(frame, axis.at[0], axis.at[1]);
  const tip = toWorld(frame, axis.at[0] + axis.dir[0], axis.at[1] + axis.dir[1]);
  const sign = opts.flip ? -1 : 1;
  const direction: Vec3 = [(tip[0] - origin[0]) * sign, (tip[1] - origin[1]) * sign, (tip[2] - origin[2]) * sign];
  try {
    return joined(wires.map((w) => revolution(asFace(w), origin, direction, opts.angle)));
  } finally {
    release(...wires);
  }
}

/** Each run of the profile's curves carried along the path: a skin. */
export function sweepSurface(profilePlane: SketchPlane, profile: SketchData, pathPlane: SketchPlane, path: SketchData): Shape3D {
  const { wires } = sketchWires(profilePlane, profile, "sweep");
  const spine = pathWire(pathPlane, path);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const why = (e: unknown): string => {
    if (e instanceof Error) return e.message;
    try {
      const [, message] = oc.getExceptionMessage(e);
      return String(message);
    } catch {
      return String(e);
    }
  };
  try {
    return joined(
      wires.map((w) => {
        // OpenCascade's pipe shell carries any outline (open or closed) along the path as a skin.
        const pipe = new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);
        try {
          pipe.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner);
          // No correction: a single line has no plane to turn square to the path.
          pipe.Add(w.wrapped, false, false);
          pipe.Build();
          if (!pipe.IsDone()) throw new Error("the path and outline don't go together");
          return cast(pipe.Shape()) as Shape3D;
        } catch (e) {
          throw new Error(`Couldn't sweep the outline along that path (${why(e)}). Check it sits at the start of the path and is small enough for its bends.`);
        } finally {
          pipe.delete();
        }
      }),
    );
  } finally {
    release(spine, ...wires);
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** A smooth skin through one run of curves (open or closed) on each sketch, in order. */
export function loftSurface(sections: { plane: SketchPlane; data: SketchData; name: string }[]): Shape3D {
  if (sections.length < 2) throw new Error("Pick at least two sketches to loft between.");
  const wires: Wire[] = [];
  try {
    let closed: boolean | null = null;
    for (const s of sections) {
      const { chains } = findChains(s.data);
      if (chains.length !== 1) throw new Error(`${s.name} needs exactly one run of lines or curves to loft through (it has ${chains.length}).`);
      if (closed !== null && chains[0].closed !== closed) throw new Error("The sketches must all be closed shapes, or all open outlines.");
      closed = chains[0].closed;
      wires.push(segmentsWire(chains[0].segments, planeFrame(s.plane), 0));
    }
    try {
      return loft(wires, { ruled: false }, true);
    } catch {
      throw new Error("Couldn't loft between those outlines. Try sketches on parallel planes, or outlines with the same number of pieces.");
    }
  } finally {
    release(...wires);
  }
}

/**
 * A face spanning a closed ring of edges (picked on parts): flat if they lie
 * in a plane, otherwise a smooth patch (OpenCascade's filling).
 */
export function fillEdges(edges: Edge[]): Shape3D {
  if (edges.length === 0) throw new Error("Click the edges round the opening to fill.");
  let wire: Wire;
  try {
    wire = assembleWire(edges);
  } catch {
    throw new Error("The edges don't join up into one ring. Pick every edge round the opening, in any order.");
  }
  try {
    try {
      return makeFace(wire) as unknown as Shape3D;
    } catch {
      return makeNonPlanarFace(wire) as unknown as Shape3D;
    }
  } catch {
    throw new Error("Couldn't fit a surface to those edges. Pick a ring of edges that closes up.");
  } finally {
    release(wire);
  }
}

/**
 * A surface (skin) made into a solid `thickness` thick (on its outside; minus
 * for the other side), with OpenCascade's thick solid.
 */
export function thickenSurface(shape: Shape3D, thickness: number): Shape3D {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const faces = facesOf(shape);
  const none = new oc.NCollection_List_TopoDS_Shape();
  const builder = new oc.BRepOffsetAPI_MakeThickSolid();
  try {
    // Sharp corners where the thickened faces meet (as the surface's own corners are).
    builder.MakeThickSolidByJoin(shape.wrapped, none, thickness, 1e-4, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Intersection, false);
    if (!builder.IsDone()) throw new Error("Couldn't thicken this surface. Try a smaller thickness, or the other side.");
    return cast(builder.Shape()) as Shape3D;
  } finally {
    builder.delete();
    none.delete();
    faces.forEach((f) => f.delete());
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Surfaces sewn together and closed into one solid (they must meet at their edges all the way round). */
export function encloseSurfaces(shapes: Shape3D[]): Shape3D {
  const faces = shapes.flatMap((s) => facesOf(s));
  if (faces.length === 0) throw new Error("Pick the surfaces to close up into a solid.");
  try {
    return makeSolid(faces);
  } catch {
    throw new Error("These surfaces don't close up into a solid — there's a gap somewhere between them. Fill it first.");
  } finally {
    faces.forEach((f) => f.delete());
  }
}

/** A copy of a surface moved `distance` along its normal everywhere (minus for the other side). */
export function offsetSurface(shape: Shape3D, distance: number): Shape3D {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const builder = new oc.BRepOffsetAPI_MakeOffsetShape();
  try {
    builder.PerformByJoin(shape.wrapped, distance, 1e-4, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false);
    if (!builder.IsDone()) throw new Error("Couldn't offset this surface that far. Try a smaller distance.");
    return cast(builder.Shape()) as Shape3D;
  } finally {
    builder.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Faces and shells sewn into one shell (or whatever closes up), with OpenCascade's sewing. */
function sewn(shapes: Shape3D[]): Shape3D {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const sewing = new oc.BRepBuilderAPI_Sewing(1e-4, true, true, true, false);
  try {
    for (const s of shapes) sewing.Add(s.wrapped);
    sewing.Perform();
    return cast(sewing.SewedShape()) as Shape3D;
  } finally {
    sewing.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * A surface grown out past its free edges: each picked edge is pushed
 * `distance` further on, straight along the surface's tangent there, and the
 * new strip is joined on.
 */
export function extendSurface(shape: Shape3D, edges: Edge[], distance: number): Shape3D {
  if (!edges.length) throw new Error("Click the edges of the surface to extend.");
  if (!(distance > 0)) throw new Error("Distance: enter how far to extend.");
  const faces = facesOf(shape);
  const strips: Shape3D[] = [];
  try {
    for (const edge of edges) {
      const hash = edge.hashCode;
      // The face this edge belongs to.
      const face = faces.find((f) => {
        const mine = edgesOf(f);
        const has = mine.some((e) => e.hashCode === hash);
        mine.forEach((e) => e.delete());
        return has;
      });
      if (!face) throw new Error("A picked edge isn't on this surface. Pick its own edges.");
      const m = take(edge.pointAt(0.5));
      const t = take(edge.tangentAt(0.5));
      let n: Vec3;
      try {
        n = take(face.normalAt(m));
      } catch {
        throw new Error("Couldn't tell which way the surface goes at that edge.");
      }
      // Across the edge, in the surface, away from the face.
      let d = unit(cross(t, n));
      const c = take(face.center);
      if (d[0] * (m[0] - c[0]) + d[1] * (m[1] - c[1]) + d[2] * (m[2] - c[2]) < 0) d = [-d[0], -d[1], -d[2]];
      const v = new Vector([d[0] * distance, d[1] * distance, d[2] * distance]);
      try {
        strips.push(basicFaceExtrusion(edge as unknown as Face, v));
      } finally {
        v.delete();
      }
    }
    return sewn([shape, ...strips]);
  } finally {
    release(...faces, ...strips);
  }
}

const take = (v: { x: number; y: number; z: number; delete(): void }): Vec3 => {
  const out: Vec3 = [v.x, v.y, v.z];
  v.delete();
  return out;
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
