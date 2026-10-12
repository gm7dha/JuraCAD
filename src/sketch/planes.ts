/**
 * Where a sketch lives in 3D. A sketch plane is a frame: an origin and two
 * in-plane directions (u = sketch "right", v = sketch "up"); the normal n = u × v
 * points towards the viewer when you look straight at the sketch, and is the
 * default direction for Extrude.
 */

export type Vec3 = [number, number, number];

export type DefaultPlane = "Top" | "Front" | "Right";

export type SketchPlane =
  | { kind: "default"; name: DefaultPlane }
  /** A flat face of a part. The frame is captured when the sketch is created. */
  | { kind: "face"; origin: Vec3; u: Vec3; v: Vec3; label: string };

export interface PlaneFrame {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  n: Vec3;
}

/**
 * Onshape conventions (Z up): Top looks down from +Z, Front looks from −Y,
 * Right looks from +X. In each, sketch "right" and "up" match the screen.
 */
const DEFAULT_FRAMES: Record<DefaultPlane, PlaneFrame> = {
  Top: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
  Front: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] },
  Right: { origin: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1], n: [1, 0, 0] },
};

export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function planeFrame(plane: SketchPlane): PlaneFrame {
  if (plane.kind === "default") return DEFAULT_FRAMES[plane.name];
  return { origin: plane.origin, u: plane.u, v: plane.v, n: normalize(cross(plane.u, plane.v)) };
}

/** Sketch (u, v) → 3D point, optionally shifted along the normal. */
export function toWorld(frame: PlaneFrame, x: number, y: number, offset = 0): Vec3 {
  const { origin: o, u, v, n } = frame;
  return [
    o[0] + x * u[0] + y * v[0] + offset * n[0],
    o[1] + x * u[1] + y * v[1] + offset * n[1],
    o[2] + x * u[2] + y * v[2] + offset * n[2],
  ];
}

/** 3D point → sketch (u, v) (projected onto the plane). */
export function toSketch(frame: PlaneFrame, p: Vec3): [number, number] {
  const d: Vec3 = [p[0] - frame.origin[0], p[1] - frame.origin[1], p[2] - frame.origin[2]];
  return [dot(d, frame.u), dot(d, frame.v)];
}

/**
 * Build a sketch plane on a flat face, given its outward normal and a point on it.
 * The sketch origin is where the world origin projects onto the face, and
 * sketch "up" follows world Z where possible, so coordinates stay intuitive.
 */
export function planeOnFace(normal: Vec3, pointOnFace: Vec3, label: string): SketchPlane {
  const n = normalize(normal);
  // Pick "up": world Z projected onto the plane, or world Y for horizontal faces.
  const ref: Vec3 = Math.abs(n[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
  const vRaw: Vec3 = [ref[0] - dot(ref, n) * n[0], ref[1] - dot(ref, n) * n[1], ref[2] - dot(ref, n) * n[2]];
  const v = normalize(vRaw);
  const u = normalize(cross(v, n));
  const t = dot(pointOnFace, n);
  const origin: Vec3 = [t * n[0], t * n[1], t * n[2]];
  return { kind: "face", origin, u, v, label };
}

export function planeLabel(plane: SketchPlane): string {
  return plane.kind === "default" ? `${plane.name} plane` : plane.label;
}
