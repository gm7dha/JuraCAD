/**
 * Mates: how two parts in an assembly are joined, like Onshape's mates.
 * Each mate lines up a connector on one part with a connector on another,
 * then allows only certain movements (turning, sliding…) whose amounts are
 * stored with the mate.
 *
 * Solving works outwards from the fixed parts: a part joined by a mate to an
 * already placed part is placed by that mate. Closed loops of mates (where a
 * part is reached two ways) are closed by adjusting the mates' movements.
 */
import { applyRelations } from "./relations";
import { evaluate, getCurrentScope, type Scope } from "../model/expr";
import type { Assembly, AssemblyPattern, Instance, Mate, MateConnector, MateType } from "../model/types";
import { sameRef } from "../geometry/topoRef";
import { applyPlacement, compose, IDENTITY, invert, quatConjugate, quatFromAxisAngle, quatFromEulerDeg, quatMultiply, rotate, sub, type Placement, type Vec3 } from "./math";
import { connectorFrameOnParts, framePlacement, widthFrame, type Frame } from "./connectors";
import { axisPlane, mirrorAcross, OWN_YZ, patternStep, placeCopy, type MirrorPlane, type OwnPlane } from "./patterns";
import { findMesh, meshIdOf } from "./configured";
import { withoutSuppressed } from "./suppress";
import { isOrigin, ORIGIN_ID, originFrame } from "./origin";
import { pathProblem } from "./paths";
import { ownSymmetry } from "./symmetry";
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
    description: "Joins the two parts solidly — no movement. Use the gap, turn and shifts to set exactly where it sits.",
    values: [gap, angle(false), { key: "dx", label: "Shift X", unit: "mm", free: false }, { key: "dy", label: "Shift Y", unit: "mm", free: false }],
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
  pinSlot: {
    type: "pinSlot",
    label: "Pin slot",
    description: "A pin in a slot: the part slides along the slot (the connector's X direction) and turns about the pin.",
    values: [{ key: "dx", label: "Along the slot", unit: "mm", free: true }, angle(true, "Angle"), gap],
  },
  parallel: {
    type: "parallel",
    label: "Parallel",
    description: "Keeps the connectors' Z axes pointing the same way; the part can move anywhere and turn about that axis.",
    values: [
      { key: "dx", label: "Move X", unit: "mm", free: true },
      { key: "dy", label: "Move Y", unit: "mm", free: true },
      { key: "distance", label: "Move Z", unit: "mm", free: true },
      angle(true, "Angle"),
    ],
  },
  width: {
    type: "width",
    label: "Width",
    description: "Centres a part between two faces of another — like a tab in a slot: pick the two sides of the slot, then the two sides of the tab. It can still slide along and turn.",
    values: [
      { key: "dx", label: "Slide X", unit: "mm", free: true },
      { key: "dy", label: "Slide Y", unit: "mm", free: true },
      angle(true, "Angle"),
    ],
  },
  tangent: {
    type: "tangent",
    label: "Tangent",
    description: "Keeps a round face touching another face — a roller on a flat, a wheel against a wheel, a ball on a plate. Pick at least one round face (a cylinder or ball). The part can slide, turn and roll while staying in touch.",
    values: [
      { key: "dx", label: "Slide", unit: "mm", free: true },
      { key: "dy", label: "Slide sideways", unit: "mm", free: true },
      angle(true, "Angle"),
      { key: "roll", label: "Roll", unit: "°", free: true },
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

export const MATE_ORDER: MateType[] = ["fastened", "revolute", "slider", "cylindrical", "planar", "pinSlot", "parallel", "width", "tangent", "ball"];

/**
 * The limits on a mate's movements, worked out from what's typed (missing
 * ends are ±Infinity). Only movements (free amounts) can have limits.
 */
export function mateLimits(mate: Pick<Mate, "type" | "limits">): { limits: Record<string, { min: number; max: number }>; errors: Record<string, string> } {
  const limits: Record<string, { min: number; max: number }> = {};
  const errors: Record<string, string> = {};
  for (const def of MATE_TYPES[mate.type].values) {
    const l = mate.limits?.[def.key];
    if (!def.free || !l) continue;
    const end = (src: string | undefined, fallback: number, word: string): number => {
      if (!src?.trim()) return fallback;
      const r = evaluate(src);
      if (r.ok) return r.value;
      errors[def.key] = `${word} limit: ${r.error}`;
      return fallback;
    };
    const min = end(l.min, -Infinity, "Lowest");
    const max = end(l.max, Infinity, "Highest");
    if (min > max && !errors[def.key]) errors[def.key] = "The lowest limit is more than the highest.";
    if (min > -Infinity || max < Infinity) limits[def.key] = { min, max };
  }
  return { limits, errors };
}

/** Keep a movement's amount within its limits. */
export function clampToLimits(mate: Pick<Mate, "type" | "limits">, key: string, value: number): number {
  const l = mateLimits(mate).limits[key];
  return l && l.min <= l.max ? Math.max(l.min, Math.min(l.max, value)) : value;
}

/** Values worked out from what's typed (0 where blank), kept within any limits; errors by key. */
export function mateValues(mate: Pick<Mate, "type" | "values" | "limits">): { values: Record<string, number>; errors: Record<string, string> } {
  const values: Record<string, number> = {};
  const { limits, errors } = mateLimits(mate);
  for (const def of MATE_TYPES[mate.type].values) {
    const src = (mate.values[def.key] ?? "").trim();
    if (!src) {
      values[def.key] = 0;
    } else {
      const r = evaluate(src);
      if (r.ok) values[def.key] = r.value;
      else errors[def.key] = r.error;
    }
    const l = limits[def.key];
    if (l && l.min <= l.max && values[def.key] !== undefined) values[def.key] = Math.max(l.min, Math.min(l.max, values[def.key]));
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

/** A face as a Tangent mate sees it: Z points out to where the other face touches (across a cylinder's axis), X along a cylinder's axis. */
export interface TangentSide {
  frame: Frame;
  kind: "plane" | "cylinder" | "sphere";
  radius: number;
}

export function tangentSide(f: Frame): TangentSide | null {
  if (f.surface === "plane") return { frame: f, kind: "plane", radius: 0 };
  if (f.surface === "cylinder") return { frame: { origin: f.origin, z: f.x, x: f.z }, kind: "cylinder", radius: f.radius ?? 0 };
  if (f.surface === "sphere") return { frame: f, kind: "sphere", radius: f.radius ?? 0 };
  return null;
}

const turnAbout = (axis: Vec3, radians: number): Placement => ({ position: [0, 0, 0], rotation: quatFromAxisAngle(axis, radians) });
const shift = (x: number, y: number, z: number): Placement => ({ position: [x, y, z], rotation: [0, 0, 0, 1] });

/**
 * Where the round side `b` sits on side `a` for a Tangent mate (relative to
 * their tangent frames): slid `dx`, `dy` over a's surface (on a cylinder, along
 * its axis and round it; on a ball, round it — distances measured on the
 * surface), touching at the radii plus the gap, turned about the line between
 * them, then rolled about b's own axis.
 */
export function tangentOffset(a: Pick<TangentSide, "kind" | "radius">, b: Pick<TangentSide, "kind" | "radius">, v: Record<string, number>): Placement {
  const dx = v.dx ?? 0;
  const dy = v.dy ?? 0;
  let move: Placement;
  if (a.kind === "cylinder") move = compose(shift(dx, 0, 0), turnAbout([1, 0, 0], -dy / Math.max(a.radius, 1e-9)));
  else if (a.kind === "sphere") move = compose(turnAbout([0, 1, 0], dx / Math.max(a.radius, 1e-9)), turnAbout([1, 0, 0], -dy / Math.max(a.radius, 1e-9)));
  else move = shift(dx, dy, 0);
  const touch = shift(0, 0, a.radius + b.radius + (v.gap ?? 0));
  const roll = turnAbout([1, 0, 0], (v.roll ?? 0) * RAD);
  return compose(compose(compose(compose(move, touch), turnAbout([0, 0, 1], (v.angle ?? 0) * RAD)), HALF_TURN_X), roll);
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
  /** Movements changed to close loops of mates (mate id → amount key → value). */
  adjusted?: Record<string, Record<string, number>>;
  /** Pattern id → plain-English reason its copies couldn't be placed. */
  patternErrors?: Record<string, string>;
  /** Group id → plain-English reason its parts couldn't be kept together. */
  groupErrors?: Record<string, string>;
}

/** How much a turn counts against a gap when closing loops: 1 radian ≈ this many mm. */
const TURN_WEIGHT = 20;

/**
 * Place every instance, starting from the fixed ones and following the mates.
 * When mates form a closed loop (a part reached two ways, like a four-bar
 * linkage), the movements the mates allow (hinge angles, slider distances…)
 * are adjusted until the loop closes; only if it can't be closed is a mate
 * reported as disagreeing.
 */
export interface SolveOptions {
  /**
   * Mates whose movements were just set (typed, dragged or animated): loops
   * are closed by moving the other mates first, so these stay as set unless
   * the loop can't close any other way.
   */
  hold?: readonly string[];
  /**
   * Every assembly in the document, so connectors on parts inside a
   * sub-assembly can be found (each sub-assembly placed by its own mates).
   * Not needed when the assembly has no sub-assemblies.
   */
  assemblies?: readonly Assembly[];
  /**
   * Mirrors that show a symmetric part as itself (the same hand as its original):
   * the plane of its own that the part is symmetric across (solveWithParts works it
   * out from the part's shape). Missing or null: the part isn't (known to be) symmetric.
   */
  symmetry?: (instance: Instance) => OwnPlane | null;
  /** (Inside the solver) mirrors across faces: each one's plane where the face ended up, worked out by a first pass. */
  facePlanes?: Record<string, MirrorPlane | string>;
}

/** A connector on its own, looked up like a mate's first side. */
const asMate = (c: MateConnector): Mate => ({ id: "", name: "", type: "fastened", a: c, b: c, flip: false, values: {} });

/** How many times face-mirrors are solved again while their faces still move (a mirror across a face of another mirror's copy needs one more each). */
const FACE_PASSES = 8;
/** A face counts as not moving when its plane moves less than this (mm; and turns less than about 0.06°). */
const FACE_STILL = 1e-6;

/**
 * Where each face-mirror's face is, given where the parts are, as a plane — or
 * a plain-English reason it can't be used.
 */
function mirrorFacePlanes(input: Assembly, frameOf: FrameLookup, placements: Record<string, Placement>): Record<string, MirrorPlane | string> {
  const out: Record<string, MirrorPlane | string> = {};
  for (const p of input.patterns ?? []) {
    if (p.kind !== "mirror" || !p.plane) continue;
    const c = p.plane;
    const on = input.instances.find((i) => i.id === c.instanceId);
    if (!isOrigin(c) && !on) {
      out[p.id] = "The face it mirrors across was on a part that's been removed. Pick another face, or one of the assembly's planes.";
      continue;
    }
    if (on?.copyOf?.pattern === p.id) {
      out[p.id] = "It can't mirror across a face of one of its own copies. Pick a face on another part, or one of the assembly's planes.";
      continue;
    }
    if (on?.suppressed) {
      out[p.id] = `The face it mirrors across is on ${on.name}, which is suppressed. Unsuppress it, or pick another face.`;
      continue;
    }
    const f = frameOf(asMate(c), "a");
    if (!f || f.surface !== "plane") {
      out[p.id] = "The face it mirrors across can't be found any more (or isn't flat). Pick a flat face again, or one of the assembly's planes.";
      continue;
    }
    const at = on ? placements[on.id] ?? on.placement : IDENTITY;
    const w = placeFrame(at, f);
    out[p.id] = { point: w.origin, normal: w.z };
  }
  return out;
}

/** Whether a face-mirror's plane stayed put from one pass to the next. */
function samePlane(a: MirrorPlane | string | undefined, b: MirrorPlane | string | undefined): boolean {
  if (typeof a !== "object" || typeof b !== "object") return a === b;
  const la = Math.hypot(...a.normal) || 1;
  const lb = Math.hypot(...b.normal) || 1;
  const na = a.normal.map((v) => v / la);
  const nb = b.normal.map((v) => v / lb);
  const turn = Math.hypot(na[0] - nb[0], na[1] - nb[1], na[2] - nb[2]);
  const off = Math.abs((b.point[0] - a.point[0]) * na[0] + (b.point[1] - a.point[1]) * na[1] + (b.point[2] - a.point[2]) * na[2]);
  return turn < 1e-6 && off < FACE_STILL;
}

/**
 * Mirrors across faces. First the assembly is solved with those mirrors' copies
 * left where they are, to see where each face is; then again, mirroring across
 * those faces — and again while any face still moves (a face on another
 * mirror's copy, which only gets to its place in the pass before). A face that
 * keeps moving is on a part that depends on the mirror's own copies (fastened
 * to one, say): mirroring would chase it for ever, so that mirror's copies are
 * left where they are and it says why.
 */
function solveWithFaceMirrors(input: Assembly, frameOf: FrameLookup, options: SolveOptions): SolveResult {
  const faced = (input.patterns ?? []).filter((p) => p.kind === "mirror" && p.plane);
  const skip: Record<string, string> = Object.fromEntries(faced.map((p) => [p.id, "(first pass)"]));
  let result = solveAssembly(input, frameOf, { ...options, facePlanes: skip });
  let planes = mirrorFacePlanes(input, frameOf, result.placements);
  let stuck: AssemblyPattern[] = [];
  for (let pass = 0; pass < FACE_PASSES; pass++) {
    result = solveAssembly(input, frameOf, { ...options, facePlanes: planes });
    const again = mirrorFacePlanes(input, frameOf, result.placements);
    stuck = faced.filter((p) => !samePlane(planes[p.id], again[p.id]));
    if (!stuck.length) return result;
    planes = again;
  }
  // Still moving: hold those mirrors' copies where they are, and say why.
  const held = { ...planes };
  for (const p of stuck) held[p.id] = "(held)";
  result = solveAssembly(input, frameOf, { ...options, facePlanes: held });
  const patternErrors = { ...result.patternErrors };
  for (const p of stuck)
    patternErrors[p.id] = "This mirror's face is on a part that depends on the mirror's own copies (it's mated to one of them, say), so the copies can't settle. Pick a face on another part, or one of the assembly's planes.";
  return { ...result, patternErrors };
}

export function solveAssembly(input: Assembly, frameOf: FrameLookup, options: SolveOptions = {}): SolveResult {
  // Mirrors across a face: find where the face is first (its part placed by its own mates), then mirror across it.
  if (!options.facePlanes && (input.patterns ?? []).some((p) => p.kind === "mirror" && p.plane)) return solveWithFaceMirrors(input, frameOf, options);
  // Relations (gears, rack and pinion, screws) set the amounts of the mates they drive.
  // Suppressed parts (and the mates on them) are left out; they stay where they were.
  const related = applyRelations(withoutSuppressed(input));
  const assembly = related.assembly;
  // The assembly's origin, when a mate uses it: a part that's always fixed where it is.
  const origin: Instance | null = (assembly.mates ?? []).some((m) => isOrigin(m.a) || isOrigin(m.b))
    ? { id: ORIGIN_ID, partId: ORIGIN_ID, name: "Origin", placement: IDENTITY, fixed: true }
    : null;
  const everything = origin ? [origin, ...assembly.instances] : assembly.instances;
  const instances = new Map(everything.map((i) => [i.id, i]));
  const mateErrors: Record<string, string> = { ...related.errors };

  // Mates that can be used: both parts present, connectors found, values readable.
  interface Usable {
    mate: Mate;
    a: string;
    b: string;
    fa: Frame;
    fb: Frame;
    values: Record<string, number>;
    /** Tangent mates: both sides' surfaces (round one second; `swapped` when that's the first part's). */
    tangent?: { a: TangentSide; b: TangentSide; swapped: boolean };
  }
  /** A join between two instances: a mate, a pattern copy following its original, or two grouped parts (a → b, and back). */
  interface Link {
    u: Usable | null;
    patternId: string | null;
    groupId?: string;
    a: string;
    b: string;
    fwd: (p: Placement) => Placement;
    back: (p: Placement) => Placement;
  }
  const usable: Usable[] = [];
  for (const mate of assembly.mates ?? []) {
    if (mate.suppressed) continue;
    const ia = instances.get(mate.a.instanceId);
    const ib = instances.get(mate.b.instanceId);
    if (!ia || !ib) {
      mateErrors[mate.id] = "One of its parts has been removed from the assembly.";
      continue;
    }
    if (ia.id === ib.id) {
      mateErrors[mate.id] = ia.id === ORIGIN_ID ? "Both connectors are on the origin — pick a face or edge on a part for one of them." : "Both connectors are on the same part — pick a face or edge on another part.";
      continue;
    }
    const fa = frameOf(mate, "a");
    const fb = frameOf(mate, "b");
    if (mate.type === "width" && (!mate.a.pick2 || !mate.b.pick2)) {
      mateErrors[mate.id] = "Pick two faces on each part: the two sides of the slot, then the two sides of what goes in it.";
      continue;
    }
    if (mate.type === "width" && (!fa || !fb)) {
      mateErrors[mate.id] = "A Width mate needs two flat faces on each part, parallel to each other (like the two sides of a slot).";
      continue;
    }
    if (!fa || !fb) {
      mateErrors[mate.id] = "A face or edge it uses can't be found any more (the part has changed too much). Edit the mate and pick it again.";
      continue;
    }
    let tangent: Usable["tangent"];
    if (mate.type === "tangent") {
      const ta = tangentSide(fa);
      const tb = tangentSide(fb);
      if (!ta || !tb || (ta.kind === "plane" && tb.kind === "plane")) {
        mateErrors[mate.id] = "A Tangent mate needs faces, at least one of them round (a cylinder or ball) — like a roller and the flat it runs on.";
        continue;
      }
      // Keep the round one second, so it's the one that rolls.
      tangent = tb.kind === "plane" ? { a: tb, b: ta, swapped: true } : { a: ta, b: tb, swapped: false };
    }
    const { values, errors } = mateValues(mate);
    const bad = Object.keys(errors)[0];
    if (bad) {
      mateErrors[mate.id] = `${MATE_TYPES[mate.type].values.find((d) => d.key === bad)?.label ?? bad}: ${errors[bad]}`;
      continue;
    }
    usable.push({ mate, a: ia.id, b: ib.id, fa, fb, values, ...(tangent ? { tangent } : {}) });
  }

  // The movements loops may adjust: every free amount of every usable mate, within its limits.
  const free: { u: Usable; key: string; min: number; max: number }[] = [];
  for (const u of usable) {
    const { limits } = mateLimits(u.mate);
    for (const def of MATE_TYPES[u.mate.type].values) {
      if (!def.free || related.driven.has(`${u.mate.id}:${def.key}`)) continue;
      const l = limits[def.key];
      free.push({ u, key: def.key, min: l ? l.min : -Infinity, max: l ? l.max : Infinity });
    }
  }
  const start = free.map((f) => f.u.values[f.key]);

  // Pattern copies are held to their originals: each copy is the original moved on by a fixed step.
  const patternErrors: Record<string, string> = {};
  const copyLinks: Link[] = [];
  for (const p of assembly.patterns ?? []) {
    const step = patternStep(p);
    if ("error" in step) {
      patternErrors[p.id] = step.error;
      continue;
    }
    for (const i of assembly.instances) {
      if (i.copyOf?.pattern !== p.id || !instances.has(i.copyOf.seed)) continue;
      if (p.kind === "mirror") {
        // Across a face: the plane where the face is (or, in the first pass, the copy isn't held yet).
        const face = p.plane ? options.facePlanes?.[p.id] : undefined;
        if (p.plane && typeof face !== "object") {
          if (face && face !== "(first pass)" && face !== "(held)") patternErrors[p.id] = face;
          continue;
        }
        const plane: MirrorPlane = typeof face === "object" ? face : axisPlane(p);
        // A mirror-image copy shows the part flipped across its own YZ plane. A copy showing the same hand as its
        // original (a symmetric part shown as itself) is turned instead, using the plane the part is symmetric across.
        const seed = instances.get(i.copyOf.seed)!;
        let own = OWN_YZ;
        if (!!i.mirrored === !!seed.mirrored) {
          const sym = options.symmetry?.(seed) ?? null;
          if (!sym && !patternErrors[p.id])
            patternErrors[p.id] = `${seed.name} isn't symmetric (any more), so showing the same part can't make a true mirror image. Untick "Same part for symmetric parts" to make a mirror-image copy.`;
          // (On a mirrored original, the part's own plane is flipped across its YZ plane too.)
          if (sym) own = seed.mirrored && sym.axis === "x" ? { axis: "x", at: -sym.at } : sym;
        }
        // Mirroring is its own undoing: the copy is the original's mirror image, and the other way round.
        const flip = (q: Placement) => mirrorAcross(plane, q, own);
        copyLinks.push({ u: null, patternId: p.id, a: i.copyOf.seed, b: i.id, fwd: flip, back: flip });
        continue;
      }
      const shift = placeCopy(p, step.step, IDENTITY, i.copyOf.index);
      const back = invert(shift);
      copyLinks.push({ u: null, patternId: p.id, a: i.copyOf.seed, b: i.id, fwd: (q) => compose(shift, q), back: (q) => compose(back, q) });
    }
  }

  // Grouped parts are held where they were grouped, relative to the group's first part.
  const groupLinks: Link[] = [];
  for (const g of assembly.groups ?? []) {
    if (!instances.has(g.members[0])) continue;
    for (const m of g.members.slice(1)) {
      const rel = g.offsets[m];
      if (!rel || !instances.has(m)) continue;
      const inv = invert(rel);
      groupLinks.push({ u: null, patternId: null, groupId: g.id, a: g.members[0], b: m, fwd: (q) => compose(q, rel), back: (q) => compose(q, inv) });
    }
  }
  /** Grouped parts other than each group's first: placed from their group rather than started from. */
  const followers = new Set((assembly.groups ?? []).flatMap((g) => g.members.slice(1)));

  /** Where the second part sits relative to the first. */
  const mateRelation = (u: Usable, v: Record<string, number>): Placement => {
    const t = u.tangent;
    if (!t) return compose(compose(framePlacement(u.fa), mateOffset(u.mate.type, v, u.mate.flip)), invert(framePlacement(u.fb)));
    const rel = compose(compose(framePlacement(t.a.frame), tangentOffset(t.a, t.b, v)), invert(framePlacement(t.b.frame)));
    return t.swapped ? invert(rel) : rel;
  };

  /** One pass outwards from the fixed parts with these free amounts; closures = links reaching a part already placed. */
  const spread = (x: number[]) => {
    const values = new Map(usable.map((u) => [u, { ...u.values }]));
    free.forEach((f, i) => (values.get(f.u)![f.key] = x[i]));
    const links: Link[] = [
      ...usable.map((u): Link => {
        const rel = mateRelation(u, values.get(u)!);
        const inv = invert(rel);
        return { u, patternId: null, a: u.a, b: u.b, fwd: (q) => compose(q, rel), back: (q) => compose(q, inv) };
      }),
      ...copyLinks,
      ...groupLinks,
    ];
    const placements: Record<string, Placement> = {};
    const drivenBy: Record<string, string> = {};
    const closures: { link: Link; target: Placement; already: Placement; fixedPair: boolean }[] = [];
    const starts = [
      ...everything.filter((i) => i.fixed),
      ...everything.filter((i) => !i.fixed && !followers.has(i.id)),
      ...everything.filter((i) => !i.fixed && followers.has(i.id)),
    ];
    for (const st of starts) {
      if (placements[st.id]) continue;
      placements[st.id] = st.placement;
      const queue = [st.id];
      const used = new Set<Link>();
      while (queue.length) {
        const id = queue.shift()!;
        for (const link of links) {
          if ((link.a !== id && link.b !== id) || used.has(link)) continue;
          used.add(link);
          const other = link.a === id ? link.b : link.a;
          const target = link.a === id ? link.fwd(placements[id]) : link.back(placements[id]);
          const already = placements[other];
          if (already) {
            closures.push({ link, target, already, fixedPair: !!instances.get(link.a)?.fixed && !!instances.get(link.b)?.fixed });
            continue;
          }
          const o = instances.get(other)!;
          if (o.fixed) {
            // Reached a second fixed part: it stays put; the link closes the loop only if it fits.
            placements[other] = o.placement;
            closures.push({ link, target, already: o.placement, fixedPair: !!instances.get(id)?.fixed });
            queue.push(other);
            continue;
          }
          placements[other] = target;
          if (link.u) drivenBy[other] = link.u.mate.id;
          else if (link.groupId) drivenBy[other] = `group:${link.groupId}`;
          else if (link.b === other) drivenBy[other] = `pattern:${link.patternId}`;
          queue.push(other);
        }
      }
    }
    return { placements, drivenBy, closures, values };
  };

  /** How far each closing mate is from fitting: position gap (mm) and turn (weighted), 6 numbers per closure. */
  const residual = (x: number[]): number[] => {
    const out: number[] = [];
    for (const c of spread(x).closures) {
      const d = sub(c.target.position, c.already.position);
      let q = quatMultiply(quatConjugate(c.already.rotation), c.target.rotation);
      if (q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
      out.push(d[0], d[1], d[2], 2 * TURN_WEIGHT * q[0], 2 * TURN_WEIGHT * q[1], 2 * TURN_WEIGHT * q[2]);
    }
    return out;
  };
  const size = (r: number[]) => Math.sqrt(r.reduce((t, v) => t + v * v, 0));
  const clampX = (x: number[]) => x.map((v, i) => Math.max(free[i].min, Math.min(free[i].max, v)));

  let x = start;
  let r = residual(x);
  if (r.length && free.length && size(r) > 1e-6) {
    // First move only the mates that weren't just set; then, if that can't close the loop, all of them.
    const hold = new Set(options.hold ?? []);
    const movable = free.map((_, i) => i).filter((i) => !hold.has(free[i].u.mate.id));
    if (movable.length && movable.length < free.length) {
      const expand = (xs: number[]) => {
        const full = [...start];
        movable.forEach((i, k) => (full[i] = xs[k]));
        return full;
      };
      const pickMovable = (full: number[]) => movable.map((i) => full[i]);
      x = expand(closeLoops(pickMovable(start), (xs) => residual(expand(xs)), (xs) => pickMovable(clampX(expand(xs)))));
    }
    if (size(residual(x)) > 1e-6) x = closeLoops(x, residual, clampX);
  }
  const result = spread(x);
  r = residual(x);
  // When a loop can't close, is a limit what's stopping it? Try again without limits: blame the
  // amounts that would then go past their limits, if the loop closes that way.
  const failed = r.some((v) => Math.abs(v) > 1e-3);
  let atLimit: string | null = null;
  if (failed && free.some((f) => Number.isFinite(f.min) || Number.isFinite(f.max))) {
    const loose = closeLoops(x, residual);
    if (size(residual(loose)) < 1e-4) {
      const beyond = free.findIndex((f, i) => loose[i] < f.min - 1e-6 || loose[i] > f.max + 1e-6);
      if (beyond >= 0) {
        const f = free[beyond];
        atLimit = `${f.u.mate.name} (${MATE_TYPES[f.u.mate.type].values.find((d) => d.key === f.key)?.label ?? f.key})`;
      }
    }
  }
  // Report the closing mates that still don't fit.
  const groupErrors: Record<string, string> = {};
  result.closures.forEach((c, i) => {
    const bad = r.slice(6 * i, 6 * i + 6).some((v) => Math.abs(v) > 1e-3);
    if (bad && c.link.groupId && !groupErrors[c.link.groupId]) {
      groupErrors[c.link.groupId] = c.fixedPair
        ? "Two of its parts are fixed in places that don't match how they were grouped. Unfix one."
        : "Its parts are also held by mates (or fixed parts) somewhere other than where they were grouped. Delete those mates, or ungroup.";
    }
    if (bad && !c.link.u && c.link.patternId && !patternErrors[c.link.patternId]) {
      patternErrors[c.link.patternId] = c.fixedPair
        ? "A copy and its original are both fixed — unfix one, so the copy can follow the original."
        : "A copy is held by a mate somewhere other than where the pattern puts it. Delete that mate, or mate the original instead.";
    }
    if (bad && c.link.u && !mateErrors[c.link.u.mate.id]) {
      mateErrors[c.link.u.mate.id] = c.fixedPair
        ? "Both parts are fixed, so this mate can't move either of them. Unfix one."
        : atLimit
          ? `This mate can't be met: ${atLimit} has reached its limit. Widen the limit, or move the parts back.`
          : "This mate can't be met together with the other mates on the same parts — they pull against each other. Suppress or delete one, or let one of them move (a Hinge or Slider instead of Fasten).";
    }
  });
  // Movements the loop solver changed, so they can be stored and the next solve starts there —
  // only when every loop closed (a failed attempt's amounts mean nothing).
  const adjusted: Record<string, Record<string, number>> = {};
  if (!failed) {
    free.forEach((f, i) => {
      if (Math.abs(x[i] - start[i]) > 1e-9) (adjusted[f.u.mate.id] ??= {})[f.key] = x[i];
    });
  }
  for (const i of input.instances) if (i.suppressed && !result.placements[i.id]) result.placements[i.id] = i.placement;
  // The origin isn't a part: it's only there to be mated to.
  delete result.placements[ORIGIN_ID];
  return {
    placements: result.placements,
    mateErrors,
    drivenBy: result.drivenBy,
    adjusted,
    ...(Object.keys(patternErrors).length ? { patternErrors } : {}),
    ...(Object.keys(groupErrors).length ? { groupErrors } : {}),
  };
}

/**
 * Close loops of mates: find movement amounts near `start` that make every
 * residual zero (damped least squares — Levenberg–Marquardt — with numerical
 * slopes), keeping each amount within its limits. Small changes are preferred,
 * so dragging one part of a linkage moves the rest as little as needed.
 */
export function closeLoops(start: number[], residual: (x: number[]) => number[], clamp: (x: number[]) => number[] = (x) => x): number[] {
  let x = [...start];
  let r = residual(x);
  const cost = (v: number[]) => v.reduce((t, a) => t + a * a, 0);
  let c = cost(r);
  let lambda = 1e-3;
  const n = x.length;
  for (let iter = 0; iter < 100 && c > 1e-12; iter++) {
    // Numerical slopes of each residual against each amount.
    const J: number[][] = [];
    for (let j = 0; j < n; j++) {
      const h = 1e-5 * Math.max(1, Math.abs(x[j]));
      const xp = [...x];
      xp[j] += h;
      const rp = residual(xp);
      J.push(rp.map((v, i) => (v - r[i]) / h));
    }
    // (JᵀJ + λ diag) δ = −Jᵀ r
    const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, k) => J[i].reduce((t, v, m) => t + v * J[k][m], 0)));
    const g = Array.from({ length: n }, (_, i) => J[i].reduce((t, v, m) => t + v * r[m], 0));
    let improved = false;
    for (let tries = 0; tries < 10 && !improved; tries++) {
      const M = A.map((row, i) => row.map((v, k) => (i === k ? v + lambda * (v + 1e-9) + lambda * 1e-6 : v)));
      const step = solveLinear(M, g.map((v) => -v));
      if (!step) {
        lambda *= 10;
        continue;
      }
      const xn = clamp(x.map((v, i) => v + step[i]));
      const rn = residual(xn);
      const cn = cost(rn);
      if (cn < c) {
        x = xn;
        r = rn;
        c = cn;
        lambda = Math.max(lambda / 10, 1e-9);
        improved = true;
      } else lambda *= 10;
    }
    if (!improved) break;
  }
  return x;
}

/** Solve M x = b (Gaussian elimination with partial pivoting); null if M is singular. */
function solveLinear(M: number[][], b: number[]): number[] | null {
  const n = b.length;
  const a = M.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let i = col + 1; i < n; i++) if (Math.abs(a[i][col]) > Math.abs(a[piv][col])) piv = i;
    if (Math.abs(a[piv][col]) < 1e-14) return null;
    [a[col], a[piv]] = [a[piv], a[col]];
    for (let i = 0; i < n; i++) {
      if (i === col) continue;
      const f = a[i][col] / a[col][col];
      for (let k = col; k <= n; k++) a[i][k] -= f * a[col][k];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

/** Mirrored copies of symmetric parts shown as the part itself: the plane each part is symmetric across (from its shape). */
const symmetryOn = (parts: readonly PartMesh[]) => (i: Instance) => {
  const mesh = i.subAssembly ? undefined : findMesh(parts, meshIdOf(i));
  return mesh ? ownSymmetry(mesh) : null;
};

/** Solve using the parts as built now (pass the document's assemblies when it may hold sub-assemblies). */
export function solveWithParts(assembly: Assembly, parts: PartMesh[], options: SolveOptions = {}): SolveResult {
  const r = solveAssembly(assembly, frameLookup(assembly, parts, options.assemblies), { symmetry: symmetryOn(parts), ...options });
  // A connector on a part inside a sub-assembly: say plainly when the way to it is switched off or gone.
  for (const m of assembly.mates ?? []) {
    if (!r.mateErrors[m.id]) continue;
    const second = (c: MateConnector) => (c.path2 ? pathProblem(assembly, { instanceId: c.instanceId, path: c.path2 }, options.assemblies) : null);
    const problem = pathProblem(assembly, m.a, options.assemblies) ?? pathProblem(assembly, m.b, options.assemblies) ?? second(m.a) ?? second(m.b);
    if (problem) r.mateErrors[m.id] = problem.kind === "suppressed" ? `${problem.text}. Unsuppress it, or edit the mate and pick another face.` : problem.text;
  }
  return r;
}

/**
 * Where each mate's connectors are on the parts as built now — on the part as
 * each instance shows it (another configuration, or mirrored, or a part inside
 * a sub-assembly, where that sub-assembly's own mates put it).
 */
export function frameLookup(assembly: Assembly, parts: PartMesh[], assemblies?: readonly Assembly[]): FrameLookup {
  return (mate, side) => connectorFrameFor(assembly, parts, mate[side], assemblies);
}

/**
 * One connector's frame on its instance, as the instance shows its part (null
 * if it can't be found). On a sub-assembly, the frame is in the sub-assembly's
 * own coordinates: the part's frame moved to where the part sits inside it.
 * `within` lists the assemblies already being looked into (so a loop of
 * sub-assemblies can't go round for ever).
 */
export function connectorFrameFor(assembly: Assembly, parts: PartMesh[], c: MateConnector, assemblies?: readonly Assembly[], within: readonly string[] = []): Frame | null {
  // The assembly's origin: one of its planes.
  if (isOrigin(c)) return originFrame(c);
  // On the part as the instance shows it (which may be another configuration).
  const instance = assembly.instances.find((i) => i.id === c.instanceId);
  // A Width mate's two faces on two parts of one sub-assembly copy (a slot made by two plates): each face found
  // on its own part, in the sub-assembly's coordinates, and the connector halfway between them.
  if (c.pick2 && c.path2 && instance?.subAssembly) {
    if (c.pick.ref.kind !== "face" || c.pick2.ref.kind !== "face" || c.pick.ref.surface !== "PLANE" || c.pick2.ref.surface !== "PLANE") return null;
    const { pick2, path2, spot: _s, point: _p, ...first } = c;
    const f1 = connectorFrameFor(assembly, parts, first, assemblies, within);
    const f2 = connectorFrameFor(assembly, parts, { instanceId: c.instanceId, path: path2, pick: pick2 }, assemblies, within);
    return f1 && f2 ? widthFrame(f1, f2) : null;
  }
  if (instance?.subAssembly) return frameInside(instance.subAssembly, parts, c, assemblies, within);
  // Always on the part the instance shows now (if it was replaced, the most similar face or edge of the new one).
  const mesh = instance ? findMesh(parts, meshIdOf(instance)) : undefined;
  if (instance && !mesh) return null;
  const f = mesh
    ? connectorFrameOnParts([mesh], { ...c, pick: { ...c.pick, partId: mesh.id }, ...(c.pick2 ? { pick2: { ...c.pick2, partId: mesh.id } } : {}) })
    : connectorFrameOnParts(parts, c);
  // A mirrored instance shows its part flipped across its own YZ plane: so are its connectors.
  if (f && instance?.mirrored) {
    const flipX = (v: Vec3): Vec3 => [-v[0], v[1], v[2]];
    return { ...f, origin: flipX(f.origin), z: flipX(f.z), x: flipX(f.x) };
  }
  return f;
}

/** A frame moved by a placement. */
export function placeFrame(p: Placement, f: Frame): Frame {
  return { ...f, origin: applyPlacement(p, f.origin), z: rotate(p.rotation, f.z), x: rotate(p.rotation, f.x) };
}

/** A connector on a part inside sub-assembly `subId` (its `path` leads to the part), in the sub-assembly's coordinates. */
function frameInside(subId: string, parts: PartMesh[], c: MateConnector, assemblies: readonly Assembly[] | undefined, within: readonly string[]): Frame | null {
  const sub = assemblies?.find((a) => a.id === subId);
  const [first, ...rest] = c.path ?? [];
  if (!sub || !first || within.includes(subId)) return null;
  const inner = sub.instances.find((i) => i.id === first);
  if (!inner || inner.suppressed) return null;
  const deeper = within.concat(subId);
  const { path: _p, ...plain } = c;
  const f = connectorFrameFor(sub, parts, { ...plain, instanceId: first, ...(rest.length ? { path: rest } : {}) }, assemblies, deeper);
  if (!f) return null;
  return placeFrame(solvedInside(sub, parts, assemblies, deeper)[first] ?? inner.placement, f);
}

/** Solved sub-assemblies, by the document's assemblies, the parts as built and the variables' values (all unchanged objects mean the same answer). */
const insideCache = new WeakMap<readonly Assembly[], WeakMap<readonly PartMesh[], WeakMap<Scope, Map<string, Record<string, Placement>>>>>();

/**
 * Where an assembly's own mates put each of its instances, when it's used as
 * a sub-assembly (it moves as one piece, so this never changes with where it's
 * placed). Worked out once for each state of the document and parts.
 */
export function solvedInside(sub: Assembly, parts: readonly PartMesh[], assemblies?: readonly Assembly[], within: readonly string[] = [sub.id]): Record<string, Placement> {
  const solve = () => solveAssembly(sub, (m, side) => connectorFrameFor(sub, parts as PartMesh[], m[side], assemblies, within), { symmetry: symmetryOn(parts) }).placements;
  if (!assemblies) return solve();
  let byParts = insideCache.get(assemblies);
  if (!byParts) insideCache.set(assemblies, (byParts = new WeakMap()));
  let byScope = byParts.get(parts);
  if (!byScope) byParts.set(parts, (byScope = new WeakMap()));
  const scope = getCurrentScope();
  let byId = byScope.get(scope);
  if (!byId) byScope.set(scope, (byId = new Map()));
  let out = byId.get(sub.id);
  if (!out) byId.set(sub.id, (out = solve()));
  return out;
}

/** Next free mate name, e.g. "Hinge 2". */
export function nextMateName(assembly: Assembly, type: MateType): string {
  const prefix = MATE_TYPES[type].label;
  const used = new Set((assembly.mates ?? []).map((m) => m.name));
  let n = 1;
  while (used.has(`${prefix} ${n}`)) n++;
  return `${prefix} ${n}`;
}

/**
 * True when a click would join a face of one part inside a sub-assembly copy
 * to another part inside the same copy. The copy moves as one piece, so that
 * mate can't do anything: the click is refused (the picks so far are kept) and
 * the sub-assembly should be opened to mate its own parts.
 */
export function samePieceClick(m: { type: MateType; a?: MateConnector; b?: MateConnector }, c: MateConnector): boolean {
  if (isOrigin(c)) return false;
  // The side the click would add to: the first part while the second isn't picked (or, for Width mates, a side still waiting for its second face).
  const open = m.type === "width" ? (m.a && !m.a.pick2 ? m.a : m.a && !m.b ? m.a : m.b && !m.b.pick2 ? m.b : undefined) : m.a && !m.b ? m.a : undefined;
  if (!open || open.instanceId !== c.instanceId) return false;
  // A Width mate's second face may be on another part of the same copy (a slot made by two plates): that's allowed.
  if (m.type === "width" && !open.pick2) return false;
  const key = (x: MateConnector) => (x.path ?? []).join("/");
  return (!!open.path?.length || !!c.path?.length) && key(open) !== key(c);
}

/**
 * The mate dialog's next pick: the first click is the part that stays put,
 * the second the part to move (a click on the first part again starts over).
 * The origin always goes first — it never moves — so a part already picked
 * moves over to second place.
 */
export function pickConnector(m: { type: MateType; a?: MateConnector; b?: MateConnector }, c: MateConnector): { a?: MateConnector; b?: MateConnector } {
  if (m.type === "width") return pickWidthFace(m, c);
  if (isOrigin(c)) return { a: c, b: [m.b, m.a].find((x) => x && !isOrigin(x)) };
  if (!m.a || (m.a && m.b) || (!m.b && m.a.instanceId === c.instanceId)) return { a: c, b: undefined };
  return { a: m.a, b: c };
}

/**
 * Width mates take two faces on each part: the two sides of the slot (on the
 * part that stays put), then the two sides of what goes in it. A click on a
 * part other than the one being picked moves on to (or starts) the other side.
 */
export function pickWidthFace(m: { a?: MateConnector; b?: MateConnector }, c: MateConnector): { a?: MateConnector; b?: MateConnector } {
  // The second face of a side: on the same part, or (in a sub-assembly copy) on another part of the same copy.
  const samePath = (side: MateConnector) => (side.path ?? []).join("/") === (c.path ?? []).join("/");
  const add = (side: MateConnector | undefined) =>
    side && side.instanceId === c.instanceId && !side.pick2 && !(samePath(side) && sameRef(side.pick.ref, c.pick.ref))
      ? { ...side, pick2: c.pick, ...(samePath(side) ? {} : { path2: c.path ?? [] }) }
      : null;
  if (!m.a) return { a: c, b: undefined };
  if (!m.a.pick2) {
    const a = add(m.a);
    return a ? { a, b: undefined } : { a: c, b: undefined };
  }
  if (!m.b) return m.a.instanceId === c.instanceId ? { a: c, b: undefined } : { a: m.a, b: c };
  if (!m.b.pick2) {
    const b = add(m.b);
    if (b) return { a: m.a, b };
    return m.a.instanceId === c.instanceId ? { a: c, b: undefined } : { a: m.a, b: c };
  }
  // Both sides done: start again.
  return { a: c, b: undefined };
}
