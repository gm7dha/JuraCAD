/**
 * An assembly's structure for a STEP file (as Onshape exports one): the
 * assembly as a product made of components; each sub-assembly a product of
 * its own (one definition, however many copies use it); each part once, as a
 * shared definition every copy points at; and every component with its
 * instance name and place. CAD programs that open the file then show the same
 * tree, and the file holds each part's shape only once.
 */
import type { PartMesh, StepComponent, StepTree } from "../kernel/protocol";
import type { Assembly, Instance } from "../model/types";
import { findMesh, meshIdOf } from "./configured";
import { solvedInside } from "./mates";
import type { Placement } from "./math";

/** A part definition's key: the built part, and "~mirrored" for its mirror image (the opposite hand is a different part). */
export const stepPartKey = (i: Pick<Instance, "partId" | "configuration" | "mirrored">): string => meshIdOf(i) + (i.mirrored ? "~mirrored" : "");

/**
 * The STEP structure of an assembly, its top-level instances where `tops` says
 * (their solved places). Suppressed instances, copies of parts that aren't
 * built and sub-assemblies with nothing in them are left out, as in every other
 * export. Null when nothing is left.
 */
export function stepTree(assembly: Assembly, parts: readonly PartMesh[], tops: Record<string, Placement>, assemblies: readonly Assembly[] = []): StepTree | null {
  const out: StepTree = { root: assembly.id, assemblies: {}, parts: {} };
  /** Fills in an assembly's product (once); false when it has nothing in it. */
  const visit = (a: Assembly, places: (i: Instance) => Placement, within: string[]): boolean => {
    if (out.assemblies[a.id]) return out.assemblies[a.id].components.length > 0;
    const components: StepComponent[] = [];
    for (const i of a.instances) {
      if (i.suppressed) continue;
      const p = places(i);
      if (i.subAssembly) {
        const sub = assemblies.find((x) => x.id === i.subAssembly);
        // (Missing, or it would go round in a circle: left out, as the 3D view does.)
        if (!sub || within.includes(sub.id)) continue;
        const inner = solvedInside(sub, parts, assemblies, [...within, sub.id]);
        if (!visit(sub, (j) => inner[j.id] ?? j.placement, [...within, sub.id])) continue;
        components.push({ name: i.name, position: p.position, rotation: p.rotation, assembly: sub.id });
        continue;
      }
      const mesh = findMesh(parts, meshIdOf(i));
      if (!mesh) continue;
      const key = stepPartKey(i);
      if (!out.parts[key]) out.parts[key] = { partId: meshIdOf(i), name: mesh.name + (i.mirrored ? " (mirrored)" : ""), ...(i.mirrored ? { mirrored: true } : {}) };
      components.push({ name: i.name, position: p.position, rotation: p.rotation, part: key });
    }
    out.assemblies[a.id] = { name: a.name, components };
    return components.length > 0;
  };
  return visit(assembly, (i) => tops[i.id] ?? i.placement, [assembly.id]) ? out : null;
}

export { stepPartCount } from "../kernel/stepCount";
