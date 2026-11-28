/**
 * Fillet and Chamfer picking (Onshape's): the result rounds its edges away, so while edges are being clicked the
 * Part Studio is shown as it was before the feature (`Feature.edgesPicking`, never saved — see `picksPartsBefore`),
 * with the picked edges lit, and a picked edge can be clicked again (to take it off, or to put a variable fillet's
 * radius there). Pure.
 */
import { edgesOfFace, type FaceEdgeMesh } from "./faceEdges";
import type { Feature } from "./types";

/** Whether the feature picks edges this way. */
export const picksEdges = (f: Pick<Feature, "type">): boolean => f.type === "fillet" || f.type === "chamfer";

/** A new Fillet/Chamfer with nothing picked starts showing the part as it was, ready for clicks. */
export function withStartPicking(f: Feature): Feature {
  return picksEdges(f) && !(f.picks ?? []).length ? { ...f, edgesPicking: true } : f;
}

/**
 * What the engine builds while picking: the features before it, then it marked `edgesCheck` — built and checked (its
 * error or warning shown as usual), but the parts left as they were, so they're what's clicked.
 */
export function checkWhilePicking(features: Feature[], draft: Feature | null): Feature[] {
  if (!draft || !picksEdges(draft) || !draft.edgesPicking) return features;
  const at = features.findIndex((f) => f.id === draft.id);
  return at < 0 ? features : [...features.slice(0, at), { ...features[at], edgesCheck: true }];
}

/** A dialog undo step taken back: the feature as it was then, but picking (or showing the result) as it is now. */
export function withPickingOf(restored: Feature, now: Feature): Feature {
  if (restored.edgesPicking === now.edgesPicking) return restored;
  return now.edgesPicking ? { ...restored, edgesPicking: true } : showingResult(restored);
}

/** The feature showing its result again (picking off), or the same object when it already does. */
export function showingResult(f: Feature): Feature {
  if (f.edgesPicking === undefined) return f;
  const { edgesPicking: _p, ...rest } = f;
  return rest;
}

/**
 * Whether a clicked face or edge of the preview was made by the open feature itself (a fillet's round face, or an
 * edge round one): it isn't on the part as it was, so the click can't pick anything — the view goes back to picking.
 */
export function madeByOpenFeature(part: FaceEdgeMesh & { faceMakers?: string[] }, item: { kind: string; index: number }, featureId: string): boolean {
  const makers = part.faceMakers;
  // Not known (a part too big to keep its faces' makers): it may well be the result's — go back to picking to be safe.
  if (!makers) return true;
  if (item.kind === "face") return makers[item.index] === featureId;
  if (item.kind !== "edge") return false;
  for (let f = 0; f < makers.length; f++) if (makers[f] === featureId && edgesOfFace(part, f).includes(item.index)) return true;
  return false;
}

export const PICKING_NOTE = "Showing the part as it was before this feature, so you can click its edges (picked ones are lit).";
export const BACK_TO_PICKING = "Showing the part as it was before this feature, so you can click the edge itself — click it again.";
