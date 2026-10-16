/** Standard metric bolts, screws, nuts and washers as solids (see model/fasteners.ts for the sizes). */
import { basicFaceExtrusion, makeBox, makeCylinder, makePolygon, makeSphere, Vector, type Shape3D } from "replicad";

import { fastenerSize, hasLength, hexagon, shankOf, type FastenerKind } from "../model/fasteners";
import { release } from "./extrude";

/** `a` with `b` fused on (or cut out), releasing both inputs. */
function fuse(a: Shape3D, b: Shape3D): Shape3D {
  const out: Shape3D = a.fuse(b);
  release(a, b);
  return out;
}
function cut(a: Shape3D, b: Shape3D): Shape3D {
  const out: Shape3D = a.cut(b);
  release(a, b);
  return out;
}

/**
 * A fastener with its reference point at (x, y, z): for bolts and screws the
 * middle of the face that sits on the part (the flush top for a countersunk
 * screw, the socket end for a grub screw), with the shank going down; a nut or
 * washer sits on it. No thread here (it's cut afterwards when asked for).
 */
export function fastenerSolid(kind: FastenerKind, sizeName: string, length: number, x: number, y: number, z: number, threaded = false): Shape3D {
  const s = fastenerSize(sizeName);
  if (!s) throw new Error("Choose a size (M3 to M12).");
  const hexPrism = (flats: number, z0: number, height: number): Shape3D => {
    const face = makePolygon(hexagon(flats, x, y).map(([px, py]) => [px, py, z0] as [number, number, number]));
    const v = new Vector([0, 0, height]);
    try {
      return basicFaceExtrusion(face, v);
    } finally {
      release(v, face);
    }
  };
  /** A hex key socket `flats` across, `depth` deep, down from `top`. */
  const socket = (flats: number, top: number, depth: number) => hexPrism(flats, top - depth, depth + 1);
  const cyl = (r: number, z0: number, h: number) => makeCylinder(r, h, [x, y, z0], [0, 0, 1]);

  if (hasLength(kind)) {
    if (!(length > 0)) throw new Error("Enter the screw's length.");
    const shank = shankOf(kind, s, length);
    if (!(shank.length > 0)) throw new Error(`A countersunk screw this size must be longer than its head (${s.countersunk.k} mm).`);
    const body = cyl(s.d / 2, shank.top - shank.length, shank.length + (kind === "grub" ? 0 : 0.01));
    switch (kind) {
      case "bolt":
        return fuse(hexPrism(s.flats, z, s.head), body);
      case "socketCap": {
        const h = s.socketCap;
        return cut(fuse(cyl(h.dk / 2, z, h.k), body), socket(h.s!, z + h.k, h.t!));
      }
      case "buttonHead": {
        // A dome: the cap of a sphere through the head's rim and top.
        const h = s.buttonHead;
        const r = h.dk / 2;
        const R = (r * r + h.k * h.k) / (2 * h.k);
        const sphere = makeSphere(R).translate([x, y, z + h.k - R]);
        const dome: Shape3D = sphere.intersect(cyl(r, z, h.k));
        sphere.delete();
        return cut(fuse(dome, body), socket(h.s!, z + h.k, h.t!));
      }
      case "countersunk": {
        // A 90° cone, wide end flush at z (its height is half the difference in diameters).
        const h = s.countersunk;
        // A cylinder chamfered 45° at the bottom down to the shank, trimmed flush at z.
        const tall = cyl(h.dk / 2, z - h.k, h.k + 1);
        const chamfered: Shape3D = tall.chamfer(h.k, (e) => e.inPlane("XY", z - h.k));
        tall.delete();
        const cone = cut(chamfered, makeBox([x - h.dk, y - h.dk, z], [x + h.dk, y + h.dk, z + 2]));
        return cut(fuse(cone, body), socket(h.s!, z, h.t!));
      }
      case "panHead": {
        // Rounded top edge, and a cross recess.
        const h = s.panHead;
        let head = cyl(h.dk / 2, z, h.k);
        try {
          const rounded = head.fillet(h.k * 0.4, (e) => e.inPlane("XY", z + h.k));
          head.delete();
          head = rounded;
        } catch {
          // A plain flat head if the rounding fails.
        }
        const arm = h.dk * 0.45;
        const w = Math.max(0.6, s.d * 0.18);
        const depth = h.k * 0.6;
        const a = makeBox([x - arm / 2, y - w / 2, z + h.k - depth], [x + arm / 2, y + w / 2, z + h.k + 1]);
        const b = makeBox([x - w / 2, y - arm / 2, z + h.k - depth], [x + w / 2, y + arm / 2, z + h.k + 1]);
        return cut(fuse(head, body), fuse(a, b));
      }
      case "grub":
        return cut(body, socket(s.grub.s, z, s.grub.t));
    }
  }
  if (kind === "nut") {
    const body = hexPrism(s.flats, z, s.nut);
    // Threaded: the hole is the thread's inner (minor) diameter, so the thread can be cut into its wall.
    return cut(body, cyl(threaded ? s.d / 2 - 0.5413 * s.pitch : s.d / 2, z - 1, s.nut + 2));
  }
  return cut(cyl(s.washerOd / 2, z, s.washerThickness), cyl(s.washerHole / 2, z - 1, s.washerThickness + 2));
}
