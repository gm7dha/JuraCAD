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
import { flexibleInner, solvedInside } from "./mates";
import { compose, invert, type Placement } from "./math";
import { hasFlexible, isFlexible } from "./flexible";
import { mirroredPlacement } from "./subassembly";

/** A part definition's key: the built part, and "~mirrored" for its mirror image (the opposite hand is a different part). */
export const stepPartKey = (i: Pick<Instance, "partId" | "configuration" | "mirrored">): string => meshIdOf(i) + (i.mirrored ? "~mirrored" : "");

/**
 * The STEP structure of an assembly, its top-level instances where `tops` says
 * (their solved places). Suppressed instances, copies of parts that aren't
 * built and sub-assemblies with nothing in them are left out, as in every other
 * export. Null when nothing is left.
 *
 * A mirrored sub-assembly copy is its own product ("… (mirrored)", each part in
 * it the opposite hand), written once however many use it. A flexible copy's
 * parts sit where the assembly's solve put them (`inner`, a solve's
 * `SolveResult.inner`), which can differ from copy to copy, so each flexible
 * copy is a product of its own.
 */
export function stepTree(assembly: Assembly, parts: readonly PartMesh[], tops: Record<string, Placement>, assemblies: readonly Assembly[] = [], inner?: Record<string, Placement>): StepTree | null {
  const out: StepTree = { root: assembly.id, assemblies: {}, parts: {} };
  /**
   * Fills in an assembly's product (once, under `key`); false when it has nothing in it. `places` gives each
   * instance's place in it; `flip` = seen in a mirror (each place mirrored, each part the opposite hand);
   * `flat` = where its flexible copies' parts are, by key below `flatPrefix`, in its coordinates.
   */
  const visit = (a: Assembly, key: string, places: (i: Instance) => Placement, flip: boolean, within: string[], flat: (k: string) => Placement | undefined): boolean => {
    if (out.assemblies[key]) return out.assemblies[key].components.length > 0;
    const components: StepComponent[] = [];
    for (const i of a.instances) {
      if (i.suppressed) continue;
      const own = places(i);
      const p = flip ? mirroredPlacement(own) : own;
      const mirrored = flip !== !!i.mirrored;
      if (i.subAssembly) {
        const sub = assemblies.find((x) => x.id === i.subAssembly);
        // (Missing, or it would go round in a circle: left out, as the 3D view does.)
        if (!sub || within.includes(sub.id)) continue;
        const deeper = [...within, sub.id];
        let ok: boolean;
        let child: string;
        if (isFlexible(i)) {
          // Its parts where this level's solve put them, relative to the copy.
          const at = (k: string) => flat(k);
          const frame = invert(own);
          child = `${sub.id}@${key}/${i.id}${flip ? "~mirrored" : ""}`;
          const prefix = `${i.id}/`;
          ok = visit(sub, child, (j) => { const w = at(prefix + j.id); return w ? compose(frame, w) : j.placement; }, flip, deeper, (k) => { const w = at(prefix + k); return w ? compose(frame, w) : undefined; });
        } else {
          const solved = solvedInside(sub, parts, assemblies, deeper);
          child = sub.id + (mirrored ? "~mirrored" : "");
          ok = visit(sub, child, (j) => solved[j.id] ?? j.placement, mirrored, deeper, (k) => solved[k]);
          if (ok && mirrored) out.assemblies[child].name = `${sub.name} (mirrored)`;
        }
        if (!ok) continue;
        components.push({ name: i.name, position: p.position, rotation: p.rotation, assembly: child });
        continue;
      }
      const mesh = findMesh(parts, meshIdOf(i));
      if (!mesh) continue;
      const shown = { ...i, mirrored };
      const pk = stepPartKey(shown);
      if (!out.parts[pk]) out.parts[pk] = { partId: meshIdOf(i), name: mesh.name + (mirrored ? " (mirrored)" : ""), ...(mirrored ? { mirrored: true } : {}) };
      components.push({ name: i.name, position: p.position, rotation: p.rotation, part: pk });
    }
    out.assemblies[key] = { name: a.name, components };
    return components.length > 0;
  };
  // The top level's flexible copies: their parts relative to each copy (inner), here in the assembly's coordinates.
  const flex = inner ?? (hasFlexible(assembly) ? flexibleInner(assembly, parts, assemblies) : {});
  const topFlat = (k: string) => {
    const rel = flex[k];
    const t = tops[k.split("/")[0]];
    return rel && t ? compose(t, rel) : undefined;
  };
  return visit(assembly, assembly.id, (i) => tops[i.id] ?? i.placement, false, [assembly.id], topFlat) ? out : null;
}

export { stepPartCount } from "../kernel/stepCount";
