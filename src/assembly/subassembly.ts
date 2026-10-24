/**
 * Sub-assemblies (as in Onshape): one assembly placed inside another as a
 * single instance. It moves as one solid piece; inside it, each part sits
 * where that assembly's own mates put it, so editing the sub-assembly (moving
 * parts, changing mates, changing a part's shape) updates every place it's used.
 *
 * Parts inside are named by a path of instance ids, one per level, joined by
 * "/": "i_top/i_inner/i_part". A plain part's key is just its instance id.
 * Everything that walks an assembly's parts (the 3D view, exports, drawings,
 * the clash check, the parts list) goes through `leavesOf`.
 */
import { newId } from "../model/document";
import type { Assembly, Instance, JuraCADDocument } from "../model/types";
import type { InstanceInput, PartMesh } from "../kernel/protocol";
import { mirroredBox, nextInstanceName, placedBox, updateAssembly, usesAssembly, type Box3 } from "./assembly";

export { tidySubAssemblies, usesAssembly } from "./assembly";
import { findMesh, meshIdOf } from "./configured";
import { compose, IDENTITY, type Placement } from "./math";
import { solvedInside } from "./mates";

export const PATH_SEP = "/";

/** The key of a part inside an assembly: its top-level instance, then the instances inside, down to the part. */
export const leafKey = (top: string, path: readonly string[] = []): string => [top, ...path].join(PATH_SEP);

/** The top-level instance a key belongs to (a key with no "/" is the instance itself). */
export const topOfKey = (key: string): string => key.split(PATH_SEP)[0];

/** The instances inside the top-level one, down to the part (empty for a plain part). */
export const pathOfKey = (key: string): string[] => key.split(PATH_SEP).slice(1);

/** True when the instance shows another assembly. */
export const isSubAssembly = (i: Pick<Instance, "subAssembly">): boolean => !!i.subAssembly;

/** Why assembly `subId` can't be put into assembly `targetId`, in plain words (null when it can). */
export function insertProblem(doc: JuraCADDocument, targetId: string, subId: string): string | null {
  const all = doc.assemblies ?? [];
  const target = all.find((a) => a.id === targetId);
  const sub = all.find((a) => a.id === subId);
  if (!target || !sub) return "That assembly no longer exists.";
  if (subId === targetId) return `${sub.name} can't go inside itself. Pick another assembly.`;
  if (usesAssembly(all, subId, targetId))
    return `${sub.name} already has ${target.name} inside it, so putting it into ${target.name} would go round in a circle. Pick another assembly, or take ${target.name} out of ${sub.name} first.`;
  return null;
}

/**
 * Put a copy of another assembly into an assembly, as one piece (a
 * sub-assembly). Refused (the document comes back unchanged) when it would go
 * round in a circle — see `insertProblem`.
 */
export function insertSubAssembly(doc: JuraCADDocument, targetId: string, subId: string, placement: Placement = IDENTITY, id = newId("i")): JuraCADDocument {
  if (insertProblem(doc, targetId, subId)) return doc;
  const sub = doc.assemblies!.find((a) => a.id === subId)!;
  return updateAssembly(doc, targetId, (a) => ({
    ...a,
    instances: [...a.instances, { id, partId: "", subAssembly: subId, name: nextInstanceName(a, sub.name), placement, fixed: a.instances.length === 0 }],
  }));
}

/** The assemblies that use assembly `id` as a sub-assembly (directly). */
export function whereUsed(assemblies: readonly Assembly[], id: string): Assembly[] {
  return assemblies.filter((a) => a.instances.some((i) => i.subAssembly === id));
}

/** One part shown by an assembly, at any depth. */
export interface Leaf {
  /** "top/inner/…/part" ids (just the instance id for a plain part). */
  key: string;
  /** The top-level instance it belongs to. */
  top: string;
  /** The instances inside the top-level one, down to the part (empty for a plain part). */
  path: string[];
  /** The part's own instance (its part, configuration, mirroring). */
  instance: Instance;
  /** "Sub <1> / Part <2>" (just the instance's name for a plain part). */
  name: string;
  /** Where the part sits inside its top-level instance (no move for a plain part). */
  relative: Placement;
}

/**
 * Every part an assembly shows, looking into sub-assemblies (each placed by
 * its own mates). Suppressed instances, at any level, are left out, and so are
 * sub-assemblies that are missing or would go round in a circle.
 */
export function leavesOf(assembly: Assembly, parts: readonly PartMesh[], assemblies: readonly Assembly[] = []): Leaf[] {
  const out: Leaf[] = [];
  const walk = (a: Assembly, top: Instance | null, path: string[], names: string[], at: Placement, within: string[]) => {
    const inner = top ? solvedInside(a, parts, assemblies, within) : null;
    for (const i of a.instances) {
      if (i.suppressed) continue;
      const here = top ? compose(at, inner![i.id] ?? i.placement) : IDENTITY;
      const t = top ?? i;
      const p = top ? [...path, i.id] : [];
      const n = [...names, i.name];
      if (i.subAssembly) {
        const sub = assemblies.find((x) => x.id === i.subAssembly);
        if (sub && !within.includes(sub.id) && sub.id !== assembly.id) walk(sub, t, p, n, here, [...within, sub.id]);
        continue;
      }
      out.push({ key: leafKey(t.id, p), top: t.id, path: p, instance: i, name: n.join(" / "), relative: here });
    }
  };
  walk(assembly, null, [], [], IDENTITY, [assembly.id]);
  return out;
}

/** The parts of one top-level instance, from a list of leaves. */
export const leavesOfTop = (leaves: readonly Leaf[], top: string): Leaf[] => leaves.filter((l) => l.top === top);

/**
 * What a key names, without solving anything: its top-level instance, and
 * the part's own instance at the bottom (the same for a plain part). Null when
 * any step is missing.
 */
export function instanceAt(assembly: Assembly, assemblies: readonly Assembly[], key: string): { top: Instance; path: string[]; part: Instance } | null {
  const [topId, ...path] = key.split(PATH_SEP);
  const top = assembly.instances.find((i) => i.id === topId);
  if (!top) return null;
  let here: Instance = top;
  const within = [assembly.id];
  for (const id of path) {
    const sub = here.subAssembly ? assemblies.find((a) => a.id === here.subAssembly) : undefined;
    if (!sub || within.includes(sub.id)) return null;
    within.push(sub.id);
    const next = sub.instances.find((i) => i.id === id);
    if (!next) return null;
    here = next;
  }
  if (here.subAssembly) return null;
  return { top, path, part: here };
}

/**
 * Each part in its place for the geometry engine (exports, drawings, clash
 * checks): top-level instances where `tops` says (their solved or exploded
 * places), parts inside sub-assemblies carried along. Copies of parts that no
 * longer exist are left out.
 */
export function kernelInstances(leaves: readonly Leaf[], parts: readonly PartMesh[], tops: Record<string, Placement>, fallback: (top: string) => Placement): InstanceInput[] {
  const out: InstanceInput[] = [];
  for (const l of leaves) {
    if (!findMesh(parts, meshIdOf(l.instance))) continue;
    const p = compose(tops[l.top] ?? fallback(l.top), l.relative);
    out.push({ id: l.key, partId: meshIdOf(l.instance), name: l.name, position: p.position, rotation: p.rotation, ...(l.instance.mirrored ? { mirrored: true } : {}) });
  }
  return out;
}

/** The box round a top-level instance's parts, in its own coordinates (null when none of them is built). */
export function topBox(leaves: readonly Leaf[], parts: readonly PartMesh[], boxOf: (p: PartMesh) => Box3 | null): Box3 | null {
  let box: Box3 | null = null;
  for (const l of leaves) {
    const mesh = findMesh(parts, meshIdOf(l.instance));
    let b = mesh ? boxOf(mesh) : null;
    if (!b) continue;
    if (l.instance.mirrored) b = mirroredBox(b);
    const placed = placedBox(b, l.relative);
    box = box
      ? { min: [0, 1, 2].map((k) => Math.min(box!.min[k], placed.min[k])) as Box3["min"], max: [0, 1, 2].map((k) => Math.max(box!.max[k], placed.max[k])) as Box3["max"] }
      : placed;
  }
  return box;
}

/**
 * The box round an instance before it's placed: its part's (flipped when
 * mirrored), or for a sub-assembly, the box round all its parts. Null when
 * nothing of it is built.
 */
export function ownBox(assembly: Assembly, i: Instance, parts: readonly PartMesh[], assemblies: readonly Assembly[], boxOf: (p: PartMesh) => Box3 | null): Box3 | null {
  if (i.subAssembly) return topBox(leavesOfTop(leavesOf(assembly, parts, assemblies), i.id), parts, boxOf);
  const mesh = findMesh(parts, meshIdOf(i));
  const b = mesh ? boxOf(mesh) : null;
  return b && i.mirrored ? mirroredBox(b) : b;
}
