/**
 * Plane features: where each construction plane is, worked out from what it's
 * based on, and keeping everything placed on a plane (sketches, text, other
 * planes, mirrors) up to date when the plane moves.
 *
 * Things placed on a Plane feature store its frame (like a sketch on a face)
 * plus `planeRef`; refreshPlaneRefs rewrites those stored frames after any change.
 */
import { resolveParams } from "../model/features";
import type { Scope } from "../model/expr";
import type { Feature, PartSmithDocument, PlaneOptions } from "../model/types";
import { cross, dot, normalize, planeFrame, type PlaneFrame, type SketchPlane, type Vec3 } from "./planes";

/** Turn `w` about the unit axis `k` by `deg` degrees. */
function rotate(w: Vec3, k: Vec3, deg: number): Vec3 {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const kw = cross(k, w);
  const d = dot(k, w) * (1 - c);
  return [w[0] * c + kw[0] * s + k[0] * d, w[1] * c + kw[1] * s + k[1] * d, w[2] * c + kw[2] * s + k[2] * d];
}

const along = (o: Vec3, n: Vec3, d: number): Vec3 => [o[0] + n[0] * d, o[1] + n[1] * d, o[2] + n[2] * d];

/** Where a plane is, or why it can't be made. `distance` is mm, `angle` degrees. */
export function planeFeatureFrame(def: PlaneOptions, values: { distance?: number; angle?: number }): PlaneFrame | string {
  const base = planeFrame(def.ref);
  const distance = values.distance ?? 0;
  if (def.mode === "midplane") {
    if (!def.ref2) return "Click a second flat face, parallel to the first, to put the plane halfway between them.";
    const other = planeFrame(def.ref2);
    if (Math.abs(Math.abs(dot(base.n, other.n)) - 1) > 1e-6) return "The two faces aren't parallel, so there's no halfway plane between them.";
    const gap = dot([other.origin[0] - base.origin[0], other.origin[1] - base.origin[1], other.origin[2] - base.origin[2]], base.n);
    return { ...base, origin: along(base.origin, base.n, gap / 2 + distance) };
  }
  if (def.mode === "angle") {
    const k = normalize(def.axis === "u" ? base.u : base.v);
    const u = normalize(rotate(base.u, k, values.angle ?? 0));
    const v = normalize(rotate(base.v, k, values.angle ?? 0));
    const n = normalize(cross(u, v));
    return { origin: along(base.origin, n, distance), u, v, n };
  }
  return { ...base, origin: along(base.origin, base.n, distance) };
}

/** The frame of a Plane feature as a place to sketch (or put text, or mirror across). */
export function planeAsSketchPlane(f: Feature, frame: PlaneFrame): SketchPlane {
  return { kind: "face", origin: frame.origin, u: frame.u, v: frame.v, label: f.name, planeRef: f.id };
}

/** A plane feature's frame as things stand (null when it can't be made). */
export function framesOf(features: Feature[], scope?: Scope): Map<string, PlaneFrame> {
  const out = new Map<string, PlaneFrame>();
  for (const f of refreshPlaneRefs(features, scope)) {
    if (f.type !== "plane" || f.suppressed || !f.planeDef) continue;
    const { values, errors } = resolveParams(f, scope);
    if (Object.keys(errors).length) continue;
    const frame = planeFeatureFrame(f.planeDef, values);
    if (typeof frame !== "string") out.set(f.id, frame);
  }
  return out;
}

const close = (a: Vec3, b: Vec3) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 1e-9;

/**
 * Bring everything placed on Plane features up to date with where the planes
 * are now (in list order, so planes based on other planes follow too).
 * Returns the same array when nothing moved.
 */
export function refreshPlaneRefs(features: Feature[], scope?: Scope): Feature[] {
  if (!features.some((f) => f.type === "plane")) return features;
  const planes = new Map<string, SketchPlane>();
  let changed = false;
  const fix = (p: SketchPlane | null | undefined): SketchPlane | null | undefined => {
    if (!p || p.kind !== "face" || !p.planeRef) return p;
    const now = planes.get(p.planeRef);
    if (!now || now.kind !== "face") return p;
    if (close(now.origin, p.origin) && close(now.u, p.u) && close(now.v, p.v) && now.label === p.label) return p;
    changed = true;
    return now;
  };
  const out = features.map((f) => {
    let g = f;
    if (f.sketch?.plane) {
      const plane = fix(f.sketch.plane);
      if (plane !== f.sketch.plane) g = { ...g, sketch: { ...f.sketch, plane: plane ?? null } };
    }
    if (f.text?.plane) {
      const plane = fix(f.text.plane);
      if (plane !== f.text.plane) g = { ...g, text: { ...f.text, plane: plane ?? null } };
    }
    if (f.mirror?.plane) {
      const plane = fix(f.mirror.plane);
      if (plane && plane !== f.mirror.plane) g = { ...g, mirror: { ...f.mirror, plane } };
    }
    if (f.neutral) {
      const plane = fix(f.neutral);
      if (plane && plane !== f.neutral) g = { ...g, neutral: plane };
    }
    if (f.replaceDef?.target) {
      const plane = fix(f.replaceDef.target);
      if (plane && plane !== f.replaceDef.target) g = { ...g, replaceDef: { ...f.replaceDef, target: plane } };
    }
    if (f.splitDef) {
      const plane = fix(f.splitDef.plane);
      if (plane && plane !== f.splitDef.plane) g = { ...g, splitDef: { ...f.splitDef, plane } };
    }
    if (f.planeDef) {
      const ref = fix(f.planeDef.ref);
      const ref2 = fix(f.planeDef.ref2);
      if (ref !== f.planeDef.ref || ref2 !== f.planeDef.ref2) g = { ...g, planeDef: { ...f.planeDef, ref: ref ?? f.planeDef.ref, ...(ref2 ? { ref2 } : {}) } };
    }
    if (g.type === "plane" && g.planeDef && !g.suppressed) {
      const { values, errors } = resolveParams(g, scope);
      const frame = Object.keys(errors).length ? null : planeFeatureFrame(g.planeDef, values);
      if (frame && typeof frame !== "string") planes.set(g.id, planeAsSketchPlane(g, frame));
    }
    return g;
  });
  return changed ? out : features;
}

/** refreshPlaneRefs for every Part Studio in a document. */
export function refreshDocumentPlanes(doc: PartSmithDocument, scope?: Scope): PartSmithDocument {
  const features = refreshPlaneRefs(doc.features, scope);
  let studiosChanged = false;
  const studios = doc.partStudios?.map((s) => {
    const fs = refreshPlaneRefs(s.features, scope);
    if (fs === s.features) return s;
    studiosChanged = true;
    return { ...s, features: fs };
  });
  if (features === doc.features && !studiosChanged) return doc;
  return { ...doc, features, ...(studiosChanged ? { partStudios: studios } : {}) };
}
