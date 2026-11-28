import { scopePickingAfter, toggleScopePart } from "./mergeScope";
import { sketchFromDxf, type LinkedSketch } from "../link/receive";
import { clickRadiusPoint, tidyRadiusPoints } from "./variableFillet";
import { defaultTemplate } from "../drawing/templateStorage";
import { applyTemplate } from "../drawing/templates";
import { addPoint, deleteItems, setDimensionValue } from "../sketch/ops";
import { takeTyped } from "../sketch/offeredBox";
import { followLinks, pruneReferences, type RefEdge, type SketchLinkInfo } from "../sketch/links";
import { isExtraId, keepSketchExtras, withoutEmptyExtras } from "../sketch/sketchText";
import { create } from "zustand";
import { NO_FILTER, type SelectFilter } from "../viewport/selectionFilter";
import { removeNamedView, removeViewsOf, renameNamedView as renameNamedViewIn, saveNamedView as saveNamedViewIn, type CameraState } from "./namedViews";
import { pasteFeatures as pasteClip, type FeatureClip, type PasteResult } from "./featureClipboard";

import type { FollowedFrame, PartMesh } from "../kernel/protocol";
import {
  addFeature,
  insertFeatureAfter,
  newId,
  commit,
  createFeature,
  madeByDraft,
  picksPartsBefore,
  withoutPicking,
  emptyDocument,
  historyOf,
  redo as redoHistory,
  removeFeature,
  renameFeature,
  renameFolder,
  setFolder,
  renamePart,
  replaceFeature,
  setSuppressed,
  undo as undoHistory,
  type History,
} from "./document";
import { sameRef, type TopoPick } from "../geometry/topoRef";
import { cornersOf, type VertexPick } from "../geometry/vertexRef";
import { dot, planeFrame, toSketch, type SketchPlane, type Vec3 } from "../sketch/planes";
import { emptySketch, type SketchData } from "../sketch/types";
import { setCurrentScope } from "./expr";
import { NO_MEASURED, type MeasuredValue } from "./measuredVariable";
import { addConfiguration, removeConfiguration, renameConfiguration, switchConfiguration } from "./configurations";
import { framesOf, planeAsSketchPlane, refreshDocumentPlanes } from "../sketch/planeFeature";
import { lengthUnit, setLengthUnit, startingLength, storeLength, type LengthUnit } from "./units";
import { applyVariables, renameInFeatures, resolveVariables, type Variable } from "./variables";
import { editInsert, findDesign, insertDesign } from "../library/insert";
import type { DesignValues } from "../library/types";
import { hasManipulators } from "./manipulators";
import { isPatternFeature, isPickFeature, isSketchSolid, isSolidFeature, resolveParams } from "./features";
import { setMirrorReference } from "./patternRefs";
import { defaultAxis } from "../sketch/axis";
import { areaSelectionLapses, followedSketch, freeAreas, selectionStart, sketchToExtrude, type AreaSelection } from "../sketch/areaClicks";
import type { Assembly, AssemblyPattern, ExplodeStep, IntendedFit, Replicate, Drawing, Feature, FeatureType, ImportedFile, Instance, Mate, MateConnector, MateRelation, MateType, JuraCADDocument, PartProperties, PlaneName, DatumName } from "./types";
import { boundsOfVertices } from "../assembly/assembly";
import { nextPatternName, removePattern, syncPattern } from "../assembly/patterns";
import { nextReplicateName, removeReplicate, replicateSource, syncReplicate } from "../assembly/replicate";
import { replicateHoles } from "../assembly/replicateHoles";
import { makeGroup, removeGroup, renameGroup } from "../assembly/groups";
import { duplicateInstances, placedBox, replaceInstancePart, type Box3 } from "../assembly/assembly";
import { putExplodeStep, removeExplodeStep } from "../assembly/explode";
import { putFit, removeFit } from "../assembly/fits";
import { findMesh, meshIdOf } from "../assembly/configured";
import { ownSymmetry, subAssemblySymmetry } from "../assembly/symmetry";
import { setFlexible } from "../assembly/flexible";

import { addAssembly, applyPosition, updateAssembly, insertInstance, putMate, putRelation, removeAssembly, removeInstances, removeMate, removePosition, removeRelation, savePosition, renameAssembly, setExplode, settlePlacements, settleSolved, updateInstance } from "../assembly/assembly";
import { MATE_TYPES, nextMateName, pickConnector, cornerFlip, samePieceClick, solveWithParts } from "../assembly/mates";
import { insertProblem, insertSubAssembly, instanceAt, ownBox, PATH_SEP, whereUsed } from "../assembly/subassembly";
import { setSuppressed as setInstancesOff } from "../assembly/suppress";
import { setPartProperties as setPartPropertiesIn } from "../assembly/properties";
import { moveFeature as moveFeatureIn } from "./reorder";
import { DEFAULT_MATERIAL } from "./materials";
import { chooseFinish, setColourIn, type FinishId } from "./finishes";
import { clearFaceColoursIn, setFaceColoursIn, setPartSpoolIn } from "./faceColours";
import { addDrawing as addDrawingTo, removeDrawing as removeDrawingFrom, renameDrawing as renameDrawingIn, updateDrawing, numberInspections } from "../drawing/drawing";
import { withDragChange, type DragChange } from "../assembly/drag";
import type { Placement } from "../assembly/math";
import { importName } from "./importFile";
import { usedSketches } from "./visibility";
import { hiddenDatumsOf, keepVisibility, setAllPlanesVisible, setAllSketchesVisible, setDatumHidden, setFeaturesVisible, toggleAllPlanes } from "./visibility";
import { settlePrintedFit } from "./printSettings";
import { addStudio, firstStudioId, MAIN_STUDIO, inStudio, moveStudio, renameStudio, studioExists, studioFeatures, studioName, studioView, studiosOf } from "./studios";
import { deleteStudio, studioInUse, studioUsers } from "./studioUse";
import { deleteFeatures as deleteFeaturesIn, findDependents } from "./dependents";
import { designOf, withVersionsOf } from "./versions";
import { newKeepId, readKept } from "./browserKeep";
import { rememberOptions, withRemembered, type OptionsMemory } from "./lastOptions";
import { holeSketchFor, withAutoValues, type AutoContext, type AutoValues } from "./newFeatureDefaults";
import { holePositionCount } from "../sketch/holePositions";
import { acceptBlocker } from "./draftReady";
import { editRollback } from "./finalPreview";
import { mainPart } from "../drawing/defaultPart";

/** Which instances show a symmetric part, or a symmetric sub-assembly (for mirrors that show such things as themselves). */
const symmetricIn = (parts: readonly PartMesh[], assemblies: readonly Assembly[] = []) => (i: Instance) => {
  if (i.subAssembly) return !!subAssemblySymmetry(i.subAssembly, parts, assemblies);
  const mesh = findMesh(parts, meshIdOf(i));
  return !!mesh && !!ownSymmetry(mesh);
};

/** Two sketch planes in the same place (to within a micron), whatever face they remember. */
function samePlace(a: SketchPlane, b: SketchPlane): boolean {
  if (a.kind !== "face" || b.kind !== "face") return a.kind === b.kind && JSON.stringify(a) === JSON.stringify(b);
  const near = (p: number[], q: number[]) => p.every((v, i) => Math.abs(v - q[i]) < 1e-3);
  return near(a.origin, b.origin) && near(a.u, b.u) && near(a.v, b.v);
}

/** No sketch links (one shared object, so selectors stay stable). */
const NO_LINKS: Record<string, SketchLinkInfo> = {};
const NO_FRAMES: Record<string, FollowedFrame> = {};
const NO_CURVES: Record<string, number[][]> = {};
const NO_WARNINGS: Record<string, string> = {};
const NO_CENTRES: Record<string, [number, number, number]> = {};
const NO_FRAME_PATHS: Record<string, import("./frame").PathSeg[]> = {};

/**
 * The open dialog's undo after a change to `before` (the draft as it was): one more step — unless `typing` names the
 * box typed in last time too, when the step that typing began already holds what to go back to.
 */
function draftStepAfter(steps: { id: string; drafts: Feature[]; typing?: string } | null, before: Feature, typing?: string): { id: string; drafts: Feature[]; typing?: string } {
  const drafts = steps?.id === before.id ? steps.drafts : [];
  if (typing && steps?.id === before.id && steps.typing === typing && drafts.length) return steps;
  return { id: before.id, drafts: [...drafts.slice(-49), before], ...(typing ? { typing } : {}) };
}

/** Tab in an offered size's box: the next size offered after `id` (`back`: the one before), round and round; null when it's the only one. */
export function nextOffered(list: readonly string[], id: string, back = false): string | null {
  const i = list.indexOf(id);
  if (i < 0 || list.length < 2) return null;
  return list[(i + (back ? list.length - 1 : 1)) % list.length];
}

/** Does the open dialog keep its own undo (Move / copy, and the dialogs with manipulators)? */
export function keepsSteps(d: Feature): boolean {
  return d.type === "transform" || hasManipulators(d.type);
}
/** No drawing dimensions selected (one shared array, so selectors stay stable). */
const NO_DIMS: string[] = [];
export interface SelectionItem {
  partId: string;
  /** "vertex": a corner (its number in `cornersOf(part)`, geometry/vertexRef.ts). */
  kind: "face" | "edge" | "vertex";
  /** Face, edge or corner number within the part. */
  index: number;
}

/** What a picked face or edge looks like, so a feature can find it again after rebuilds. */
export function pickFor(parts: PartMesh[], item: SelectionItem): TopoPick | null {
  if (item.kind === "vertex") return null;
  const part = parts.find((p) => p.id === item.partId);
  const ref = item.kind === "edge" ? part?.edgeRefs?.[item.index] : part?.faceRefs?.[item.index];
  if (!ref || (ref.kind === "edge" ? ref.curve : ref.surface) === "UNKNOWN") return null;
  return { partId: item.partId, ref };
}

/** A picked corner, so a feature (or Measure) can find it again after rebuilds. */
export function cornerPickFor(parts: PartMesh[], item: SelectionItem): VertexPick | null {
  if (item.kind !== "vertex") return null;
  const part = parts.find((p) => p.id === item.partId);
  const ref = part ? cornersOf(part)[item.index] : undefined;
  return part && ref ? { partId: part.id, ref } : null;
}

export type { PlaneName, DatumName } from "./types";

/** Where the Part Studio on show is rolled back to right now (the rollback bar, or the feature being edited with "Final" off). */
export function shownRollback(s: Pick<AppState, "editing" | "rollbackTo" | "showFinal" | "activeTab" | "history">): string | null {
  return editRollback(activeFeatures(s), s.editing, s.rollbackTo, s.showFinal);
}

/** Is the Part Studio on show rolled back just for the feature being edited ("Final" off)? */
function shownRolledBackForEdit(s: AppState): boolean {
  return shownRollback(s) !== s.rollbackTo;
}

export interface Editing {
  mode: "create" | "edit";
  draft: Feature;
}

/** Drawing tools: select, the smart Dimension, baseline / chain / ordinate runs, and section. */
export type DrawingTool = "select" | "crop" | "cropShape" | "dimension" | "baseline" | "chain" | "ordinate" | "section" | "auxiliary" | "breakout" | "shorten" | "note" | "detail" | "holeCallout" | "chamfer" | "arcLength" | "datum" | "fcf" | "finish";

export type SketchTool =
  | "select"
  | "line"
  /** Onshape's Midpoint line: click the middle, then one end. */
  | "midpointLine"
  | "rectangle"
  | "centreRectangle"
  | "alignedRectangle"
  | "circle3"
  | "centreArc"
  | "circle"
  | "arc"
  | "tangentArc"
  | "spline"
  | "conic"
  | "ellipse"
  | "point"
  | "dimension"
  | "slot"
  | "polygon"
  | "sketchFillet"
  | "trim"
  | "extend"
  | "split"
  | "offset"
  | "mirror"
  | "sketchPattern"
  | "sketchTransform"
  | "useEdge"
  | "text"
  | "intersect"
  | "sketchChamfer"
  | "slotAlong"
  | "ellipticalArc";

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
  /** Dimensions offered just after drawing a shape (their value box opens straight away): Enter keeps one, Esc drops them. */
  provisional: string[];
  /** Polygon tool: number of sides. */
  polygonSides: number;
  /** Polygon tool: the pointer sets a corner (the size across corners) or the middle of a side (across flats). */
  polygonAcross?: "corners" | "flats";
  /** Conic tool: how full new conics are (0.5 = a parabola). */
  conicRho?: number;
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
  /** Linear pattern: the next click on a line sets the direction. */
  patternDirectionPick?: boolean;
  /** Linear pattern: the line the direction came from, so the copies follow it. */
  patternLine?: string;
  /** Move / copy tool: how far across and up (as typed), the turn (degrees, about the selection's middle), and whether to copy. */
  moveDx: string;
  moveDy: string;
  moveAngle: string;
  moveCopy: boolean;
  /** Move / copy's Scale box (1 = the same size); missing in older sessions = 1. */
  moveScale?: string;
  /** Text tool: the settings for new text (a selected text shows its own instead). */
  textValue?: string;
  textSize?: string;
  textAngle?: string;
  textFont?: "regular" | "bold";
  textAnchorAt?: "start" | "centre";
  /** Bumped to put the cursor in the sketch panel's text box (a double-click on text). */
  textFocus?: number;
  /** Intersect: clicking a face takes where the sketch cuts the whole part, not just that face. */
  intersectWhole?: boolean;
  /** Insert DXF: the panel's box is open, and the scale to bring the next file in at. */
  dxfOpen?: boolean;
  dxfScale?: string;
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

/** The Design library window: the list of designs (optionally one already picked), or an inserted design's sizes. */
export type LibraryView = { mode: "browse"; design?: string } | { mode: "edit"; insertId: string };

export type DialogName = "check" | "export" | "picture" | "help" | "whatsNew" | "flatPattern" | "variables" | "configurations" | "insert" | "versions" | "cutList" | null;

/**
 * Looking at an old version (read-only): the version's design is in `history`
 * so every tab shows it, and the real design waits in `stash` (with what was
 * on show) until "Back to the current design". See src/app/versionActions.ts.
 */
export interface VersionView {
  id: string;
  name: string;
  createdAt: string;
  stash: History;
  /** What was on show before, put back on the way out. */
  was: { activeTab: string | null; rollbackTo: string | null; hiddenParts: string[]; transparentParts: string[] };
}

/**
 * Comparing two versions (or a version with now): the designs being compared
 * ("now" = the current design). While set, the engine also builds each old
 * version's Part Studios (ids "<studio>@version:<id>"), for the parts lists and
 * the see-through overlay in 3D.
 */
export interface VersionCompare {
  older: string;
  newer: string;
  docs: Record<string, JuraCADDocument>;
  /** Draw the older version's parts see-through over the newer's in the 3D view. */
  ghost: boolean;
}

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "success" | "error";
}

export interface AppState {
  history: History;
  /** An old version open read-only (null = the current design). */
  versionView: VersionView | null;
  versionCompare: VersionCompare | null;
  setVersionCompare: (c: VersionCompare | null) => void;
  /** Open a version's design read-only (or switch to another version). */
  enterVersionView: (v: { id: string; name: string; createdAt: string }, doc: JuraCADDocument) => void;
  /** Back to the current design. */
  leaveVersionView: () => void;
  /** A change to the whole design (one undo step): restoring a version. */
  changeDocument: (fn: (doc: JuraCADDocument) => JuraCADDocument) => void;
  /**
   * Save, rename or remove versions. Not an undo step: as in Onshape, versions
   * stay put whatever is undone or redone (undo and redo carry them along).
   */
  changeVersions: (fn: (doc: JuraCADDocument) => JuraCADDocument) => void;
  /** While an old version is open: say it can't be changed and return true (for drags and clicks that would change it). */
  refuseReadOnly: () => boolean;
  /** Why the design (or its versions) couldn't be kept in this browser just now, or null when it's kept. Set by connect.ts. */
  storageProblem: string | null;
  editing: Editing | null;
  /** Present while the feature being edited is a sketch. */
  sketch: SketchSession | null;
  /** Feature highlighted in the feature list. */
  selectedFeatureId: string | null;
  /** Several features picked in the list (Shift / Ctrl + click): counts only while it holds `selectedFeatureId`; read with `pickedFeatures`. */
  featureSelection: string[];
  /** The section view, when one is on. */
  section: SectionView | null;
  /** The print bed preview, when on: which printer (or a custom size). */
  printBed: { printer: string; custom?: [number, number, number] } | null;
  /** Faces and edges picked in the viewport. */
  selection: SelectionItem[];
  /** Sketch areas clicked in the 3D view with nothing open: the next Extrude, Revolve or Sweep uses them (as in Onshape). */
  areaSelection: AreaSelection | null;
  hiddenParts: string[];
  /** Parts drawn see-through (display only, not saved). */
  transparentParts: string[];
  /** Part Studio: show sheet metal parts laid out flat instead of folded. */
  showFlat: boolean;
  /** Whole parts picked in the Parts list (for hiding, colouring or exporting several at once). */
  selectedParts: string[];
  /** Default plane picked in the list or viewport (planes and faces aren't selected together). */
  selectedPlane: PlaneName | null;
  /** Plane whose row the pointer is over in the feature list (highlighted in the viewport). */
  listHoverPlane: PlaneName | null;

  kernelStatus: "loading" | "ready" | "failed";
  kernelError: string | null;
  rebuildBusy: boolean;
  parts: PartMesh[];
  featureErrors: Record<string, string>;
  /** Features built, but with something to tell (an amber note, not a failure): feature ID → message. */
  featureWarnings: Record<string, string>;
  /** Plain information about features built (what Simplify did): feature ID → message. */
  featureNotes: Record<string, string>;
  /** Move / copy features → the point they turn about before the move (from the latest rebuild): where the triad goes. */
  transformCentres: Record<string, [number, number, number]>;
  /** Frames → the path pieces they follow from part edges and curve features (from the latest rebuild), for the dialog's corners. */
  framePaths: Record<string, import("./frame").PathSeg[]>;
  /** While the Move / copy triad is being dragged: the boxes' values so far (shown instead of the draft's). */
  transformLive: Record<string, string> | null;
  /** The open dialog's own undo: the draft before each drag of the triad (or Move triad click), newest last. */
  draftSteps: { id: string; drafts: Feature[]; /** The box typed in last (typing on in it merges into that step). */ typing?: string } | null;
  /** Sketches on part faces or using part edges (by feature id), as found on the latest rebuild. */
  sketchLinks: Record<string, SketchLinkInfo>;
  /**
   * The sketch open for editing: what else it can snap to (other sketches,
   * every part's edges, seen square-on to it), from the engine. Null when
   * no sketch is open (or the engine hasn't answered yet).
   */
  sketchCandidates: { id: string; studioId: string; version: number; list: RefEdge[] } | null;
  setSketchCandidates: (c: { id: string; studioId: string; version: number; list: RefEdge[] } | null) => void;
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
  /** Every selected dimension and note (several when box-selected or Ctrl-clicked; selectedDim is set only when there's one). */
  selectedDims: string[];
  /** Part Studio rolled back to just after this feature (Onshape's rollback bar); null = showing everything. */
  rollbackTo: string | null;
  /**
   * Onshape's "Final" tick in feature dialogs: while an existing feature is edited, show the whole design (true)
   * or the Part Studio rolled back to just after it (false, the usual). This session only, never in the file.
   */
  showFinal: boolean;
  setShowFinal: (on: boolean) => void;
  /** What a mouse drag in an assembly is changing, while the button is held. */
  dragPreview: DragChange | null;
  /** Mate whose movement is being animated in the 3D view. */
  animatingMate: string | null;
  setAnimatingMate: (id: string | null) => void;
  /** The design as last saved to (or opened from) a file; compare with history.present to see unsaved changes. */
  savedDoc: JuraCADDocument | null;
  /** Name of that file, e.g. "Bracket.juracad". */
  fileName: string | null;

  // actions
  startCreate: (type: FeatureType) => void;
  startEdit: (id: string) => void;
  /** Start importing a STEP or STL file (opens the Import dialog with a preview). */
  startImport: (file: ImportedFile) => void;
  setDraftParam: (key: string, value: string) => void;
  setDraftField: (patch: Partial<Pick<Feature, "name" | "operation" | "sketchRef" | "areas" | "extrude" | "revolve" | "picks" | "pattern" | "mirror" | "hole" | "transform" | "import" | "pathRef" | "sections" | "loftRuled" | "text" | "planeDef" | "booleanDef" | "splitDef" | "replaceDef" | "flipSide" | "closeCorners" | "neutral" | "deleteParts" | "simplifyParts" | "compositeParts" | "mergeScope" | "mergeScopePicking" | "simplify" | "fastener" | "derived" | "reliefShape" | "cornerRelief" | "surface" | "hollow" | "flangePosition" | "mitreCorners" | "keepOtherSide" | "extendTo" | "bothSides" | "continuity" | "breakStyle" | "leaveOpen" | "chamferType" | "sweepControl" | "moreAreas" | "sheetConvert" | "connector" | "thin" | "loft" | "modifyFillet" | "allEdges" | "curve" | "pathEdges" | "frame" | "trimFrame" | "gusset" | "boundary" | "blend" | "moveFace" | "variableFillet" | "importUnits" | "measured">>) => void;
  /** Fillet/chamfer: add a picked edge or face, or remove it if it's already picked. */
  toggleDraftPick: (pick: TopoPick) => void;
  /** Part pattern / Composite part: add a part to the open feature's parts, or take it out. */
  toggleDraftPart: (partId: string) => void;
  /** Mirror/pattern: add a feature to repeat, or remove it if it's already there. */
  toggleDraftSource: (featureId: string) => void;
  /** Mirror: the plane to mirror across. */
  setDraftMirrorPlane: (plane: SketchPlane) => void;
  /** Open a new sketch (plane may be chosen later). */
  startSketch: (plane: SketchPlane | null) => void;
  setSketchPlane: (plane: SketchPlane) => void;
  /** The sketch's face can't be found: let the next click on a face or plane put the sketch there. */
  repickSketchPlane: () => void;
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
  /** Offer these new dimensions (see SketchSession.provisional); the first one's box opens. */
  offerDimensions: (ids: string[]) => void;
  /** Keep the offered dimension being edited, and move on to the next one offered (if any); `close` (Enter): drop the rest. */
  keepOfferedDimension: (id: string, close?: boolean) => void;
  /** Tab in an offered size's box: open the next one offered (Shift+Tab: the one before), as Onshape does while drawing. */
  nextOfferedDimension: (id: string, back?: boolean) => void;
  /** Drop any offered dimensions not kept yet; `keepTyped` (drawing carries on): a size typed in its box is set and kept. */
  discardOfferedDimensions: (keepTyped?: boolean) => void;
  setSketchOptions: (patch: Partial<Pick<SketchSession, "polygonSides" | "polygonAcross" | "conicRho" | "filletRadius" | "offsetDistance" | "patternKind" | "patternCount" | "patternSpacing" | "patternAngle" | "patternCentre" | "patternDirectionPick" | "patternLine" | "moveDx" | "moveDy" | "moveAngle" | "moveCopy" | "moveScale" | "textValue" | "textSize" | "textAngle" | "textFont" | "textAnchorAt" | "textFocus" | "intersectWhole" | "dxfOpen" | "dxfScale">>) => void;
  commitDraft: () => boolean;
  cancelDraft: () => void;
  /**
   * The Hole dialog: a flat face clicked at `point` (on `plane`, the face's sketch plane) puts a hole there — a point in
   * a sketch on that face, made for this hole (as Onshape's hole flow); more clicks on the same face add more.
   */
  placeHoleAt: (plane: SketchPlane, point: Vec3) => void;
  /**
   * Turn features off (Delete face's "fillets in the way" prompt). With
   * `commit`, the open feature is added in the same undo step; otherwise it's dropped.
   */
  suppressThenFinish: (ids: string[], commit: boolean) => void;
  deleteFeature: (id: string) => void;
  /**
   * The Delete question open over the feature list (Onshape's Delete dialog):
   * the features picked, and whether it came from "Delete with dependents…"
   * (else from the Delete key, on a feature others use). Null = closed.
   */
  deleteAsk: { ids: string[]; from: "menu" | "key" } | null;
  askDelete: (ask: { ids: string[]; from: "menu" | "key" } | null) => void;
  /** Selection filter in the 3D view (session only, never saved): the kinds clicks may pick; empty = everything. */
  selectFilter: SelectFilter;
  setSelectFilter: (filter: SelectFilter) => void;
  /** Save the camera as a named view of the Part Studio or assembly on show (a name already there is replaced). One undo step. */
  saveNamedView: (camera: CameraState, name?: string) => void;
  renameNamedView: (id: string, name: string) => void;
  deleteNamedView: (id: string) => void;
  /** Copied features waiting to be pasted while the user says whether to add the variables they use. Null = none. */
  pasteAsk: { clip: FeatureClip; missing: string[] } | null;
  askPaste: (ask: { clip: FeatureClip; missing: string[] } | null) => void;
  /** Paste copied features into the Part Studio on show (after the rollback bar, else at the end). One undo step; null if they can't go in now. */
  pasteFeatures: (clip: FeatureClip, addVariables: boolean) => PasteResult | null;
  /** Delete features of the Part Studio on show, with every later feature that uses them (see model/dependents.ts) unless `justThese`. One undo step; returns how many went. */
  deleteFeatures: (ids: string[], justThese?: boolean) => number;
  /** Roll the Part Studio back to just after a feature (null = roll to the end). */
  setRollback: (id: string | null) => void;
  /** Move a feature to just before another (null = the end), if what it uses stays above it. One undo step. */
  moveFeature: (id: string, beforeId: string | null) => void;
  toggleSuppressed: (id: string) => void;
  /** Suppress (or unsuppress) several features as one undo step. */
  setFeaturesSuppressed: (ids: string[], suppressed: boolean) => void;
  renameFeature: (id: string, name: string) => void;
  /** Feature list folders: put features in one (null takes them out), or rename one. */
  setFeatureFolder: (ids: string[], folder: string | null) => void;
  /** The eye on sketches and Plane features: show or hide them in the 3D view (saved in the file). */
  setFeaturesVisible: (ids: string[], visible: boolean) => void;
  /** "Show all sketches" / "Hide all sketches" in the Part Studio on show. */
  setAllSketchesVisible: (visible: boolean) => void;
  /** "Show all planes" / "Hide all planes" (Top, Front, Right and Plane features) in the Part Studio on show. One undo step. */
  setAllPlanesVisible: (visible: boolean) => void;
  /** The P key: hide every plane if any is shown, else show them all. One undo step; returns whether they're now shown. */
  toggleAllPlanes: () => boolean;
  renameFeatureFolder: (from: string, to: string) => void;
  renameDocument: (name: string) => void;
  /** Name a part (blank goes back to "Part N"). One undo step. */
  renamePart: (partId: string, name: string) => void;
  /** Set what a part is made of (null = back to PLA). One undo step. */
  setPartMaterial: (partId: string, material: string | null) => void;
  /** A part's number, description and own properties, for parts lists (blank ones are dropped). */
  setPartProperties: (partId: string, props: PartProperties) => void;
  /** Colour a part (null = back to the default grey). One undo step. */
  setPartColour: (partId: string, colour: string | null, spool?: string) => void;
  /** Colour some faces of a part (face indices of its mesh as shown; colour null = back to the part's colour), one undo step. */
  setFaceColours: (partId: string, faces: number[], colour: string | null, spool?: string) => void;
  /** Take off all of a part's face colours (one undo step). */
  clearFaceColours: (partId: string) => void;
  /** A part's finish (matte, glossy, metal, clear…); null = the usual matte look. Undoable, saved in the file. A grey part also gets a colour that suits the finish (`chooseFinish`). */
  setPartFinish: (partId: string, finish: FinishId | null) => void;
  /** Several parts at once, as one undo step. */
  setPartsFinish: (partIds: string[], finish: FinishId | null) => void;
  /** Replace the variable list (one undo step); renames are followed everywhere. */
  setVariables: (variables: Variable[]) => void;
  /** The Design library's window: browsing the designs, or changing an inserted one's sizes. */
  library: LibraryView | null;
  openLibrary: (view: LibraryView | null) => void;
  /** Insert a library design (one undo step): into a new Part Studio named after it (shown), or the one on show. Returns a problem, or null. */
  insertLibraryDesign: (designId: string, values: DesignValues, into: "new" | "current") => string | null;
  /** A design sent from JuraCUT (DXF) as a new sketch in the Part Studio on show (a new one from an assembly or drawing). Returns what to tell JuraCUT. */
  addLinkedSketch: (name: string, dxf: string) => { ok: boolean; message: string };
  /** Change an inserted design's sizes and choices (one undo step). Returns a problem, or null. */
  editLibraryDesign: (insertId: string, values: DesignValues) => string | null;
  /** Configurations: keep the current state as a new one (and show it), show another, rename or forget one. */
  addConfiguration: (name: string) => void;
  switchConfiguration: (id: string) => void;
  renameConfiguration: (id: string, name: string) => void;
  removeConfiguration: (id: string) => void;
  /** Start a new design: empty, or this one (from a version). */
  newDocument: (doc?: JuraCADDocument) => void;
  /** Replace the design with one opened from a file (undoable). */
  openDocument: (doc: JuraCADDocument, fileName: string) => void;
  /** Note that the current design has just been saved to this file. */
  markSaved: (fileName: string) => void;
  /**
   * Live with Claude: show Claude's change to the design as one undo step
   * (`replace`: a whole new design, e.g. one Claude opened). The label
   * ("Claude: added Extrude 2") is shown as a note.
   */
  /** Returns why it couldn't be applied, or null when it was. */
  applyClaudeChange: (doc: JuraCADDocument, studio: string, label: string, replace: boolean) => string | null;
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
  /** Delete a Part Studio (any, while another is left), with the assembly copies of its parts. One undo step. */
  removePartStudio: (id: string) => void;
  /** Move a Part Studio's tab to place `to` (0 = first). One undo step. */
  movePartStudio: (id: string, to: number) => void;
  /** Show the Part Studio (null) or an assembly. */
  setActiveTab: (id: string | null) => void;
  removeAssembly: (id: string) => void;
  renameAssembly: (id: string, name: string) => void;
  /** Put a copy of a part into the assembly on show. */
  insertInstance: (part: { id: string; name: string }, placement?: Placement) => void;
  /** Put a copy of another assembly into the assembly on show, as one piece (refused, with a message, if it would go round in a circle). */
  insertSubAssembly: (assemblyId: string, placement?: Placement) => void;
  updateInstance: (id: string, patch: Partial<Pick<Instance, "name" | "placement" | "fixed" | "configuration">>) => void;
  removeInstances: (ids: string[]) => void;
  setAsmSelection: (ids: string[]) => void;
  toggleInstanceHidden: (id: string) => void;
  /** Switch instances off (Onshape's Suppress) or back on; the others stay where they are. */
  setInstancesSuppressed: (ids: string[], suppressed: boolean) => void;
  /** Make a sub-assembly copy flexible (its parts can move here, Onshape's "Make flexible") or rigid again. */
  setInstanceFlexible: (id: string, flexible: boolean) => void;
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
  /** Add or change a mate relation in the assembly on show (one undo step). */
  putRelation: (relation: MateRelation) => void;
  removeRelation: (id: string) => void;
  /** Named positions in the assembly on show: save the mates' amounts now, go back to one, or forget one. */
  savePosition: (name: string) => void;
  applyPosition: (id: string) => void;
  removePosition: (id: string) => void;
  /** Show and type lengths in millimetres or inches. */
  setUnits: (unit: LengthUnit) => void;
  /** Light or dark appearance (see app/theme.ts; not saved in designs). */
  theme: "light" | "dark";
  setTheme: (theme: "light" | "dark") => void;
  /** "Nicer lighting" in the 3D view: finishes shown with studio reflections (this computer only, `juracad.niceLighting`). */
  niceLighting: boolean;
  setNiceLighting: (on: boolean) => void;
  /** The exploded view's spread while its slider is being dragged (not saved until let go). */
  explodePreview: number | null;
  setExplodePreview: (amount: number | null) => void;
  /** The assembly pattern whose settings are open (changes apply straight away). */
  editingPattern: string | null;
  setEditingPattern: (id: string | null) => void;
  /** The open Mirror is waiting for a click on a flat face to mirror across. */
  /** A Mirror waiting for a click: a flat face to mirror across (true), or a face or edge to place a mate connector on ("connector"). */
  mirrorFacePick: boolean | "connector";
  setMirrorFacePick: (on: boolean | "connector") => void;
  /** Mirror the open Mirror's parts across this face (clicked in the 3D view). */
  pickMirrorFace: (c: MateConnector) => void;
  /** Repeat the selected instances (a linear pattern to start with) and open its settings. */
  /** Pattern (or, with "mirror", Mirror) the selected instances. */
  createPattern: (kind?: "mirror") => void;
  updatePattern: (id: string, patch: Partial<Omit<AssemblyPattern, "id">>) => void;
  deletePattern: (id: string) => void;
  /** Group: lock the selected parts together where they are. */
  createGroup: () => void;
  /** Ungroup: the parts stay where they are but move separately again. */
  deleteGroup: (id: string) => void;
  renameGroup: (id: string, name: string) => void;
  /** Replicate: copy the selected part into every hole matching the one it's mated into. */
  createReplicate: () => void;
  /** Look for matching holes again (after the part changed). */
  refreshReplicate: (id: string) => void;
  deleteReplicate: (id: string) => void;
  /** Copy the selected instances (and the mates between them), placed beside everything. */
  duplicateInstances: () => void;
  /** Show another part in an instance (and its pattern and Replicate copies), keeping its mates. */
  replaceInstancePart: (instanceId: string, partId: string) => void;
  /** Exploded view steps: move the selected parts (add), change or remove a step. */
  addExplodeStep: () => void;
  updateExplodeStep: (id: string, patch: Partial<Omit<ExplodeStep, "id">>) => void;
  removeExplodeStep: (id: string) => void;
  /** Mark two parts of the assembly on show as meant to fit (replaces any fit marked for the pair). */
  setAssemblyFit: (fit: IntendedFit) => void;
  removeAssemblyFit: (id: string) => void;
  setDragPreview: (change: DragChange | null) => void;
  setDrawingTool: (tool: DrawingTool) => void;
  selectDim: (id: string | null) => void;
  selectDims: (ids: string[]) => void;
  /** Keep what the drag did (one undo step). */
  commitDrag: () => void;
  undo: () => void;
  redo: () => void;
  selectFeature: (id: string | null) => void;
  /** Pick several features in the list; `primary` is the one clicked last (the one Edit, the eye etc. act on). */
  selectFeatures: (ids: string[], primary: string | null) => void;
  setSelection: (items: SelectionItem[]) => void;
  setAreaSelection: (selection: AreaSelection | null) => void;
  toggleHidden: (partId: string) => void;
  setShowFlat: (on: boolean) => void;
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
  /** Join parts into one (adds a Boolean join feature, one undo step). */
  mergeParts: (ids: string[]) => void;
  /** Draw parts see-through, or solid again. */
  setPartsTransparent: (ids: string[], on: boolean) => void;
  selectPlane: (plane: PlaneName | null) => void;
  setListHoverPlane: (plane: PlaneName | null) => void;
  toggleDatum: (datum: DatumName) => void;
  openDialog: (d: DialogName) => void;
  setSection: (section: SectionView | null) => void;
  setPrintBed: (printBed: { printer: string; custom?: [number, number, number] } | null) => void;
  showToast: (text: string, tone?: Toast["tone"]) => void;

  // set by the kernel connection
  setKernelStatus: (status: AppState["kernelStatus"], error?: string) => void;
  setRebuildBusy: (busy: boolean) => void;
  setRebuildResult: (
    parts: PartMesh[],
    featureErrors: Record<string, string>,
    ms: number,
    rebuilt?: string[],
    studioOrder?: string[],
    sketchLinks?: Record<string, SketchLinkInfo>,
    featureWarnings?: Record<string, string>,
    featureNotes?: Record<string, string>,
    followed?: Record<string, FollowedFrame>,
    curves?: Record<string, number[][]>,
  ) => void;
  /** Curve features (Helix, Fit spline…) as the engine built them: lines to draw (RebuildResult.curves, every Part Studio). */
  builtCurves: Record<string, number[][]>;
  /** Measured variables (by feature id): the value each came to in the last build (RebuildResult.measuredValues). */
  measuredValues: Record<string, MeasuredValue>;
  /**
   * Where Plane features that follow the model and mate connectors are, as the engine built them (RebuildResult.followed,
   * every Part Studio). Shown and used instead of what the design's numbers give; the design stays as clicked.
   */
  builtFrames: Record<string, FollowedFrame>;
  /** The Move / copy triad being dragged: the boxes' values so far (null when the drag ends or is taken back). */
  setTransformLive: (values: Record<string, string> | null) => void;
  /** Change the open draft as one step of the dialog's own undo (a finished drag of the triad, say). */
  changeDraftStep: (patch: { params?: Record<string, string>; transform?: Feature["transform"] }) => void;
  /** Undo the open dialog's last step (see changeDraftStep). False when there's nothing to undo. */
  undoDraftStep: () => boolean;
  /** A manipulator being dragged: the open draft changed live (rebuilt as usual), not yet a step of its undo. */
  dragDraft: (patch: { params?: Record<string, string>; fields?: Partial<Feature> }) => void;
  /** The manipulator drag that began at `before` is over: one step of the dialog's undo, or (`cancel`) taken back. */
  endDraftDrag: (before: Feature, cancel?: boolean) => void;
}

// The browser-storage keys are in browserKeep.ts (the design's keeps the app's old name, PartSmith, on purpose).
export { STORAGE_KEY, VERSIONS_KEY } from "./browserKeep";

/** Which file the design in browser storage was last saved to, so "Saved" survives a page refresh. */
const FILE_KEY = "partsmith.file.v1";
const NICE_LIGHTING_KEY = "juracad.niceLighting";

function readNiceLighting(): boolean {
  try {
    return globalThis.localStorage?.getItem(NICE_LIGHTING_KEY) === "1";
  } catch {
    return false;
  }
}

/** A short fingerprint of a design, to tell whether it changed since it was saved. */
export function fingerprint(doc: JuraCADDocument): string {
  const text = JSON.stringify(doc);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${h >>> 0}`;
}

function rememberFile(doc: JuraCADDocument, fileName: string | null) {
  try {
    if (fileName) globalThis.localStorage?.setItem(FILE_KEY, JSON.stringify({ fileName, print: fingerprint(doc) }));
    else globalThis.localStorage?.removeItem(FILE_KEY);
  } catch {
    // storage blocked: only the label is affected
  }
}

/** The saved-file label for a design just loaded from browser storage. */
function savedFileFor(doc: JuraCADDocument): { savedDoc: JuraCADDocument | null; fileName: string | null } {
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

function loadSavedDocument(): JuraCADDocument {
  try {
    const storage = globalThis.localStorage;
    const kept = storage ? readKept(storage) : null;
    if (kept) {
      // The same design carries on with the same keep id (so its versions stay tied to it).
      if (kept.keep) keepIds.set(designKey(kept.doc), kept.keep);
      return kept.doc;
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
  tool: "select",
  selection: [],
  construction: false,
  message: null,
  editingDimension: null,
  provisional: [],
  polygonSides: 6,
  filletRadius: "2",
  offsetDistance: "2",
  patternKind: "linear",
  patternCount: 3,
  patternSpacing: "10",
  patternAngle: "0",
  patternCentre: "origin",
  moveDx: "10",
  moveDy: "0",
  moveAngle: "0",
  moveCopy: false,
});

/** Is this id (point, curve or constraint) still in the sketch? */
const existsIn = (d: SketchData, id: string) =>
  d.points.some((p) => p.id === id) || d.curves.some((c) => c.id === id) || d.constraints.some((c) => c.id === id) || id === "origin" || isExtraId(d, id);

/**
 * Which design each document in the undo list belongs to. A change keeps the
 * design; New, Open, a new design from a version, or Claude opening another
 * design starts another. Undo and redo carry the versions along only within
 * one design, so stepping back past Open doesn't hand the opened file's
 * versions to the design you had before.
 */
const designKeys = new WeakMap<JuraCADDocument, number>();
let nextDesignKey = 1;
export function designKey(doc: JuraCADDocument): number {
  let k = designKeys.get(doc);
  if (!k) designKeys.set(doc, (k = nextDesignKey++));
  return k;
}
/** Each design's keep id (by design key), tying it to its versions in browser storage (browserKeep.ts). */
const keepIds = new Map<number, string>();
export function keepIdOf(doc: JuraCADDocument): string {
  const k = designKey(doc);
  let id = keepIds.get(k);
  if (!id) keepIds.set(k, (id = newKeepId()));
  return id;
}
/** `next` is the same design as `from` (a change, or the same document with other versions). */
function sameDesign(next: JuraCADDocument, from: JuraCADDocument) {
  if (next !== from) designKeys.set(next, designKey(from));
}

export const useStore = create<AppState>((set, get) => {
  /** The last options each kind of new feature was made with, this session (lastOptions.ts). */
  let remembered: OptionsMemory = {};
  // A new feature's self-worked-out starting values (an Extrude's direction into the part, a pattern's spacing), kept
  // up to date while the user hasn't changed them; and the parts as they were when its dialog opened.
  let autoValues: AutoValues = { id: "" };
  let autoParts: PartMesh[] = [];
  const autoContext = (): AutoContext => {
    const s = get();
    const features = activeFeatures(s);
    return {
      planeOf: (id) => followedSketch(features.find((f) => f.id === id && f.type === "sketch"), s.sketchLinks)?.plane ?? null,
      parts: autoParts,
      features,
      unit: s.history.present.units === "in" ? "in" : "mm",
    };
  };
  // The sketch a new Hole's face clicks make (see placeHoleAt): kept out of the undo history until Accept, when it goes
  // in with the hole as one step; Cancel takes it away again. `placed` is the document as the last click left it, and
  // `clean` says nothing else has changed the design since the first click (then `before` can simply be put back).
  let holeSketch: { draftId: string; sketch: Feature; before: History; placed: JuraCADDocument; clean: boolean; studio: string } | null = null;
  const dropHoleSketch = () => {
    if (!holeSketch) return;
    const { before, placed, clean, sketch, studio } = holeSketch;
    holeSketch = null;
    const h = get().history;
    if (clean && h.present === placed) {
      set({ history: before });
      return;
    }
    // Something else changed the design meanwhile (or another document is open now): take only the sketch out again,
    // never putting back an older design.
    if (!studioFeatures(h.present, studio).some((f) => f.id === sketch.id)) return;
    set({ history: { ...h, present: inStudio(h.present, studio, (doc) => removeFeature(doc, sketch.id)) } });
  };
  const withAuto = (draft: Feature, mode: "create" | "edit"): Feature => {
    if (mode !== "create" || autoValues.id !== draft.id) return draft;
    const r = withAutoValues(draft, autoValues, autoContext());
    autoValues = r.auto;
    return r.draft;
  };
  /**
   * Apply a document change and record it for undo. Refused while an old
   * version is open, except changes to what's shown (`display`: the eye, P),
   * which only change the old version's copy on screen.
   */
  const change = (fn: (doc: JuraCADDocument) => JuraCADDocument, display = false) => {
    if (!display && readOnly()) return;
    set((s) => {
      const next = fn(s.history.present);
      // Keep sketches (and anything else) on Plane features where their planes are now.
      const settled = next === s.history.present ? next : refreshDocumentPlanes(next, resolveVariables(next.variables).values);
      const history = commit(s.history, settled);
      sameDesign(history.present, s.history.present);
      return { history };
    });
  };
  /** True (and says so, at most every few seconds) while an old version is open: it can't be changed. */
  let readOnlySaid = 0;
  const readOnly = () => {
    const v = get().versionView;
    if (!v) return false;
    if (Date.now() - readOnlySaid > 3000) {
      readOnlySaid = Date.now();
      get().showToast(`You're looking at the old version "${v.name}", which can't be changed. Click "Back to the current design" (at the top) to carry on working, or "Restore this version".`, "error");
    }
    return true;
  };
  /** Leaving an old version: the current design and what was on show come back. */
  const unview = (s: AppState): Partial<AppState> =>
    s.versionView ? { history: s.versionView.stash, versionView: null, ...s.versionView.was, selection: [], selectedParts: [], selectedFeatureId: null, asmSelection: [] } : {};
  /** A change to the features of the Part Studio on show. */
  const changeStudio = (fn: (doc: JuraCADDocument) => JuraCADDocument, display = false) =>
    change((doc) => inStudio(doc, activeStudioId(get()) ?? firstStudioId(get().history.present), fn), display);
  /** Undo or redo, keeping the versions as they are now when the step stays within the same design. */
  const step = (move: (h: History) => History) =>
    set((s) => {
      if (s.editing || s.mateDraft) return {};
      const h = move(s.history);
      if (h === s.history) return {};
      const present = designKey(h.present) === designKey(s.history.present) ? withVersionsOf(h.present, s.history.present) : h.present;
      sameDesign(present, h.present);
      return { history: { ...h, present }, selection: [] };
    });
  /** The document as the Part Studio on show sees it (its features in `features`). */
  const view = () => studioView(get().history.present, activeStudioId(get()) ?? firstStudioId(get().history.present));

  const initialDoc = loadSavedDocument();
  return {
    ...savedFileFor(initialDoc),
    history: historyOf(initialDoc),
    versionView: null,
    versionCompare: null,
    setVersionCompare: (versionCompare) => set({ versionCompare }),
    enterVersionView: (v, doc) =>
      set((s) => {
        const stash = s.versionView?.stash ?? s.history;
        const was = s.versionView?.was ?? { activeTab: s.activeTab, rollbackTo: s.rollbackTo, hiddenParts: s.hiddenParts, transparentParts: s.transparentParts };
        const tab = s.activeTab;
        const tabThere = !!tab && (studioExists(doc, tab) || !!doc.assemblies?.some((a) => a.id === tab) || !!doc.drawings?.some((d) => d.id === tab));
        return {
          versionView: { ...v, stash, was },
          // The old design, with the current list of versions (so the Versions panel still lists them all).
          history: historyOf(stash.present.versions ? { ...doc, versions: stash.present.versions } : doc),
          activeTab: tabThere ? tab : null,
          rollbackTo: null,
          editing: null,
          sketch: null,
          selection: [],
          selectedParts: [],
          selectedFeatureId: null,
          selectedPlane: null,
          hiddenParts: [],
          transparentParts: [],
          asmSelection: [],
          mateDraft: null,
          areaSelection: null,
          showFlat: false,
          versionCompare: null,
        };
      }),
    leaveVersionView: () => set((s) => unview(s)),
    changeDocument: (fn) => change(fn),
    changeVersions: (fn) => {
      if (readOnly()) return;
      set((s) => {
        const present = fn(s.history.present);
        if (present === s.history.present) return {};
        sameDesign(present, s.history.present);
        return { history: { ...s.history, present } };
      });
    },
    refuseReadOnly: () => readOnly(),
    storageProblem: null,
    editing: null,
    sketch: null,
    selectedFeatureId: null,
    featureSelection: NO_DIMS,
    selection: [],
    areaSelection: null,
    section: null,
    printBed: null,
    hiddenParts: [],
    transparentParts: [],
    showFlat: false,
    selectedParts: [],
    selectedPlane: null,
    listHoverPlane: null,

    kernelStatus: "loading",
    kernelError: null,
    rebuildBusy: false,
    parts: [],
    featureErrors: {},
    featureWarnings: NO_WARNINGS,
    featureNotes: NO_WARNINGS,
    transformCentres: NO_CENTRES,
    framePaths: NO_FRAME_PATHS,
    transformLive: null,
    draftSteps: null,
    setTransformLive: (transformLive) => set({ transformLive }),
    changeDraftStep: (patch) =>
      set((s) => {
        if (!s.editing) return {};
        const d = s.editing.draft;
        const draft = { ...d, ...(patch.params ? { params: { ...d.params, ...patch.params } } : {}), ...(patch.transform ? { transform: patch.transform } : {}) };
        return { editing: { ...s.editing, draft }, draftSteps: draftStepAfter(s.draftSteps, d), transformLive: null };
      }),
    dragDraft: (patch) =>
      set((s) => {
        if (!s.editing) return {};
        const d = s.editing.draft;
        return { editing: { ...s.editing, draft: { ...d, ...patch.fields, ...(patch.params ? { params: { ...d.params, ...patch.params } } : {}) } } };
      }),
    endDraftDrag: (before, cancel) =>
      set((s) => {
        if (!s.editing || s.editing.draft.id !== before.id || s.editing.draft === before) return {};
        if (cancel) return { editing: { ...s.editing, draft: before } };
        return { draftSteps: draftStepAfter(s.draftSteps, before) };
      }),
    undoDraftStep: () => {
      const s = get();
      const steps = s.draftSteps;
      if (!s.editing || !steps || steps.id !== s.editing.draft.id || !steps.drafts.length) return false;
      const draft = steps.drafts[steps.drafts.length - 1];
      set({ editing: { ...s.editing, draft }, draftSteps: { id: steps.id, drafts: steps.drafts.slice(0, -1) }, transformLive: null });
      return true;
    },
    sketchLinks: NO_LINKS,
    builtFrames: NO_FRAMES,
    builtCurves: NO_CURVES,
    measuredValues: NO_MEASURED,
    sketchCandidates: null,
    setSketchCandidates: (sketchCandidates) => set({ sketchCandidates }),
    lastRebuildMs: null,

    dialog: null,
    library: null,
    toast: null,
    activeTab: null,
    asmSelection: [],
    hiddenInstances: [],
    mateDraft: null,
    dragPreview: null,
    animatingMate: null,
    setAnimatingMate: (animatingMate) => set({ animatingMate }),
    drawingTool: "select",
    selectedDim: null,
    selectedDims: NO_DIMS,
    rollbackTo: null,
    showFinal: false,
    setShowFinal: (showFinal) => set({ showFinal }),

    startCreate: (type) => {
      if (readOnly()) return;
      dropHoleSketch();
      // A new dialog starts with nothing to undo in it.
      set({ draftSteps: null, transformLive: null });
      const s = get();
      if (type === "sketch") {
        // On the highlighted plane, or Plane feature, if any — or the plane of the sketch whose areas are selected.
        const planeFeature = activeFeatures(s).find((f) => f.id === s.selectedFeatureId && (f.type === "plane" || f.type === "mateConnector"));
        const frame = planeFeature ? framesOf(activeFeatures(s), undefined, s.builtFrames).get(planeFeature.id) : undefined;
        const sel = s.areaSelection;
        const areaPlane = sel ? (followedSketch(activeFeatures(s).find((f) => f.id === sel.sketch && f.type === "sketch"), s.sketchLinks)?.plane ?? null) : null;
        s.startSketch(planeFeature && frame ? planeAsSketchPlane(planeFeature, frame) : s.selectedPlane ? { kind: "default", name: s.selectedPlane } : areaPlane);
        return;
      }
      // The last options used for this kind of feature (Onshape keeps them for the next one).
      const draft = withRemembered(createFeature(view(), type), remembered);
      const features = activeFeatures(s);
      // Extrude or revolve the sketch that's highlighted in the list, if any.
      if (isSketchSolid(type)) {
        const picked = features.find((f) => f.id === s.selectedFeatureId && f.type === "sketch");
        if (picked) {
          draft.sketchRef = picked.id;
          if (type === "revolve" && picked.sketch) draft.revolve = { axis: defaultAxis(picked.sketch.data), flip: false };
        } else {
          // Else the last sketch with closed shapes left to use (as Hole's), else none: never a used-up sketch.
          const bar = s.rollbackTo ? features.findIndex((f) => f.id === s.rollbackTo) : -1;
          const before = bar >= 0 ? features.slice(0, bar + 1) : features;
          const id = sketchToExtrude(before, usedSketches(features), (f) => followedSketch(f, s.sketchLinks)?.data);
          draft.sketchRef = id;
          const chosen = id ? features.find((f) => f.id === id) : undefined;
          if (type === "revolve") draft.revolve = { axis: chosen?.sketch ? defaultAxis(chosen.sketch.data) : "vertical", flip: false };
        }
      }
      if (isSketchSolid(type) || type === "sweep") {
        // Areas clicked in the 3D view beforehand (as in Onshape): use them.
        // Areas of several sketches: the first is the feature's own sketch, the others its `moreAreas` (as in Onshape).
        const sel = s.areaSelection;
        const usable = (id: string) => !!features.find((f) => f.id === id && f.type === "sketch" && !f.suppressed && f.sketch?.plane);
        const start = sel ? selectionStart(sel, usable, true) : null;
        const chosen = start ? features.find((f) => f.id === start.sketchRef) : undefined;
        // A sketch highlighted in the list wins (the two aren't normally selected together).
        const listed = features.some((f) => f.id === s.selectedFeatureId && f.type === "sketch");
        if (start && chosen?.sketch && !listed) {
          draft.sketchRef = start.sketchRef;
          draft.areas = start.areas;
          if (start.moreAreas) draft.moreAreas = start.moreAreas;
          if (type === "revolve") draft.revolve = { axis: defaultAxis(chosen.sketch.data), flip: false };
          // A sweep's path is another sketch (not one of the profiles).
          const profiles = new Set([start.sketchRef, ...(start.moreAreas ?? []).map((m) => m.sketch)]);
          if (type === "sweep" && draft.pathRef && profiles.has(draft.pathRef)) draft.pathRef = features.filter((f) => f.type === "sketch" && !f.suppressed && !profiles.has(f.id)).at(-1)?.id;
        } else if (draft.sketchRef && type !== "sweep") {
          // A sketch other features already use: start with the areas that are left (Extrude 2 of the other circle).
          const data = followedSketch(features.find((f) => f.id === draft.sketchRef), s.sketchLinks)?.data;
          const free = data ? freeAreas(features, draft.sketchRef, data) : undefined;
          if (free) draft.areas = free;
        }
      }
      // Transform the part that's selected in the 3D view (or the latest part).
      if (type === "transform" && draft.transform) {
        // Not a part only a cancelled dialog's preview made (it goes with the next rebuild).
        const kept = new Set(features.map((f) => f.id));
        const mine = studioParts(s).filter((p) => kept.has(p.id.split("~")[0]));
        const partId = s.selection[0]?.partId ?? mine[mine.length - 1]?.id;
        if (partId) draft.transform = { ...draft.transform, partId };
      }
      // A new plane starts offset from the standard plane selected in the list (or 3D view), if any.
      if (type === "plane" && draft.planeDef && s.selectedPlane) draft.planeDef = { ...draft.planeDef, ref: { kind: "default", name: s.selectedPlane } };
      // Split starts with the part picked in the Parts list (or clicked in the 3D view).
      if (type === "split" && draft.splitDef) {
        const partId = s.selectedParts[0] ?? s.selection[0]?.partId;
        if (partId) draft.splitDef = { ...draft.splitDef, partId, picking: "plane" };
        if (s.selectedPlane) draft.splitDef = { ...draft.splitDef, plane: { kind: "default", name: s.selectedPlane } };
      }
      // Face features start with the faces selected.
      if (type === "thicken" || type === "draft" || type === "moveFace" || type === "replaceFace" || type === "deleteFace" || type === "modifyFillet" || type === "thread" || type === "fullRound" || type === "wrap" || type === "enclose" || type === "offsetSurface") {
        draft.picks = s.selection
          .filter((item) => item.kind === "face")
          .map((item) => pickFor(s.parts, item))
          .filter((p): p is TopoPick => p !== null);
      }
      // A Face blend starts with the faces selected as side 1; a Boundary surface with the edges selected as U curves.
      if (type === "faceBlend") {
        const faces = s.selection
          .filter((item) => item.kind === "face")
          .map((item) => pickFor(s.parts, item))
          .filter((p): p is TopoPick => p !== null);
        draft.picks = faces;
        if (faces.length && draft.blend) draft.blend = { ...draft.blend, picking: "side2" };
      }
      if (type === "boundary" && draft.boundary) {
        const edges = s.selection
          .filter((item) => item.kind === "edge")
          .map((item) => pickFor(s.parts, item))
          .filter((p): p is TopoPick => p !== null)
          .slice(0, 2);
        if (edges.length) draft.boundary = { ...draft.boundary, u: edges.map((edge) => ({ edge })) };
      }
      // A flange (or Fill) starts with the edges selected.
      if (type === "flange" || type === "hem" || type === "cornerBreak" || type === "fill" || type === "extendSurface" || type === "ruled") {
        draft.picks = s.selection
          .filter((item) => item.kind === "edge")
          .map((item) => pickFor(s.parts, item))
          .filter((p): p is TopoPick => p !== null);
      }
      // A rib (or sheet metal) uses the sketch highlighted in the list, if any.
      if (type === "rib" || type === "sheetMetal" || type === "tab" || type === "bend" || type === "jog") {
        const picked = features.find((f) => f.id === s.selectedFeatureId && f.type === "sketch");
        if (picked) draft.sketchRef = picked.id;
        // Sheet metal with faces of a part selected (and no sketch highlighted): made from the part, those faces its walls.
        // (Only flat faces of a solid part that isn't sheet metal already.)
        const faces = s.selection.filter((item) => item.kind === "face");
        const convertible =
          faces.length > 0 &&
          faces.every((item) => {
            const part = s.parts.find((p) => p.id === item.partId);
            return !!part && !part.surface && !part.flat && part.faceRefs?.[item.index]?.surface === "PLANE";
          });
        if (type === "sheetMetal" && !picked && convertible) {
          draft.sheetConvert = true;
          draft.sketchRef = undefined;
          draft.picks = s.selection.map((item) => pickFor(s.parts, item)).filter((p): p is TopoPick => p !== null);
        }
        // No sketch to make it from, but a part: made from the part.
        if (type === "sheetMetal" && !draft.sketchRef && !draft.sheetConvert) {
          draft.sheetConvert = true;
          draft.picks = [];
        }
      }
      // Delete part starts with the parts picked in the Parts list.
      if (type === "deletePart") draft.deleteParts = [...s.selectedParts];
      // Simplify part starts with the parts picked in the Parts list.
      if (type === "simplify") draft.simplifyParts = [...s.selectedParts];
      // A Boolean starts with the parts picked in the Parts list.
      if (type === "boolean" && draft.booleanDef && s.selectedParts.length) draft.booleanDef = { ...draft.booleanDef, targets: [...s.selectedParts] };
      // A plane starts from the plane (or Plane feature) highlighted, if any.
      if (type === "plane" && draft.planeDef) {
        const picked = features.find((f) => f.id === s.selectedFeatureId && f.type === "plane");
        const frame = picked ? framesOf(features, undefined, s.builtFrames).get(picked.id) : undefined;
        if (picked && frame) draft.planeDef = { ...draft.planeDef, ref: planeAsSketchPlane(picked, frame) };
        else if (s.selectedPlane) draft.planeDef = { ...draft.planeDef, ref: { kind: "default", name: s.selectedPlane } };
      }
      // A hole uses the sketch highlighted in the list, if any.
      if (type === "hole" && draft.hole) {
        // (Rolled back: only what's above the bar counts.)
        const bar = s.rollbackTo ? features.findIndex((f) => f.id === s.rollbackTo) : -1;
        const before = bar >= 0 ? features.slice(0, bar + 1) : features;
        draft.hole = { ...draft.hole, sketchRef: holeSketchFor(before, s.selectedFeatureId, usedSketches(features), (f) => (f.sketch ? holePositionCount(f.sketch.data) : 0)) };
      }
      // Mirror and circular patterns start with no plane or axis: the dialog asks for one to be clicked
      // (Onshape does the same), rather than quietly using the origin.
      if (draft.mirror) draft.mirror = { ...draft.mirror, unset: true };
      if (type === "circularPattern" && draft.pattern) draft.pattern = { ...draft.pattern, unset: true };
      // Mirror and patterns start with the features highlighted in the list (every one picked), if they make solids.
      if (isPatternFeature(type)) {
        const picked = pickedFeatures(s).filter((id) => features.some((f) => f.id === id && isSolidFeature(f.type)));
        if (picked.length) {
          if (draft.mirror) draft.mirror = { ...draft.mirror, sources: picked };
          if (draft.pattern) draft.pattern = { ...draft.pattern, sources: picked };
        }
      }
      // As in Onshape: a pattern started with parts picked (in the Parts list) repeats those parts; with faces picked in
      // the view, those faces (a boss or pocket). A mirror started with faces picked mirrors them.
      const pickedFaces = s.selection.filter((item) => item.kind === "face").map((item) => pickFor(s.parts, item)).filter((p): p is TopoPick => p !== null);
      if (draft.pattern && s.selectedParts.length) draft.pattern = { ...draft.pattern, of: "part", parts: [...s.selectedParts], sources: [] };
      else if (draft.pattern && pickedFaces.length) {
        draft.pattern = { ...draft.pattern, of: "face", sources: [] };
        draft.picks = pickedFaces;
      } else if (draft.mirror && pickedFaces.length) {
        draft.mirror = { ...draft.mirror, of: "face", sources: [] };
        draft.picks = pickedFaces;
      }
      // A composite part starts with the parts picked in the Parts list.
      if (type === "composite") draft.compositeParts = [...s.selectedParts];
      // Fillet, chamfer and shell start with whatever is selected (faces only, for shell).
      if (isPickFeature(type)) {
        draft.picks = s.selection
          .filter((item) => type !== "shell" || item.kind === "face")
          .map((item) => pickFor(s.parts, item))
          .filter((p): p is TopoPick => p !== null);
      }
      autoParts = studioParts(s);
      autoValues = { id: draft.id, flip: draft.extrude?.flip ?? false, spacing: draft.params.spacing, spacing2: draft.params.spacing2 };
      const started = withAuto(draft, "create");
      set({ editing: { mode: "create", draft: started }, sketch: null, selectedFeatureId: null, featureSelection: NO_DIMS, selection: [], areaSelection: null, selectedPlane: null, showFlat: false });
    },

    startImport: (file) => {
      if (readOnly()) return;
      const s = get();
      const draft = createFeature(view(), "import");
      draft.import = file;
      const base = importName(file.fileName);
      const used = new Set(activeFeatures(s).map((f) => f.name));
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base} (${n})`;
      draft.name = name;
      set({ editing: { mode: "create", draft }, sketch: null, selectedFeatureId: null, selection: [], selectedPlane: null, showFlat: false });
    },

    startEdit: (id) => {
      if (readOnly()) return;
      dropHoleSketch();
      const f = activeFeatures(get()).find((x) => x.id === id);
      if (!f) return;
      set({ draftSteps: null, transformLive: null });
      set({
        editing: { mode: "edit", draft: { ...f, params: { ...f.params } } },
        showFlat: false,
        sketch: f.type === "sketch" ? newSession() : null,
        selectedFeatureId: id,
        featureSelection: NO_DIMS,
        selectedPlane: null,
        selection: [],
      });
    },

    startSketch: (plane) => {
      if (readOnly()) return;

      const draft = createFeature(view(), "sketch");
      draft.sketch = { plane, data: draft.sketch!.data };
      set({
        editing: { mode: "create", draft },
        showFlat: false,
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

    repickSketchPlane: () =>
      set((s) =>
        s.editing?.draft.sketch && s.sketch
          ? {
              editing: { ...s.editing, draft: { ...s.editing.draft, sketch: { ...s.editing.draft.sketch, plane: null } } },
              sketch: { ...s.sketch, message: { text: "Click a flat face, or Top, Front or Right, to put the sketch on.", tone: "info" } },
            }
          : {},
      ),

    updateSketch: (next, opts = {}) =>
      set((s) => {
        if (!s.editing?.draft.sketch || !s.sketch) return {};
        const prev = s.editing.draft.sketch.data;
        // Texts and pictures stay, even through edits that only know about points, curves and constraints.
        const data = keepSketchExtras(prev, next);
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

    setSketchTool: (tool) => {
      get().discardOfferedDimensions();
      set((s) => (s.sketch ? { sketch: { ...s.sketch, tool, message: null, editingDimension: null } } : {}));
    },
    setSketchSelection: (selection) => set((s) => (s.sketch ? { sketch: { ...s.sketch, selection } } : {})),
    setSketchMessage: (text, tone = "info") =>
      set((s) => (s.sketch ? { sketch: { ...s.sketch, message: text ? { text, tone } : null } } : {})),
    setSketchConstruction: (construction) => set((s) => (s.sketch ? { sketch: { ...s.sketch, construction } } : {})),
    setSketchOptions: (patch) => set((s) => (s.sketch ? { sketch: { ...s.sketch, ...patch } } : {})),
    setEditingDimension: (editingDimension) => set((s) => (s.sketch ? { sketch: { ...s.sketch, editingDimension } } : {})),
    offerDimensions: (ids) => set((s) => (s.sketch ? { sketch: { ...s.sketch, provisional: ids, editingDimension: ids[0] ?? null } } : {})),
    nextOfferedDimension: (id, back = false) =>
      set((s) => {
        const next = nextOffered(s.sketch?.provisional ?? [], id, back);
        return s.sketch && next ? { sketch: { ...s.sketch, editingDimension: next } } : {};
      }),
    keepOfferedDimension: (id, close = false) => {
      set((s) => {
        if (!s.sketch) return {};
        const provisional = s.sketch.provisional.filter((x) => x !== id);
        return { sketch: { ...s.sketch, provisional, editingDimension: close ? null : provisional[0] ?? null } };
      });
      // Enter: the offering ends — the sizes not kept go (Onshape's), so no box opens again to take the next key.
      if (close) get().discardOfferedDimensions();
    },
    discardOfferedDimensions: (keepTyped = false) => {
      const s = get();
      let data = s.editing?.draft.sketch?.data;
      const typed = takeTyped(s.sketch?.provisional ?? []);
      if (!s.sketch || !data || s.sketch.provisional.length === 0) return;
      // Typed in its box, then drawing carried on: the size is set and kept (a value that can't be used is dropped).
      const kept = new Set<string>();
      if (keepTyped) {
        for (const [id, value] of typed) {
          const r = setDimensionValue(data, id, value);
          if (r.error) continue;
          data = r.sketch;
          kept.add(id);
        }
      }
      const gone = s.sketch.provisional.filter((id) => !kept.has(id) && data!.constraints.some((c) => c.id === id));
      set({ sketch: { ...s.sketch, provisional: [], editingDimension: null } });
      if (kept.size) get().updateSketch(gone.length ? deleteItems(data, gone) : data, { record: true });
      else if (gone.length) get().updateSketch(deleteItems(data, gone), { record: false });
    },

    setDraftParam: (key, value) =>
      set((s) => {
        if (!s.editing) return {};
        const d = s.editing.draft;
        // Move / copy keeps its own undo: typing in a box is a step (typing on in the same box adds to it).
        const steps = keepsSteps(d) ? { draftSteps: draftStepAfter(s.draftSteps, d, `param:${key}`) } : {};
        return { editing: { ...s.editing, draft: { ...d, params: { ...d.params, [key]: value } } }, ...steps };
      }),

    setDraftField: (patch) =>
      set((s) => {
        if (!s.editing) return {};
        const d = s.editing.draft;
        // (Another box taking clicks stops the merge-scope box picking: one box picks at a time.)
        const next = scopePickingAfter(patch, patch.picks && d.variableFillet ? tidyRadiusPoints({ ...d, ...patch }) : { ...d, ...patch });
        // Move / copy: a change is a step of its own undo — except only choosing what a click picks next.
        const { picking: _a, ...was } = d.transform ?? ({} as NonNullable<Feature["transform"]>);
        const { picking: _b, ...now } = next.transform ?? ({} as NonNullable<Feature["transform"]>);
        const onlyPicking = Object.keys(patch).every((k) => k === "transform") && JSON.stringify(was) === JSON.stringify(now);
        const steps = keepsSteps(d) && !onlyPicking ? { draftSteps: draftStepAfter(s.draftSteps, d, Object.keys(patch).join(",") === "name" ? "name" : undefined) } : {};
        return { editing: { ...s.editing, draft: withAuto(next, s.editing.mode) }, ...steps };
      }),

    toggleDraftPick: (pick) =>
      set((s) => {
        if (!s.editing) return {};
        const picks = s.editing.draft.picks ?? [];
        const steps = keepsSteps(s.editing.draft) ? { draftSteps: draftStepAfter(s.draftSteps, s.editing.draft) } : {};
        // Variable fillet: a click on an edge it already rounds puts a radius point there (the list's × still removes it).
        const pointed = clickRadiusPoint(s.editing.draft, pick);
        if (pointed) return pointed === s.editing.draft ? {} : { editing: { ...s.editing, draft: pointed }, ...steps };
        // (A variable fillet's click point on an edge only says where a radius goes; a face keeps its own.)
        const { at: _at, ...plain } = pick;
        const i = picks.findIndex((p) => p.partId === pick.partId && sameRef(p.ref, pick.ref));
        const next = i >= 0 ? picks.filter((_, j) => j !== i) : [...picks, s.editing.draft.variableFillet && pick.ref.kind === "edge" ? plain : pick];
        return { editing: { ...s.editing, draft: tidyRadiusPoints({ ...s.editing.draft, picks: next }) }, ...steps };
      }),

    toggleDraftPart: (partId) => {
      const d0 = get().editing?.draft;
      // Never a part the open feature makes itself (a copy or the composite): it would use itself.
      if (d0 && (d0.type === "composite" || d0.pattern?.of === "part" || d0.mergeScopePicking) && madeByDraft(partId, d0.id)) {
        get().showToast(`That part is made by ${d0.name} itself. Click one of the parts made before it.`, "info");
        return;
      }
      set((s) => {
        const d = s.editing?.draft;
        if (!s.editing || !d) return {};
        const toggle = (list: string[]) => (list.includes(partId) ? list.filter((x) => x !== partId) : [...list, partId]);
        // The merge-scope box taking clicks: the part is put in (or taken out of) the parts to merge with / cut.
        if (d.mergeScopePicking) return { editing: { ...s.editing, draft: toggleScopePart(d, partId) } };
        if (d.type === "composite") return { editing: { ...s.editing, draft: { ...d, compositeParts: toggle(d.compositeParts ?? []) } } };
        if (d.pattern?.of === "part") return { editing: { ...s.editing, draft: withAuto({ ...d, pattern: { ...d.pattern, parts: toggle(d.pattern.parts ?? []), picking: "items" } }, s.editing.mode) } };
        return {};
      });
    },

    toggleDraftSource: (featureId) =>
      set((s) => {
        if (!s.editing) return {};
        const d = s.editing.draft;
        const toggle = (list: string[]) => (list.includes(featureId) ? list.filter((x) => x !== featureId) : [...list, featureId]);
        if (d.mirror) return { editing: { ...s.editing, draft: { ...d, mirror: { ...d.mirror, sources: toggle(d.mirror.sources) } } } };
        if (d.pattern) return { editing: { ...s.editing, draft: withAuto({ ...d, pattern: { ...d.pattern, sources: toggle(d.pattern.sources) } }, s.editing.mode) } };
        return {};
      }),

    setDraftMirrorPlane: (plane) =>
      set((s) =>
        s.editing?.draft.mirror ? { editing: { ...s.editing, draft: { ...s.editing.draft, mirror: setMirrorReference(s.editing.draft.mirror, { kind: "plane", plane }) } } } : {},
      ),

    commitDraft: () => {
      // Dimensions offered but not kept aren't part of the sketch.
      get().discardOfferedDimensions();
      const { editing } = get();
      if (!editing) return false;
      if (editing.draft.type === "sketch" && !editing.draft.sketch?.plane) {
        get().setSketchMessage("Pick a plane or flat face to sketch on first.", "error");
        return false;
      }
      const { errors } = resolveParams(editing.draft);
      if (Object.keys(errors).length > 0) return false;
      // Nothing picked yet where something must be (a fillet with no edges): not accepted, as Onshape's greyed ✓.
      const original = editing.mode === "edit" ? activeFeatures(get()).find((f) => f.id === editing.draft.id) : null;
      const missing = acceptBlocker(editing.draft, original, { table: (get().history.present.variables ?? []).map((v) => v.name), features: activeFeatures(get()) });
      if (missing) {
        get().showToast(missing, "info");
        return false;
      }
      // A printed fit chosen in the Hole dialog brings its fit_* variables into the design, in the same undo step.
      const fitted = settlePrintedFit(get().history.present.variables, editing.draft, () => newId("v"));
      const named = withoutPicking({ ...fitted.draft, name: fitted.draft.name.trim() || "Unnamed feature" });
      // Part edges brought in just to snap to, that nothing uses any more, are tidied away.
      const sk = named.sketch;
      const draft = sk ? { ...named, sketch: { ...sk, data: withoutEmptyExtras(pruneReferences(sk.data)) } } : named;
      // Rolled back: a new feature goes in at the rollback point, and the bar moves down past it.
      const at = get().rollbackTo;
      // A sketch the Hole's face clicks made goes in just before it, in the same undo step.
      const made = holeSketch && holeSketch.draftId === draft.id && draft.hole?.sketchRef === holeSketch.sketch.id ? holeSketch.sketch : null;
      dropHoleSketch();
      // A measured variable renamed: the features using it follow the new name (as a renamed variable's do).
      const renamed = (doc: JuraCADDocument) => {
        const from = original?.measured?.name;
        const to = draft.measured?.name;
        return from && to && from !== to ? { ...doc, features: renameInFeatures(doc.features, from, to) } : doc;
      };
      const placeOne = (doc: JuraCADDocument) => (editing.mode === "create" ? (at ? insertFeatureAfter(doc, draft, at) : addFeature(doc, draft)) : renamed(replaceFeature(doc, keepVisibility(doc, draft))));
      const place = made ? (doc: JuraCADDocument) => (at ? insertFeatureAfter(insertFeatureAfter(doc, made, at), draft, made.id) : addFeature(addFeature(doc, made), draft)) : placeOne;
      if (fitted.variables !== get().history.present.variables) {
        const vars = fitted.variables;
        change((doc) => inStudio({ ...doc, variables: vars }, activeStudioId(get()) ?? firstStudioId(get().history.present), place));
      } else changeStudio(place);
      if (editing.mode === "create") remembered = rememberOptions(remembered, draft);
      // As Onshape: nothing stays selected after Accept (the new part isn't left lit up in the selection colour).
      // (A sketch stays highlighted in the list, so Extrude goes on to use it.)
      const keepSketch = draft.type === "sketch";
      set({ editing: null, sketch: null, selectedFeatureId: keepSketch ? draft.id : null, featureSelection: NO_DIMS, selection: [], selectedParts: [], draftSteps: null, transformLive: null, ...(at && editing.mode === "create" ? { rollbackTo: draft.id } : {}) });
      return true;
    },

    cancelDraft: () => {
      dropHoleSketch();
      set({ editing: null, sketch: null, draftSteps: null, transformLive: null });
    },

    placeHoleAt: (plane, point) => {
      const s = get();
      const d = s.editing?.draft;
      if (!d || d.type !== "hole" || !d.hole || s.editing?.mode !== "create" || readOnly()) return;
      const frame = planeFrame(plane);
      const mine = holeSketch?.draftId === d.id ? holeSketch : null;
      if (mine) {
        // One Hole's points are in one sketch, on one face.
        const was = planeFrame(mine.sketch.sketch!.plane!);
        const sameFace = dot(was.n, frame.n) > 0.9999 && Math.abs(dot(was.n, [point[0] - was.origin[0], point[1] - was.origin[1], point[2] - was.origin[2]])) < 1e-3;
        if (!sameFace) {
          get().showToast("A Hole's holes all go on one face. Accept this one, then start another Hole for the other face.", "info");
          return;
        }
      }
      const at = toSketch(mine ? planeFrame(mine.sketch.sketch!.plane!) : frame, point);
      const studio = mine?.studio ?? activeStudioId(s) ?? firstStudioId(s.history.present);
      const base = mine?.sketch ?? { ...createFeature(view(), "sketch"), sketch: { plane, data: emptySketch() } };
      const data = addPoint(base.sketch!.data, { x: at[0], y: at[1] }).sketch;
      const sketch: Feature = { ...base, sketch: { ...base.sketch!, data } };
      const h = s.history;
      const clean = mine ? mine.clean && h.present === mine.placed : true;
      const before = mine?.before ?? h;
      // (Rolled back: it goes in at the rollback point, as the hole will.)
      const from = clean ? before.present : h.present;
      const placed = inStudio(from, studio, (doc) =>
        doc.features.some((f) => f.id === sketch.id) ? replaceFeature(doc, sketch) : s.rollbackTo ? insertFeatureAfter(doc, sketch, s.rollbackTo) : addFeature(doc, sketch),
      );
      holeSketch = { draftId: d.id, sketch, before, placed, clean, studio };
      set({ history: { ...(clean ? before : h), present: placed }, editing: { ...s.editing!, draft: { ...d, hole: { ...d.hole, sketchRef: sketch.id } } } });
    },

    setRollback: (id) => {
      if (get().editing) return;
      const last = view().features[view().features.length - 1];
      set({ rollbackTo: id && id !== last?.id ? id : null });
    },

    suppressThenFinish: (ids, commit) => {
      const { editing } = get();
      const off = (doc: JuraCADDocument) => ids.reduce((d, id) => setSuppressed(d, id, true), doc);
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

    moveFeature: (id, beforeId) => {
      const r = moveFeatureIn(view().features, id, beforeId);
      if (typeof r === "string") {
        get().showToast(r, "info");
        return;
      }
      changeStudio((doc) => ({ ...doc, features: r }));
    },

    deleteFeature: (id) => {
      changeStudio((doc) => removeFeature(doc, id));
      set((s) => ({
        selectedFeatureId: s.selectedFeatureId === id ? null : s.selectedFeatureId,
        editing: s.editing?.draft.id === id ? null : s.editing,
        sketch: s.editing?.draft.id === id ? null : s.sketch,
      }));
    },

    deleteAsk: null,
    askDelete: (deleteAsk) => set({ deleteAsk }),
    selectFilter: NO_FILTER,
    setSelectFilter: (selectFilter) => set({ selectFilter }),
    saveNamedView: (camera, name) => {
      const owner = viewOwner(get());
      change((doc) => saveNamedViewIn(doc, owner, name ?? "", camera, newId("nv")));
    },
    renameNamedView: (id, name) => change((doc) => renameNamedViewIn(doc, id, name)),
    deleteNamedView: (id) => change((doc) => removeNamedView(doc, id)),
    pasteAsk: null,
    askPaste: (pasteAsk) => set({ pasteAsk }),
    pasteFeatures: (clip, addVariables) => {
      const s = get();
      if (s.editing || s.sketch || s.versionView || activeAssembly(s) || activeDrawing(s)) return null;
      const doc = s.history.present;
      const features = activeFeatures(s);
      const allIds = studiosOf(doc).flatMap((st) => st.features.map((f) => f.id));
      const r = pasteClip(features, clip, { after: s.rollbackTo, allIds, makeId: newId, variables: doc.variables ?? [], addVariables });
      const vars = r.addVariables.length ? [...(doc.variables ?? []), ...r.addVariables] : null;
      changeStudio((d) => ({ ...d, ...(vars ? { variables: vars } : {}), features: r.features }));
      const last = r.pasted.at(-1)?.id ?? null;
      set({ pasteAsk: null, selectedFeatureId: last, selection: [], ...(s.rollbackTo && last ? { rollbackTo: last } : {}) });
      return r;
    },
    deleteFeatures: (ids, justThese = false) => {
      const features = activeFeatures(get());
      const plan = findDependents(features, ids, new Set((get().history.present.variables ?? []).map((v) => v.name)));
      const going = new Set(justThese ? plan.picked : plan.going);
      set({ deleteAsk: null });
      if (!going.size) return 0;
      // A rollback bar on a feature that goes moves up to the nearest earlier one that stays (the end if that's the last).
      const bar = get().rollbackTo;
      let rollbackTo = bar;
      if (bar && going.has(bar)) {
        const left = features.filter((f) => !going.has(f.id));
        const at = features.findIndex((f) => f.id === bar);
        const keep = features.slice(0, at).reverse().find((f) => !going.has(f.id));
        rollbackTo = keep && keep.id !== left.at(-1)?.id ? keep.id : null;
      }
      changeStudio((doc) => deleteFeaturesIn(doc, going, !justThese));
      set((s) => {
        const open = s.editing && going.has(s.editing.draft.id);
        return {
          selectedFeatureId: s.selectedFeatureId && going.has(s.selectedFeatureId) ? null : s.selectedFeatureId,
          rollbackTo,
          editing: open ? null : s.editing,
          sketch: open ? null : s.sketch,
        };
      });
      return going.size;
    },

    toggleSuppressed: (id) => {
      const f = activeFeatures(get()).find((x) => x.id === id);
      if (f) changeStudio((doc) => setSuppressed(doc, id, !f.suppressed));
    },

    setFeaturesSuppressed: (ids, suppressed) => {
      const list = activeFeatures(get());
      const todo = ids.filter((id) => list.some((f) => f.id === id && f.suppressed !== suppressed));
      if (todo.length) changeStudio((doc) => todo.reduce((d, id) => setSuppressed(d, id, suppressed), doc));
    },
    renameFeature: (id, name) => changeStudio((doc) => renameFeature(doc, id, name)),
    setFeatureFolder: (ids, folder) => changeStudio((doc) => setFolder(doc, ids, folder)),
    setFeaturesVisible: (ids, visible) => {
      changeStudio((doc) => setFeaturesVisible(doc, ids, visible), true);
      // A hidden plane can't stay picked.
      if (!visible && get().selectedFeatureId && ids.includes(get().selectedFeatureId!) && activeFeatures(get()).find((f) => f.id === get().selectedFeatureId)?.type === "plane") set({ selectedFeatureId: null });
    },
    setAllSketchesVisible: (visible) => changeStudio((doc) => setAllSketchesVisible(doc, visible), true),
    setAllPlanesVisible: (visible) => {
      const studio = activeStudioId(get()) ?? firstStudioId(get().history.present);
      change((doc) => setAllPlanesVisible(doc, studio, visible), true);
      // A hidden plane can't stay selected (Top/Front/Right, or a Plane feature, as with its eye).
      if (!visible && get().selectedPlane) set({ selectedPlane: null });
      const picked = get().selectedFeatureId;
      if (!visible && picked && activeFeatures(get()).find((f) => f.id === picked)?.type === "plane") set({ selectedFeatureId: null });
    },
    toggleAllPlanes: () => {
      const studio = activeStudioId(get()) ?? firstStudioId(get().history.present);
      const { visible } = toggleAllPlanes(get().history.present, studio);
      get().setAllPlanesVisible(visible);
      return visible;
    },
    renameFeatureFolder: (from, to) => changeStudio((doc) => renameFolder(doc, from, to)),

    setPartProperties: (partId, props) => change((doc) => setPartPropertiesIn(doc, partId, props)),
    setPartMaterial: (partId, material) =>
      change((doc) => {
        const materials = { ...(doc.materials ?? {}) };
        if (material && material !== DEFAULT_MATERIAL) materials[partId] = material;
        else delete materials[partId];
        const { materials: _old, ...rest } = doc;
        return Object.keys(materials).length ? { ...rest, materials } : rest;
      }),

    setPartColour: (partId, colour, spool) => change((doc) => setPartSpoolIn(setColourIn(doc, partId, colour), partId, colour ? (spool ?? null) : null)),
    setFaceColours: (partId, faces, colour, spool) => {
      const part = get().parts.find((p) => p.id === partId);
      if (!part) return;
      change((doc) => setFaceColoursIn(doc, partId, faces, colour, part, spool));
    },
    clearFaceColours: (partId) => change((doc) => clearFaceColoursIn(doc, partId)),

    setPartFinish: (partId, finish) => change((doc) => chooseFinish(doc, [partId], finish)),
    setPartsFinish: (partIds, finish) => change((doc) => chooseFinish(doc, partIds, finish)),

    setVariables: (variables) => change((doc) => applyVariables(doc, variables)),
    openLibrary: (library) => set({ library }),
    insertLibraryDesign: (designId, values, into) => {
      const s = get();
      const design = findDesign(designId);
      if (!design) return "That design isn't in the library.";
      if (s.editing) return "Finish or cancel the open feature first.";
      if (s.versionView) return "You're looking at an old version, which can't be changed.";
      const studio = into === "new" ? "new" : activeStudioId(s) ?? firstStudioId(s.history.present);
      let made: ReturnType<typeof insertDesign>;
      try {
        made = insertDesign(s.history.present, design, values, { into: studio });
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      change(() => made.doc);
      if (into === "new") {
        set({ activeTab: made.studioId, asmSelection: [], selection: [], selectedPlane: null, selectedFeatureId: null, section: null, mateDraft: null, editingPattern: null });
      }
      get().showToast(`Inserted ${made.insert.name}. Change its sizes in Variables (${made.insert.prefix}_…), or right-click its folder › Edit design sizes.`, "success");
      return null;
    },
    addLinkedSketch: (name, dxf) => {
      const s = get();
      if (s.versionView) return { ok: false, message: "JuraCAD is showing an old version of the design: go back to the current design there, then send again." };
      if (s.editing || s.sketch) return { ok: false, message: "JuraCAD has a feature or sketch open: finish it there, then send again." };
      const studio = activeStudioId(s);
      let made: LinkedSketch;
      try {
        made = sketchFromDxf(s.history.present, studio ?? "new", name, dxf);
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
      change(() => made.doc);
      set({ activeTab: studio ? s.activeTab : made.studioId, selection: [], selectedParts: [], selectedPlane: null, selectedFeatureId: made.featureId, asmSelection: [], section: null, mateDraft: null, editingPattern: null });
      get().showToast(`From JuraCUT: ${made.summary} It's a new sketch on the Top plane — pick it and Extrude to make a part.`, "success");
      return { ok: true, message: "It's a new sketch in JuraCAD, ready to extrude." };
    },
    editLibraryDesign: (insertId, values) => {
      const s = get();
      if (s.editing) return "Finish or cancel the open feature first.";
      if (s.versionView) return "You're looking at an old version, which can't be changed.";
      let made: ReturnType<typeof editInsert>;
      try {
        made = editInsert(s.history.present, insertId, values);
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      change(() => made.doc);
      if (made.remade.length) get().showToast(`${made.remade.join(", ")} ${made.remade.length === 1 ? "was" : "were"} deleted before, and made again with the new sizes. Undo to take that back.`, "info");
      return null;
    },
    addConfiguration: (name) => change((doc) => addConfiguration(doc, name)),
    switchConfiguration: (id) => change((doc) => switchConfiguration(doc, id)),
    renameConfiguration: (id, name) => change((doc) => renameConfiguration(doc, id, name)),
    removeConfiguration: (id) => change((doc) => removeConfiguration(doc, id)),

    renamePart: (partId, name) => {
      const old = get().parts.find((p) => p.id === partId)?.name ?? "";
      if (name.trim() === old) return;
      change((doc) => renamePart(doc, partId, old, name));
    },

    renameDocument: (name) => {
      const trimmed = name.trim();
      if (trimmed && trimmed !== get().history.present.name) change((doc) => ({ ...doc, name: trimmed }));
    },

    newDocument: (start) => {
      set(unview);
      set((s) => ({
        versionCompare: null,
        history: commit(s.history, start ?? emptyDocument()),
        editing: null,
        sketch: null,
        selectedFeatureId: null,
        selection: [],
        hiddenParts: [],
        transparentParts: [],
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
      set(unview);
      set((s) => ({
        versionCompare: null,
        history: commit(s.history, doc),
        editing: null,
        sketch: null,
        selectedFeatureId: null,
        selection: [],
        selectedPlane: null,
        hiddenParts: [],
        transparentParts: [],
        selectedParts: [],
        activeTab: null,
        asmSelection: [],
        mateDraft: null,
        fileName,
      }));
      set((s) => ({ savedDoc: s.history.present }));
      rememberFile(get().history.present, fileName);
    },

    applyClaudeChange: (incoming, studio, label, replace) => {
      const viewing = get().versionView;
      if (viewing) return `The user is looking at an old version ("${viewing.name}") of the design; changes can be made once they go back to the current design.`;
      // Claude isn't sent the versions (see liveLink.ts), so a change to this design keeps its own.
      // A new or opened design (replace) is another design: it doesn't get this one's versions.
      const doc = replace ? designOf(incoming) : withVersionsOf(designOf(incoming), get().history.present);
      set((s) => {
        const history = commit(s.history, refreshDocumentPlanes(doc, resolveVariables(doc.variables).values));
        if (replace) {
          return { history, versionCompare: null, selectedFeatureId: null, selection: [], selectedPlane: null, hiddenParts: [], transparentParts: [], selectedParts: [], activeTab: null, asmSelection: [] };
        }
        sameDesign(history.present, s.history.present);
        // The user stays on their tab (Claude works on the Part Studio on show, so that's normally the one changed).
        const keep = (id: string | null) => (id && studioFeatures(history.present, studio).some((f) => f.id === id) ? id : null);
        return { history, selectedFeatureId: keep(s.selectedFeatureId), selection: [] };
      });
      get().showToast(label, "info");
      return null;
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
      set({ activeTab, rollbackTo: null, animatingMate: null, asmSelection: [], selection: [], selectedParts: [], selectedPlane: null, selectedFeatureId: null, section: null, mateDraft: null, editingPattern: null, drawingTool: "select", selectedDim: null, selectedDims: NO_DIMS });
    },

    removeAssembly: (id) => {
      const s = get();
      const all = s.history.present.assemblies ?? [];
      const name = all.find((a) => a.id === id)?.name ?? "The assembly";
      const users = whereUsed(all, id).filter((a) => a.id !== id);
      change((doc) => removeViewsOf(removeAssembly(doc, id), id));
      if (users.length) s.showToast(`${name} was also taken out of ${users.map((a) => a.name).join(", ")}. Undo brings it all back.`, "info");
      if (get().activeTab === id) set({ activeTab: null, asmSelection: [] });
    },

    renameAssembly: (id, name) => change((doc) => renameAssembly(doc, id, name)),

    addPartStudio: () => {
      if (get().editing) return;
      const id = newId("s");
      change((doc) => addStudio(doc, id));
      set({ activeTab: id, asmSelection: [], selection: [], selectedPlane: null, selectedFeatureId: null, section: null, mateDraft: null, editingPattern: null });
    },

    renamePartStudio: (id, name) => change((doc) => renameStudio(doc, id, name)),

    addDrawing: () => {
      const s = get();
      if (s.editing) return;
      // Draw the part that's selected, else the main (biggest) part of the Part Studio on show, else any part.
      const shown = studioParts(s);
      const partId = s.selection[0]?.partId ?? s.selectedParts[0] ?? mainPart(shown) ?? s.parts[s.parts.length - 1]?.id;
      const asm = activeAssembly(s);
      const source = asm ? { kind: "assembly" as const, id: asm.id } : partId ? { kind: "part" as const, id: partId } : null;
      const id = newId("d");
      // (A new drawing starts from the template chosen for new drawings, if any.)
      const template = defaultTemplate();
      change((doc) => {
        const added = addDrawingTo(doc, id, source);
        return template ? updateDrawing(added, id, (d) => applyTemplate(d, template)) : added;
      });
      set({ activeTab: id, asmSelection: [], selection: [], selectedPlane: null, selectedFeatureId: null, section: null, mateDraft: null, editingPattern: null, dialog: null });
    },

    changeDrawing: (fn) => {
      const d = activeDrawing(get());
      // (With inspection balloons on, new dimensions get the next numbers — numberInspections.)
      if (d) change((doc) => updateDrawing(doc, d.id, (x) => numberInspections(fn(x))));
    },

    renameDrawing: (id, name) => change((doc) => renameDrawingIn(doc, id, name)),

    removeDrawing: (id) => {
      change((doc) => removeDrawingFrom(doc, id));
      if (get().activeTab === id) set({ activeTab: null });
    },

    removePartStudio: (id) => {
      const s = get();
      if (s.editing) return;
      const before = s.history.present;
      const shown = activeStudioId(s);
      const used = studioInUse(studioUsers(before, id));
      change((doc) => {
        const next = deleteStudio(doc, id);
        return next === doc ? doc : removeViewsOf(next, id);
      });
      if (get().history.present === before) return;
      // The studio on show stays on show (by its id: the first tab may now be another studio).
      if (shown === id) set({ activeTab: null, selection: [], selectedParts: [], selectedFeatureId: null, selectedPlane: null, section: null, rollbackTo: null });
      else if (shown && get().activeTab === null) set({ activeTab: shown });
      if (used) s.showToast(`${studioName(before, id)} was deleted, with the copies of its parts. Undo brings it all back.`, "info");
    },

    movePartStudio: (id, to) => {
      const s = get();
      if (s.editing) return;
      const shown = activeStudioId(s);
      change((doc) => moveStudio(doc, id, to));
      // Keep the same Part Studio on show (a null tab means "the first one", which may have changed).
      if (shown && get().activeTab === null) set({ activeTab: shown });
    },

    insertInstance: (part, placement) => {
      const tab = get().activeTab;
      if (!tab) return;
      const before = new Set(activeAssembly(get())?.instances.map((i) => i.id) ?? []);
      change((doc) => insertInstance(doc, tab, part, placement));
      const added = activeAssembly(get())?.instances.find((i) => !before.has(i.id));
      if (added) set({ asmSelection: [added.id] });
    },

    insertSubAssembly: (assemblyId, placement) => {
      const s = get();
      const tab = s.activeTab;
      if (!tab) return;
      const problem = insertProblem(s.history.present, tab, assemblyId);
      if (problem) return s.showToast(problem, "error");
      const before = new Set(activeAssembly(s)?.instances.map((i) => i.id) ?? []);
      change((doc) => insertSubAssembly(doc, tab, assemblyId, placement));
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
          // Only Width mates use a second face on each part.
          if (patch.type !== "width") {
            const one = (c?: MateConnector) => (c?.pick2 ? { instanceId: c.instanceId, ...(c.path ? { path: c.path } : {}), pick: c.pick } : c);
            mate.a = one(mate.a);
            mate.b = one(mate.b);
          }
        }
        return { mateDraft: { ...s.mateDraft, mate } };
      }),

    pickMateConnector: (c) => {
      const s = get();
      if (!s.mateDraft) return;
      // Two parts inside the same sub-assembly copy: it moves as one piece, so keep the first pick and say why.
      if (samePieceClick(s.mateDraft.mate, c)) {
        const top = activeAssembly(s)?.instances.find((i) => i.id === c.instanceId);
        const sub = s.history.present.assemblies?.find((a) => a.id === top?.subAssembly);
        s.showToast(`Both faces are in ${top?.name ?? "the same sub-assembly"}, which moves as one piece. Open ${sub?.name ?? "it"} (double-click it) to mate its parts to each other.`, "info");
        return;
      }
      set((st) => {
        if (!st.mateDraft) return {};
        const m = st.mateDraft.mate;
        const ends = pickConnector(m, c);
        // (Two corners: pointed the same way, so the parts keep their way up.)
        const next: MateDraft = { ...m, ...ends, flip: st.mateDraft.mode === "create" ? cornerFlip(m, ends, m.flip) : m.flip };
        return { mateDraft: { ...st.mateDraft, mate: next } };
      });
    },

    commitMateDraft: () => {
      const s = get();
      const asm = activeAssembly(s);
      const d = s.mateDraft;
      if (!asm || !d || !d.mate.a || !d.mate.b) return false;
      const mate: Mate = { ...d.mate, a: d.mate.a, b: d.mate.b, name: d.mate.name.trim() || MATE_TYPES[d.mate.type].label };
      change((doc) => {
        const withMate = putMate(doc, asm.id, mate);
        const solvedAsm = withMate.assemblies?.find((a) => a.id === asm.id);
        return solvedAsm ? settleSolved(withMate, asm.id, solveWithParts(solvedAsm, s.parts, { hold: [mate.id], assemblies: s.history.present.assemblies })) : withMate;
      });
      set({ mateDraft: null });
      return true;
    },

    cancelMateDraft: () => set({ mateDraft: null }),

    setDragPreview: (dragPreview) => set({ dragPreview }),
    setDrawingTool: (drawingTool) => set({ drawingTool, selectedDim: null, selectedDims: NO_DIMS }),
    selectDim: (selectedDim) => set({ selectedDim, selectedDims: selectedDim ? [selectedDim] : NO_DIMS }),
    selectDims: (ids) => set({ selectedDim: ids.length === 1 ? ids[0] : null, selectedDims: ids.length ? ids : NO_DIMS }),

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
      const solved = solveWithParts(moved, s.parts, { hold: [mate.id], assemblies: s.history.present.assemblies });
      change((doc) => settleSolved(putMate(doc, asm.id, { ...mate, values: d.values }), asm.id, solved));
    },

    deleteMate: (id) => {
      const s = get();
      const asm = activeAssembly(s);
      if (!asm) return;
      // Parts stay where the mates had put them.
      change((doc) => removeMate(settleSolved(doc, asm.id, solveWithParts(asm, s.parts, { assemblies: s.history.present.assemblies })), asm.id, id));
      if (s.mateDraft?.mate.id === id) set({ mateDraft: null });
    },

    theme: "light",
    setTheme: (theme) => set({ theme }),
    niceLighting: readNiceLighting(),
    setNiceLighting: (on) => {
      try {
        globalThis.localStorage?.setItem(NICE_LIGHTING_KEY, on ? "1" : "0");
      } catch {
        // Private windows may refuse: it just isn't remembered.
      }
      set({ niceLighting: on });
    },
    setUnits: (unit) =>
      change((doc) => {
        const { units: _old, ...rest } = doc;
        return unit === "in" ? { ...rest, units: "in" } : rest;
      }),
    savePosition: (name) => {
      const asm = activeAssembly(get());
      // Saved as shown: with the amounts loops of mates have moved to.
      if (asm) change((doc) => savePosition(settleSolved(doc, asm.id, solveWithParts(asm, get().parts, { assemblies: get().history.present.assemblies })), asm.id, newId("np"), name));
    },
    applyPosition: (id) => {
      const asm = activeAssembly(get());
      if (asm) change((doc) => applyPosition(doc, asm.id, id));
    },
    removePosition: (id) => {
      const asm = activeAssembly(get());
      if (asm) change((doc) => removePosition(doc, asm.id, id));
    },
    putRelation: (relation) => {
      const asm = activeAssembly(get());
      if (asm) change((doc) => putRelation(doc, asm.id, relation));
    },
    removeRelation: (id) => {
      const asm = activeAssembly(get());
      if (asm) change((doc) => removeRelation(doc, asm.id, id));
    },
    setExplode: (amount) => {
      const asm = activeAssembly(get());
      if (asm) change((doc) => setExplode(doc, asm.id, amount));
      // Parts inside sub-assemblies can only be selected on their own in the exploded view.
      set((st) => ({ explodePreview: null, ...(amount === null && st.asmSelection.some((k) => k.includes(PATH_SEP)) ? { asmSelection: st.asmSelection.filter((k) => !k.includes(PATH_SEP)) } : {}) }));
    },
    explodePreview: null,
    setExplodePreview: (amount) => set({ explodePreview: amount }),
    editingPattern: null,
    setEditingPattern: (editingPattern) => set({ editingPattern, mirrorFacePick: false, ...(editingPattern ? { asmSelection: [], mateDraft: null, dialog: null } : {}) }),
    mirrorFacePick: false,
    setMirrorFacePick: (mirrorFacePick) => set({ mirrorFacePick }),
    pickMirrorFace: (c) => {
      const s = get();
      const asm = activeAssembly(s);
      const p = asm?.patterns?.find((x) => x.id === s.editingPattern);
      if (!asm || !p) return;
      // Placing a mate connector: any face or edge will do (it then sits at its centre, moved and tilted as typed).
      const connector = s.mirrorFacePick === "connector";
      if (!connector && (c.pick.ref.kind !== "face" || c.pick.ref.surface !== "PLANE")) return s.showToast("Click a flat face to mirror across.", "info");
      if (asm.instances.find((i) => i.id === c.instanceId)?.copyOf?.pattern === p.id) return s.showToast("That's one of this mirror's own copies — click a face on another part.", "info");
      // Only the face matters (not where on it it was clicked).
      if (!connector && c.vertex) return s.showToast("Click a flat face to mirror across.", "info");
      const plane: MateConnector = { instanceId: c.instanceId, ...(c.path ? { path: c.path } : {}), pick: c.pick, ...(c.vertex ? { vertex: c.vertex } : {}) };
      set({ mirrorFacePick: false });
      s.updatePattern(p.id, connector ? { plane, placed: p.placed ?? {} } : { plane, placed: undefined });
    },
    createPattern: (kind) => {
      const s = get();
      const asm = activeAssembly(s);
      if (!asm) return;
      const seeds = asm.instances.filter((i) => s.asmSelection.includes(i.id) && !i.copyOf);
      if (!seeds.length) return;
      // Spaced a little more than the first part (or sub-assembly) is wide, so the copies don't overlap.
      const box = ownBox(asm, seeds[0], s.parts, s.history.present.assemblies ?? [], (p) => boundsOfVertices(p.vertices));
      const width = box ? box.max[0] - box.min[0] : 10;
      const pattern: AssemblyPattern =
        kind === "mirror"
          ? // Across the Right plane, moved out past the parts so the copies don't land on them.
            { id: newId("pt"), name: nextPatternName(asm, "Mirror"), kind: "mirror", seeds: seeds.map((i) => i.id), count: 2, amount: "0", axis: "x", centre: [Math.ceil((box ? box.max[0] : 0) + Math.max(...seeds.map((i) => i.placement.position[0])) + 5), 0, 0] }
          : {
              id: newId("pt"),
              name: nextPatternName(asm),
              kind: "linear",
              seeds: seeds.map((i) => i.id),
              count: 3,
              amount: String(Math.ceil(width + 5)),
              axis: "x",
            };
      change((doc) => updateAssembly(doc, asm.id, (a) => syncPattern(a, pattern, () => newId("i"), symmetricIn(s.parts, doc.assemblies))));
      set({ editingPattern: pattern.id, asmSelection: [], mirrorFacePick: false });
    },
    updatePattern: (id, patch) => {
      const asm = activeAssembly(get());
      const p = asm?.patterns?.find((x) => x.id === id);
      if (!asm || !p) return;
      const next: AssemblyPattern = { ...p, ...patch, name: (patch.name ?? p.name).trim() || p.name };
      // (A setting patched to undefined is taken away: back to an assembly plane, or mirror images again.)
      for (const k of Object.keys(next) as (keyof AssemblyPattern)[]) if (next[k] === undefined) delete next[k];
      const parts = get().parts;
      change((doc) => {
        const synced = updateAssembly(doc, asm.id, (a) => syncPattern(a, next, () => newId("i"), symmetricIn(parts, doc.assemblies)));
        // Across a face: the copies' places come from where the face is, so put them there now.
        if (!next.plane && !p.plane) return synced;
        const solvedAsm = synced.assemblies?.find((a) => a.id === asm.id);
        return solvedAsm ? settlePlacements(synced, asm.id, solveWithParts(solvedAsm, parts, { assemblies: synced.assemblies }).placements) : synced;
      });
    },
    createReplicate: () => {
      const s = get();
      const asm = activeAssembly(s);
      if (!asm || s.asmSelection.length !== 1) return s.showToast("Select one part — one that's mated into a hole.", "info");
      const source = replicateSource(asm, s.asmSelection[0]);
      if (typeof source === "string") return s.showToast(source, "info");
      const rep: Replicate = { id: newId("rp"), name: nextReplicateName(asm), seed: s.asmSelection[0], mate: source.mate.id };
      const holes = replicateHoles(asm, rep, s.parts, s.history.present.assemblies);
      if (!holes.length) return s.showToast("No other holes like that one were found on the part it's mated to.", "info");
      change((doc) => {
        const next = updateAssembly(doc, asm.id, (a) => syncReplicate(a, rep, holes, () => newId("i")));
        const solved = next.assemblies?.find((a) => a.id === asm.id);
        return solved ? settlePlacements(next, asm.id, solveWithParts(solved, s.parts, { assemblies: s.history.present.assemblies }).placements) : next;
      });
      set({ asmSelection: [] });
      s.showToast(`Copied into ${holes.length} more hole${holes.length === 1 ? "" : "s"}.`, "success");
    },
    refreshReplicate: (id) => {
      const s = get();
      const asm = activeAssembly(s);
      const rep = asm?.replicates?.find((r) => r.id === id);
      if (!asm || !rep) return;
      const holes = replicateHoles(asm, rep, s.parts, s.history.present.assemblies);
      change((doc) => {
        const next = updateAssembly(doc, asm.id, (a) => syncReplicate(a, rep, holes, () => newId("i")));
        const solved = next.assemblies?.find((a) => a.id === asm.id);
        return solved ? settlePlacements(next, asm.id, solveWithParts(solved, s.parts, { assemblies: s.history.present.assemblies }).placements) : next;
      });
      s.showToast(`${rep.name}: ${holes.length} cop${holes.length === 1 ? "y" : "ies"}.`, "success");
    },
    deleteReplicate: (id) => {
      const asm = activeAssembly(get());
      if (asm) change((doc) => updateAssembly(doc, asm.id, (a) => removeReplicate(a, id)));
    },
    duplicateInstances: () => {
      const s = get();
      const asm = activeAssembly(s);
      if (!asm) return;
      const ids = asm.instances.filter((i) => s.asmSelection.includes(i.id)).map((i) => i.id);
      if (!ids.length) return;
      const { placements } = solveWithParts(asm, s.parts, { assemblies: s.history.present.assemblies });
      // Beside everything already there (in +X), keeping the copies' places relative to each other.
      const boxOf = (i: Instance) => {
        // (A mirrored part is flipped across its own YZ plane before it's placed; a sub-assembly's box holds all its parts.)
        const b = ownBox(asm, i, s.parts, s.history.present.assemblies ?? [], (p) => boundsOfVertices(p.vertices));
        return b ? placedBox(b, placements[i.id] ?? i.placement) : null;
      };
      const all = asm.instances.map(boxOf).filter((b): b is Box3 => !!b);
      const mine = asm.instances.filter((i) => ids.includes(i.id)).map(boxOf).filter((b): b is Box3 => !!b);
      const shift: [number, number, number] = all.length && mine.length ? [Math.max(...all.map((b) => b.max[0])) + 10 - Math.min(...mine.map((b) => b.min[0])), 0, 0] : [20, 0, 0];
      const made = duplicateInstances(asm, ids, placements, shift, newId);
      change((doc) => updateAssembly(doc, asm.id, () => made.assembly));
      set({ asmSelection: made.ids });
    },
    replaceInstancePart: (instanceId, partId) => {
      const s = get();
      const asm = activeAssembly(s);
      const part = s.parts.find((p) => p.id === partId);
      const old = asm?.instances.find((i) => i.id === instanceId);
      if (!asm || !part || !old) return;
      const oldName = s.parts.find((p) => p.id === old.partId)?.name;
      change((doc) => {
        const next = updateAssembly(doc, asm.id, (a) => replaceInstancePart(a, instanceId, { id: part.id, name: part.name }, oldName));
        const solved = next.assemblies?.find((a) => a.id === asm.id);
        return solved ? settlePlacements(next, asm.id, solveWithParts(solved, s.parts, { assemblies: s.history.present.assemblies }).placements) : next;
      });
    },
    addExplodeStep: () => {
      const s = get();
      const asm = activeAssembly(s);
      if (!asm) return;
      const ids = asm.instances.filter((i) => s.asmSelection.includes(i.id)).map((i) => i.id);
      // Parts inside sub-assemblies ("top/inner/part", picked in the exploded view) move on their own.
      const inner = s.asmSelection
        .filter((k) => k.includes(PATH_SEP) && instanceAt(asm, s.history.present.assemblies ?? [], k))
        .map((k) => {
          const [instanceId, ...path] = k.split(PATH_SEP);
          return { instanceId, path };
        });
      if (!ids.length && !inner.length) return s.showToast("Select the parts to move first (click them, or Shift-click for more).", "info");
      change((doc) =>
        updateAssembly(doc, asm.id, (a) => putExplodeStep(a, { id: newId("xs"), instances: ids, ...(inner.length ? { parts: inner } : {}), axis: "z", distance: storeLength(lengthUnit() === "in" ? "1" : "30") })),
      );
      set({ asmSelection: [] });
    },
    updateExplodeStep: (id, patch) => {
      const asm = activeAssembly(get());
      const step = asm?.explodeSteps?.find((x) => x.id === id);
      if (!asm || !step) return;
      const next: ExplodeStep = { ...step, ...patch };
      if (!next.flip) delete next.flip;
      change((doc) => updateAssembly(doc, asm.id, (a) => putExplodeStep(a, next)));
    },
    removeExplodeStep: (id) => {
      const asm = activeAssembly(get());
      if (asm) change((doc) => updateAssembly(doc, asm.id, (a) => removeExplodeStep(a, id)));
    },
    setAssemblyFit: (fit) => {
      const asm = activeAssembly(get());
      if (asm) change((doc) => updateAssembly(doc, asm.id, (a) => putFit(a, fit)));
    },
    removeAssemblyFit: (id) => {
      const asm = activeAssembly(get());
      if (asm) change((doc) => updateAssembly(doc, asm.id, (a) => removeFit(a, id)));
    },
    deletePattern: (id) => {
      const asm = activeAssembly(get());
      if (!asm) return;
      change((doc) => updateAssembly(doc, asm.id, (a) => removePattern(a, id)));
      if (get().editingPattern === id) set({ editingPattern: null });
    },
    createGroup: () => {
      const s = get();
      const asm = activeAssembly(s);
      if (!asm) return;
      const { placements } = solveWithParts(asm, s.parts, { assemblies: s.history.present.assemblies });
      const made = makeGroup(asm, s.asmSelection, placements, newId("g"));
      if (made.error) {
        s.showToast(made.error);
        return;
      }
      change((doc) => updateAssembly(settlePlacements(doc, asm.id, placements), asm.id, (a) => ({ ...a, groups: made.assembly.groups })));
      set({ asmSelection: [] });
    },
    deleteGroup: (id) => {
      const s = get();
      const asm = activeAssembly(s);
      if (!asm) return;
      const { placements } = solveWithParts(asm, s.parts, { assemblies: s.history.present.assemblies });
      change((doc) => updateAssembly(settlePlacements(doc, asm.id, placements), asm.id, (a) => removeGroup(a, id)));
    },
    renameGroup: (id, name) => {
      const asm = activeAssembly(get());
      if (!asm) return;
      change((doc) => updateAssembly(doc, asm.id, (a) => renameGroup(a, id, name)));
    },
    toggleMateSuppressed: (id) => {
      const s = get();
      const asm = activeAssembly(s);
      const mate = asm?.mates?.find((m) => m.id === id);
      if (!asm || !mate) return;
      const solved = solveWithParts(asm, s.parts, { assemblies: s.history.present.assemblies });
      change((doc) => {
        const settled = settleSolved(doc, asm.id, solved);
        const kept = settled.assemblies?.find((a) => a.id === asm.id)?.mates?.find((m) => m.id === id) ?? mate;
        return putMate(settled, asm.id, { ...kept, suppressed: !mate.suppressed });
      });
    },
    setInstancesSuppressed: (ids, suppressed) => {
      const s = get();
      const asm = activeAssembly(s);
      if (!asm || !ids.length) return;
      // Everything stays where the mates put it now, so nothing jumps when a mate stops (or starts) counting.
      const solved = solveWithParts(asm, s.parts, { assemblies: s.history.present.assemblies });
      change((doc) => updateAssembly(settleSolved(doc, asm.id, solved), asm.id, (a) => setInstancesOff(a, ids, suppressed)));
      if (suppressed) set((st) => ({ asmSelection: st.asmSelection.filter((x) => !ids.includes(x)) }));
    },

    setInstanceFlexible: (id, flexible) => {
      const s = get();
      const asm = activeAssembly(s);
      if (!asm) return;
      // Then solved again with its parts free (or held) — and left where that puts everything.
      change((doc) => {
        const next = updateAssembly(doc, asm.id, (a) => setFlexible(a, id, flexible));
        const changed = next.assemblies?.find((a) => a.id === asm.id);
        return changed ? settleSolved(next, asm.id, solveWithParts(changed, s.parts, { assemblies: next.assemblies })) : next;
      });
    },
    toggleInstanceHidden: (id) =>
      set((s) => ({ hiddenInstances: s.hiddenInstances.includes(id) ? s.hiddenInstances.filter((x) => x !== id) : [...s.hiddenInstances, id] })),

    // Undo/redo only when no feature dialog is open (see App shortcuts).
    // Versions aren't undone: they stay as they are (see `step`).
    undo: () => {
      if (!readOnly()) step(undoHistory);
    },
    // (While sketching, Ctrl+Z goes to sketchUndo instead — see App shortcuts.)
    redo: () => {
      if (!readOnly()) step(redoHistory);
    },

    // Picking a feature or picking parts: one at a time (the other side is then shown as "linked").
    selectFeature: (id) => set((s) => ({ selectedFeatureId: id, featureSelection: NO_DIMS, selectedPlane: id ? null : s.selectedPlane, selectedParts: id ? [] : s.selectedParts })),
    selectFeatures: (ids, primary) => {
      const main = primary && ids.includes(primary) ? primary : (ids[ids.length - 1] ?? null);
      set((s) => ({ selectedFeatureId: main, featureSelection: ids.length > 1 ? ids : NO_DIMS, selectedPlane: main ? null : s.selectedPlane, selectedParts: main ? [] : s.selectedParts }));
    },
    setSelection: (items) =>
      set((s) => ({ selection: items, selectedPlane: items.length > 0 ? null : s.selectedPlane, areaSelection: null })),
    // Areas are selected on their own: faces, edges and planes are let go (and the other way round).
    setAreaSelection: (areaSelection) => set((s) => (areaSelection ? { areaSelection, selection: [], selectedPlane: null, selectedFeatureId: null } : s.areaSelection ? { areaSelection: null } : {})),
    mergeParts: (ids) => {
      const s = get();
      if (s.editing) return;
      const names = ids.map((id) => s.parts.find((p) => p.id === id)?.name).filter((n): n is string => !!n);
      if (names.length < 2) {
        s.showToast("Select two or more parts to merge.", "info");
        return;
      }
      const draft = createFeature(view(), "boolean");
      draft.name = `Merge ${names.length} parts`;
      draft.booleanDef = { op: "union", targets: [...ids], tools: [], keepTools: false, picking: "targets" };
      changeStudio((d) => addFeature(d, draft));
      set({ selectedParts: [ids[0]], selectedFeatureId: null });
      s.showToast(`Merged ${names.join(", ")} into one part. Undo to separate them again.`, "success");
    },
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
    setPartsTransparent: (ids, on) =>
      set((s) => ({ transparentParts: on ? [...s.transparentParts.filter((p) => !ids.includes(p)), ...ids] : s.transparentParts.filter((p) => !ids.includes(p)) })),
    setPartsHidden: (ids, hidden) =>
      set((s) => ({ hiddenParts: hidden ? [...s.hiddenParts.filter((p) => !ids.includes(p)), ...ids] : s.hiddenParts.filter((p) => !ids.includes(p)) })),
    setShowFlat: (showFlat) => set({ showFlat, selection: [] }),
    toggleHidden: (partId) =>
      set((s) => ({
        hiddenParts: s.hiddenParts.includes(partId) ? s.hiddenParts.filter((p) => p !== partId) : [...s.hiddenParts, partId],
      })),

    selectPlane: (plane) =>
      set((s) => ({
        selectedPlane: plane,
        selection: plane ? [] : s.selection,
        areaSelection: plane ? null : s.areaSelection,
        selectedFeatureId: plane ? null : s.selectedFeatureId,
      })),
    setListHoverPlane: (listHoverPlane) => set({ listHoverPlane }),
    toggleDatum: (datum) => {
      const studio = activeStudioId(get()) ?? firstStudioId(get().history.present);
      const hidden = hiddenDatumsOf(get().history.present, studio).includes(datum);
      change((doc) => setDatumHidden(doc, studio, datum, !hidden), true);
      // A hidden plane can't stay selected.
      if (!hidden && get().selectedPlane === datum) set({ selectedPlane: null });
    },

    openDialog: (dialog) => set({ dialog }),
    setSection: (section) => set({ section }),
    setPrintBed: (printBed) => set({ printBed }),

    showToast: (text, tone = "info") => set({ toast: { id: ++toastCounter, text, tone } }),

    setKernelStatus: (kernelStatus, error) => set({ kernelStatus, kernelError: error ?? null }),
    setRebuildBusy: (rebuildBusy) => set({ rebuildBusy }),
    setRebuildResult: (built, featureErrors, ms, rebuilt, studioOrder, sketchLinks, featureWarnings, featureNotes, followed, curves) =>
      set((s) => {
        // The sketch open for editing follows its part's face and edges, as the engine found them.
        const links = sketchLinks && Object.keys(sketchLinks).length ? sketchLinks : NO_LINKS;
        const draft = s.editing?.draft;
        const info = draft?.sketch ? links[draft.id] : undefined;
        let editing = s.editing;
        if (editing && draft?.sketch && info) {
          const data = followLinks(draft.sketch.data, info.links, info.pointLinks);
          const plane = info.plane && draft.sketch.plane?.kind === "face" && !samePlace(info.plane, draft.sketch.plane) ? info.plane : draft.sketch.plane;
          if (data !== draft.sketch.data || plane !== draft.sketch.plane) editing = { ...editing, draft: { ...draft, sketch: { plane, data } } };
        }
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
        // Picking parts for the open feature shows only the parts before it for a while: later parts' hidden,
        // see-through and selected flags are kept for when they're back.
        const keep = picksPartsBefore(s.editing?.draft ?? null) || shownRolledBackForEdit(s);
        return {
          parts,
          featureErrors,
          featureWarnings: featureWarnings && Object.keys(featureWarnings).length ? featureWarnings : NO_WARNINGS,
          featureNotes: featureNotes && Object.keys(featureNotes).length ? featureNotes : NO_WARNINGS,
          sketchLinks: links,
          // (Kept the same object while nothing moved, so nothing redraws.)
          builtFrames: !followed || !Object.keys(followed).length ? NO_FRAMES : JSON.stringify(followed) === JSON.stringify(s.builtFrames) ? s.builtFrames : followed,
          builtCurves: !curves || !Object.keys(curves).length ? NO_CURVES : JSON.stringify(curves) === JSON.stringify(s.builtCurves) ? s.builtCurves : curves,
          ...(editing !== s.editing ? { editing } : {}),
          lastRebuildMs: ms,
          rebuildBusy: false,
          // Drop picks and hidden flags for parts that no longer exist.
          selection: s.selection.filter((x) => ids.has(x.partId)),
          hiddenParts: keep ? s.hiddenParts : s.hiddenParts.filter((p) => ids.has(p)),
          transparentParts: keep ? s.transparentParts : s.transparentParts.filter((p) => ids.has(p)),
          selectedParts: keep ? s.selectedParts : s.selectedParts.filter((p) => ids.has(p)),
        };
      }),
  };
});

// Areas selected with nothing open last only while nothing else happens: a change to the design (undo, redo, a new
// or opened file, a change from Claude), another tab, a sketch or feature dialog, or a feature picked in the list.
useStore.subscribe((now, before) => {
  if (now.areaSelection && areaSelectionLapses(before, now)) useStore.setState({ areaSelection: null });
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
  return s.activeTab && studioExists(doc, s.activeTab) ? s.activeTab : firstStudioId(doc);
}

/** Whose named views are shown: the assembly on show, else the Part Studio on show. */
export function viewOwner(s: Pick<AppState, "activeTab" | "history">): string {
  return activeAssembly(s)?.id ?? activeStudioId(s) ?? firstStudioId(s.history.present);
}

/** The Origin and default planes hidden in the Part Studio on show. Same array each time. */
export function activeHiddenDatums(s: Pick<AppState, "activeTab" | "history">): DatumName[] {
  return hiddenDatumsOf(s.history.present, activeStudioId(s) ?? firstStudioId(s.history.present));
}

/**
 * The features picked in the list, in list-pick order (selector-safe): several after Shift / Ctrl + click, else just
 * the highlighted one, else none. Ids no longer in the Part Studio on show (after an undo, or a change from Claude) are
 * left out.
 */
let lastSingle: string[] = [];
let lastPicked: { sel: string[]; features: Feature[]; result: string[] } | null = null;
export function pickedFeatures(s: Pick<AppState, "selectedFeatureId" | "featureSelection" | "activeTab" | "history">): string[] {
  const id = s.selectedFeatureId;
  if (!id) return NO_DIMS;
  if (s.featureSelection.length > 1 && s.featureSelection.includes(id)) {
    const features = activeFeatures(s);
    if (!lastPicked || lastPicked.sel !== s.featureSelection || lastPicked.features !== features) {
      const left = s.featureSelection.filter((x) => features.some((f) => f.id === x));
      lastPicked = { sel: s.featureSelection, features, result: left.length === s.featureSelection.length ? s.featureSelection : left };
    }
    if (lastPicked.result.length > 1 && lastPicked.result.includes(id)) return lastPicked.result;
  }
  if (lastSingle[0] !== id) lastSingle = [id];
  return lastSingle;
}

/** Features of the Part Studio on show (the first one while an assembly is on show). Same array each time. */
export function activeFeatures(s: Pick<AppState, "activeTab" | "history">): Feature[] {
  return studioFeatures(s.history.present, activeStudioId(s) ?? firstStudioId(s.history.present));
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


