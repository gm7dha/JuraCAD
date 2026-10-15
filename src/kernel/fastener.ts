/** Standard hex bolts, nuts and washers as solids (see model/fasteners.ts for the sizes). */
import { basicFaceExtrusion, makeCylinder, makePolygon, Vector, type Shape3D } from "replicad";

import { fastenerSize, hexagon, type FastenerKind } from "../model/fasteners";
import { release } from "./extrude";

/**
 * A fastener with its bearing face at (x, y, z): a bolt's head sits on top of
 * that point with the shank going down; a nut or washer sits on it. No thread
 * here (it's cut afterwards when asked for).
 */
export function fastenerSolid(kind: FastenerKind, sizeName: string, length: number, x: number, y: number, z: number, threaded = false): Shape3D {
  const s = fastenerSize(sizeName);
  if (!s) throw new Error("Choose a size (M3 to M12).");
  const hexPrism = (z0: number, height: number): Shape3D => {
    const face = makePolygon(hexagon(s.flats, x, y).map(([px, py]) => [px, py, z0] as [number, number, number]));
    const v = new Vector([0, 0, height]);
    try {
      return basicFaceExtrusion(face, v);
    } finally {
      release(v, face);
    }
  };
  if (kind === "bolt") {
    if (!(length > 0)) throw new Error("Enter the bolt's length (under the head).");
    const head = hexPrism(z, s.head);
    const shank = makeCylinder(s.d / 2, length, [x, y, z - length], [0, 0, 1]);
    const bolt: Shape3D = head.fuse(shank);
    release(head, shank);
    return bolt;
  }
  if (kind === "nut") {
    const body = hexPrism(z, s.nut);
    // Threaded: the hole is the thread's inner (minor) diameter, so the thread can be cut into its wall.
    const hole = makeCylinder(threaded ? s.d / 2 - 0.5413 * s.pitch : s.d / 2, s.nut + 2, [x, y, z - 1], [0, 0, 1]);
    const nut: Shape3D = body.cut(hole);
    release(body, hole);
    return nut;
  }
  const disc = makeCylinder(s.washerOd / 2, s.washerThickness, [x, y, z], [0, 0, 1]);
  const hole = makeCylinder(s.washerHole / 2, s.washerThickness + 2, [x, y, z - 1], [0, 0, 1]);
  const washer: Shape3D = disc.cut(hole);
  release(disc, hole);
  return washer;
}
