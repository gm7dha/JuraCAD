import { convertPreview, featuresToBuild, featuresWithDraft, pickingPreview, previewFeatures, previewOf } from "../model/document";
import { resolveVariables } from "../model/variables";
import { useStore } from "../model/store";
import { keepInBrowser, keepProblem, OTHER_TAB, STORAGE_KEY, VERSIONS_KEY, type Kept } from "../model/browserKeep";

import { activeStudioId, keepIdOf, type VersionCompare } from "../model/store";
import { setCurrentScope } from "../model/expr";
import { studiosOf } from "../model/studios";
import type { StudioInput } from "./protocol";
import type { JuraCADDocument } from "../model/types";
import { configurationsInUse } from "../assembly/configured";
import { KernelClient } from "./client";
import { compareStudioInputs, configuredStudioInputs, featureForEngine, featuresForEngine, withContexts } from "./buildInput";

let client: KernelClient | null = null;

export function getKernel(): KernelClient {
  if (!client) throw new Error("The geometry engine hasn't started yet.");
  return client;
}

/** What to build right now: every Part Studio, with the feature being edited swapped into the one on show. */
function currentStudios(): StudioInput[] {
  const s = useStore.getState();
  const here = activeStudioId(s);
  const editingIn = s.editing ? here : null;
  return [...studiosOf(s.history.present).map((st) => ({ ...st, features: featuresForEngine(st.features) })).map((st) => withContexts(s.history.present, {
    id: st.id,
    features: convertPreview(
      // Picking parts or faces for the open feature: shown as they were before it (see pickingPreview).
      pickingPreview(st.id === here && s.rollbackTo
        ? featuresToBuild(st.id === editingIn ? previewFeatures(st.features) : st.features, st.id === editingIn ? featureForEngine(previewOf(s.editing?.draft ?? null)) : null, s.rollbackTo)
        : st.id === editingIn
          ? featuresWithDraft(previewFeatures(st.features), featureForEngine(previewOf(s.editing?.draft ?? null)))
          : st.features, st.id === editingIn ? s.editing?.draft ?? null : null),
      st.id === editingIn ? s.editing?.draft ?? null : null,
    ),
  }))), ...configuredStudios(s.history.present), ...versionStudios(s.versionCompare)];
}

/** Old versions being compared: their Part Studios, built alongside (see compareStudioInputs). */
let versionCache: { docs: Record<string, JuraCADDocument>; list: StudioInput[] } | null = null;
function versionStudios(c: VersionCompare | null): StudioInput[] {
  if (!c) return [];
  if (versionCache?.docs === c.docs) return versionCache.list;
  const list = Object.entries(c.docs).flatMap(([id, doc]) => compareStudioInputs(id, doc));
  setCurrentScope(resolveVariables(useStore.getState().history.present.variables).values);
  versionCache = { docs: c.docs, list };
  return list;
}

/** Part Studios that assemblies show in another configuration, built again in it ("<studio>@<configuration>"). */
let configuredCache: { doc: JuraCADDocument; list: StudioInput[] } | null = null;
function configuredStudios(doc: JuraCADDocument): StudioInput[] {
  if (configuredCache?.doc === doc) return configuredCache.list;
  const list = configuredStudioInputs(doc);
  configuredCache = { doc, list };
  return list;
}

/** What decides the configured builds (so a rebuild happens when it changes). */
function configuredKey(doc: JuraCADDocument): string {
  const used = configurationsInUse(doc);
  return used.length ? JSON.stringify([used, doc.configurations, doc.activeConfiguration]) : "";
}

/**
 * Starts the geometry worker and keeps it in sync with the document:
 * every change (including typing in an open feature dialog) triggers a rebuild,
 * and the document is saved to browser storage.
 */
export function connectKernel(): () => void {
  client = new KernelClient();
  const kernel = client;
  const store = useStore.getState();

  const rebuild = () => {
    useStore.getState().setRebuildBusy(true);
    const doc = useStore.getState().history.present;
    kernel.requestRebuild(currentStudios(), resolveVariables(doc.variables).values, doc.partNames ?? {}, (result) => {
      const s = useStore.getState();
      if (result instanceof Error) {
        s.setRebuildBusy(false);
        s.showToast(result.message, "error");
        return;
      }
      s.setRebuildResult(result.parts, result.featureErrors, result.durationMs, result.rebuilt, result.studioOrder, result.sketchLinks, result.featureWarnings, result.featureNotes, result.followed, result.curves);
      // Where each Move / copy's triad goes (kept the same object while nothing changed, so nothing redraws).
      // (Only the Part Studios rebuilt are in the result: the others' are kept.)
      const was = useStore.getState().transformCentres;
      const centres = { ...was, ...(result.transformCentres ?? {}) };
      if (JSON.stringify(centres) !== JSON.stringify(was)) useStore.setState({ transformCentres: centres });
      refreshCandidates();
    });
  };

  /**
   * The sketch open for editing: ask the engine what else it can snap to
   * (other sketches, every part's edges). Worked out from what's already
   * built, so opening or closing a sketch never rebuilds anything.
   */
  const refreshCandidates = () => {
    const s = useStore.getState();
    const draft = s.editing?.draft;
    const studio = activeStudioId(s);
    if (!draft || draft.type !== "sketch" || !draft.sketch?.plane || !studio) {
      if (s.sketchCandidates) s.setSketchCandidates(null);
      return;
    }
    const held = s.sketchCandidates?.id === draft.id && s.sketchCandidates.studioId === studio ? s.sketchCandidates : null;
    kernel.sketchCandidates(studio, draft.id, held?.version).then(
      (r) => {
        const now = useStore.getState();
        if (!r || now.editing?.draft.id !== draft.id) return;
        if (r.list) now.setSketchCandidates({ id: draft.id, studioId: studio, version: r.version, list: r.list });
      },
      () => undefined,
    );
  };

  kernel.ready.then(
    () => {
      store.setKernelStatus("ready");
      rebuild();
    },
    (e: Error) => store.setKernelStatus("failed", e.message),
  );

  let lastFeatures = useStore.getState().history.present.features;
  let lastVariables = useStore.getState().history.present.variables;
  let lastPartNames = useStore.getState().history.present.partNames;
  let lastStudios = useStore.getState().history.present.partStudios;
  let lastContexts = useStore.getState().history.present.contexts;
  let lastDraft = useStore.getState().editing?.draft ?? null;
  let lastDoc = useStore.getState().history.present;
  /** What this tab last wrote to browser storage (null: write the design and its versions again next time). */
  let kept: Kept | null = null;
  // Another tab wrote its design (or versions) over this one's: write both again on this design's next change
  // (not at once, or two open tabs would keep overwriting each other), and say so meanwhile.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY && e.key !== VERSIONS_KEY && e.key !== null) return;
    kept = null;
    if (useStore.getState().storageProblem !== OTHER_TAB) useStore.setState({ storageProblem: OTHER_TAB });
  };
  globalThis.addEventListener?.("storage", onStorage);
  let lastRollback = useStore.getState().rollbackTo;
  let lastConfigured = configuredKey(useStore.getState().history.present);
  let lastCompared = useStore.getState().versionCompare?.docs;

  const unsubscribe = useStore.subscribe((s) => {
    const draft = s.editing?.draft ?? null;
    if (
      s.history.present.features !== lastFeatures ||
      draft !== lastDraft ||
      s.rollbackTo !== lastRollback ||
      s.history.present.variables !== lastVariables ||
      s.history.present.partNames !== lastPartNames ||
      s.history.present.partStudios !== lastStudios ||
      s.history.present.contexts !== lastContexts ||
      configuredKey(s.history.present) !== lastConfigured ||
      s.versionCompare?.docs !== lastCompared
    ) {
      lastCompared = s.versionCompare?.docs;
      lastConfigured = configuredKey(s.history.present);
      lastStudios = s.history.present.partStudios;
      lastContexts = s.history.present.contexts;
      lastPartNames = s.history.present.partNames;
      lastFeatures = s.history.present.features;
      lastVariables = s.history.present.variables;
      lastDraft = draft;
      lastRollback = s.rollbackTo;
      if (s.kernelStatus === "ready") rebuild();
    }
    // An old version open to look at is never kept as the design: the current one (waiting in the stash) is.
    const keep = s.versionView?.stash.present ?? s.history.present;
    if (keep !== lastDoc) {
      lastDoc = keep;
      const storage = globalThis.localStorage;
      if (!storage) return;
      const r = keepInBrowser(storage, keep, keepIdOf(keep), kept);
      kept = r.kept;
      const problem = keepProblem(r, !!keep.versions?.length);
      const was = useStore.getState().storageProblem;
      if (problem !== was) {
        useStore.setState({ storageProblem: problem });
        // Said when it starts (or changes); the top bar keeps saying it until it's fixed.
        if (problem) useStore.getState().showToast(problem, "error");
        else if (was) useStore.getState().showToast("Your design is kept in this browser again.", "success");
      }
    }
  });

  return () => {
    unsubscribe();
    globalThis.removeEventListener?.("storage", onStorage);
    kernel.terminate();
    client = null;
  };
}
