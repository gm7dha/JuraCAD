/**
 * Positions and turns for assemblies: a placement is a move (mm) plus a turn
 * (a unit quaternion, x y z w). Kept free of three.js so it can be tested.
 */
import type { Vec3 } from "../geometry/topoRef";

export type { Vec3 };
export type Quat = [number, number, number, number];

/** Where an instance sits: first turned about the origin, then moved. */
export interface Placement {
  position: Vec3;
  rotation: Quat;
}

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];
export const IDENTITY: Placement = { position: [0, 0, 0], rotation: IDENTITY_QUAT };

const DEG = Math.PI / 180;

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 1e-15 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  if (l < 1e-15) return IDENTITY_QUAT;
  // Keep w ≥ 0 so the same turn always has the same numbers.
  const s = q[3] < 0 ? -1 / l : 1 / l;
  return [q[0] * s, q[1] * s, q[2] * s, q[3] * s];
}

export const quatConjugate = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

export function quatFromAxisAngle(axis: Vec3, radians: number): Quat {
  const n = normalize(axis);
  const s = Math.sin(radians / 2);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(radians / 2)];
}

export function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // v' = v + 2w(q×v) + 2 q×(q×v)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** Turn of `rx`, `ry`, `rz` degrees about X, then Y, then Z (fixed axes). */
export function quatFromEulerDeg(rx: number, ry: number, rz: number): Quat {
  const qx = quatFromAxisAngle([1, 0, 0], rx * DEG);
  const qy = quatFromAxisAngle([0, 1, 0], ry * DEG);
  const qz = quatFromAxisAngle([0, 0, 1], rz * DEG);
  return quatNormalize(quatMultiply(qz, quatMultiply(qy, qx)));
}

/** The inverse of quatFromEulerDeg (angles in degrees, rounded to 1e-9). */
export function eulerDegFromQuat(q: Quat): Vec3 {
  // Rotation matrix entries for R = Rz·Ry·Rx.
  const [x, y, z, w] = quatNormalize(q);
  const r00 = 1 - 2 * (y * y + z * z);
  const r10 = 2 * (x * y + z * w);
  const r20 = 2 * (x * z - y * w);
  const r21 = 2 * (y * z + x * w);
  const r22 = 1 - 2 * (x * x + y * y);
  const ry = Math.asin(Math.max(-1, Math.min(1, -r20)));
  let rx: number;
  let rz: number;
  if (Math.abs(r20) < 0.9999999) {
    rx = Math.atan2(r21, r22);
    rz = Math.atan2(r10, r00);
  } else {
    // Straight up or down: only the sum/difference of X and Z turns matters.
    const r01 = 2 * (x * y - z * w);
    const r11 = 1 - 2 * (x * x + z * z);
    rx = 0;
    rz = Math.atan2(-r01, r11);
  }
  const tidy = (v: number) => {
    const d = Math.round((v / DEG) * 1e9) / 1e9;
    return d === 0 ? 0 : d; // no "-0"
  };
  return [tidy(rx), tidy(ry), tidy(rz)];
}

/** a then b: the placement of something placed by `b` inside something placed by `a`. */
export function compose(a: Placement, b: Placement): Placement {
  return { position: add(a.position, rotate(a.rotation, b.position)), rotation: quatNormalize(quatMultiply(a.rotation, b.rotation)) };
}

export function invert(a: Placement): Placement {
  const q = quatConjugate(a.rotation);
  return { position: scale(rotate(q, a.position), -1), rotation: quatNormalize(q) };
}

export function applyPlacement(p: Placement, v: Vec3): Vec3 {
  return add(p.position, rotate(p.rotation, v));
}

/** 4×4 matrix, column by column (the order three.js `Matrix4.fromArray` expects). */
export function placementMatrix(p: Placement): number[] {
  const [x, y, z, w] = quatNormalize(p.rotation);
  const [tx, ty, tz] = p.position;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    tx, ty, tz, 1,
  ];
}

/** Placements equal to within `tol` mm (and about the same in angle). */
export function samePlacement(a: Placement, b: Placement, tol = 1e-6): boolean {
  if (length(sub(a.position, b.position)) > tol) return false;
  const d = Math.abs(a.rotation[0] * b.rotation[0] + a.rotation[1] * b.rotation[1] + a.rotation[2] * b.rotation[2] + a.rotation[3] * b.rotation[3]);
  return d > 1 - tol;
}
