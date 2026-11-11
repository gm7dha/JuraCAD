/**
 * Writing what the engine found again for newer Plane features and mate
 * connectors (RebuildResult.followed) into the design (pure): their numbers
 * as they are now, then everything placed on them brought up to date. It
 * changes nothing that a user typed, so the app does it without an undo step.
 */
import type { FollowedRefs } from "../kernel/protocol";
import type { Scope } from "./expr";
import type { Feature, JuraCADDocument } from "./types";
import { refreshDocumentPlanes } from "../sketch/planeFeature";

/** A feature with what was found for it (the same object when there's nothing for it, or nothing new). */
export function withFollowed(f: Feature, followed: Record<string, FollowedRefs>): Feature {
  const found = followed[f.id];
  if (!found) return f;
  let g = f;
  // Only when it's still made from the same things (the user may have changed it while it was being built).
  if (found.planeDef && f.type === "plane" && f.planeDef && sameChoices(found.planeDef, f.planeDef) && JSON.stringify(found.planeDef) !== JSON.stringify(f.planeDef)) g = { ...g, planeDef: found.planeDef };
  // Only where it sits is taken (its settings may have been changed since the build began).
  if (found.connector && f.type === "mateConnector" && f.connector && JSON.stringify(found.connector.base) !== JSON.stringify(f.connector.base)) g = { ...g, connector: { ...f.connector, base: found.connector.base } };
  return g;
}

/** The same plane settings but for the numbers found (points, directions, the face's frame). */
function sameChoices(a: object, b: object): boolean {
  const strip = (o: object) => JSON.stringify(o, (k, v) => (k === "p" || k === "dir" || k === "origin" || k === "u" || k === "v" ? undefined : v));
  return strip(a) === strip(b);
}

/** Same for every Part Studio of a design; the same document when nothing changed. */
export function applyFollowed(doc: JuraCADDocument, followed: Record<string, FollowedRefs>, scope?: Scope): JuraCADDocument {
  if (!Object.keys(followed).length) return doc;
  const fix = (list: Feature[]) => {
    let changed = false;
    const out = list.map((f) => {
      const g = withFollowed(f, followed);
      if (g !== f) changed = true;
      return g;
    });
    return changed ? out : list;
  };
  const features = fix(doc.features);
  let studiosChanged = false;
  const studios = doc.partStudios?.map((s) => {
    const fs = fix(s.features);
    if (fs === s.features) return s;
    studiosChanged = true;
    return { ...s, features: fs };
  });
  if (features === doc.features && !studiosChanged) return doc;
  return refreshDocumentPlanes({ ...doc, features, ...(studiosChanged ? { partStudios: studios } : {}) }, scope);
}
