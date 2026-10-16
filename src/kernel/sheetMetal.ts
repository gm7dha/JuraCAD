/**
 * Sheet metal solids: the walls and bends of a folded sheet (see
 * src/sheetmetal/sheet.ts) made into OpenCascade solids.
 */
import { basicFaceExtrusion, Vector, type Shape3D } from "replicad";
import { facesOf } from "./topology";

import type { Bend, P2, Wall } from "../sheetmetal/sheet";
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
export function fusePieces(pieces: Shape3D[]): Shape3D | null {
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

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Where a cut (a tool shape taken away from the part) goes through a wall,
 * as line pieces in the wall's own flat coordinates — for the flat pattern.
 * The cut is traced on the wall's 0 side: the outline of what it takes away there.
 */
export function wallCutLines(wall: Wall, thickness: number, tool: Shape3D): [P2, P2][] {
  const slab = wallSolid(wall, thickness);
  let inside: Shape3D | null = null;
  const out: [P2, P2][] = [];
  try {
    inside = slab.intersect(tool) as Shape3D;
    const { origin, u, v, n } = wall.frame;
    const local = (p: V3): P2 => {
      const d: V3 = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
      return [dot(d, u), dot(d, v)];
    };
    for (const face of facesOf(inside)) {
      try {
        if (face.geomType !== "PLANE") continue;
        const c = face.center;
        const centre: V3 = [c.x, c.y, c.z];
        c.delete();
        const nv = face.normalAt();
        const normal: V3 = [nv.x, nv.y, nv.z];
        nv.delete();
        // On the wall's 0 side: facing along n (either way) and level with its origin.
        if (Math.abs(dot(normal, n)) < 0.999 || Math.abs(dot([centre[0] - origin[0], centre[1] - origin[1], centre[2] - origin[2]], n)) > 1e-4) continue;
        const { lines, edgeGroups } = face.meshEdges({ tolerance: 0.01, angularTolerance: 0.1 });
        for (const g of edgeGroups) {
          for (let i = g.start; i + 1 < g.start + g.count; i += 2) {
            const a: V3 = [lines[3 * i], lines[3 * i + 1], lines[3 * i + 2]];
            const b: V3 = [lines[3 * i + 3], lines[3 * i + 4], lines[3 * i + 5]];
            out.push([local(a), local(b)]);
          }
        }
      } finally {
        face.delete();
      }
    }
  } finally {
    slab.delete();
    inside?.delete();
  }
  return out;
}
