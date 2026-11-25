/**
 * What an open feature still needs clicked before it can be accepted (Onshape greys its ✓ until then). Only the
 * plain "nothing picked yet" cases — never stricter than the engine, which says the same when such a feature is built.
 * Pure.
 */
import type { Feature } from "./types";

const faces = (f: Feature) => (f.picks ?? []).filter((p) => p.ref.kind === "face");
const edges = (f: Feature) => (f.picks ?? []).filter((p) => p.ref.kind === "edge");
const none = (f: Feature) => !(f.picks ?? []).length;

/** A plain-English "click this first", or null when the feature has what it needs to be accepted. */
export function missingPick(f: Feature): string | null {
  switch (f.type) {
    case "fillet":
    case "chamfer":
      return none(f) ? `Click the edges (or faces) to ${f.type === "fillet" ? "round" : "bevel"} first.` : null;
    case "shell":
      // Hollow keeps every face (a face picked only says which part); Open needs the faces to leave open.
      return !f.hollow && !faces(f).length ? "Pick the faces to leave open first (or choose Hollow for a closed hollow)." : null;
    case "draft":
      return !faces(f).length ? "Click the faces to slope first." : null;
    case "moveFace":
      return !faces(f).length ? "Click the faces to move first." : null;
    case "deleteFace":
      return !faces(f).length ? "Click the faces to remove first." : null;
    case "replaceFace":
      return !faces(f).length ? "Click the faces to replace first." : null;
    case "modifyFillet":
      return !faces(f).length ? "Click the rounded faces (fillets) to change first." : null;
    case "thicken":
      return none(f) ? "Click the faces to thicken first." : null;
    case "thread":
      return none(f) ? "Click the round face to thread first." : null;
    case "fullRound":
      return none(f) ? "Click the flat top face to round over first." : null;
    case "flange":
    case "hem":
      return !edges(f).length ? "Click the straight edges of the sheet first." : null;
    case "cornerBreak":
      return none(f) ? "Click the corner edges to round off first." : null;
    case "extendSurface":
      return none(f) ? "Click the edges of the surface to extend first." : null;
    case "fill":
      return none(f) ? "Click the edges round the opening first." : null;
    case "ruled":
      return none(f) ? "Click the edges to make the strips from first." : null;
    case "faceBlend":
      if (none(f)) return "Click the faces for side 1 first.";
      return !(f.blend?.side2 ?? []).length ? "Click the faces for side 2 first." : null;
    case "split":
      return f.splitDef?.mode === "face" && !faces(f).length ? "Click the faces to split first." : null;
    case "deletePart":
      return !(f.deleteParts ?? []).length ? "Click the parts to delete first." : null;
    case "simplify":
      return !(f.simplifyParts ?? []).length ? "Click the parts to simplify first." : null;
    case "composite":
      return (f.compositeParts ?? []).length < 2 ? "Click two or more parts first." : null;
    case "trimFrame":
      return !(f.trimFrame?.parts ?? []).length ? "Click the frame members to trim first." : null;
    case "gusset":
      return (f.gusset?.parts ?? []).length < 2 ? "Click the two frame members that meet first." : null;
    case "linearPattern":
    case "circularPattern":
    case "curvePattern":
      if (f.pattern?.of === "part" && !(f.pattern.parts ?? []).length) return "Click the parts to repeat first.";
      if (f.pattern?.of === "face" && none(f)) return "Click the faces to repeat first.";
      return null;
    case "mirror":
      if (f.mirror?.of === "face" && none(f)) return "Click the faces to mirror first.";
      return null;
    case "hole":
      return f.hole && !f.hole.sketchRef ? "Click a face to place a hole, or choose a sketch with points first." : null;
    default:
      return null;
  }
}

/**
 * What stops Accept: `missingPick`, except when an existing feature being edited was already missing it when the dialog
 * opened (its picks lost to an upstream change, an older Shell saved Open with no face) — then Accept stays free, so
 * the user is never trapped in the dialog (the engine says what's wrong on the row as before).
 */
export function acceptBlocker(draft: Feature, original?: Feature | null): string | null {
  const missing = missingPick(draft);
  if (!missing || !original || original.id !== draft.id) return missing;
  return missingPick(original) ? null : missing;
}
