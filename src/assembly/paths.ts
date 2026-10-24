/**
 * Following a mate connector's path into sub-assemblies (see subassembly.ts),
 * and saying in plain words why it no longer leads to a part. Kept apart (no
 * imports but types) so the solver, suppression and sub-assembly code can all use it.
 */
import type { Assembly, MateConnector } from "../model/types";

export interface PathProblem {
  /** "suppressed": a part (or sub-assembly) on the way is switched off; "gone": something on the way no longer exists. */
  kind: "suppressed" | "gone";
  text: string;
}

/**
 * Why a connector on a part inside a sub-assembly can't be used, or null when
 * its path still leads to a part that's switched on (and for connectors on
 * ordinary parts, which have no path).
 */
export function pathProblem(assembly: Assembly, c: Pick<MateConnector, "instanceId" | "path">, assemblies: readonly Assembly[] = []): PathProblem | null {
  if (!c.path?.length) return null;
  const top = assembly.instances.find((i) => i.id === c.instanceId);
  if (!top) return null;
  let here = top;
  for (const id of c.path) {
    const sub = here.subAssembly ? assemblies.find((a) => a.id === here.subAssembly) : undefined;
    if (!sub) return { kind: "gone", text: `The assembly ${here.name} showed has been deleted. Edit the mate and pick a face again.` };
    const next = sub.instances.find((i) => i.id === id);
    if (!next) return { kind: "gone", text: `The part it used inside ${top.name} was removed from ${sub.name}. Edit the mate and pick a face again.` };
    if (next.suppressed) return { kind: "suppressed", text: `${next.name} inside ${top.name} is suppressed` };
    here = next;
  }
  if (here.subAssembly) return { kind: "gone", text: `The part it used inside ${top.name} was removed from ${here.name}. Edit the mate and pick a face again.` };
  return null;
}
