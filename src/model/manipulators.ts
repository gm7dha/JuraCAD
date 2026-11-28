/**
 * Onshape's in-view manipulators for feature dialogs (pure: no three.js, no DOM): while an Extrude, Revolve, Draft, Hole, Move face, Offset or Extend surface,
 * Fillet, Chamfer, Shell or Thicken dialog is open, an arrow (or, for a revolve, an arrow round an arc) sits in the
 * 3D view where the size it changes shows, and dragging it changes that size live, exactly like typing in its box.
 *
 * This file says which handles a draft shows and where (`manipulatorsFor`), and what a dragged value does to the
 * draft (`manipPatch`). Dragging maths (pointer ray → value, hit tests) is in viewport/manipulatorDrag.ts.
 */
import { resolveParams } from "./features";
import { evaluate } from "./expr";
import { radiusPointAt, radiusPointPick } from "./variableFillet";
import { add, cross, dot, length, scale, sub, unit, type Vec3 } from "./transformMath";
import type { Feature, FeatureType } from "./types";
import { formatLength, showLength, startingLength, storeLength } from "./units";
import { chosenRegions } from "../sketch/areas";
import { axisInSketch } from "../sketch/axis";
import { curvePoints } from "../sketch/ops";
import { planeFrame, toWorld, type SketchPlane } from "../sketch/planes";
import type { SketchData } from "../sketch/types";
import { holePositionsIn } from "../sketch/holePositions";
import { strictMatch, type EdgeRef, type FaceRef, type TopoPick } from "../geometry/topoRef";
import { moveFaceAxisNow, turnPoint } from "./moveFace";
import { pieceOfPicks } from "./movePiece";

export interface Manipulator {
  /** Which handle (unique within the draft): "depth", "depthBack", "depth2", "angle", "radius"… */
  id: string;
  /** The box it changes. */
  key: string;
  /** "arrow": slides along `dir`; "arc": turns round `axis`. */
  kind: "arrow" | "arc";
  /** Arrow: where the value is 0. Arc: the profile's point at 0°. */
  origin: Vec3;
  /** Arrow: the way a bigger value moves the handle (unit). */
  dir: Vec3;
  /** Arc: the line it turns round (unit direction, the way bigger angles turn, right-handed). */
  axis?: { through: Vec3; dir: Vec3 };
  /** The value now (mm or degrees). */
  value: number;
  /** The handle sits at value × scale along `dir` (or degrees round the axis). */
  scale: number;
  /** Degrees (snaps to 1°), not a length. */
  angle: boolean;
  /** Dragged past zero, the size stays positive and the feature turns the other way (an Extrude's blind end). */
  flips: boolean;
  /** The most it may be (a revolve's 360°). */
  max: number;
  /** Shown but not draggable: why (the box holds a variable or a sum). */
  locked?: string;
  /** The value may go below zero (a Draft's angle, Move face's distance): dragged past zero it carries on, minus. */
  signed?: boolean;
  /** Nothing to type in the view (an Extrude's "Up to…" end: it has no size). */
  noEdit?: boolean;
  /**
   * A still click on it goes through to what's under it (an Extrude's / Revolve's: the areas round the profile).
   * Others keep their clicks: they sit on the face or edge the dialog has picked.
   */
  passesClicks?: boolean;
  /** What the label by the handle and its tooltip say. */
  text: string;
  tip: string;
}

/** The feature types that show manipulators. */
export const MANIPULATED: ReadonlySet<FeatureType> = new Set<FeatureType>(["extrude", "revolve", "fillet", "chamfer", "shell", "thicken", "draft", "hole", "moveFace", "offsetSurface", "extendSurface"]);

export function hasManipulators(type: FeatureType): boolean {
  return MANIPULATED.has(type);
}

/** What manipulatorsFor needs besides the draft. */
export interface ManipContext {
  /** The draft's sketch (`sketchRef`, or a Hole's `hole.sketchRef`) as built now (a face sketch where its face is), if it has one. */
  sketch: { plane: SketchPlane | null; data: SketchData } | null;
  /** The Part Studio's parts as built now (faces, to see which way an edge's corner faces). */
  parts: readonly MeshFaces[];
}

/** A part as the view has it: its faces, and (when shown) its mesh — one corner of a face tells which way it faces there. */
export interface MeshFaces {
  id: string;
  faceRefs?: readonly FaceRef[];
  vertices?: ArrayLike<number>;
  normals?: ArrayLike<number>;
  triangles?: ArrayLike<number>;
  faceGroups?: readonly { start: number; count: number }[];
}

/** Is a box's text a plain number (with a unit, perhaps), not a variable or a sum? Empty = the default, plain. */
export function isPlainNumber(text: string | undefined): boolean {
  if (text === undefined || text.trim() === "") return true;
  return /^\s*[+]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*(mm|cm|m|in|inch|inches|"|deg|°)?\s*$/i.test(text);
}

const LOCKED = "This size uses a variable or a sum: double-click the arrow, or type in its box, to change it.";

/** Where a sketch's shapes are, in the middle (sketch coordinates): the middle of the picked areas' (or all closed shapes') box. */
const middles = new WeakMap<SketchData, Map<string, [number, number] | null>>();
export function profileMiddle(data: SketchData, areas: Feature["areas"]): [number, number] | null {
  let byAreas = middles.get(data);
  if (!byAreas) middles.set(data, (byAreas = new Map()));
  const key = JSON.stringify(areas ?? null);
  if (byAreas.has(key)) return byAreas.get(key)!;
  let out: [number, number] | null = null;
  try {
    const { regions } = chosenRegions(data, areas, "extrude");
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of regions)
      for (const [x, y] of r.outer.polygon) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    if (Number.isFinite(x0)) out = [(x0 + x1) / 2, (y0 + y1) / 2];
  } catch {
    out = null;
  }
  // No closed shapes (an open profile made thin or into a surface): the middle of the drawn curves' points.
  if (!out) {
    const used = new Set(data.curves.filter((c) => !c.construction).flatMap((c) => curvePoints(c)));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of data.points)
      if (used.has(p.id)) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
    if (Number.isFinite(x0)) out = [(x0 + x1) / 2, (y0 + y1) / 2];
  }
  byAreas.set(key, out);
  return out;
}

/** `p` turned by `degrees` round the line through `o` along unit `d` (right-handed). */
export function turnAbout(p: Vec3, o: Vec3, d: Vec3, degrees: number): Vec3 {
  const a = (degrees * Math.PI) / 180;
  const v = sub(p, o);
  const c = Math.cos(a);
  const s = Math.sin(a);
  const along = scale(d, dot(d, v) * (1 - c));
  return add(o, add(add(scale(v, c), scale(cross(d, v), s)), along));
}

/** Where the handle is drawn (the arrow's foot). */
export function manipPoint(m: Manipulator): Vec3 {
  if (m.kind === "arc" && m.axis) return turnAbout(m.origin, m.axis.through, m.axis.dir, m.value * m.scale);
  return add(m.origin, scale(m.dir, m.value * m.scale));
}

/** Which way the arrow points at its foot (unit): along `dir`, or round the arc. */
export function manipArrowDir(m: Manipulator): Vec3 {
  if (m.kind !== "arc" || !m.axis) return m.dir;
  const p = manipPoint(m);
  const rel = sub(p, m.axis.through);
  const radial = sub(rel, scale(m.axis.dir, dot(rel, m.axis.dir)));
  return unit(cross(m.axis.dir, radial)) ?? m.dir;
}

/** The arc's points from 0° to the handle (world), for drawing its guide; [] for an arrow. */
export function arcPoints(m: Manipulator, count = 48): Vec3[] {
  if (m.kind !== "arc" || !m.axis) return [];
  const end = m.value * m.scale;
  const n = Math.max(2, Math.ceil((count * Math.abs(end)) / 360) + 1);
  return Array.from({ length: n }, (_, i) => turnAbout(m.origin, m.axis!.through, m.axis!.dir, (end * i) / (n - 1)));
}

function valueText(label: string, value: number, angle: boolean): string {
  return `${label} ${angle ? `${Math.round(value * 100) / 100}°` : formatLength(value)}`;
}

interface Base {
  key: string;
  label: string;
  values: Record<string, number>;
  params: Record<string, string>;
}

function make(b: Base, m: Omit<Manipulator, "key" | "value" | "text" | "tip" | "locked"> & { tip: string }): Manipulator {
  const value = b.values[b.key] ?? 0;
  const typed = b.params[b.key];
  // (A size that may be minus is plain with a minus sign too.)
  const plain = isPlainNumber(typed) || (!!m.signed && isPlainNumber(typed?.replace(/^\s*-/, "")));
  const locked = plain ? undefined : LOCKED;
  return { ...m, key: b.key, value, text: valueText(b.label, value, m.angle), tip: locked ?? m.tip, ...(locked ? { locked } : {}) };
}

/** Faces of a part lying along a straight edge (their plane holds it), nearest first: up to two. */
function facesAlong(edge: EdgeRef, faces: readonly FaceRef[]): FaceRef[] {
  const t = unit(sub(edge.b, edge.a));
  if (!t || edge.curve !== "LINE") return [];
  const size = length(sub(edge.b, edge.a));
  const tol = Math.max(1e-3, size * 1e-4);
  return faces
    .filter((f) => f.surface === "PLANE" && Math.abs(dot(f.normal, t)) < 1e-3 && Math.abs(dot(sub(edge.mid, f.center), f.normal)) < tol)
    .sort((a, b) => length(sub(a.center, edge.mid)) - length(sub(b.center, edge.mid)))
    .slice(0, 2);
}

/**
 * Where an edge's corner is and how a fillet / chamfer sits there: `into` = from the corner into the material
 * (between its two faces), `fillet`/`chamfer` = how far along it the rounded / cut face's middle is per mm of size.
 * Worked out once per pick (so a drag that rebuilds the part never moves its handle about).
 */
const corners = new WeakMap<TopoPick, { into: Vec3; fillet: number; chamfer: number } | null>();
export function edgeCorner(pick: TopoPick, faces: readonly FaceRef[], mesh?: MeshFaces): { into: Vec3; fillet: number; chamfer: number } | null {
  if (corners.has(pick)) return corners.get(pick)!;
  const edge = pick.ref as EdgeRef;
  let out: { into: Vec3; fillet: number; chamfer: number } | null = null;
  const two = facesAlong(edge, faces);
  if (two.length === 2) {
    // An inside corner (a wall standing on a base): each face reaches out in front of the other, and a fillet or
    // chamfer fills the corner, so its face's middle is out in the open, along the faces' normals.
    const inside = dot(sub(two[0].center, edge.mid), two[1].normal) > 1e-9 || dot(sub(two[1].center, edge.mid), two[0].normal) > 1e-9;
    const into = unit(scale(add(two[0].normal, two[1].normal), inside ? 1 : -1));
    // α: the angle between the faces' normals (90° for a box's edge).
    const cosA = Math.max(-1, Math.min(1, dot(two[0].normal, two[1].normal)));
    const half = Math.acos(cosA) / 2;
    if (into && half > 0.05) out = { into, fillet: Math.max(0.25, 1 / Math.cos(half) - 1), chamfer: Math.max(0.25, Math.sin(half)) };
  }
  if (!out && edge.curve !== "LINE") out = roundCorner(edge, faces, mesh);
  if (!out && faces.length) {
    // An edge we can't place exactly: point at the part's middle.
    const centre = scale(faces.reduce<Vec3>((s, f) => add(s, f.center), [0, 0, 0]), 1 / faces.length);
    let into = sub(centre, edge.mid);
    const t = unit(sub(edge.b, edge.a));
    if (t && edge.curve === "LINE") into = sub(into, scale(t, dot(into, t)));
    const u = unit(into);
    if (u) out = { into: u, fillet: 0.5, chamfer: 0.5 };
  }
  // (Not kept when the part isn't built yet: it's worked out again once it is.)
  if (out || faces.length) corners.set(pick, out);
  return out;
}

/**
 * A round edge where a flat face meets a round one (a hole's rim, a pin's top): in between the flat face's inside and
 * the way into the material across the round face — away from its axis for a hole (the part's middle is further out
 * than the rim), towards it for a pin. A square corner, so the rounded / cut face's middle is as on a box's edge.
 */
function roundCorner(edge: EdgeRef, faces: readonly FaceRef[], mesh?: MeshFaces): { into: Vec3; fillet: number; chamfer: number } | null {
  const flat = faces.find((f) => f.surface === "PLANE" && Math.abs(dot(sub(edge.mid, f.center), f.normal)) < 1e-3);
  const n = flat ? unit(flat.normal) : null;
  if (!flat || !n) return null;
  const across = (p: Vec3, c: Vec3) => {
    const w = sub(p, c);
    return sub(w, scale(n, dot(w, n)));
  };
  const round = faces
    .map((f, i) => ({ f, i, d: length(sub(f.center, edge.mid)) }))
    .filter(({ f }) => f.surface !== "PLANE")
    .sort((a, b) => a.d - b.d)[0];
  if (!round) return null;
  const roundAt = meshCorner(mesh, round.i);
  const roundFace = round.f;
  const toAxis = unit(across(roundFace.center, edge.mid));
  if (!toAxis) return null;
  let hole: boolean;
  if (roundAt) {
    // A hole's wall faces its axis; a pin's faces away from it.
    hole = dot(roundAt.n, across(roundAt.p, roundFace.center)) < 0;
  } else {
    const middle = scale(faces.reduce<Vec3>((sum, f) => add(sum, f.center), [0, 0, 0]), 1 / faces.length);
    hole = length(across(middle, roundFace.center)) > length(across(edge.mid, roundFace.center));
  }
  const into = unit(add(scale(n, -1), scale(toAxis, hole ? -1 : 1)));
  return into ? { into, fillet: Math.SQRT2 - 1, chamfer: Math.SQRT1_2 } : null;
}

/** One corner of face `i` in the part's mesh, and which way the face faces there (null: no mesh). */
function meshCorner(mesh: MeshFaces | undefined, i: number): { p: Vec3; n: Vec3 } | null {
  const g = mesh?.faceGroups?.[i];
  if (!mesh || !g || !g.count || !mesh.vertices || !mesh.normals || !mesh.triangles) return null;
  // (`start` is already an index into `triangles`, as connectors.ts reads it.)
  const v = mesh.triangles[g.start];
  if (v === undefined) return null;
  const at = (a: ArrayLike<number>): Vec3 => [a[3 * v], a[3 * v + 1], a[3 * v + 2]];
  const n = unit(at(mesh.normals));
  return n ? { p: at(mesh.vertices), n } : null;
}

/** Variable fillet: an arrow at each radius point that can be placed (straight edges, and any edge's ends). Keys "vf:<index>". */
function radiusPointHandles(draft: Feature, facesOf: (partId: string) => readonly FaceRef[], partOf: (partId: string) => MeshFaces | undefined): Manipulator[] {
  const out: Manipulator[] = [];
  (draft.variableFillet?.points ?? []).forEach((p, i) => {
    const pick = radiusPointPick(draft.picks, p);
    if (!pick || pick.placed || pick.ref.kind !== "edge") return;
    const at = radiusPointAt(pick.ref, p.at);
    const c = at && edgeCorner(pick, facesOf(pick.partId), partOf(pick.partId));
    if (!at || !c) return;
    const key = `vf:${i}`;
    const r = evaluate(p.radius);
    const b: Base = { key, label: "Radius here", values: { [key]: r.ok ? r.value : 0 }, params: { [key]: p.radius } };
    out.push({ ...make(b, { id: key, kind: "arrow", origin: at, dir: c.into, scale: c.fillet, angle: false, flips: false, max: Infinity, tip: "Drag to change the radius at this point (type it in the dialog's list)" }), noEdit: true });
  });
  return out;
}

/** The handles to show for the open dialog's draft (none for kinds and settings that have none). */
export function manipulatorsFor(draft: Feature, ctx: ManipContext): Manipulator[] {
  if (!hasManipulators(draft.type)) return [];
  const { values } = resolveParams(draft);
  const params = draft.params;
  const base = (key: string, label: string): Base => ({ key, label, values, params });
  const sketch = ctx.sketch;
  if ((draft.type === "extrude" || draft.type === "revolve") && sketch?.plane) {
    const made = extrudeRevolveHandles(draft, sketch as { plane: SketchPlane; data: SketchData }, base, values);
    return made.map((m) => ({ ...m, passesClicks: true }));
  }
  return otherHandles(draft, ctx, base);
}

function extrudeRevolveHandles(draft: Feature, sketch: { plane: SketchPlane; data: SketchData }, base: (key: string, label: string) => Base, values: Record<string, number>): Manipulator[] {
  const out: Manipulator[] = [];
  const frame = planeFrame(sketch.plane);
  const mid = profileMiddle(sketch.data, draft.areas);
  if (!mid) return [];
  const p0 = toWorld(frame, mid[0], mid[1]);
  if (draft.type === "extrude") {
    const ex = draft.extrude ?? { end: "blind", flip: false };
    const d = scale(frame.n, ex.flip ? -1 : 1);
    if (ex.end === "blind") {
      out.push(make(base("depth", "Depth"), { id: "depth", kind: "arrow", origin: p0, dir: d, scale: 1, angle: false, flips: !ex.second, max: Infinity, tip: "Drag to change the depth (hold Shift to stop it snapping)" }));
      if (ex.second && !draft.surface)
        out.push(make(base("depth2", "Other way"), { id: "depth2", kind: "arrow", origin: p0, dir: scale(d, -1), scale: 1, angle: false, flips: false, max: Infinity, tip: "Drag to change the depth the other way" }));
    } else if (ex.end === "symmetric") {
      const tip = "Drag to change the depth (it grows the same both ways)";
      out.push(make(base("depth", "Depth"), { id: "depth", kind: "arrow", origin: p0, dir: d, scale: 0.5, angle: false, flips: false, max: Infinity, tip }));
      out.push(make(base("depth", "Depth"), { id: "depthBack", kind: "arrow", origin: p0, dir: scale(d, -1), scale: 0.5, angle: false, flips: false, max: Infinity, tip }));
    } else if (UP_TO_SAYS[ex.end]) {
      // No size to drag: shown greyed, saying why (as Onshape shows the arrow of an end that goes up to something).
      const say = UP_TO_SAYS[ex.end]!;
      out.push({ id: "depth", key: "depth", kind: "arrow", origin: p0, dir: d, value: 0, scale: 1, angle: false, flips: false, max: Infinity, locked: say, tip: say, text: "Up to", noEdit: true });
    }
    return out;
  }
  const rv = draft.revolve ?? { axis: "vertical", flip: false };
  const ax = axisInSketch(sketch.data, rv.axis);
  if (!ax) return [];
  const through = toWorld(frame, ax.at[0], ax.at[1]);
  const dir0 = unit(sub(toWorld(frame, ax.at[0] + ax.dir[0], ax.at[1] + ax.dir[1]), through));
  if (!dir0) return [];
  const d = scale(dir0, rv.flip ? -1 : 1);
  const rel = sub(p0, through);
  if (length(sub(rel, scale(d, dot(rel, d)))) < 1e-6) return [];
  const angle = values.angle ?? 360;
  const angle2 = values.angle2 ?? 0;
  const arc = { kind: "arc" as const, origin: p0, dir: d, angle: true, flips: false };
  if (rv.symmetric) {
    const tip = "Drag round to change the angle (it grows the same both ways)";
    out.push(make(base("angle", "Angle"), { ...arc, id: "angle", axis: { through, dir: d }, scale: 0.5, max: 360, tip }));
    out.push(make(base("angle", "Angle"), { ...arc, id: "angleBack", axis: { through, dir: scale(d, -1) }, scale: 0.5, max: 360, tip }));
  } else if (rv.second) {
    out.push(make(base("angle", "Angle"), { ...arc, id: "angle", axis: { through, dir: d }, scale: 1, max: Math.max(0, 360 - angle2), tip: "Drag round to change the angle" }));
    out.push(make(base("angle2", "Other way"), { ...arc, id: "angle2", axis: { through, dir: scale(d, -1) }, scale: 1, max: Math.max(0, 360 - angle), tip: "Drag round to change the angle the other way" }));
  } else out.push(make(base("angle", "Angle"), { ...arc, id: "angle", axis: { through, dir: d }, scale: 1, max: 360, tip: "Drag round to change the angle" }));
  return out;
}

/**
 * The hole or boss Move face's round picks make, where it was before the move (the handles start there), found among
 * the parts shown as the engine finds picks (so it follows earlier changes). Those parts may already have it moved by
 * the dialog's own preview (or, editing, by the feature itself): then it's found where the move puts it, and its opening
 * taken back across its axis (along it, a hole's or boss's opening stays on its face).
 */
function movedPiece(picks: readonly TopoPick[], parts: readonly MeshFaces[], mode: "translate" | "rotate", ax: { dir: Vec3; through: Vec3 }, value: number): { axis: Vec3; mouth: Vec3 } | null {
  const v = Number.isFinite(value) ? value : 0;
  const fwd = (p: Vec3): Vec3 => (mode === "translate" ? add(p, scale(ax.dir, v)) : turnPoint(p, ax.through, ax.dir, v));
  const piece = pieceOfPicks(picks, parts, Math.abs(v) > 1e-9 ? fwd : undefined);
  if (!piece) return null;
  if (!piece.moved) return { axis: piece.axis, mouth: piece.mouth };
  if (mode === "rotate") return { axis: turnPoint(piece.axis, [0, 0, 0], ax.dir, -v), mouth: turnPoint(piece.mouth, ax.through, ax.dir, -v) };
  const shift = scale(ax.dir, v);
  const across = sub(shift, scale(piece.axis, dot(shift, piece.axis)));
  return { axis: piece.axis, mouth: sub(piece.mouth, across) };
}

function otherHandles(draft: Feature, ctx: ManipContext, base: (key: string, label: string) => Base): Manipulator[] {
  const out: Manipulator[] = [];
  const partOf = (partId: string) => ctx.parts.find((p) => p.id === partId);
  const facesOf = (partId: string) => partOf(partId)?.faceRefs ?? [];
  if (draft.type === "fillet" || draft.type === "chamfer") {
    const pick = (draft.picks ?? []).find((p) => p.ref.kind === "edge" && !p.placed);
    if (!pick) return [];
    // Two distances, or a distance and an angle: an arrow along each face (the first distance on the face the engine takes first).
    if (draft.type === "chamfer" && draft.chamferType) return lopsidedHandles(draft, pick, facesOf(pick.partId), base);
    const c = edgeCorner(pick, facesOf(pick.partId), partOf(pick.partId));
    if (!c) return [];
    const edge = pick.ref as EdgeRef;
    const fillet = draft.type === "fillet";
    out.push(
      make(base(fillet ? "radius" : "distance", fillet ? "Radius" : "Distance"), {
        id: fillet ? "radius" : "distance",
        kind: "arrow",
        origin: edge.mid,
        dir: c.into,
        scale: fillet ? c.fillet : c.chamfer,
        angle: false,
        flips: false,
        max: Infinity,
        tip: fillet ? "Drag to change the radius" : "Drag to change the distance",
      }),
    );
    if (fillet && draft.variableFillet) out.push(...radiusPointHandles(draft, facesOf, partOf));
    return out;
  }
  if (draft.type === "hole") return holeHandles(draft, ctx, base);
  if (draft.type === "extendSurface") {
    const pick = (draft.picks ?? []).find((p) => p.ref.kind === "edge" && !p.placed);
    if (!pick || draft.extendTo) return [];
    const dir = extendDir(pick, facesOf(pick.partId));
    if (!dir) return [];
    return [make(base("distance", "Distance"), { id: "distance", kind: "arrow", origin: (pick.ref as EdgeRef).mid, dir, scale: 1, angle: false, flips: false, max: Infinity, tip: "Drag to change how far the surface grows" })];
  }
  const facePick = (draft.picks ?? []).find((p) => p.ref.kind === "face" && !p.placed);
  if (!facePick) return [];
  if (draft.type === "draft") return draftHandles(draft, facePick.ref as FaceRef, base);
  // Shell and Thicken: on the face as it's built now (a part an earlier feature moved carries its face along).
  // Move face's Translate / Rotate with a round face picked moves the whole hole or boss: its handle sits at the opening.
  if (draft.type === "moveFace" && (draft.moveFace?.mode === "translate" || draft.moveFace?.mode === "rotate") && (draft.picks ?? []).some((p) => p.ref.kind === "face" && p.ref.surface !== "PLANE")) {
    const ax = moveFaceAxisNow(draft.moveFace);
    if (!ax) return out;
    const mode = draft.moveFace.mode;
    const value = base(mode === "translate" ? "distance" : "angle", "").values[mode === "translate" ? "distance" : "angle"] ?? 0;
    const piece = movedPiece(draft.picks ?? [], ctx.parts, mode, ax, value);
    if (!piece) return out;
    if (draft.moveFace.mode === "translate") {
      out.push(make(base("distance", "Distance"), { id: "distance", kind: "arrow", origin: piece.mouth, dir: ax.dir, scale: 1, angle: false, flips: false, signed: true, max: Infinity, tip: "Drag to move the hole or boss along the direction (back past it moves it the other way)" }));
      return out;
    }
    // Turned only about an axis along its own (square to the face it opens onto), and not about itself.
    if (Math.abs(dot(ax.dir, piece.axis)) < 0.9999) return out;
    const off = sub(piece.mouth, ax.through);
    const radial = sub(off, scale(ax.dir, dot(off, ax.dir)));
    const r = unit(radial);
    if (!r || length(radial) < 1e-6) return out;
    out.push(make(base("angle", "Angle"), { id: "angle", kind: "arc", origin: piece.mouth, dir: r, axis: { through: ax.through, dir: ax.dir }, scale: 1, angle: true, flips: false, signed: true, max: 179, tip: "Drag round to turn the hole or boss about the axis" }));
    return out;
  }
  const face = draft.type === "shell" || draft.type === "thicken" ? faceNow(facePick, partOf(facePick.partId)) : (facePick.ref as FaceRef);
  const n = unit(face.normal);
  if (!n) return [];
  if (draft.type === "shell") {
    out.push(make(base("thickness", "Wall"), { id: "thickness", kind: "arrow", origin: face.center, dir: scale(n, draft.flipSide ? 1 : -1), scale: 1, angle: false, flips: false, max: Infinity, tip: "Drag to change the wall thickness" }));
  } else if (draft.type === "thicken") {
    const both = !!draft.bothSides;
    const d = scale(n, draft.flipSide && !both ? -1 : 1);
    out.push(make(base("thickness", "Thickness"), { id: "thickness", kind: "arrow", origin: face.center, dir: d, scale: both ? 0.5 : 1, angle: false, flips: false, max: Infinity, tip: "Drag to change the thickness" }));
  } else if (draft.type === "moveFace" && (draft.moveFace?.mode === "translate" || draft.moveFace?.mode === "rotate")) {
    // Translate: along the chosen direction; Rotate: round the chosen axis (none when only the engine knows where it is — a round edge or face).
    const ax = moveFaceAxisNow(draft.moveFace);
    if (!ax) return out;
    if (draft.moveFace.mode === "translate") {
      out.push(make(base("distance", "Distance"), { id: "distance", kind: "arrow", origin: face.center, dir: ax.dir, scale: 1, angle: false, flips: false, signed: true, max: Infinity, tip: "Drag to move the face along the direction (back past it moves it the other way)" }));
    } else {
      const off = sub(face.center, ax.through);
      if (length(sub(off, scale(ax.dir, dot(off, ax.dir)))) < 1e-6) return out;
      out.push(make(base("angle", "Angle"), { id: "angle", kind: "arc", origin: face.center, dir: n, axis: { through: ax.through, dir: ax.dir }, scale: 1, angle: true, flips: false, signed: true, max: 79, tip: "Drag round to turn the face" }));
    }
  } else if (draft.type === "moveFace" || draft.type === "offsetSurface") {
    const tip = draft.type === "moveFace" ? "Drag to move the face (back past it moves it in)" : "Drag to change how far the copy is (back past the surface puts it on the other side)";
    out.push(make(base("distance", "Distance"), { id: "distance", kind: "arrow", origin: face.center, dir: n, scale: 1, angle: false, flips: false, signed: true, max: Infinity, tip }));
  }
  return out;
}

/** What a greyed "Up to…" arrow says. */
const UP_TO_SAYS: Partial<Record<string, string>> = {
  upToFace: "This end goes up to a face: change the end type to drag it.",
  upToNext: "This end goes up to the next face it meets: change the end type to drag it.",
  upToVertex: "This end goes up to a point: change the end type to drag it.",
  upToPart: "This end goes up to a part: change the end type to drag it.",
};

/**
 * A picked face as the part has it now: the face the engine would find for it (`strictMatch`, near and
 * unambiguous), else as it was picked.
 */
export function faceNow(pick: TopoPick, part: MeshFaces | undefined): FaceRef {
  const want = pick.ref as FaceRef;
  const faces = part?.faceRefs;
  if (!faces?.length) return want;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const f of faces) {
    x0 = Math.min(x0, f.center[0]);
    x1 = Math.max(x1, f.center[0]);
    y0 = Math.min(y0, f.center[1]);
    y1 = Math.max(y1, f.center[1]);
    z0 = Math.min(z0, f.center[2]);
    z1 = Math.max(z1, f.center[2]);
  }
  const size = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
  const i = strictMatch(want, faces as FaceRef[], size);
  const got = i === null ? null : faces[i];
  return got && got.surface === want.surface && dot(got.normal, want.normal) > 0.999 ? got : want;
}

/**
 * A Hole's depth arrow: from its first hole (a sketch point or circle centre) down the drill, as the engine drills
 * (into the face, or out of it with Flip). Through all and up to next have no size to drag: no arrow.
 */
function holeHandles(draft: Feature, ctx: ManipContext, base: (key: string, label: string) => Base): Manipulator[] {
  const h = draft.hole;
  const sketch = ctx.sketch;
  if (!h || h.end !== "blind" || !sketch?.plane) return [];
  const at = holePositionsIn(sketch.data)[0];
  if (!at) return [];
  const frame = planeFrame(sketch.plane);
  const dir = scale(frame.n, h.flip ? 1 : -1);
  return [make(base("depth", "Depth"), { id: "depth", kind: "arrow", origin: toWorld(frame, at[0], at[1]), dir, scale: 1, angle: false, flips: false, max: Infinity, tip: "Drag to change the hole's depth" })];
}

/**
 * A Draft's angle: an arc round the line where the face meets the neutral plane (it pivots there). The handle is
 * the face's middle as the face leans: a plus angle leans the face in going along the pull (narrower at the top
 * with Top as the neutral plane), as the engine's BRepOffsetAPI_DraftAngle does.
 */
function draftHandles(draft: Feature, face: FaceRef, base: (key: string, label: string) => Base): Manipulator[] {
  const frame = planeFrame(draft.neutral ?? { kind: "default", name: "Top" });
  const pull = scale(frame.n, draft.flipSide ? -1 : 1);
  const n = unit(face.normal);
  if (!n || face.surface !== "PLANE") return [];
  // A face square to the pull has nothing to lean (the engine refuses it).
  if (Math.abs(dot(n, pull)) > 0.9) return [];
  const across = unit(sub(n, scale(pull, dot(n, pull))));
  if (!across) return [];
  // Turning the face's middle round this line by +θ moves it in (−across) when it's above the neutral plane.
  const axisDir = unit(cross(across, pull));
  if (!axisDir) return [];
  // How far the face's middle is from the neutral plane, along the pull; on it, a little way up (so the arc shows).
  let h = dot(sub(face.center, frame.origin), pull);
  const foot = sub(face.center, scale(pull, h));
  if (Math.abs(h) < 1e-6) h = 10;
  const origin = add(foot, scale(pull, h));
  return [
    make(base("angle", "Angle"), {
      id: "angle",
      kind: "arc",
      origin,
      dir: pull,
      axis: { through: foot, dir: axisDir },
      scale: 1,
      angle: true,
      flips: false,
      signed: true,
      max: 44,
      tip: "Drag round to change the draft angle",
    }),
  ];
}

/**
 * The way across a face from a straight edge into it (in the face's plane, square to the edge), or null. On an
 * outside corner each face runs away from the other face's outside; on an inside corner, towards it.
 */
function intoFace(edge: EdgeRef, face: FaceRef, other: FaceRef, convex: boolean): Vec3 | null {
  const t = unit(sub(edge.b, edge.a));
  const n = unit(face.normal);
  if (!t || !n) return null;
  const u = unit(cross(t, n));
  if (!u) return null;
  const s = dot(u, other.normal);
  if (Math.abs(s) < 1e-9) return null;
  return scale(u, s < 0 === convex ? 1 : -1);
}

/**
 * The faces beside a straight edge in the order the engine's lopsided chamfer takes them: the first distance runs
 * along the face that faces most upwards (then towards +Y, then +X); `flipSide` swaps.
 */
export function chamferFaces(edge: EdgeRef, faces: readonly FaceRef[], flip: boolean, picked: readonly FaceRef[] = []): { first: FaceRef; second: FaceRef; convex: boolean } | null {
  const two = facesAlong(edge, faces);
  if (two.length !== 2) return null;
  const up = (f: FaceRef) => [f.normal[2], f.normal[1], f.normal[0]];
  const [a, b] = two.map(up);
  // A face picked too, holding this edge: the engine bevels its edges first, measuring the first distance along it.
  const holds = (f: FaceRef) => picked.some((p) => p.surface === f.surface && dot(p.normal, f.normal) > 0.999 && Math.abs(dot(sub(p.center, f.center), f.normal)) < 1e-3);
  const own = [holds(two[0]), holds(two[1])];
  const aFirst =
    own[0] !== own[1] ? own[0] : a[0] - b[0] > 1e-6 || (Math.abs(a[0] - b[0]) <= 1e-6 && (a[1] - b[1] > 1e-6 || (Math.abs(a[1] - b[1]) <= 1e-6 && a[2] >= b[2])));
  const [first, second] = aFirst !== flip ? [two[0], two[1]] : [two[1], two[0]];
  const inside = dot(sub(two[0].center, edge.mid), two[1].normal) > 1e-9 || dot(sub(two[1].center, edge.mid), two[0].normal) > 1e-9;
  return { first, second, convex: !inside };
}

/**
 * Chamfer of two distances: an arrow along each face from the edge. A distance and an angle: the distance's arrow,
 * and an arc for the angle — round the line where the cut meets the first face, from back along that face (0°)
 * towards the other face; the handle sits on the cut.
 */
function lopsidedHandles(draft: Feature, pick: TopoPick, faces: readonly FaceRef[], base: (key: string, label: string) => Base): Manipulator[] {
  const edge = pick.ref as EdgeRef;
  const picked = (draft.picks ?? []).filter((p) => p.ref.kind === "face" && p.partId === pick.partId && !p.placed).map((p) => p.ref as FaceRef);
  // Both faces picked: the engine takes whichever it meets first — there's no telling which, so no arrows.
  const sides = chamferFaces(edge, faces, !!draft.flipSide, picked);
  if (sides && picked.length && [sides.first, sides.second].every((f) => picked.some((p) => dot(p.normal, f.normal) > 0.999 && Math.abs(dot(sub(p.center, f.center), f.normal)) < 1e-3))) return [];
  if (!sides) return [];
  const u1 = intoFace(edge, sides.first, sides.second, sides.convex);
  const u2 = intoFace(edge, sides.second, sides.first, sides.convex);
  if (!u1 || !u2) return [];
  const out: Manipulator[] = [];
  const first = make(base("distance", "Distance"), { id: "distance", kind: "arrow", origin: edge.mid, dir: u1, scale: 1, angle: false, flips: false, max: Infinity, tip: "Drag to change the distance along this face" });
  out.push(first);
  if (draft.chamferType === "twoDistances") {
    out.push(make(base("distance2", "Second distance"), { id: "distance2", kind: "arrow", origin: edge.mid, dir: u2, scale: 1, angle: false, flips: false, max: Infinity, tip: "Drag to change the distance along the other face" }));
    return out;
  }
  const d = first.value;
  if (!(d > 0)) return out;
  const pivot = add(edge.mid, scale(u1, d));
  const towards = sub(u2, scale(u1, dot(u2, u1)));
  const axisDir = unit(cross(scale(u1, -1), towards));
  if (!axisDir) return out;
  out.push(make(base("angle", "Angle"), { id: "angle", kind: "arc", origin: edge.mid, dir: u1, axis: { through: pivot, dir: axisDir }, scale: 1, angle: true, flips: false, max: 89, tip: "Drag round to change the angle" }));
  return out;
}

/** Extend surface: the way the surface grows from a straight edge (along its flat face, away from it). */
const extendDirs = new WeakMap<TopoPick, Vec3 | null>();
export function extendDir(pick: TopoPick, faces: readonly FaceRef[]): Vec3 | null {
  if (extendDirs.has(pick)) return extendDirs.get(pick)!;
  const edge = pick.ref as EdgeRef;
  const face = facesAlong(edge, faces)[0];
  let out: Vec3 | null = null;
  const t = unit(sub(edge.b, edge.a));
  if (face && t) {
    const u = unit(cross(t, face.normal));
    if (u) out = dot(u, sub(face.center, edge.mid)) > 0 ? scale(u, -1) : u;
  }
  // (Worked out once per pick, from the surface before it grew — the grown face's middle moves towards the edge.)
  if (out || faces.length) extendDirs.set(pick, out);
  return out;
}

/** A dragged value as its box shows it: lengths in the design's units, angles in degrees. */
export function manipBoxText(m: Pick<Manipulator, "angle">, value: number): string {
  return m.angle ? String(Math.round(value * 1000) / 1000) : startingLength(value);
}

/**
 * What dragging `m` to `value` (and, for an Extrude's blind end, past zero: `flipped`) does to the draft as it was
 * when the drag began.
 */
export function manipPatch(start: Feature, m: Manipulator, value: number, flipped: boolean): { params: Record<string, string>; fields?: Partial<Feature> } {
  const params = { [m.key]: manipBoxText(m, value) };
  // A variable fillet's radius point: its own radius, not a box.
  const point = /^vf:(\d+)$/.exec(m.key);
  if (point && start.variableFillet) {
    const k = Number(point[1]);
    return { params: {}, fields: { variableFillet: { ...start.variableFillet, points: start.variableFillet.points.map((p, i) => (i === k ? { ...p, radius: params[m.key] } : p)) } } };
  }
  // (Always said, so dragging back over zero turns it round again.)
  if (m.flips && start.type === "extrude" && start.extrude) return { params, fields: { extrude: { ...start.extrude, flip: flipped ? !start.extrude.flip : start.extrude.flip } } };
  return { params };
}

/** What the in-view size box starts with: the box's own text, as the dialog shows it (lengths in the design's units). */
export function manipEditText(draft: Feature, m: Pick<Manipulator, "key" | "angle" | "value">): string {
  const typed = draft.params[m.key];
  if (typed === undefined || typed.trim() === "") return manipBoxText(m, m.value).replace(/ in$/, "");
  return m.angle ? typed : showLength(typed);
}

/**
 * What typing `typed` in the in-view size box does: the same text the dialog's box would save (a length typed in an
 * inch design gets " in"; a variable or a sum is kept as typed), or why it can't be used.
 */
export function typedManipValue(draft: Feature, m: Pick<Manipulator, "key" | "angle">, typed: string): { params: Record<string, string> } | { problem: string } {
  const text = typed.trim();
  if (!text) return { problem: "Type a size (a number, a variable or a sum), then press Enter." };
  const stored = m.angle ? text : storeLength(text);
  const { errors } = resolveParams({ ...draft, params: { ...draft.params, [m.key]: stored } });
  if (errors[m.key]) return { problem: errors[m.key] };
  return { params: { [m.key]: stored } };
}
