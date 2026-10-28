import { featuresToBuild, featuresWithDraft, previewFeatures, previewOf } from "../model/document";
import { resolveVariables } from "../model/variables";
import { STORAGE_KEY, useStore } from "../model/store";

/** Whether the "too big to keep" message has been shown since the last successful keep. */
let storageWarned = false;
import { activeStudioId } from "../model/store";
import { studiosOf } from "../model/studios";
import type { StudioInput } from "./protocol";
import type { JuraCADDocument } from "../model/types";
import { configurationsInUse } from "../assembly/configured";
import { KernelClient } from "./client";
import { configuredStudioInputs, featureForEngine, featuresForEngine } from "./buildInput";

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
  return [...studiosOf(s.history.present).map((st) => ({ ...st, features: featuresForEngine(st.features) })).map((st) => ({
    id: st.id,
    features:
      st.id === here && s.rollbackTo
        ? featuresToBuild(st.id === editingIn ? previewFeatures(st.features) : st.features, st.id === editingIn ? featureForEngine(previewOf(s.editing?.draft ?? null)) : null, s.rollbackTo)
        : st.id === editingIn
          ? featuresWithDraft(previewFeatures(st.features), featureForEngine(previewOf(s.editing?.draft ?? null)))
          : st.features,
  })), ...configuredStudios(s.history.present)];
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
      s.setRebuildResult(result.parts, result.featureErrors, result.durationMs, result.rebuilt, result.studioOrder, result.sketchLinks);
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
  let lastDraft = useStore.getState().editing?.draft ?? null;
  let lastDoc = useStore.getState().history.present;
  let lastRollback = useStore.getState().rollbackTo;
  let lastConfigured = configuredKey(useStore.getState().history.present);

  const unsubscribe = useStore.subscribe((s) => {
    const draft = s.editing?.draft ?? null;
    if (
      s.history.present.features !== lastFeatures ||
      draft !== lastDraft ||
      s.rollbackTo !== lastRollback ||
      s.history.present.variables !== lastVariables ||
      s.history.present.partNames !== lastPartNames ||
      s.history.present.partStudios !== lastStudios ||
      configuredKey(s.history.present) !== lastConfigured
    ) {
      lastConfigured = configuredKey(s.history.present);
      lastStudios = s.history.present.partStudios;
      lastPartNames = s.history.present.partNames;
      lastFeatures = s.history.present.features;
      lastVariables = s.history.present.variables;
      lastDraft = draft;
      lastRollback = s.rollbackTo;
      if (s.kernelStatus === "ready") rebuild();
    }
    if (s.history.present !== lastDoc) {
      lastDoc = s.history.present;
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(lastDoc));
        storageWarned = false;
      } catch {
        // Storage full (e.g. a big imported file) or blocked: the session still works, but say so once.
        if (!storageWarned && globalThis.localStorage) {
          storageWarned = true;
          useStore.getState().showToast("This design is too big for the browser to keep automatically. Use Save to keep it as a file.", "error");
        }
      }
    }
  });

  return () => {
    unsubscribe();
    kernel.terminate();
    client = null;
  };
}
