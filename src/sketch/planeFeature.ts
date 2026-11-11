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
import type { Feature, JuraCADDocument, PlaneOptions } from "../model/types";
import { cross, dot, normalize, planeFrame, type PlaneFrame, type SketchPlane, type Vec3 } from "./planes";
import { connectorFrame, connectorPlane, isMorePlaneMode, morePlaneFrame } from "./planeTypes";
import type { PlaneMoreMode } from "../model/types";

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
  if (isMorePlaneMode(def.mode)) return morePlaneFrame(def as PlaneOptions & { mode: PlaneMoreMode }, values);
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

/** A mate connector feature's XY plane (null when it isn't one, or is suppressed). */
export function connectorFeaturePlane(f: Feature, scope?: Scope): PlaneFrame | null {
  if (f.type !== "mateConnector" || f.suppressed || !f.connector) return null;
  const { values } = resolveParams(f, scope);
  return connectorPlane(connectorFrame(f.connector, values));
}

/** The frame of a Plane feature as a place to sketch (or put text, or mirror across). */
export function planeAsSketchPlane(f: Feature, frame: PlaneFrame): SketchPlane {
  return { kind: "face", origin: frame.origin, u: frame.u, v: frame.v, label: f.name, planeRef: f.id };
}

/**
 * A plane feature's (or mate connector's) frame as things stand (missing when it can't be made). `built`: where the
 * engine built the ones that follow the model (RebuildResult.followed) — those win over the design's own numbers.
 */
export function framesOf(features: Feature[], scope?: Scope, built?: Readonly<Record<string, PlaneFrame>>): Map<string, PlaneFrame> {
  const out = new Map<string, PlaneFrame>();
  if (built) {
    for (const [id, frame] of framesOf(features, scope)) out.set(id, built[id] ?? frame);
    return out;
  }
  for (const f of refreshPlaneRefs(features, scope)) {
    const cf = connectorFeaturePlane(f, scope);
    if (cf) out.set(f.id, cf);
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
  if (!features.some((f) => f.type === "plane" || f.type === "mateConnector")) return features;
  const planes = new Map<string, SketchPlane>();
  let changed = false;
  const out = features.map((f) => {
    const g = repointFeature(f, planes);
    if (g !== f) changed = true;
    if (g.type === "plane" && g.planeDef && !g.suppressed) {
      const { values, errors } = resolveParams(g, scope);
      const frame = Object.keys(errors).length ? null : planeFeatureFrame(g.planeDef, values);
      if (frame && typeof frame !== "string") planes.set(g.id, planeAsSketchPlane(g, frame));
    }
    const cf = connectorFeaturePlane(g, scope);
    if (cf) planes.set(g.id, planeAsSketchPlane(g, cf));
    return g;
  });
  return changed ? out : features;
}

/**
 * Put a feature's planes that are on Plane features / mate connectors (`planeRef`) where `planes` says those are now.
 * Returns the same feature when nothing moved.
 */
export function repointFeature(f: Feature, planes: ReadonlyMap<string, SketchPlane>): Feature {
  if (!planes.size) return f;
  const fix = (p: SketchPlane | null | undefined): SketchPlane | null | undefined => {
    if (!p || p.kind !== "face" || !p.planeRef) return p;
    const now = planes.get(p.planeRef);
    if (!now || now.kind !== "face") return p;
    if (close(now.origin, p.origin) && close(now.u, p.u) && close(now.v, p.v) && now.label === p.label) return p;
    return now;
  };
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
  if (f.connector?.plane) {
    const plane = fix(f.connector.plane);
    if (plane && plane !== f.connector.plane) g = { ...g, connector: { ...f.connector, plane } };
  }
  return g;
}

/** refreshPlaneRefs for every Part Studio in a document. */
export function refreshDocumentPlanes(doc: JuraCADDocument, scope?: Scope): JuraCADDocument {
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
