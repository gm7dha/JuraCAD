/**
 * Keeping the design in the browser (localStorage), so a refresh brings it
 * back. The design and its versions are kept under separate keys, the design
 * first: big versions can never stop the design itself being kept (they're
 * dropped from the browser to make room). Pure (the storage is passed in), so
 * it's tested without a browser.
 *
 * The two keys are tied together by a keep id: a random id for each design
 * (store.ts `keepIdOf`), written into both. On loading, versions are put back
 * only on the design with the same id — so versions written by another tab
 * (or left from a design that's gone) never land on the wrong design.
 */
import { fileVersionOf, parseDocument } from "./document";
import type { DesignVersion, JuraCADDocument } from "./types";
import { designOf, parseVersions } from "./versions";

// The design's key keeps the app's old name (PartSmith) on purpose: changing it
// would lose the design people have kept in this browser.
export const STORAGE_KEY = "partsmith.document.v1";
/** The design's versions (new with Versions, so it has the new name): `{ keep, list }`. */
export const VERSIONS_KEY = "juracad.versions.v1";

export interface KeepStorage {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** What this tab last wrote: the design's keep id and the versions list kept with it. */
export interface Kept {
  keep: string;
  versions: DesignVersion[] | undefined;
}

export interface KeepResult {
  /** The design itself was kept. */
  design: boolean;
  /** The versions as they are now are kept with it. */
  versions: boolean;
  /** What's now written (pass it back next time), or null when nothing can be relied on (write everything again). */
  kept: Kept | null;
}

/** A new random keep id. */
export function newKeepId(): string {
  const bytes = new Uint8Array(9);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (bytes.every((b) => b === 0)) for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function remove(storage: KeepStorage, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    // (removing never fails in practice)
  }
}

/**
 * Keep `doc` in the browser under keep id `keep`. Its versions are written
 * only when they (or the keep id) changed since `kept`, and only after the
 * design was kept. If the design doesn't fit, the versions are removed from
 * the browser to make room and the design tried again. Versions that can't
 * be kept are removed rather than left to be put back on another design.
 */
export function keepInBrowser(storage: KeepStorage, doc: JuraCADDocument, keep: string, kept: Kept | null): KeepResult {
  // A design with moved Part Studio tabs is kept as format version 2 (see fileVersionOf), so an older JuraCAD
  // (e.g. an offline cached copy) refuses it rather than drop a studio; otherwise exactly as before.
  const plain = designOf(doc);
  const design = JSON.stringify(fileVersionOf(doc) === 2 ? { ...plain, version: 2, keep } : { ...plain, keep });
  const list = doc.versions?.length ? doc.versions : undefined;
  try {
    storage.setItem(STORAGE_KEY, design);
  } catch {
    // Saved versions may be what fills the browser: the design comes first.
    remove(storage, VERSIONS_KEY);
    try {
      storage.setItem(STORAGE_KEY, design);
    } catch {
      return { design: false, versions: false, kept: null };
    }
    return list ? { design: true, versions: false, kept: null } : { design: true, versions: true, kept: { keep, versions: undefined } };
  }
  if (kept && kept.keep === keep && kept.versions === list) return { design: true, versions: true, kept };
  if (!list) {
    remove(storage, VERSIONS_KEY);
    return { design: true, versions: true, kept: { keep, versions: undefined } };
  }
  try {
    storage.setItem(VERSIONS_KEY, JSON.stringify({ keep, list }));
    return { design: true, versions: true, kept: { keep, versions: list } };
  } catch {
    remove(storage, VERSIONS_KEY);
    return { design: true, versions: false, kept: null };
  }
}

/**
 * The design kept in the browser, with its versions when they're its own
 * (same keep id), and its keep id; null when there's none (or it's damaged).
 */
export function readKept(storage: { getItem(key: string): string | null }): { doc: JuraCADDocument; keep: string | null } | null {
  let raw: unknown;
  try {
    const text = storage.getItem(STORAGE_KEY);
    if (!text) return null;
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const doc = parseDocument(raw);
  if (!doc) return null;
  const keep = typeof (raw as { keep?: unknown }).keep === "string" ? ((raw as { keep: string }).keep) : null;
  // Versions only come from their own key now (never from inside the design).
  const design = designOf(doc);
  if (!keep) return { doc: design, keep: null };
  try {
    const text = storage.getItem(VERSIONS_KEY);
    const v = text ? (JSON.parse(text) as { keep?: unknown; list?: unknown }) : null;
    const list = v && v.keep === keep ? parseVersions(v.list) : [];
    return { doc: list.length ? { ...design, versions: list } : design, keep };
  } catch {
    return { doc: design, keep };
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

/** Shown in the top bar when another tab has written its design over this one's. */
export const OTHER_TAB =
  "JuraCAD in another tab or window is now the design kept in this browser. Make any change here (or Save to a file) to keep this one instead — a reload would otherwise open the other one.";
