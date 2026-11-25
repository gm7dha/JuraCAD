/**
 * Starting values a new feature works out for itself (Onshape's), kept up to date while the user hasn't changed them:
 * - an Extrude's direction: a Remove or Intersect from a sketch on a part's face points into the part;
 * - a Linear pattern's spacing: the size of what's repeated along the direction, plus a little, so copies don't overlap.
 *
 * Pure: the store keeps the last value it set (`AutoValues`) and only changes a value while it still equals that.
 */
import type { PartMesh } from "../kernel/protocol";
import { planeFrame, type SketchPlane, type Vec3 } from "../sketch/planes";
import { sketchLine3D, AXIS_DIRS } from "./patternRefs";
import type { Feature } from "./types";

/**
 * Which side of a sketch plane the part is on, when that's known: true = behind it (against its normal — a sketch
 * on a part's face, whose normal points out of the part), false = in front, null = not known (a standard plane, a
 * Plane feature, an older face sketch that didn't keep its face).
 */
export function materialBehind(plane: SketchPlane | null | undefined): boolean | null {
  if (!plane || plane.kind !== "face" || !plane.face || plane.face.ref.kind !== "face") return null;
  const n = planeFrame(plane).n;
  const out = plane.face.ref.normal;
  const d = n[0] * out[0] + n[1] * out[1] + n[2] * out[2];
  if (Math.abs(d) < 0.5) return null;
  return d > 0;
}

/**
 * The extrude direction a new Extrude should start with on this plane (as Onshape): Remove and Intersect go into the
 * part, New and Add out of it. Null = no opinion (keep what it has).
 */
export function aimedFlip(draft: Pick<Feature, "type" | "operation" | "surface" | "extrude">, plane: SketchPlane | null | undefined): boolean | null {
  if (draft.type !== "extrude" || !draft.extrude || draft.surface) return null;
  const behind = materialBehind(plane);
  if (behind === null) return null;
  const cutting = draft.operation === "remove" || draft.operation === "intersect";
  return cutting ? behind : !behind;
}

const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

/** A linear pattern's direction (first or second), as a unit vector, when it can be told without the engine. */
export function patternDirection(draft: Pick<Feature, "pattern">, features: Feature[], second = false): Vec3 | null {
  const p = draft.pattern;
  if (!p || (!second && p.unset)) return null;
  const line = second ? p.line2 : p.line;
  const along = second ? p.along2 : p.along;
  const axis = second ? (p.axis2 ?? "y") : p.axis;
  let d: Vec3 | null = null;
  if (line) {
    const l = sketchLine3D(features, line);
    if (typeof l !== "string") d = [l.b[0] - l.a[0], l.b[1] - l.a[1], l.b[2] - l.a[2]];
  } else if (along) {
    const r = along.ref;
    if (r.kind === "edge" && r.curve === "LINE") d = [r.b[0] - r.a[0], r.b[1] - r.a[1], r.b[2] - r.a[2]];
    else if (r.kind === "face" && r.surface === "PLANE") d = r.normal;
  } else d = AXIS_DIRS[axis];
  if (!d) return null;
  const l = len(d);
  return l > 1e-9 ? [d[0] / l, d[1] / l, d[2] / l] : null;
}

type Box = { min: Vec3; max: Vec3 };
const boxes = new WeakMap<PartMesh, Box | null>();
function boxOfPart(p: PartMesh): Box | null {
  if (boxes.has(p)) return boxes.get(p) ?? null;
  const v = p.vertices;
  let box: Box | null = null;
  if (v.length >= 3) {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 2 < v.length; i += 3)
      for (let k = 0; k < 3; k++) {
        if (v[i + k] < min[k]) min[k] = v[i + k];
        if (v[i + k] > max[k]) max[k] = v[i + k];
      }
    box = { min, max };
  }
  boxes.set(p, box);
  return box;
}

/** The parts a linear pattern repeats, as they were before it (whole parts picked, or the parts its source features made). */
export function patternedParts(draft: Pick<Feature, "pattern">, parts: readonly PartMesh[]): PartMesh[] {
  const p = draft.pattern;
  if (!p) return [];
  if (p.of === "part") return parts.filter((part) => (p.parts ?? []).includes(part.id));
  if (p.of === "face") return [];
  const made = new Set(p.sources);
  return parts.filter((part) => made.has(part.id.split("~")[0].split("@")[0]));
}

/** How far a set of parts reaches along a direction (mm). */
export function sizeAlong(parts: readonly PartMesh[], dir: Vec3): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const part of parts) {
    const b = boxOfPart(part);
    if (!b) continue;
    // The box's corners: the lowest and highest along the direction.
    let a = 0;
    let c = 0;
    for (let k = 0; k < 3; k++) {
      const x0 = b.min[k] * dir[k];
      const x1 = b.max[k] * dir[k];
      a += Math.min(x0, x1);
      c += Math.max(x0, x1);
    }
    lo = Math.min(lo, a);
    hi = Math.max(hi, c);
  }
  return hi > lo ? hi - lo : 0;
}

/** A spacing that clears `size` with room to spare: 1.2 × it, rounded up to a whole mm (or a 16th of an inch). */
export function clearSpacing(size: number, unit: "mm" | "in" = "mm"): string | null {
  if (!(size > 0.01)) return null;
  const mm = size * 1.2;
  if (unit === "in") {
    const inches = mm / 25.4;
    const step = inches >= 1 ? 4 : 16;
    return `${Math.ceil(inches * step - 1e-9) / step} in`;
  }
  return String(Math.max(1, Math.ceil(mm - 1e-9)));
}

/** The spacing (or `spacing2`, between rows) a Linear pattern should start with, or null (keep what it has). */
export function suggestedSpacing(draft: Pick<Feature, "type" | "pattern">, parts: readonly PartMesh[], features: Feature[], unit: "mm" | "in" = "mm", second = false): string | null {
  if (draft.type !== "linearPattern") return null;
  const dir = patternDirection(draft, features, second);
  if (!dir) return null;
  const repeated = patternedParts(draft, parts);
  return repeated.length ? clearSpacing(sizeAlong(repeated, dir), unit) : null;
}

/** The values last set automatically for the open new feature (see the store's startCreate / setDraftField). */
export interface AutoValues {
  id: string;
  flip?: boolean;
  spacing?: string;
  spacing2?: string;
}

export interface AutoContext {
  /** The sketch plane of a sketch, as the engine has it now. */
  planeOf: (sketchId: string) => SketchPlane | null;
  /** The parts as they were when the dialog opened (before its preview changed them). */
  parts: readonly PartMesh[];
  features: Feature[];
  unit: "mm" | "in";
}

/**
 * The new feature with its self-worked-out values brought up to date — each only while it still has the value last
 * set for it (the user hasn't changed it). Returns the feature (the same object when nothing changed) and the values
 * now set.
 */
export function withAutoValues(draft: Feature, auto: AutoValues, ctx: AutoContext): { draft: Feature; auto: AutoValues } {
  if (auto.id !== draft.id) return { draft, auto };
  let out = draft;
  let next = auto;
  if (draft.type === "extrude" && draft.extrude && draft.extrude.flip === (auto.flip ?? false)) {
    const flip = aimedFlip(draft, draft.sketchRef ? ctx.planeOf(draft.sketchRef) : null);
    if (flip !== null) {
      if (flip !== draft.extrude.flip) out = { ...out, extrude: { ...draft.extrude, flip } };
      next = { ...next, flip };
    }
  }
  if (draft.type === "linearPattern" && draft.pattern) {
    for (const key of ["spacing", "spacing2"] as const) {
      const was = next[key];
      if (was === undefined || out.params[key] !== was) continue;
      const s = suggestedSpacing(out, ctx.parts, ctx.features, ctx.unit, key === "spacing2");
      if (s === null) continue;
      if (s !== out.params[key]) out = { ...out, params: { ...out.params, [key]: s } };
      next = { ...next, [key]: s };
    }
  }
  return { draft: out, auto: next };
}

/**
 * The sketch a new Hole starts with: the one highlighted in the list, else the sketch just made (the last feature,
 * with points or circles to drill at, that nothing uses yet), else none — the dialog then asks for a face to be
 * clicked (or a sketch chosen), rather than drilling an old, used-up sketch's circles again.
 */
export function holeSketchFor(features: Feature[], selectedId: string | null, used: ReadonlySet<string>, positions: (f: Feature) => number): string | undefined {
  const picked = features.find((f) => f.id === selectedId && f.type === "sketch" && !f.suppressed);
  if (picked) return picked.id;
  const last = features.filter((f) => !f.suppressed).at(-1);
  return last?.type === "sketch" && last.sketch?.plane && !used.has(last.id) && positions(last) > 0 ? last.id : undefined;
}
