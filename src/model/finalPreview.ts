import type { Feature } from "./types";

/**
 * Onshape's "Final" tick in feature dialogs (pure).
 *
 * While an existing feature is being edited (not a new one, not a sketch), the
 * Part Studio is shown rolled back to just after it: later features aren't
 * built, so the parts look — and are clicked — as they were when it was made.
 * Ticking "Final" (`showFinal`) shows the whole design with the edit in place.
 * A new feature already goes in at the rollback bar, so nothing changes for it.
 */

/** What `editRollback` needs to know about the open dialog. */
export interface EditingLike {
  mode: "create" | "edit";
  draft: Pick<Feature, "id" | "type">;
}

/**
 * Where the Part Studio on show is rolled back to right now: the rollback bar
 * (`rollbackTo`, null = none), or — while an existing feature is edited with
 * "Final" off and something unsuppressed comes after it — that feature. A bar
 * already above the feature stays where it is.
 */
export function editRollback(features: readonly Feature[], editing: EditingLike | null | undefined, rollbackTo: string | null, showFinal: boolean): string | null {
  if (!editing || showFinal || !finalChoice(features, editing, rollbackTo)) return rollbackTo;
  return editing.draft.id;
}

/**
 * Whether the dialog offers the "Final" tick: an existing (non-sketch) feature
 * is being edited and some unsuppressed feature after it — before the rollback
 * bar, if there is one — would be left out.
 */
export function finalChoice(features: readonly Feature[], editing: EditingLike | null | undefined, rollbackTo: string | null): boolean {
  if (!editing || editing.mode !== "edit" || editing.draft.type === "sketch") return false;
  const at = features.findIndex((f) => f.id === editing.draft.id);
  if (at < 0) return false;
  const bar = rollbackTo ? features.findIndex((f) => f.id === rollbackTo) : -1;
  // Rolled back above it already (or to it): the bar decides, as before.
  if (bar >= 0 && bar <= at) return false;
  const end = bar >= 0 ? bar + 1 : features.length;
  for (let i = at + 1; i < end; i++) if (!features[i].suppressed) return true;
  return false;
}

/**
 * While an existing sketch is open, the parts as they'd be rolled back to just before it (Onshape rolls back while a
 * sketch is edited). A sketch's own build and its snap list come from the whole design, so instead of rebuilding, the
 * parts later features made are hidden, and parts made before it but changed later are drawn see-through. Null when
 * there's nothing to do (not editing an existing sketch, or nothing comes after it).
 */
export function partsAfterSketch(
  features: readonly Feature[],
  parts: readonly { id: string; featureIds: readonly string[]; configuration?: string }[],
  editing: EditingLike | null | undefined,
): { hidden: string[]; seeThrough: string[] } | null {
  if (!editing || editing.mode !== "edit" || editing.draft.type !== "sketch") return null;
  const at = features.findIndex((f) => f.id === editing.draft.id);
  if (at < 0) return null;
  const later = new Set(features.slice(at + 1).map((f) => f.id));
  if (!later.size) return null;
  const hidden: string[] = [];
  const seeThrough: string[] = [];
  for (const p of parts) {
    if (p.configuration || !p.featureIds.length) continue;
    if (later.has(p.featureIds[0])) hidden.push(p.id);
    else if (p.featureIds.some((id) => later.has(id))) seeThrough.push(p.id);
  }
  return hidden.length || seeThrough.length ? { hidden, seeThrough } : null;
}
