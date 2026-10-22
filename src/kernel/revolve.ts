/**
 * Revolve: spins a sketch's closed shapes around a line to make round parts
 * (knobs, bottles, wheels, rings). Each closed region becomes a face that is
 * swept around the axis; holes are swept too and cut away.
 */
import { revolution, type Shape3D } from "replicad";

import { planeFrame, toWorld, type SketchPlane } from "../sketch/planes";
import { chosenRegions, type AreaPick } from "../sketch/areas";
import { axisInSketch, type RevolveAxis } from "../sketch/axis";
import type { SketchData } from "../sketch/types";
import { loopFace, release } from "./extrude";

export interface RevolveOptions {
  axis: RevolveAxis;
  /** Degrees, 0 < angle ≤ 360. */
  angle: number;
  flip: boolean;
  /** The sketch areas to use, as picked (missing: every closed shape). */
  areas?: AreaPick[];
}

type P2 = [number, number];
type V3 = [number, number, number];

/** The line a revolve spins around, in 3D: a point on it and its direction (null if the sketch line has gone). */
export function revolveAxis(plane: SketchPlane, data: SketchData, axisId: RevolveAxis): { origin: V3; direction: V3 } | null {
  const axis = axisInSketch(data, axisId);
  if (!axis) return null;
  const frame = planeFrame(plane);
  const origin = toWorld(frame, axis.at[0], axis.at[1]);
  const tip = toWorld(frame, axis.at[0] + axis.dir[0], axis.at[1] + axis.dir[1]);
  return { origin, direction: [tip[0] - origin[0], tip[1] - origin[1], tip[2] - origin[2]] };
}

/**
 * A revolved shape turned back by half its angle about its axis, so it goes
 * equally both ways from the sketch (Onshape's "symmetric"). `shape` is used up.
 */
export function centreRevolve(shape: Shape3D, plane: SketchPlane, data: SketchData, opts: RevolveOptions): Shape3D {
  if (opts.angle >= 360 - 1e-9) return shape;
  const axis = revolveAxis(plane, data, opts.axis);
  if (!axis) return shape;
  const sign = opts.flip ? -1 : 1;
  const d = axis.direction;
  return shape.rotate(-opts.angle / 2, axis.origin, [d[0] * sign, d[1] * sign, d[2] * sign]);
}

export function revolveSketch(plane: SketchPlane, data: SketchData, opts: RevolveOptions): Shape3D {
  if (!(opts.angle > 0) || opts.angle > 360) throw new Error("The angle must be more than 0° and at most 360°.");
  const axis = axisInSketch(data, opts.axis);
  if (!axis) throw new Error("The line to spin around isn't in the sketch any more. Pick another axis.");

  // Everything that's revolved must lie on one side of the axis, or the solid would pass through itself.
  const { regions, problems } = chosenRegions(data, opts.areas, "revolve");
  if (regions.length === 0) {
    throw new Error(
      `The sketch has no closed shapes to revolve.${problems.length ? ` ${problems.join(" ")}` : " Draw a closed outline beside the axis."}`,
    );
  }
  const side = (p: P2) => axis.dir[0] * (p[1] - axis.at[1]) - axis.dir[1] * (p[0] - axis.at[0]);
  let left = false;
  let right = false;
  for (const r of regions) {
    for (const p of r.outer.polygon) {
      const s = side(p);
      if (s > 1e-6) left = true;
      if (s < -1e-6) right = true;
    }
  }
  if (left && right) {
    throw new Error("The shape crosses the line it spins around. Keep the whole shape on one side of the axis.");
  }

  const frame = planeFrame(plane);
  const origin = toWorld(frame, axis.at[0], axis.at[1]);
  const tip = toWorld(frame, axis.at[0] + axis.dir[0], axis.at[1] + axis.dir[1]);
  const sign = opts.flip ? -1 : 1;
  const direction: [number, number, number] = [(tip[0] - origin[0]) * sign, (tip[1] - origin[1]) * sign, (tip[2] - origin[2]) * sign];

  const spin = (face: ReturnType<typeof loopFace>) => {
    try {
      return revolution(face, origin, direction, opts.angle);
    } finally {
      release(face);
    }
  };

  let result: Shape3D | null = null;
  for (const region of regions) {
    let solid = spin(loopFace(region.outer, frame, 0));
    for (const hole of region.holes) {
      const cutter = spin(loopFace(hole, frame, 0));
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
