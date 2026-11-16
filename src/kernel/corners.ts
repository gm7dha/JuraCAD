/**
 * Corners (vertices) of a built part, found again from a pick (see geometry/vertexRef.ts): every open edge's two
 * ends, with the way the edge leaves each, grouped into corners.
 */
import type { Shape3D } from "replicad";
import { cornersFromEnds, matchVertex, type EdgeEnd, type VertexPick, type VertexRef } from "../geometry/vertexRef";
import type { Vec3 } from "../geometry/topoRef";
import { edgesOf } from "./topology";

type Vecish = { x: number; y: number; z: number; delete(): void };
const take = (v: Vecish): Vec3 => {
  const out: Vec3 = [v.x, v.y, v.z];
  v.delete();
  return out;
};

/** Parts with more edges than this (a mesh brought in) aren't searched for corners. */
export const MOST_CORNER_EDGES = 20000;

/** A shape's corners (with its bounding box for their places as shares of it). */
export function shapeCorners(shape: Shape3D): VertexRef[] {
  const box = shape.boundingBox;
  const [min, max] = box.bounds as [Vec3, Vec3];
  box.delete();
  const edges = edgesOf(shape);
  const ends: EdgeEnd[] = [];
  try {
    if (edges.length > MOST_CORNER_EDGES) return [];
    for (const e of edges) {
      try {
        const a = take(e.startPoint);
        const b = take(e.endPoint);
        if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= 1e-6) continue;
        let ta: Vec3 | null = null;
        let tb: Vec3 | null = null;
        try {
          ta = take(e.tangentAt(0));
          const t1 = take(e.tangentAt(1));
          tb = [-t1[0], -t1[1], -t1[2]];
        } catch {
          // a curve with no tangent there: its direction isn't known
        }
        ends.push({ p: a, dir: ta }, { p: b, dir: tb });
      } catch {
        // an edge that can't be read is left out
      }
    }
  } finally {
    edges.forEach((e) => e.delete());
  }
  return cornersFromEnds(ends, min, max);
}

/** Where a picked corner is now on its part, or a plain message saying why it can't be found. */
export function findCorner(parts: { id: string; name: string; shape: Shape3D }[], pick: VertexPick): Vec3 | string {
  const part = parts.find((p) => p.id === pick.partId);
  if (!part) return "The part with the corner it uses no longer exists (or comes later in the list). Click another corner.";
  const box = part.shape.boundingBox;
  const [min, max] = box.bounds as [Vec3, Vec3];
  box.delete();
  const size = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const corners = shapeCorners(part.shape);
  const m = matchVertex(pick.ref, corners, size);
  if (m === null) return `The corner it uses can't be found on ${part.name} any more (the part has changed too much). Click the corner again.`;
  return corners[m].p;
}
