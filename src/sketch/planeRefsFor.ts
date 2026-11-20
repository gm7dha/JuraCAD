/**
 * The plane lines (and origin) a sketch being edited is offered, worked out
 * in the app from the design (see planeRefs.ts): Top, Front, Right, every
 * unsuppressed Plane feature — those further down the feature list than the
 * sketch are offered as `later` (shown, but they say why they can't be used).
 * Kept apart from planeRefs.ts so links.ts needn't load the feature maths.
 */
import type { Scope } from "../model/expr";
import type { Feature } from "../model/types";
import type { RefEdge } from "./links";
import { framesOf } from "./planeFeature";
import { planeRefs, type PlaneSource } from "./planeRefs";
import { planeFrame, type PlaneFrame, type SketchPlane } from "./planes";

const cache = new WeakMap<Feature[], { key: string; list: RefEdge[] }>();

export function sketchPlaneRefs(plane: SketchPlane, features: Feature[], sketchId: string, built?: Readonly<Record<string, PlaneFrame>>, scope?: Scope): RefEdge[] {
  const frame = planeFrame(plane);
  const key = JSON.stringify([frame, sketchId, built ?? null]);
  const known = cache.get(features);
  if (known?.key === key) return known.list;
  const frames = framesOf(features, scope, built);
  const at = features.findIndex((f) => f.id === sketchId);
  const planes: PlaneSource[] = [];
  features.forEach((f, i) => {
    const fr = f.type === "plane" ? frames.get(f.id) : undefined;
    if (fr) planes.push({ id: f.id, name: f.name, frame: fr, ...(at >= 0 && i > at ? { later: true } : {}) });
  });
  const list = planeRefs(frame, planes);
  cache.set(features, { key, list });
  return list;
}
