/** The assembly on show, solved (with the mate being edited included), for the 3D view and panels. */
import { useMemo } from "react";

import { solveWithParts, type SolveResult } from "../assembly/mates";
import { boundsOfVertices, type Box3 } from "../assembly/assembly";
import { addOffsets, explodedPlacements, explodeOffsets, stepOffsets } from "../assembly/explode";
import { IDENTITY, type Placement } from "../assembly/math";
import { withDragChange } from "../assembly/drag";
import { findMesh, meshIdOf } from "../assembly/configured";
import { kernelInstances, leavesOf, leavesOfTop, topBox, type Leaf } from "../assembly/subassembly";
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

/** Box of each part, worked out once per rebuild. */
const boxCache = new WeakMap<PartMesh, Box3 | null>();
export function partBox(p: PartMesh): Box3 | null {
  if (!boxCache.has(p)) boxCache.set(p, boundsOfVertices(p.vertices));
  return boxCache.get(p) ?? null;
}

// Moved to src/assembly/drawingBom.ts (pure, so it can be tested); kept here for the app's imports.
export { bomInfo, partVolume } from "../assembly/drawingBom";

/**
 * Placements for an exploded view: spread apart by `amount` (0 = not spread),
 * then moved by the exploded view's steps. Null = not exploded (unchanged).
 */
export function explodeAssembly(assembly: Assembly, parts: PartMesh[], placements: Record<string, Placement>, amount: number | null, assemblies: readonly Assembly[] = []): Record<string, Placement> {
  if (amount === null) return placements;
  // Suppressed parts aren't shown, so they don't take part in spreading the others out.
  // A sub-assembly moves out as one piece (the box round all its parts).
  const leaves = assembly.instances.some((i) => i.subAssembly) ? leavesOf(assembly, parts, assemblies) : NO_LEAVES;
  const items = assembly.instances.filter((i) => !i.suppressed).map((i) => {
    const part = i.subAssembly ? null : findMesh(parts, meshIdOf(i));
    const box = i.subAssembly ? topBox(leavesOfTop(leaves, i.id), parts, partBox) : part ? partBox(part) : null;
    return { id: i.id, placement: placements[i.id] ?? i.placement, box, fixed: i.fixed };
  });
  const spread = amount > 0 ? explodeOffsets(items, amount) : {};
  return explodedPlacements(placements, addOffsets(spread, stepOffsets(assembly.explodeSteps ?? [])));
}

/**
 * Each part in its solved place, for exports, drawings and clash checks —
 * parts inside sub-assemblies too, carried along with them (their ids are
 * "top/inner/…" paths). Suppressed parts, and copies of missing parts, are left
 * out. `shown` replaces the top-level places (an exploded view).
 */
export function instancesForKernel(
  assembly: Assembly,
  parts: PartMesh[],
  assemblies: readonly Assembly[] = [],
  solved: SolveResult = solveWithParts(assembly, parts, { assemblies }),
  shown?: Record<string, Placement>,
): InstanceInput[] {
  const own = (id: string) => assembly.instances.find((i) => i.id === id)?.placement ?? IDENTITY;
  return kernelInstances(leavesOf(assembly, parts, assemblies), parts, shown ?? solved.placements, (id) => solved.placements[id] ?? own(id));
}
