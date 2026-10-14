/** The assembly on show, solved (with the mate being edited included), for the 3D view and panels. */
import { useMemo } from "react";

import { solveWithParts, type SolveResult } from "../assembly/mates";
import { withDragChange } from "../assembly/drag";
import { activeAssembly, useStore, type MateDraft } from "../model/store";
import type { Assembly, Mate } from "../model/types";
import type { InstanceInput, PartMesh } from "../kernel/protocol";

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
  return useMemo(() => {
    if (!assembly) return { assembly: null, solved: null };
    return { assembly, solved: solveWithParts(withDragChange(withDraftMate(assembly, draft), drag), parts) };
  }, [assembly, parts, draft, drag]);
}

/** Each instance in its solved place, for exports and clash checks (copies of missing parts are left out). */
export function instancesForKernel(assembly: Assembly, parts: PartMesh[], solved: SolveResult = solveWithParts(assembly, parts)): InstanceInput[] {
  return assembly.instances
    .filter((i) => parts.some((p) => p.id === i.partId))
    .map((i) => {
      const p = solved.placements[i.id] ?? i.placement;
      return { id: i.id, partId: i.partId, name: i.name, position: p.position, rotation: p.rotation };
    });
}
