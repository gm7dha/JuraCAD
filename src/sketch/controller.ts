/**
 * Sketch tools: turns pointer events (already converted to sketch mm by the
 * viewport) into sketch edits, and keeps the live preview (rubber-band line,
 * snap marker) for the viewport to draw.
 */
import { activeFeatures, useStore, type SketchTool } from "../model/store";
import { planeVisible, sketchVisible, usedSketches } from "../model/visibility";
import type { Feature } from "../model/types";
import { hitTest, inferOrientation, type Hit } from "./hit";
import { dimensionLayout, offsetFor } from "./layout";
import {
  addArc,
  addCircle,
  addDimension,
  addLine,
  addMidpointLine,
  addPoint,
  addRectangle,
  circleThrough,
  curveById,
  dimensionFor,
  dimensionSpecAt,
  dragArcRim,
  dragCircleRim,
  dragCurve,
  dragPoint,
  pointPos,
  ellipsePoints,
  curvePoints,
  splinePath,
  pointsSharingCurve,
  radiusOf,
  setSplineHandle,
  splineHandleEnds,
  type LineRelation,
  type Placed,
  type SplineHandleEnd,
} from "./ops";
import {
  addCentreRectangle,
  addPolygon,
  polygonCorners,
  addAlignedRectangle,
  addCentreArc,
  addEllipse,
  addSlot,
  addThreePointCircle,
  alignedWidth,
  addSpline,
  addConic,
  addTangentArc,
  filletCorner,
  mirrorCurves,
  offsetCurves,
  patternTransform,
  readTransformSettings,
  readPatternSettings,
  tangentArcCentre,
  tangentAt,
  trimAt,
  extendAt,
  splitAt,
} from "./tools";
import { isPartLink, ORIGIN_ID, type SketchCurve, type SketchData } from "./types";
import { placedByOffset } from "./solver";
import { chamferCorner, cornerOfLines } from "./sketchChamfer";
import { filletBetween } from "./filletCurves";
import { slotAlong } from "./slotAlong";
import { trimAlong } from "./trimStroke";
import { addEllipticalArc, ellipticalArcPath, ellipticalArcShape } from "./ellipticalArc";
import { useEditToolOptions } from "./editToolOptions";
import { readSecondDirection } from "./patternGrid";
import { addText, imageAt, imageById, readTextSettings, textAt, textById } from "./sketchText";
import { DEFAULT_PLANE_REFS, isPlaneLink, isPlaneRef } from "./planeRefs";
import { sketchPlaneRefs } from "./planeRefsFor";
import { isRefId, laterMessage, linkEdge, parseRefId, pruneReferences, refSketch, type RefEdge } from "./links";
import { addTangentLine, tangentLineAt, type TangentLine } from "./tangents";
import { attachPoint, bringIn, hintFor, nearRefs, pickAt, sketchCurveAt, snapAt, type SnapResult } from "./snaps";
import type { Snap } from "./ops";
import { splinePolyline } from "./spline";
import { ellipseFrom, ellipsePolyline, minorPointFor } from "./ellipse";
import { rectOf, sketchItemsInBox } from "../viewport/boxSelect";
import { clipAt, dragSelection, draggableCount, pasteSketchClip, selectionPoints, type SketchClip } from "./clipboard";
import {
  gizmoPartAt,
  gizmoShapes,
  motionMap,
  motionWords,
  NO_MOTION,
  readScale,
  selectionCentre,
  snapScale,
  snapTurn,
  transformCopy,
  transformSelection,
  turnBetween,
  type GizmoPart,
  type SelectionMotion,
} from "./transformSelection";

export interface SketchPointer {
  /** Sketch coordinates (mm). */
  x: number;
  y: number;
  /** Millimetres per screen pixel at the current zoom. */
  mmPerPx: number;
  /**
   * How many times further snapping and picking reach (missing = 1, the mouse): a finger covers more
   * than a mouse pointer, the pen a bit more (see reachFor in viewport/gestures.ts).
   */
  reach?: number;
  shift: boolean;
  ctrl: boolean;
  /** Screen position across the view (px), for telling which way a box was dragged. */
  screenX?: number;
}

/** Temporary shapes drawn while a tool is in progress. */
export type PreviewShape =
  | { kind: "line"; a: [number, number]; b: [number, number]; handle?: boolean }
  /** A faint guide showing what the pointer has lined up with. */
  | { kind: "guide"; a: [number, number]; b: [number, number] }
  /** (`handle`: one of Move / copy's handles, drawn in the handles' colour.) */
  | { kind: "circle"; c: [number, number]; r: number; handle?: boolean }
  | { kind: "arc"; c: [number, number]; r: number; a0: number; a1: number };

export interface SketchTransient {
  hover: Hit | null;
  preview: PreviewShape[];
  /** Where the pointer has snapped to (drawn as a small marker). */
  snap: [number, number] | null;
  /** "H" / "V" shown while a line is snapping horizontal or vertical. */
  inference: { at: [number, number]; text: string } | null;
  /** Items picked so far by the dimension tool. */
  pending: string[];
  /** Small markers: the middle of the line, or the centre of the circle or arc, under the pointer. */
  hints?: [number, number][];
  /** Points of other sketches and parts near the pointer that it can snap to (drawn faintly). */
  nearby?: [number, number][];
}

const POINT_PX = 9;
/** How close (px) the pointer must come to where a line would touch a circle for the tangent line to be offered. */
const TANGENT_PX = 14;
/** How near (px) the pointer shows other sketches' and parts' points it can snap to. */
const NEARBY_PX = 60;
/** At most this many of those are shown at once. */
const NEARBY_MAX = 80;
const NO_REFS: RefEdge[] = [];
/** Millimetres per "pixel" of the snapping and picking distances below: wider for fingers and the pen. */
const pickMm = (e: SketchPointer) => e.mmPerPx * (e.reach ?? 1);
/** Tools whose first click only marks where the shape starts: on a touch screen a drag draws them (lift = the next click). */
const DRAG_DRAWN = new Set<string>(["line", "midpointLine", "rectangle", "centreRectangle", "alignedRectangle", "circle", "circle3", "centreArc", "arc", "tangentArc", "slot", "polygon", "ellipse", "conic"]);
const CURVE_PX = 6;
const DRAG_PX = 3;
/**
 * With the mouse, letting go this far (px) from where a drawing tool's first press went down counts as the next
 * click (Onshape's drag to draw). Well past a hand's wobble during an ordinary click, so a click never makes two points.
 */
const RELEASE_PX = 10;
/** How near (degrees) a line being drawn must point to a woken line's direction (or an arc's, where it starts) for it to be inferred. */
const RELATION_DEGREES = 4;
/** At most this many lines are kept "woken up" (hovered while drawing) for parallel / perpendicular inference. */
const WOKEN_MAX = 3;

/** Where a line being drawn ends and what's inferred about it (horizontal / vertical, or a relation to another curve). */
interface LinePlan {
  end: Placed;
  orientation: "horizontal" | "vertical" | null;
  relation: LineRelation | null;
  /** The relation's badge shown by the pointer ("H", "∥", "T"…), or null. */
  badge: string | null;
}
/** How close (px) a dragged point must come to another to snap onto it. */
const SNAP_PX = 14;

/** Dragging one of Move / copy's handles (the middle, the ring or the scale square). */
interface GizmoDrag {
  part: GizmoPart;
  start: SketchData;
  ids: string[];
  centre: [number, number];
  from: [number, number];
  /** The turn so far, added up move by move (so a drag can go past half a turn), before snapping. */
  turned: number;
  lastAt: [number, number];
  motion: SelectionMotion;
  copy: boolean;
  moved: boolean;
  /** The last refusal said (so it's said once, not on every move). */
  said: string | null;
}

interface DragState {
  kind: "point" | "curve" | "rim" | "handle" | "image" | "group" | "none";
  id: string;
  /** Dragging several picked things together ("group"): what moves, and whether it's been said that they can't. */
  ids?: string[];
  heldSaid?: boolean;
  start: SketchData;
  startX: number;
  startY: number;
  moved: boolean;
  additive: boolean;
  hit: Hit | null;
  startScreenX?: number;
  /** Dragging from empty space draws a selection box: its far corner and whether it was dragged leftwards. */
  box?: { x: number; y: number; crossing: boolean };
  /** Dragging a point: what it has snapped onto (a point, a line's middle, a part edge's corner), joined when the drag ends. */
  snapTo?: Snap | null;
  /** Dragging a spline handle: which one. */
  handle?: SplineHandleEnd;
}

export class SketchController {
  private transient: SketchTransient = { hover: null, preview: [], snap: null, inference: null, pending: [] };
  /** Clicks collected so far by the current drawing tool. */
  private placed: Placed[] = [];
  private drag: DragState | null = null;
  /** Points the pointer has passed over while drawing, most recent first (to line up with). */
  private acquired: string[] = [];
  private lastTool: SketchTool | null = null;
  /** Which kind of dimension the placing preview last showed. */
  private previewKind: string | null = null;
  private readonly listeners = new Set<(t: SketchTransient) => void>();
  /** A copy being placed (after Ctrl+V): it follows the pointer until a click puts it down. */
  private pasting: SketchClip | null = null;
  /** Where the pointer last was (sketch mm), so a paste shows at once, and how many mm a pixel was then. */
  private lastPointer: [number, number] | null = null;
  private lastMmPerPx = 0.1;
  private gizmoDrag: GizmoDrag | null = null;
  /** Round / Chamfer between two picked curves: the first one picked and where it was clicked. */
  private firstCurve: { id: string; at: [number, number] } | null = null;
  /** The last round or chamfer made while the tool stayed on, so the next one of the same size is kept Equal to it. */
  private lastEdge: { tool: string; size: string; id: string } | null = null;
  /** Trim: the pointer's path while dragging across curves (trimmed when let go). */
  private trimStroke: { path: [number, number][]; moved: boolean; mm: number } | null = null;
  /** Lines the pointer has passed over while drawing, most recent first ("woken up", as Onshape says): new lines may be parallel or perpendicular to them. */
  private woken: string[] = [];
  /** Line tool: the next click makes an arc carrying on smoothly from the last end (Shift+A, or back to the end and away again). */
  private arcMode = false;
  /** The pointer coming back to a line chain's last end and leaving again switches to (or from) an arc: where it is in that. */
  private returning: "fresh" | "away" | "back" = "fresh";
  /** With the mouse: where the press that started a shape went down (letting go far from it is the next click). */
  private press: SketchPointer | null = null;
  /** The last pointer move (for a release, and for redrawing after Shift+A). */
  private lastEvent: SketchPointer | null = null;

  /** What's drawn and said right now (the view's labels read the inferred relation's badge each frame). */
  get current(): SketchTransient {
    return this.transient;
  }

  /**
   * Start placing a copy (Ctrl/⌘ + V, or Duplicate): it follows the pointer, a click puts it down, Esc stops.
   * Switches to the Select tool.
   */
  startPaste(clip: SketchClip): void {
    if (this.state.sketch?.tool !== "select") this.state.setSketchTool("select");
    void this.tool; // (catch up with the tool change, which would otherwise drop the paste)
    this.pasting = clip;
    this.drag = null;
    this.state.setSketchMessage("Click where to put the copy (Esc to stop).", "info");
    this.emit({ preview: this.lastPointer ? this.pastePreview(this.lastPointer) : [], hover: null, snap: null, inference: null, hints: [] });
  }

  /** Is a copy following the pointer, waiting to be put down? */
  isPasting(): boolean {
    return this.pasting !== null;
  }

  /** The copy drawn where it would go, its middle at the pointer. */
  private pastePreview(at: [number, number]): PreviewShape[] {
    const clip = this.pasting;
    if (!clip) return [];
    const d = clipAt(clip, at);
    const out = curvesPreview(d, d.curves, (p) => p);
    // Points on their own as small rings, text as a box where its letters go (roughly).
    const used = new Set(d.curves.flatMap(curvePoints));
    const anchors = new Set((d.texts ?? []).map((t) => t.anchor));
    for (const p of d.points) if (!used.has(p.id) && !anchors.has(p.id)) out.push({ kind: "circle", c: [p.x, p.y], r: 4 * this.lastMmPerPx });
    for (const t of d.texts ?? []) {
      const [x, y] = pointPos(d, t.anchor);
      const w = Math.max(t.size, t.value.length * t.size * 0.6);
      const h = t.size;
      const [x0, y0] = t.anchorAt === "centre" ? [x - w / 2, y - h / 2] : [x, y];
      const a: [number, number] = [x0, y0], b: [number, number] = [x0 + w, y0], c: [number, number] = [x0 + w, y0 + h], e: [number, number] = [x0, y0 + h];
      out.push({ kind: "guide", a, b }, { kind: "guide", a: b, b: c }, { kind: "guide", a: c, b: e }, { kind: "guide", a: e, b: a });
    }
    return out;
  }

  /**
   * Where a copy being placed goes: its middle snaps like a drawn point — onto points, middles of lines, the
   * origin, corners of part edges, or lined up with points passed over (Shift: exactly at the pointer).
   */
  private pasteSnap(e: SketchPointer, clip: SketchClip | null = this.pasting): { x: number; y: number; snap: boolean; hints: [number, number][] } {
    const d = this.data;
    if (!d || !clip || e.shift) return { x: e.x, y: e.y, snap: false, hints: [] };
    // Passing over a point picks it up, to line up with.
    const over = this.hitAt(e);
    if (over?.kind === "point" && this.acquired[0] !== over.id) this.acquired = [over.id, ...this.acquired.filter((x) => x !== over.id)].slice(0, 4);
    const found = snapAt(d, e.x, e.y, { pointTol: POINT_PX * pickMm(e), curveTol: 0, acquired: this.acquired, refs: this.refs, skip: this.skipRef, ignore: this.notHidden() });
    const sn = found.placed.snap;
    if (!sn || sn.kind === "curve" || (sn.kind === "ref" && (sn.at === "on" || sn.edge.source?.later))) return { x: e.x, y: e.y, snap: false, hints: [] };
    return { x: found.placed.x, y: found.placed.y, snap: true, hints: found.hints };
  }

  private pasteAt(e: SketchPointer): void {
    const clip = this.pasting;
    const d = this.data;
    this.pasting = null;
    this.emit({ preview: [] });
    if (!clip || !d) return;
    const at = this.pasteSnap(e, clip);
    const r = pasteSketchClip(d, clip, [at.x, at.y]);
    if (!this.commit(r, r.ids)) return;
    const names = r.unknownNames ?? [];
    this.state.setSketchMessage(
      names.length
        ? `Pasted — this design has no variable${names.length > 1 ? "s" : ""} ${names.join(", ")}, so those sizes were pasted as plain numbers. The copy is selected.`
        : "Pasted — the copy is selected. Drag it to move it, or Ctrl+V again for another.",
      "info",
    );
  }

  onChange(fn: (t: SketchTransient) => void): () => void {
    this.listeners.add(fn);
    fn(this.transient);
    return () => this.listeners.delete(fn);
  }

  private emit(patch: Partial<SketchTransient>) {
    this.transient = { ...this.transient, ...patch };
    for (const fn of this.listeners) fn(this.transient);
  }

  // ---------------------------------------------------------------------------
  // Store access

  private get state() {
    return useStore.getState();
  }

  private get data(): SketchData | null {
    return this.state.editing?.draft.sketch?.data ?? null;
  }

  /** The part face's edges and everything else the sketch can snap to, put together once per answer from the engine. */
  private refsCache: { edges: RefEdge[]; candidates: RefEdge[]; planes: RefEdge[]; list: RefEdge[] } | null = null;

  /**
   * Edges of the part face the sketch is on (first, so their "ref:<n>" ids
   * match what the view draws), then the other sketches' geometry and every
   * part's edges, seen square-on to the sketch. Nothing is taken out of the
   * list (hidden things are skipped when looking, see `skipRef`), so the ids
   * stay the same when something is hidden or shown.
   */
  private get refs(): RefEdge[] {
    const st = this.state;
    const id = st.editing?.draft.id;
    const edges = (id && st.sketchLinks?.[id]?.edges) || NO_REFS;
    const candidates = id && st.sketchCandidates?.id === id ? st.sketchCandidates.list : NO_REFS;
    // Then the lines where Top, Front, Right and Plane features cross the sketch, and the origin (planeRefs.ts).
    const plane = (id && st.sketchLinks?.[id]?.plane) || st.editing?.draft.sketch?.plane;
    const planes = id && plane ? sketchPlaneRefs(plane, activeFeatures(st), id, st.builtFrames) : NO_REFS;
    const c = this.refsCache;
    if (c && c.edges === edges && c.candidates === candidates && c.planes === planes) return c.list;
    const list = candidates.length || planes.length ? [...edges, ...candidates, ...planes] : edges;
    this.refsCache = { edges, candidates, planes, list };
    return list;
  }

  private skipCache: { hidden: string[]; features: Feature[]; skip: (e: RefEdge) => boolean } | null = null;

  /** Whether a reference is left out: a hidden part's edge, or a sketch that isn't shown in the view. */
  private get skipRef(): (e: RefEdge) => boolean {
    const hidden = this.state.hiddenParts;
    const features = activeFeatures(this.state);
    const c = this.skipCache;
    if (c && c.hidden === hidden && c.features === features) return c.skip;
    const used = usedSketches(features);
    // (Curve features, which sketches can use too, are shown unless their eye is off.)
    // (So are Plane features' lines; Top, Front, Right and the origin always are, as Onshape always offers the origin's axes.)
    const shown = new Set(features.filter((f) => (f.type === "sketch" && sketchVisible(f, used)) || ((f.type === "curve" || f.type === "plane") && planeVisible(f))).map((f) => f.id));
    for (const id of DEFAULT_PLANE_REFS) shown.add(id);
    const hiddenSet = new Set(hidden);
    const skip = (e: RefEdge) => (e.project && e.pick ? hiddenSet.has(e.pick.partId) : !!e.source && !shown.has(e.source.sketch));
    this.skipCache = { hidden, features, skip };
    return skip;
  }

  /** How many of the references are the face's own edges (drawn by the view); the rest are drawn only when hovered. */
  private get faceEdgeCount(): number {
    const id = this.state.editing?.draft.id;
    return (id && this.state.sketchLinks?.[id]?.edges.length) || 0;
  }

  /** A reference from elsewhere under the pointer, drawn faintly (the face's own edges are always drawn). */
  private refOutline(hover: Hit | null): PreviewShape[] {
    if (!hover || !isRefId(hover.id)) return [];
    const r = parseRefId(hover.id);
    if (!r || r.index < this.faceEdgeCount) return [];
    const e = this.refs[r.index];
    if (!e) return [];
    if (e.kind === "line") return [{ kind: "guide", a: e.a, b: e.b }];
    if (e.kind === "circle") return [{ kind: "circle", c: e.centre!, r: e.radius! }];
    if (e.kind === "arc") {
      const c = e.centre!;
      return [{ kind: "arc", c, r: e.radius!, a0: Math.atan2(e.start![1] - c[1], e.start![0] - c[0]), a1: Math.atan2(e.end![1] - c[1], e.end![0] - c[0]) }];
    }
    const path = e.path ?? [];
    return path.slice(1).map((q, i) => ({ kind: "guide" as const, a: path[i], b: q }));
  }

  /** Points of other sketches and parts near the pointer (not the face's own edges, which are drawn). */
  private nearbyPoints(e: SketchPointer): [number, number][] {
    const refs = this.refs;
    const faceCount = this.faceEdgeCount;
    if (refs.length <= faceCount) return [];
    const reach = NEARBY_PX * pickMm(e);
    const skip = this.skipRef;
    const virt = nearRefs(refs, e.x, e.y, reach, (r) => !!r.source?.later || skip(r));
    const found: { at: [number, number]; d: number }[] = [];
    for (const p of virt.points) {
      const d = Math.hypot(p.x - e.x, p.y - e.y);
      if (d > reach) continue;
      const r = parseRefId(p.id);
      if (!r || r.index < faceCount || r.what === "q") continue;
      found.push({ at: [p.x, p.y], d });
    }
    found.sort((a, b) => a.d - b.d);
    return found.slice(0, NEARBY_MAX).map((f) => f.at);
  }

  /** What's under the pointer, part edges of the face included (their stand-in ids start "ref:"). */
  private pickAt(e: SketchPointer): Hit | null {
    const d = this.data;
    if (!d) return null;
    return pickAt(d, e.x, e.y, POINT_PX * pickMm(e), CURVE_PX * pickMm(e), this.refs, this.skipRef, this.notHidden());
  }

  /** A line's middle or a circle's centre to mark for whatever's hovered. */
  private hintsFor(hit: Hit | null): [number, number][] {
    const d = this.data;
    if (!d || hit?.kind !== "curve") return [];
    const virtual = isRefId(hit.id);
    const s = virtual ? refSketch(this.refs) : d;
    const c = curveById(s, hit.id);
    const h = c ? hintFor(s, c) : null;
    return h ? [h] : [];
  }

  /** Bring a picked part edge into the sketch (as a reference) and give its real id; the sketch's own ids come back as they are. */
  private realId(id: string, record = true): string | null {
    const d = this.data;
    if (!d || !isRefId(id)) return id;
    const r = bringIn(d, id, this.refs);
    if (r.error) {
      this.state.setSketchMessage(r.error, "info");
      return null;
    }
    this.state.updateSketch(r.sketch, { record });
    return r.id;
  }

  /** Whether a stand-in id is a plane's line or the origin (planeRefs.ts). */
  private isPlaneRefId(id: string): boolean {
    const r = isRefId(id) ? parseRefId(id) : null;
    const e = r ? this.refs[r.index] : undefined;
    return !!e && isPlaneRef(e);
  }

  /**
   * Plane lines a Select click brought in that nothing uses and aren't picked any more are taken out again, so
   * clicking along the origin's axes (to pick nothing, or something else) leaves no dashed copies behind. Not an undo step.
   */
  private dropUnusedPlaneLines(keep: readonly string[]): void {
    const d = this.data;
    if (!d) return;
    const t = pruneReferences(d, (c) => "link" in c && !!c.link && !isPartLink(c.link) && isPlaneLink(c.link) && !keep.includes(c.id));
    if (t !== d) this.state.updateSketch(t, { record: false });
  }

  /**
   * The Use tool, clicked in the sketch: another sketch's line, circle, arc,
   * spline or ellipse under the pointer is copied in as real geometry that
   * follows it. False when there's none there (the click then goes to the
   * parts' edges).
   */
  useAt(e: SketchPointer): boolean {
    const d = this.data;
    if (!d || this.tool !== "useEdge") return false;
    const edge = sketchCurveAt(this.refs, e.x, e.y, CURVE_PX * pickMm(e), this.skipRef);
    if (!edge) return false;
    if (edge.source?.later) {
      this.state.setSketchMessage(laterMessage(edge), "info");
      return true;
    }
    const r = linkEdge(d, edge, false);
    this.commit(r, r.curveId ? [r.curveId] : []);
    return true;
  }

  private get tool(): SketchTool {
    const tool = this.state.sketch?.tool ?? "select";
    if (tool !== this.lastTool) {
      // Switching tools abandons anything half-drawn.
      this.lastTool = tool;
      this.placed = [];
      this.pasting = null;
      // (A handle drag in progress is taken back: what it moved live was never kept.)
      const g = this.gizmoDrag;
      this.gizmoDrag = null;
      if (g?.moved && !g.copy) this.state.updateSketch(g.start, { record: false });
      this.acquired = [];
      this.firstCurve = null;
      this.lastEdge = null;
      this.trimStroke = null;
      this.woken = [];
      this.arcMode = false;
      this.press = null;
      this.transient = { ...this.transient, preview: [], inference: null, pending: [] };
    }
    return tool;
  }

  private commit(result: { sketch: SketchData; error?: string }, selection?: string[]): boolean {
    if (result.error) {
      this.state.setSketchMessage(result.error, "error");
      return false;
    }
    this.state.updateSketch(result.sketch, { record: true, selection });
    this.state.setSketchMessage(null);
    return true;
  }

  /**
   * Just after a shape is drawn, offer its sizes (like Onshape): add each
   * dimension and open the first one's value box. Enter keeps it (with
   * whatever was typed), Esc or carrying on drawing drops it.
   */
  private offerDimensions(groups: string[][]): void {
    let data = this.data;
    if (!data) return;
    const ids: string[] = [];
    for (const refs of groups) {
      const r = addDimension(data, refs);
      // Sizes already set by something else aren't offered.
      if (r.error || r.driven) continue;
      data = r.sketch;
      ids.push(r.dimensionId);
    }
    if (!ids.length) return;
    this.state.updateSketch(data, { record: false });
    this.state.offerDimensions(ids);
  }

  /**
   * Mirror tool: the first click picks the line to mirror about (if shapes
   * were already selected, they're mirrored straight away); each click after
   * that mirrors the clicked line, arc or circle. Esc finishes.
   */
  private mirrorClick(e: SketchPointer): void {
    const d = this.data!;
    const hit = this.hitAt(e);
    const axis = this.transient.pending[0];
    if (!axis) {
      const c = hit?.kind === "curve" ? curveById(d, hit.id) : undefined;
      if (c?.type !== "line") {
        this.state.setSketchMessage("First click the straight line to mirror about (a construction line works well).", "info");
        return;
      }
      this.emit({ pending: [c.id] });
      const chosen = (this.state.sketch?.selection ?? []).filter((id) => id !== c.id && d.curves.some((k) => k.id === id));
      if (chosen.length) {
        const r = mirrorCurves(d, c.id, chosen);
        if (this.commit(r, r.curveIds)) this.state.setSketchMessage(`Mirrored ${chosen.length === 1 ? "1 shape" : `${chosen.length} shapes`}. Click more to mirror them too, or Esc to finish.`, "info");
        return;
      }
      this.state.setSketchMessage("Now click the lines, arcs and circles to mirror. Esc when done.", "info");
      return;
    }
    if (hit?.kind !== "curve" || hit.id === axis) {
      this.state.setSketchMessage("Click a line, arc or circle to mirror it, or Esc to finish.", "info");
      return;
    }
    const r = mirrorCurves(d, axis, [hit.id]);
    if (this.commit(r, r.curveIds)) this.state.setSketchMessage("Mirrored. Click more to mirror them too, or Esc to finish.", "info");
    this.emit({ hover: null });
  }

  /**
   * Pattern tool: click lines, arcs and circles to choose what to repeat (and,
   * for a circular pattern, a point to go round); the sketch panel's button
   * makes the copies.
   */
  private patternClick(e: SketchPointer): void {
    const st = this.state;
    const moving = this.tool === "sketchTransform";
    const circular = !moving && st.sketch?.patternKind === "circular";
    // A circular pattern's centre can be any point: a sketch point, a circle's centre, a line's end, or a corner of the face.
    const picked = circular ? this.pickAt(e) : null;
    if (!moving && st.sketch?.patternKind === "linear" && st.sketch.patternDirectionPick) {
      const over = this.pickAt(e);
      const s = over && isRefId(over.id) ? refSketch(this.refs) : this.data!;
      const line = over?.kind === "curve" ? curveById(s, over.id) : undefined;
      if (line?.type !== "line") {
        st.setSketchMessage("Click a straight line (or a straight edge of the face) to set the direction.", "info");
        return;
      }
      const [a, b] = [pointPos(s, line.p1), pointPos(s, line.p2)];
      const angle = Math.round(((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI) * 100) / 100;
      // A line of the sketch itself: the copies follow it if it turns (a part's edge just sets the angle).
      const lineId = over && !isRefId(over.id) ? line.id : undefined;
      st.setSketchOptions({ patternAngle: String(Object.is(angle, -0) ? 0 : angle), patternDirectionPick: false, patternLine: lineId });
      st.setSketchMessage(
        `Direction set along that line (${angle}°)${lineId ? " — the copies will follow the line if it turns" : ""}. Type 180 more to go the other way.`,
        "info",
      );
      this.emit({ preview: this.patternPreview() });
      return;
    }
    const hit = picked?.kind === "point" ? picked : this.hitAt(e);
    if (hit?.kind === "point" && circular) {
      const id = this.realId(hit.id);
      if (!id) return;
      st.setSketchOptions({ patternCentre: id });
      st.setSketchMessage("Centre chosen. Click the shapes to repeat, then Make pattern in the sketch panel. The copies follow if the centre moves.", "info");
    } else if (hit?.kind === "curve") {
      const sel = st.sketch?.selection ?? [];
      st.setSketchSelection(sel.includes(hit.id) ? sel.filter((x) => x !== hit.id) : [...sel, hit.id]);
      st.setSketchMessage(null);
    } else {
      st.setSketchMessage(
        moving ? "Click the lines, arcs and circles to move, then Move (or Copy) in the sketch panel." : "Click the lines, arcs and circles to repeat, then Make pattern in the sketch panel.",
        "info",
      );
      return;
    }
    this.emit({ preview: this.patternPreview() });
  }

  /** Faint copies showing where the pattern tool would put things. */
  private patternPreview(): PreviewShape[] {
    const d = this.data;
    const session = this.state.sketch;
    if (!d || !session) return [];
    if (this.tool === "sketchTransform") return this.transformPreview();
    const sources = session.selection.map((id) => curveById(d, id)).filter((c) => !!c);
    if (!sources.length) return [];
    const opts = readPatternSettings(d, session);
    if (typeof opts === "string" || !(opts.count >= 2 && opts.count <= 200)) return [];
    const moves = Array.from({ length: Math.round(opts.count) - 1 }, (_, i) => patternTransform(opts, i + 1));
    // A second direction (rows × columns): every one of the row moved along it too.
    const second = opts.kind === "linear" ? readSecondDirection(useEditToolOptions.getState()) : null;
    if (second && typeof second !== "string" && second.count >= 2 && second.count <= 200) {
      const row = [(p: [number, number]) => p, ...moves];
      const along = { kind: "linear" as const, count: second.count, spacing: second.spacing, angle: second.angle };
      for (let j = 1; j < Math.round(second.count); j++) {
        const step = patternTransform(along, j);
        for (const m of row) moves.push((p) => step(m(p)));
      }
    }
    return moves.flatMap((move) => curvesPreview(d, sources, move));
  }

  /**
   * Move / copy: where the typed amounts would put the picked shapes (faintly), and the handles on them — the
   * middle square moves them, the ring turns them, the square on the arm scales them (see transformSelection.ts).
   */
  private transformPreview(): PreviewShape[] {
    const d = this.data;
    const session = this.state.sketch;
    if (!d || !session) return [];
    const g = this.gizmoDrag;
    if (g) {
      const sources = g.ids.map((id) => curveById(g.start, id)).filter((c) => !!c);
      const ghost = g.copy && g.moved ? curvesPreview(g.start, sources, motionMap(g.centre, g.motion), g.motion.scale) : [];
      return [...ghost, ...gizmoShapes({ centre: g.centre, mmPerPx: this.lastMmPerPx }, g.motion)];
    }
    const ids = session.selection;
    const centre = selectionCentre(d, ids);
    if (!centre) return [];
    const out: PreviewShape[] = [];
    const t = readTransformSettings(session);
    const k = readScale(session.moveScale);
    if (typeof t !== "string" && typeof k === "number" && (t.dx !== 0 || t.dy !== 0 || t.angle !== 0 || k !== 1)) {
      const sources = ids.map((id) => curveById(d, id)).filter((c) => !!c);
      out.push(...curvesPreview(d, sources, motionMap(centre, { dx: t.dx, dy: t.dy, angle: t.angle, scale: k }), k));
    }
    out.push(...gizmoShapes({ centre, mmPerPx: this.lastMmPerPx }));
    return out;
  }

  /** A press on one of Move / copy's handles starts dragging it (true); elsewhere the click picks shapes as before. */
  private gizmoDown(e: SketchPointer): boolean {
    const d = this.data;
    const ids = this.state.sketch?.selection ?? [];
    if (!d || this.tool !== "sketchTransform") return false;
    const centre = selectionCentre(d, ids);
    if (!centre) return false;
    const part = gizmoPartAt({ centre, mmPerPx: e.mmPerPx }, e.x, e.y, e.reach ?? 1);
    if (!part) return false;
    this.gizmoDrag = { part, start: d, ids: [...ids], centre, from: [e.x, e.y], turned: 0, lastAt: [e.x, e.y], motion: NO_MOTION, copy: !!this.state.sketch?.moveCopy, moved: false, said: null };
    return true;
  }

  private gizmoMove(e: SketchPointer): void {
    const g = this.gizmoDrag!;
    if (!g.moved && Math.hypot(e.x - g.from[0], e.y - g.from[1]) < DRAG_PX * pickMm(e)) return;
    g.moved = true;
    let m: SelectionMotion = NO_MOTION;
    let snap: [number, number] | null = null;
    if (g.part === "move") {
      // The middle snaps onto points, middles of lines and the origin (Shift: no snapping).
      const tx = g.centre[0] + e.x - g.from[0];
      const ty = g.centre[1] + e.y - g.from[1];
      const found = snapAt(g.start, tx, ty, { pointTol: SNAP_PX * pickMm(e), curveTol: 0, refs: this.refs, skip: this.skipRef, ignore: this.notHidden(new Set(selectionPoints(g.start, g.ids))), free: e.shift });
      const sn = found.placed.snap;
      const snapped = !!sn && sn.kind !== "curve" && !(sn.kind === "ref" && (sn.at === "on" || sn.edge.source?.later));
      const [x, y] = snapped ? [found.placed.x, found.placed.y] : [tx, ty];
      if (snapped) snap = [x, y];
      m = { dx: x - g.centre[0], dy: y - g.centre[1], angle: 0, scale: 1 };
    } else if (g.part === "turn") {
      g.turned += turnBetween(g.centre, g.lastAt, [e.x, e.y]);
      g.lastAt = [e.x, e.y];
      m = { dx: 0, dy: 0, angle: snapTurn(g.turned, e.shift), scale: 1 };
    } else {
      const from = Math.hypot(g.from[0] - g.centre[0], g.from[1] - g.centre[1]) || 1;
      m = { dx: 0, dy: 0, angle: 0, scale: snapScale(Math.hypot(e.x - g.centre[0], e.y - g.centre[1]) / from, e.shift) };
    }
    g.motion = m;
    if (!g.copy) {
      const r = transformSelection(g.start, g.ids, m, g.centre);
      this.state.updateSketch(r.error ? g.start : r.sketch, { record: false });
      if (r.error) {
        if (g.said !== r.error) this.state.setSketchMessage(r.error, "info");
        g.said = r.error;
      } else {
        g.said = null;
        this.state.setSketchMessage(motionWords(g.part, m), "info");
      }
    } else this.state.setSketchMessage(motionWords(g.part, m), "info");
    this.emit({ preview: this.transformPreview(), snap, hover: null, hints: [] });
  }

  private gizmoUp(): void {
    const g = this.gizmoDrag!;
    this.gizmoDrag = null;
    const m = g.motion;
    const still = m.dx === 0 && m.dy === 0 && m.angle === 0 && m.scale === 1;
    if (!g.moved || still) {
      if (g.moved && !g.copy) this.state.updateSketch(g.start, { record: false });
      this.emit({ preview: this.transformPreview(), snap: null });
      return;
    }
    const done = g.part === "move" ? "Moved" : g.part === "turn" ? "Turned" : "Scaled";
    if (g.copy) {
      const r = transformCopy(g.start, g.ids, m, g.centre);
      if (r.error) this.state.setSketchMessage(r.error, "error");
      else {
        this.state.updateSketch(r.sketch, { record: true, selection: r.ids });
        this.state.setSketchMessage(`${done} a copy — the copy is picked, to drag again. Esc to finish.`, "info");
      }
    } else {
      const r = transformSelection(g.start, g.ids, m, g.centre);
      if (r.error) {
        this.state.updateSketch(g.start, { record: false });
        this.state.setSketchMessage(r.error, "info");
      } else {
        this.state.updateSketch(r.sketch, { record: false });
        this.state.recordSketchStep(g.start);
        this.state.setSketchMessage(`${done}. Drag the handles again, or Esc to finish.`, "info");
      }
    }
    this.emit({ preview: this.transformPreview(), snap: null });
  }

  /** Take back a handle drag in progress (Esc, or a second finger). */
  private dropGizmoDrag(): boolean {
    const g = this.gizmoDrag;
    if (!g) return false;
    this.gizmoDrag = null;
    if (g.moved && !g.copy) this.state.updateSketch(g.start, { record: false });
    this.state.setSketchMessage(null);
    this.emit({ preview: this.transformPreview(), snap: null });
    return true;
  }

  /**
   * The view's zoom (mm per screen pixel), every frame: Move / copy's handles are a set size on screen, so they're
   * drawn again when it changes (a wheel zoom with no mouse move).
   */
  zoomed(mmPerPx: number): void {
    if (!(mmPerPx > 0) || Math.abs(mmPerPx - this.lastMmPerPx) <= 1e-9 * mmPerPx) return;
    this.lastMmPerPx = mmPerPx;
    if (this.state.sketch?.tool === "sketchTransform") this.emit({ preview: this.transformPreview() });
  }

  /** Is one of Move / copy's handles being dragged (undo waits until it's let go)? */
  draggingHandle(): boolean {
    return this.gizmoDrag !== null;
  }

  /** Redraw the pattern preview (after its settings change in the panel). */
  refreshPreview(): void {
    if (this.tool === "sketchPattern" || this.tool === "sketchTransform") this.emit({ preview: this.patternPreview() });
  }

  // ---------------------------------------------------------------------------
  // Snapping

  private hitAt(e: SketchPointer, ignore?: Set<string>): Hit | null {
    const d = this.data;
    if (!d) return null;
    return hitTest(d, e.x, e.y, POINT_PX * pickMm(e), CURVE_PX * pickMm(e), { ignore: this.notHidden(ignore) });
  }

  /** Construction geometry hidden with Shift+P (and its own points): never picked or snapped to. */
  private hidden: ReadonlySet<string> = new Set();

  setHidden(ids: ReadonlySet<string>): void {
    this.hidden = ids;
  }

  /** `ignore` with the hidden ids added (unchanged when nothing is hidden). */
  private notHidden(ignore?: Set<string>): Set<string> | undefined {
    if (!this.hidden.size) return ignore;
    return new Set([...(ignore ?? []), ...this.hidden]);
  }

  /**
   * Where the pointer snaps to while drawing (points, middles of lines, part edges, lining up, onto curves).
   * Holding Shift places it exactly where the pointer is, with nothing snapped or inferred (as in Onshape);
   * `needsPoint`: this click must land on a point (a tangent arc's start), so Shift is ignored.
   */
  private snapAt(e: SketchPointer, needsPoint = false): SnapResult {
    return snapAt(this.data!, e.x, e.y, { pointTol: POINT_PX * pickMm(e), curveTol: CURVE_PX * pickMm(e), acquired: this.acquired, refs: this.refs, skip: this.skipRef, ignore: this.notHidden(), free: e.shift && !needsPoint });
  }

  /** The spline handle end under the pointer, if any (handles show on selected splines). */
  private handleAt(e: SketchPointer): SplineHandleEnd | null {
    const d = this.data;
    if (!d) return null;
    const tol = POINT_PX * pickMm(e);
    let best: SplineHandleEnd | null = null;
    let bestD = tol;
    for (const h of splineHandleEnds(d, this.state.sketch?.selection ?? [])) {
      const dist = Math.hypot(h.at[0] - e.x, h.at[1] - e.y);
      if (dist <= bestD) {
        bestD = dist;
        best = h;
      }
    }
    return best;
  }

  /** Where a click lands, snapped to points, the origin, middles of lines, part edges or curves. */
  private placeAt(e: SketchPointer): Placed {
    return this.snapAt(e, this.tool === "tangentArc" && this.placed.length === 0).placed;
  }

  private snapMarker(p: Placed): [number, number] | null {
    return p.snap ? [p.x, p.y] : null;
  }

  // ---------------------------------------------------------------------------
  // Pointer events

  pointerDown(e: SketchPointer): void {
    const d = this.data;
    if (!d) return;
    const tool = this.tool;
    this.press = null;
    // (The pointer is here now: a release with no move since is a plain click.)
    this.lastEvent = e;
    if (this.pasting) return this.pasteAt(e);
    if (tool === "select") return this.selectDown(e);
    if (tool === "dimension") return this.dimensionClick(e);
    if (tool === "extend" || tool === "split") {
      const hit = this.hitAt(e);
      if (hit?.kind !== "curve") {
        this.state.setSketchMessage(tool === "extend" ? "Click near the end of a line, arc, spline or part of an ellipse you want to lengthen." : "Click a line, arc, spline or part of an ellipse where you want to split it.", "info");
        return;
      }
      this.commit(tool === "extend" ? extendAt(d, hit.id, { x: e.x, y: e.y }) : splitAt(d, hit.id, { x: e.x, y: e.y }), []);
      this.emit({ hover: null });
      return;
    }
    if (tool === "trim") {
      // A press starts a stroke: let go without moving = a click (trims what's under it), drag = trim all it crosses.
      // (A finger's lift arrives as a press while its stroke is on: it just ends the path there.)
      if (this.trimStroke?.moved) {
        this.trimStroke.path.push([e.x, e.y]);
        return;
      }
      this.trimStroke = { path: [[e.x, e.y]], moved: false, mm: pickMm(e) };
      return;
    }
    if (tool === "offset") {
      const hit = this.hitAt(e);
      if (hit?.kind !== "curve") {
        this.state.setSketchMessage("Click a line, arc, circle, spline or ellipse — on the side you want the copy.", "info");
        return;
      }
      const r = offsetCurves(d, hit.id, { x: e.x, y: e.y }, this.state.sketch?.offsetDistance ?? "2");
      this.commit(r, r.curveIds);
      this.emit({ hover: null });
      return;
    }
    if (tool === "useEdge" || tool === "intersect") return;
    if (tool === "mirror") return this.mirrorClick(e);
    if (tool === "sketchTransform" && this.gizmoDown(e)) return;
    if (tool === "sketchPattern" || tool === "sketchTransform") return this.patternClick(e);
    if (tool === "sketchFillet" || tool === "sketchChamfer") return this.cornerClick(e, tool);
    if (tool === "slotAlong") {
      const hit = this.hitAt(e);
      if (hit?.kind !== "curve") {
        this.state.setSketchMessage("Click a line, arc, circle, spline or ellipse to put a slot along it (set the width in the sketch panel).", "info");
        return;
      }
      const r = slotAlong(d, hit.id, useEditToolOptions.getState().slotWidth);
      this.commit(r, r.curveIds);
      this.emit({ hover: null });
      return;
    }

    // Drawing on: any size offered for the last shape and not typed is dropped.
    this.state.discardOfferedDimensions();
    const p = this.placeAt(e);
    // Something from a sketch further down the list can't be used (they'd depend on each other).
    if (p.snap?.kind === "ref" && p.snap.edge.source?.later) {
      this.state.setSketchMessage(laterMessage(p.snap.edge), "info");
      return;
    }
    const construction = this.state.sketch?.construction ?? false;
    // (A shape started by this press: with the mouse, letting go elsewhere is its next click.)
    if (this.placed.length === 0 && DRAG_DRAWN.has(tool)) this.press = e;

    switch (tool) {
      case "point": {
        const r = addPoint(d, p);
        this.commit(r, [r.pointId]);
        return;
      }
      case "text": {
        const settings = readTextSettings(this.state.sketch ?? {});
        if (typeof settings === "string") {
          this.state.setSketchMessage(settings, "error");
          return;
        }
        const r = addText(d, p, settings, construction);
        if (this.commit(r, [r.textId]))
          this.state.setSketchMessage("Text added. Change its words, size or turn in the sketch panel (double-click text to edit it later); dimension its point to place it exactly.", "info");
        return;
      }
      case "line": {
        if (this.placed.length === 0) {
          this.placed = [p];
          this.returning = "fresh";
          return;
        }
        const start = this.placed[0];
        if (this.arcMode) return this.lineArcClick(start, p);
        const tangent = e.shift ? null : this.tangentFor(start, p, e);
        if (tangent) {
          const t = addTangentLine(d, start, tangent, construction);
          if (!this.commit(t)) return;
          if (!construction) this.offerDimensions([[t.lineId]]);
          this.placed = [{ x: tangent.end[0], y: tangent.end[1], snap: { kind: "point", id: t.endId } }];
          this.returning = "fresh";
          this.emit({ preview: [], inference: null });
          return;
        }
        const plan = this.linePlan(start, p, e);
        const end = plan.end;
        const r = addLine(d, start, end, { construction, orientation: plan.orientation, relation: plan.relation });
        if (!this.commit(r)) return;
        if (!construction) this.offerDimensions([[r.lineId]]);
        // Keep drawing from the new end, unless we just closed the shape (or ended on a corner of the face).
        const closed = p.snap?.kind === "point" || p.snap?.kind === "origin" || (p.snap?.kind === "ref" && p.snap.at !== "on" && p.snap.at !== "mid");
        this.placed = closed ? [] : [{ ...end, snap: { kind: "point", id: r.endId } }];
        // The line just drawn is woken up: the next one may be square to it.
        this.wake(r.lineId);
        this.returning = "fresh";
        this.emit({ preview: [], inference: null });
        return;
      }
      case "midpointLine": {
        if (this.placed.length === 0) {
          this.placed = [p];
          this.state.setSketchMessage("Now click where one end goes — the other end goes as far the other way.", "info");
          return;
        }
        const mid = this.placed[0];
        const plan = this.linePlan(mid, p, e, false);
        const r = addMidpointLine(d, mid, plan.end, { construction, orientation: plan.orientation, relation: plan.relation });
        if (!this.commit(r, [r.lineId])) return;
        this.placed = [];
        if (!construction) this.offerDimensions([[r.lineId]]);
        this.wake(r.lineId);
        this.emit({ preview: [], inference: null });
        return;
      }
      case "rectangle": {
        if (this.placed.length === 0) {
          this.placed = [p];
          return;
        }
        const r = addRectangle(d, this.placed[0], p, construction);
        if (this.commit(r)) {
          this.placed = [];
          if (!construction) this.offerDimensions([[r.lineIds[0]], [r.lineIds[1]]]);
        }
        this.emit({ preview: [] });
        return;
      }
      case "centreRectangle": {
        if (this.placed.length === 0) {
          this.placed = [p];
          return;
        }
        const r = addCentreRectangle(d, this.placed[0], p, construction);
        if (this.commit(r)) {
          this.placed = [];
          if (!construction) this.offerDimensions([[r.lineIds[0]], [r.lineIds[1]]]);
        }
        this.emit({ preview: [] });
        return;
      }
      case "tangentArc": {
        if (this.placed.length === 0) {
          const id = p.snap?.kind === "point" ? p.snap.id : null;
          if (!id || !tangentAt(d, id)) {
            this.state.setSketchMessage("Click the end of a line or arc to carry on from.", "info");
            return;
          }
          this.placed = [p];
          this.state.setSketchMessage(null);
          return;
        }
        const startId = (this.placed[0].snap as { id: string }).id;
        const r = addTangentArc(d, startId, p, construction);
        if (!this.commit(r, [r.arcId])) return;
        // Keep going from the arc's new end, like the line tool.
        const arc = r.sketch.curves.find((c) => c.id === r.arcId);
        const endId = arc?.type === "arc" ? (arc.start === startId ? arc.end : arc.start) : null;
        const closed = p.snap?.kind === "point" || p.snap?.kind === "origin";
        this.placed = endId && !closed ? [{ ...p, snap: { kind: "point", id: endId } }] : [];
        this.emit({ preview: [] });
        return;
      }
      case "spline": {
        // Each click adds a point; clicking the first point again closes it, Esc finishes an open one.
        const first = this.placed[0];
        const closing = !e.shift && this.placed.length >= 3 && !!first && Math.hypot(p.x - first.x, p.y - first.y) < POINT_PX * pickMm(e);
        // Clicking the last point again (a double-click) finishes an open curve, as in Onshape.
        const last = this.placed[this.placed.length - 1];
        if (!closing && last && Math.hypot(p.x - last.x, p.y - last.y) < POINT_PX * pickMm(e)) {
          if (this.placed.length < 2) return;
          const r = addSpline(d, this.placed, false, construction);
          if (this.commit(r, [r.splineId])) this.placed = [];
          this.emit({ preview: [] });
          return;
        }
        if (!closing) {
          this.placed = [...this.placed, p];
          if (this.placed.length === 1) this.state.setSketchMessage("Click more points for the curve to pass through. Click the first point to close it, or Esc to finish.", "info");
          return;
        }
        const r = addSpline(d, this.placed, true, construction);
        if (this.commit(r, [r.splineId])) this.placed = [];
        this.emit({ preview: [] });
        return;
      }
      case "conic": {
        if (this.placed.length < 2) {
          this.placed = [...this.placed, p];
          this.state.setSketchMessage(this.placed.length === 1 ? "Click where the curve ends." : "Now click the corner the curve bends towards (set how full it is in the sketch panel).", "info");
          return;
        }
        const [start, end] = this.placed;
        const r = addConic(d, start, end, p, this.state.sketch?.conicRho ?? 0.5, construction);
        if (this.commit(r, [r.conicId])) {
          this.placed = [];
          this.state.setSketchMessage(null);
        }
        this.emit({ preview: [] });
        return;
      }
      case "ellipse": {
        if (this.placed.length < 2) {
          this.placed = [...this.placed, p];
          if (this.placed.length === 2) this.state.setSketchMessage("Now click to set how wide it is.", "info");
          return;
        }
        const [centre, major] = this.placed;
        const r = addEllipse(d, centre, major, [p.x, p.y], construction);
        if (this.commit(r, [r.ellipseId])) {
          this.placed = [];
          this.state.setSketchMessage(null);
          const el = r.sketch.curves.find((c) => c.id === r.ellipseId);
          if (!construction && el?.type === "ellipse") this.offerDimensions([[el.center, el.major], [el.center, el.minor]]);
        }
        this.emit({ preview: [] });
        return;
      }
      case "circle": {
        if (this.placed.length === 0) {
          this.placed = [p];
          return;
        }
        const c = this.placed[0];
        const r = addCircle(d, c, Math.hypot(p.x - c.x, p.y - c.y), construction);
        if (this.commit(r, [r.circleId])) {
          this.placed = [];
          if (!construction) this.offerDimensions([[r.circleId]]);
        }
        this.emit({ preview: [] });
        return;
      }
      case "circle3":
      case "centreArc":
      case "alignedRectangle": {
        if (this.placed.length < 2) {
          this.placed = [...this.placed, p];
          return;
        }
        const [a, b] = this.placed;
        let ids: string[] = [];
        let offer: string[][] = [];
        let r;
        if (tool === "circle3") {
          r = addThreePointCircle(d, a, b, p, construction);
          ids = [r.circleId];
          offer = [[r.circleId]];
        } else if (tool === "centreArc") {
          r = addCentreArc(d, a, b, p, construction);
          ids = [r.arcId];
          offer = [[r.arcId]];
        } else {
          r = addAlignedRectangle(d, a, b, [p.x, p.y], construction);
          ids = r.lineIds;
          offer = [[r.lineIds[0]], [r.lineIds[1]]];
        }
        if (this.commit(r, ids)) {
          this.placed = [];
          if (!construction) this.offerDimensions(offer);
        }
        this.emit({ preview: [] });
        return;
      }
      case "slot": {
        if (this.placed.length < 2) {
          this.placed = [...this.placed, p];
          return;
        }
        const [a, b] = this.placed;
        const r = addSlot(d, a, b, slotRadius(a, b, p), construction);
        if (this.commit(r, r.curveIds)) {
          this.placed = [];
          // Offer its length (centre to centre) and the round ends' size.
          if (!construction && r.axisId) this.offerDimensions([[r.axisId], [r.curveIds[2]]]);
        }
        this.emit({ preview: [] });
        return;
      }
      case "polygon": {
        if (this.placed.length === 0) {
          this.placed = [p];
          return;
        }
        const r = addPolygon(d, this.placed[0], p, this.state.sketch?.polygonSides ?? 6, construction, this.state.sketch?.polygonAcross ?? "corners");
        if (this.commit(r, r.lineIds)) {
          this.placed = [];
          // Offer its size: across corners, or across flats.
          if (!construction && r.sizeCircleId) this.offerDimensions([[r.sizeCircleId]]);
        }
        this.emit({ preview: [] });
        return;
      }
      case "ellipticalArc": {
        if (this.placed.length < 3) {
          this.placed = [...this.placed, p];
          this.state.setSketchMessage(
            this.placed.length === 1 ? "Click the end of the ellipse's long axis." : this.placed.length === 2 ? "Click where the arc starts (this also sets how wide the ellipse is)." : "Click where the arc ends.",
            "info",
          );
          return;
        }
        const [c, m, st] = this.placed;
        const r = addEllipticalArc(d, c, m, st, p, construction);
        if (this.commit(r, [r.ellipseId])) {
          this.placed = [];
          this.state.setSketchMessage(null);
        }
        this.emit({ preview: [] });
        return;
      }
      case "arc": {
        if (this.placed.length < 2) {
          this.placed = [...this.placed, p];
          return;
        }
        const r = addArc(d, this.placed[0], this.placed[1], { x: p.x, y: p.y }, construction);
        if (this.commit(r, [r.arcId])) {
          this.placed = [];
          if (!construction) this.offerDimensions([[r.arcId]]);
        }
        this.emit({ preview: [] });
        return;
      }
    }
  }

  pointerMove(e: SketchPointer, dragging: boolean): void {
    const d = this.data;
    if (!d) return;
    const tool = this.tool;
    this.lastPointer = [e.x, e.y];
    this.lastMmPerPx = e.mmPerPx;
    this.lastEvent = e;
    if (this.pasting) {
      const at = this.pasteSnap(e);
      this.emit({ preview: this.pastePreview([at.x, at.y]), hover: null, snap: at.snap ? [at.x, at.y] : null, inference: null, hints: at.hints });
      return;
    }
    if (this.gizmoDrag) {
      if (dragging) this.gizmoMove(e);
      return;
    }
    if (tool === "select") {
      if (dragging && this.drag) return this.selectDrag(e);
      const hover = this.selectHit(e);
      this.emit({ hover, preview: this.refOutline(hover), snap: null, inference: null, hints: this.hintsFor(hover), nearby: this.nearbyPoints(e) });
      return;
    }
    if (tool === "useEdge" || tool === "intersect") return;
    if (tool === "sketchPattern" || tool === "sketchTransform") {
      const circular = tool === "sketchPattern" && this.state.sketch?.patternKind === "circular";
      const picking = tool === "sketchPattern" && this.state.sketch?.patternKind === "linear" && this.state.sketch.patternDirectionPick;
      const over = circular || picking ? this.pickAt(e) : null;
      const hit = over?.kind === "point" || picking ? over : this.hitAt(e);
      this.emit({ hover: hit?.kind === "curve" || (circular && hit?.kind === "point") ? hit : null, snap: null, preview: this.patternPreview(), hints: [] });
      return;
    }
    if (tool === "dimension") {
      const hover = this.pickAt(e);
      if (this.transient.pending.length) this.emit({ hover, snap: null, hints: [], nearby: this.nearbyPoints(e), ...this.dimensionPreview(e) });
      else this.emit({ hover, snap: null, preview: this.refOutline(hover), hints: this.hintsFor(hover), nearby: this.nearbyPoints(e) });
      return;
    }
    if (tool === "trim" && this.trimStroke) {
      const st = this.trimStroke;
      const [x0, y0] = st.path[0];
      if (dragging && (st.moved || Math.hypot(e.x - x0, e.y - y0) >= DRAG_PX * pickMm(e))) {
        st.moved = true;
        st.path.push([e.x, e.y]);
        const preview = st.path.slice(1).map((q, i): PreviewShape => ({ kind: "guide", a: st.path[i], b: q }));
        this.emit({ hover: null, snap: null, preview, hints: [] });
        return;
      }
      if (!dragging) this.trimStroke = null;
    }
    if (tool === "sketchChamfer" || tool === "slotAlong") {
      const hit = this.hitAt(e);
      this.emit({ hover: tool === "slotAlong" && hit?.kind !== "curve" ? null : hit, snap: null, preview: [], hints: [] });
      return;
    }
    if (tool === "trim" || tool === "extend" || tool === "split" || tool === "sketchFillet" || tool === "offset" || tool === "mirror") {
      const hit = this.hitAt(e);
      this.emit({ hover: (tool === "trim" || tool === "extend" || tool === "split" || tool === "offset" || tool === "mirror") && hit?.kind !== "curve" ? null : hit, snap: null, preview: [], hints: [] });
      return;
    }

    // Passing over a point picks it up, to line up with afterwards; passing over a circle's rim picks up its centre.
    const over = this.hitAt(e);
    const overCurve = over?.kind === "curve" ? curveById(d, over.id) : undefined;
    const pickedUp = over?.kind === "point" ? over.id : overCurve && (overCurve.type === "circle" || overCurve.type === "arc" || overCurve.type === "ellipse") ? overCurve.center : null;
    if (pickedUp && !e.shift && this.acquired[0] !== pickedUp) this.acquired = [pickedUp, ...this.acquired.filter((x) => x !== pickedUp)].slice(0, 4);
    // Passing over a line wakes it up: a line being drawn may then be inferred parallel or perpendicular to it.
    if (overCurve?.type === "line" && !e.shift && (tool === "line" || tool === "midpointLine")) this.wake(overCurve.id);
    if (tool === "line") this.followReturn(e);
    const snapped = this.snapAt(e, tool === "tangentArc" && this.placed.length === 0);
    const p = snapped.placed;
    const preview: PreviewShape[] = [];
    if (p.snap?.kind === "align") {
      for (const id of [p.snap.x, p.snap.y]) if (id) preview.push({ kind: "guide", a: pointPos(d, id), b: [p.x, p.y] });
    }
    let inference: SketchTransient["inference"] = null;
    let snap = this.snapMarker(p);
    const first = this.placed[0];
    const arcing = tool === "line" && !!first && this.arcMode;
    const tangent = tool === "line" && first && !e.shift && !arcing ? this.tangentFor(first, p, e) : null;
    if (arcing) {
      preview.push(...tangentArcPreview(d, first, p));
    } else if (tangent) {
      preview.push({ kind: "line", a: tangent.start, b: tangent.end });
      snap = tangent.end;
      inference = { at: tangent.end, text: "Tangent" };
    } else if ((tool === "line" || tool === "midpointLine") && first) {
      const plan = this.linePlan(first, p, e, tool === "line");
      const end: [number, number] = [plan.end.x, plan.end.y];
      if (plan.badge) {
        inference = { at: end, text: plan.badge };
        snap = end;
      }
      const a: [number, number] = tool === "midpointLine" ? [2 * first.x - end[0], 2 * first.y - end[1]] : [first.x, first.y];
      preview.push({ kind: "line", a, b: end });
    } else if (tool === "spline" && first) {
      const pts = splinePolyline([...this.placed.map((q): [number, number] => [q.x, q.y]), [p.x, p.y]], false);
      for (let i = 0; i + 1 < pts.length; i++) preview.push({ kind: "line", a: pts[i], b: pts[i + 1] });
    } else if (tool === "rectangle" && first) {
      const a: [number, number] = [first.x, first.y];
      const c: [number, number] = [p.x, p.y];
      const b: [number, number] = [c[0], a[1]];
      const dd: [number, number] = [a[0], c[1]];
      preview.push({ kind: "line", a, b }, { kind: "line", a: b, b: c }, { kind: "line", a: c, b: dd }, { kind: "line", a: dd, b: a });
    } else if (tool === "centreRectangle" && first) {
      const c: [number, number] = [p.x, p.y];
      const a: [number, number] = [2 * first.x - p.x, 2 * first.y - p.y];
      const b: [number, number] = [c[0], a[1]];
      const dd: [number, number] = [a[0], c[1]];
      preview.push({ kind: "line", a, b }, { kind: "line", a: b, b: c }, { kind: "line", a: c, b: dd }, { kind: "line", a: dd, b: a }, { kind: "guide", a, b: c });
    } else if (tool === "tangentArc" && first) {
      preview.push(...tangentArcPreview(d, first, p));
    } else if (tool === "circle3" && first) {
      const second = this.placed[1];
      if (!second) preview.push({ kind: "line", a: [first.x, first.y], b: [p.x, p.y] });
      else {
        const c = circleThrough([first.x, first.y], [second.x, second.y], [p.x, p.y]);
        if (c) preview.push({ kind: "circle", c, r: Math.hypot(first.x - c[0], first.y - c[1]) });
        else preview.push({ kind: "line", a: [first.x, first.y], b: [p.x, p.y] });
      }
    } else if (tool === "centreArc" && first) {
      const second = this.placed[1];
      if (!second) {
        const r = Math.hypot(p.x - first.x, p.y - first.y);
        preview.push({ kind: "guide", a: [first.x, first.y], b: [p.x, p.y] }, { kind: "circle", c: [first.x, first.y], r });
      } else {
        const r = Math.hypot(second.x - first.x, second.y - first.y);
        const a0 = Math.atan2(second.y - first.y, second.x - first.x);
        let sweep = Math.atan2(p.y - first.y, p.x - first.x) - a0;
        while (sweep > Math.PI) sweep -= 2 * Math.PI;
        while (sweep <= -Math.PI) sweep += 2 * Math.PI;
        const [s0, s1] = sweep >= 0 ? [a0, a0 + sweep] : [a0 + sweep, a0];
        preview.push({ kind: "arc", c: [first.x, first.y], r, a0: s0, a1: s1 }, { kind: "guide", a: [first.x, first.y], b: [second.x, second.y] });
      }
    } else if (tool === "alignedRectangle" && first) {
      const second = this.placed[1];
      if (!second) preview.push({ kind: "line", a: [first.x, first.y], b: [p.x, p.y] });
      else {
        const A: [number, number] = [first.x, first.y];
        const B: [number, number] = [second.x, second.y];
        const l = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
        const w = alignedWidth(A, B, [p.x, p.y]);
        const n: [number, number] = [(-(B[1] - A[1]) / l) * w, ((B[0] - A[0]) / l) * w];
        const C: [number, number] = [B[0] + n[0], B[1] + n[1]];
        const D: [number, number] = [A[0] + n[0], A[1] + n[1]];
        preview.push({ kind: "line", a: A, b: B }, { kind: "line", a: B, b: C }, { kind: "line", a: C, b: D }, { kind: "line", a: D, b: A });
      }
    } else if (tool === "slot" && first) {
      if (this.placed.length === 1) preview.push({ kind: "line", a: [first.x, first.y], b: [p.x, p.y] });
      else preview.push(...slotPreview(first, this.placed[1], slotRadius(first, this.placed[1], p)));
    } else if (tool === "polygon" && first) {
      const n = Math.max(3, Math.min(64, Math.round(this.state.sketch?.polygonSides ?? 6)));
      const across = this.state.sketch?.polygonAcross ?? "corners";
      const corners = polygonCorners([first.x, first.y], [p.x, p.y], n, across);
      for (let i = 0; i < n; i++) preview.push({ kind: "line", a: corners[i], b: corners[(i + 1) % n] });
      const r = Math.hypot(p.x - first.x, p.y - first.y);
      if (r > 1e-9) preview.push({ kind: "guide", a: [first.x, first.y], b: [p.x, p.y] });
    } else if (tool === "conic" && first) {
      const second = this.placed[1];
      if (!second) preview.push({ kind: "line", a: [first.x, first.y], b: [p.x, p.y] });
      else {
        const a: [number, number] = [first.x, first.y];
        const b: [number, number] = [second.x, second.y];
        const m: [number, number] = [p.x, p.y];
        const pts = splinePolyline([a, m, b], false, 16, this.state.sketch?.conicRho ?? 0.5);
        for (let i = 0; i + 1 < pts.length; i++) preview.push({ kind: "line", a: pts[i], b: pts[i + 1] });
        preview.push({ kind: "guide", a, b: m }, { kind: "guide", a: m, b });
      }
    } else if (tool === "ellipse" && first) {
      const c: [number, number] = [first.x, first.y];
      const second = this.placed[1];
      if (!second) {
        const r = Math.hypot(p.x - first.x, p.y - first.y);
        preview.push({ kind: "line", a: c, b: [p.x, p.y] }, { kind: "circle", c, r });
      } else {
        const m: [number, number] = [second.x, second.y];
        const pts = ellipsePolyline(ellipseFrom(c, m, minorPointFor(c, m, [p.x, p.y])));
        for (let i = 0; i + 1 < pts.length; i++) preview.push({ kind: "line", a: pts[i], b: pts[i + 1] });
        preview.push({ kind: "guide", a: c, b: m });
      }
    } else if (tool === "circle" && first) {
      preview.push({ kind: "circle", c: [first.x, first.y], r: Math.hypot(p.x - first.x, p.y - first.y) });
    } else if (tool === "arc" && first) {
      if (this.placed.length === 1) {
        preview.push({ kind: "line", a: [first.x, first.y], b: [p.x, p.y] });
      } else {
        const second = this.placed[1];
        const centre = circleThrough([first.x, first.y], [p.x, p.y], [second.x, second.y]);
        if (centre) {
          const r = Math.hypot(first.x - centre[0], first.y - centre[1]);
          const cross = (second.x - first.x) * (p.y - first.y) - (second.y - first.y) * (p.x - first.x);
          const [from, to] = cross < 0 ? [first, second] : [second, first];
          preview.push({
            kind: "arc",
            c: centre,
            r,
            a0: Math.atan2(from.y - centre[1], from.x - centre[0]),
            a1: Math.atan2(to.y - centre[1], to.x - centre[0]),
          });
        } else preview.push({ kind: "line", a: [first.x, first.y], b: [second.x, second.y] });
      }
    }
    if (tool === "ellipticalArc" && first) preview.push(...ellipticalArcPreview(this.placed, [p.x, p.y]));
    preview.push(...this.refOutline(snapped.hover));
    this.emit({ hover: snapped.hover?.kind === "curve" ? snapped.hover : null, preview, snap, inference, hints: snapped.hints, nearby: this.nearbyPoints(e) });
  }

  /**
   * While drawing a line: the tangent line to offer, when the line started on
   * a circle or arc and the pointer is near where it would touch another (or
   * from any start, near where it would touch a circle). Not when the pointer
   * has snapped onto a point.
   */
  private tangentFor(first: Placed, p: Placed, e: SketchPointer): TangentLine | null {
    const sn = p.snap?.kind;
    if (sn === "point" || sn === "origin" || sn === "midpoint" || (p.snap?.kind === "ref" && p.snap.at !== "on")) return null;
    return tangentLineAt(this.data!, first, e.x, e.y, TANGENT_PX * pickMm(e), this.refs, this.skipRef);
  }

  /** Remember a line the pointer passed over while drawing (most recent first). */
  private wake(id: string): void {
    if (this.woken[0] !== id) this.woken = [id, ...this.woken.filter((x) => x !== id)].slice(0, WOKEN_MAX);
  }

  /** The sketch point a line being drawn starts from (null for a fresh point or the origin). */
  private startPointId(start: Placed | undefined): string | null {
    return start?.snap?.kind === "point" && start.snap.id !== ORIGIN_ID ? start.snap.id : null;
  }

  /**
   * Onshape's line → tangent arc gesture: with a chain going, bringing the pointer back onto its last end and
   * away again switches to an arc carrying on smoothly from it (and the same again switches back).
   */
  private followReturn(e: SketchPointer): void {
    const start = this.placed[0];
    const id = this.startPointId(start);
    if (!start || !id || e.shift) return;
    const away = Math.hypot(e.x - start.x, e.y - start.y);
    const tol = POINT_PX * pickMm(e);
    if (away > 2 * tol) {
      if (this.returning === "back") {
        // An arc only when leaving onwards (the way the chain was heading): sweeping back past the end to draw a
        // sharp V is just passing by, and would loop the arc round.
        const t = tangentAt(this.data!, id);
        const onwards = !!t && t.dir[0] * (e.x - start.x) + t.dir[1] * (e.y - start.y) > 0;
        if (t && (this.arcMode || onwards)) this.setArcMode(!this.arcMode);
      }
      this.returning = "away";
    } else if (away <= tol && this.returning === "away") this.returning = "back";
  }

  private setArcMode(on: boolean): void {
    this.arcMode = on;
    this.state.setSketchMessage(on ? "Drawing an arc that carries on smoothly — click where it ends (Shift+A for a line again)." : null, "info");
  }

  /**
   * Shift+A while drawing a line chain: switch to an arc carrying on smoothly from the last end, or back to
   * lines. False when the Line tool isn't in use (the key then does nothing here).
   */
  toggleLineArc(): boolean {
    const d = this.data;
    if (!d || this.tool !== "line") return false;
    const id = this.startPointId(this.placed[0]);
    if (!id || !tangentAt(d, id)) {
      this.state.setSketchMessage("Draw a line first: Shift+A then carries on from its end with an arc.", "info");
      return true;
    }
    this.setArcMode(!this.arcMode);
    this.returning = "fresh";
    if (this.lastEvent) this.pointerMove(this.lastEvent, false);
    return true;
  }

  /** The line tool in arc mode: an arc carrying on smoothly from the chain's last end, then back to lines. */
  private lineArcClick(start: Placed, p: Placed): void {
    const d = this.data!;
    const startId = this.startPointId(start);
    if (!startId) return;
    const r = addTangentArc(d, startId, p, this.state.sketch?.construction ?? false);
    if (!this.commit(r, [r.arcId])) return;
    const arc = r.sketch.curves.find((c) => c.id === r.arcId);
    const endId = arc?.type === "arc" ? (arc.start === startId ? arc.end : arc.start) : null;
    const closed = p.snap?.kind === "point" || p.snap?.kind === "origin";
    this.arcMode = false;
    this.returning = "fresh";
    this.placed = endId && !closed ? [{ ...p, snap: { kind: "point", id: endId } }] : [];
    this.emit({ preview: [], inference: null });
  }

  /**
   * Where a line from `start` towards `p` ends, and what's inferred (as Onshape): horizontal or vertical when
   * nearly so — also when the end lines up with a point passed over (whichever the lining up doesn't give
   * already) —, else parallel or perpendicular to a woken-up line, or (from an arc's end, `fromArc`) tangent
   * or square to the arc. Shift: nothing. Snapped onto a point or curve: just that.
   */
  private linePlan(start: Placed, p: Placed, e: SketchPointer, fromArc = true): LinePlan {
    const none: LinePlan = { end: p, orientation: null, relation: null, badge: null };
    if (e.shift) return none;
    const sn = p.snap;
    const inf = inferOrientation(start.x, start.y, p.x, p.y, RELATION_DEGREES);
    const badgeOf = (o: "horizontal" | "vertical") => (o === "horizontal" ? "H" : "V");
    if (sn?.kind === "align") {
      const startId = this.startPointId(start);
      if (inf.orientation === "horizontal" && !sn.y && sn.x !== startId) return { end: { x: p.x, y: start.y, snap: sn }, orientation: "horizontal", relation: null, badge: "H" };
      if (inf.orientation === "vertical" && !sn.x && sn.y !== startId) return { end: { x: start.x, y: p.y, snap: sn }, orientation: "vertical", relation: null, badge: "V" };
      return none;
    }
    if (sn) return none;
    if (inf.orientation) return { end: { x: inf.x, y: inf.y, snap: null }, orientation: inf.orientation, relation: null, badge: badgeOf(inf.orientation) };
    const rel = this.lineRelation(start, p, fromArc);
    return rel ? { end: rel.end, orientation: null, relation: rel.relation, badge: rel.badge } : none;
  }

  /** A relation for a line from `start` towards `p`: the nearest direction (within RELATION_DEGREES) of the woken lines and the arc it starts on. */
  private lineRelation(start: Placed, p: Placed, fromArc: boolean): { end: Placed; relation: LineRelation; badge: string } | null {
    const d = this.data!;
    const v: [number, number] = [p.x - start.x, p.y - start.y];
    const len = Math.hypot(v[0], v[1]);
    if (len < 1e-9) return null;
    const startId = this.startPointId(start);
    const limit = (RELATION_DEGREES * Math.PI) / 180;
    let best: { u: [number, number]; relation: LineRelation; badge: string; off: number } | null = null;
    const offer = (u: [number, number], relation: LineRelation, badge: string) => {
      const n = Math.hypot(u[0], u[1]);
      if (n < 1e-12) return;
      const w: [number, number] = [u[0] / n, u[1] / n];
      const off = Math.acos(Math.min(1, Math.abs(v[0] * w[0] + v[1] * w[1]) / len));
      if (off < limit && (!best || off < best.off)) best = { u: w, relation, badge, off };
    };
    if (fromArc && startId) {
      for (const c of d.curves) {
        if (c.type !== "arc" || (c.start !== startId && c.end !== startId)) continue;
        const [cx, cy] = pointPos(d, c.center);
        const r: [number, number] = [start.x - cx, start.y - cy];
        offer([-r[1], r[0]], { type: "tangent", ref: c.id }, "T");
        offer(r, { type: "normal", ref: c.id }, "N");
      }
    }
    for (const id of this.woken) {
      const c = curveById(d, id);
      if (c?.type !== "line") continue;
      const [a, b] = [pointPos(d, c.p1), pointPos(d, c.p2)];
      const u: [number, number] = [b[0] - a[0], b[1] - a[1]];
      // (Parallel through a point the line already passes through would lie on top of it.)
      if (c.p1 !== startId && c.p2 !== startId) offer(u, { type: "parallel", ref: c.id }, "∥");
      offer([-u[1], u[0]], { type: "perpendicular", ref: c.id }, "⊥");
    }
    const found = best as { u: [number, number]; relation: LineRelation; badge: string; off: number } | null;
    if (!found) return null;
    const t = v[0] * found.u[0] + v[1] * found.u[1];
    return { end: { x: start.x + t * found.u[0], y: start.y + t * found.u[1], snap: null }, relation: found.relation, badge: found.badge };
  }

  pointerUp(): void {
    if (this.gizmoDrag) return this.gizmoUp();
    if (this.trimStroke) return this.trimUp();
    const press = this.press;
    this.press = null;
    if (press && this.tool !== "select") {
      // Pressed, dragged and let go (the mouse): where it's let go is the next click, as in Onshape — a line
      // dragged out is one line (no chain after it).
      const at = this.lastEvent;
      const tool = this.tool;
      if (at && this.placed.length && Math.hypot(at.x - press.x, at.y - press.y) > RELEASE_PX * pickMm(press)) {
        this.pointerDown(at);
        this.press = null;
        if (tool === "line" && !this.arcMode) {
          this.placed = [];
          this.emit({ preview: [], inference: null });
        }
      }
      return;
    }
    if (this.tool !== "select" || !this.drag) return;
    const drag = this.drag;
    this.drag = null;
    if (drag.moved && drag.kind === "none") {
      this.emit({ preview: [] });
      const d = this.data;
      if (!d || !drag.box) return;
      const found = sketchItemsInBox(d, rectOf(drag.startX, drag.startY, drag.box.x, drag.box.y), drag.box.crossing).filter((id) => !this.hidden.has(id));
      const sel = this.state.sketch?.selection ?? [];
      const next = drag.additive ? [...new Set([...sel, ...found])] : found;
      this.state.setSketchSelection(next);
      this.dropUnusedPlaneLines(next);
      return;
    }
    if (drag.moved) {
      if (drag.kind === "point" && drag.snapTo) {
        const r = attachPoint(this.data ?? drag.start, drag.id, drag.snapTo);
        if (r.error) this.state.setSketchMessage(r.error, "error");
        else this.state.updateSketch(r.sketch, { record: false });
        this.emit({ snap: null, hints: [] });
      }
      this.state.recordSketchStep(drag.start);
      return;
    }
    // A click without dragging: select (a click on a handle leaves the selection as it is).
    if (drag.kind === "handle") return;
    const sel = this.state.sketch?.selection ?? [];
    if (!drag.hit) {
      if (!drag.additive) {
        this.state.setSketchSelection([]);
        this.dropUnusedPlaneLines([]);
      }
      return;
    }
    // A part edge of the face: bring it in (as a reference) and select that. (A plane's line comes in without an undo
    // step of its own, and goes again once it's neither picked nor used.)
    const id = this.realId(drag.hit.id, !this.isPlaneRefId(drag.hit.id));
    if (!id) return;
    const next = drag.additive ? (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]) : sel.length === 1 && sel[0] === id ? [] : [id];
    this.state.setSketchSelection(next);
    this.dropUnusedPlaneLines(next);
  }

  /** Trim let go: a click trims the piece under it (as before), a drag trims every piece the path crossed — one undo step. */
  private trimUp(): void {
    const st = this.trimStroke!;
    this.trimStroke = null;
    const d = this.data;
    this.emit({ preview: [], hover: null });
    if (!d) return;
    const [x, y] = st.path[0];
    const clickTrim = (): boolean => {
      const hit = hitTest(d, x, y, POINT_PX * st.mm, CURVE_PX * st.mm, { ignore: this.notHidden() });
      if (hit?.kind !== "curve") return false;
      this.commit(trimAt(d, hit.id, { x, y }), []);
      return true;
    };
    if (!st.moved) {
      if (!clickTrim()) this.state.setSketchMessage("Click the part of a line, arc, circle, spline or ellipse you want to cut away — or drag across several.", "info");
      return;
    }
    const r = trimAlong(d, st.path, this.hidden);
    // A press on a curve that wobbled a little without crossing anything is still a click there.
    if (!r.trimmed && clickTrim()) return;
    if (this.commit(r, [])) this.state.setSketchMessage(`Trimmed ${r.trimmed === 1 ? "1 piece" : `${r.trimmed} pieces`}.`, "info");
  }

  /**
   * Round and Chamfer: a click on a corner point does it there; a click on a line (or arc, for Round), then
   * another, does it between the two — they're trimmed or carried on to meet it. Done again with the same
   * size while the tool stays on, the new one is kept Equal to the first (Onshape's), so one dimension sizes them all.
   */
  private cornerClick(e: SketchPointer, tool: "sketchFillet" | "sketchChamfer"): void {
    const d = this.data!;
    const hit = this.hitAt(e);
    const round = tool === "sketchFillet";
    const opts = useEditToolOptions.getState();
    const size = round ? this.state.sketch?.filletRadius ?? "2" : `${opts.chamferMode}:${opts.chamferDistance}`;
    const last = this.lastEdge?.tool === tool && this.lastEdge.size === size && d.curves.some((c) => c.id === this.lastEdge!.id) ? this.lastEdge.id : undefined;
    const chamfer = { mode: opts.chamferMode, distance: opts.chamferDistance, distance2: opts.chamferDistance2, angle: opts.chamferAngle, equalTo: last };
    const done = (r: { sketch: SketchData; error?: string }, keep: string, select: string) => {
      this.firstCurve = null;
      this.emit({ pending: [] });
      if (this.commit(r, select ? [select] : [])) this.lastEdge = { tool, size, id: keep };
    };
    if (hit?.kind === "point" && hit.id !== ORIGIN_ID && !this.firstCurve) {
      if (round) {
        const r = filletCorner(d, hit.id, size, last);
        return done(r, r.arcId, r.arcId);
      }
      const r = chamferCorner(d, hit.id, chamfer);
      return done(r, r.sizeLineId, r.lineId);
    }
    const curve = hit?.kind === "curve" ? curveById(d, hit.id) : undefined;
    if (!curve || !(curve.type === "line" || (round && curve.type === "arc"))) {
      this.state.setSketchMessage(
        round ? "Click a corner where two lines or arcs meet, or two lines or arcs to round between." : "Click a corner where two lines meet, or two lines to chamfer between.",
        "info",
      );
      return;
    }
    const first = this.firstCurve;
    if (!first || first.id === curve.id) {
      this.firstCurve = { id: curve.id, at: [e.x, e.y] };
      this.emit({ pending: [curve.id] });
      this.state.setSketchMessage(`Now click the other ${round ? "line or arc" : "line"} (on the part to keep). Esc to start again.`, "info");
      return;
    }
    if (round) {
      const r = filletBetween(d, first.id, first.at, curve.id, [e.x, e.y], size, last);
      return done(r, r.arcId, r.arcId);
    }
    const corner = cornerOfLines(d, first.id, first.at, curve.id, [e.x, e.y]);
    if (corner.error) return done(corner, "", "");
    const r = chamferCorner(corner.sketch, corner.pointId, chamfer, first.id);
    return done(r.error ? { sketch: d, error: r.error } : r, r.sizeLineId, r.lineId);
  }

  pointerLeave(): void {
    this.emit({ hover: null, snap: null, inference: null, hints: [], nearby: [] });
  }

  // ---------------------------------------------------------------------------
  // Fingers and the pen (SceneManager decides when; the mouse never comes here)

  private stroke: { placed: Placed[]; pending: string[] } | null = null;

  /** A finger started dragging (at `e`, when known): should the tool get the press (where it went down) now? */
  touchDragStarts(e?: SketchPointer): boolean {
    // Placing a copy: it follows the finger, and lifting puts it down.
    if (this.pasting) return false;
    // On one of Move / copy's handles: the drag is the handle's.
    if (this.tool === "sketchTransform" && e) {
      const d = this.data;
      const centre = d ? selectionCentre(d, this.state.sketch?.selection ?? []) : null;
      if (centre && gizmoPartAt({ centre, mmPerPx: e.mmPerPx }, e.x, e.y, e.reach ?? 1)) return true;
    }
    if (this.tool === "select" || this.tool === "trim") return true;
    return DRAG_DRAWN.has(this.tool) && this.placed.length === 0;
  }

  /** Is lifting a finger after a drag a click where it came up? (With Select it just ends the drag.) */
  touchLiftClicks(): boolean {
    if (this.pasting) return true;
    if (this.gizmoDrag) return false;
    return this.tool !== "select";
  }

  /** Remember how things are before a finger's drag reaches the tools, so a second finger can take it back. */
  beginStroke(): void {
    this.stroke = { placed: this.placed, pending: this.transient.pending };
  }

  endStroke(): void {
    this.stroke = null;
  }

  /**
   * A second finger came down mid-drag (to pan or zoom): put back how things were before the drag —
   * a dragged point goes back, a shape just started is dropped (no stray point), a box isn't drawn.
   */
  cancelStroke(): void {
    const s = this.stroke;
    this.stroke = null;
    this.dropGizmoDrag();
    this.press = null;
    if (this.drag?.moved && this.drag.kind !== "none") this.state.updateSketch(this.drag.start, { record: false });
    this.drag = null;
    this.trimStroke = null;
    if (s) this.placed = s.placed;
    this.emit({ preview: [], inference: null, snap: null, hints: [], hover: null, ...(s ? { pending: s.pending } : {}) });
  }

  /** A shape is half drawn, or a paste follows the pointer (the right-click menu offers Finish). */
  busy(): boolean {
    return this.placed.length > 0 || !!this.pasting;
  }

  /** Esc: abandon a half-drawn shape. Returns true if there was one. */
  cancel(): boolean {
    if (this.dropGizmoDrag()) return true;
    if (this.pasting) {
      this.pasting = null;
      this.emit({ preview: [] });
      this.state.setSketchMessage(null);
      return true;
    }
    // Esc finishes a spline that has enough points (rather than throwing it away).
    if (this.tool === "spline" && this.placed.length >= 2 && this.data) {
      const r = addSpline(this.data, this.placed, false, this.state.sketch?.construction ?? false);
      this.placed = [];
      this.emit({ preview: [] });
      this.commit(r, r.splineId ? [r.splineId] : []);
      return true;
    }
    const had = this.placed.length > 0 || this.transient.pending.length > 0 || this.drag !== null || this.firstCurve !== null || this.trimStroke !== null;
    this.firstCurve = null;
    this.trimStroke = null;
    if (this.drag?.moved) this.state.updateSketch(this.drag.start, { record: false });
    if (this.arcMode) this.setArcMode(false);
    this.press = null;
    this.placed = [];
    this.drag = null;
    this.emit({ preview: [], inference: null, pending: [], snap: null, hints: [] });
    return had;
  }

  // ---------------------------------------------------------------------------
  // Select tool: click to select, drag to move

  private selectDown(e: SketchPointer) {
    const d = this.data!;
    // A spline handle (shown on selected splines) takes priority over whatever is under it.
    const handle = this.handleAt(e);
    if (handle) {
      this.drag = { kind: "handle", id: handle.splineId, start: d, startX: e.x, startY: e.y, moved: false, additive: false, hit: null, handle };
      return;
    }
    const picked = this.selectHit(e);
    // Text (dragged by its point) or a picture under the pointer, when there's nothing else of the sketch there.
    const extra = picked && textById(d, picked.id) ? picked : picked && imageById(d, picked.id) ? picked : null;
    const hit = extra ? null : picked;
    let kind: DragState["kind"] = "none";
    if (extra) {
      const text = textById(d, extra.id);
      const now = Date.now();
      // A double-click on text: select it and put the cursor in the sketch panel's text box.
      if (text && this.lastTextClick?.id === text.id && now - this.lastTextClick.at < 450) {
        this.lastTextClick = null;
        this.state.setSketchSelection([text.id]);
        this.state.setSketchOptions({ textFocus: now });
        this.drag = null;
        return;
      }
      this.lastTextClick = text ? { id: text.id, at: now } : null;
      const picks = this.state.sketch?.selection ?? [];
      if (text && !(e.shift || e.ctrl) && picks.includes(text.id) && draggableCount(d, picks) >= 2) {
        this.drag = { kind: "group", id: text.id, ids: picks, start: d, startX: e.x, startY: e.y, moved: false, additive: false, hit: extra, startScreenX: e.screenX };
        return;
      }
      if (text) this.drag = { kind: text.anchor === ORIGIN_ID ? "none" : "point", id: text.anchor, start: d, startX: e.x, startY: e.y, moved: false, additive: e.shift || e.ctrl, hit: extra, startScreenX: e.screenX };
      else this.drag = { kind: "image", id: extra.id, start: d, startX: e.x, startY: e.y, moved: false, additive: e.shift || e.ctrl, hit: extra, startScreenX: e.screenX };
      return;
    }
    if (hit && isRefId(hit.id)) {
      // Part edges can't be dragged: a click selects (brings in) one, a drag draws a selection box.
    } else if (hit?.kind === "point" && hit.id !== ORIGIN_ID) {
      kind = "point";
      if (placedByOffset(d, hit.id))
        this.state.setSketchMessage("That point is on an offset copy, which follows its original: drag the original instead (or change the offset's distance).", "info");
    }
    else if (hit?.kind === "curve") {
      const c = curveById(d, hit.id)!;
      // Dragging a circle's or an arc's rim resizes it; drag its centre point to move it.
      kind = c.type === "circle" || c.type === "arc" ? "rim" : "curve";
    }
    // Pressing on one of several picked things drags them all together (Shift/Ctrl held: it only adds or takes away).
    const sel = this.state.sketch?.selection ?? [];
    if (kind !== "none" && hit && !(e.shift || e.ctrl) && sel.includes(hit.id) && draggableCount(d, sel) >= 2) {
      this.drag = { kind: "group", id: hit.id, ids: sel, start: d, startX: e.x, startY: e.y, moved: false, additive: false, hit, startScreenX: e.screenX };
      return;
    }
    this.drag = { kind, id: hit?.id ?? "", start: d, startX: e.x, startY: e.y, moved: false, additive: e.shift || e.ctrl, hit, startScreenX: e.screenX };
  }

  /**
   * What a click with the Select tool would pick: the sketch's own points and
   * curves (and the face's corners), then its text and pictures, then things
   * from other sketches and parts.
   */
  private selectHit(e: SketchPointer): Hit | null {
    const hit = this.pickAt(e);
    if (hit && !this.isOutsideRef(hit.id)) return hit;
    return this.extraAt(e) ?? hit;
  }

  /** A stand-in for something from another sketch or a part off the face (not the face's own edges). */
  private isOutsideRef(id: string): boolean {
    const r = isRefId(id) ? parseRefId(id) : null;
    return !!r && r.index >= this.faceEdgeCount;
  }

  /** When text was last clicked (for telling a double-click). */
  private lastTextClick: { id: string; at: number } | null = null;

  /** Text or a picture under the pointer (text first; a picture only where nothing else is). */
  private extraAt(e: SketchPointer): Hit | null {
    const d = this.data;
    if (!d) return null;
    const t = textAt(d, e.x, e.y, CURVE_PX * pickMm(e));
    if (t) return { kind: "curve", id: t };
    const m = imageAt(d, e.x, e.y);
    return m ? { kind: "curve", id: m } : null;
  }

  private selectDrag(e: SketchPointer) {
    const drag = this.drag!;
    if (!drag.moved && Math.hypot(e.x - drag.startX, e.y - drag.startY) < DRAG_PX * pickMm(e)) return;
    drag.moved = true;
    if (drag.kind === "none") {
      // From empty space: a selection box. Leftwards takes anything it touches.
      const crossing = e.screenX !== undefined && drag.startScreenX !== undefined ? e.screenX < drag.startScreenX : e.x < drag.startX;
      drag.box = { x: e.x, y: e.y, crossing };
      const a: [number, number] = [drag.startX, drag.startY];
      const b: [number, number] = [e.x, drag.startY];
      const c: [number, number] = [e.x, e.y];
      const dd: [number, number] = [drag.startX, e.y];
      const kind = crossing ? "guide" : "line";
      this.emit({ preview: [{ kind, a, b }, { kind, a: b, b: c }, { kind, a: c, b: dd }, { kind, a: dd, b: a }], hover: null });
      return;
    }
    let next = drag.start;
    if (drag.kind === "handle" && drag.handle) {
      // The handle end follows the pointer: the curve's direction and speed at that point (its tangent is three times the handle).
      const h = drag.handle;
      const [px, py] = pointPos(drag.start, h.pointId);
      const dx = e.x - px;
      const dy = e.y - py;
      // Dropped back onto the point: the handle is cleared and the curve runs naturally again.
      const reset = Math.hypot(dx, dy) < POINT_PX * pickMm(e);
      next = setSplineHandle(drag.start, h.splineId, h.pointId, reset ? null : [3 * dx * h.side, 3 * dy * h.side]);
      this.state.updateSketch(next, { record: false });
      return;
    }
    if (drag.kind === "point") {
      // Hovering close to another point snaps onto it (and joins them when let go).
      // A wider reach than a click, so an end point dropped near another joins onto it.
      // Also onto the middle of a line, or a corner, centre or middle of the face's edges.
      // Holding Shift drags it freely: nothing is snapped onto or joined when let go.
      const found = this.data ? snapAt(drag.start, e.x, e.y, { pointTol: SNAP_PX * pickMm(e), curveTol: 0, refs: this.refs, skip: this.skipRef, ignore: this.notHidden(pointsSharingCurve(drag.start, drag.id)), free: e.shift }) : null;
      const sn = found?.placed.snap;
      drag.snapTo = sn && (sn.kind === "point" || sn.kind === "origin" || sn.kind === "midpoint" || (sn.kind === "ref" && sn.at !== "on")) ? sn : null;
      const [x, y] = drag.snapTo ? [found!.placed.x, found!.placed.y] : [e.x, e.y];
      next = dragPoint(drag.start, drag.id, x, y);
      this.emit({ snap: drag.snapTo ? [x, y] : null, hints: drag.snapTo?.kind === "midpoint" ? [[x, y]] : [] });
    }
    else if (drag.kind === "curve") next = dragCurve(drag.start, drag.id, e.x - drag.startX, e.y - drag.startY);
    else if (drag.kind === "group") {
      next = dragSelection(drag.start, drag.ids ?? [], e.x - drag.startX, e.y - drag.startY);
      if (next === drag.start && !drag.heldSaid) {
        // Part of the selection is held: moving the rest would stretch the shapes, so nothing moves.
        drag.heldSaid = true;
        this.state.setSketchMessage("These can't move together: part of the selection is held where it is (a Fix, or a dimension or relation to something not picked). Pick only what's free to move.", "info");
      }
    }
    else if (drag.kind === "image") {
      const m = imageById(drag.start, drag.id);
      if (m) next = { ...drag.start, images: (drag.start.images ?? []).map((x) => (x.id === m.id ? { ...m, x: m.x + e.x - drag.startX, y: m.y + e.y - drag.startY } : x)) };
    }
    else {
      const c = curveById(drag.start, drag.id);
      if (c?.type === "circle") {
        const [cx, cy] = pointPos(drag.start, c.center);
        next = dragCircleRim(drag.start, c.id, Math.hypot(e.x - cx, e.y - cy));
      } else if (c?.type === "arc") {
        const [cx, cy] = pointPos(drag.start, c.center);
        next = dragArcRim(drag.start, c.id, Math.hypot(e.x - cx, e.y - cy));
      }
    }
    this.state.updateSketch(next, { record: false });
  }

  // ---------------------------------------------------------------------------
  // Dimension tool: pick one or two things, then click where the value goes

  /** While placing a dimension: where it would go, and whether it measures across, up or straight. */
  private dimensionPreview(e: SketchPointer): Pick<SketchTransient, "preview" | "inference"> {
    const d = this.data!;
    const base = dimensionFor(d, this.transient.pending);
    if (typeof base === "string") return { preview: [], inference: null };
    const offset = offsetFor(d, { id: "tmp", ...base }, [e.x, e.y]);
    const spec = dimensionSpecAt(d, this.transient.pending, offset);
    if (typeof spec === "string") return { preview: [], inference: null };
    const layout = dimensionLayout(d, { id: "tmp", ...spec, value: "0", labelOffset: offset });
    const preview: PreviewShape[] = (layout?.lines ?? []).map(([a, b]) => ({ kind: "guide", a, b }));
    const text = spec.type === "horizontalDistance" ? "Across" : spec.type === "verticalDistance" ? "Up" : null;
    // Say which kind it will be when that changes as the pointer moves.
    if (spec.type !== this.previewKind) {
      this.previewKind = spec.type;
      const what =
        spec.type === "horizontalDistance" ? "the distance across" : spec.type === "verticalDistance" ? "the distance up" : spec.type === "length" ? "the line's length" : spec.type === "distance" ? "the straight distance" : null;
      if (what) this.state.setSketchMessage(`Click to place ${what} — moving the value round picks across, up or straight.`, "info");
    }
    return { preview, inference: text ? { at: [e.x, e.y], text } : null };
  }

  private dimensionClick(e: SketchPointer) {
    this.previewKind = null;
    const picked = this.pickAt(e);
    const pending = this.transient.pending;
    // A part edge (or its corner) of the face: bring it in as a reference to measure from.
    const wanted = picked && pending.length < 2 ? this.realId(picked.id) : null;
    const hit = picked && wanted ? { ...picked, id: wanted } : picked && !isRefId(picked.id) ? picked : null;
    const d = this.data!;
    if (hit && pending.length < 2 && !pending.includes(hit.id)) {
      const next = [...pending, hit.id];
      // Only keep a second pick if it makes a valid pair; otherwise start again with it.
      const ok = next.length === 1 || typeof dimensionFor(d, next) !== "string";
      this.emit({ pending: ok ? next : [hit.id] });
      // A lone arc: say how to get its angle or length instead of its radius.
      const only = (ok ? next : [hit.id]).length === 1 ? curveById(d, hit.id) : undefined;
      this.state.setSketchMessage(
        only?.type === "arc"
          ? "Now click where the radius goes — or click the arc's centre for its angle, or one of its ends for its length."
          : "Now click where the dimension should go.",
        "info",
      );
      return;
    }
    if (pending.length === 0) {
      this.state.setSketchMessage("Click a line, circle or arc — or two things to measure between. Where you put the value picks across, up or straight.", "info");
      return;
    }
    const spec = dimensionFor(d, pending);
    if (typeof spec === "string") {
      this.state.setSketchMessage(spec, "error");
      this.emit({ pending: [] });
      return;
    }
    const offset = offsetFor(d, { id: "tmp", ...spec }, [e.x, e.y]);
    const r = addDimension(d, pending, offset);
    this.emit({ pending: [] });
    if (!this.commit(r)) return;
    if (r.driven) {
      this.state.setSketchMessage("That's already set by other constraints or dimensions, so this one just shows the size (in brackets) and won't change the sketch.", "info");
      return;
    }
    this.state.setEditingDimension(r.dimensionId);
  }
}

/** Faint copies of curves with every point moved by `move` (a rigid move: splines and ellipses are moved point by point). */
function curvesPreview(d: SketchData, sources: readonly SketchCurve[], move: (p: [number, number]) => [number, number], scale = 1): PreviewShape[] {
  const out: PreviewShape[] = [];
  const at = (id: string) => move(pointPos(d, id));
  for (const c of sources) {
    if (c.type === "line") out.push({ kind: "line", a: at(c.p1), b: at(c.p2) });
    else if (c.type === "circle") out.push({ kind: "circle", c: at(c.center), r: c.radius * scale });
    else if (c.type === "spline" || c.type === "ellipse") {
      const pts = (c.type === "spline" ? splinePath(d, c) : ellipsePoints(d, c)).map(move);
      for (let k = 0; k + 1 < pts.length; k++) out.push({ kind: "line", a: pts[k], b: pts[k + 1] });
    } else {
      const cc = at(c.center);
      const s0 = at(c.start);
      const s1 = at(c.end);
      out.push({ kind: "arc", c: cc, r: radiusOf(d, c) * scale, a0: Math.atan2(s0[1] - cc[1], s0[0] - cc[0]), a1: Math.atan2(s1[1] - cc[1], s1[0] - cc[0]) });
    }
  }
  return out;
}

/** The arc a tangent arc from `first` (a line's or arc's end) to `p` would make (a plain line where there's none). */
function tangentArcPreview(d: SketchData, first: Placed, p: Placed): PreviewShape[] {
  const startId = first.snap?.kind === "point" ? first.snap.id : null;
  const t = startId ? tangentAt(d, startId) : null;
  const centre = t ? tangentArcCentre([first.x, first.y], t.dir, [p.x, p.y]) : null;
  if (!t || !centre) return [{ kind: "line", a: [first.x, first.y], b: [p.x, p.y] }];
  const r = Math.hypot(first.x - centre[0], first.y - centre[1]);
  const left = t.dir[0] * (p.y - first.y) - t.dir[1] * (p.x - first.x) > 0;
  const [from, to] = left ? [[first.x, first.y], [p.x, p.y]] : [[p.x, p.y], [first.x, first.y]];
  return [{ kind: "arc", c: centre, r, a0: Math.atan2(from[1] - centre[1], from[0] - centre[0]), a1: Math.atan2(to[1] - centre[1], to[0] - centre[0]) }];
}

/** Half the slot's width: how far the third click is from the line through the two centres. */
/** The elliptical arc tool's preview: the long axis, then the whole ellipse through the start, then the arc. */
function ellipticalArcPreview(placed: Placed[], p: [number, number]): PreviewShape[] {
  const [c, m, st] = placed;
  const C: [number, number] = [c.x, c.y];
  if (!m) return [{ kind: "line", a: C, b: p }, { kind: "circle", c: C, r: Math.hypot(p[0] - C[0], p[1] - C[1]) }];
  const M: [number, number] = [m.x, m.y];
  const shape = ellipticalArcShape(C, M, st ? [st.x, st.y] : p, st ? p : null);
  if (!shape) return [{ kind: "guide", a: C, b: M }];
  const out: PreviewShape[] = [{ kind: "guide", a: C, b: M }];
  if (!st) {
    const pts = ellipsePolyline(shape.g);
    for (let i = 0; i + 1 < pts.length; i++) out.push({ kind: "guide", a: pts[i], b: pts[i + 1] });
    return out;
  }
  const pts = ellipticalArcPath(shape);
  for (let i = 0; i + 1 < pts.length; i++) out.push({ kind: "line", a: pts[i], b: pts[i + 1] });
  return out;
}

function slotRadius(a: { x: number; y: number }, b: { x: number; y: number }, p: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  return Math.abs(dx * (p.y - a.y) - dy * (p.x - a.x)) / (Math.hypot(dx, dy) || 1);
}

function slotPreview(a: { x: number; y: number }, b: { x: number; y: number }, r: number): PreviewShape[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  const nx = (-dy / L) * r, ny = (dx / L) * r;
  const ang = Math.atan2(ny, nx);
  return [
    { kind: "line", a: [a.x + nx, a.y + ny], b: [b.x + nx, b.y + ny] },
    { kind: "line", a: [a.x - nx, a.y - ny], b: [b.x - nx, b.y - ny] },
    { kind: "arc", c: [a.x, a.y], r, a0: ang, a1: ang + Math.PI },
    { kind: "arc", c: [b.x, b.y], r, a0: ang + Math.PI, a1: ang },
  ];
}
