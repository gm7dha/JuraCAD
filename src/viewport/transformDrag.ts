/**
 * Dragging Move / copy's triad (Onshape's Transform manipulator), worked out
 * as plain numbers (pure: no three.js, no DOM). The 3D view hands in rays from
 * the eye through the pointer and screen positions of points; this file says
 * which handle is under the pointer and how far a drag has moved or turned.
 *
 * - An arrow: the point on its line nearest the pointer's ray (moves along it).
 * - A square: where the ray meets the square's plane (moves in that plane).
 * - A ring: the angle round its axis where the ray meets the ring's plane
 *   (or, when the ring is seen edge-on, how far the pointer slid along it).
 * - The ball: where the ray meets the plane through the triad facing the
 *   screen (moves anywhere in the screen's plane).
 *
 * Results snap to steps (1 mm or more as you zoom out, 5°) unless `snap` is off
 * (Shift, or the touch bar's "No snapping").
 */
import { add, compose, cross, dot, frameAxis, length, rotation, scale, sub, turnOf, turnsNear, unit, type Triad, type TransformValues, type Vec3 } from "../model/transformMath";

export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

export type TriadHandle = { kind: "arrow"; axis: number } | { kind: "plane"; axis: number } | { kind: "ring"; axis: number } | { kind: "ball" };

/** How big the triad is drawn on screen (px from its middle to an arrow's tip). */
export const TRIAD_PIXELS = 90;

/** Where each handle is, as a fraction of the triad's size. */
export const TRIAD_LAYOUT = {
  /** Arrows run from here to the tip (1). */
  arrowFrom: 0.24,
  /** The squares sit between these, along their two directions. */
  planeFrom: 0.3,
  planeTo: 0.52,
  /** The rings' radius. */
  ring: 0.78,
  /** The ball's radius. */
  ball: 0.1,
};

/**
 * How side-on an arrow must be seen to be dragged (1 − cos² of its angle to the view) and how face-on a square
 * (|cos|): nearer edge-on, a tiny move of the pointer would throw the part far away (at |cos| 0.05, 1 mm → 20 mm).
 * Such handles are faded and can't be grabbed.
 */
export const MIN_ARROW_SIDE = 0.1;
export const MIN_SQUARE_FACING = 0.2;

/** Can this handle be dragged with the view looking along `view`? (The ball and rings always can.) */
export function handleUsable(triad: Triad, handle: TriadHandle, view: Vec3 | undefined): boolean {
  const v = view ? unit(view) : null;
  if (!v) return true;
  if (handle.kind === "arrow") {
    const c = dot(v, frameAxis(triad.frame, handle.axis));
    return 1 - c * c >= MIN_ARROW_SIDE;
  }
  if (handle.kind === "plane") return Math.abs(dot(v, frameAxis(triad.frame, handle.axis))) >= MIN_SQUARE_FACING;
  return true;
}

/** Steps a turn snaps to (degrees). */
export const ANGLE_STEP = 5;

/** The two frame directions a square (square to direction `axis`) lies along. */
export function planeAxes(axis: number): [number, number] {
  return [(axis + 1) % 3, (axis + 2) % 3];
}

/** The point on the line `origin + s·dir` nearest the ray: its s (null when the line points along the ray). */
export function axisParam(ray: Ray, origin: Vec3, dir: Vec3): number | null {
  const d = unit(dir);
  const r = unit(ray.dir);
  if (!d || !r) return null;
  const w = sub(origin, ray.origin);
  const b = dot(d, r);
  const denom = 1 - b * b;
  // (Seen almost end-on, a tiny move of the pointer would throw the part far away.)
  if (denom < MIN_ARROW_SIDE) return null;
  return (b * dot(r, w) - dot(d, w)) / denom;
}

/** Where the ray meets the plane through `origin` square to `normal` (null when it runs along the plane). */
export function planeHit(ray: Ray, origin: Vec3, normal: Vec3, least = 0.05): Vec3 | null {
  const n = unit(normal);
  const r = unit(ray.dir);
  if (!n || !r) return null;
  const along = dot(r, n);
  if (Math.abs(along) < least) return null;
  const t = dot(sub(origin, ray.origin), n) / along;
  return add(ray.origin, scale(r, t));
}

/** `value` snapped to the nearest whole number of `step`s (tidied to 1/1000). */
export function snapTo(value: number, step: number): number {
  if (!(step > 0)) return Math.round(value * 1000) / 1000;
  return Math.round(Math.round(value / step) * step * 1000) / 1000;
}

/**
 * The step a dragged length snaps to (mm): 1 mm (0.05 in), or more when zoomed
 * out so that a step is at least a few pixels long.
 */
export function lengthStep(mmPerPixel: number, unit: "mm" | "in" = "mm"): number {
  const steps = unit === "in" ? [0.05, 0.1, 0.5, 1, 5, 10, 50].map((x) => x * 25.4) : [1, 5, 10, 50, 100, 500, 1000];
  const least = 3 * (Number.isFinite(mmPerPixel) && mmPerPixel > 0 ? mmPerPixel : 0);
  return steps.find((s) => s >= least) ?? steps[steps.length - 1];
}

type Screen = [number, number];
/** World point → screen pixel (null when it can't be seen). */
export type Projector = (p: Vec3) => Screen | null;

function segmentDistance(p: Screen, a: Screen, b: Screen): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function insidePolygon(p: Screen, poly: Screen[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Points round a ring about frame direction `axis` (world). */
export function ringPoints(triad: Triad, axis: number, size: number, count = 48): Vec3[] {
  const [i, j] = planeAxes(axis);
  const u = frameAxis(triad.frame, i);
  const v = frameAxis(triad.frame, j);
  const r = TRIAD_LAYOUT.ring * size;
  const out: Vec3[] = [];
  for (let k = 0; k <= count; k++) {
    const a = (2 * Math.PI * k) / count;
    out.push(add(triad.frame.origin, add(scale(u, r * Math.cos(a)), scale(v, r * Math.sin(a)))));
  }
  return out;
}

/** The corners of the square that's square to frame direction `axis` (world). */
export function planeCorners(triad: Triad, axis: number, size: number): Vec3[] {
  const [i, j] = planeAxes(axis);
  const u = frameAxis(triad.frame, i);
  const v = frameAxis(triad.frame, j);
  const a = TRIAD_LAYOUT.planeFrom * size;
  const b = TRIAD_LAYOUT.planeTo * size;
  const at = (s: number, t: number) => add(triad.frame.origin, add(scale(u, s), scale(v, t)));
  return [at(a, a), at(b, a), at(b, b), at(a, b)];
}

/**
 * The handle under the pointer at (x, y), or null. `size`: the triad's size in
 * world units; `reach` widens it for fingers (see gestures.ts `reachFor`).
 */
export function handleAt(triad: Triad, size: number, project: Projector, x: number, y: number, reach = 1, view?: Vec3): TriadHandle | null {
  const p: Screen = [x, y];
  const o = project(triad.frame.origin);
  if (!o) return null;
  // The ball first: it's in the middle of everything else.
  if (triad.ball) {
    const edge = project(add(triad.frame.origin, scale(triad.frame.x, TRIAD_LAYOUT.ball * size)));
    const r = edge ? Math.max(8, Math.hypot(edge[0] - o[0], edge[1] - o[1])) : 8;
    if (Math.hypot(x - o[0], y - o[1]) <= r + 3 * reach) return { kind: "ball" };
  }
  let best: { handle: TriadHandle; d: number } | null = null;
  const consider = (handle: TriadHandle, d: number, within: number) => {
    if (d <= within * reach && (!best || d < best.d) && handleUsable(triad, handle, view)) best = { handle, d };
  };
  for (const axis of triad.arrows) {
    const dir = frameAxis(triad.frame, axis);
    const a = project(add(triad.frame.origin, scale(dir, TRIAD_LAYOUT.arrowFrom * size)));
    const b = project(add(triad.frame.origin, scale(dir, size)));
    if (a && b) consider({ kind: "arrow", axis }, segmentDistance(p, a, b), 8);
  }
  for (const axis of triad.planes) {
    const corners = planeCorners(triad, axis, size).map(project);
    if (corners.every((c): c is Screen => !!c) && insidePolygon(p, corners)) consider({ kind: "plane", axis }, 1, 8);
  }
  for (const axis of triad.rings) {
    const pts = ringPoints(triad, axis, size).map(project);
    let d = Infinity;
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1];
      const b = pts[k];
      if (a && b) d = Math.min(d, segmentDistance(p, a, b));
    }
    consider({ kind: "ring", axis }, d + 0.5, 7);
  }
  return (best as { handle: TriadHandle } | null)?.handle ?? null;
}

/** Which value each handle changes, for a way of moving. */
function keysFor(mode: string): { move: (keyof TransformValues | null)[]; turn: (keyof TransformValues | null)[] } {
  if (mode === "distance") return { move: [null, null, "distance"], turn: [null, null, null] };
  if (mode === "rotate") return { move: [null, null, null], turn: [null, null, "turn"] };
  if (mode === "xyz") return { move: ["dx", "dy", "dz"], turn: [null, null, null] };
  return { move: ["dx", "dy", "dz"], turn: ["rx", "ry", "rz"] };
}

export interface DragOptions {
  /** Snap to steps (off with Shift). */
  snap: boolean;
  /** Length step (mm). */
  step: number;
  /** Angle step (degrees). */
  angleStep?: number;
}

/** A drag in progress: each pointer move gives the values (those the handle changes) to show. */
export interface TriadDrag {
  handle: TriadHandle;
  /** The values the handle changes, from the pointer's ray now. */
  move(ray: Ray, opts: DragOptions): Partial<Record<keyof TransformValues, number>>;
}

/**
 * Start dragging `handle` (pressed with the pointer's ray `ray0`). `start`: the
 * values when the drag began; `mode`: the way of moving (see transformMath).
 * Null when the handle can't be dragged from here (an arrow pointing straight
 * at you, say) or changes nothing in this way of moving.
 */
export function startTriadDrag(handle: TriadHandle, triad: Triad, size: number, ray0: Ray, start: TransformValues, mode: string): TriadDrag | null {
  const f = triad.frame;
  const o = f.origin;
  const keys = keysFor(mode);
  const startOf = (k: keyof TransformValues) => start[k] ?? 0;
  const lengths = (delta: Vec3, axes: number[], opts: DragOptions) => {
    const out: Partial<Record<keyof TransformValues, number>> = {};
    for (const i of axes) {
      const k = keys.move[i];
      if (!k) continue;
      const v = startOf(k) + dot(delta, frameAxis(f, i));
      out[k] = opts.snap ? snapTo(v, opts.step) : snapTo(v, 0);
    }
    return out;
  };
  if (handle.kind === "arrow") {
    const dir = frameAxis(f, handle.axis);
    const s0 = axisParam(ray0, o, dir);
    if (s0 === null || !keys.move[handle.axis]) return null;
    let last: Vec3 = [0, 0, 0];
    return {
      handle,
      move(ray, opts) {
        const s = axisParam(ray, o, dir);
        if (s !== null) last = scale(dir, s - s0);
        return lengths(last, [handle.axis], opts);
      },
    };
  }
  if (handle.kind === "plane") {
    const n = frameAxis(f, handle.axis);
    const p0 = planeHit(ray0, o, n, MIN_SQUARE_FACING);
    const axes = planeAxes(handle.axis);
    if (!p0 || axes.every((i) => !keys.move[i])) return null;
    let last: Vec3 = [0, 0, 0];
    return {
      handle,
      move(ray, opts) {
        const p = planeHit(ray, o, n, MIN_SQUARE_FACING);
        if (p) last = sub(p, p0);
        return lengths(last, axes, opts);
      },
    };
  }
  if (handle.kind === "ball") {
    // The plane through the triad facing the screen (the view is orthographic: every ray goes the same way).
    const n = ray0.dir;
    const p0 = planeHit(ray0, o, n, 1e-6);
    if (!p0 || keys.move.every((k) => !k)) return null;
    let last: Vec3 = [0, 0, 0];
    return {
      handle,
      move(ray, opts) {
        const p = planeHit(ray, o, n, 1e-6);
        if (p) last = sub(p, p0);
        return lengths(last, [0, 1, 2], opts);
      },
    };
  }
  // A ring.
  const k = keys.turn[handle.axis];
  if (!k) return null;
  const n = frameAxis(f, handle.axis);
  const radius = TRIAD_LAYOUT.ring * size;
  const edgeOn = Math.abs(dot(unit(ray0.dir) ?? [0, 0, 1], n)) < 0.2;
  const flat = (p: Vec3): Vec3 => {
    const w = sub(p, o);
    return sub(w, scale(n, dot(w, n)));
  };
  let total = 0;
  // Free (turn and move): the turn so far, then the ring's turn about its drawn axis on top — written back as the
  // X-then-Y-then-Z turns of the three boxes (so a ring always turns about the axis it's drawn round).
  const before = mode === "free" ? turnOf(startOf("rx"), startOf("ry"), startOf("rz")) : null;
  // The angles shown last (the drag's start values first): the next ones are kept as near them as they can be.
  let shown = { rx: startOf("rx"), ry: startOf("ry"), rz: startOf("rz") };
  const names = ["rx", "ry", "rz"] as const;
  const finish = (opts: DragOptions) => {
    if (before) {
      const delta = opts.snap ? snapTo(total, opts.angleStep ?? ANGLE_STEP) : total;
      const axis: Vec3 = [handle.axis === 0 ? 1 : 0, handle.axis === 1 ? 1 : 0, handle.axis === 2 ? 1 : 0];
      // Nearest what was shown, with the ring's own box where the drag alone would take it (so 400° stays 400°).
      const near = { ...shown, [names[handle.axis]]: startOf(names[handle.axis]) + delta };
      const turns = turnsNear(compose(rotation(axis, delta), { r: before, t: [0, 0, 0] }).r, near);
      const tidy = (n: number) => Math.round(n * 1000) / 1000 + 0;
      shown = { rx: tidy(turns.rx), ry: tidy(turns.ry), rz: tidy(turns.rz) };
      return { ...shown };
    }
    const v = startOf(k) + total;
    return { [k]: opts.snap ? snapTo(v, opts.angleStep ?? ANGLE_STEP) : Math.round(v * 100) / 100 } as Partial<Record<keyof TransformValues, number>>;
  };
  if (!edgeOn) {
    const p0 = planeHit(ray0, o, n);
    const v0 = p0 ? unit(flat(p0)) : null;
    if (!v0) return null;
    let prev = v0;
    return {
      handle,
      move(ray, opts) {
        const p = planeHit(ray, o, n);
        const v = p ? unit(flat(p)) : null;
        if (v) {
          // Added up a little at a time, so a drag can go more than half way round.
          total += (Math.atan2(dot(n, cross(prev, v)), dot(prev, v)) * 180) / Math.PI;
          prev = v;
        }
        return finish(opts);
      },
    };
  }
  // Seen edge-on: how far the pointer slides along the ring where it was grabbed.
  const view = ray0.dir;
  const p0 = planeHit(ray0, o, view, 1e-6);
  if (!p0) return null;
  // Where on the ring it was grabbed: the side nearer the eye, level with the pointer.
  const g = flat(p0);
  const toEye = unit(flat(scale(view, -1)));
  const h = Math.sqrt(Math.max(0, radius * radius - dot(g, g)));
  const out = unit(toEye ? add(g, scale(toEye, h)) : g) ?? frameAxis(f, (handle.axis + 1) % 3);
  const tangent = unit(cross(n, out));
  if (!tangent) return null;
  return {
    handle,
    move(ray, opts) {
      const p = planeHit(ray, o, view, 1e-6);
      if (p) total = (dot(sub(p, p0), tangent) / radius) * (180 / Math.PI);
      return finish(opts);
    },
  };
}

/** The handle's colour name (X red, Y green, Z blue; the ball grey). */
export function handleColour(handle: TriadHandle): "x" | "y" | "z" | "ball" {
  return handle.kind === "ball" ? "ball" : (["x", "y", "z"] as const)[handle.axis];
}

/** A one-line description of a handle (for the smoke test and screen readers). */
export function handleName(handle: TriadHandle): string {
  const axis = handle.kind === "ball" ? "" : ["X", "Y", "Z"][handle.axis];
  if (handle.kind === "arrow") return `${axis} arrow`;
  if (handle.kind === "plane") return `${["YZ", "ZX", "XY"][handle.axis]} square`;
  if (handle.kind === "ring") return `ring about ${axis}`;
  return "centre ball";
}

/** Length of a world vector (re-exported for the view's sizes). */
export const vecLength = length;
