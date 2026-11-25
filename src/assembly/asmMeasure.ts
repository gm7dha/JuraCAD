/**
 * Measure and Mass properties in an assembly (Onshape's), pure: which copies are weighed, where a point or
 * direction of a copy's own part ends up as the copy is placed (mirrored, turned, moved — as the engine's
 * placeInstances places it), and what each copy is made of. The engine measures the placed shapes exactly.
 */
import type { InstanceInput } from "../kernel/protocol";
import type { TopoRef, Vec3 } from "../geometry/topoRef";
import { rotate } from "./math";
import { PATH_SEP } from "./subassembly";

type Placed = Pick<InstanceInput, "position" | "rotation" | "mirrored">;

/** Whether a copy's key is the given top-level copy (or sub-assembly) or a part inside it. */
export function keyWithin(key: string, id: string): boolean {
  return key === id || key.startsWith(`${id}${PATH_SEP}`);
}

/** The copies to weigh: those picked (a sub-assembly picked = every part in it), else every one not hidden. */
export function copiesToWeigh(instances: readonly InstanceInput[], picked: readonly string[], hidden: readonly string[]): { instances: InstanceInput[]; all: boolean } {
  const some = picked.length ? instances.filter((i) => picked.some((p) => keyWithin(i.id, p))) : [];
  if (some.length) return { instances: some, all: false };
  return { instances: instances.filter((i) => !hidden.some((h) => keyWithin(i.id, h))), all: true };
}

/** A direction of the part's own (unplaced) coordinates as the copy is placed. */
export function placedDir(inst: Placed, d: Vec3): Vec3 {
  return rotate(inst.rotation, inst.mirrored ? [-d[0], d[1], d[2]] : d);
}

/** A point of the part's own coordinates as the copy is placed: mirrored across its own YZ plane, turned, moved. */
export function placedPoint(inst: Placed, p: Vec3): Vec3 {
  const r = placedDir(inst, p);
  return [r[0] + inst.position[0], r[1] + inst.position[1], r[2] + inst.position[2]];
}

/** A face/edge reference moved with its copy (for the angle between two picks on different copies). */
export function placedRef(ref: TopoRef, inst: Placed): TopoRef {
  if (ref.kind === "edge") return { kind: "edge", curve: ref.curve, a: placedPoint(inst, ref.a), b: placedPoint(inst, ref.b), mid: placedPoint(inst, ref.mid) };
  return { kind: "face", surface: ref.surface, center: placedPoint(inst, ref.center), normal: placedDir(inst, ref.normal) };
}

/** The part a copy shows (configured parts are "<part>@<configuration>"; their material is the part's). */
export function materialPartOf(partId: string, materials: Record<string, string>): string {
  return materials[partId] !== undefined ? partId : partId.split("@")[0];
}
