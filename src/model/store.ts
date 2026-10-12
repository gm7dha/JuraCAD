import { create } from "zustand";

import type { PartMesh } from "../kernel/protocol";
import {
  addFeature,
  commit,
  createFeature,
  emptyDocument,
  historyOf,
  parseDocument,
  redo as redoHistory,
  removeFeature,
  renameFeature,
  replaceFeature,
  setSuppressed,
  undo as undoHistory,
  type History,
} from "./document";
import { resolveParams } from "./features";
import type { Feature, FeatureType, PartSmithDocument } from "./types";

export interface SelectionItem {
  partId: string;
  kind: "face" | "edge";
  /** Face or edge number within the part. */
  index: number;
}

/** The default planes, as in Onshape. Top = XY, Front = XZ, Right = YZ. */
export type PlaneName = "Top" | "Front" | "Right";
/** Default geometry listed at the top of the feature list. */
export type DatumName = "Origin" | PlaneName;

export interface Editing {
  mode: "create" | "edit";
  draft: Feature;
}

export type DialogName = "check" | "export" | "help" | null;

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "success" | "error";
}

export interface AppState {
  history: History;
  editing: Editing | null;
  /** Feature highlighted in the feature list. */
  selectedFeatureId: string | null;
  /** Faces and edges picked in the viewport. */
  selection: SelectionItem[];
  hiddenParts: string[];
  /** Default plane picked in the list or viewport (planes and faces aren't selected together). */
  selectedPlane: PlaneName | null;
  /** Plane whose row the pointer is over in the feature list (highlighted in the viewport). */
  listHoverPlane: PlaneName | null;
  hiddenDatums: DatumName[];

  kernelStatus: "loading" | "ready" | "failed";
  kernelError: string | null;
  rebuildBusy: boolean;
  parts: PartMesh[];
  featureErrors: Record<string, string>;
  lastRebuildMs: number | null;

  dialog: DialogName;
  toast: Toast | null;

  // actions
  startCreate: (type: FeatureType) => void;
  startEdit: (id: string) => void;
  setDraftParam: (key: string, value: string) => void;
  setDraftField: (patch: Partial<Pick<Feature, "name" | "operation">>) => void;
  commitDraft: () => boolean;
  cancelDraft: () => void;
  deleteFeature: (id: string) => void;
  toggleSuppressed: (id: string) => void;
  renameFeature: (id: string, name: string) => void;
  renameDocument: (name: string) => void;
  newDocument: () => void;
  undo: () => void;
  redo: () => void;
  selectFeature: (id: string | null) => void;
  setSelection: (items: SelectionItem[]) => void;
  toggleHidden: (partId: string) => void;
  selectPlane: (plane: PlaneName | null) => void;
  setListHoverPlane: (plane: PlaneName | null) => void;
  toggleDatum: (datum: DatumName) => void;
  openDialog: (d: DialogName) => void;
  showToast: (text: string, tone?: Toast["tone"]) => void;

  // set by the kernel connection
  setKernelStatus: (status: AppState["kernelStatus"], error?: string) => void;
  setRebuildBusy: (busy: boolean) => void;
  setRebuildResult: (parts: PartMesh[], featureErrors: Record<string, string>, ms: number) => void;
}

export const STORAGE_KEY = "partsmith.document.v1";

function loadSavedDocument(): PartSmithDocument {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const doc = parseDocument(JSON.parse(raw));
      if (doc) return doc;
    }
  } catch {
    // storage unavailable or corrupt: start fresh
  }
  return emptyDocument();
}

let toastCounter = 0;

export const useStore = create<AppState>((set, get) => {
  /** Apply a document change and record it for undo. */
  const change = (fn: (doc: PartSmithDocument) => PartSmithDocument) =>
    set((s) => ({ history: commit(s.history, fn(s.history.present)) }));

  return {
    history: historyOf(loadSavedDocument()),
    editing: null,
    selectedFeatureId: null,
    selection: [],
    hiddenParts: [],
    selectedPlane: null,
    listHoverPlane: null,
    hiddenDatums: [],

    kernelStatus: "loading",
    kernelError: null,
    rebuildBusy: false,
    parts: [],
    featureErrors: {},
    lastRebuildMs: null,

    dialog: null,
    toast: null,

    startCreate: (type) => {
      const doc = get().history.present;
      set({ editing: { mode: "create", draft: createFeature(doc, type) }, selectedFeatureId: null });
    },

    startEdit: (id) => {
      const f = get().history.present.features.find((x) => x.id === id);
      if (!f) return;
      set({ editing: { mode: "edit", draft: { ...f, params: { ...f.params } } }, selectedFeatureId: id });
    },

    setDraftParam: (key, value) =>
      set((s) =>
        s.editing ? { editing: { ...s.editing, draft: { ...s.editing.draft, params: { ...s.editing.draft.params, [key]: value } } } } : {},
      ),

    setDraftField: (patch) =>
      set((s) => (s.editing ? { editing: { ...s.editing, draft: { ...s.editing.draft, ...patch } } } : {})),

    commitDraft: () => {
      const { editing } = get();
      if (!editing) return false;
      const { errors } = resolveParams(editing.draft);
      if (Object.keys(errors).length > 0) return false;
      const draft = { ...editing.draft, name: editing.draft.name.trim() || "Unnamed feature" };
      change((doc) => (editing.mode === "create" ? addFeature(doc, draft) : replaceFeature(doc, draft)));
      set({ editing: null, selectedFeatureId: draft.id });
      return true;
    },

    cancelDraft: () => set({ editing: null }),

    deleteFeature: (id) => {
      change((doc) => removeFeature(doc, id));
      set((s) => ({
        selectedFeatureId: s.selectedFeatureId === id ? null : s.selectedFeatureId,
        editing: s.editing?.draft.id === id ? null : s.editing,
      }));
    },

    toggleSuppressed: (id) => {
      const f = get().history.present.features.find((x) => x.id === id);
      if (f) change((doc) => setSuppressed(doc, id, !f.suppressed));
    },

    renameFeature: (id, name) => change((doc) => renameFeature(doc, id, name)),

    renameDocument: (name) => {
      const trimmed = name.trim();
      if (trimmed && trimmed !== get().history.present.name) change((doc) => ({ ...doc, name: trimmed }));
    },

    newDocument: () =>
      set((s) => ({
        history: commit(s.history, emptyDocument()),
        editing: null,
        selectedFeatureId: null,
        selection: [],
        hiddenParts: [],
      })),

    // Undo/redo only when no feature dialog is open (see App shortcuts).
    undo: () => set((s) => (s.editing ? {} : { history: undoHistory(s.history), selection: [] })),
    redo: () => set((s) => (s.editing ? {} : { history: redoHistory(s.history), selection: [] })),

    selectFeature: (id) => set((s) => ({ selectedFeatureId: id, selectedPlane: id ? null : s.selectedPlane })),
    setSelection: (items) =>
      set((s) => ({ selection: items, selectedPlane: items.length > 0 ? null : s.selectedPlane })),
    toggleHidden: (partId) =>
      set((s) => ({
        hiddenParts: s.hiddenParts.includes(partId) ? s.hiddenParts.filter((p) => p !== partId) : [...s.hiddenParts, partId],
      })),

    selectPlane: (plane) =>
      set((s) => ({
        selectedPlane: plane,
        selection: plane ? [] : s.selection,
        selectedFeatureId: plane ? null : s.selectedFeatureId,
      })),
    setListHoverPlane: (listHoverPlane) => set({ listHoverPlane }),
    toggleDatum: (datum) =>
      set((s) => {
        const hidden = s.hiddenDatums.includes(datum);
        return {
          hiddenDatums: hidden ? s.hiddenDatums.filter((d) => d !== datum) : [...s.hiddenDatums, datum],
          // A hidden plane can't stay selected.
          selectedPlane: !hidden && s.selectedPlane === datum ? null : s.selectedPlane,
        };
      }),

    openDialog: (dialog) => set({ dialog }),

    showToast: (text, tone = "info") => set({ toast: { id: ++toastCounter, text, tone } }),

    setKernelStatus: (kernelStatus, error) => set({ kernelStatus, kernelError: error ?? null }),
    setRebuildBusy: (rebuildBusy) => set({ rebuildBusy }),
    setRebuildResult: (parts, featureErrors, ms) =>
      set((s) => {
        const ids = new Set(parts.map((p) => p.id));
        return {
          parts,
          featureErrors,
          lastRebuildMs: ms,
          rebuildBusy: false,
          // Drop picks and hidden flags for parts that no longer exist.
          selection: s.selection.filter((x) => ids.has(x.partId)),
          hiddenParts: s.hiddenParts.filter((p) => ids.has(p)),
        };
      }),
  };
});

/** The current document (without any unsaved draft). */
export const useDocument = () => useStore((s) => s.history.present);
