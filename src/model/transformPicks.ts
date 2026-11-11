/**
 * What a click in the 3D view gives Move / copy (pure): a spot to put the
 * triad or a mate connector on (Onshape's implicit mate connectors: a flat
 * face's middle, an edge's ends and middle, a round edge's centre), a
 * direction or axis, or a straight edge's ends.
 */
import { circleThrough3D } from "../geometry/measureMath";
import type { EdgeRef, FaceRef } from "../geometry/topoRef";
import type { PlaneFrame } from "../sketch/planes";
import { applyPoint, applyVec, cross, dot, frameFromZ, length, scale, sub, unit, type Frame, type Rigid, type Vec3 } from "./transformMath";

/** What was clicked. */
export type SpotSource =
  | { kind: "face"; ref: FaceRef; at?: Vec3 }
  /** `points`: points along the edge (from the 3D view's lines), to tell a round edge's centre. */
  | { kind: "edge"; ref: EdgeRef; at?: Vec3; points: Vec3[] }
  /** One of Top/Front/Right or a Plane feature. */
  | { kind: "plane"; frame: PlaneFrame };

const dist = (a: Vec3, b: Vec3) => length(sub(a, b));

/** A round edge's centre and the way it faces, when the edge is (part of) a circle. */
export function circleOf(points: Vec3[]): { centre: Vec3; normal: Vec3; radius: number } | null {
  if (points.length < 3) return null;
  const a = points[0];
  const b = points[Math.floor(points.length / 3)];
  const c = points[Math.floor((2 * points.length) / 3)];
  const circle = circleThrough3D(a, b, c);
  const normal = unit(cross(sub(b, a), sub(c, a)));
  if (!circle || !normal || !(circle.radius > 1e-6)) return null;
  // Every point on it (within 1%) and in its plane.
  const ok = points.every((p) => Math.abs(dist(p, circle.centre) - circle.radius) <= 0.01 * circle.radius + 1e-4 && Math.abs(dot(sub(p, circle.centre), normal)) <= 0.01 * circle.radius + 1e-4);
  return ok ? { centre: circle.centre, normal, radius: circle.radius } : null;
}

/** The end (or middle) of a straight edge nearest the click. */
function nearestOnEdge(ref: EdgeRef, at: Vec3 | undefined): Vec3 {
  if (!at) return ref.mid;
  return [ref.a, ref.mid, ref.b].reduce((best, p) => (dist(p, at) < dist(best, at) ? p : best));
}

/**
 * A spot for the triad or a mate connector: on a flat face, its middle (Z out of it); on an edge, its end or middle
 * nearest the click (Z along it), or a round edge's centre (Z square to it); on a plane, `near` brought onto it.
 */
export function spotFrame(src: SpotSource, near: Vec3 = [0, 0, 0]): Frame | string {
  if (src.kind === "plane") {
    const f = src.frame;
    const at = sub(near, scale(f.n, dot(sub(near, f.origin), f.n)));
    return frameFromZ(at, f.n, f.u);
  }
  if (src.kind === "face") {
    if (src.ref.surface !== "PLANE") return "That face is curved. Click a flat face, an edge or a corner (for a round hole, click its round edge).";
    return frameFromZ(src.ref.center, src.ref.normal);
  }
  const circle = src.ref.curve === "LINE" ? null : circleOf(src.points);
  if (circle) return frameFromZ(circle.centre, circle.normal);
  const along = unit(sub(src.ref.b, src.ref.a));
  if (!along) return frameFromZ(src.ref.mid, [0, 0, 1]);
  return frameFromZ(nearestOnEdge(src.ref, src.at), along);
}

/** A direction (Translate by distance) or axis (Rotate): along a straight edge, out of a flat face or plane, or round a round edge. */
export function directionOf(src: SpotSource): { dir: Vec3; through: Vec3 } | string {
  if (src.kind === "plane") return { dir: src.frame.n, through: src.frame.origin };
  if (src.kind === "face") {
    if (src.ref.surface !== "PLANE") return "That face is curved. Click a straight edge, a round edge or a flat face.";
    return { dir: unit(src.ref.normal) ?? [0, 0, 1], through: src.ref.center };
  }
  if (src.ref.curve === "LINE") {
    const dir = unit(sub(src.ref.b, src.ref.a));
    if (dir) return { dir, through: src.ref.a };
  }
  const circle = circleOf(src.points);
  if (circle) return { dir: circle.normal, through: circle.centre };
  return "That edge is neither straight nor round. Click a straight edge, a round edge or a flat face.";
}

/** Translate by line: a straight edge's ends (from the end nearer the click to the other one). */
export function lineOf(src: SpotSource): { a: Vec3; b: Vec3 } | string {
  if (src.kind !== "edge" || src.ref.curve !== "LINE") return "Click a straight edge: the part moves by it, from the end nearer where you clicked to the other end.";
  const { a, b } = src.ref;
  if (src.at && dist(src.at, b) < dist(src.at, a)) return { a: [...b], b: [...a] };
  return { a: [...a], b: [...b] };
}

/** A spot (frame) carried by a move: where it was before the move, when it was clicked on the moved part. */
export function frameBy(m: Rigid, f: Frame): Frame {
  return { origin: applyPoint(m, f.origin), x: applyVec(m, f.x), y: applyVec(m, f.y), z: applyVec(m, f.z) };
}

export function directionBy(m: Rigid, d: { dir: Vec3; through: Vec3 }): { dir: Vec3; through: Vec3 } {
  return { dir: applyVec(m, d.dir), through: applyPoint(m, d.through) };
}

export function lineBy(m: Rigid, l: { a: Vec3; b: Vec3 }): { a: Vec3; b: Vec3 } {
  return { a: applyPoint(m, l.a), b: applyPoint(m, l.b) };
}

/** Tidied for saving (to a billionth). */
export function tidyVec(v: Vec3): Vec3 {
  return v.map((n) => Math.round(n * 1e9) / 1e9 + 0) as Vec3;
}
