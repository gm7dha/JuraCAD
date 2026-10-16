/**
 * Sheet metal solids: the walls and bends of a folded sheet (see
 * src/sheetmetal/sheet.ts) made into OpenCascade solids.
 */
import { basicFaceExtrusion, Vector, type Shape3D } from "replicad";

import type { Bend, Wall } from "../sheetmetal/sheet";
import type { Loop, Segment } from "../sketch/regions";
import { loopFace, release } from "./extrude";

type V3 = [number, number, number];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const loop = (segments: Segment[]): Loop => ({ segments, polygon: [], area: 0 });

/** One outline (with holes) on a frame, pushed `vector` along. */
function prism(outer: Segment[], holes: Segment[][], frame: { origin: V3; u: V3; v: V3; n: V3 }, vector: V3): Shape3D {
  const make = (segs: Segment[]) => {
    const face = loopFace(loop(segs), frame, 0);
    const v = new Vector(vector);
    try {
      return basicFaceExtrusion(face, v) as Shape3D;
    } finally {
      release(v, face);
    }
  };
  let solid = make(outer);
  for (const h of holes) {
    const cutter = make(h);
    const next = solid.cut(cutter);
    release(solid, cutter);
    solid = next;
  }
  return solid;
}

/** A wall as a solid: its outline, the sheet's thickness thick. */
export function wallSolid(wall: Wall, thickness: number): Shape3D {
  const n = wall.frame.n;
  return prism(wall.outline, wall.holes, wall.frame, [n[0] * thickness, n[1] * thickness, n[2] * thickness]);
}

/** A bend as a solid: its curved cross-section swept along the edge. */
export function bendSolid(bend: Bend): Shape3D {
  const frame = { origin: bend.start, u: bend.out, v: bend.up, n: cross(bend.out, bend.up) };
  const a = bend.along;
  return prism(bend.profile, [], frame, [a[0] * bend.length, a[1] * bend.length, a[2] * bend.length]);
}

/** Join solids into one (the pieces are freed). */
export function fuseAll(pieces: Shape3D[]): Shape3D | null {
  let out: Shape3D | null = null;
  for (const p of pieces) {
    if (!out) {
      out = p;
      continue;
    }
    const next: Shape3D = out.fuse(p);
    release(out, p);
    out = next;
  }
  return out;
}
