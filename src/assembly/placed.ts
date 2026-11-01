/**
 * Where an assembly's parts are, for anything that draws, exports or checks
 * them (the 3D view, drawings, exports, the clash check, and Claude's tools):
 * the exploded view's places, and each part placed for the geometry engine.
 * Pure (no store), so the Claude extension uses exactly what the app does.
 */
import { solveWithParts, type SolveResult } from "./mates";
import { boundsOfVertices, type Box3 } from "./assembly";
import { addOffsets, explodedPlacements, explodeOffsets, stepOffsets } from "./explode";
import { IDENTITY, type Placement, type Vec3 } from "./math";
import { findMesh, meshIdOf } from "./configured";
import { kernelInstances, leavesOf, leavesOfTop, topBox, type Leaf } from "./subassembly";
import type { Assembly } from "../model/types";
import type { InstanceInput, PartMesh } from "../kernel/protocol";

const NO_LEAVES: Leaf[] = [];

/** Box of each part, worked out once per rebuild. */
const boxCache = new WeakMap<PartMesh, Box3 | null>();
export function partBox(p: PartMesh): Box3 | null {
  if (!boxCache.has(p)) boxCache.set(p, boundsOfVertices(p.vertices));
  return boxCache.get(p) ?? null;
}

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
  /** Parts inside sub-assemblies moved on their own (an exploded view's steps). */
  shift?: Record<string, Vec3>,
): InstanceInput[] {
  const own = (id: string) => assembly.instances.find((i) => i.id === id)?.placement ?? IDENTITY;
  return kernelInstances(leavesOf(assembly, parts, assemblies), parts, shown ?? solved.placements, (id) => solved.placements[id] ?? own(id), shift);
}
