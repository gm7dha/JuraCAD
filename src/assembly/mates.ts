/**
 * Mates: how two parts in an assembly are joined, like Onshape's mates.
 * Each mate lines up a connector on one part with a connector on another,
 * then allows only certain movements (turning, sliding…) whose amounts are
 * stored with the mate.
 *
 * Solving works outwards from the fixed parts: a part joined by a mate to an
 * already placed part is placed by that mate. Closed loops of mates (where a
 * part is reached two ways) are checked, and reported if they disagree.
 */
import { evaluate } from "../model/expr";
import type { Assembly, Mate, MateType } from "../model/types";
import { compose, invert, quatFromAxisAngle, quatFromEulerDeg, samePlacement, type Placement } from "./math";
import { frameOnParts, framePlacement, type Frame } from "./connectors";
import type { PartMesh } from "../kernel/protocol";

export interface MateValueDef {
  key: string;
  label: string;
  unit: "mm" | "°";
  /** A movement the mate allows (shown with a slider), rather than a fixed offset. */
  free: boolean;
}

export interface MateTypeDef {
  type: MateType;
  label: string;
  description: string;
  values: MateValueDef[];
}

const angle = (free: boolean, label = "Turn"): MateValueDef => ({ key: "angle", label, unit: "°", free });
const gap: MateValueDef = { key: "gap", label: "Gap", unit: "mm", free: false };

export const MATE_TYPES: Record<MateType, MateTypeDef> = {
  fastened: {
    type: "fastened",
    label: "Fasten",
    description: "Joins the two parts solidly — no movement.",
    values: [gap, angle(false)],
  },
  revolute: {
    type: "revolute",
    label: "Hinge",
    description: "Lets the part turn around the connectors' shared axis, like a hinge or a wheel on an axle.",
    values: [angle(true, "Angle"), gap],
  },
  slider: {
    type: "slider",
    label: "Slider",
    description: "Lets the part slide along the connectors' axis, without turning.",
    values: [{ key: "distance", label: "Distance", unit: "mm", free: true }, angle(false)],
  },
  cylindrical: {
    type: "cylindrical",
    label: "Cylindrical",
    description: "Lets the part slide along and turn around the axis, like a pin in a hole.",
    values: [{ key: "distance", label: "Distance", unit: "mm", free: true }, angle(true, "Angle")],
  },
  planar: {
    type: "planar",
    label: "Planar",
    description: "Keeps two faces together while the part slides and turns on the face.",
    values: [
      { key: "dx", label: "Slide X", unit: "mm", free: true },
      { key: "dy", label: "Slide Y", unit: "mm", free: true },
      angle(true, "Angle"),
      gap,
    ],
  },
  ball: {
    type: "ball",
    label: "Ball",
    description: "Keeps two points together while the part turns any way, like a ball joint.",
    values: [
      { key: "rx", label: "Tilt about X", unit: "°", free: true },
      { key: "ry", label: "Tilt about Y", unit: "°", free: true },
      { key: "rz", label: "Turn about Z", unit: "°", free: true },
    ],
  },
};

export const MATE_ORDER: MateType[] = ["fastened", "revolute", "slider", "cylindrical", "planar", "ball"];

/** Values worked out from what's typed (0 where blank); errors by key. */
export function mateValues(mate: Pick<Mate, "type" | "values">): { values: Record<string, number>; errors: Record<string, string> } {
  const values: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const def of MATE_TYPES[mate.type].values) {
    const src = (mate.values[def.key] ?? "").trim();
    if (!src) {
      values[def.key] = 0;
      continue;
    }
    const r = evaluate(src);
    if (r.ok) values[def.key] = r.value;
    else errors[def.key] = r.error;
  }
  return { values, errors };
}

const RAD = Math.PI / 180;
const HALF_TURN_X: Placement = { position: [0, 0, 0], rotation: quatFromAxisAngle([1, 0, 0], Math.PI) };

/**
 * Where the second connector sits relative to the first: the mate's
 * movement, then (unless flipped) a half turn so the two Z axes face each
 * other — so two faces end up touching, face to face.
 */
export function mateOffset(type: MateType, v: Record<string, number>, flip: boolean): Placement {
  const z = (v.gap ?? 0) + (v.distance ?? 0);
  const turn = quatFromAxisAngle([0, 0, 1], (v.angle ?? 0) * RAD);
  let offset: Placement = { position: [v.dx ?? 0, v.dy ?? 0, z], rotation: turn };
  if (type === "ball") offset = { position: [0, 0, 0], rotation: quatFromEulerDeg(v.rx ?? 0, v.ry ?? 0, v.rz ?? 0) };
  return flip ? offset : compose(offset, HALF_TURN_X);
}

/** Looks up a connector's frame on its instance's part, or null if it can't be found any more. */
export type FrameLookup = (mate: Mate, side: "a" | "b") => Frame | null;

export interface SolveResult {
  /** Where every instance ends up. */
  placements: Record<string, Placement>;
  /** Mate id → plain-English reason it couldn't be used. */
  mateErrors: Record<string, string>;
  /** Instances placed by a mate (instance id → mate id); the rest sit where they were put. */
  drivenBy: Record<string, string>;
}

/** Place every instance, starting from the fixed ones and following the mates. */
export function solveAssembly(assembly: Assembly, frameOf: FrameLookup): SolveResult {
  const placements: Record<string, Placement> = {};
  const mateErrors: Record<string, string> = {};
  const drivenBy: Record<string, string> = {};
  const instances = new Map(assembly.instances.map((i) => [i.id, i]));

  // Mates that can be used: both parts present, connectors found, values readable.
  interface Link {
    mate: Mate;
    a: string;
    b: string;
    /** b's placement from a's: T_b = T_a ∘ rel. */
    rel: Placement;
  }
  const links: Link[] = [];
  for (const mate of assembly.mates ?? []) {
    if (mate.suppressed) continue;
    const ia = instances.get(mate.a.instanceId);
    const ib = instances.get(mate.b.instanceId);
    if (!ia || !ib) {
      mateErrors[mate.id] = "One of its parts has been removed from the assembly.";
      continue;
    }
    if (ia.id === ib.id) {
      mateErrors[mate.id] = "Both connectors are on the same part — pick a face or edge on another part.";
      continue;
    }
    const fa = frameOf(mate, "a");
    const fb = frameOf(mate, "b");
    if (!fa || !fb) {
      mateErrors[mate.id] = "A face or edge it uses can't be found any more (the part has changed too much). Edit the mate and pick it again.";
      continue;
    }
    const { values, errors } = mateValues(mate);
    const bad = Object.keys(errors)[0];
    if (bad) {
      mateErrors[mate.id] = `${MATE_TYPES[mate.type].values.find((d) => d.key === bad)?.label ?? bad}: ${errors[bad]}`;
      continue;
    }
    const rel = compose(compose(framePlacement(fa), mateOffset(mate.type, values, mate.flip)), invert(framePlacement(fb)));
    links.push({ mate, a: ia.id, b: ib.id, rel });
  }

  const conflict = (link: Link) => {
    mateErrors[link.mate.id] =
      instances.get(link.a)?.fixed && instances.get(link.b)?.fixed
        ? "Both parts are fixed, so this mate can't move either of them. Unfix one."
        : "This mate disagrees with other mates on the same parts (PartSmith can't solve loops of mates yet). Suppress or delete one.";
  };

  // Spread outwards from each starting part: fixed ones first, then any others not yet reached.
  const starts = [...assembly.instances.filter((i) => i.fixed), ...assembly.instances.filter((i) => !i.fixed)];
  for (const start of starts) {
    if (placements[start.id]) continue;
    placements[start.id] = start.placement;
    const queue = [start.id];
    while (queue.length) {
      const id = queue.shift()!;
      for (const link of links) {
        if (link.a !== id && link.b !== id) continue;
        const other = link.a === id ? link.b : link.a;
        const target = link.a === id ? compose(placements[id], link.rel) : compose(placements[id], invert(link.rel));
        const already = placements[other];
        if (already) {
          if (!samePlacement(already, target, 1e-4) && !mateErrors[link.mate.id]) conflict(link);
          continue;
        }
        const o = instances.get(other)!;
        if (o.fixed) {
          // Reached a second fixed part: it stays put; the mate is satisfied only if it already fits.
          placements[other] = o.placement;
          if (!samePlacement(o.placement, target, 1e-4)) conflict(link);
          queue.push(other);
          continue;
        }
        placements[other] = target;
        drivenBy[other] = link.mate.id;
        queue.push(other);
      }
    }
  }
  return { placements, mateErrors, drivenBy };
}

/** Solve using the parts as built now. */
export function solveWithParts(assembly: Assembly, parts: PartMesh[]): SolveResult {
  return solveAssembly(assembly, (mate, side) => frameOnParts(parts, mate[side].pick));
}

/** Next free mate name, e.g. "Hinge 2". */
export function nextMateName(assembly: Assembly, type: MateType): string {
  const prefix = MATE_TYPES[type].label;
  const used = new Set((assembly.mates ?? []).map((m) => m.name));
  let n = 1;
  while (used.has(`${prefix} ${n}`)) n++;
  return `${prefix} ${n}`;
}
