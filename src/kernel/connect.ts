import { featuresWithDraft } from "../model/document";
import { resolveVariables } from "../model/variables";
import { STORAGE_KEY, useStore } from "../model/store";

/** Whether the "too big to keep" message has been shown since the last successful keep. */
let storageWarned = false;
import type { Feature } from "../model/types";
import { KernelClient } from "./client";

let client: KernelClient | null = null;

export function getKernel(): KernelClient {
  if (!client) throw new Error("The geometry engine hasn't started yet.");
  return client;
}

/** The features to build right now: the saved list plus any feature being edited. */
function currentFeatures(): Feature[] {
  const s = useStore.getState();
  return featuresWithDraft(s.history.present.features, s.editing?.draft ?? null);
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
    kernel.requestRebuild(currentFeatures(), resolveVariables(doc.variables).values, doc.partNames ?? {}, (result) => {
      const s = useStore.getState();
      if (result instanceof Error) {
        s.setRebuildBusy(false);
        s.showToast(result.message, "error");
        return;
      }
      s.setRebuildResult(result.parts, result.featureErrors, result.durationMs);
    });
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
  let lastDraft = useStore.getState().editing?.draft ?? null;
  let lastDoc = useStore.getState().history.present;

  const unsubscribe = useStore.subscribe((s) => {
    const draft = s.editing?.draft ?? null;
    if (
      s.history.present.features !== lastFeatures ||
      draft !== lastDraft ||
      s.history.present.variables !== lastVariables ||
      s.history.present.partNames !== lastPartNames
    ) {
      lastPartNames = s.history.present.partNames;
      lastFeatures = s.history.present.features;
      lastVariables = s.history.present.variables;
      lastDraft = draft;
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
