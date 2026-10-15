/**
 * Measuring maths that doesn't need the geometry engine: angles between
 * edges and faces, and the centre and radius of round edges.
 */
import type { EdgeRef, FaceRef, TopoRef, Vec3 } from "./topoRef";

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 | null => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null;
};

/** Centre and radius of the circle through three points (null if they're in a line). */
export function circleThrough3D(a: Vec3, b: Vec3, c: Vec3): { centre: Vec3; radius: number } | null {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const n = cross(ab, ac);
  const n2 = dot(n, n);
  if (n2 < 1e-18) return null;
  // Standard circumcentre formula.
  const t1 = cross(n, ab).map((v) => v * dot(ac, ac)) as Vec3;
  const t2 = cross(ac, n).map((v) => v * dot(ab, ab)) as Vec3;
  const offset = [(t1[0] + t2[0]) / (2 * n2), (t1[1] + t2[1]) / (2 * n2), (t1[2] + t2[2]) / (2 * n2)] as Vec3;
  const centre: Vec3 = [a[0] + offset[0], a[1] + offset[1], a[2] + offset[2]];
  return { centre, radius: len(offset) };
}

/** Direction of a straight edge, or the facing direction of a flat face (null otherwise). */
function directionOf(ref: TopoRef): { dir: Vec3; kind: "line" | "plane" } | null {
  if (ref.kind === "edge" && ref.curve === "LINE") {
    const d = unit(sub(ref.b, ref.a));
    return d ? { dir: d, kind: "line" } : null;
  }
  if (ref.kind === "face" && ref.surface === "PLANE") {
    const d = unit(ref.normal);
    return d ? { dir: d, kind: "plane" } : null;
  }
  return null;
}

/**
 * Angle between two straight edges, two flat faces, or an edge and a face
 * (degrees, 0–90), or null if it doesn't apply.
 */
export function angleBetween(a: TopoRef, b: TopoRef): number | null {
  const da = directionOf(a);
  const db = directionOf(b);
  if (!da || !db) return null;
  const c = Math.min(1, Math.abs(dot(da.dir, db.dir)));
  let deg = (Math.acos(c) * 180) / Math.PI;
  // A line against a plane: the angle to the surface, not to its facing direction.
  if (da.kind !== db.kind) deg = 90 - deg;
  return Math.round(deg * 1e6) / 1e6;
}

export interface MeasuredItem {
  /** "Straight edge", "Round edge", "Flat face"… */
  label: string;
  length?: number;
  area?: number;
  radius?: number;
  centre?: Vec3;
  /** Whole parts: how much space they take up (mm³). */
  volume?: number;
}

export interface Measurement {
  items: MeasuredItem[];
  /** Shortest distance between the two things picked. */
  distance?: number;
  /** For two round edges (e.g. hole rims): distance between their centres, and its X/Y/Z parts. */
  centreDistance?: { total: number; dx: number; dy: number; dz: number };
  angle?: number;
  /** Two whole parts: how much of them overlaps (mm³; 0 when they only touch or are apart). */
  overlap?: number;
}

/** Fill in what can be worked out without the geometry engine. */
export function describePick(ref: EdgeRef | FaceRef): MeasuredItem {
  if (ref.kind === "edge") {
    if (ref.curve === "LINE") return { label: "Straight edge" };
    if (ref.curve === "CIRCLE") return { label: len(sub(ref.a, ref.b)) < 1e-6 ? "Round edge" : "Curved edge" };
    return { label: "Curved edge" };
  }
  if (ref.surface === "PLANE") return { label: "Flat face" };
  if (ref.surface === "CYLINDRE") return { label: "Round face" };
  return { label: "Curved face" };
}

/** Distance between two centres, with its X, Y and Z parts. */
export function centreGap(a: Vec3, b: Vec3): { total: number; dx: number; dy: number; dz: number } {
  const d = sub(b, a);
  return { total: len(d), dx: Math.abs(d[0]), dy: Math.abs(d[1]), dz: Math.abs(d[2]) };
}
