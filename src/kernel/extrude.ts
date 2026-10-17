/**
 * Extrude: turns a sketch's closed shapes into a solid with OpenCascade.
 * Each closed region becomes a face that's swept along the sketch normal;
 * holes are swept too and cut away, islands are added back.
 */
import {
  asDir,
  cast,
  getOC,
  makePln,
  assembleWire,
  basicFaceExtrusion,
  makeBezierCurve,
  makeCircle,
  makeAx2,
  makeEllipse,
  makeEllipseArc,
  makeFace,
  makeLine,
  makeSolid,
  makeThreePointArc,
  Vector,
  type Edge,
  type Face,
  type Shape3D,
  type Wire,
} from "replicad";

import { planeFrame, toWorld, type PlaneFrame, type SketchPlane } from "../sketch/planes";
import { findRegions, type Loop, type Segment } from "../sketch/regions";
import type { SketchData } from "../sketch/types";
import { edgesOf as edgesOfShape, facesOf, wiresOf } from "./topology";

export interface ExtrudeOptions {
  depth: number;
  end: "blind" | "symmetric";
  flip: boolean;
  /** Taper of the sides in degrees (positive narrows away from the sketch). */
  draft?: number;
  /** One way (blind) only: also this far the other way from the sketch. */
  depth2?: number;
}

/** Free OpenCascade objects once we're done with them. */
export const release = (...items: { delete(): void }[]) => items.forEach((i) => i.delete());

/** The closed outline of one loop of the sketch, `offset` mm along the plane's normal. */
export function loopWire(loop: Loop, frame: PlaneFrame, offset: number, startDir?: Vec3): Wire {
  return segmentsWire(loop.segments, frame, offset, startDir);
}

type Vec3 = [number, number, number];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * A run of sketch pieces (closed or open) as one wire, `offset` mm along the
 * plane's normal. A whole circle or ellipse starts (where its one edge begins
 * and ends) towards `startDir` from its centre, when given — so the outlines of
 * a loft line up instead of being cut in two to match.
 */
export function segmentsWire(segments: Segment[], frame: PlaneFrame, offset: number, startDir?: Vec3): Wire {
  const P = ([x, y]: [number, number]) => toWorld(frame, x, y, offset);
  const n = frame.n;
  // The start direction laid flat in this sketch's plane (none if it points straight out of it).
  const flat = startDir ? ((): Vec3 | null => {
    const k = dot(startDir, n);
    const d: Vec3 = [startDir[0] - n[0] * k, startDir[1] - n[1] * k, startDir[2] - n[2] * k];
    const l = Math.hypot(...d);
    return l > 1e-6 ? [d[0] / l, d[1] / l, d[2] / l] : null;
  })() : null;
  const edges: Edge[] = segments.map((seg) => {
    switch (seg.kind) {
      case "line":
        return makeLine(P(seg.from), P(seg.to));
      case "arc":
        return makeThreePointArc(P(seg.from), P(seg.mid), P(seg.to));
      case "circle":
        return flat ? circleFrom(seg.radius, P(seg.center), n, flat) : makeCircle(seg.radius, P(seg.center), frame.n);
      case "bezier":
        return makeBezierCurve([P(seg.from), P(seg.c1), P(seg.c2), P(seg.to)]);
      case "ellipse": {
        // OpenCascade wants the longer axis first.
        const long = seg.rx >= seg.ry;
        const a = seg.angle + (long ? 0 : Math.PI / 2);
        const { u, v } = frame;
        const [ca, sa] = [Math.cos(a), Math.sin(a)];
        const dir: [number, number, number] = [u[0] * ca + v[0] * sa, u[1] * ca + v[1] * sa, u[2] * ca + v[2] * sa];
        const major = Math.max(seg.rx, seg.ry);
        const minor = Math.min(seg.rx, seg.ry);
        if (flat) {
          // The point on the ellipse in that direction from its centre: its angle round the ellipse, measured from the long axis.
          const y: Vec3 = [n[1] * dir[2] - n[2] * dir[1], n[2] * dir[0] - n[0] * dir[2], n[0] * dir[1] - n[1] * dir[0]];
          const phi = Math.atan2(dot(flat, y), dot(flat, dir));
          const t = Math.atan2(major * Math.sin(phi), minor * Math.cos(phi));
          return makeEllipseArc(major, minor, t, t + 2 * Math.PI, P(seg.center), frame.n, dir);
        }
        return makeEllipse(major, minor, P(seg.center), frame.n, dir);
      }
    }
  });
  try {
    return assembleWire(edges);
  } finally {
    release(...edges);
  }
}

/** A whole circle starting towards `xDir` from its centre. */
function circleFrom(radius: number, center: Vec3, normal: Vec3, xDir: Vec3): Edge {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const ax = makeAx2(center, normal, xDir) as any;
  const circ = new oc.gp_Circ(ax, radius);
  const maker = new oc.BRepBuilderAPI_MakeEdge(circ);
  try {
    return cast(maker.Edge()) as Edge;
  } finally {
    maker.delete();
    circ.delete();
    ax.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** A flat face for one closed loop of the sketch, `offset` mm along the plane's normal. */
export function loopFace(loop: Loop, frame: PlaneFrame, offset: number): Face {
  const wire = loopWire(loop, frame, offset);
  try {
    return makeFace(wire);
  } finally {
    release(wire);
  }
}

function loopPrism(loop: Loop, frame: PlaneFrame, offset: number, vector: [number, number, number]): Shape3D {
  const face = loopFace(loop, frame, offset);
  const v = new Vector(vector);
  try {
    return basicFaceExtrusion(face, v);
  } finally {
    release(v, face);
  }
}

export function extrudeSketch(plane: SketchPlane, data: SketchData, opts: ExtrudeOptions): Shape3D {
  const { regions, problems } = findRegions(data);
  if (regions.length === 0) {
    throw new Error(
      `The sketch has no closed shapes to extrude.${problems.length ? ` ${problems.join(" ")}` : " Draw a closed outline, such as a rectangle or circle."}`,
    );
  }
  const frame = planeFrame(plane);
  const dirSign = opts.flip ? -1 : 1;
  // How far it goes ahead of the sketch, and behind it (symmetric, or a second direction).
  const ahead = opts.end === "symmetric" ? opts.depth / 2 : opts.depth;
  const behind = opts.end === "symmetric" ? opts.depth / 2 : Math.max(0, opts.depth2 ?? 0);
  const drafted = !!opts.draft && Math.abs(opts.draft) > 1e-9;
  if (drafted && behind > 0) {
    // With a taper, each side narrows away from the sketch: two tapered halves, joined at the sketch.
    const front = extrudeSketch(plane, data, { depth: ahead, end: "blind", flip: opts.flip, draft: opts.draft });
    let back: Shape3D;
    try {
      back = extrudeSketch(plane, data, { depth: behind, end: "blind", flip: !opts.flip, draft: opts.draft });
    } catch (e) {
      release(front);
      throw e;
    }
    try {
      return front.fuse(back);
    } finally {
      release(front, back);
    }
  }
  const n = frame.n;
  const length = ahead + behind;
  const vector: [number, number, number] = [n[0] * length * dirSign, n[1] * length * dirSign, n[2] * length * dirSign];
  const start = -behind * dirSign;

  let result: Shape3D | null = null;
  for (const region of regions) {
    let solid = loopPrism(region.outer, frame, start, vector);
    for (const hole of region.holes) {
      const cutter = loopPrism(hole, frame, start, vector);
      const next = solid.cut(cutter);
      release(solid, cutter);
      solid = next;
    }
    if (!result) {
      result = solid;
    } else {
      const merged: Shape3D = result.fuse(solid);
      release(result, solid);
      result = merged;
    }
  }
  if (drafted) {
    const tapered = draftSides(result!, frame, opts.flip ? -1 : 1, opts.draft!);
    release(result!);
    return tapered;
  }
  return result!;
}

/**
 * Tilt every side of an extrusion by `angle` degrees, keeping the outline at
 * the sketch the same (OpenCascade's draft). The flat faces at either end stay put.
 */
export function draftSides(shape: Shape3D, frame: PlaneFrame, dirSign: number, angle: number): Shape3D {
  if (Math.abs(angle) >= 45) throw new Error("The draft angle must be less than 45°.");
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const pull: [number, number, number] = [frame.n[0] * dirSign, frame.n[1] * dirSign, frame.n[2] * dirSign];
  const dir = asDir(pull) as any;
  const plane = makePln(frame.origin, pull) as any;
  const builder = new oc.BRepOffsetAPI_DraftAngle(shape.wrapped);
  const faces = facesOf(shape);
  try {
    for (const f of faces) {
      if (f.geomType === "PLANE") {
        let n: [number, number, number] = [0, 0, 0];
        try {
          const v = f.normalAt();
          n = [v.x, v.y, v.z];
          v.delete();
        } catch {
          // no normal: treat as a side
        }
        if (Math.abs(n[0] * pull[0] + n[1] * pull[1] + n[2] * pull[2]) > 0.999) continue;
      }
      builder.Add(f.wrapped, dir, (angle * Math.PI) / 180, plane, true);
    }
    builder.Build();
    if (!builder.IsDone()) throw new Error("The draft couldn't be applied (try a smaller angle).");
    const out = cast(builder.Shape()) as Shape3D;
    return out;
  } finally {
    faces.forEach((f) => f.delete());
    builder.delete();
    dir.delete();
    plane.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Draft (taper) chosen faces of a part, Onshape's Draft feature: each face is
 * tilted by `angle` degrees about where it meets the neutral plane, so the
 * part pulls out of a mould along the plane's normal (`flip` pulls the other way).
 */
export function draftFaces(shape: Shape3D, faces: Face[], neutral: PlaneFrame, flip: boolean, angle: number): Shape3D {
  if (Math.abs(angle) >= 45) throw new Error("The draft angle must be less than 45°.");
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const s = flip ? -1 : 1;
  const pull: [number, number, number] = [neutral.n[0] * s, neutral.n[1] * s, neutral.n[2] * s];
  const dir = asDir(pull) as any;
  const plane = makePln(neutral.origin, pull) as any;
  const builder = new oc.BRepOffsetAPI_DraftAngle(shape.wrapped);
  try {
    for (const f of faces) builder.Add(f.wrapped, dir, (angle * Math.PI) / 180, plane, true);
    builder.Build();
    if (!builder.IsDone()) throw new Error("The draft couldn't be applied. Faces parallel to the neutral plane can't be drafted; try a smaller angle.");
    return cast(builder.Shape()) as Shape3D;
  } finally {
    builder.delete();
    dir.delete();
    plane.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Delete faces and let the part heal over the gap (OpenCascade's
 * defeaturing): removes fillets, chamfers, holes and bosses.
 */
export function deleteFaces(shape: Shape3D, faces: Face[]): Shape3D {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  if (!oc.BRepAlgoAPI_Defeaturing) return deleteLoopFaces(shape, faces);
  const df = new oc.BRepAlgoAPI_Defeaturing();
  try {
    df.SetShape(shape.wrapped);
    for (const f of faces) df.AddFaceToRemove(f.wrapped);
    try {
      df.Build();
    } catch {
      df.Build(new oc.Message_ProgressRange_1());
    }
    if (!df.IsDone()) throw new Error("Those faces can't be removed — the faces around them can't be stretched to close the gap.");
    return cast(df.Shape()) as Shape3D;
  } finally {
    df.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Delete faces that sit in their own edge loop — a hole's wall (and floor),
 * a boss's sides (and top) — by taking those loops out of the faces around
 * them and closing the part up again. (Fillets and chamfers blend into their
 * neighbours' outer edges, so they can't be removed this way.)
 */
function deleteLoopFaces(shape: Shape3D, picked: Face[]): Shape3D {
  let stage = "faces";
  const all = facesOf(shape);
  const removed = all.filter((f) => picked.some((p) => p.isSame(f)));
  const kept = all.filter((f) => !removed.includes(f));
  stage = "edges";
  const gone: Edge[] = removed.flatMap((f) => edgesOfShape(f));
  const touches = (w: Wire) => edgesOfShape(w).some((e) => gone.some((g) => g.isSame(e)));
  const rebuilt: Face[] = [];
  try {
    for (const f of kept) {
      stage = "outer wire";
      // The outer loop is the one with the biggest extent; the rest are holes in the face.
      const wires = wiresOf(f);
      const size = (w: Wire) => {
        const b = w.boundingBox;
        const [lo, hi] = b.bounds as [number[], number[]];
        b.delete();
        return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
      };
      const outer = wires.reduce((m, w) => (size(w) > size(m) ? w : m), wires[0]);
      stage = "touches";
      if (touches(outer)) {
        throw new Error("Only holes and bosses (faces in a loop of their own) can be deleted for now — a fillet or chamfer blends into the faces next to it.");
      }
      stage = "inner wires";
      const inner = wires.filter((w) => w !== outer);
      const keep = inner.filter((w) => !touches(w));
      if (keep.length === inner.length) {
        stage = "clone";
        rebuilt.push(f.clone());
        continue;
      }
      if (f.geomType !== "PLANE") throw new Error("The face around these is curved, so the gap can't be closed.");
      stage = "make face";
      rebuilt.push(makeFace(outer, keep));
    }
    stage = "make solid";
    // (makeSolid takes care of the faces it's given.)
    return makeSolid(rebuilt) as Shape3D;
  } catch (e) {
    if (e instanceof Error && /deleted/.test(e.message)) e.message = `${e.message} (at ${stage})`;
    rebuilt.forEach((f) => {
      try {
        f.delete();
      } catch {
        // already freed
      }
    });
    throw e;
  } finally {
    all.forEach((f) => {
      try {
        f.delete();
      } catch {
        // already freed
      }
    });
  }
}
