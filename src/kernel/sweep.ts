/**
 * Sweep (a profile carried along a path) and loft (a smooth solid joining
 * outlines on different sketches), with OpenCascade.
 */
import { genericSweep, loft, makeLine, makeThreePointArc, type Edge, type Shape3D, type Wire, assembleWire } from "replicad";

import { planeFrame, toWorld, type SketchPlane } from "../sketch/planes";
import { findRegions, type Segment } from "../sketch/regions";
import { chainOf } from "../sketch/tools";
import { pointPos } from "../sketch/ops";
import type { SketchArc, SketchData, SketchLine } from "../sketch/types";
import { loopWire, release } from "./extrude";

/** The path a sweep follows: all the sketch's lines and arcs, joined end to end into one run. */
export function pathWire(plane: SketchPlane, data: SketchData): Wire {
  const curves = data.curves.filter((c): c is SketchLine | SketchArc => (c.type === "line" || c.type === "arc") && !c.construction);
  if (curves.length === 0) {
    throw new Error(data.curves.some((c) => c.type === "circle" && !c.construction) ? "A sweep path can't be a whole circle — use arcs." : "The path sketch has no lines or arcs.");
  }
  // Start from an open end if there is one.
  const ends = new Map<string, number>();
  for (const c of curves) for (const p of c.type === "line" ? [c.p1, c.p2] : [c.start, c.end]) ends.set(p, (ends.get(p) ?? 0) + 1);
  const start = curves.find((c) => (c.type === "line" ? [c.p1, c.p2] : [c.start, c.end]).some((p) => ends.get(p) === 1)) ?? curves[0];
  const { steps } = chainOf(data, start);
  if (steps.length !== curves.length) throw new Error("The path must be one connected run of lines and arcs, with no branches.");
  const frame = planeFrame(plane);
  const P = (id: string) => {
    const [x, y] = pointPos(data, id);
    return toWorld(frame, x, y);
  };
  const edges: Edge[] = steps.map((st) => {
    if (st.curve.type === "line") return makeLine(P(st.from), P(st.to));
    const [cx, cy] = pointPos(data, st.curve.center);
    const [sx, sy] = pointPos(data, st.curve.start);
    const [ex, ey] = pointPos(data, st.curve.end);
    const r = Math.hypot(sx - cx, sy - cy);
    const a0 = Math.atan2(sy - cy, sx - cx);
    let a1 = Math.atan2(ey - cy, ex - cx);
    if (a1 <= a0) a1 += 2 * Math.PI;
    const am = (a0 + a1) / 2;
    const mid = toWorld(frame, cx + r * Math.cos(am), cy + r * Math.sin(am));
    return makeThreePointArc(P(st.from), mid, P(st.to));
  });
  try {
    return assembleWire(edges);
  } finally {
    release(...edges);
  }
}

/** Carry each closed shape of the profile sketch along the path (holes stay holes). */
export function sweepSketch(profilePlane: SketchPlane, profile: SketchData, pathPlane: SketchPlane, path: SketchData): Shape3D {
  const { regions, problems } = findRegions(profile);
  if (regions.length === 0) throw new Error(`The profile sketch has no closed shapes.${problems.length ? ` ${problems.join(" ")}` : ""}`);
  const spine = pathWire(pathPlane, path);
  const frame = planeFrame(profilePlane);
  const sweepOne = (wire: Wire): Shape3D => {
    try {
      return genericSweep(wire, spine, { transitionMode: "round", forceProfileSpineOthogonality: false });
    } catch {
      throw new Error("Couldn't sweep the profile along that path. Check the profile sits at the start of the path and is small enough for its bends.");
    } finally {
      release(wire);
    }
  };
  try {
    let result: Shape3D | null = null;
    for (const region of regions) {
      let solid = sweepOne(loopWire(region.outer, frame, 0));
      for (const hole of region.holes) {
        const cutter = sweepOne(loopWire(hole, frame, 0));
        const next = solid.cut(cutter);
        release(solid, cutter);
        solid = next;
      }
      if (!result) result = solid;
      else {
        const merged: Shape3D = result.fuse(solid);
        release(result, solid);
        result = merged;
      }
    }
    return result!;
  } finally {
    release(spine);
  }
}

/** Which way a lone circle or ellipse starts from its centre (an ellipse at its long axis; a circle along the sketch's X). */
export function loopStart(segments: Segment[], frame: ReturnType<typeof planeFrame>): [number, number, number] | undefined {
  if (segments.length !== 1) return undefined;
  const s = segments[0];
  const a = s.kind === "ellipse" ? s.angle + (s.rx >= s.ry ? 0 : Math.PI / 2) : s.kind === "circle" ? 0 : null;
  if (a === null) return undefined;
  const { u, v } = frame;
  return [u[0] * Math.cos(a) + v[0] * Math.sin(a), u[1] * Math.cos(a) + v[1] * Math.sin(a), u[2] * Math.cos(a) + v[2] * Math.sin(a)];
}

/** A smooth solid passing through one closed shape on each of the sketches, in order. */
export function loftSketches(sections: { plane: SketchPlane; data: SketchData; name: string }[]): Shape3D {
  if (sections.length < 2) throw new Error("Pick at least two sketches to loft between.");
  const wires: Wire[] = [];
  try {
    let start: [number, number, number] | undefined;
    for (const s of sections) {
      const { regions } = findRegions(s.data);
      if (regions.length !== 1) throw new Error(`${s.name} needs exactly one closed shape to loft through (it has ${regions.length}).`);
      if (regions[0].holes.length) throw new Error(`${s.name}'s shape has a hole in it — lofts can only join plain outlines for now.`);
      const frame = planeFrame(s.plane);
      // Whole circles and ellipses all start the same way round, so the loft doesn't cut them in two to line them up.
      start ??= loopStart(regions[0].outer.segments, frame);
      wires.push(loopWire(regions[0].outer, frame, 0, start));
    }
    try {
      return loft(wires, { ruled: false });
    } catch {
      throw new Error("Couldn't loft between those shapes. Try sketches on parallel planes, or outlines with the same number of sides.");
    }
  } finally {
    release(...wires);
  }
}
