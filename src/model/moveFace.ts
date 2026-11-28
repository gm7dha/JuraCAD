/**
 * Move face (Onshape's Offset / Translate / Rotate types), the pure parts: reading the saved settings, the
 * direction or axis as the 3D view can draw it, and the maths that turns a flat face about an axis into the
 * "pivot line + lean" the engine's face-tilting tool (OpenCascade's draft) takes.
 *
 * A Move face without `moveFace` is the original one (flat faces pushed out along their normals) and builds
 * exactly as it always did.
 */
import { parsePick, type TopoPick } from "../geometry/topoRef";
import type { Axis, Feature, MoveFaceDef } from "./types";

type Vec3 = [number, number, number];

export type MoveFaceMode = MoveFaceDef["mode"];

/** The three types, as the dialog's segmented choice shows them (Onshape's names). */
export const MOVE_FACE_MODES: readonly { mode: MoveFaceMode; label: string; hint: string }[] = [
  { mode: "offset", label: "Offset", hint: "Each face moves straight out from itself (or in, with a minus distance) — round faces too: a hole's wall moved in by 0.2 makes the hole 0.4 mm bigger across" },
  { mode: "translate", label: "Translate", hint: "Faces slide along a direction you choose (X, Y, Z or a clicked edge or face); the faces round them stretch to meet. Pick a hole's wall (and its floor or countersink) or a boss's faces to move the whole hole or boss" },
  { mode: "rotate", label: "Rotate", hint: "Faces turn about an axis (a clicked straight edge, a hole's middle, or X, Y, Z) by an angle; the faces round them stretch to meet. A hole or boss turns as a whole about an axis square to its face" },
];

/** Which type a Move face is ("classic" = an older one with no type: flat faces pushed out). */
export function moveFaceMode(f: Pick<Feature, "moveFace">): MoveFaceMode | "classic" {
  return f.moveFace?.mode ?? "classic";
}

/** Saved settings read back carefully (null = not a Move face type, as in older files). `picking` isn't kept. */
export function parseMoveFace(v: unknown): MoveFaceDef | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.mode !== "offset" && o.mode !== "translate" && o.mode !== "rotate") return null;
  const out: MoveFaceDef = { mode: o.mode };
  if (o.axis === "x" || o.axis === "y" || o.axis === "z") out.axis = o.axis;
  const along = parsePick(o.along);
  if (along) out.along = along;
  if (o.flip === true) out.flip = true;
  return out;
}

/** The settings with another type chosen: the direction / axis is kept (it means the same for both). */
export function withMoveFaceMode(def: MoveFaceDef | undefined, mode: MoveFaceMode): MoveFaceDef {
  const { picking: _p, ...rest } = def ?? { mode };
  return { ...rest, mode };
}

/** The settings with the direction / axis set to X/Y/Z (a picked one is dropped) or to a picked edge/face. */
export function withMoveFaceAxis(def: MoveFaceDef, to: Axis | TopoPick): MoveFaceDef {
  const { along: _a, axis: _x, picking: _p, ...rest } = def;
  return typeof to === "string" ? { ...rest, axis: to } : { ...rest, along: to };
}

const AXES: Record<Axis, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
export const axisDir = (a: Axis | undefined): Vec3 => AXES[a ?? "z"];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 | null => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null;
};

/**
 * The direction (Translate) or axis (Rotate) as the view can tell from the settings alone — X/Y/Z, a picked
 * straight edge (from its first end to its second, as picked) or a picked flat face's normal; null for a round
 * edge or face (only the engine knows where its axis is). `through` is where the axis passes.
 */
export function moveFaceAxisNow(def: MoveFaceDef): { dir: Vec3; through: Vec3 } | null {
  const k = def.flip ? -1 : 1;
  const pick = def.along;
  if (!pick) return { dir: scale(axisDir(def.axis), k), through: [0, 0, 0] };
  if (pick.ref.kind === "edge") {
    if (pick.ref.curve !== "LINE") return null;
    const d = unit(sub(pick.ref.b, pick.ref.a));
    return d ? { dir: scale(d, k), through: pick.ref.a } : null;
  }
  if (pick.ref.surface !== "PLANE" || def.mode === "rotate") return null;
  const n = unit(pick.ref.normal);
  return n ? { dir: scale(n, k), through: pick.ref.center } : null;
}

/** `p` turned by `degrees` round the line through `o` along unit `d` (right-handed). */
export function turnPoint(p: Vec3, o: Vec3, d: Vec3, degrees: number): Vec3 {
  const a = (degrees * Math.PI) / 180;
  const v = sub(p, o);
  const c = Math.cos(a);
  const s = Math.sin(a);
  return add(o, add(add(scale(v, c), scale(cross(d, v), s)), scale(d, dot(d, v) * (1 - c))));
}

/**
 * A flat face (through `c`, outward normal `n`) turned by `degrees` about the axis (`through`, unit `dir`), as a
 * pivot: the line where the face's plane and its turned plane meet (`point`, direction `line`), the way the face
 * leans from there (`lean`: in the face, square to the line) and by how much (`tilt`, degrees, 0…180). The turned
 * plane's normal is n·cos(tilt) + lean·sin(tilt) — what OpenCascade's draft makes with `lean` as the pull direction,
 * `tilt` as the angle and the plane through `point` square to `lean` as the neutral plane. A string = why it can't.
 */
export function rotationPivot(c: Vec3, n: Vec3, through: Vec3, dir: Vec3, degrees: number): { point: Vec3; line: Vec3; lean: Vec3; tilt: number; normal: Vec3 } | string {
  if (Math.abs(degrees) < 1e-9) return "Enter an angle to turn the faces by.";
  const n2 = unit(turnPoint(n, [0, 0, 0], dir, degrees));
  const nn = unit(n);
  if (!n2 || !nn) return "That face can't be turned.";
  const line = unit(cross(nn, n2));
  if (!line) {
    return Math.abs(dot(nn, dir)) > 0.999
      ? "That axis points straight out of the face, so turning about it leaves the face where it is. Choose an axis lying along the face (an edge of it, say)."
      : "Turned that far the face points the same way again. Use a smaller angle.";
  }
  const c2 = turnPoint(c, through, dir, degrees);
  // The point on both planes nearest the world origin: p = α n + β n2 + γ line, with n·p = n·c and n2·p = n2·c2.
  const d1 = dot(nn, c);
  const d2 = dot(n2, c2);
  const k = dot(nn, n2);
  const det = 1 - k * k;
  const alpha = (d1 - k * d2) / det;
  const beta = (d2 - k * d1) / det;
  const point = add(scale(nn, alpha), scale(n2, beta));
  const lean = unit(sub(n2, scale(nn, k)))!;
  const tilt = (Math.acos(Math.max(-1, Math.min(1, k))) * 180) / Math.PI;
  return { point, line, lean, tilt, normal: n2 };
}

/**
 * Why a clicked edge or face can't be the direction (Translate) or axis (Rotate), or null when it can: Translate
 * takes a straight edge or a flat face (its normal); Rotate a straight edge, a round edge or a round face (its axis).
 */
export function moveFaceAxisProblem(mode: MoveFaceMode, pick: TopoPick): string | null {
  const ref = pick.ref;
  if (mode === "translate") {
    if (ref.kind === "edge") return ref.curve === "LINE" ? null : "That edge is curved. Click a straight edge, or a flat face (the faces move square to it).";
    return ref.surface === "PLANE" ? null : "That face is curved. Click a flat face (the faces move square to it) or a straight edge.";
  }
  if (mode === "rotate") {
    if (ref.kind === "edge") return ref.curve === "LINE" || ref.curve === "CIRCLE" ? null : "Click a straight edge, a round edge or a round face (such as a hole) for the axis.";
    return ref.surface === "CYLINDRE" ? null : "That face isn't round. Click a round face (such as a hole), a round edge or a straight edge for the axis.";
  }
  return null;
}
