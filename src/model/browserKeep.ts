/**
 * Keeping the design in the browser (localStorage), so a refresh brings it
 * back. The design and its versions are kept under separate keys, the design
 * first: big versions can never stop the design itself being kept. Pure (the
 * storage is passed in), so it's tested without a browser.
 */
import type { DesignVersion, JuraCADDocument } from "./types";
import { designOf } from "./versions";

// The design's key keeps the app's old name (PartSmith) on purpose: changing it
// would lose the design people have kept in this browser.
export const STORAGE_KEY = "partsmith.document.v1";
/** The design's versions (new with Versions, so it has the new name). */
export const VERSIONS_KEY = "juracad.versions.v1";

export interface KeepStorage {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface KeepResult {
  /** The design itself was kept. */
  design: boolean;
  /** The versions as they are now are kept (also true when there was nothing new to write). */
  versions: boolean;
}

/**
 * Keep `doc` in the browser. Its versions are written only when they changed
 * since `keptVersions` (the list last kept), and only after the design was
 * kept. When the versions can't be kept, the old ones are removed rather than
 * left to be put back on a design they may not belong to.
 */
export function keepInBrowser(storage: KeepStorage, doc: JuraCADDocument, keptVersions: DesignVersion[] | undefined): KeepResult {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(designOf(doc)));
  } catch {
    return { design: false, versions: false };
  }
  const list = doc.versions;
  if (list === keptVersions) return { design: true, versions: true };
  if (!list?.length) {
    try {
      storage.removeItem(VERSIONS_KEY);
    } catch {
      // (removing never fails in practice)
    }
    return { design: true, versions: true };
  }
  try {
    storage.setItem(VERSIONS_KEY, JSON.stringify(list));
    return { design: true, versions: true };
  } catch {
    try {
      storage.removeItem(VERSIONS_KEY);
    } catch {
      // ignore
    }
    return { design: true, versions: false };
  }
}

/** What to tell the user (kept in the top bar until it's fixed), or null when everything is kept. */
export function keepProblem(r: KeepResult, hasVersions: boolean): string | null {
  if (!r.design)
    return hasVersions
      ? "This design is too big for the browser to keep, so your latest changes would be lost if the page is closed or reloaded. Use Save to keep it as a file (that keeps its versions too), or remove old versions (Versions, at the top)."
      : "This design is too big for the browser to keep, so your latest changes would be lost if the page is closed or reloaded. Use Save to keep it as a file.";
  if (!r.versions)
    return "The design is kept in this browser, but its versions are too big to keep here too: they'd be gone after a reload. Use Save to keep them in the .juracad file, or remove old versions (Versions, at the top).";
  return null;
}
