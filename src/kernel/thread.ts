/**
 * Screw threads: a 60° (ISO metric) groove swept along a helix round a round
 * face, cut into a rod (external thread, for bolts) or into the wall of a
 * hole (internal thread, for nuts).
 */
import { assembleWire, genericSweep, makeHelix, makeLine, type Shape3D, type Wire } from "replicad";

import { release } from "./extrude";
import type { Cylinder } from "./textSolid";

type Vec3 = [number, number, number];

/** ISO metric coarse pitches by nominal diameter (mm). */
export const ISO_COARSE: [number, number][] = [
  [2, 0.4],
  [2.5, 0.45],
  [3, 0.5],
  [4, 0.7],
  [5, 0.8],
  [6, 1],
  [8, 1.25],
  [10, 1.5],
  [12, 1.75],
  [14, 2],
  [16, 2],
  [20, 2.5],
  [24, 3],
];

/** How deep the groove goes, as a fraction of the pitch (ISO: 0.6134 P for bolts, 0.5413 P for nuts). */
export const threadDepth = (pitch: number, external: boolean) => pitch * (external ? 0.6134 : 0.5413);

/**
 * The groove to cut: from `from` to `to` (distances along the axis from the
 * cylinder's origin), a 60° V of the given pitch, pointing into the
 * material — towards the axis on a rod, away from it in a hole.
 */
export function threadGroove(cyl: Cylinder, from: number, to: number, pitch: number, external: boolean): Shape3D {
  if (!(pitch > 0)) throw new Error("Enter a pitch (the distance between threads).");
  const R = cyl.radius;
  const depth = threadDepth(pitch, external);
  if (external && depth >= R * 0.9) throw new Error("That pitch is too coarse for such a thin rod — choose a smaller size.");
  const k = cyl.axis;
  const at = (h: number): Vec3 => [cyl.origin[0] + k[0] * h, cyl.origin[1] + k[1] * h, cyl.origin[2] + k[2] * h];
  const base = at(from);
  const height = to - from;
  if (height < pitch) throw new Error("The thread needs to be at least one pitch long.");
  const helix = makeHelix(pitch, height, R, base, k);
  const sp = helix.startPoint;
  const start: Vec3 = [sp.x, sp.y, sp.z];
  sp.delete();
  const out = [start[0] - base[0], start[1] - base[1], start[2] - base[2]];
  const len = Math.hypot(out[0], out[1], out[2]) || 1;
  const radial: Vec3 = [out[0] / len, out[1] / len, out[2] / len];
  // The V: its tip `depth` into the material, its wide end a little out in the air so the cut is clean.
  const tan30 = Math.tan(Math.PI / 6);
  const air = 0.1 * pitch;
  const half = (depth + air) * tan30;
  const tipR = external ? R - depth : R + depth;
  const mouthR = external ? R + air : R - air;
  const P = (r: number, z: number): Vec3 => [base[0] + radial[0] * r + k[0] * z, base[1] + radial[1] * r + k[1] * z, base[2] + radial[2] * r + k[2] * z];
  const pts = [P(mouthR, -half), P(mouthR, half), P(tipR, 0)];
  const edges = pts.map((p, i) => makeLine(p, pts[(i + 1) % 3]));
  let profile: Wire | null = null;
  try {
    profile = assembleWire(edges);
    return genericSweep(profile, helix, { frenet: true }) as Shape3D;
  } finally {
    release(...edges, helix, ...(profile ? [profile] : []));
  }
}
