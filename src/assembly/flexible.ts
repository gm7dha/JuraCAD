/**
 * Flexible sub-assemblies (Onshape's "Make flexible"). A sub-assembly is
 * normally one rigid piece: its parts sit where its own mates put them, and
 * the parent moves it as a whole. A flexible copy instead lets its parts move
 * in the parent: its own parts and mates join the parent's solve, so mating
 * one of its parts can move that part inside it — a hinge opens when the
 * parent mates its leaf to something.
 *
 * The solver sees a "flattened" assembly (`expandFlexible`): the flexible
 * copy stays as an instance of its own — its frame, placed by the parent like
 * any copy — and each instance inside it becomes an instance of the parent too,
 * named by its key ("copy/part", "copy/inner/part" for a flexible one inside a
 * flexible one), with the sub-assembly's mates, patterns, groups and relations
 * carried along (their ids prefixed the same way). Its fixed parts are held to
 * the frame where they sit inside it; its other parts start there too, unless
 * a mate places them first (so an unmated sub-assembly looks exactly as it
 * would rigid). Pure: no parts, no solver, so it's tested on its own.
 */
import type { Assembly, AssemblyGroup, AssemblyPattern, Instance, Mate, MateConnector, MateRelation } from "../model/types";
import { compose, IDENTITY, invert, type Placement } from "./math";
import { ORIGIN_ID } from "./origin";

export const FLEX_SEP = "/";

/** True when the instance is a sub-assembly copy that's flexible (a mirrored copy never is). */
export const isFlexible = (i: Pick<Instance, "subAssembly" | "flexible" | "mirrored">): boolean => !!i.subAssembly && !!i.flexible && !i.mirrored;

/** True when an assembly has a flexible sub-assembly copy that's switched on (its own solve then needs flattening). */
export const hasFlexible = (a: Assembly): boolean => a.instances.some((i) => !i.suppressed && isFlexible(i));

/** How a part of a flexible sub-assembly is held in the solve. */
export interface FlexBody {
  /** The instance it belongs to: the copy's frame ("copy"), or a flexible copy inside it ("copy/inner"). */
  frame: string;
  /** Where it sits relative to that frame inside the sub-assembly (as the sub-assembly's own mates put it). */
  rel: Placement;
  /** Fixed inside the sub-assembly: held to the frame there. Otherwise it only starts there when nothing else places it. */
  fixed: boolean;
  /** The top-level flexible copy it's in. */
  top: string;
}

export interface FlexView {
  /** The assembly as the solver sees it. */
  assembly: Assembly;
  /** Every instance brought in from a flexible copy, by its key. */
  bodies: Record<string, FlexBody>;
  /** Patterns brought in from a flexible copy: the instance whose frame their directions and planes are in. */
  patternFrames: Record<string, string>;
  /** The top-level copy each brought-in mate, pattern and group came from, and its own name there. */
  from: Record<string, { top: string; name: string }>;
  /** Mates of the assembly that can't be used flexibly, with why (plain words). */
  errors: Record<string, string>;
}

/**
 * Where an assembly's own solve puts its instances (in its own coordinates),
 * including — under their keys — the parts of its own flexible copies.
 */
export type InsideSolve = (sub: Assembly, within: string[]) => Record<string, Placement>;

const key = (...ids: string[]) => ids.join(FLEX_SEP);

/** The origin of a flexible copy, as a part of the flattened assembly held to its frame. */
export const isCopyOrigin = (id: string): boolean => id.endsWith(FLEX_SEP + ORIGIN_ID);

/** An instance's flexible flag taken off (the frame of a flattened copy is just a place). */
function asFrame(i: Instance): Instance {
  const { flexible: _f, ...rest } = i;
  return rest;
}

/**
 * The assembly flattened for its solve: each flexible copy's parts and mates
 * brought in (see the top of this file). An assembly without flexible copies
 * comes back as it is (the same object).
 */
export function expandFlexible(a: Assembly, assemblies: readonly Assembly[], inside: InsideSolve, within: readonly string[] = [a.id]): FlexView {
  const empty: FlexView = { assembly: a, bodies: {}, patternFrames: {}, from: {}, errors: {} };
  if (!hasFlexible(a)) return empty;
  const instances: Instance[] = [];
  const bodies: Record<string, FlexBody> = {};
  const patternFrames: Record<string, string> = {};
  const from: FlexView["from"] = {};
  const mates: Mate[] = [];
  const patterns: AssemblyPattern[] = [];
  const groups: AssemblyGroup[] = [];
  const relations: MateRelation[] = [];
  const lift = (prefix: string, c: MateConnector): MateConnector => ({ ...c, instanceId: key(prefix, c.instanceId) });

  for (const i of a.instances) {
    const sub = isFlexible(i) && !i.suppressed ? assemblies.find((x) => x.id === i.subAssembly) : undefined;
    if (!sub || within.includes(sub.id)) {
      instances.push(i);
      continue;
    }
    instances.push(asFrame(i));
    const deeper = [...within, sub.id];
    const inner = expandFlexible(sub, assemblies, inside, deeper);
    const places = inside(sub, deeper);
    const placeOf = (id: string): Placement => places[id] ?? inner.assembly.instances.find((j) => j.id === id)?.placement ?? IDENTITY;
    for (const j of inner.assembly.instances) {
      const id = key(i.id, j.id);
      const own = inner.bodies[j.id];
      const frame = own ? key(i.id, own.frame) : i.id;
      const rel = own ? own.rel : placeOf(j.id);
      bodies[id] = { frame, rel, fixed: own ? own.fixed : j.fixed, top: i.id };
      const copyOf = j.copyOf ? { copyOf: { ...j.copyOf, pattern: key(i.id, j.copyOf.pattern), seed: key(i.id, j.copyOf.seed) } } : {};
      instances.push({ ...j, id, name: `${i.name} / ${j.name}`, placement: compose(i.placement, placeOf(j.id)), fixed: false, ...copyOf, ...(i.suppressed ? { suppressed: true } : {}) });
    }
    // The sub-assembly's own origin, when its mates or mirrors use it: a point held to its frame.
    const usesOrigin =
      (inner.assembly.mates ?? []).some((m) => m.a.instanceId === ORIGIN_ID || m.b.instanceId === ORIGIN_ID) ||
      (inner.assembly.patterns ?? []).some((p) => p.plane?.instanceId === ORIGIN_ID);
    if (usesOrigin) {
      const id = key(i.id, ORIGIN_ID);
      bodies[id] = { frame: i.id, rel: IDENTITY, fixed: true, top: i.id };
      instances.push({ id, partId: ORIGIN_ID, name: `${i.name} / Origin`, placement: i.placement, fixed: false });
    }
    const came = (id: string, name: string) => (from[key(i.id, id)] = { top: i.id, name: inner.from[id]?.name ?? name });
    for (const m of inner.assembly.mates ?? []) {
      came(m.id, m.name);
      mates.push({ ...m, id: key(i.id, m.id), a: lift(i.id, m.a), b: lift(i.id, m.b) });
    }
    for (const p of inner.assembly.patterns ?? []) {
      came(p.id, p.name);
      const pid = key(i.id, p.id);
      patternFrames[pid] = inner.patternFrames[p.id] ? key(i.id, inner.patternFrames[p.id]) : i.id;
      patterns.push({ ...p, id: pid, seeds: p.seeds.map((s) => key(i.id, s)), ...(p.plane ? { plane: lift(i.id, p.plane) } : {}) });
    }
    for (const g of inner.assembly.groups ?? []) {
      came(g.id, g.name);
      groups.push({ ...g, id: key(i.id, g.id), members: g.members.map((m) => key(i.id, m)), offsets: Object.fromEntries(Object.entries(g.offsets).map(([m, o]) => [key(i.id, m), o])) });
    }
    for (const r of inner.assembly.relations ?? []) {
      came(r.id, r.name);
      relations.push({ ...r, id: key(i.id, r.id), driver: key(i.id, r.driver), driven: key(i.id, r.driven) });
    }
  }

  const ids = new Set(instances.map((i) => i.id));
  const errors: Record<string, string> = {};
  /** A connector of this assembly's, on a part inside a flexible copy: on that part's own instance now. */
  const resolve = (c: MateConnector): MateConnector | string => {
    if (!c.path?.length || !bodies[key(c.instanceId, c.path[0])]) return c;
    const down = (path: readonly string[]) => {
      for (let k = path.length; k > 0; k--) {
        const id = key(c.instanceId, ...path.slice(0, k));
        if (ids.has(id)) return { id, rest: path.slice(k) };
      }
      return null;
    };
    const first = down(c.path);
    if (!first) return c;
    const { path: _p, path2: _p2, ...plain } = c;
    const out: MateConnector = { ...plain, instanceId: first.id, ...(first.rest.length ? { path: first.rest } : {}) };
    if (c.path2) {
      const second = down(c.path2);
      if (!second || second.id !== first.id)
        return `Its two faces on ${a.instances.find((i) => i.id === c.instanceId)?.name ?? "the sub-assembly"} are on parts that can move apart (it's flexible). Pick both faces on one part, or untick Flexible.`;
      if (second.rest.length) out.path2 = second.rest;
    }
    return out;
  };
  for (const m of a.mates ?? []) {
    const ra = resolve(m.a);
    const rb = resolve(m.b);
    if (typeof ra === "string" || typeof rb === "string") {
      errors[m.id] = typeof ra === "string" ? ra : (rb as string);
      continue;
    }
    mates.push(ra === m.a && rb === m.b ? m : { ...m, a: ra, b: rb });
  }
  // (This assembly's own patterns first, in their order, then the brought-in ones.)
  const ordered = [
    ...(a.patterns ?? []).map((p) => {
      const plane = p.plane ? resolve(p.plane) : undefined;
      return typeof plane === "object" && plane !== p.plane ? { ...p, plane } : p;
    }),
    ...patterns,
  ];
  const own = (list: readonly unknown[] | undefined) => list?.length ?? 0;
  const { mates: _m, patterns: _p, groups: _g, relations: _r, ...rest } = a;
  return {
    assembly: {
      ...rest,
      instances,
      ...(mates.length ? { mates } : {}),
      ...(ordered.length ? { patterns: ordered } : {}),
      ...(own(a.groups) || groups.length ? { groups: [...(a.groups ?? []), ...groups] } : {}),
      ...(own(a.relations) || relations.length ? { relations: [...(a.relations ?? []), ...relations] } : {}),
    },
    bodies,
    patternFrames,
    from,
    errors,
  };
}

/** Where a brought-in part sits relative to its top-level copy, from where the solve put both. */
export function relativeToTop(placements: Record<string, Placement>, id: string, top: string): Placement | null {
  const p = placements[id];
  const t = placements[top];
  return p && t ? compose(invert(t), p) : null;
}

/** Make a sub-assembly copy flexible, or rigid again (other instances, and parts, are left alone). */
export function setFlexible(a: Assembly, id: string, flexible: boolean): Assembly {
  return {
    ...a,
    instances: a.instances.map((i) => {
      if (i.id !== id || !i.subAssembly) return i;
      if (flexible) return { ...i, flexible: true };
      const { flexible: _f, ...rest } = i;
      return rest;
    }),
  };
}
