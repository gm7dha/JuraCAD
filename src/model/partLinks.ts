/**
 * Which features made which parts, both ways — so picking a part lights up
 * the features that shaped it, and picking a feature lights up its part(s).
 * Sketches count too, through the extrudes, holes and sweeps that use them.
 */
import type { Feature } from "./types";

/** The sketches a feature uses. */
export function sketchesUsedBy(f: Feature): string[] {
  return [f.sketchRef, f.hole?.sketchRef, f.pathRef, ...(f.sections ?? [])].filter((x): x is string => !!x);
}

/** Features that made any of the given parts (including the sketches they use), in list order. */
export function featuresOfParts(parts: { id: string; featureIds: string[] }[], partIds: string[], features: Feature[]): string[] {
  const made = new Set(parts.filter((p) => partIds.includes(p.id)).flatMap((p) => p.featureIds));
  for (const f of features) if (made.has(f.id)) for (const s of sketchesUsedBy(f)) made.add(s);
  return features.filter((f) => made.has(f.id)).map((f) => f.id);
}

/** Parts a feature helped make (for a sketch: the parts made from it). */
export function partsOfFeature(parts: { id: string; featureIds: string[] }[], featureId: string, features: Feature[]): string[] {
  const users = new Set([featureId, ...features.filter((f) => sketchesUsedBy(f).includes(featureId)).map((f) => f.id)]);
  return parts.filter((p) => p.featureIds.some((id) => users.has(id))).map((p) => p.id);
}
