/**
 * Dragging a feature dialog's manipulators (see model/manipulators.ts), worked out as plain numbers (pure: no
 * three.js, no DOM): which handle is under the pointer, and the value a drag gives from the pointer's ray.
 *
 * - An arrow: the point on its line nearest the pointer's ray (as Move / copy's triad arrows).
 * - An arc: the angle round its axis where the ray meets the plane square to it through the profile's point,
 *   added up a little at a time (so a drag can go past half a turn); seen edge-on, how far the pointer slides
 *   along the arc where it was grabbed.
 *
 * Lengths snap to steps (`manipStep`: 1 mm or 0.05 in, finer zoomed in, coarser zoomed out), angles to 1°, unless
 * `snap` is off (Shift, or the touch bar's "No snapping").
 */
import { arcPoints, manipArrowDir, manipPoint, type Manipulator } from "../model/manipulators";
import { add, cross, dot, scale, sub, unit, type Vec3 } from "../model/transformMath";
import { axisParam, MIN_ARROW_SIDE, planeHit, snapTo, type Projector, type Ray } from "./transformDrag";

/** A manipulator's handle, as the 3D view's hit tests hand it on (beside the triad's handles). */
export interface ManipHandle {
  kind: "manip";
  id: string;
}

/** How long an arrow is drawn on screen (px from its foot to its tip). */
export const MANIP_PIXELS = 64;

/** The steps a dragged length snaps to (mm): the smallest at least 4 px long, so finer zoomed in. */
const MM_STEPS = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100, 500, 1000];
const IN_STEPS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50].map((x) => x * 25.4);
export function manipStep(mmPerPixel: number, unit: "mm" | "in" = "mm"): number {
  const steps = unit === "in" ? IN_STEPS : MM_STEPS;
  const least = 4 * (Number.isFinite(mmPerPixel) && mmPerPixel > 0 ? mmPerPixel : 0);
  // At usual zooms 1 mm (0.05 in): finer only when zoomed right in.
  const usual = unit === "in" ? 0.05 * 25.4 : 1;
  const fine = steps.find((s) => s >= least) ?? steps[steps.length - 1];
  return least * 10 < usual ? fine : Math.max(fine, usual);
}

/** Angle steps (degrees). */
export const MANIP_ANGLE_STEP = 1;

type Screen = [number, number];

function segmentDistance(p: Screen, a: Screen, b: Screen): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** The arrow's foot and tip (world), drawn `size` long (world units). */
export function arrowEnds(m: Manipulator, size: number): [Vec3, Vec3] {
  const foot = manipPoint(m);
  return [foot, add(foot, scale(manipArrowDir(m), size))];
}

/**
 * The handle under the pointer at (x, y), or null. `size`: the arrow's length in world units; `reach` widens it for
 * fingers. Locked handles are found too (so their tooltip shows); the glue refuses to drag them.
 */
export function manipHandleAt(manips: readonly Manipulator[], size: number, project: Projector, x: number, y: number, reach = 1, view?: Vec3): ManipHandle | null {
  let best: { id: string; d: number } | null = null;
  const v = view ? unit(view) : null;
  for (const m of manips) {
    // Pointing (almost) straight at you, an arrow is a dot that can't be dragged: it mustn't take clicks meant for what's behind it.
    if (v) {
      const c = dot(v, manipArrowDir(m));
      if (1 - c * c < MIN_ARROW_SIDE) continue;
    }
    const [foot, tip] = arrowEnds(m, size);
    const a = project(foot);
    const b = project(tip);
    if (!a || !b) continue;
    const d = segmentDistance([x, y], a, b);
    if (d <= 9 * reach && (!best || d < best.d)) best = { id: m.id, d };
  }
  return best ? { kind: "manip", id: best.id } : null;
}

export interface ManipDragOptions {
  snap: boolean;
  /** Length step (mm). */
  step: number;
  /** Angle step (degrees). */
  angleStep?: number;
}

/** A drag in progress: each pointer move gives the value to show and whether it went past zero (flipping the feature). */
export interface ManipDrag {
  manip: Manipulator;
  move(ray: Ray, opts: ManipDragOptions): { value: number; flipped: boolean };
}

/** The least a size may be: a step when snapping, else a hundredth (sizes must be more than 0). */
function least(opts: ManipDragOptions, angle: boolean, start: number): number {
  if (!opts.snap) return 0.01;
  const step = angle ? opts.angleStep ?? MANIP_ANGLE_STEP : opts.step;
  // (A size already smaller than a step doesn't jump up to one as the drag starts.)
  return start > 0 ? Math.min(step, start) : step;
}

function settle(m: Manipulator, raw: number, opts: ManipDragOptions): { value: number; flipped: boolean } {
  const step = m.angle ? opts.angleStep ?? MANIP_ANGLE_STEP : opts.step;
  // Until the pointer has moved half a step the size stays as it was (a 15.3 mm depth doesn't jump to 15 when grabbed).
  if (opts.snap && Math.abs(raw - m.value) < step / 2) return { value: m.value, flipped: false };
  const v = opts.snap ? snapTo(raw, step) : Math.round(raw * 1000) / 1000;
  let flipped = false;
  let out = v;
  if (m.flips && v < 0) {
    flipped = true;
    out = -v;
  }
  if (m.signed) {
    // Past zero it carries on, minus (never exactly 0, which isn't a size).
    if (Number.isFinite(m.max)) out = Math.max(-m.max, Math.min(m.max, out));
    // (Never nearer 0 than the least a size may be, Shift or not.)
    const low = least(opts, m.angle, Math.abs(m.value));
    if (Math.abs(out) < low) out = (out < 0 || (out === 0 && raw < 0) ? -1 : 1) * low;
    return { value: out + 0, flipped: false };
  }
  out = Math.max(least(opts, m.angle, m.value), out);
  if (Number.isFinite(m.max)) out = Math.min(m.max, out);
  return { value: out + 0, flipped };
}

/**
 * Start dragging `m`, pressed with the pointer's ray `ray0`. Null when it can't be dragged from this view (an arrow
 * pointing straight at you).
 */
export function startManipDrag(m: Manipulator, ray0: Ray): ManipDrag | null {
  if (m.kind === "arrow") {
    const s0 = axisParam(ray0, m.origin, m.dir);
    if (s0 === null || !(m.scale > 0)) return null;
    let s = s0;
    return {
      manip: m,
      move(ray, opts) {
        const now = axisParam(ray, m.origin, m.dir);
        if (now !== null) s = now;
        return settle(m, m.value + (s - s0) / m.scale, opts);
      },
    };
  }
  const axis = m.axis;
  if (!axis || !(m.scale > 0)) return null;
  const n = axis.dir;
  // The plane square to the axis through the profile's point (the arc lies in it).
  const centre = add(axis.through, scale(n, dot(sub(m.origin, axis.through), n)));
  const flat = (p: Vec3): Vec3 => {
    const w = sub(p, centre);
    return sub(w, scale(n, dot(w, n)));
  };
  const radius = Math.hypot(...flat(m.origin));
  if (!(radius > 1e-9)) return null;
  let total = 0;
  const edgeOn = Math.abs(dot(unit(ray0.dir) ?? [0, 0, 1], n)) < 0.2;
  if (!edgeOn) {
    const p0 = planeHit(ray0, centre, n);
    const v0 = p0 ? unit(flat(p0)) : null;
    if (!v0) return null;
    let prev = v0;
    return {
      manip: m,
      move(ray, opts) {
        const p = planeHit(ray, centre, n);
        const v = p ? unit(flat(p)) : null;
        if (v) {
          total += (Math.atan2(dot(n, cross(prev, v)), dot(prev, v)) * 180) / Math.PI;
          prev = v;
        }
        return settle(m, m.value + total / m.scale, opts);
      },
    };
  }
  // Seen edge-on: how far the pointer slides along the arc's direction at the handle.
  const view = ray0.dir;
  const p0 = planeHit(ray0, manipPoint(m), view, 1e-6);
  const tangent = manipArrowDir(m);
  if (!p0) return null;
  return {
    manip: m,
    move(ray, opts) {
      const p = planeHit(ray, manipPoint(m), view, 1e-6);
      if (p) total = (dot(sub(p, p0), tangent) / radius) * (180 / Math.PI);
      return settle(m, m.value + total / m.scale, opts);
    },
  };
}

/** The arc's guide line (world points), re-exported for the view. */
export const manipArc = arcPoints;
