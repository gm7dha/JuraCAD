/**
 * The feature list's search box (Onshape's feature list filter), pure: which features match what's typed, and
 * which face picks lead back to the feature that made them.
 */
import type { Feature } from "./types";

/** Every typed word must appear in the feature's name or in what kind of feature it is ("fillet 2", "hole"). */
export function featureMatches(feature: Feature, query: string, kindLabel: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${feature.name} ${kindLabel} ${feature.folder ?? ""}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

/** The ids of the features that match (null = nothing typed: show them all). */
export function matchingFeatures(features: Feature[], query: string, kindLabel: (f: Feature) => string): Set<string> | null {
  if (!query.trim()) return null;
  return new Set(features.filter((f) => featureMatches(f, query, kindLabel(f))).map((f) => f.id));
}

/** The feature that made face `index` of a part (from the build's `faceMakers`), else the latest feature that changed it. */
export function featureOfFace(part: { featureIds: string[]; faceMakers?: string[] }, index: number, features: Feature[]): string | null {
  const known = part.faceMakers?.[index];
  if (known && features.some((f) => f.id === known)) return known;
  for (let i = part.featureIds.length - 1; i >= 0; i--) {
    const id = part.featureIds[i];
    if (features.some((f) => f.id === id)) return id;
  }
  return null;
}

/** The faces of each part that a feature made (for lighting them up while its row is hovered); null = none known. */
export function facesMadeBy(parts: { id: string; faceMakers?: string[] }[], featureId: string): Map<string, number[]> | null {
  const out = new Map<string, number[]>();
  for (const p of parts) {
    const faces: number[] = [];
    p.faceMakers?.forEach((m, i) => m === featureId && faces.push(i));
    if (faces.length) out.set(p.id, faces);
  }
  return out.size ? out : null;
}

/**
 * While searching, the rollback bar goes after the last feature shown at or above the one it's on (that one may be
 * hidden): its id, "" = at the top of the list, null = no rollback bar.
 */
export function rollbackBarAfter(features: Feature[], rollbackTo: string | null, matches: Set<string> | null): string | null {
  if (!rollbackTo || !matches) return rollbackTo;
  const at = features.findIndex((f) => f.id === rollbackTo);
  for (let i = at; i >= 0; i--) if (matches.has(features[i].id)) return features[i].id;
  return "";
}
