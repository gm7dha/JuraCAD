/**
 * Groups (Onshape's Group mate): parts locked together where they are, so
 * they move as one. Each part's place is kept relative to the group's first
 * part; the mate solver treats that like a Fasten between them.
 */
import type { Assembly, AssemblyGroup } from "../model/types";
import { compose, invert, parsePlacement, type Placement } from "./math";

/** The next free group name: "Group 1", "Group 2"… */
export function nextGroupName(a: Assembly): string {
  const used = new Set((a.groups ?? []).map((g) => g.name));
  let n = 1;
  while (used.has(`Group ${n}`)) n++;
  return `Group ${n}`;
}

/** The group a part is in, if any. */
export function groupOf(a: Assembly, instanceId: string): AssemblyGroup | undefined {
  return (a.groups ?? []).find((g) => g.members.includes(instanceId));
}

/**
 * Lock parts together where they are now (`placements`: where each is shown).
 * Parts already in a group, pattern copies and replicated parts are left out;
 * groups need two parts or more. Returns the error in plain words if it can't.
 */
export function makeGroup(a: Assembly, ids: string[], placements: Record<string, Placement>, id: string): { assembly: Assembly; error?: string } {
  const members = a.instances.filter((i) => ids.includes(i.id) && !i.copyOf && !i.replicaOf && !groupOf(a, i.id)).map((i) => i.id);
  if (members.length < 2) return { assembly: a, error: "Select two or more parts that aren't already in a group (pattern and Replicate copies can't be grouped)." };
  const at = (iid: string) => placements[iid] ?? a.instances.find((i) => i.id === iid)!.placement;
  const anchor = invert(at(members[0]));
  const offsets: Record<string, Placement> = {};
  for (const m of members.slice(1)) offsets[m] = compose(anchor, at(m));
  const group: AssemblyGroup = { id, name: nextGroupName(a), members, offsets };
  return { assembly: { ...a, groups: [...(a.groups ?? []), group] } };
}

/** Ungroup: the parts stay where they are, but move separately again. */
export function removeGroup(a: Assembly, id: string): Assembly {
  const groups = (a.groups ?? []).filter((g) => g.id !== id);
  const { groups: _old, ...rest } = a;
  return groups.length ? { ...rest, groups } : rest;
}

export function renameGroup(a: Assembly, id: string, name: string): Assembly {
  const n = name.trim().slice(0, 80);
  return n ? { ...a, groups: (a.groups ?? []).map((g) => (g.id === id ? { ...g, name: n } : g)) } : a;
}

/** Drop removed parts from groups, and groups left with fewer than two. */
export function tidyGroups(a: Assembly): Assembly {
  if (!a.groups) return a;
  const present = new Set(a.instances.map((i) => i.id));
  const groups: AssemblyGroup[] = [];
  for (const g of a.groups) {
    const members = g.members.filter((m) => present.has(m));
    if (members.length < 2) continue;
    if (members[0] === g.members[0]) {
      groups.push(members.length === g.members.length ? g : { ...g, members, offsets: Object.fromEntries(members.slice(1).map((m) => [m, g.offsets[m]])) });
      continue;
    }
    // The first part went: keep the others' places relative to the new first one.
    const back = invert(g.offsets[members[0]]);
    groups.push({ ...g, members, offsets: Object.fromEntries(members.slice(1).map((m) => [m, compose(back, g.offsets[m])])) });
  }
  const { groups: _old, ...rest } = a;
  return groups.length ? { ...rest, groups } : rest;
}

/** A group read from a file, or null if it's unusable. */
export function parseGroup(raw: unknown): AssemblyGroup | null {
  const g = (raw ?? {}) as Record<string, unknown>;
  if (typeof g.id !== "string" || !Array.isArray(g.members)) return null;
  const members = [...new Set(g.members.filter((m): m is string => typeof m === "string"))];
  if (members.length < 2) return null;
  const off = (g.offsets ?? {}) as Record<string, unknown>;
  return {
    id: g.id,
    name: typeof g.name === "string" && g.name.trim() ? g.name.slice(0, 80) : "Group",
    members,
    offsets: Object.fromEntries(members.slice(1).map((m) => [m, parsePlacement(off[m])])),
  };
}
