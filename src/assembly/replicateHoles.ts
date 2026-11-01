/**
 * Which holes a Replicate's copies go in: every hole like the original's on
 * the part it's mated to, as that part is built now. Shared by the app
 * (store.ts) and Claude's assembly tools, so both find the same holes.
 */
import type { TopoPick } from "../geometry/topoRef";
import type { PartMesh } from "../kernel/protocol";
import type { Assembly, Replicate } from "../model/types";
import { findMesh, meshIdOf } from "./configured";
import { matchingConnectors } from "./connectors";
import { instanceAt, leafKey } from "./subassembly";

/** The holes a replicate's copies go in (none if its mate or the part it's mated to has gone). */
export function replicateHoles(a: Assembly, rep: Replicate, parts: PartMesh[], assemblies: readonly Assembly[] = []): TopoPick[] {
  const mate = a.mates?.find((m) => m.id === rep.mate);
  if (!mate) return [];
  const target = mate.a.instanceId === rep.seed ? mate.b : mate.a;
  // (The holes may be in a part inside a sub-assembly.)
  const instance = instanceAt(a, assemblies, leafKey(target.instanceId, target.path))?.part;
  const part = instance && findMesh(parts, meshIdOf(instance));
  // Picks name the part itself, whichever configuration it's shown in.
  return part && instance ? matchingConnectors(part, { ...target.pick, partId: part.id }).map((p) => ({ ...p, partId: instance.partId })) : [];
}
