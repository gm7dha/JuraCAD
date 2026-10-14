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
  makeCircle,
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
import { findRegions, type Loop } from "../sketch/regions";
import type { SketchData } from "../sketch/types";
import { facesOf } from "./topology";

export interface ExtrudeOptions {
  depth: number;
  end: "blind" | "symmetric";
  flip: boolean;
  /** Taper of the sides in degrees (positive narrows away from the sketch). */
  draft?: number;
}

/** Free OpenCascade objects once we're done with them. */
export const release = (...items: { delete(): void }[]) => items.forEach((i) => i.delete());

/** The closed outline of one loop of the sketch, `offset` mm along the plane's normal. */
export function loopWire(loop: Loop, frame: PlaneFrame, offset: number): Wire {
  const P = ([x, y]: [number, number]) => toWorld(frame, x, y, offset);
  const edges: Edge[] = loop.segments.map((seg) => {
    switch (seg.kind) {
      case "line":
        return makeLine(P(seg.from), P(seg.to));
      case "arc":
        return makeThreePointArc(P(seg.from), P(seg.mid), P(seg.to));
      case "circle":
        return makeCircle(seg.radius, P(seg.center), frame.n);
    }
  });
  try {
    return assembleWire(edges);
  } finally {
    release(...edges);
  }
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
  const offset = opts.end === "symmetric" ? -opts.depth / 2 : 0;
  const n = frame.n;
  const vector: [number, number, number] = [n[0] * opts.depth * dirSign, n[1] * opts.depth * dirSign, n[2] * opts.depth * dirSign];
  const start = opts.end === "symmetric" ? offset * dirSign : 0;

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
  if (opts.draft && Math.abs(opts.draft) > 1e-9) {
    const tapered = draftSides(result!, frame, opts.flip ? -1 : 1, opts.draft);
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
  const all = facesOf(shape);
  const removed = all.filter((f) => picked.some((p) => p.isSame(f)));
  const kept = all.filter((f) => !removed.includes(f));
  const gone: Edge[] = removed.flatMap((f) => f.edges);
  const touches = (w: Wire) => w.edges.some((e) => gone.some((g) => g.isSame(e)));
  const rebuilt: Face[] = [];
  try {
    for (const f of kept) {
      const outer = f.outerWire();
      if (touches(outer)) {
        throw new Error("Only holes and bosses (faces in a loop of their own) can be deleted for now — a fillet or chamfer blends into the faces next to it.");
      }
      const inner = f.innerWires();
      const keep = inner.filter((w) => !touches(w));
      if (keep.length === inner.length) {
        rebuilt.push(f.clone());
        continue;
      }
      if (f.geomType !== "PLANE") throw new Error("The face around these is curved, so the gap can't be closed.");
      rebuilt.push(makeFace(outer, keep));
    }
    // (makeSolid takes care of the faces it's given.)
    return makeSolid(rebuilt) as Shape3D;
  } catch (e) {
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
