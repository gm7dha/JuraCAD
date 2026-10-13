/**
 * Hole: drills holes at a sketch's points (and the centres of its circles),
 * straight into the part, at right angles to the sketch.
 */
import { assembleWire, makeFace, makeLine, revolution, type Shape3D } from "replicad";

import { holeProfile, type HoleSize } from "../model/holes";
import { planeFrame, toWorld, type SketchPlane } from "../sketch/planes";
import { holePositionsIn } from "../sketch/holePositions";
import type { SketchData } from "../sketch/types";
import { release } from "./extrude";

type V3 = [number, number, number];

/** The solid cut away by one hole whose top centre is `at`, drilling along `dir` (unit). */
function oneHole(at: V3, dir: V3, size: HoleSize): Shape3D {
  // Any direction at right angles to the drill, to draw the cross-section in.
  const helper: V3 = Math.abs(dir[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const e: V3 = [dir[1] * helper[2] - dir[2] * helper[1], dir[2] * helper[0] - dir[0] * helper[2], dir[0] * helper[1] - dir[1] * helper[0]];
  const el = Math.hypot(...e);
  const side: V3 = [e[0] / el, e[1] / el, e[2] / el];
  const P = ([r, t]: [number, number]): V3 => [at[0] + side[0] * r + dir[0] * t, at[1] + side[1] * r + dir[1] * t, at[2] + side[2] * r + dir[2] * t];
  const pts = holeProfile(size).map(P);
  const edges = pts.map((p, i) => makeLine(p, pts[(i + 1) % pts.length]));
  const wire = assembleWire(edges);
  const face = makeFace(wire);
  try {
    return revolution(face, at, dir, 360);
  } finally {
    release(face, wire, ...edges);
  }
}

/** All the holes a Hole feature drills, as one solid to cut away. */
export function holeTool(plane: SketchPlane, data: SketchData, size: HoleSize, flip: boolean): Shape3D {
  const positions = holePositionsIn(data);
  if (positions.length === 0) {
    throw new Error("The sketch has no points for holes. In the sketch, place points (P) where the holes go — or draw circles: their centres are used.");
  }
  const frame = planeFrame(plane);
  // Into the face by default (sketches on a face point outwards from it).
  const s = flip ? 1 : -1;
  const dir: V3 = [frame.n[0] * s, frame.n[1] * s, frame.n[2] * s];
  let result: Shape3D | null = null;
  for (const [x, y] of positions) {
    const hole = oneHole(toWorld(frame, x, y), dir, size);
    if (!result) result = hole;
    else {
      const merged: Shape3D = result.fuse(hole);
      release(result, hole);
      result = merged;
    }
  }
  return result!;
}
