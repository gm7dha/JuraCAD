/**
 * Fast lists of a shape's faces, edges and solids.
 *
 * replicad's own `.faces` / `.edges` compare every item with every other to
 * skip repeats, which gets very slow on shapes with thousands of faces (such
 * as imported STL files). Here repeats are found by hash first.
 */
import { cast, getOC, type Edge, type Face, type Wire, type Shape3D } from "replicad";

const HASH_MAX = 2147483647;

/* eslint-disable @typescript-eslint/no-explicit-any */
function list<T>(shape: { wrapped: unknown }, kind: "TopAbs_FACE" | "TopAbs_EDGE" | "TopAbs_SOLID" | "TopAbs_WIRE" | "TopAbs_SHELL"): T[] {
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
export const wiresOf = (shape: { wrapped: unknown }): Wire[] => list<Wire>(shape, "TopAbs_WIRE");
export const solidsOf = (shape: { wrapped: unknown }): Shape3D[] => list<Shape3D>(shape, "TopAbs_SOLID");
export const shellsOf = (shape: { wrapped: unknown }): { delete(): void }[] => list<{ delete(): void }>(shape, "TopAbs_SHELL");

/**
 * Seams: the line down the side of a cylinder, cone or sphere where the
 * surface meets itself (a face's outline runs along it twice). Onshape doesn't
 * show those (they aren't real edges of the shape), and clicking one would get
 * in the way of picking the round face. The free edges of a surface (a skin)
 * are real edges, and are kept.
 */
export function seamEdgeIds(shape: Shape3D): Set<number> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const seams = new Set<number>();
  for (const f of facesOf(shape)) {
    try {
      // A seam runs round the face twice (once each way), so it turns up twice when the face's edges are walked.
      const seen = new Map<number, number>();
      const explorer = new oc.TopExp_Explorer(f.wrapped, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      try {
        for (; explorer.More(); explorer.Next()) {
          const current = explorer.Current();
          const h = oc.ReplicadShapeHasher.HashCode(current, 2147483647) as number;
          current.delete();
          seen.set(h, (seen.get(h) ?? 0) + 1);
        }
      } finally {
        explorer.delete();
      }
      for (const [h, n] of seen) if (n > 1) seams.add(h);
    } finally {
      f.delete();
    }
  }
  return seams;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
