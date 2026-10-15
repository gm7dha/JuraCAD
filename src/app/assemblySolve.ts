/** The assembly on show, solved (with the mate being edited included), for the 3D view and panels. */
import { useMemo } from "react";

import { solveWithParts, type SolveResult } from "../assembly/mates";
import { boundsOfVertices, type Box3 } from "../assembly/assembly";
import { explodedPlacements, explodeOffsets } from "../assembly/explode";
import type { Placement } from "../assembly/math";
import { withDragChange } from "../assembly/drag";
import { findMesh, meshIdOf } from "../assembly/configured";
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

/** Box of each part, worked out once per rebuild. */
const boxCache = new WeakMap<PartMesh, Box3 | null>();
export function partBox(p: PartMesh): Box3 | null {
  if (!boxCache.has(p)) boxCache.set(p, boundsOfVertices(p.vertices));
  return boxCache.get(p) ?? null;
}

/** Placements spread apart for an exploded view (unchanged when `amount` is 0). */
export function explodeAssembly(assembly: Assembly, parts: PartMesh[], placements: Record<string, Placement>, amount: number): Record<string, Placement> {
  if (!(amount > 0)) return placements;
  const items = assembly.instances.map((i) => {
    const part = findMesh(parts, meshIdOf(i));
    return { id: i.id, placement: placements[i.id] ?? i.placement, box: part ? partBox(part) : null, fixed: i.fixed };
  });
  return explodedPlacements(placements, explodeOffsets(items, amount));
}

/** Each instance in its solved place, for exports and clash checks (copies of missing parts are left out). */
export function instancesForKernel(assembly: Assembly, parts: PartMesh[], solved: SolveResult = solveWithParts(assembly, parts)): InstanceInput[] {
  return assembly.instances
    .filter((i) => findMesh(parts, meshIdOf(i)))
    .map((i) => {
      const p = solved.placements[i.id] ?? i.placement;
      return { id: i.id, partId: meshIdOf(i), name: i.name, position: p.position, rotation: p.rotation };
    });
}
