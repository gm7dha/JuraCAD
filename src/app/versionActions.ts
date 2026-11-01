/**
 * What the Versions panel's buttons do (saving, opening, restoring,
 * comparing). The pure parts are in src/model/versions.ts and
 * versionCompare.ts; this wires them to the store. Packing a design is
 * asynchronous (the browser's compression), so these return promises.
 */
import type { PartMesh } from "../kernel/protocol";
import { newId } from "../model/document";
import { useStore, type AppState } from "../model/store";
import type { DesignVersion, JuraCADDocument } from "../model/types";
import { versionSuffix } from "../kernel/buildInput";
import { compareDesigns, type DesignChanges, type PartInfo } from "../model/versionCompare";
import { addVersion, designFromVersion, editVersion, packDesign, removeVersions, restoredDesign, unpackDesign, versionNameProblem, versionsOf } from "../model/versions";
import { forgetFile } from "./fileActions";

/** "now": the current design, in comparisons. */
export const NOW = "now";

/** The current design (not an old version open to look at). */
export const currentDesign = (s: Pick<AppState, "history" | "versionView">): JuraCADDocument => s.versionView?.stash.present ?? s.history.present;

function findVersion(id: string): DesignVersion | undefined {
  return versionsOf(currentDesign(useStore.getState())).find((v) => v.id === id);
}

async function openPacked(v: DesignVersion): Promise<JuraCADDocument | null> {
  const r = await unpackDesign(v.packed);
  if (!r.ok) {
    useStore.getState().showToast(r.error, "error");
    return null;
  }
  return r.doc;
}

/** Make a version (not yet added) of the current design. */
async function snapshot(name: string, note: string | undefined, auto: boolean): Promise<DesignVersion> {
  const doc = currentDesign(useStore.getState());
  return { id: newId("ver"), name: name.trim(), ...(note?.trim() ? { note: note.trim() } : {}), createdAt: new Date().toISOString(), ...(auto ? { auto: true } : {}), packed: await packDesign(doc) };
}

/** Save the design as a version. Returns a plain-English problem, or null when saved. */
export async function saveVersion(name: string, note?: string): Promise<string | null> {
  const s = useStore.getState();
  if (s.versionView) return "You're looking at an old version. Go back to the current design to save a version of it.";
  if (s.editing) return "Finish or cancel the open feature first, then save a version.";
  const problem = versionNameProblem(s.history.present, name);
  if (problem) return problem;
  const v = await snapshot(name, note, false);
  useStore.getState().changeDocument((doc) => addVersion(doc, v));
  useStore.getState().showToast(`Saved version "${v.name}".`, "success");
  return null;
}

/** Open a version to look at (read-only). */
export async function openVersion(id: string): Promise<void> {
  const v = findVersion(id);
  if (!v) return;
  if (useStore.getState().editing) {
    useStore.getState().showToast("Finish or cancel the open feature first, then open the version.", "error");
    return;
  }
  const doc = await openPacked(v);
  if (!doc) return;
  useStore.getState().enterVersionView({ id: v.id, name: v.name, createdAt: v.createdAt }, doc);
  useStore.getState().openDialog(null);
}

/**
 * Restore a version: the design becomes a copy of it (one undo step). With
 * `keepCurrent`, what you have now is saved first as an automatic version,
 * so it can be found again even after more changes.
 */
export async function restoreVersion(id: string, keepCurrent: boolean): Promise<void> {
  const v = findVersion(id);
  if (!v) return;
  if (useStore.getState().editing) {
    useStore.getState().showToast("Finish or cancel the open feature first, then restore the version.", "error");
    return;
  }
  const doc = await openPacked(v);
  if (!doc) return;
  useStore.getState().leaveVersionView();
  const before = keepCurrent ? await snapshot(`Before restoring ${v.name}`, undefined, true) : null;
  useStore.getState().changeDocument((now) => restoredDesign(before ? addVersion(now, before) : now, doc));
  useStore.getState().openDialog(null);
  useStore.getState().showToast(`Restored version "${v.name}". ${before ? `What you had is kept as "${before.name}". ` : ""}Undo brings it back as it was.`, "success");
}

/** Start a new design from a version (like New: the design you had can be undone back). */
export async function newDesignFromVersion(id: string): Promise<void> {
  const v = findVersion(id);
  if (!v) return;
  if (useStore.getState().editing) {
    useStore.getState().showToast("Finish or cancel the open feature first.", "error");
    return;
  }
  const doc = await openPacked(v);
  if (!doc) return;
  useStore.getState().newDocument(designFromVersion(doc, v.name));
  forgetFile();
  useStore.getState().openDialog(null);
  useStore.getState().showToast(`Started a new design from version "${v.name}". Undo goes back to the design you had.`, "success");
}

export function renameVersion(id: string, name: string, note?: string): string | null {
  const s = useStore.getState();
  const problem = name !== undefined ? versionNameProblem(s.history.present, name, id) : null;
  if (problem) return problem;
  s.changeDocument((doc) => editVersion(doc, id, { name, ...(note !== undefined ? { note } : {}) }));
  return null;
}

export function deleteVersions(ids: string[]): void {
  useStore.getState().changeDocument((doc) => removeVersions(doc, ids));
}

/** Compare two versions, or a version with now (NOW). The older one first. */
export async function startCompare(older: string, newer: string): Promise<boolean> {
  const docs: Record<string, JuraCADDocument> = {};
  for (const id of [older, newer]) {
    if (id === NOW) continue;
    const v = findVersion(id);
    if (!v) return false;
    const doc = await openPacked(v);
    if (!doc) return false;
    docs[id] = doc;
  }
  useStore.getState().leaveVersionView();
  useStore.getState().setVersionCompare({ older, newer, docs, ghost: false });
  return true;
}

export function stopCompare(): void {
  useStore.getState().setVersionCompare(null);
}

/** One side's built parts (its own ids and names), or null while they're still being built. */
export function comparedParts(s: Pick<AppState, "parts" | "rebuildBusy" | "kernelStatus" | "versionCompare">, side: string): PartInfo[] | null {
  if (s.kernelStatus !== "ready" || s.rebuildBusy) return null;
  if (side === NOW) return s.parts.filter((p) => !p.configuration).map((p) => ({ id: p.id, name: p.name }));
  const doc = s.versionCompare?.docs[side];
  const suffix = versionSuffix(side);
  const tag = suffix.slice(1);
  return s.parts
    .filter((p) => p.configuration === tag)
    .map((p) => {
      const id = p.id.endsWith(suffix) ? p.id.slice(0, -suffix.length) : p.id;
      return { id, name: doc?.partNames?.[id] ?? p.name };
    });
}

/** What changed between the two compared sides. */
export function comparedChanges(s: AppState): DesignChanges | null {
  const c = s.versionCompare;
  if (!c) return null;
  const docOf = (side: string) => (side === NOW ? currentDesign(s) : c.docs[side]);
  const a = docOf(c.older);
  const b = docOf(c.newer);
  if (!a || !b) return null;
  return compareDesigns(a, b, comparedParts(s, c.older), comparedParts(s, c.newer));
}

/** The older version's parts in the Part Studio on show, drawn see-through over the design (compare overlay). */
export function ghostParts(parts: PartMesh[], c: AppState["versionCompare"], studioId: string | null): PartMesh[] {
  if (!c?.ghost || !studioId || c.older === NOW) return NO_PARTS;
  const id = studioId + versionSuffix(c.older);
  return parts.filter((p) => p.studioId === id);
}
const NO_PARTS: PartMesh[] = [];
