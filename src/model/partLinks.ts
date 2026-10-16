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

/** Plane features a feature is placed on or based on. */
function planesUsedBy(f: Feature): string[] {
  const refs = [f.sketch?.plane, f.text?.plane, f.mirror?.plane, f.splitDef?.plane, f.replaceDef?.target ?? undefined, f.planeDef?.ref, f.planeDef?.ref2];
  return refs.flatMap((p) => (p && p.kind === "face" && p.planeRef ? [p.planeRef] : []));
}

/** Features that made any of the given parts (including the sketches and planes they use), in list order. */
export function featuresOfParts(parts: { id: string; featureIds: string[] }[], partIds: string[], features: Feature[]): string[] {
  const made = new Set(parts.filter((p) => partIds.includes(p.id)).flatMap((p) => p.featureIds));
  // Walk back up the list, so a sketch's plane (and that plane's own plane) are found too.
  for (let i = features.length - 1; i >= 0; i--) {
    const f = features[i];
    if (!made.has(f.id)) continue;
    for (const s of sketchesUsedBy(f)) made.add(s);
  }
  for (let i = features.length - 1; i >= 0; i--) {
    const f = features[i];
    if (made.has(f.id)) for (const p of planesUsedBy(f)) made.add(p);
  }
  return features.filter((f) => made.has(f.id)).map((f) => f.id);
}

/**
 * The feature list grouped by part, for the "Group by part" view: Plane
 * features first (with the standard planes — they belong to no part), then
 * each part with the features that made it (in build order), then anything
 * else not tied to a part. A feature that shaped several parts is listed under each.
 */
export function groupByPart(
  parts: { id: string; name: string; featureIds: string[] }[],
  features: Feature[],
): { planes: string[]; groups: { partId: string; name: string; featureIds: string[] }[]; other: string[] } {
  const planes = features.filter((f) => f.type === "plane").map((f) => f.id);
  const isPlane = new Set(planes);
  const groups = parts.map((p) => ({ partId: p.id, name: p.name, featureIds: featuresOfParts(parts, [p.id], features).filter((id) => !isPlane.has(id)) }));
  const used = new Set([...planes, ...groups.flatMap((g) => g.featureIds)]);
  return { planes, groups, other: features.filter((f) => !used.has(f.id)).map((f) => f.id) };
}

/** Parts a feature helped make (for a sketch: the parts made from it). */
export function partsOfFeature(parts: { id: string; featureIds: string[] }[], featureId: string, features: Feature[]): string[] {
  const users = new Set([featureId, ...features.filter((f) => sketchesUsedBy(f).includes(featureId)).map((f) => f.id)]);
  return parts.filter((p) => p.featureIds.some((id) => users.has(id))).map((p) => p.id);
}
