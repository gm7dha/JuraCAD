/**
 * Sweep's further choices, as Onshape's Sweep: how the profile is carried (Profile control: None, Keep profile
 * orientation, Lock profile direction), a twist given as an angle, a number of turns or a pitch (with Opposite
 * direction), a scale (the size at the end of the path, as a share of the size at the profile), and a flat face of a
 * part as the profile. Pure: what the dialog, the file reader, the engine and Claude's tools share.
 */
import type { TopoPick } from "../geometry/topoRef";
import type { Feature, GeomPick, SweepOptions } from "./types";

/** Onshape's Profile control choices. */
export type ProfileControl = "none" | "keep" | "direction" | "faces";

export const PROFILE_CONTROLS: { id: ProfileControl; label: string; hint: string }[] = [
  { id: "none", label: "None", hint: "The shape turns to follow the path's bends (it can also twist)." },
  { id: "keep", label: "Keep profile orientation", hint: "The shape doesn't tilt to follow the path: it stays parallel to the plane it was drawn on all the way along." },
  { id: "direction", label: "Lock profile direction", hint: "The shape keeps the same angle to a direction you click (a line, an edge, a flat face's normal or a mate connector's Z) as it follows the path." },
  { id: "faces", label: "Lock profile faces", hint: "The shape keeps the same angle to faces of a part you click as it follows the path — e.g. a lip kept square to a box's sides. The path must be edges of those faces (choose Part edges as the path)." },
];

/** How a twist is given. */
export type TwistBy = "angle" | "turns" | "pitch";

export const TWIST_BY: { id: TwistBy; label: string }[] = [
  { id: "angle", label: "Angle" },
  { id: "turns", label: "Turns" },
  { id: "pitch", label: "Pitch" },
];

export function profileControlOf(f: Pick<Feature, "sweepControl">): ProfileControl {
  if (f.sweepControl?.lockOrientation) return "keep";
  if (f.sweepControl?.lockFaces || f.sweepControl?.picking === "lockFaces") return "faces";
  if (f.sweepControl?.lockDirection) return "direction";
  return "none";
}

/** Drops empty choices, so a sweep with none of them saves exactly as before (no `sweepControl` at all). */
export function tidySweepControl(c: SweepOptions | undefined): SweepOptions | undefined {
  if (!c) return undefined;
  const out: SweepOptions = {};
  if (c.lockOrientation) out.lockOrientation = true;
  if (c.lockDirection) out.lockDirection = c.lockDirection;
  if (c.twistBy) out.twistBy = c.twistBy;
  if (c.opposite) out.opposite = true;
  if (c.scaled) out.scaled = true;
  if (c.face) out.face = c.face;
  if (c.lockFaces?.length) out.lockFaces = c.lockFaces;
  if (c.picking) out.picking = c.picking;
  return Object.keys(out).length ? out : undefined;
}

/** The sweep with another profile control (a direction already clicked is kept for switching back; "direction" with none clicked asks for a click). */
export function withProfileControl(f: Pick<Feature, "sweepControl">, choice: ProfileControl): SweepOptions | undefined {
  const c = { ...(f.sweepControl ?? {}) };
  delete c.lockOrientation;
  if (choice === "keep") {
    c.lockOrientation = true;
    delete c.lockDirection;
  }
  if (choice === "none" || choice === "faces") delete c.lockDirection;
  if (choice !== "faces") delete c.lockFaces;
  if (choice === "direction" && !c.lockDirection) c.picking = "direction";
  else if (choice === "faces" && !c.lockFaces) c.picking = "lockFaces";
  else if (c.picking === "direction" || c.picking === "lockFaces") delete c.picking;
  return tidySweepControl(c);
}

/** How the twist is given now. */
export const twistByOf = (f: Pick<Feature, "sweepControl">): TwistBy => f.sweepControl?.twistBy ?? "angle";

/** Does the profile turn with the path (so a twist can be given)? */
export const canTwist = (f: Pick<Feature, "sweepControl">) => profileControlOf(f) === "none";

/**
 * The twist in degrees: an angle as typed, turns × 360, or 360 × the path's length / pitch; Opposite direction turns
 * it the other way. `length` (mm) is only asked for with a pitch.
 */
export function twistDegrees(by: TwistBy, value: number, opposite: boolean, length: () => number): number {
  const sign = opposite ? -1 : 1;
  if (by === "turns") return sign * 360 * value;
  if (by === "pitch") {
    if (!(Math.abs(value) > 1e-9)) throw new Error("The twist's pitch (how far along the path one whole turn takes) must be more than 0.");
    return (sign * 360 * length()) / value;
  }
  return sign * value;
}

/** What the kernel's sweep is told (see SweepControl in kernel/sweep.ts): plain numbers, the direction already found. */
export interface SweepSettings {
  twist?: number;
  pitch?: number;
  lockOrientation?: boolean;
  lockDirection?: [number, number, number];
  scale?: number;
}

/**
 * The feature's choices as the kernel takes them, from its worked-out sizes `v`. A sweep without any of the new
 * choices gives exactly what it always did: `{ twist, lockOrientation }`.
 */
export function sweepSettings(f: Pick<Feature, "sweepControl">, v: Record<string, number>, direction?: [number, number, number]): SweepSettings {
  const c = f.sweepControl;
  const lockOrientation = c?.lockOrientation === true;
  const out: SweepSettings = { twist: v.twist ?? 0, lockOrientation };
  if (!c) return out;
  const by = twistByOf(f);
  const sign = c.opposite ? -1 : 1;
  if (by === "turns") out.twist = sign * 360 * (v.turns ?? 1);
  else if (by === "pitch") {
    delete out.twist;
    out.pitch = sign * (v.pitch ?? 10);
  } else out.twist = sign * (v.twist ?? 0);
  if (!lockOrientation && c.lockDirection && direction) out.lockDirection = direction;
  if (c.scaled) out.scale = v.scale ?? 1;
  return out;
}

/** The size boxes a sweep shows: one way of giving the twist (only while the profile turns with the path), and the scale when it's on. */
export function sweepParamKeys(f: Pick<Feature, "sweepControl">, keys: Set<string>): void {
  const by = twistByOf(f);
  const twist = canTwist(f);
  if (!twist || by !== "angle") keys.delete("twist");
  if (!twist || by !== "turns") keys.delete("turns");
  if (!twist || by !== "pitch") keys.delete("pitch");
  if (!f.sweepControl?.scaled) keys.delete("scale");
}

/** The parts a sweep needs besides its sketches: the profile face's part, and the part a locked direction is on. */
export function sweepPartsUsed(f: Pick<Feature, "sweepControl">): string[] {
  const out: string[] = [];
  const c = f.sweepControl;
  if (c?.face) out.push(c.face.partId);
  if (c?.lockDirection?.pick) out.push(c.lockDirection.pick.partId);
  if (c?.lockDirection?.vertex) out.push(c.lockDirection.vertex.partId);
  for (const f of c?.lockFaces ?? []) out.push(f.partId);
  return out;
}

/** The features a sweep's locked direction uses (a sketch line, a mate connector, a curve). */
export function sweepFeaturesUsed(f: Pick<Feature, "sweepControl">): string[] {
  const g = f.sweepControl?.lockDirection;
  if (!g) return [];
  return [g.sketchLine?.sketch, g.sketchPoint?.sketch, g.connector, g.curve].filter((x): x is string => typeof x === "string");
}

/** The dialog's view-click state is never saved or sent to the engine. */
export function withoutSweepPicking<T extends Pick<Feature, "sweepControl">>(f: T): T {
  if (f.sweepControl?.picking === undefined) return f;
  const { picking: _p, ...rest } = f.sweepControl;
  return { ...f, sweepControl: tidySweepControl(rest) };
}

/**
 * Reads a saved `sweepControl` (checked, anything odd dropped). `parseGeom` and `parsePick` are the document reader's
 * own readers for a GeomPick and a TopoPick.
 */
export function parseSweepControl(raw: unknown, parseGeom: (g: unknown) => GeomPick | null, parsePick: (p: unknown) => TopoPick | null): SweepOptions | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  const out: SweepOptions = {};
  if (c.lockOrientation === true) out.lockOrientation = true;
  const dir = c.lockDirection !== undefined ? parseGeom(c.lockDirection) : null;
  if (dir) out.lockDirection = dir;
  if (c.twistBy === "turns" || c.twistBy === "pitch") out.twistBy = c.twistBy;
  if (c.opposite === true) out.opposite = true;
  if (c.scaled === true) out.scaled = true;
  const face = c.face !== undefined ? parsePick(c.face) : null;
  if (face && face.ref.kind === "face") out.face = face;
  if (Array.isArray(c.lockFaces)) {
    const faces = c.lockFaces.map(parsePick).filter((p): p is TopoPick => p !== null && p.ref.kind === "face");
    if (faces.length) out.lockFaces = faces;
  }
  return tidySweepControl(out);
}

/** A click in the view as a sweep's picking wants it (the same shapes geomClicks.ts takes). */
export type SweepClick =
  | { kind: "part"; pick: TopoPick; at?: [number, number, number] }
  | { kind: "plane"; plane: { kind: string; name?: string }; frame: { origin: [number, number, number]; n: [number, number, number] } }
  | { kind: "connector"; id: string; origin: [number, number, number]; z: [number, number, number] }
  | { kind: "sketchLine"; line: { sketch: string; line: string }; a: [number, number, number]; b: [number, number, number] }
  | { kind: "corner" };

const unitOf = (v: [number, number, number]): [number, number, number] => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * What a click does while a Sweep is picking its profile face or the direction to lock the profile to: the fields to
 * change, or a plain message why it can't be used (null: not picking).
 */
export function sweepClick(d: Pick<Feature, "sweepControl">, c: SweepClick | null): Partial<Pick<Feature, "sweepControl" | "sketchRef" | "areas" | "moreAreas">> | string | null {
  const picking = d.sweepControl?.picking;
  if (!picking) return null;
  if (!c) return picking === "face" ? "Click a flat face of a part to sweep." : picking === "lockFaces" ? LOCK_FACES_CLICK : "Click a line, a straight edge, a flat face, a plane or a mate connector for the direction.";
  const base = { ...(d.sweepControl ?? {}) };
  delete base.picking;
  if (picking === "lockFaces") {
    if (c.kind !== "part" || c.pick.ref.kind !== "face") return LOCK_FACES_CLICK;
    const list = d.sweepControl?.lockFaces ?? [];
    const pick = c.pick;
    if (list.length && list[0].partId !== pick.partId) return "The faces the profile is locked to must all be on one part (the part whose edges are the path).";
    const at = list.findIndex((f) => f.partId === pick.partId && sameFaceRef(f, pick));
    const next = at >= 0 ? list.filter((_, i) => i !== at) : [...list, pick];
    // Stays picking, so several faces can be clicked in turn.
    return { sweepControl: tidySweepControl({ ...base, lockFaces: next.length ? next : undefined, picking: "lockFaces" }) };
  }
  if (picking === "face") {
    if (c.kind !== "part" || c.pick.ref.kind !== "face") return "Click a flat face of a part to sweep.";
    if (c.pick.ref.surface !== "PLANE") return "That face is curved: a sweep's profile face must be flat.";
    return { sweepControl: tidySweepControl({ ...base, face: c.pick }), sketchRef: undefined, areas: undefined, moreAreas: undefined };
  }
  let g: GeomPick | null = null;
  if (c.kind === "part") {
    const ref = c.pick.ref;
    if (ref.kind === "edge") g = { p: c.at ?? ref.a, dir: unitOf([ref.b[0] - ref.a[0], ref.b[1] - ref.a[1], ref.b[2] - ref.a[2]]), pick: c.pick };
    else g = { p: c.at ?? ref.center, dir: ref.normal, pick: c.pick };
  } else if (c.kind === "plane") {
    const axis = c.plane.kind === "default" ? ({ Top: "z", Front: "y", Right: "x" } as const)[c.plane.name as "Top" | "Front" | "Right"] : undefined;
    g = axis ? { p: [0, 0, 0], axis } : { p: c.frame.origin, dir: c.frame.n };
  } else if (c.kind === "connector") g = { p: c.origin, dir: c.z, connector: c.id };
  else if (c.kind === "sketchLine") g = { p: c.a, dir: unitOf([c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]]), sketchLine: c.line };
  if (!g) return "A corner has no direction: click a line, a straight edge, a flat face, a plane or a mate connector.";
  return { sweepControl: tidySweepControl({ ...base, lockDirection: g }) };
}

/** What to click for Lock profile faces. */
const LOCK_FACES_CLICK = "Click the faces of the part to keep the profile at the same angle to (click one again to take it out).";

/** The same face of a part, as picked twice (its kind of surface, centre and facing within a hair). */
function sameFaceRef(a: TopoPick, b: TopoPick): boolean {
  if (a.ref.kind !== "face" || b.ref.kind !== "face") return false;
  const near = (p: [number, number, number], q: [number, number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-6;
  return a.ref.surface === b.ref.surface && near(a.ref.center, b.ref.center);
}

/** A few words for the faces a sweep's profile is locked to (shown in its dialog). */
export function lockFacesLabel(faces: TopoPick[] | undefined): string {
  const n = faces?.length ?? 0;
  return n === 0 ? "None yet" : n === 1 ? "1 face" : `${n} faces`;
}

/** A few words for the direction a sweep is locked to (shown in its dialog). */
export function directionLabel(g: GeomPick | undefined): string {
  if (!g) return "Not chosen yet";
  if (g.axis) return `The ${g.axis.toUpperCase()} axis`;
  if (g.connector) return "A mate connector's Z";
  if (g.sketchLine) return "A sketch line";
  if (g.pick?.ref.kind === "edge") return "An edge";
  if (g.pick?.ref.kind === "face") return g.pick.ref.surface === "PLANE" ? "A flat face's normal" : "A round face's axis";
  return "A plane's normal";
}
