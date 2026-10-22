/** The assembly on show, solved (with the mate being edited included), for the 3D view and panels. */
import { useMemo } from "react";

import { solveWithParts, type SolveResult } from "../assembly/mates";
import { boundsOfVertices, meshVolume, type BomInfo, type Box3 } from "../assembly/assembly";
import { addOffsets, explodedPlacements, explodeOffsets, stepOffsets } from "../assembly/explode";
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
    // The mate being edited or dragged keeps its amounts; loops close by moving the others.
    const hold = [...(draft ? [draft.id] : []), ...(drag?.kind === "mate" ? [drag.id] : [])];
    return { assembly, solved: solveWithParts(withDragChange(withDraftMate(assembly, draft), drag), parts, { hold }) };
  }, [assembly, parts, draft, drag]);
}

/** Box of each part, worked out once per rebuild. */
const boxCache = new WeakMap<PartMesh, Box3 | null>();
export function partBox(p: PartMesh): Box3 | null {
  if (!boxCache.has(p)) boxCache.set(p, boundsOfVertices(p.vertices));
  return boxCache.get(p) ?? null;
}

/** Volume of each part's display mesh (mm³; null for a surface), worked out once per rebuild. */
const volumeCache = new WeakMap<PartMesh, number | null>();
export function partVolume(p: PartMesh): number | null {
  if (!volumeCache.has(p)) volumeCache.set(p, p.surface ? null : meshVolume(p.vertices, p.triangles));
  return volumeCache.get(p) ?? null;
}

/** Material and volume of the part each instance shows, for the parts list. */
export function bomInfo(parts: PartMesh[], materials: Record<string, string> | undefined): BomInfo {
  return (i) => {
    const mesh = findMesh(parts, meshIdOf(i));
    return mesh ? { material: materials?.[i.partId], volume: partVolume(mesh) } : null;
  };
}

/**
 * Placements for an exploded view: spread apart by `amount` (0 = not spread),
 * then moved by the exploded view's steps. Null = not exploded (unchanged).
 */
export function explodeAssembly(assembly: Assembly, parts: PartMesh[], placements: Record<string, Placement>, amount: number | null): Record<string, Placement> {
  if (amount === null) return placements;
  // Suppressed parts aren't shown, so they don't take part in spreading the others out.
  const items = assembly.instances.filter((i) => !i.suppressed).map((i) => {
    const part = findMesh(parts, meshIdOf(i));
    return { id: i.id, placement: placements[i.id] ?? i.placement, box: part ? partBox(part) : null, fixed: i.fixed };
  });
  const spread = amount > 0 ? explodeOffsets(items, amount) : {};
  return explodedPlacements(placements, addOffsets(spread, stepOffsets(assembly.explodeSteps ?? [])));
}

/** Each instance in its solved place, for exports, drawings and clash checks (suppressed parts, and copies of missing parts, are left out). */
export function instancesForKernel(assembly: Assembly, parts: PartMesh[], solved: SolveResult = solveWithParts(assembly, parts)): InstanceInput[] {
  return assembly.instances
    .filter((i) => !i.suppressed && findMesh(parts, meshIdOf(i)))
    .map((i) => {
      const p = solved.placements[i.id] ?? i.placement;
      return { id: i.id, partId: meshIdOf(i), name: i.name, position: p.position, rotation: p.rotation, ...(i.mirrored ? { mirrored: true } : {}) };
    });
}
