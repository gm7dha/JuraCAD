/**
 * Suppressed instances (Onshape's Suppress): a part switched off for now. It
 * stays in the Instances list (greyed out) so it can be switched back on, but
 * it's hidden, left out of the parts list, exports, clash checks and the
 * solver, and the mates on it do nothing until it's back.
 */
import type { Assembly, Mate } from "../model/types";
import { tidyGroups } from "./groups";
import { pathProblem } from "./paths";

/** True when the instance is switched off. */
export function isSuppressed(a: Assembly, instanceId: string): boolean {
  return a.instances.some((i) => i.id === instanceId && i.suppressed === true);
}

/**
 * Why a mate isn't doing anything, in plain words: it's suppressed itself, or
 * one of its parts is. Null when it's in use.
 */
export function mateInactive(a: Assembly, mate: Mate, assemblies: readonly Assembly[] = []): string | null {
  if (mate.suppressed) return "Suppressed — not used";
  const off = [mate.a.instanceId, mate.b.instanceId].map((id) => a.instances.find((i) => i.id === id)).find((i) => i?.suppressed);
  if (off) return `Not used while ${off.name} is suppressed`;
  // On a part inside a sub-assembly that's suppressed there.
  // (A Width mate's second face may be on another part of the same copy: `path2`.)
  const second = (c: Mate["a"]) => (c.path2 ? pathProblem(a, { instanceId: c.instanceId, path: c.path2 }, assemblies) : null);
  const inner = [pathProblem(a, mate.a, assemblies), pathProblem(a, mate.b, assemblies), second(mate.a), second(mate.b)].find((p) => p?.kind === "suppressed");
  return inner ? `Not used while ${inner.text}` : null;
}

/**
 * The assembly as the solver, exports and checks see it: suppressed instances
 * taken out, with the mates on them (and relations between those mates), and
 * groups closed up around them. Unchanged (the same object) when nothing is suppressed.
 */
export function withoutSuppressed(a: Assembly): Assembly {
  if (!a.instances.some((i) => i.suppressed)) return a;
  const off = new Set(a.instances.filter((i) => i.suppressed).map((i) => i.id));
  const instances = a.instances.filter((i) => !off.has(i.id));
  const mates = (a.mates ?? []).filter((m) => !off.has(m.a.instanceId) && !off.has(m.b.instanceId));
  const mateIds = new Set(mates.map((m) => m.id));
  const relations = (a.relations ?? []).filter((r) => mateIds.has(r.driver) && mateIds.has(r.driven));
  const { mates: _m, relations: _r, ...rest } = a;
  return tidyGroups({ ...rest, instances, ...(mates.length ? { mates } : {}), ...(relations.length ? { relations } : {}) });
}

/** Switch instances off (or back on). Ids not in the assembly are ignored. */
export function setSuppressed(a: Assembly, ids: string[], suppressed: boolean): Assembly {
  const chosen = new Set(ids);
  return {
    ...a,
    instances: a.instances.map((i) => {
      if (!chosen.has(i.id)) return i;
      if (suppressed) return { ...i, suppressed: true };
      const { suppressed: _s, ...rest } = i;
      return rest;
    }),
  };
}
