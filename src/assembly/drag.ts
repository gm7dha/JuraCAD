/**
 * Dragging parts in an assembly with the mouse, like Onshape:
 *  - a part not held by any mate slides around in the plane of the screen;
 *  - a part held by a Hinge turns around the hinge, a Slider slides along it,
 *    a Cylindrical turns (or slides, with Shift), a Planar slides on its face.
 * Each drag works out new values for one thing — the part's position, or the
 * amounts of the mate that holds it — which are saved as one undo step at the end.
 */
import type { Assembly, Mate } from "../model/types";
import { framePlacement, type Frame } from "./connectors";
import { add, compose, cross, dot, length, normalize, rotate, scale, sub, type Placement, type Vec3 } from "./math";
import { clampToLimits, mateValues, type SolveResult } from "./mates";
import { lengthUnit, startingLength } from "../model/units";

export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

/** Where a ray meets a plane (null if it runs along it). */
export function rayPlane(ray: Ray, point: Vec3, normal: Vec3): Vec3 | null {
  const d = dot(ray.dir, normal);
  if (Math.abs(d) < 1e-9) return null;
  const t = dot(sub(point, ray.origin), normal) / d;
  return add(ray.origin, scale(ray.dir, t));
}

export type DragChange = { kind: "instance"; id: string; placement: Placement } | { kind: "mate"; id: string; values: Record<string, string> };

export interface DragPlan {
  /** What the drag changes for the pointer's current ray (null when the pointer is somewhere unusable). */
  update(ray: Ray): DragChange | null;
}

export type DragStart = { plan: DragPlan } | { refuse: string };

const round = (v: number, step: number) => {
  const r = Math.round(v / step) * step;
  return String(Math.round(r * 1e6) / 1e6);
};

/** A connector's frame in the world, as the assembly is placed now. */
function worldFrame(placement: Placement, f: Frame): { origin: Vec3; x: Vec3; y: Vec3; z: Vec3 } {
  const w = compose(placement, framePlacement(f));
  return { origin: w.position, x: rotate(w.rotation, [1, 0, 0]), y: rotate(w.rotation, [0, 1, 0]), z: rotate(w.rotation, [0, 0, 1]) };
}

/**
 * Plan a drag of `instanceId`, grabbed at world point `grab`, seen along `view`.
 * `shift` asks a Cylindrical mate to slide rather than turn.
 */
export function planDrag(
  assembly: Assembly,
  solved: SolveResult,
  frameOf: (mate: Mate, side: "a" | "b") => Frame | null,
  instanceId: string,
  grab: Vec3,
  view: Vec3,
  shift = false,
): DragStart {
  const instance = assembly.instances.find((i) => i.id === instanceId);
  if (!instance) return { refuse: "" };
  const mateId = solved.drivenBy[instanceId];

  // A grouped part: drag the whole group, by its first part.
  if (mateId?.startsWith("group:")) {
    const group = assembly.groups?.find((g) => `group:${g.id}` === mateId);
    const anchor = group?.members[0];
    if (group && anchor && anchor !== instanceId && !solved.drivenBy[anchor]?.startsWith("group:")) {
      return planDrag(assembly, solved, frameOf, anchor, grab, view, shift);
    }
    return { refuse: group ? `${instance.name} is in ${group.name}, which is held in place by a mate or a fixed part. Move that instead, or ungroup it.` : "" };
  }

  if (!mateId) {
    if (instance.fixed) return { refuse: `${instance.name} is fixed. Unfix it (toolbar) to move it.` };
    const start = solved.placements[instanceId] ?? instance.placement;
    const normal = normalize(view);
    return {
      plan: {
        update(ray) {
          const hit = rayPlane(ray, grab, normal);
          if (!hit) return null;
          const delta = sub(hit, grab);
          const position = add(start.position, delta).map((v) => Number(round(v, 0.01))) as Vec3;
          return { kind: "instance", id: instanceId, placement: { position, rotation: start.rotation } };
        },
      },
    };
  }

  const mate = assembly.mates?.find((m) => m.id === mateId);
  if (!mate) return { refuse: "" };
  const fa = frameOf(mate, "a");
  const pa = solved.placements[mate.a.instanceId];
  if (!fa || !pa) return { refuse: "" };
  const axis = worldFrame(pa, fa);
  // Mate amounts move the second connector's part; dragging the first part goes the other way.
  const sign = mate.b.instanceId === instanceId ? 1 : -1;
  const { values: start } = mateValues(mate);
  // Movements stop at the mate's limits.
  // Lengths are saved in the design's units (angles in degrees).
  const limited = (key: string, v: number, step: number) => {
    const value = clampToLimits(mate, key, lengthUnit() === "in" && key !== "angle" ? v : Number(round(v, step)));
    return key === "angle" ? String(value) : startingLength(value);
  };
  const withValue = (key: string, value: number, step: number): DragChange => ({ kind: "mate", id: mate.id, values: { ...mate.values, [key]: limited(key, value, step) } });

  const turnPlan = (): DragStart => {
    const n = axis.z;
    const flat = (p: Vec3) => {
      const v = sub(p, axis.origin);
      return sub(v, scale(n, dot(v, n)));
    };
    const v0 = flat(grab);
    if (length(v0) < 1e-6) return { refuse: "Grab the part further from its hinge to turn it." };
    if (Math.abs(dot(normalize(view), n)) < 0.05) return { refuse: "You're looking along the hinge — turn the view a little to drag it round." };
    let last = v0;
    let total = 0;
    return {
      plan: {
        update(ray) {
          const hit = rayPlane(ray, grab, n);
          if (!hit) return null;
          const v = flat(hit);
          if (length(v) < 1e-6) return null;
          total += Math.atan2(dot(cross(last, v), n), dot(last, v));
          last = v;
          return withValue("angle", (start.angle ?? 0) + (sign * total * 180) / Math.PI, 0.5);
        },
      },
    };
  };

  const slidePlan = (): DragStart => {
    const z = axis.z;
    const across = sub(normalize(view), scale(z, dot(normalize(view), z)));
    if (length(across) < 0.05) return { refuse: "You're looking straight along the slider — turn the view a little to drag it." };
    const normal = normalize(across);
    const s0 = dot(sub(grab, axis.origin), z);
    return {
      plan: {
        update(ray) {
          const hit = rayPlane(ray, grab, normal);
          if (!hit) return null;
          const s = dot(sub(hit, axis.origin), z);
          return withValue("distance", (start.distance ?? 0) + sign * (s - s0), 0.1);
        },
      },
    };
  };

  switch (mate.type) {
    case "revolute":
      return turnPlan();
    case "slider":
      return slidePlan();
    case "cylindrical":
      return shift ? slidePlan() : turnPlan();
    case "width":
    case "planar": {
      if (sign < 0) return { refuse: `Drag the other part of ${mate.name}, or use its sliders.` };
      if (Math.abs(dot(normalize(view), axis.z)) < 0.05) return { refuse: "You're looking along the face — turn the view a little to drag it." };
      return {
        plan: {
          update(ray) {
            const hit = rayPlane(ray, grab, axis.z);
            if (!hit) return null;
            const d = sub(hit, grab);
            return {
              kind: "mate",
              id: mate.id,
              values: { ...mate.values, dx: limited("dx", (start.dx ?? 0) + dot(d, axis.x), 0.1), dy: limited("dy", (start.dy ?? 0) + dot(d, axis.y), 0.1) },
            };
          },
        },
      };
    }
    case "pinSlot": {
      if (shift) return turnPlan();
      // Slide along the slot (the connector's X direction).
      const x = axis.x;
      const across = sub(normalize(view), scale(x, dot(normalize(view), x)));
      if (length(across) < 0.05) return { refuse: "You're looking straight along the slot — turn the view a little to drag it." };
      const normal = normalize(across);
      const s0 = dot(sub(grab, axis.origin), x);
      return {
        plan: {
          update(ray) {
            const hit = rayPlane(ray, grab, normal);
            if (!hit) return null;
            return withValue("dx", (start.dx ?? 0) + sign * (dot(sub(hit, axis.origin), x) - s0), 0.1);
          },
        },
      };
    }
    case "parallel": {
      if (shift) return slidePlan();
      if (Math.abs(dot(normalize(view), axis.z)) < 0.05) return { refuse: "You're looking side-on — turn the view a little to drag it (hold Shift to move it up and down)." };
      return {
        plan: {
          update(ray) {
            const hit = rayPlane(ray, grab, axis.z);
            if (!hit) return null;
            const d = sub(hit, grab);
            return {
              kind: "mate",
              id: mate.id,
              values: { ...mate.values, dx: limited("dx", (start.dx ?? 0) + sign * dot(d, axis.x), 0.1), dy: limited("dy", (start.dy ?? 0) + sign * dot(d, axis.y), 0.1) },
            };
          },
        },
      };
    }
    case "fastened":
      return { refuse: `${instance.name} is fastened by ${mate.name}, so it can't move. Edit the mate to change where it sits.` };
    case "ball":
      return { refuse: `Use the sliders in ${mate.name} to turn a ball joint (double-click it in the Mates list).` };
  }
}

/** The assembly with a drag's change applied (for showing it while dragging). */
export function withDragChange(assembly: Assembly, change: DragChange | null): Assembly {
  if (!change) return assembly;
  if (change.kind === "instance") {
    return { ...assembly, instances: assembly.instances.map((i) => (i.id === change.id ? { ...i, placement: change.placement } : i)) };
  }
  return { ...assembly, mates: assembly.mates?.map((m) => (m.id === change.id ? { ...m, values: change.values } : m)) };
}
