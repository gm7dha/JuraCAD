/**
 * Which features made which parts, both ways — so picking a part lights up
 * the features that shaped it, and picking a feature lights up its part(s).
 * Sketches count too, through the extrudes, holes and sweeps that use them.
 */
import type { Feature } from "./types";

/** The sketches a feature uses. */
export function sketchesUsedBy(f: Feature): string[] {
  return [f.sketchRef, f.hole?.sketchRef, f.pathRef, ...(f.sections ?? []), ...(f.moreAreas ?? []).map((m) => m.sketch)].filter((x): x is string => !!x);
}

/** Plane features a feature is placed on or based on. */
function planesUsedBy(f: Feature): string[] {
  const refs = [f.sketch?.plane, f.text?.plane, f.mirror?.plane, f.splitDef?.plane, f.neutral, f.replaceDef?.target ?? undefined, f.planeDef?.ref, f.planeDef?.ref2];
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

/**
 * While a feature's dialog is open (its preview built): the parts it changes
 * (not ones it makes), for lighting them up, and a plain line saying what it
 * does to which parts — "Adds to Part 1", "Makes Part 3", "Cuts Part 1 and
 * Part 2". Null line when it hasn't built anything yet.
 */
export function draftEffect(
  parts: { id: string; name: string; featureIds: string[]; configuration?: string; joined?: { feature: string; names: string[] }[] }[],
  draft: Pick<Feature, "id" | "operation">,
): { changed: string[]; text: string | null } {
  const own = parts.filter((p) => !p.configuration && p.featureIds.includes(draft.id));
  const made = own.filter((p) => p.id.split("~")[0] === draft.id);
  const changed = own.filter((p) => p.id.split("~")[0] !== draft.id);
  const names = (list: string[]) => (list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`);
  // Parts an Add merged into this one ("joining Part 2 into it").
  const joinedInto = (p: (typeof parts)[number]) => p.joined?.find((j) => j.feature === draft.id)?.names ?? [];
  const sentence: string[] = [];
  if (changed.length) {
    if (draft.operation === "remove") sentence.push(`Cuts ${names(changed.map((p) => p.name))}`);
    else if (draft.operation === "intersect") sentence.push(`Keeps only the overlap with ${names(changed.map((p) => p.name))}`);
    else if (changed.length === 1 && joinedInto(changed[0]).length) sentence.push(`Adds to ${changed[0].name}, joining ${names(joinedInto(changed[0]))} into it`);
    else sentence.push(`Adds to ${names(changed.map((p) => (joinedInto(p).length ? `${p.name} (joining ${names(joinedInto(p))} into it)` : p.name)))}`);
  }
  if (made.length) sentence.push(`${changed.length ? "makes" : "Makes"} ${made.length === 1 ? "a new part" : "new parts"}: ${names(made.map((p) => p.name))}`);
  return { changed: changed.map((p) => p.id), text: sentence.length ? `${sentence.join(", and ")}.` : null };
}
