import { create } from "zustand";

import type { PartMesh } from "../kernel/protocol";
import {
  addFeature,
  newId,
  commit,
  createFeature,
  emptyDocument,
  historyOf,
  parseDocument,
  redo as redoHistory,
  removeFeature,
  renameFeature,
  renamePart,
  replaceFeature,
  setSuppressed,
  undo as undoHistory,
  type History,
} from "./document";
import { sameRef, type TopoPick } from "../geometry/topoRef";
import type { SketchPlane } from "../sketch/planes";
import type { SketchData } from "../sketch/types";
import { setCurrentScope } from "./expr";
import { framesOf, planeAsSketchPlane, refreshDocumentPlanes } from "../sketch/planeFeature";
import { setLengthUnit, startingLength, type LengthUnit } from "./units";
import { applyVariables, resolveVariables, type Variable } from "./variables";
import { isPatternFeature, isPickFeature, isSketchSolid, isSolidFeature, resolveParams } from "./features";
import { defaultAxis } from "../sketch/axis";
import type { Assembly, Drawing, Feature, FeatureType, ImportedFile, Instance, Mate, MateConnector, MateType, PartSmithDocument } from "./types";
import { boundsOfVertices } from "../assembly/assembly";
import { addAssembly, insertInstance, putMate, removeAssembly, removeInstances, removeMate, renameAssembly, setExplode, settlePlacements, updateInstance } from "../assembly/assembly";
import { MATE_TYPES, nextMateName, solveWithParts } from "../assembly/mates";
import { addDrawing as addDrawingTo, removeDrawing as removeDrawingFrom, renameDrawing as renameDrawingIn, updateDrawing } from "../drawing/drawing";
import { withDragChange, type DragChange } from "../assembly/drag";
import type { Placement } from "../assembly/math";
import { importName } from "./importFile";
import { addStudio, inStudio, MAIN_STUDIO, removeStudio, renameStudio, studioExists, studioFeatures, studioView } from "./studios";

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

/** Drawing tools: select, the smart Dimension, baseline / chain / ordinate runs, and section. */
export type DrawingTool = "select" | "dimension" | "baseline" | "chain" | "ordinate" | "section";

export type SketchTool =
  | "select"
  | "line"
  | "rectangle"
  | "centreRectangle"
  | "circle"
  | "arc"
  | "tangentArc"
  | "point"
  | "dimension"
  | "slot"
  | "polygon"
  | "sketchFillet"
  | "trim"
  | "offset"
  | "mirror"
  | "sketchPattern"
  | "useEdge";

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
  /** Offset tool: distance as typed. */
  offsetDistance: string;
  /** Pattern tool: in a row or round a centre. */
  patternKind: "linear" | "circular";
  /** Pattern tool: how many, counting the original. */
  patternCount: number;
  /** Linear pattern: gap between copies as typed. */
  patternSpacing: string;
  /** Linear pattern: direction in degrees from X. Circular pattern: angle to spread over. */
  patternAngle: string;
  /** Circular pattern: the point to go round. */
  patternCentre: string;
}

/** Section view (display only — not saved): cut the view along a default plane. */
export interface SectionView {
  plane: PlaneName;
  /** Position of the cut along the plane's direction, mm. */
  offset: number;
  /** Show the other side. */
  flip: boolean;
}

/** A mate being made or changed; its two connectors may not be picked yet. */
export type MateDraft = Omit<Mate, "a" | "b"> & { a?: MateConnector; b?: MateConnector };

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
  /** Whole parts picked in the Parts list (for hiding, colouring or exporting several at once). */
  selectedParts: string[];
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
  /** The mate dialog, while open. */
  mateDraft: { mode: "create" | "edit"; mate: MateDraft } | null;
  /** Drawing tab: what clicks on the sheet do, and the selected dimension. */
  drawingTool: DrawingTool;
  selectedDim: string | null;
  /** What a mouse drag in an assembly is changing, while the button is held. */
  dragPreview: DragChange | null;
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
  setDraftField: (patch: Partial<Pick<Feature, "name" | "operation" | "sketchRef" | "extrude" | "revolve" | "picks" | "pattern" | "mirror" | "hole" | "transform" | "import" | "pathRef" | "sections" | "text" | "planeDef" | "booleanDef" | "splitDef" | "flipSide" | "neutral">>) => void;
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
  setSketchOptions: (patch: Partial<Pick<SketchSession, "polygonSides" | "filletRadius" | "offsetDistance" | "patternKind" | "patternCount" | "patternSpacing" | "patternAngle" | "patternCentre">>) => void;
  commitDraft: () => boolean;
  cancelDraft: () => void;
  /**
   * Turn features off (Delete face's "fillets in the way" prompt). With
   * `commit`, the open feature is added in the same undo step; otherwise it's dropped.
   */
  suppressThenFinish: (ids: string[], commit: boolean) => void;
  deleteFeature: (id: string) => void;
  toggleSuppressed: (id: string) => void;
  renameFeature: (id: string, name: string) => void;
  renameDocument: (name: string) => void;
  /** Name a part (blank goes back to "Part N"). One undo step. */
  renamePart: (partId: string, name: string) => void;
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
  /** Add a Part Studio tab and switch to it. */
  addPartStudio: () => void;
  /** Add a drawing tab (of the part selected or last shown) and switch to it. */
  addDrawing: () => void;
  /** Change the drawing on show (one undo step). */
  changeDrawing: (fn: (d: Drawing) => Drawing) => void;
  renameDrawing: (id: string, name: string) => void;
  removeDrawing: (id: string) => void;
  renamePartStudio: (id: string, name: string) => void;
  removePartStudio: (id: string) => void;
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
  startMate: (type: MateType) => void;
  editMate: (id: string) => void;
  setMateDraft: (patch: Partial<MateDraft>) => void;
  /** A face or edge clicked while the mate dialog is open: fills the first connector, then the second. */
  pickMateConnector: (c: MateConnector) => void;
  /** Save the mate (false if it isn't ready). */
  commitMateDraft: () => boolean;
  cancelMateDraft: () => void;
  deleteMate: (id: string) => void;
  toggleMateSuppressed: (id: string) => void;
  /** Exploded view of the assembly on show: how far apart (null = together). */
  setExplode: (amount: number | null) => void;
  /** Show and type lengths in millimetres or inches. */
  setUnits: (unit: LengthUnit) => void;
  /** Light or dark appearance (see app/theme.ts; not saved in designs). */
  theme: "light" | "dark";
  setTheme: (theme: "light" | "dark") => void;
  /** The exploded view's spread while its slider is being dragged (not saved until let go). */
  explodePreview: number | null;
  setExplodePreview: (amount: number | null) => void;
  setDragPreview: (change: DragChange | null) => void;
  setDrawingTool: (tool: DrawingTool) => void;
  selectDim: (id: string | null) => void;
  /** Keep what the drag did (one undo step). */
  commitDrag: () => void;
  undo: () => void;
  redo: () => void;
  selectFeature: (id: string | null) => void;
  setSelection: (items: SelectionItem[]) => void;
  toggleHidden: (partId: string) => void;
  setSelectedParts: (ids: string[]) => void;
  /** Boolean dialog: add a part to (or take it off) the list being picked. */
  toggleBooleanPart: (partId: string) => void;
  /**
   * Copy parts (a Move/copy feature with "copy" ticked), placed just to the
   * side. One part opens the Move/copy dialog to adjust; several are copied straight away.
   */
  duplicateParts: (ids: string[]) => void;
  /** Hide or show several parts at once. */
  setPartsHidden: (ids: string[], hidden: boolean) => void;
  selectPlane: (plane: PlaneName | null) => void;
  setListHoverPlane: (plane: PlaneName | null) => void;
  toggleDatum: (datum: DatumName) => void;
  openDialog: (d: DialogName) => void;
  setSection: (section: SectionView | null) => void;
  showToast: (text: string, tone?: Toast["tone"]) => void;

  // set by the kernel connection
  setKernelStatus: (status: AppState["kernelStatus"], error?: string) => void;
  setRebuildBusy: (busy: boolean) => void;
  setRebuildResult: (parts: PartMesh[], featureErrors: Record<string, string>, ms: number, rebuilt?: string[], studioOrder?: string[]) => void;
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
  offsetDistance: "2",
  patternKind: "linear",
  patternCount: 3,
  patternSpacing: "10",
  patternAngle: "0",
  patternCentre: "origin",
});

/** Is this id (point, curve or constraint) still in the sketch? */
const existsIn = (d: SketchData, id: string) =>
  d.points.some((p) => p.id === id) || d.curves.some((c) => c.id === id) || d.constraints.some((c) => c.id === id) || id === "origin";

export const useStore = create<AppState>((set, get) => {
  /** Apply a document change and record it for undo. */
  const change = (fn: (doc: PartSmithDocument) => PartSmithDocument) =>
    set((s) => {
      const next = fn(s.history.present);
      // Keep sketches (and anything else) on Plane features where their planes are now.
      const settled = next === s.history.present ? next : refreshDocumentPlanes(next, resolveVariables(next.variables).values);
      return { history: commit(s.history, settled) };
    });
  /** A change to the features of the Part Studio on show. */
  const changeStudio = (fn: (doc: PartSmithDocument) => PartSmithDocument) =>
    change((doc) => inStudio(doc, activeStudioId(get()) ?? MAIN_STUDIO, fn));
  /** The document as the Part Studio on show sees it (its features in `features`). */
  const view = () => studioView(get().history.present, activeStudioId(get()) ?? MAIN_STUDIO);

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
    selectedParts: [],
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
    mateDraft: null,
    dragPreview: null,
    drawingTool: "select",
    selectedDim: null,

    startCreate: (type) => {
      const s = get();
      if (type === "sketch") {
        // On the highlighted plane, or Plane feature, if any.
        const planeFeature = activeFeatures(s).find((f) => f.id === s.selectedFeatureId && f.type === "plane");
        const frame = planeFeature ? framesOf(activeFeatures(s)).get(planeFeature.id) : undefined;
        s.startSketch(planeFeature && frame ? planeAsSketchPlane(planeFeature, frame) : s.selectedPlane ? { kind: "default", name: s.selectedPlane } : null);
        return;
      }
      const draft = createFeature(view(), type);
      const features = activeFeatures(s);
      // Extrude or revolve the sketch that's highlighted in the list, if any.
      if (isSketchSolid(type)) {
        const picked = features.find((f) => f.id === s.selectedFeatureId && f.type === "sketch");
        if (picked) {
          draft.sketchRef = picked.id;
          if (type === "revolve" && picked.sketch) draft.revolve = { axis: defaultAxis(picked.sketch.data), flip: false };
        }
      }
      // Transform the part that's selected in the 3D view (or the latest part).
      if (type === "transform" && draft.transform) {
        const mine = studioParts(s);
        const partId = s.selection[0]?.partId ?? mine[mine.length - 1]?.id;
        if (partId) draft.transform = { ...draft.transform, partId };
      }
      // Split starts with the part picked in the Parts list (or clicked in the 3D view).
      if (type === "split" && draft.splitDef) {
        const partId = s.selectedParts[0] ?? s.selection[0]?.partId;
        if (partId) draft.splitDef = { ...draft.splitDef, partId, picking: "plane" };
        if (s.selectedPlane) draft.splitDef = { ...draft.splitDef, plane: { kind: "default", name: s.selectedPlane } };
      }
      // Face features start with the faces selected.
      if (type === "thicken" || type === "draft" || type === "moveFace" || type === "deleteFace" || type === "thread") {
        draft.picks = s.selection
          .filter((item) => item.kind === "face")
          .map((item) => pickFor(s.parts, item))
          .filter((p): p is TopoPick => p !== null);
      }
      // A rib uses the sketch highlighted in the list, if any.
      if (type === "rib") {
        const picked = features.find((f) => f.id === s.selectedFeatureId && f.type === "sketch");
        if (picked) draft.sketchRef = picked.id;
      }
      // A Boolean starts with the parts picked in the Parts list.
      if (type === "boolean" && draft.booleanDef && s.selectedParts.length) draft.booleanDef = { ...draft.booleanDef, targets: [...s.selectedParts] };
      // A plane starts from the plane (or Plane feature) highlighted, if any.
      if (type === "plane" && draft.planeDef) {
        const picked = features.find((f) => f.id === s.selectedFeatureId && f.type === "plane");
        const frame = picked ? framesOf(features).get(picked.id) : undefined;
        if (picked && frame) draft.planeDef = { ...draft.planeDef, ref: planeAsSketchPlane(picked, frame) };
        else if (s.selectedPlane) draft.planeDef = { ...draft.planeDef, ref: { kind: "default", name: s.selectedPlane } };
      }
      // A hole uses the sketch highlighted in the list, if any.
      if (type === "hole" && draft.hole) {
        const picked = features.find((f) => f.id === s.selectedFeatureId && f.type === "sketch");
        if (picked) draft.hole = { ...draft.hole, sketchRef: picked.id };
      }
      // Mirror and patterns start with the feature highlighted in the list, if it makes a solid.
      if (isPatternFeature(type)) {
        const picked = features.find((f) => f.id === s.selectedFeatureId && isSolidFeature(f.type));
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
      const draft = createFeature(view(), "import");
      draft.import = file;
      const base = importName(file.fileName);
      const used = new Set(activeFeatures(s).map((f) => f.name));
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base} (${n})`;
      draft.name = name;
      set({ editing: { mode: "create", draft }, sketch: null, selectedFeatureId: null, selection: [], selectedPlane: null });
    },

    startEdit: (id) => {
      const f = activeFeatures(get()).find((x) => x.id === id);
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
      const draft = createFeature(view(), "sketch");
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
      changeStudio((doc) => (editing.mode === "create" ? addFeature(doc, draft) : replaceFeature(doc, draft)));
      set({ editing: null, sketch: null, selectedFeatureId: draft.id });
      return true;
    },

    cancelDraft: () => set({ editing: null, sketch: null }),

    suppressThenFinish: (ids, commit) => {
      const { editing } = get();
      const off = (doc: PartSmithDocument) => ids.reduce((d, id) => setSuppressed(d, id, true), doc);
      if (commit && editing) {
        const draft = { ...editing.draft, name: editing.draft.name.trim() || "Unnamed feature" };
        changeStudio((doc) => {
          const d = off(doc);
          return editing.mode === "create" ? addFeature(d, draft) : replaceFeature(d, draft);
        });
        set({ editing: null, sketch: null, selectedFeatureId: draft.id });
        return;
      }
      changeStudio(off);
      set({ editing: null, sketch: null });
    },

    deleteFeature: (id) => {
      changeStudio((doc) => removeFeature(doc, id));
      set((s) => ({
        selectedFeatureId: s.selectedFeatureId === id ? null : s.selectedFeatureId,
        editing: s.editing?.draft.id === id ? null : s.editing,
        sketch: s.editing?.draft.id === id ? null : s.sketch,
      }));
    },

    toggleSuppressed: (id) => {
      const f = activeFeatures(get()).find((x) => x.id === id);
      if (f) changeStudio((doc) => setSuppressed(doc, id, !f.suppressed));
    },

    renameFeature: (id, name) => changeStudio((doc) => renameFeature(doc, id, name)),

    setPartColour: (partId, colour) =>
      change((doc) => {
        const appearance = { ...(doc.appearance ?? {}) };
        if (colour) appearance[partId] = colour;
        else delete appearance[partId];
        const { appearance: _old, ...rest } = doc;
        return Object.keys(appearance).length ? { ...rest, appearance } : rest;
      }),

    setVariables: (variables) => change((doc) => applyVariables(doc, variables)),

    renamePart: (partId, name) => {
      const old = get().parts.find((p) => p.id === partId)?.name ?? "";
      if (name.trim() === old) return;
      change((doc) => renamePart(doc, partId, old, name));
    },

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
        selectedParts: [],
        activeTab: null,
        asmSelection: [],
        mateDraft: null,
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
        selectedParts: [],
        activeTab: null,
        asmSelection: [],
        mateDraft: null,
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
      set({ activeTab, asmSelection: [], selection: [], selectedParts: [], selectedPlane: null, selectedFeatureId: null, section: null, mateDraft: null, drawingTool: "select", selectedDim: null });
    },

    removeAssembly: (id) => {
      change((doc) => removeAssembly(doc, id));
      if (get().activeTab === id) set({ activeTab: null, asmSelection: [] });
    },

    renameAssembly: (id, name) => change((doc) => renameAssembly(doc, id, name)),

    addPartStudio: () => {
      if (get().editing) return;
      const id = newId("s");
      change((doc) => addStudio(doc, id));
      set({ activeTab: id, asmSelection: [], selection: [], selectedPlane: null, selectedFeatureId: null, section: null, mateDraft: null });
    },

    renamePartStudio: (id, name) => change((doc) => renameStudio(doc, id, name)),

    addDrawing: () => {
      const s = get();
      if (s.editing) return;
      // Draw the part that's selected, else the last part of the Part Studio on show, else any part.
      const shown = studioParts(s);
      const partId = s.selection[0]?.partId ?? shown[shown.length - 1]?.id ?? s.parts[s.parts.length - 1]?.id;
      const asm = activeAssembly(s);
      const source = asm ? { kind: "assembly" as const, id: asm.id } : partId ? { kind: "part" as const, id: partId } : null;
      const id = newId("d");
      change((doc) => addDrawingTo(doc, id, source));
      set({ activeTab: id, asmSelection: [], selection: [], selectedPlane: null, selectedFeatureId: null, section: null, mateDraft: null, dialog: null });
    },

    changeDrawing: (fn) => {
      const d = activeDrawing(get());
      if (d) change((doc) => updateDrawing(doc, d.id, fn));
    },

    renameDrawing: (id, name) => change((doc) => renameDrawingIn(doc, id, name)),

    removeDrawing: (id) => {
      change((doc) => removeDrawingFrom(doc, id));
      if (get().activeTab === id) set({ activeTab: null });
    },

    removePartStudio: (id) => {
      if (get().editing) return;
      change((doc) => removeStudio(doc, id));
      if (get().activeTab === id) set({ activeTab: null, selection: [], selectedFeatureId: null });
    },

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

    startMate: (type) => {
      const asm = activeAssembly(get());
      if (!asm) return;
      const values: Record<string, string> = {};
      for (const d of MATE_TYPES[type].values) values[d.key] = "0";
      set({
        mateDraft: { mode: "create", mate: { id: newId("m"), name: nextMateName(asm, type), type, flip: false, values } },
        asmSelection: [],
        dialog: null,
      });
    },

    editMate: (id) => {
      const mate = activeAssembly(get())?.mates?.find((m) => m.id === id);
      if (mate) set({ mateDraft: { mode: "edit", mate: { ...mate, values: { ...mate.values } } }, asmSelection: [], dialog: null });
    },

    setMateDraft: (patch) =>
      set((s) => {
        if (!s.mateDraft) return {};
        const mate = { ...s.mateDraft.mate, ...patch };
        // A new kind of mate keeps the amounts it shares with the old one, and starts the rest at 0.
        if (patch.type && patch.type !== s.mateDraft.mate.type) {
          const values: Record<string, string> = {};
          for (const d of MATE_TYPES[patch.type].values) values[d.key] = s.mateDraft.mate.values[d.key] ?? "0";
          mate.values = values;
          const asm = activeAssembly(s);
          const autoName = /^\S+ \d+$/.test(s.mateDraft.mate.name) && s.mateDraft.mode === "create";
          if (asm && autoName) mate.name = nextMateName(asm, patch.type);
        }
        return { mateDraft: { ...s.mateDraft, mate } };
      }),

    pickMateConnector: (c) =>
      set((s) => {
        if (!s.mateDraft) return {};
        const m = s.mateDraft.mate;
        let next: MateDraft;
        if (!m.a || (m.a && m.b) || (!m.b && m.a.instanceId === c.instanceId)) next = { ...m, a: c, b: undefined };
        else next = { ...m, b: c };
        return { mateDraft: { ...s.mateDraft, mate: next } };
      }),

    commitMateDraft: () => {
      const s = get();
      const asm = activeAssembly(s);
      const d = s.mateDraft;
      if (!asm || !d || !d.mate.a || !d.mate.b) return false;
      const mate: Mate = { ...d.mate, a: d.mate.a, b: d.mate.b, name: d.mate.name.trim() || MATE_TYPES[d.mate.type].label };
      change((doc) => {
        const withMate = putMate(doc, asm.id, mate);
        const solvedAsm = withMate.assemblies?.find((a) => a.id === asm.id);
        return solvedAsm ? settlePlacements(withMate, asm.id, solveWithParts(solvedAsm, s.parts).placements) : withMate;
      });
      set({ mateDraft: null });
      return true;
    },

    cancelMateDraft: () => set({ mateDraft: null }),

    setDragPreview: (dragPreview) => set({ dragPreview }),
    setDrawingTool: (drawingTool) => set({ drawingTool, selectedDim: null }),
    selectDim: (selectedDim) => set({ selectedDim }),

    commitDrag: () => {
      const s = get();
      const asm = activeAssembly(s);
      const d = s.dragPreview;
      set({ dragPreview: null });
      if (!asm || !d) return;
      if (d.kind === "instance") {
        change((doc) => updateInstance(doc, asm.id, d.id, { placement: d.placement }));
        return;
      }
      const mate = asm.mates?.find((m) => m.id === d.id);
      if (!mate) return;
      const moved = withDragChange(asm, d);
      const { placements } = solveWithParts(moved, s.parts);
      change((doc) => settlePlacements(putMate(doc, asm.id, { ...mate, values: d.values }), asm.id, placements));
    },

    deleteMate: (id) => {
      const s = get();
      const asm = activeAssembly(s);
      if (!asm) return;
      // Parts stay where the mates had put them.
      const { placements } = solveWithParts(asm, s.parts);
      change((doc) => removeMate(settlePlacements(doc, asm.id, placements), asm.id, id));
      if (s.mateDraft?.mate.id === id) set({ mateDraft: null });
    },

    theme: "light",
    setTheme: (theme) => set({ theme }),
    setUnits: (unit) =>
      change((doc) => {
        const { units: _old, ...rest } = doc;
        return unit === "in" ? { ...rest, units: "in" } : rest;
      }),
    setExplode: (amount) => {
      const asm = activeAssembly(get());
      if (asm) change((doc) => setExplode(doc, asm.id, amount));
      set({ explodePreview: null });
    },
    explodePreview: null,
    setExplodePreview: (amount) => set({ explodePreview: amount }),
    toggleMateSuppressed: (id) => {
      const s = get();
      const asm = activeAssembly(s);
      const mate = asm?.mates?.find((m) => m.id === id);
      if (!asm || !mate) return;
      const { placements } = solveWithParts(asm, s.parts);
      change((doc) => putMate(settlePlacements(doc, asm.id, placements), asm.id, { ...mate, suppressed: !mate.suppressed }));
    },
    toggleInstanceHidden: (id) =>
      set((s) => ({ hiddenInstances: s.hiddenInstances.includes(id) ? s.hiddenInstances.filter((x) => x !== id) : [...s.hiddenInstances, id] })),

    // Undo/redo only when no feature dialog is open (see App shortcuts).
    undo: () => set((s) => (s.editing || s.mateDraft ? {} : { history: undoHistory(s.history), selection: [] })),
    // (While sketching, Ctrl+Z goes to sketchUndo instead — see App shortcuts.)
    redo: () => set((s) => (s.editing || s.mateDraft ? {} : { history: redoHistory(s.history), selection: [] })),

    // Picking a feature or picking parts: one at a time (the other side is then shown as "linked").
    selectFeature: (id) => set((s) => ({ selectedFeatureId: id, selectedPlane: id ? null : s.selectedPlane, selectedParts: id ? [] : s.selectedParts })),
    setSelection: (items) =>
      set((s) => ({ selection: items, selectedPlane: items.length > 0 ? null : s.selectedPlane })),
    duplicateParts: (ids) => {
      const s = get();
      if (s.editing || ids.length === 0) return;
      const drafts = ids.flatMap((partId) => {
        const part = s.parts.find((p) => p.id === partId);
        if (!part) return [];
        const box = boundsOfVertices(part.vertices);
        const width = box ? box.max[0] - box.min[0] : 20;
        const draft = createFeature(view(), "transform");
        draft.name = `Copy of ${part.name}`;
        draft.transform = { axis: "z", about: "centre", copy: true, partId };
        draft.params = { ...draft.params, dx: startingLength(width + 10) };
        return [draft];
      });
      if (drafts.length === 1) {
        set({ editing: { mode: "create", draft: drafts[0] }, sketch: null, selectedFeatureId: null, selection: [], selectedParts: [], selectedPlane: null });
        return;
      }
      // Several: add them one after another.
      const added: Feature[] = drafts;
      changeStudio((d) => added.reduce((acc, f) => addFeature(acc, f), d));
      set({ selectedParts: [] });
      s.showToast(`Copied ${added.length} parts — each copy is a Move/copy feature you can edit.`, "success");
    },
    toggleBooleanPart: (partId) =>
      set((s) => {
        const d = s.editing?.draft;
        const b = d?.booleanDef;
        if (!s.editing || !d || !b) return {};
        const key = b.op === "subtract" && b.picking === "tools" ? "tools" : "targets";
        const other = key === "tools" ? "targets" : "tools";
        const list = b[key].includes(partId) ? b[key].filter((x) => x !== partId) : [...b[key], partId];
        const booleanDef = { ...b, [key]: list, [other]: b[other].filter((x) => x !== partId) };
        return { editing: { ...s.editing, draft: { ...d, booleanDef } } };
      }),
    setSelectedParts: (selectedParts) => set((s) => ({ selectedParts, selectedFeatureId: selectedParts.length ? null : s.selectedFeatureId })),
    setPartsHidden: (ids, hidden) =>
      set((s) => ({ hiddenParts: hidden ? [...s.hiddenParts.filter((p) => !ids.includes(p)), ...ids] : s.hiddenParts.filter((p) => !ids.includes(p)) })),
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
    setRebuildResult: (built, featureErrors, ms, rebuilt, studioOrder) =>
      set((s) => {
        // Part Studios that weren't rebuilt keep the parts they had.
        let parts = built;
        if (rebuilt && studioOrder) {
          parts = [];
          for (const id of studioOrder) {
            if (rebuilt.includes(id)) parts.push(...built.filter((p) => (p.studioId ?? MAIN_STUDIO) === id));
            else parts.push(...s.parts.filter((p) => (p.studioId ?? MAIN_STUDIO) === id));
          }
        }
        const ids = new Set(parts.map((p) => p.id));
        return {
          parts,
          featureErrors,
          lastRebuildMs: ms,
          rebuildBusy: false,
          // Drop picks and hidden flags for parts that no longer exist.
          selection: s.selection.filter((x) => ids.has(x.partId)),
          hiddenParts: s.hiddenParts.filter((p) => ids.has(p)),
          selectedParts: s.selectedParts.filter((p) => ids.has(p)),
        };
      }),
  };
});

/** The assembly on show, or null when the Part Studio is on show (or the assembly was undone away). */
export function activeAssembly(s: Pick<AppState, "activeTab" | "history">): Assembly | null {
  if (!s.activeTab) return null;
  return s.history.present.assemblies?.find((a) => a.id === s.activeTab) ?? null;
}

/**
 * The Part Studio on show (its id), or null when an assembly is on show.
 * Falls back to the first Part Studio if the tab's studio was undone away.
 */
export function activeStudioId(s: Pick<AppState, "activeTab" | "history">): string | null {
  const doc = s.history.present;
  if (s.activeTab && doc.assemblies?.some((a) => a.id === s.activeTab)) return null;
  if (s.activeTab && doc.drawings?.some((d) => d.id === s.activeTab)) return null;
  return s.activeTab && studioExists(doc, s.activeTab) ? s.activeTab : MAIN_STUDIO;
}

/** Features of the Part Studio on show (the first one while an assembly is on show). Same array each time. */
export function activeFeatures(s: Pick<AppState, "activeTab" | "history">): Feature[] {
  return studioFeatures(s.history.present, activeStudioId(s) ?? MAIN_STUDIO);
}

const studioPartsCache = new WeakMap<PartMesh[], Map<string, PartMesh[]>>();
/** The parts made by one Part Studio (the same array each time for the same parts list, so safe in selectors). */
export function partsInStudio(parts: PartMesh[], studioId: string): PartMesh[] {
  let byStudio = studioPartsCache.get(parts);
  if (!byStudio) {
    byStudio = new Map();
    studioPartsCache.set(parts, byStudio);
  }
  let list = byStudio.get(studioId);
  if (!list) {
    list = parts.filter((p) => (p.studioId ?? MAIN_STUDIO) === studioId);
    byStudio.set(studioId, list);
  }
  return list;
}

/** Parts of the Part Studio on show (none while an assembly is on show). */
export function studioParts(s: Pick<AppState, "activeTab" | "history" | "parts">): PartMesh[] {
  const id = activeStudioId(s);
  return id ? partsInStudio(s.parts, id) : NO_PARTS;
}
const NO_PARTS: PartMesh[] = [];

/** The drawing on show, or null. */
export function activeDrawing(s: Pick<AppState, "activeTab" | "history">): Drawing | null {
  if (!s.activeTab) return null;
  return s.history.present.drawings?.find((d) => d.id === s.activeTab) ?? null;
}

/** The current document (without any unsaved draft). */
export const useDocument = () => useStore((s) => s.history.present);

// Keep the maths boxes' variable values in step with the document (including after undo/redo).
let scopeFor: Variable[] | undefined | null = null;
/** The document's units, for components that show lengths (re-renders them when it changes). */
export const useLengthUnit = (): LengthUnit => useStore((s) => (s.history.present.units === "in" ? "in" : "mm"));
useStore.subscribe((s) => setLengthUnit(s.history.present.units === "in" ? "in" : "mm"));

function syncScope(variables: Variable[] | undefined) {
  if (variables === scopeFor) return;
  scopeFor = variables;
  setCurrentScope(resolveVariables(variables).values);
}
syncScope(useStore.getState().history.present.variables);
useStore.subscribe((s) => syncScope(s.history.present.variables));
