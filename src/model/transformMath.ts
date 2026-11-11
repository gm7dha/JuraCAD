/**
 * Move / copy (Onshape's Transform), worked out as plain numbers (pure: no
 * OpenCascade, no three.js). The engine uses `transformMotion` to move a part
 * for every way of moving except the original one (turns then moves, about the
 * part's centre or the origin, along X/Y/Z), which it still does exactly as it
 * always has; the 3D view uses the same maths to draw the triad (the drag
 * handles) and to show a drag before the part is rebuilt.
 */
import type { Axis, TransformDef, TransformFrame, TransformMode } from "./types";

export type Vec3 = [number, number, number];

/** A rigid move: p → R·p + t (R is 3 × 3, row by row). */
export interface Rigid {
  r: number[];
  t: Vec3;
}

/** A frame: where it is and its three directions (unit length, square to each other). */
export interface Frame {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export function unit(a: Vec3): Vec3 | null {
  const l = length(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null;
}

export const IDENTITY: Rigid = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

export function applyVec(m: Rigid, v: Vec3): Vec3 {
  const r = m.r;
  return [r[0] * v[0] + r[1] * v[1] + r[2] * v[2], r[3] * v[0] + r[4] * v[1] + r[5] * v[2], r[6] * v[0] + r[7] * v[1] + r[8] * v[2]];
}

export function applyPoint(m: Rigid, p: Vec3): Vec3 {
  return add(applyVec(m, p), m.t);
}

/** `a` after `b` (b first, then a). */
export function compose(a: Rigid, b: Rigid): Rigid {
  const r: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(a.r[3 * i] * b.r[j] + a.r[3 * i + 1] * b.r[3 + j] + a.r[3 * i + 2] * b.r[6 + j]);
  return { r, t: applyPoint(a, b.t) };
}

export function invert(m: Rigid): Rigid {
  const r = m.r;
  const rt = [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]];
  const inv = { r: rt, t: [0, 0, 0] as Vec3 };
  return { r: rt, t: scale(applyVec(inv, m.t), -1) };
}

export function translation(v: Vec3): Rigid {
  return { r: [...IDENTITY.r], t: [...v] };
}

/** A turn of `degrees` about the line through `through` along `axis` (anticlockwise looking back down the axis). */
export function rotation(axis: Vec3, degrees: number, through: Vec3 = [0, 0, 0]): Rigid {
  const u = unit(axis);
  if (!u || Math.abs(degrees) < 1e-12) return { r: [...IDENTITY.r], t: [0, 0, 0] };
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const k = 1 - c;
  const [x, y, z] = u;
  const r = [c + x * x * k, x * y * k - z * s, x * z * k + y * s, y * x * k + z * s, c + y * y * k, y * z * k - x * s, z * x * k - y * s, z * y * k + x * s, c + z * z * k];
  const m = { r, t: [0, 0, 0] as Vec3 };
  return { r, t: sub(through, applyVec(m, through)) };
}

/** The same turn as an angle (degrees, 0…180) about an axis through the origin, then the move: p → turn(p) + t. */
export function toAxisAngle(m: Rigid): { axis: Vec3; degrees: number; t: Vec3 } {
  const r = m.r;
  const cos = Math.max(-1, Math.min(1, (r[0] + r[4] + r[8] - 1) / 2));
  const angle = Math.acos(cos);
  if (angle < 1e-12) return { axis: [0, 0, 1], degrees: 0, t: m.t };
  let axis: Vec3;
  if (Math.PI - angle > 1e-6) {
    axis = unit([r[7] - r[5], r[2] - r[6], r[3] - r[1]]) ?? [0, 0, 1];
  } else {
    // A half turn: the axis from the matrix's diagonal (R = 2·u·uᵀ − I).
    const xx = Math.sqrt(Math.max(0, (r[0] + 1) / 2));
    const yy = Math.sqrt(Math.max(0, (r[4] + 1) / 2));
    const zz = Math.sqrt(Math.max(0, (r[8] + 1) / 2));
    if (xx >= yy && xx >= zz) axis = [xx, r[1] / (2 * xx), r[2] / (2 * xx)];
    else if (yy >= zz) axis = [r[1] / (2 * yy), yy, r[5] / (2 * yy)];
    else axis = [r[2] / (2 * zz), r[5] / (2 * zz), zz];
    axis = unit(axis) ?? [0, 0, 1];
  }
  return { axis, degrees: (angle * 180) / Math.PI, t: m.t };
}

/** The 4 × 4 matrix (column by column, as three.js's Matrix4.fromArray reads it). */
export function toMatrix4(m: Rigid): number[] {
  const r = m.r;
  return [r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, m.t[0], m.t[1], m.t[2], 1];
}

/** A whole frame from where it is, its Z and (optionally) roughly which way its X goes: world X, else world Y. */
export function frameFromZ(origin: Vec3, z: Vec3, xHint?: Vec3): Frame {
  const zz = unit(z) ?? [0, 0, 1];
  const along = (h: Vec3) => unit(sub(h, scale(zz, dot(h, zz))));
  const x = (xHint && along(xHint)) ?? along([1, 0, 0]) ?? (along([0, 1, 0]) as Vec3);
  return { origin: [...origin], x, y: cross(zz, x), z: zz };
}

/** A saved frame (origin, X, Z) made whole (Y = Z × X, all tidied square). */
export function fullFrame(f: TransformFrame): Frame {
  return frameFromZ(f.origin, f.z, f.x);
}

/** The saved form of a frame. */
export function savedFrame(f: Frame): TransformFrame {
  const r = (v: Vec3): Vec3 => v.map((n) => Math.round(n * 1e9) / 1e9) as Vec3;
  return { origin: r(f.origin), x: r(f.x), z: r(f.z) };
}

/** A frame moved by `m`. */
export function movedFrame(m: Rigid, f: Frame): Frame {
  return { origin: applyPoint(m, f.origin), x: applyVec(m, f.x), y: applyVec(m, f.y), z: applyVec(m, f.z) };
}

/** Frame direction 0/1/2 (x/y/z). */
export function frameAxis(f: Frame, i: number): Vec3 {
  return i === 0 ? f.x : i === 1 ? f.y : f.z;
}

const AXIS_INDEX: Record<Axis, number> = { x: 0, y: 1, z: 2 };

/** The way of moving (missing = "free": turn and move, as before). */
export function transformMode(t: Pick<TransformDef, "mode"> | undefined): TransformMode {
  return t?.mode ?? "free";
}

/** True when the part is moved the original way (so the engine moves it exactly as before). */
export function isClassicTransform(t: TransformDef): boolean {
  return transformMode(t) === "free" && !t.triad;
}

/** The triad's frame before the move: where "Move triad" put it, else at the part's centre (or the origin) along X, Y and Z. */
export function baseFrame(t: TransformDef, centre: Vec3): Frame {
  if (t.triad) return fullFrame(t.triad);
  return { origin: [...centre], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
}

/** The line a "Translate by distance" goes along or a "Rotate" turns about. */
export function transformAxis(t: TransformDef, centre: Vec3): { dir: Vec3; through: Vec3 } {
  const f = baseFrame(t, centre);
  const a = t.along;
  if (a && "dir" in a) return { dir: unit(a.dir) ?? [0, 0, 1], through: [...a.through] };
  const i = AXIS_INDEX[a?.axis ?? (transformMode(t) === "distance" ? "x" : "z")];
  return { dir: frameAxis(f, i), through: f.origin };
}

/** The values a transform uses (missing ones are 0). */
export interface TransformValues {
  dx?: number;
  dy?: number;
  dz?: number;
  rx?: number;
  ry?: number;
  rz?: number;
  distance?: number;
  turn?: number;
}

const v0 = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) ? n : 0);

/**
 * How the part moves (`centre`: the middle of its box before it moves, or the
 * origin with "about the origin"), or a plain-English problem.
 */
export function transformMotion(t: TransformDef, values: TransformValues, centre: Vec3): Rigid | string {
  const mode = transformMode(t);
  const sign = t.flip ? -1 : 1;
  const f = baseFrame(t, centre);
  const moveIn = (frame: Frame) => add(add(scale(frame.x, v0(values.dx)), scale(frame.y, v0(values.dy))), scale(frame.z, v0(values.dz)));
  if (mode === "free") {
    // Turned about the triad's X, then Y, then Z (through its origin), then moved along its directions.
    let m = rotation(f.x, v0(values.rx), f.origin);
    m = compose(rotation(f.y, v0(values.ry), f.origin), m);
    m = compose(rotation(f.z, v0(values.rz), f.origin), m);
    return compose(translation(moveIn(f)), m);
  }
  if (mode === "xyz") return translation(moveIn(f));
  if (mode === "distance") {
    const { dir } = transformAxis(t, centre);
    return translation(scale(dir, sign * v0(values.distance)));
  }
  if (mode === "line") {
    if (!t.line) return "Click a straight edge: the part moves from one end of it to the other.";
    return translation(scale(sub(t.line.b, t.line.a), sign));
  }
  if (mode === "rotate") {
    const { dir, through } = transformAxis(t, centre);
    return rotation(dir, sign * v0(values.turn), through);
  }
  // Mate connectors: the first one is carried onto the second (Z onto Z, X onto X; Flip turns it over about X).
  if (!t.from) return "Click where to move from: a face, an edge or a corner on the part.";
  if (!t.to) return "Now click where to move it to: a face, an edge or a corner.";
  const a = fullFrame(t.from);
  const b = fullFrame(t.to);
  const toWorld = (fr: Frame): Rigid => ({ r: [fr.x[0], fr.y[0], fr.z[0], fr.x[1], fr.y[1], fr.z[1], fr.x[2], fr.y[2], fr.z[2]], t: [...fr.origin] });
  const flip: Rigid = t.flip ? { r: [1, 0, 0, 0, -1, 0, 0, 0, -1], t: [0, 0, 0] } : IDENTITY;
  return compose(toWorld(b), compose(flip, invert(toWorld(a))));
}

/** Is this move no move at all? */
export function isStill(m: Rigid): boolean {
  const r = m.r;
  return [r[0] - 1, r[1], r[2], r[3], r[4] - 1, r[5], r[6], r[7], r[8] - 1].every((n) => Math.abs(n) < 1e-12) && Math.abs(m.t[0]) + Math.abs(m.t[1]) + Math.abs(m.t[2]) < 1e-12;
}

/** The handles of the triad that can be dragged. */
export interface Triad {
  /** Where it's drawn (after the move so far). */
  frame: Frame;
  /** Arrows along these frame directions (0 = X, 1 = Y, 2 = Z). */
  arrows: number[];
  /** Plane squares, by the direction they're square to (2 = the XY square). */
  planes: number[];
  /** Rings about these directions. */
  rings: number[];
  /** The centre ball (drag in the screen's plane). */
  ball: boolean;
}

/** The triad to draw for an open Move / copy (null: this way of moving has nothing to drag). */
export function transformTriad(t: TransformDef, values: TransformValues, centre: Vec3): Triad | null {
  const mode = transformMode(t);
  const f = baseFrame(t, centre);
  const m = transformMotion(t, values, centre);
  if (typeof m === "string") return null;
  if (mode === "free" || mode === "xyz") {
    // It rides along with the move, but keeps its directions (the boxes measure along and about those).
    return { frame: { ...f, origin: applyPoint(m, f.origin) }, arrows: [0, 1, 2], planes: [2, 0, 1], rings: mode === "free" ? [0, 1, 2] : [], ball: true };
  }
  if (mode === "distance") {
    const { dir } = transformAxis(t, centre);
    const d = t.flip ? scale(dir, -1) : dir;
    return { frame: frameFromZ(applyPoint(m, f.origin), d), arrows: [2], planes: [], rings: [], ball: false };
  }
  if (mode === "rotate") {
    const { dir, through } = transformAxis(t, centre);
    // On the axis, level with the part's centre (or the triad).
    const at = add(through, scale(dir, dot(sub(f.origin, through), dir)));
    return { frame: frameFromZ(at, t.flip ? scale(dir, -1) : dir), arrows: [], planes: [], rings: [2], ball: false };
  }
  return null;
}

/** Which typed boxes a way of moving uses. */
export function transformKeys(t: Pick<TransformDef, "mode"> | undefined): string[] {
  switch (transformMode(t)) {
    case "free":
      return ["rx", "ry", "rz", "dx", "dy", "dz"];
    case "xyz":
      return ["dx", "dy", "dz"];
    case "distance":
      return ["distance"];
    case "rotate":
      return ["turn"];
    default:
      return [];
  }
}

/** The ways of moving, in the order the dialog lists them (Onshape's names, plus the free one). */
export const TRANSFORM_MODES: { mode: TransformMode; label: string; hint: string }[] = [
  { mode: "free", label: "Drag or type (move and turn)", hint: "Drag the arrows, squares, rings or ball on the part, or type the amounts." },
  { mode: "xyz", label: "Translate by XYZ", hint: "Move along the triad's X, Y and Z: drag its arrows, squares or ball, or type the amounts." },
  { mode: "distance", label: "Translate by distance", hint: "Move a set distance in one direction: X, Y or Z, or click an edge or flat face to go along (or straight out of)." },
  { mode: "line", label: "Translate by line", hint: "Click a straight edge: the part moves by that edge, from one end to the other." },
  { mode: "rotate", label: "Rotate", hint: "Turn about an axis: X, Y or Z through the triad, or click a straight edge, a round edge or a flat face." },
  { mode: "mates", label: "Transform by mate connectors", hint: "Click a spot on the part, then the spot to move it to: they line up (Flip turns it over)." },
];

/**
 * The free (or Translate by XYZ) values that make the same move with the triad in a new frame — so moving the triad
 * ("Move triad", or back to the centre) leaves the part where it is. Turns are about X, then Y, then Z of the new
 * frame through its origin; Translate by XYZ only has moves.
 */
export function valuesInFrame(t: TransformDef, values: TransformValues, centre: Vec3, frame: Frame): Required<Pick<TransformValues, "dx" | "dy" | "dz" | "rx" | "ry" | "rz">> {
  const m = transformMotion(t, values, centre);
  const motion = typeof m === "string" ? IDENTITY : m;
  // The turn as seen in the new frame's directions: Bᵀ·R·B.
  const b = [frame.x, frame.y, frame.z];
  const col = (j: number) => applyVec(motion, b[j]);
  const r = (i: number, j: number) => dot(b[i], col(j));
  const tidy = (n: number) => Math.round(n * 1e6) / 1e6 + 0;
  const turns = transformMode(t) === "xyz" ? { rx: 0, ry: 0, rz: 0 } : turnsOf([0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => r(i, j))));
  const shift = sub(applyPoint(motion, frame.origin), frame.origin);
  return { dx: tidy(dot(shift, frame.x)), dy: tidy(dot(shift, frame.y)), dz: tidy(dot(shift, frame.z)), rx: tidy(turns.rx), ry: tidy(turns.ry), rz: tidy(turns.rz) };
}

/** The turn made by turning `rx` about X, then `ry` about Y, then `rz` about Z (degrees; a 3 × 3 matrix, row by row). */
export function turnOf(rx: number, ry: number, rz: number): number[] {
  let m = rotation([1, 0, 0], rx);
  m = compose(rotation([0, 1, 0], ry), m);
  m = compose(rotation([0, 0, 1], rz), m);
  return m.r;
}

/** The X-then-Y-then-Z turns (degrees) that make the turn `r` (3 × 3, row by row). */
export function turnsOf(r: number[]): { rx: number; ry: number; rz: number } {
  // R = Rz(γ)·Ry(β)·Rx(α): r20 = −sin β, r21 = cos β sin α, r22 = cos β cos α, r10 = cos β sin γ, r00 = cos β cos γ.
  const beta = Math.asin(Math.max(-1, Math.min(1, -r[6])));
  let alpha: number;
  let gamma = 0;
  if (Math.cos(beta) > 1e-6) {
    alpha = Math.atan2(r[7], r[8]);
    gamma = Math.atan2(r[3], r[0]);
  } else alpha = Math.atan2(-r[5], r[4]);
  const deg = (a: number) => (a * 180) / Math.PI;
  return { rx: deg(alpha), ry: deg(beta), rz: deg(gamma) };
}
