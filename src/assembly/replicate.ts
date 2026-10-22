/**
 * Replicate: a part mated into one hole (a bolt, a pin, a foot…) copied into
 * every other matching hole of the part it's mated to, each copy held by a
 * mate of its own — like Onshape's Replicate. Which holes match is worked out
 * from the parts as built (see matchingConnectors), so the store does that and
 * hands the holes in here.
 */
import type { TopoPick } from "../geometry/topoRef";
import type { Assembly, Instance, Mate, Replicate } from "../model/types";
import { nextInstanceName, withMates } from "./assembly";

/** The mate holding an instance in a hole (a round edge or face on another part), and which side of it the instance is. */
export function replicateSource(a: Assembly, instanceId: string): { mate: Mate; side: "a" | "b" } | string {
  const instance = a.instances.find((i) => i.id === instanceId);
  if (!instance) return "Select the part to copy into the other holes.";
  if (instance.copyOf || instance.replicaOf) return "That's a copy — select the original part instead.";
  const round = (p: TopoPick) => (p.ref.kind === "edge" ? p.ref.curve === "CIRCLE" : p.ref.surface === "CYLINDRE" || p.ref.surface === "CYLINDER" || p.ref.surface === "CONE");
  for (const mate of a.mates ?? []) {
    if (mate.suppressed || mate.replicateOf) continue;
    const side = mate.a.instanceId === instanceId ? "a" : mate.b.instanceId === instanceId ? "b" : null;
    if (!side) continue;
    const other = side === "a" ? mate.b : mate.a;
    if (round(other.pick)) return { mate, side };
  }
  return "Mate this part into one hole first (a Fasten or Hinge mate on the hole's round edge or face) — Replicate then puts a copy in every matching hole.";
}

/** Make the copies match the holes found: one copy (and mate) per hole, keeping the ones already there. */
export function syncReplicate(a: Assembly, rep: Replicate, holes: TopoPick[], newId: () => string): Assembly {
  const seed = a.instances.find((i) => i.id === rep.seed);
  const mate = a.mates?.find((m) => m.id === rep.mate);
  const reps = a.replicates ?? [];
  const withRep = reps.some((r) => r.id === rep.id) ? reps.map((r) => (r.id === rep.id ? rep : r)) : [...reps, rep];
  if (!seed || !mate) return { ...a, replicates: withRep };
  const side = mate.a.instanceId === seed.id ? "a" : "b";
  const target = side === "a" ? mate.b : mate.a;
  const old = a.instances.filter((i) => i.replicaOf?.replicate === rep.id);
  const oldMates = (a.mates ?? []).filter((m) => m.replicateOf === rep.id);
  let instances = a.instances.filter((i) => i.replicaOf?.replicate !== rep.id);
  const copies: Instance[] = [];
  const mates: Mate[] = [];
  holes.forEach((hole, n) => {
    const index = n + 1;
    const was = old.find((i) => i.replicaOf!.index === index && i.partId === seed.partId);
    const copy: Instance = was ?? {
      id: newId(),
      partId: seed.partId,
      name: nextInstanceName({ ...a, instances: [...instances, ...copies] }, seed.name.replace(/ <\d+>$/, "")),
      placement: seed.placement,
      fixed: false,
      replicaOf: { replicate: rep.id, index },
    };
    // Copies show the part in the same configuration as the original.
    const { configuration: _old, ...plain } = copy;
    copies.push(seed.configuration ? { ...plain, configuration: seed.configuration } : plain);
    const before = oldMates.find((m) => (m.a.instanceId === copy.id || m.b.instanceId === copy.id) && m.replicateOf === rep.id);
    // The copy's own connector sits where the original's does (the same corner, the same spot).
    const own = { ...(side === "a" ? mate.a : mate.b), instanceId: copies[copies.length - 1].id };
    const into = { instanceId: target.instanceId, pick: hole };
    mates.push({
      ...mate,
      id: before?.id ?? newId(),
      name: `${mate.name} (${rep.name} ${index})`,
      a: side === "a" ? own : into,
      b: side === "a" ? into : own,
      replicateOf: rep.id,
    });
  });
  const at = instances.findIndex((i) => i.id === seed.id);
  instances = [...instances.slice(0, at + 1), ...copies, ...instances.slice(at + 1)];
  const others = (a.mates ?? []).filter((m) => m.replicateOf !== rep.id);
  return withMates({ ...a, instances, replicates: withRep }, [...others, ...mates]);
}

/** Remove a replicate, its copies and their mates. */
export function removeReplicate(a: Assembly, id: string): Assembly {
  const gone = new Set(a.instances.filter((i) => i.replicaOf?.replicate === id).map((i) => i.id));
  const { replicates: _r, ...rest } = a;
  const replicates = (a.replicates ?? []).filter((r) => r.id !== id);
  const mates = (a.mates ?? []).filter((m) => m.replicateOf !== id && !gone.has(m.a.instanceId) && !gone.has(m.b.instanceId));
  return withMates({ ...rest, instances: a.instances.filter((i) => !gone.has(i.id)), ...(replicates.length ? { replicates } : {}) }, mates);
}

/** After parts or mates are removed: a replicate whose original or mate has gone goes too (with its copies). */
export function tidyReplicates(a: Assembly): Assembly {
  let out = a;
  for (const r of a.replicates ?? []) {
    if (!a.instances.some((i) => i.id === r.seed) || !(a.mates ?? []).some((m) => m.id === r.mate)) out = removeReplicate(out, r.id);
  }
  // Copies whose replicate is unknown are ordinary parts again.
  const known = new Set((out.replicates ?? []).map((r) => r.id));
  if (out.instances.some((i) => i.replicaOf && !known.has(i.replicaOf.replicate)))
    out = { ...out, instances: out.instances.map((i) => (i.replicaOf && !known.has(i.replicaOf.replicate) ? (({ replicaOf: _x, ...rest }) => rest)(i) : i)) };
  return out;
}

/** "Replicate 1", "Replicate 2"… */
export function nextReplicateName(a: Assembly): string {
  const used = new Set((a.replicates ?? []).map((r) => r.name));
  let n = 1;
  while (used.has(`Replicate ${n}`)) n++;
  return `Replicate ${n}`;
}

export function parseReplicate(raw: unknown): Replicate | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.seed !== "string" || typeof r.mate !== "string") return null;
  return { id: r.id, name: typeof r.name === "string" && r.name.trim() ? r.name.slice(0, 80) : "Replicate", seed: r.seed, mate: r.mate };
}
