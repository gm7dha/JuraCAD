/**
 * Which version of the open feature the parts on show were built with (they lag a drag by a rebuild): connect.ts notes
 * it as each rebuild comes back, and Move face's hole/boss arrow places itself from it (manipulators.ts `shownMoveValue`).
 */
import type { Feature } from "./types";

let noted: { id: string; draft: Feature | null } | null = null;

/** The parts just shown were built with `draft` open (`built`: it was in what was built and didn't fail). */
export function noteShownDraft(draft: Feature | null, built: boolean): void {
  noted = draft ? { id: draft.id, draft: built ? draft : null } : null;
}

/** The version of `draft` the parts on show were built with: null = without it; undefined = not known. */
export function shownDraftFor(draft: Feature): Feature | null | undefined {
  return noted && noted.id === draft.id ? noted.draft : undefined;
}
