/**
 * What Measure and Mass properties hand the engine in an assembly: every copy (suppressed ones left out) as the
 * kernel places it — cut by the assembly's features, mirrored, and where the mates put it, never exploded — and a
 * clicked face, edge or corner of a copy as a pick on its part (in the part's own coordinates, as the copy shows it).
 */
import { useMemo } from "react";

import { solveWithParts } from "../assembly/mates";
import { findMesh, meshIdOf } from "../assembly/configured";
import { leavesOf } from "../assembly/subassembly";
import { cornersOf, type VertexPick } from "../geometry/vertexRef";
import type { TopoPick } from "../geometry/topoRef";
import type { InstanceInput } from "../kernel/protocol";
import { activeAssembly, useStore, type SelectionItem } from "../model/store";
import { cutMeshFor } from "./assemblyFeatureState";
import { instancesForKernel } from "./assemblySolve";

/** The assembly on show's copies for the kernel (null when none is on show or `wanted` is false). */
export function useAssemblyInputs(wanted: boolean): InstanceInput[] | null {
  const asm = useStore(activeAssembly);
  const parts = useStore((s) => s.parts);
  const assemblies = useStore((s) => s.history.present.assemblies);
  return useMemo(() => {
    if (!wanted || !asm) return null;
    const all = assemblies ?? [];
    return instancesForKernel(asm, parts, all, solveWithParts(asm, parts, { assemblies: all }));
  }, [wanted, asm, parts, assemblies]);
}

/** A face, edge or corner clicked on a copy, as a pick on that copy's part (null when it can't be read). */
export function asmPickFor(item: SelectionItem): TopoPick | VertexPick | null {
  const s = useStore.getState();
  const asm = activeAssembly(s);
  if (!asm) return null;
  const leaf = leavesOf(asm, s.parts, s.history.present.assemblies ?? []).find((l) => l.key === item.partId);
  const part = leaf ? findMesh(s.parts, meshIdOf(leaf.instance)) : undefined;
  if (!leaf || !part) return null;
  // (A copy the assembly's features cut is shown cut: the click names its own faces and edges.)
  const shown = cutMeshFor(item.partId) ?? part;
  if (item.kind === "vertex") {
    const ref = cornersOf(shown)[item.index];
    return ref ? { partId: part.id, ref } : null;
  }
  const ref = item.kind === "edge" ? shown.edgeRefs?.[item.index] : shown.faceRefs?.[item.index];
  if (!ref || (ref.kind === "edge" ? ref.curve : ref.surface) === "UNKNOWN") return null;
  return { partId: part.id, ref };
}
