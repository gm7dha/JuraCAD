/** The assembly on show, solved (with the mate being edited included), for the 3D view and panels. */
import { useMemo } from "react";

import { solveWithParts, type SolveResult } from "../assembly/mates";
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
  return useMemo(() => {
    if (!assembly) return { assembly: null, solved: null };
    return { assembly, solved: solveWithParts(withDraftMate(assembly, draft), parts) };
  }, [assembly, parts, draft]);
}
