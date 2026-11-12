/**
 * Where an assembly's parts are, for anything that draws, exports or checks
 * them (the 3D view, drawings, exports, the clash check, and Claude's tools):
 * the exploded view's places, and each part placed for the geometry engine.
 * Pure (no store), so the Claude extension uses exactly what the app does.
 */
import { solvedInside, solveWithParts, type SolveResult } from "./mates";
import { boundsOfVertices, type Box3 } from "./assembly";
import { addOffsets, explodedPlacements, explodeOffsets, stepOffsets } from "./explode";
import { compose, IDENTITY, type Placement, type Vec3 } from "./math";
import { findMesh, meshIdOf } from "./configured";
import { kernelInstances, leavesOf, leavesOfTop, PATH_SEP, topBox, type Leaf } from "./subassembly";
import type { Assembly } from "../model/types";
import { cutsFor } from "./assemblyFeatures";
import type { CutStage, InstanceInput, PartMesh } from "../kernel/protocol";

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
  // Assembly features cut the copies they reach — this assembly's and its sub-assemblies' (older assemblies have none:
  // exactly as before).
  const cuts = hasAssemblyFeatures(assembly, assemblies) ? cutStager(assembly, parts, assemblies) : undefined;
  return kernelInstances(leavesOf(assembly, parts, assemblies, solved.inner), parts, shown ?? solved.placements, (id) => solved.placements[id] ?? own(id), shift, cuts);
}

/** Whether an assembly, or any sub-assembly it uses (at any depth), has features of its own. */
export function hasAssemblyFeatures(assembly: Assembly, assemblies: readonly Assembly[], within: string[] = [assembly.id]): boolean {
  if (assembly.features?.length) return true;
  for (const i of assembly.instances) {
    if (!i.subAssembly || i.suppressed || within.includes(i.subAssembly)) continue;
    const sub = assemblies.find((a) => a.id === i.subAssembly);
    if (sub && hasAssemblyFeatures(sub, assemblies, [...within, sub.id])) return true;
  }
  return false;
}

/**
 * The cut stages of each part (see CutStage): the assembly's own features where the part is solved to be, then
 * the features of each sub-assembly it's inside, where it sits in that sub-assembly (by the sub-assembly's own
 * solve). Undefined for a part nothing cuts.
 */
export function cutStager(assembly: Assembly, parts: readonly PartMesh[], assemblies: readonly Assembly[]): (leaf: Leaf, solved: Placement) => CutStage[] | undefined {
  const inner = new Map<string, Leaf[]>();
  const leavesIn = (sub: Assembly, within: string[]) => {
    let list = inner.get(sub.id);
    if (!list) inner.set(sub.id, (list = leavesOf(sub, parts, assemblies)));
    return { list, places: solvedInside(sub, parts, assemblies, within) };
  };
  return (leaf, solved) => {
    const stages: CutStage[] = [];
    const own = cutsFor(assembly, leaf.key);
    if (own) stages.push({ features: own, at: { position: solved.position, rotation: solved.rotation }, ...(leaf.instance.mirrored ? { mirrored: true } : {}) });
    const path = [leaf.top, ...leaf.path];
    let level: Assembly = assembly;
    const within = [assembly.id];
    for (let d = 0; d < path.length - 1; d++) {
      const i = level.instances.find((x) => x.id === path[d]);
      const sub = i?.subAssembly ? assemblies.find((a) => a.id === i.subAssembly) : undefined;
      if (!sub || within.includes(sub.id)) break;
      within.push(sub.id);
      if (sub.features?.length) {
        const key = path.slice(d + 1).join(PATH_SEP);
        const features = cutsFor(sub, key);
        if (features) {
          const { list, places } = leavesIn(sub, [...within]);
          const there = list.find((l) => l.key === key);
          if (there) {
            const top = places[there.top] ?? sub.instances.find((x) => x.id === there.top)?.placement ?? IDENTITY;
            const at = there.path.length ? compose(top, there.relative) : top;
            stages.push({ features, at: { position: at.position, rotation: at.rotation }, ...(there.instance.mirrored ? { mirrored: true } : {}) });
          }
        }
      }
      level = sub;
    }
    return stages.length ? stages : undefined;
  };
}

/**
 * Whether assembly features cut any part inside a sub-assembly of this
 * assembly. A STEP file that keeps the structure shares one definition of each
 * sub-assembly between its copies, so it couldn't show those cuts: such an
 * assembly is written as a flat list of placed parts instead (with a note).
 */
export function cutsInsideSubAssemblies(assembly: Assembly, parts: readonly PartMesh[], assemblies: readonly Assembly[]): boolean {
  if (!hasAssemblyFeatures(assembly, assemblies)) return false;
  const stager = cutStager(assembly, parts, assemblies);
  return leavesOf(assembly, parts, assemblies).some((l) => l.path.length > 0 && !!stager(l, IDENTITY));
}

/** What an export says when it's written flat because of `cutsInsideSubAssemblies`. */
export const FLAT_STEP_NOTE = "Some parts inside sub-assemblies are cut by assembly features, so the STEP file lists every part on its own (in its place) instead of keeping the sub-assemblies' structure.";
