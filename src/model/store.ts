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
import { sameRef, type TopoPick } from "../geometry/topoRef";
import type { SketchPlane } from "../sketch/planes";
import type { SketchData } from "../sketch/types";
import { setCurrentScope } from "./expr";
import { applyVariables, resolveVariables, type Variable } from "./variables";
import { isPatternFeature, isPickFeature, isSketchSolid, isSolidFeature, resolveParams } from "./features";
import { defaultAxis } from "../sketch/axis";
import type { Feature, FeatureType, ImportedFile, PartSmithDocument } from "./types";
import { importName } from "./importFile";

export interface SelectionItem {
  partId: string;
  kind: "face" | "edge";
  /** Face or edge number within the part. */
  index: number;
}

/** What a picked face or edge looks like, so a feature can find it again after rebuilds. */
export function pickFor(parts: PartMesh[], item: SelectionItem): TopoPick | null {
  const part = parts.find((p) => p.id === item.partId);
  const ref = item.kind === "edge" ? part?.edgeRefs?.[item.index] : part?.faceRefs?.[item.index];
  if (!ref || (ref.kind === "edge" ? ref.curve : ref.surface) === "UNKNOWN") return null;
  return { partId: item.partId, ref };
}

/** The default planes, as in Onshape. Top = XY, Front = XZ, Right = YZ. */
export type PlaneName = "Top" | "Front" | "Right";
/** Default geometry listed at the top of the feature list. */
export type DatumName = "Origin" | PlaneName;

export interface Editing {
  mode: "create" | "edit";
  draft: Feature;
}

export type SketchTool =
  | "select"
  | "line"
  | "rectangle"
  | "circle"
  | "arc"
  | "point"
  | "dimension"
  | "slot"
  | "polygon"
  | "sketchFillet"
  | "trim";

/** State while a sketch is open for editing. */
export interface SketchSession {
  /** Sketch undo history (separate from the document's, like Onshape). */
  past: SketchData[];
  future: SketchData[];
  tool: SketchTool;
  /** Selected point, curve and constraint ids. */
  selection: string[];
  /** New lines, circles and arcs are construction geometry. */
  construction: boolean;
  /** Hint or problem shown in the sketch panel. */
  message: { text: string; tone: "info" | "error" } | null;
  /** Dimension whose value box is open. */
  editingDimension: string | null;
  /** Polygon tool: number of sides. */
  polygonSides: number;
  /** Corner-rounding tool: radius as typed. */
  filletRadius: string;
}

/** Section view (display only — not saved): cut the view along a default plane. */
export interface SectionView {
  plane: PlaneName;
  /** Position of the cut along the plane's direction, mm. */
  offset: number;
  /** Show the other side. */
  flip: boolean;
}

export type DialogName = "check" | "export" | "help" | "variables" | "insert" | null;

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "success" | "error";
}

export interface AppState {
  history: History;
  editing: Editing | null;
  /** Present while the feature being edited is a sketch. */
  sketch: SketchSession | null;
  /** Feature highlighted in the feature list. */
  selectedFeatureId: string | null;
  /** The section view, when one is on. */
  section: SectionView | null;
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
  /** The tab on show: an assembly's id, or null for the Part Studio. */
  activeTab: string | null;
  /** Instances selected in the assembly on show. */
  asmSelection: string[];
  /** Instances hidden in the 3D view. */
  hiddenInstances: string[];
  /** The design as last saved to (or opened from) a file; compare with history.present to see unsaved changes. */
  savedDoc: PartSmithDocument | null;
  /** Name of that file, e.g. "Bracket.partsmith". */
  fileName: string | null;

  // actions
  startCreate: (type: FeatureType) => void;
  startEdit: (id: string) => void;
  /** Start importing a STEP or STL file (opens the Import dialog with a preview). */
  startImport: (file: ImportedFile) => void;
  setDraftParam: (key: string, value: string) => void;
  setDraftField: (patch: Partial<Pick<Feature, "name" | "operation" | "sketchRef" | "extrude" | "revolve" | "picks" | "pattern" | "mirror" | "hole" | "transform" | "import">>) => void;
  /** Fillet/chamfer: add a picked edge or face, or remove it if it's already picked. */
  toggleDraftPick: (pick: TopoPick) => void;
  /** Mirror/pattern: add a feature to repeat, or remove it if it's already there. */
  toggleDraftSource: (featureId: string) => void;
  /** Mirror: the plane to mirror across. */
  setDraftMirrorPlane: (plane: SketchPlane) => void;
  /** Open a new sketch (plane may be chosen later). */
  startSketch: (plane: SketchPlane | null) => void;
  setSketchPlane: (plane: SketchPlane) => void;
  /** Replace the sketch being edited. `record` adds an undo step. */
  updateSketch: (data: SketchData, opts?: { record?: boolean; selection?: string[] }) => void;
  /** Record an undo step for a drag that's finished (`before` = sketch when the drag began). */
  recordSketchStep: (before: SketchData) => void;
  sketchUndo: () => void;
  sketchRedo: () => void;
  setSketchTool: (tool: SketchTool) => void;
  setSketchSelection: (ids: string[]) => void;
  setSketchMessage: (text: string | null, tone?: "info" | "error") => void;
  setSketchConstruction: (on: boolean) => void;
  setEditingDimension: (id: string | null) => void;
  setSketchOptions: (patch: Partial<Pick<SketchSession, "polygonSides" | "filletRadius">>) => void;
  commitDraft: () => boolean;
  cancelDraft: () => void;
  deleteFeature: (id: string) => void;
  toggleSuppressed: (id: string) => void;
  renameFeature: (id: string, name: string) => void;
  renameDocument: (name: string) => void;
  /** Colour a part (null = back to the default grey). One undo step. */
  setPartColour: (partId: string, colour: string | null) => void;
  /** Replace the variable list (one undo step); renames are followed everywhere. */
  setVariables: (variables: Variable[]) => void;
  newDocument: () => void;
  /** Replace the design with one opened from a file (undoable). */
  openDocument: (doc: PartSmithDocument, fileName: string) => void;
  /** Note that the current design has just been saved to this file. */
  markSaved: (fileName: string) => void;
  /** Add an assembly tab and switch to it. */
  addAssembly: () => void;
  /** Show the Part Studio (null) or an assembly. */
  setActiveTab: (id: string | null) => void;
  removeAssembly: (id: string) => void;
  renameAssembly: (id: string, name: string) => void;
  /** Put a copy of a part into the assembly on show. */
  insertInstance: (part: { id: string; name: string }, placement?: Placement) => void;
  updateInstance: (id: string, patch: Partial<Pick<Instance, "name" | "placement" | "fixed">>) => void;
  removeInstances: (ids: string[]) => void;
  setAsmSelection: (ids: string[]) => void;
  toggleInstanceHidden: (id: string) => void;
  undo: () => void;
  redo: () => void;
  selectFeature: (id: string | null) => void;
  setSelection: (items: SelectionItem[]) => void;
  toggleHidden: (partId: string) => void;
  selectPlane: (plane: PlaneName | null) => void;
  setListHoverPlane: (plane: PlaneName | null) => void;
  toggleDatum: (datum: DatumName) => void;
  openDialog: (d: DialogName) => void;
  setSection: (section: SectionView | null) => void;
  showToast: (text: string, tone?: Toast["tone"]) => void;

  // set by the kernel connection
  setKernelStatus: (status: AppState["kernelStatus"], error?: string) => void;
  setRebuildBusy: (busy: boolean) => void;
  setRebuildResult: (parts: PartMesh[], featureErrors: Record<string, string>, ms: number) => void;
}

export const STORAGE_KEY = "partsmith.document.v1";
/** Which file the design in browser storage was last saved to, so "Saved" survives a page refresh. */
const FILE_KEY = "partsmith.file.v1";

/** A short fingerprint of a design, to tell whether it changed since it was saved. */
export function fingerprint(doc: PartSmithDocument): string {
  const text = JSON.stringify(doc);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${h >>> 0}`;
}

function rememberFile(doc: PartSmithDocument, fileName: string | null) {
  try {
    if (fileName) globalThis.localStorage?.setItem(FILE_KEY, JSON.stringify({ fileName, print: fingerprint(doc) }));
    else globalThis.localStorage?.removeItem(FILE_KEY);
  } catch {
    // storage blocked: only the label is affected
  }
}

/** The saved-file label for a design just loaded from browser storage. */
function savedFileFor(doc: PartSmithDocument): { savedDoc: PartSmithDocument | null; fileName: string | null } {
  try {
    const raw = globalThis.localStorage?.getItem(FILE_KEY);
    if (raw) {
      const f = JSON.parse(raw) as { fileName?: unknown; print?: unknown };
      if (typeof f.fileName === "string") return { savedDoc: f.print === fingerprint(doc) ? doc : null, fileName: f.fileName };
    }
  } catch {
    // ignore
  }
  return { savedDoc: null, fileName: null };
}

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

const newSession = (): SketchSession => ({
  past: [],
  future: [],
  tool: "line",
  selection: [],
  construction: false,
  message: null,
  editingDimension: null,
  polygonSides: 6,
  filletRadius: "2",
});

/** Is this id (point, curve or constraint) still in the sketch? */
const existsIn = (d: SketchData, id: string) =>
  d.points.some((p) => p.id === id) || d.curves.some((c) => c.id === id) || d.constraints.some((c) => c.id === id) || id === "origin";

export const useStore = create<AppState>((set, get) => {
  /** Apply a document change and record it for undo. */
  const change = (fn: (doc: PartSmithDocument) => PartSmithDocument) =>
    set((s) => ({ history: commit(s.history, fn(s.history.present)) }));

  const initialDoc = loadSavedDocument();
  return {
    ...savedFileFor(initialDoc),
    history: historyOf(initialDoc),
    editing: null,
    sketch: null,
    selectedFeatureId: null,
    selection: [],
    section: null,
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
    activeTab: null,
    asmSelection: [],
    hiddenInstances: [],

    startCreate: (type) => {
      const s = get();
      if (type === "sketch") {
        s.startSketch(s.selectedPlane ? { kind: "default", name: s.selectedPlane } : null);
        return;
      }
      const draft = createFeature(s.history.present, type);
      // Extrude or revolve the sketch that's highlighted in the list, if any.
      if (isSketchSolid(type)) {
        const picked = s.history.present.features.find((f) => f.id === s.selectedFeatureId && f.type === "sketch");
        if (picked) {
          draft.sketchRef = picked.id;
          if (type === "revolve" && picked.sketch) draft.revolve = { axis: defaultAxis(picked.sketch.data), flip: false };
        }
      }
      // Transform the part that's selected in the 3D view (or the latest part).
      if (type === "transform" && draft.transform) {
        const partId = s.selection[0]?.partId ?? s.parts[s.parts.length - 1]?.id;
        if (partId) draft.transform = { ...draft.transform, partId };
      }
      // A hole uses the sketch highlighted in the list, if any.
      if (type === "hole" && draft.hole) {
        const picked = s.history.present.features.find((f) => f.id === s.selectedFeatureId && f.type === "sketch");
        if (picked) draft.hole = { ...draft.hole, sketchRef: picked.id };
      }
      // Mirror and patterns start with the feature highlighted in the list, if it makes a solid.
      if (isPatternFeature(type)) {
        const picked = s.history.present.features.find((f) => f.id === s.selectedFeatureId && isSolidFeature(f.type));
        if (picked) {
          if (draft.mirror) draft.mirror = { ...draft.mirror, sources: [picked.id] };
          if (draft.pattern) draft.pattern = { ...draft.pattern, sources: [picked.id] };
        }
      }
      // Fillet, chamfer and shell start with whatever is selected (faces only, for shell).
      if (isPickFeature(type)) {
        draft.picks = s.selection
          .filter((item) => type !== "shell" || item.kind === "face")
          .map((item) => pickFor(s.parts, item))
          .filter((p): p is TopoPick => p !== null);
      }
      set({ editing: { mode: "create", draft }, sketch: null, selectedFeatureId: null, selection: [], selectedPlane: null });
    },

    startImport: (file) => {
      const s = get();
      const draft = createFeature(s.history.present, "import");
      draft.import = file;
      const base = importName(file.fileName);
      const used = new Set(s.history.present.features.map((f) => f.name));
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base} (${n})`;
      draft.name = name;
      set({ editing: { mode: "create", draft }, sketch: null, selectedFeatureId: null, selection: [], selectedPlane: null });
    },

    startEdit: (id) => {
      const f = get().history.present.features.find((x) => x.id === id);
      if (!f) return;
      set({
        editing: { mode: "edit", draft: { ...f, params: { ...f.params } } },
        sketch: f.type === "sketch" ? newSession() : null,
        selectedFeatureId: id,
        selectedPlane: null,
        selection: [],
      });
    },

    startSketch: (plane) => {
      const draft = createFeature(get().history.present, "sketch");
      draft.sketch = { plane, data: draft.sketch!.data };
      set({
        editing: { mode: "create", draft },
        sketch: {
          ...newSession(),
          message: plane ? null : { text: "Click Top, Front or Right in the feature list, or a flat face, to sketch on it.", tone: "info" },
        },
        selectedFeatureId: null,
        selectedPlane: null,
        selection: [],
      });
    },

    setSketchPlane: (plane) =>
      set((s) =>
        s.editing?.draft.sketch
          ? {
              editing: { ...s.editing, draft: { ...s.editing.draft, sketch: { ...s.editing.draft.sketch, plane } } },
              sketch: s.sketch ? { ...s.sketch, message: null } : s.sketch,
              selectedPlane: null,
              selection: [],
            }
          : {},
      ),

    updateSketch: (data, opts = {}) =>
      set((s) => {
        if (!s.editing?.draft.sketch || !s.sketch) return {};
        const prev = s.editing.draft.sketch.data;
        if (prev === data) return opts.selection ? { sketch: { ...s.sketch, selection: opts.selection } } : {};
        return {
          editing: { ...s.editing, draft: { ...s.editing.draft, sketch: { ...s.editing.draft.sketch, data } } },
          sketch: {
            ...s.sketch,
            past: opts.record === false ? s.sketch.past : [...s.sketch.past, prev].slice(-200),
            future: opts.record === false ? s.sketch.future : [],
            selection: opts.selection ?? s.sketch.selection.filter((id) => existsIn(data, id)),
          },
        };
      }),

    recordSketchStep: (before) =>
      set((s) => {
        if (!s.sketch || !s.editing?.draft.sketch || s.editing.draft.sketch.data === before) return {};
        return { sketch: { ...s.sketch, past: [...s.sketch.past, before].slice(-200), future: [] } };
      }),

    sketchUndo: () =>
      set((s) => {
        if (!s.sketch || !s.editing?.draft.sketch || s.sketch.past.length === 0) return {};
        const prev = s.sketch.past[s.sketch.past.length - 1];
        return {
          editing: { ...s.editing, draft: { ...s.editing.draft, sketch: { ...s.editing.draft.sketch, data: prev } } },
          sketch: {
            ...s.sketch,
            past: s.sketch.past.slice(0, -1),
            future: [s.editing.draft.sketch.data, ...s.sketch.future],
            selection: [],
            editingDimension: null,
          },
        };
      }),

    sketchRedo: () =>
      set((s) => {
        if (!s.sketch || !s.editing?.draft.sketch || s.sketch.future.length === 0) return {};
        const [next, ...rest] = s.sketch.future;
        return {
          editing: { ...s.editing, draft: { ...s.editing.draft, sketch: { ...s.editing.draft.sketch, data: next } } },
          sketch: { ...s.sketch, past: [...s.sketch.past, s.editing.draft.sketch.data], future: rest, selection: [], editingDimension: null },
        };
      }),

    setSketchTool: (tool) =>
      set((s) => (s.sketch ? { sketch: { ...s.sketch, tool, message: null, editingDimension: null } } : {})),
    setSketchSelection: (selection) => set((s) => (s.sketch ? { sketch: { ...s.sketch, selection } } : {})),
    setSketchMessage: (text, tone = "info") =>
      set((s) => (s.sketch ? { sketch: { ...s.sketch, message: text ? { text, tone } : null } } : {})),
    setSketchConstruction: (construction) => set((s) => (s.sketch ? { sketch: { ...s.sketch, construction } } : {})),
    setSketchOptions: (patch) => set((s) => (s.sketch ? { sketch: { ...s.sketch, ...patch } } : {})),
    setEditingDimension: (editingDimension) => set((s) => (s.sketch ? { sketch: { ...s.sketch, editingDimension } } : {})),

    setDraftParam: (key, value) =>
      set((s) =>
        s.editing ? { editing: { ...s.editing, draft: { ...s.editing.draft, params: { ...s.editing.draft.params, [key]: value } } } } : {},
      ),

    setDraftField: (patch) =>
      set((s) => (s.editing ? { editing: { ...s.editing, draft: { ...s.editing.draft, ...patch } } } : {})),

    toggleDraftPick: (pick) =>
      set((s) => {
        if (!s.editing) return {};
        const picks = s.editing.draft.picks ?? [];
        const i = picks.findIndex((p) => p.partId === pick.partId && sameRef(p.ref, pick.ref));
        const next = i >= 0 ? picks.filter((_, j) => j !== i) : [...picks, pick];
        return { editing: { ...s.editing, draft: { ...s.editing.draft, picks: next } } };
      }),

    toggleDraftSource: (featureId) =>
      set((s) => {
        if (!s.editing) return {};
        const d = s.editing.draft;
        const toggle = (list: string[]) => (list.includes(featureId) ? list.filter((x) => x !== featureId) : [...list, featureId]);
        if (d.mirror) return { editing: { ...s.editing, draft: { ...d, mirror: { ...d.mirror, sources: toggle(d.mirror.sources) } } } };
        if (d.pattern) return { editing: { ...s.editing, draft: { ...d, pattern: { ...d.pattern, sources: toggle(d.pattern.sources) } } } };
        return {};
      }),

    setDraftMirrorPlane: (plane) =>
      set((s) =>
        s.editing?.draft.mirror ? { editing: { ...s.editing, draft: { ...s.editing.draft, mirror: { ...s.editing.draft.mirror, plane } } } } : {},
      ),

    commitDraft: () => {
      const { editing } = get();
      if (!editing) return false;
      if (editing.draft.type === "sketch" && !editing.draft.sketch?.plane) {
        get().setSketchMessage("Pick a plane or flat face to sketch on first.", "error");
        return false;
      }
      const { errors } = resolveParams(editing.draft);
      if (Object.keys(errors).length > 0) return false;
      const draft = { ...editing.draft, name: editing.draft.name.trim() || "Unnamed feature" };
      change((doc) => (editing.mode === "create" ? addFeature(doc, draft) : replaceFeature(doc, draft)));
      set({ editing: null, sketch: null, selectedFeatureId: draft.id });
      return true;
    },

    cancelDraft: () => set({ editing: null, sketch: null }),

    deleteFeature: (id) => {
      change((doc) => removeFeature(doc, id));
      set((s) => ({
        selectedFeatureId: s.selectedFeatureId === id ? null : s.selectedFeatureId,
        editing: s.editing?.draft.id === id ? null : s.editing,
        sketch: s.editing?.draft.id === id ? null : s.sketch,
      }));
    },

    toggleSuppressed: (id) => {
      const f = get().history.present.features.find((x) => x.id === id);
      if (f) change((doc) => setSuppressed(doc, id, !f.suppressed));
    },

    renameFeature: (id, name) => change((doc) => renameFeature(doc, id, name)),

    setPartColour: (partId, colour) =>
      change((doc) => {
        const appearance = { ...(doc.appearance ?? {}) };
        if (colour) appearance[partId] = colour;
        else delete appearance[partId];
        const { appearance: _old, ...rest } = doc;
        return Object.keys(appearance).length ? { ...rest, appearance } : rest;
      }),

    setVariables: (variables) => change((doc) => applyVariables(doc, variables)),

    renameDocument: (name) => {
      const trimmed = name.trim();
      if (trimmed && trimmed !== get().history.present.name) change((doc) => ({ ...doc, name: trimmed }));
    },

    newDocument: () => {
      set((s) => ({
        history: commit(s.history, emptyDocument()),
        editing: null,
        sketch: null,
        selectedFeatureId: null,
        selection: [],
        hiddenParts: [],
        activeTab: null,
        asmSelection: [],
        savedDoc: null,
        fileName: null,
      }));
      rememberFile(get().history.present, null);
    },

    openDocument: (doc, fileName) => {
      set((s) => ({
        history: commit(s.history, doc),
        editing: null,
        sketch: null,
        selectedFeatureId: null,
        selection: [],
        selectedPlane: null,
        hiddenParts: [],
        activeTab: null,
        asmSelection: [],
        fileName,
      }));
      set((s) => ({ savedDoc: s.history.present }));
      rememberFile(get().history.present, fileName);
    },

    markSaved: (fileName) => {
      set((s) => ({ savedDoc: s.history.present, fileName }));
      rememberFile(get().history.present, fileName);
    },

    addAssembly: () => {
      const before = new Set((get().history.present.assemblies ?? []).map((a) => a.id));
      change((doc) => addAssembly(doc));
      const added = (get().history.present.assemblies ?? []).find((a) => !before.has(a.id));
      if (added) set({ activeTab: added.id, asmSelection: [], selection: [], selectedPlane: null, editing: null, sketch: null });
    },

    setActiveTab: (activeTab) => {
      if (get().editing) return;
      set({ activeTab, asmSelection: [], selection: [], selectedPlane: null, section: null });
    },

    removeAssembly: (id) => {
      change((doc) => removeAssembly(doc, id));
      if (get().activeTab === id) set({ activeTab: null, asmSelection: [] });
    },

    renameAssembly: (id, name) => change((doc) => renameAssembly(doc, id, name)),

    insertInstance: (part, placement) => {
      const tab = get().activeTab;
      if (!tab) return;
      const before = new Set(activeAssembly(get())?.instances.map((i) => i.id) ?? []);
      change((doc) => insertInstance(doc, tab, part, placement));
      const added = activeAssembly(get())?.instances.find((i) => !before.has(i.id));
      if (added) set({ asmSelection: [added.id] });
    },

    updateInstance: (id, patch) => {
      const tab = get().activeTab;
      if (tab) change((doc) => updateInstance(doc, tab, id, patch));
    },

    removeInstances: (ids) => {
      const tab = get().activeTab;
      if (!tab || ids.length === 0) return;
      change((doc) => removeInstances(doc, tab, ids));
      set((s) => ({ asmSelection: s.asmSelection.filter((x) => !ids.includes(x)) }));
    },

    setAsmSelection: (asmSelection) => set({ asmSelection }),
    toggleInstanceHidden: (id) =>
      set((s) => ({ hiddenInstances: s.hiddenInstances.includes(id) ? s.hiddenInstances.filter((x) => x !== id) : [...s.hiddenInstances, id] })),

    // Undo/redo only when no feature dialog is open (see App shortcuts).
    undo: () => set((s) => (s.editing ? {} : { history: undoHistory(s.history), selection: [] })),
    // (While sketching, Ctrl+Z goes to sketchUndo instead — see App shortcuts.)
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
    setSection: (section) => set({ section }),

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

/** The assembly on show, or null when the Part Studio is on show (or the assembly was undone away). */
export function activeAssembly(s: Pick<AppState, "activeTab" | "history">): Assembly | null {
  if (!s.activeTab) return null;
  return s.history.present.assemblies?.find((a) => a.id === s.activeTab) ?? null;
}

/** The current document (without any unsaved draft). */
export const useDocument = () => useStore((s) => s.history.present);

// Keep the maths boxes' variable values in step with the document (including after undo/redo).
let scopeFor: Variable[] | undefined | null = null;
function syncScope(variables: Variable[] | undefined) {
  if (variables === scopeFor) return;
  scopeFor = variables;
  setCurrentScope(resolveVariables(variables).values);
}
syncScope(useStore.getState().history.present.variables);
useStore.subscribe((s) => syncScope(s.history.present.variables));
