/**
 * Exploded views: the parts of an assembly pulled apart so you can see how
 * they go together. Each part moves straight out from the middle of the
 * assembly — or, when some parts are fixed, from the middle of the fixed
 * parts, which stay where they are. Steps then move chosen parts a set
 * distance along X, Y or Z (like Onshape's exploded view steps: the screws
 * straight up out of their holes, then the lid). Only the picture changes:
 * mates, exports and clash checks still use the parts' real places.
 */
import { placedBox, type Box3 } from "./assembly";
import type { Placement, Vec3 } from "./math";
import { evaluate } from "../model/expr";
import type { Assembly, ExplodeStep } from "../model/types";

export interface ExplodeItem {
  id: string;
  placement: Placement;
  /** The part's own box (before it's placed), or null if unknown. */
  box: Box3 | null;
  fixed?: boolean;
}

const centre = (b: Box3): Vec3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];

function union(boxes: Box3[]): Box3 | null {
  if (!boxes.length) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], b.min[k]);
      max[k] = Math.max(max[k], b.max[k]);
    }
  return { min, max };
}

/** How far each part moves for an exploded view spread by `amount` (0 = not at all). */
export function explodeOffsets(items: ExplodeItem[], amount: number): Record<string, Vec3> {
  const out: Record<string, Vec3> = {};
  if (!(amount > 0)) return out;
  const placed = items.map((i) => ({ item: i, box: i.box ? placedBox(i.box, i.placement) : null }));
  const known = placed.filter((p) => p.box) as { item: ExplodeItem; box: Box3 }[];
  const fixed = known.filter((p) => p.item.fixed);
  const all = union((fixed.length && fixed.length < known.length ? fixed : known).map((p) => p.box));
  if (!all) return out;
  const middle = centre(all);
  const keepFixed = fixed.length > 0 && fixed.length < known.length;
  for (const { item, box } of known) {
    if (keepFixed && item.fixed) continue;
    const c = centre(box);
    const d: Vec3 = [(c[0] - middle[0]) * amount, (c[1] - middle[1]) * amount, (c[2] - middle[2]) * amount];
    if (Math.hypot(...d) > 1e-9) out[item.id] = d;
  }
  return out;
}

/** Placements moved by the offsets. */
export function explodedPlacements(placements: Record<string, Placement>, offsets: Record<string, Vec3>): Record<string, Placement> {
  const out: Record<string, Placement> = {};
  for (const [id, p] of Object.entries(placements)) {
    const d = offsets[id];
    out[id] = d ? { position: [p.position[0] + d[0], p.position[1] + d[1], p.position[2] + d[2]], rotation: p.rotation } : p;
  }
  return out;
}

const AXES: Record<ExplodeStep["axis"], Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** How far a step moves its parts (mm), or what's wrong with what's typed. */
export function stepDistance(step: ExplodeStep): { value: number } | { error: string } {
  const r = evaluate(step.distance.trim() || "0");
  return r.ok ? { value: r.value } : { error: r.error };
}

/** The steps' moves added up for each part (steps that can't be read are skipped). */
export function stepOffsets(steps: readonly ExplodeStep[]): Record<string, Vec3> {
  const out: Record<string, Vec3> = {};
  for (const step of steps) {
    const d = stepDistance(step);
    if ("error" in d) continue;
    const dir = AXES[step.axis];
    const k = (step.flip ? -1 : 1) * d.value;
    for (const id of step.instances) {
      const o = out[id] ?? [0, 0, 0];
      out[id] = [o[0] + dir[0] * k, o[1] + dir[1] * k, o[2] + dir[2] * k];
    }
  }
  return out;
}

/** Two sets of offsets added together. */
export function addOffsets(a: Record<string, Vec3>, b: Record<string, Vec3>): Record<string, Vec3> {
  const out: Record<string, Vec3> = { ...a };
  for (const [id, d] of Object.entries(b)) {
    const o = out[id] ?? [0, 0, 0];
    out[id] = [o[0] + d[0], o[1] + d[1], o[2] + d[2]];
  }
  return out;
}

/** Add a step, or replace the one with the same id. */
export function putExplodeStep(a: Assembly, step: ExplodeStep): Assembly {
  const steps = a.explodeSteps ?? [];
  return { ...a, explodeSteps: steps.some((s) => s.id === step.id) ? steps.map((s) => (s.id === step.id ? step : s)) : [...steps, step] };
}

export function removeExplodeStep(a: Assembly, id: string): Assembly {
  const { explodeSteps: _old, ...rest } = a;
  const left = (a.explodeSteps ?? []).filter((s) => s.id !== id);
  return left.length ? { ...rest, explodeSteps: left } : rest;
}

/** After parts are removed: steps lose them, and steps left with no parts go. */
export function tidyExplodeSteps(a: Assembly): Assembly {
  if (!a.explodeSteps) return a;
  const present = new Set(a.instances.map((i) => i.id));
  const { explodeSteps: _old, ...rest } = a;
  const steps = a.explodeSteps.map((s) => ({ ...s, instances: s.instances.filter((id) => present.has(id)) })).filter((s) => s.instances.length);
  return steps.length ? { ...rest, explodeSteps: steps } : rest;
}

/** A step read from a file (null if it's unusable). */
export function parseExplodeStep(raw: unknown): ExplodeStep | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.id !== "string" || !Array.isArray(r.instances)) return null;
  const instances = [...new Set(r.instances.filter((x): x is string => typeof x === "string"))];
  if (!instances.length) return null;
  return {
    id: r.id,
    instances,
    axis: r.axis === "x" || r.axis === "y" ? r.axis : "z",
    ...(r.flip === true ? { flip: true } : {}),
    distance: typeof r.distance === "string" ? r.distance : typeof r.distance === "number" && Number.isFinite(r.distance) ? String(r.distance) : "20",
  };
}
