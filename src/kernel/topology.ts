/**
 * Fast lists of a shape's faces, edges and solids.
 *
 * replicad's own `.faces` / `.edges` compare every item with every other to
 * skip repeats, which gets very slow on shapes with thousands of faces (such
 * as imported STL files). Here repeats are found by hash first.
 */
import { cast, getOC, type Edge, type Face, type Shape3D } from "replicad";

const HASH_MAX = 2147483647;

/* eslint-disable @typescript-eslint/no-explicit-any */
function list<T>(shape: { wrapped: unknown }, kind: "TopAbs_FACE" | "TopAbs_EDGE" | "TopAbs_SOLID"): T[] {
  const oc = getOC() as any;
  const explorer = new oc.TopExp_Explorer(shape.wrapped, oc.TopAbs_ShapeEnum[kind], oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  const buckets = new Map<number, any[]>();
  const out: T[] = [];
  try {
    for (; explorer.More(); explorer.Next()) {
      const item = explorer.Current();
      const hash = oc.ReplicadShapeHasher.HashCode(item, HASH_MAX) as number;
      const bucket = buckets.get(hash);
      if (bucket?.some((s) => s.IsSame(item))) continue;
      if (bucket) bucket.push(item);
      else buckets.set(hash, [item]);
      out.push(cast(item) as T);
    }
  } finally {
    explorer.delete();
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export const facesOf = (shape: { wrapped: unknown }): Face[] => list<Face>(shape, "TopAbs_FACE");
export const edgesOf = (shape: { wrapped: unknown }): Edge[] => list<Edge>(shape, "TopAbs_EDGE");
export const solidsOf = (shape: { wrapped: unknown }): Shape3D[] => list<Shape3D>(shape, "TopAbs_SOLID");
