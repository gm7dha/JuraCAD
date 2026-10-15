/**
 * Moving features up and down the feature list (Onshape: drag in the list).
 * A feature must stay after everything it uses (the sketch it extrudes, the
 * part it rounds, the features it repeats…) and before everything that uses it.
 */
import type { Feature } from "./types";

/** Does `a` use `b`? (Any mention of b's id in a: sketch refs, picked parts, pattern sources, planes…) */
export function uses(a: Feature, b: Feature): boolean {
  if (a.id === b.id) return false;
  return JSON.stringify(a).includes(`"${b.id}"`);
}

/**
 * The list with feature `id` moved to sit before `beforeId` (null = at the
 * end), or a plain-English reason it can't go there.
 */
export function moveFeature(features: Feature[], id: string, beforeId: string | null): Feature[] | string {
  const from = features.findIndex((f) => f.id === id);
  if (from < 0) return features;
  const f = features[from];
  const rest = features.filter((x) => x.id !== id);
  const to = beforeId === null ? rest.length : rest.findIndex((x) => x.id === beforeId);
  if (to < 0) return features;
  const next = [...rest.slice(0, to), f, ...rest.slice(to)];
  const at = next.indexOf(f);
  const earlierUser = next.slice(0, at).find((x) => uses(x, f));
  if (earlierUser) return `${f.name} can't go above ${earlierUser.name}, which uses it.`;
  const laterNeed = next.slice(at + 1).find((x) => uses(f, x));
  if (laterNeed) return `${f.name} can't go above ${laterNeed.name} — it uses it.`;
  return next;
}
