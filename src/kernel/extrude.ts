/**
 * Extrude: turns a sketch's closed shapes into a solid with OpenCascade.
 * Each closed region becomes a face that's swept along the sketch normal;
 * holes are swept too and cut away, islands are added back.
 */
import {
  assembleWire,
  basicFaceExtrusion,
  makeCircle,
  makeFace,
  makeLine,
  makeThreePointArc,
  Vector,
  type Edge,
  type Face,
  type Shape3D,
} from "replicad";

import { planeFrame, toWorld, type PlaneFrame, type SketchPlane } from "../sketch/planes";
import { findRegions, type Loop } from "../sketch/regions";
import type { SketchData } from "../sketch/types";

export interface ExtrudeOptions {
  depth: number;
  end: "blind" | "symmetric";
  flip: boolean;
}

/** Free OpenCascade objects once we're done with them. */
export const release = (...items: { delete(): void }[]) => items.forEach((i) => i.delete());

/** A flat face for one closed loop of the sketch, `offset` mm along the plane's normal. */
export function loopFace(loop: Loop, frame: PlaneFrame, offset: number): Face {
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
  const wire = assembleWire(edges);
  try {
    return makeFace(wire);
  } finally {
    release(wire, ...edges);
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
  return result!;
}
