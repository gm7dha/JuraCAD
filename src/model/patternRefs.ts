/**
 * What a Mirror mirrors across, and what a pattern goes along or round, as
 * picked in the 3D view (Onshape's "Mirror plane" and "Axis" boxes).
 *
 * A mirror plane can be a default plane, a Plane feature, a flat face of a
 * part (followed as the part changes), or a line in a sketch (mirrors across
 * the plane through the line, standing square to its sketch). A pattern's
 * direction or axis can be X, Y or Z, an edge or face of a part, or a sketch
 * line. Everything here is pure: the engine finds faces and edges itself.
 */
import type { TopoPick } from "../geometry/topoRef";
import { describeRef } from "../geometry/topoRef";
import { axisInSketch, axisLabel } from "../sketch/axis";
import { cross, normalize, planeFrame, planeLabel, toWorld, type SketchPlane, type Vec3 } from "../sketch/planes";
import type { Axis, Feature } from "./types";

/** A straight line in a sketch, by the sketch feature's id and the line's id. */
export interface SketchLineRef {
  sketch: string;
  line: string;
}

type MirrorDef = NonNullable<Feature["mirror"]>;
type PatternDef = NonNullable<Feature["pattern"]>;

/** Check untrusted JSON for a sketch line reference. */
export function parseLineRef(data: unknown): SketchLineRef | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  return typeof d.sketch === "string" && typeof d.line === "string" ? { sketch: d.sketch, line: d.line } : null;
}

/** A sketch line in 3D: its two ends (as drawn), and the normal of the sketch it's in. */
export interface Line3D {
  a: Vec3;
  b: Vec3;
  /** The sketch plane's normal. */
  n: Vec3;
  /** E.g. "Construction line 1 in Sketch 2". */
  name: string;
}

/** Where a sketch line is now, or a plain-English reason it can't be used. */
export function sketchLine3D(features: Feature[], ref: SketchLineRef): Line3D | string {
  const sk = features.find((f) => f.id === ref.sketch);
  if (!sk || sk.type !== "sketch" || !sk.sketch) return "The sketch with the picked line has been deleted. Click another line, face or plane.";
  if (sk.suppressed) return `${sk.name} is suppressed, so its line can't be used. Unsuppress it, or click something else.`;
  if (!sk.sketch.plane) return `${sk.name} isn't on a plane yet. Click something else.`;
  const at = axisInSketch(sk.sketch.data, ref.line);
  if (!at) return `The line picked in ${sk.name} has been deleted (or has no length). Click another line, face or plane.`;
  const frame = planeFrame(sk.sketch.plane);
  const line = sk.sketch.data.curves.find((c) => c.id === ref.line);
  const ends = line?.type === "line" ? [line.p1, line.p2] : [];
  const pos = (id: string) => {
    if (id === "origin") return [0, 0] as const;
    const p = sk.sketch!.data.points.find((q) => q.id === id);
    return p ? ([p.x, p.y] as const) : null;
  };
  const p = ends.map(pos);
  if (!p[0] || !p[1]) return `The line picked in ${sk.name} has lost an end. Click another line, face or plane.`;
  return {
    a: toWorld(frame, p[0][0], p[0][1]),
    b: toWorld(frame, p[1][0], p[1][1]),
    n: frame.n,
    name: `${axisLabel(sk.sketch.data, ref.line)} in ${sk.name}`,
  };
}

/** The mirror plane through a sketch line, standing square to its sketch: a point on it and its normal. */
export function planeThroughLine(line: Line3D): { origin: Vec3; n: Vec3 } {
  const dir: Vec3 = [line.b[0] - line.a[0], line.b[1] - line.a[1], line.b[2] - line.a[2]];
  return { origin: line.a, n: normalize(cross(dir, line.n)) };
}

/** The same plane as a SketchPlane (kept on the mirror as what it was when picked, and to draw it). */
export function linePlane(line: Line3D): Extract<SketchPlane, { kind: "face" }> {
  const u = normalize([line.b[0] - line.a[0], line.b[1] - line.a[1], line.b[2] - line.a[2]]);
  const mid: Vec3 = [(line.a[0] + line.b[0]) / 2, (line.a[1] + line.b[1]) / 2, (line.a[2] + line.b[2]) / 2];
  // u × v must be the plane's normal: u × n_sketch, so v = the sketch's normal.
  return { kind: "face", origin: mid, u, v: normalize(line.n), label: `Plane through ${line.name}` };
}

/** What can be chosen as a mirror plane. */
export type MirrorChoice =
  | { kind: "plane"; plane: SketchPlane }
  | { kind: "face"; plane: SketchPlane; pick: TopoPick }
  | { kind: "line"; line: SketchLineRef; plane: SketchPlane }
  | { kind: "none" };

/** The mirror with a new plane chosen (or cleared): whatever was chosen before is dropped. */
export function setMirrorReference(m: MirrorDef, choice: MirrorChoice): MirrorDef {
  const { planePick: _p, line: _l, unset: _u, ...rest } = m;
  switch (choice.kind) {
    case "plane":
      return { ...rest, plane: choice.plane };
    case "face":
      return { ...rest, plane: choice.plane, planePick: choice.pick };
    case "line":
      return { ...rest, plane: choice.plane, line: choice.line };
    case "none":
      return { ...rest, unset: true };
  }
}

/** The mirror plane in words for its box, or null when none is chosen yet. */
export function mirrorReferenceText(m: MirrorDef, features: Feature[]): string | null {
  if (m.unset) return null;
  if (m.line) {
    const l = sketchLine3D(features, m.line);
    return typeof l === "string" ? "Missing sketch line — click another" : l.name;
  }
  if (m.planePick) return `${describeRef(m.planePick.ref, true)} of ${partName(features, m.planePick.partId)}`;
  return planeLabel(m.plane);
}

/** What can be chosen as a pattern's direction (linear) or axis (circular). */
export type DirectionChoice = { kind: "axis"; axis: Axis } | { kind: "pick"; pick: TopoPick } | { kind: "line"; line: SketchLineRef } | { kind: "none" };

/**
 * The pattern with a new direction (or axis) chosen, or cleared. `second`: a
 * linear grid's rows. Clearing the rows' direction goes back to the default
 * one (rows are optional); clearing the main one leaves nothing chosen.
 */
export function setPatternDirection(p: PatternDef, choice: DirectionChoice, second = false): PatternDef {
  if (second) {
    const { along2: _a, line2: _l, ...rest } = p;
    if (choice.kind === "axis") return { ...rest, axis2: choice.axis };
    if (choice.kind === "pick") return { ...rest, along2: choice.pick };
    if (choice.kind === "line") return { ...rest, line2: choice.line };
    return rest;
  }
  const { along: _a, line: _l, unset: _u, ...rest } = p;
  switch (choice.kind) {
    case "axis":
      // The rows can't go the same way as the copies: swap them over.
      return { ...rest, axis: choice.axis, ...(rest.axis2 === choice.axis ? { axis2: p.axis } : {}) };
    case "pick":
      return { ...rest, along: choice.pick };
    case "line":
      return { ...rest, line: choice.line };
    case "none":
      return { ...rest, unset: true };
  }
}

const AXIS_NAMES: Record<Axis, string> = { x: "X axis", y: "Y axis", z: "Z axis" };

/** A pattern's direction or axis in words for its box, or null when none is chosen yet. */
export function patternReferenceText(p: PatternDef, features: Feature[], second = false): string | null {
  const line = second ? p.line2 : p.line;
  const pick = second ? p.along2 : p.along;
  if (line) {
    const l = sketchLine3D(features, line);
    return typeof l === "string" ? "Missing sketch line — click another" : l.name;
  }
  if (pick) return `${describeRef(pick.ref, true)} of ${partName(features, pick.partId)}`;
  if (second) return AXIS_NAMES[p.axis2 ?? (p.axis === "y" ? "x" : "y")];
  if (p.unset) return null;
  return AXIS_NAMES[p.axis];
}

/** A part's name for the boxes: the feature that made it (good enough to recognise it). */
function partName(features: Feature[], partId: string): string {
  const f = features.find((x) => x.id === partId.split("~")[0]);
  return f ? f.name : "a part";
}

/** A straight sketch line that can be clicked in the 3D view, in 3D. */
export interface PickableLine {
  sketch: string;
  line: string;
  a: Vec3;
  b: Vec3;
}

/** The straight lines of the sketches before `beforeId` in the list (all of them, if it's not there), to click as a reference. */
export function pickableSketchLines(features: Feature[], beforeId: string | null): PickableLine[] {
  const at = beforeId ? features.findIndex((f) => f.id === beforeId) : -1;
  const earlier = at >= 0 ? features.slice(0, at) : features;
  const out: PickableLine[] = [];
  for (const f of earlier) {
    if (f.type !== "sketch" || f.suppressed || !f.sketch?.plane) continue;
    for (const c of f.sketch.data.curves) {
      if (c.type !== "line") continue;
      const l = sketchLine3D(features, { sketch: f.id, line: c.id });
      if (typeof l !== "string") out.push({ sketch: f.id, line: c.id, a: l.a, b: l.b });
    }
  }
  return out;
}

/**
 * What to draw in the 3D view to show the chosen reference: a plane (a mirror
 * plane), an axis (a long line through a point), or nothing (a face or edge
 * picked on a part is highlighted on the part instead). `values` are the
 * feature's worked-out numbers (a circular pattern's axis goes through cx, cy, cz).
 */
export type ReferenceShape = { kind: "plane"; origin: Vec3; u: Vec3; v: Vec3 } | { kind: "axis"; through: Vec3; dir: Vec3 } | { kind: "line"; a: Vec3; b: Vec3; plane?: { u: Vec3; v: Vec3 } };

export const AXIS_DIRS: Record<Axis, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

export function referenceShape(f: Feature, features: Feature[], values: Record<string, number>): ReferenceShape | null {
  if (f.type === "mirror" && f.mirror) {
    const m = f.mirror;
    if (m.unset || m.planePick) return null;
    if (m.line) {
      const l = sketchLine3D(features, m.line);
      if (typeof l === "string") return null;
      const p = linePlane(l);
      return { kind: "line", a: l.a, b: l.b, plane: { u: p.u, v: p.v } };
    }
    const fr = planeFrame(m.plane);
    return { kind: "plane", origin: fr.origin, u: fr.u, v: fr.v };
  }
  if ((f.type === "circularPattern" || f.type === "linearPattern") && f.pattern) {
    const p = f.pattern;
    if (p.unset || p.along) return null;
    if (p.line) {
      const l = sketchLine3D(features, p.line);
      return typeof l === "string" ? null : { kind: "line", a: l.a, b: l.b };
    }
    if (f.type === "linearPattern") return null;
    return { kind: "axis", through: [values.cx ?? 0, values.cy ?? 0, values.cz ?? 0], dir: AXIS_DIRS[p.axis] };
  }
  return null;
}
