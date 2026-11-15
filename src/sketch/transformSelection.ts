/**
 * Move, turn and scale the picked shapes of a sketch (Onshape's sketch Transform), and the small handles drawn
 * on the sketch that drag them: the middle square moves, the ring turns (15° steps), the square on the arm
 * scales (steps of 0.05). Pure: the sketch controller (controller.ts) runs the drags.
 *
 * Relations and dimensions are kept sensible: what lies wholly inside the picked set moves with it (sizes scale
 * with a plain-number dimension; Horizontal / Vertical become Parallel / Perpendicular when the turn isn't a
 * quarter turn), and anything that ties the picked set to what isn't picked has to allow the move — else it's
 * refused with a plain message (as dragging several picked shapes is), never stretched.
 */
import { evaluate, namesIn } from "../model/expr";
import { copySketchItems, pasteSketchClip, selectionPoints } from "./clipboard";
import { curveById, curvePoints, ellipsePoints, pointPos, radiusOf, sketchId, splinePath } from "./ops";
import { solveSketch } from "./solver";
import { isDimension, type SketchConstraint, type SketchCurve, type SketchData } from "./types";

type P2 = [number, number];

/** A move, then a turn (degrees, anticlockwise) and a scale about a centre. */
export interface SelectionMotion {
  dx: number;
  dy: number;
  angle: number;
  scale: number;
}

export const NO_MOTION: SelectionMotion = { dx: 0, dy: 0, angle: 0, scale: 1 };

export interface TransformResult {
  sketch: SketchData;
  /** The shapes that moved (the copies, when copying). */
  ids: string[];
  error?: string;
}

/** Plain messages for what can stop a transform. */
export const HELD_MESSAGE =
  "These can't move that way: part of the selection is held where it is (a Fix, a dimension or relation to something not picked, or it follows a part's edge brought in with Use). Pick only what's free to move.";
export const STRAIGHT_DIMENSION_MESSAGE =
  "Something picked is measured straight across or straight up (a horizontal or vertical dimension), so it can only be turned by a quarter turn. Change that dimension to a plain length first.";
export const VARIABLE_SIZE_MESSAGE = "A size in the selection is set by a variable or a sum, so it can't be scaled here: change the variable instead.";

/** Dimensions that are lengths (scaled with the shapes); angles stay as they are. */
const LENGTHS = new Set<SketchConstraint["type"]>(["distance", "length", "horizontalDistance", "verticalDistance", "radius", "diameter", "pointLineDistance", "offset", "arcLength", "rimDistance"]);

/**
 * The middle of the picked shapes' box — the shapes as drawn (an arc's curve, a circle's full size, a spline's path),
 * not their construction points: a centre or an ellipse's axis end counts only when it is picked itself. Null when
 * nothing that moves is picked.
 */
export function selectionCentre(s: SketchData, ids: readonly string[]): P2 | null {
  if (!selectionPoints(s, ids).length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const take = ([x, y]: P2) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  const pointIds = new Set(s.points.map((p) => p.id));
  for (const id of ids) {
    const c = curveById(s, id);
    if (c) {
      for (const p of curveOutline(s, c)) take(p);
      continue;
    }
    if (pointIds.has(id)) take(pointPos(s, id));
    const t = s.texts?.find((x) => x.id === id);
    if (t) take(pointPos(s, t.anchor));
  }
  return Number.isFinite(x0) ? [(x0 + x1) / 2, (y0 + y1) / 2] : null;
}

/** Points along a curve as drawn (enough to give its box). */
function curveOutline(s: SketchData, c: SketchCurve): P2[] {
  if (c.type === "line") return [pointPos(s, c.p1), pointPos(s, c.p2)];
  if (c.type === "spline") return splinePath(s, c);
  if (c.type === "ellipse") return ellipsePoints(s, c);
  const [cx, cy] = pointPos(s, c.center);
  if (c.type === "circle") return [[cx - c.radius, cy - c.radius], [cx + c.radius, cy + c.radius]];
  // An arc runs anticlockwise from its start to its end: its ends, and the quarter points it passes.
  const r = radiusOf(s, c);
  const [sx, sy] = pointPos(s, c.start);
  const [ex, ey] = pointPos(s, c.end);
  const a0 = Math.atan2(sy - cy, sx - cx);
  let a1 = Math.atan2(ey - cy, ex - cx);
  while (a1 <= a0) a1 += 2 * Math.PI;
  const out: P2[] = [[sx, sy], [ex, ey]];
  for (let k = Math.ceil(a0 / (Math.PI / 2)); k * (Math.PI / 2) < a1; k++) out.push([cx + r * Math.cos((k * Math.PI) / 2), cy + r * Math.sin((k * Math.PI) / 2)]);
  return out;
}

/** Where a point goes: scaled and turned about `about`, then moved. */
export function motionMap(about: P2, m: SelectionMotion): (p: P2) => P2 {
  const r = (m.angle * Math.PI) / 180;
  const cos = Math.cos(r) * m.scale;
  const sin = Math.sin(r) * m.scale;
  return ([x, y]) => {
    const u = x - about[0], v = y - about[1];
    return [about[0] + u * cos - v * sin + m.dx, about[1] + u * sin + v * cos + m.dy];
  };
}

/** The turn as a whole number of quarter turns (0…3), or null when it isn't one. */
function quarterTurns(angle: number): number | null {
  const q = angle / 90;
  const n = Math.round(q);
  return Math.abs(q - n) < 1e-9 ? ((n % 4) + 4) % 4 : null;
}

const isIdentity = (m: SelectionMotion) => Math.abs(m.dx) < 1e-12 && Math.abs(m.dy) < 1e-12 && quarterTurns(m.angle) === 0 && Math.abs(m.scale - 1) < 1e-12;

/** A plain number dimension's value scaled (kept in inches when typed in inches); null when it uses a variable. */
function scaledValue(value: string, k: number): string | null {
  if (namesIn(value).length) return null;
  const r = evaluate(value);
  if (!r.ok) return null;
  const round = (v: number) => String(Math.round(v * 1e6) / 1e6);
  return /(?<=[\d\s)])in\s*\)?\s*$/.test(value) ? `${round((r.value * k) / 25.4)} in` : round(r.value * k);
}

/**
 * Move, turn and scale the picked shapes (curves, points and text, by id) about `about` (default: the middle of
 * their box). Relations and dimensions among them are kept (see the file's note); the sketch is solved and the
 * result refused (`error`, the sketch as it was) when anything holds part of the selection back.
 */
export function transformSelection(s: SketchData, ids: readonly string[], m: SelectionMotion, about?: P2): TransformResult {
  const moving = new Set(selectionPoints(s, ids));
  if (!moving.size) return { sketch: s, ids: [], error: "Pick the shapes to move first." };
  if (!(m.scale > 0) || !Number.isFinite(m.scale)) return { sketch: s, ids: [], error: "The scale must be a number more than 0 (1 = the same size)." };
  if (![m.dx, m.dy, m.angle].every(Number.isFinite)) return { sketch: s, ids: [], error: "Type how far to move or turn them." };
  const picked = [...ids];
  if (isIdentity(m)) return { sketch: s, ids: picked };
  const centre = about ?? selectionCentre(s, ids)!;
  const f = motionMap(centre, m);
  const k = m.scale;
  const turn = m.angle;
  const quarter = quarterTurns(turn);
  const r = (turn * Math.PI) / 180;
  const linear = (v: P2): P2 => [k * (v[0] * Math.cos(r) - v[1] * Math.sin(r)), k * (v[0] * Math.sin(r) + v[1] * Math.cos(r))];
  const selected = new Set(ids);

  const targets = new Map<string, P2>();
  const points = s.points.map((p) => {
    if (!moving.has(p.id)) return p;
    const [x, y] = f([p.x, p.y]);
    targets.set(p.id, [x, y]);
    return { ...p, x, y };
  });
  const radii = new Map<string, number>();
  const curves = s.curves.map((c): SketchCurve => {
    if (c.type === "circle" && selected.has(c.id)) {
      radii.set(c.id, c.radius * k);
      return { ...c, radius: c.radius * k };
    }
    if (c.type === "spline" && (c.tangents || c.tangentsIn) && c.points.every((p) => moving.has(p))) {
      const turnAll = (h?: Record<string, [number, number]>) => (h ? Object.fromEntries(Object.entries(h).map(([id, v]) => [id, linear(v)])) : undefined);
      const tangents = turnAll(c.tangents);
      const tangentsIn = turnAll(c.tangentsIn);
      return { ...c, ...(tangents ? { tangents } : {}), ...(tangentsIn ? { tangentsIn } : {}) };
    }
    return c;
  });
  const texts = s.texts?.map((t) => (selected.has(t.id) ? { ...t, angle: t.angle + turn, size: t.size * k } : t));

  const insideCurve = (id: string) => {
    const c = curveById(s, id);
    return !!c && (selected.has(id) || (c.type !== "circle" && curvePoints(c).every((p) => moving.has(p))));
  };
  const inside = (con: SketchConstraint) => con.refs.length > 0 && con.refs.every((ref) => moving.has(ref) || insideCurve(ref));

  // Horizontal / Vertical lines turned by other than a quarter turn: held square to one another instead.
  const straight: SketchConstraint[] = [];
  const constraints: SketchConstraint[] = [];
  for (const con of s.constraints) {
    if (!inside(con)) {
      constraints.push(con);
      continue;
    }
    let next = con;
    if (con.type === "horizontal" || con.type === "vertical") {
      if (quarter === null) {
        // (Two points level with each other: there's no line to hold square to, so the relation goes.)
        if (con.refs.length === 1 && curveById(s, con.refs[0])?.type === "line") straight.push(con);
        continue;
      }
      if (quarter % 2 === 1) next = { ...con, type: con.type === "horizontal" ? "vertical" : "horizontal" };
    } else if (con.type === "horizontalDistance" || con.type === "verticalDistance") {
      if (quarter === null) return { sketch: s, ids: [], error: STRAIGHT_DIMENSION_MESSAGE };
      // (dx, dy) turned a quarter goes to (−dy, dx): an "across" becomes an "up" and the other way round.
      const sign = con.extra?.[0] ?? 1;
      const across = con.type === "horizontalDistance";
      const flip = quarter === 2 || (quarter === 1 && !across) || (quarter === 3 && across);
      next = { ...con, type: quarter % 2 === 1 ? (across ? "verticalDistance" : "horizontalDistance") : con.type, extra: [flip ? -sign : sign, ...(con.extra?.slice(1) ?? [])] };
    } else if (con.type === "patternMove" && con.extra && con.extra.length >= 2) {
      const [dist, deg, ...rest] = con.extra;
      next = { ...con, extra: [dist * k, con.refs.length >= 3 ? deg : deg + turn, ...rest] };
    }
    if (k !== 1 && isDimension(next) && !next.driven && LENGTHS.has(next.type)) {
      const v = scaledValue(next.value ?? "", k);
      if (v === null) return { sketch: s, ids: [], error: VARIABLE_SIZE_MESSAGE };
      next = { ...next, value: v };
    }
    constraints.push(next);
  }
  // Lines that were level or upright: the first stays as it is (the whole picked set may now turn freely) and every
  // other is held parallel or square to it — one line for the whole selection, so no picked shape (a slot inside a
  // plate) is left to spin on its own; a turned rectangle stays a rectangle.
  const ref = straight[0];
  for (const con of straight.slice(1)) constraints.push({ id: sketchId("k"), type: ref.type === con.type ? "parallel" : "perpendicular", refs: [ref.refs[0], con.refs[0]] });

  const next: SketchData = { ...s, points, curves, constraints, ...(texts ? { texts } : {}) };
  const solved = solveSketch(next, { place: [...targets].map(([pointId, [x, y]]) => ({ pointId, x, y })) });
  if (!solved.ok) return { sketch: s, ids: [], error: HELD_MESSAGE };
  const rigid =
    [...targets].every(([id, [x, y]]) => {
      const [px, py] = pointPos(solved.sketch, id);
      return Math.hypot(px - x, py - y) < 1e-3;
    }) &&
    [...radii].every(([id, want]) => {
      const c = curveById(solved.sketch, id);
      return c?.type === "circle" && Math.abs(c.radius - want) < 1e-3;
    });
  if (!rigid) return { sketch: s, ids: [], error: HELD_MESSAGE };
  return { sketch: solved.sketch, ids: picked };
}

/**
 * A copy of the picked shapes, moved, turned and scaled (the originals stay). The copy carries the relations
 * and dimensions among them, never what tied them to anything else (as Copy and paste).
 */
export function transformCopy(s: SketchData, ids: readonly string[], m: SelectionMotion, about?: P2): TransformResult {
  const clip = copySketchItems(s, ids);
  if (!clip) return { sketch: s, ids: [], error: "Pick the shapes to copy first." };
  const centre = about ?? selectionCentre(s, ids) ?? clip.middle;
  const pasted = pasteSketchClip(s, clip, clip.middle);
  if (pasted.error) return { sketch: s, ids: [], error: pasted.error };
  const r = transformSelection(pasted.sketch, pasted.ids, m, centre);
  return r.error ? { sketch: s, ids: [], error: r.error } : r;
}

// ---------------------------------------------------------------------------
// The handles drawn on the sketch (sizes in screen pixels, so they look the same at any zoom)

/** The ring's radius on screen. */
export const GIZMO_RING_PX = 56;
/** Half the middle square's side. */
const MIDDLE_PX = 7;
/** How far out (at 45°, up and right) the scale handle sits, and half its square's side. */
const SCALE_ARM_PX = 84;
const SCALE_BOX_PX = 5;
/** How near (px) the pointer must come to grab each part. */
const GRAB_MIDDLE_PX = 11;
const GRAB_RING_PX = 7;
const GRAB_SCALE_PX = 10;
/** Turns snap to this (degrees), scales to this; Shift turns snapping off. */
export const TURN_STEP = 15;
export const SCALE_STEP = 0.05;

export type GizmoPart = "move" | "turn" | "scale";

export interface Gizmo {
  centre: P2;
  /** Millimetres per screen pixel when it was laid out. */
  mmPerPx: number;
}

/** Shapes to draw (the controller's preview shapes, marked as handles). */
export type GizmoShape = { kind: "line"; a: P2; b: P2; handle: true } | { kind: "circle"; c: P2; r: number; handle: true };

const scaleSpot = (g: Gizmo, k = 1): P2 => {
  const d = (SCALE_ARM_PX * g.mmPerPx * k) / Math.SQRT2;
  return [g.centre[0] + d, g.centre[1] + d];
};

/** Which handle is under the pointer (the scale square first, then the middle, then the ring). */
export function gizmoPartAt(g: Gizmo, x: number, y: number, reach = 1): GizmoPart | null {
  const px = g.mmPerPx * reach;
  const [sx, sy] = scaleSpot(g);
  if (Math.hypot(x - sx, y - sy) <= GRAB_SCALE_PX * px) return "scale";
  const d = Math.hypot(x - g.centre[0], y - g.centre[1]);
  if (d <= GRAB_MIDDLE_PX * px) return "move";
  if (Math.abs(d - GIZMO_RING_PX * g.mmPerPx) <= GRAB_RING_PX * px) return "turn";
  return null;
}

/** The handles, drawn for a drag in progress: the middle moved by (dx, dy), the ring's knob turned, the arm scaled. */
export function gizmoShapes(g: Gizmo, live: SelectionMotion = NO_MOTION): GizmoShape[] {
  const px = g.mmPerPx;
  const c: P2 = [g.centre[0] + live.dx, g.centre[1] + live.dy];
  const at = { ...g, centre: c };
  const out: GizmoShape[] = [];
  const square = (m: P2, h: number) => {
    const p: P2[] = [[m[0] - h, m[1] - h], [m[0] + h, m[1] - h], [m[0] + h, m[1] + h], [m[0] - h, m[1] + h]];
    for (let i = 0; i < 4; i++) out.push({ kind: "line", a: p[i], b: p[(i + 1) % 4], handle: true });
  };
  square(c, MIDDLE_PX * px);
  const ring = GIZMO_RING_PX * px;
  out.push({ kind: "circle", c, r: ring, handle: true });
  const a = (live.angle * Math.PI) / 180;
  const knob: P2 = [c[0] + ring * Math.cos(a), c[1] + ring * Math.sin(a)];
  out.push({ kind: "circle", c: knob, r: 4 * px, handle: true });
  if (live.angle !== 0) out.push({ kind: "line", a: c, b: knob, handle: true });
  const k = Math.max(0.2, Math.min(3, live.scale));
  const s = scaleSpot(at, k);
  const from: P2 = [c[0] + ring / Math.SQRT2, c[1] + ring / Math.SQRT2];
  if (Math.hypot(s[0] - c[0], s[1] - c[1]) > ring + SCALE_BOX_PX * px) out.push({ kind: "line", a: from, b: [s[0] - SCALE_BOX_PX * px, s[1] - SCALE_BOX_PX * px], handle: true });
  square(s, SCALE_BOX_PX * px);
  return out;
}

/** The signed turn (degrees, −180…180) from `a` to `b` seen from `c`. */
export function turnBetween(c: P2, a: P2, b: P2): number {
  const t = Math.atan2(b[1] - c[1], b[0] - c[0]) - Math.atan2(a[1] - c[1], a[0] - c[0]);
  return (Math.atan2(Math.sin(t), Math.cos(t)) * 180) / Math.PI;
}

/** A turn snapped to 15° steps (Shift: as dragged). */
export function snapTurn(deg: number, free: boolean): number {
  if (free) return Math.round(deg * 100) / 100;
  const s = Math.round(deg / TURN_STEP) * TURN_STEP;
  return Object.is(s, -0) ? 0 : s;
}

/** A scale snapped to steps of 0.05 (Shift: as dragged), never 0 or less. */
export function snapScale(k: number, free: boolean): number {
  if (free) return Math.max(0.01, Math.round(k * 1000) / 1000);
  return Math.max(SCALE_STEP, Math.round(k / SCALE_STEP) * SCALE_STEP);
}

/** The typed Scale box as a number, or what's wrong with it. */
export function readScale(text: string | undefined): number | string {
  const r = evaluate(text?.trim() ? text : "1");
  if (!r.ok) return `Scale: ${r.error}`;
  if (!(r.value > 0)) return "The scale must be a number more than 0 (1 = the same size).";
  return r.value;
}

/** What the drag does so far, in words (shown while dragging). */
export function motionWords(part: GizmoPart, m: SelectionMotion, fmt: (mm: number) => string = (v) => `${Math.round(v * 100) / 100} mm`): string {
  if (part === "turn") return `Turning ${Math.round(m.angle * 100) / 100}° — let go to keep it (hold Shift for any angle, not just 15° steps).`;
  if (part === "scale") return `Scaling ×${Math.round(m.scale * 1000) / 1000} — let go to keep it (hold Shift for any size).`;
  return `Moving ${fmt(m.dx)} across, ${fmt(m.dy)} up — let go to keep it (hold Shift to stop it snapping).`;
}
