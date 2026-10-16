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
import { evaluate } from "../model/expr";
import type { Assembly, Mate, MateConnector, MateType } from "../model/types";
import { sameRef } from "../geometry/topoRef";
import { compose, IDENTITY, invert, quatConjugate, quatFromAxisAngle, quatFromEulerDeg, quatMultiply, sub, type Placement } from "./math";
import { connectorFrameOnParts, framePlacement, type Frame } from "./connectors";
import { patternStep, placeCopy } from "./patterns";
import { findMesh, meshIdOf } from "./configured";
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

export const MATE_ORDER: MateType[] = ["fastened", "revolute", "slider", "cylindrical", "planar", "pinSlot", "parallel", "width", "ball"];

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
export function solveAssembly(input: Assembly, frameOf: FrameLookup): SolveResult {
  // Relations (gears, rack and pinion, screws) set the amounts of the mates they drive.
  const related = applyRelations(input);
  const assembly = related.assembly;
  const instances = new Map(assembly.instances.map((i) => [i.id, i]));
  const mateErrors: Record<string, string> = { ...related.errors };

  // Mates that can be used: both parts present, connectors found, values readable.
  interface Usable {
    mate: Mate;
    a: string;
    b: string;
    fa: Frame;
    fb: Frame;
    values: Record<string, number>;
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
      mateErrors[mate.id] = "Both connectors are on the same part — pick a face or edge on another part.";
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
    const { values, errors } = mateValues(mate);
    const bad = Object.keys(errors)[0];
    if (bad) {
      mateErrors[mate.id] = `${MATE_TYPES[mate.type].values.find((d) => d.key === bad)?.label ?? bad}: ${errors[bad]}`;
      continue;
    }
    usable.push({ mate, a: ia.id, b: ib.id, fa, fb, values });
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

  /** One pass outwards from the fixed parts with these free amounts; closures = links reaching a part already placed. */
  const spread = (x: number[]) => {
    const values = new Map(usable.map((u) => [u, { ...u.values }]));
    free.forEach((f, i) => (values.get(f.u)![f.key] = x[i]));
    const links: Link[] = [
      ...usable.map((u): Link => {
        const rel = compose(compose(framePlacement(u.fa), mateOffset(u.mate.type, values.get(u)!, u.mate.flip)), invert(framePlacement(u.fb)));
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
      ...assembly.instances.filter((i) => i.fixed),
      ...assembly.instances.filter((i) => !i.fixed && !followers.has(i.id)),
      ...assembly.instances.filter((i) => !i.fixed && followers.has(i.id)),
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
  if (r.length && free.length && size(r) > 1e-6) x = closeLoops(start, residual, clampX);
  const result = spread(x);
  r = residual(x);
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
        : "This mate can't be met together with the other mates on the same parts — they pull against each other. Suppress or delete one, or let one of them move (a Hinge or Slider instead of Fasten).";
    }
  });
  // Movements the loop solver changed, so the mate dialogs can show where things ended up.
  const adjusted: Record<string, Record<string, number>> = {};
  free.forEach((f, i) => {
    if (Math.abs(x[i] - start[i]) > 1e-9) (adjusted[f.u.mate.id] ??= {})[f.key] = x[i];
  });
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

/** Solve using the parts as built now. */
export function solveWithParts(assembly: Assembly, parts: PartMesh[]): SolveResult {
  return solveAssembly(assembly, (mate, side) => {
    // On the part as the instance shows it (which may be another configuration).
    const instance = assembly.instances.find((i) => i.id === mate[side].instanceId);
    const mesh = instance?.configuration ? findMesh(parts, meshIdOf(instance)) : undefined;
    const c = mate[side];
    return mesh
      ? connectorFrameOnParts([mesh], { pick: { ...c.pick, partId: mesh.id }, ...(c.pick2 ? { pick2: { ...c.pick2, partId: mesh.id } } : {}) })
      : connectorFrameOnParts(parts, c);
  });
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
 * Width mates take two faces on each part: the two sides of the slot (on the
 * part that stays put), then the two sides of what goes in it. A click on a
 * part other than the one being picked moves on to (or starts) the other side.
 */
export function pickWidthFace(m: { a?: MateConnector; b?: MateConnector }, c: MateConnector): { a?: MateConnector; b?: MateConnector } {
  const add = (side: MateConnector | undefined) =>
    side && side.instanceId === c.instanceId && !side.pick2 && !sameRef(side.pick.ref, c.pick.ref) ? { ...side, pick2: c.pick } : null;
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
