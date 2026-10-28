/** The assembly on show, solved (with the mate being edited included), for the 3D view and panels. */
import { useMemo } from "react";

import { solveWithParts, type SolveResult } from "../assembly/mates";
import { withDragChange } from "../assembly/drag";
import { leavesOf, type Leaf } from "../assembly/subassembly";
import { activeAssembly, useStore, type MateDraft } from "../model/store";
import type { Assembly, Mate } from "../model/types";

/** The assembly with an open mate dialog's mate in it (once both its connectors are picked). */
export function withDraftMate(assembly: Assembly, draft: MateDraft | null): Assembly {
  if (!draft?.a || !draft.b) return draft ? { ...assembly, mates: (assembly.mates ?? []).filter((m) => m.id !== draft.id) } : assembly;
  const mate: Mate = { ...draft, a: draft.a, b: draft.b, suppressed: false };
  const mates = assembly.mates ?? [];
  return { ...assembly, mates: mates.some((m) => m.id === mate.id) ? mates.map((m) => (m.id === mate.id ? mate : m)) : [...mates, mate] };
}

export function useSolvedAssembly(): { assembly: Assembly | null; solved: SolveResult | null } {
  const assembly = useStore(activeAssembly);
  const parts = useStore((s) => s.parts);
  const draft = useStore((s) => s.mateDraft?.mate ?? null);
  const drag = useStore((s) => s.dragPreview);
  const assemblies = useStore((s) => s.history.present.assemblies);
  return useMemo(() => {
    if (!assembly) return { assembly: null, solved: null };
    // The mate being edited or dragged keeps its amounts; loops close by moving the others.
    const hold = [...(draft ? [draft.id] : []), ...(drag?.kind === "mate" ? [drag.id] : [])];
    return { assembly, solved: solveWithParts(withDragChange(withDraftMate(assembly, draft), drag), parts, { hold, assemblies }) };
  }, [assembly, parts, draft, drag, assemblies]);
}

const NO_LEAVES: Leaf[] = [];

/** Every part the assembly on show shows, looking into its sub-assemblies (each placed by its own mates). */
export function useAssemblyLeaves(): Leaf[] {
  const assembly = useStore(activeAssembly);
  const parts = useStore((s) => s.parts);
  const assemblies = useStore((s) => s.history.present.assemblies);
  return useMemo(() => (assembly ? leavesOf(assembly, parts, assemblies) : NO_LEAVES), [assembly, parts, assemblies]);
}

// Moved to src/assembly/placed.ts (pure, so the Claude extension uses them too); kept here for the app's imports.
export { explodeAssembly, instancesForKernel, partBox } from "../assembly/placed";

// Moved to src/assembly/drawingBom.ts (pure, so it can be tested); kept here for the app's imports.
export { bomInfo, partVolume } from "../assembly/drawingBom";
