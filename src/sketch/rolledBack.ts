/**
 * Editing an early sketch (pure). Later features' parts are hidden and parts they changed are drawn see-through with
 * their finished shape (`partsAfterSketch`), but the sketch itself is built — and its links to part edges re-found —
 * as the parts were at its point in the list. So a "Use" click on a see-through part's finished shape is checked
 * against that part's edges as they were then (the face's own edges and the snap list, both from the sketch's point in
 * the build), the way the engine will look for it, instead of linking to an edge that isn't there yet.
 */
import { strictMatch, type EdgeRef, type TopoRef, type Vec3 } from "../geometry/topoRef";
import type { RefEdge } from "./links";

/** The engine stops the snap list here; past it the list may be missing edges, so nothing is refused. */
const MOST_REFS = 20000;
/** How far off the engine looks for a linked edge again (followSketch: strictMatch reach 0.3). */
const LINK_REACH = 0.3;

/** The part's edges as they were at the sketch, once each (null: not known yet, so let it be). */
function edgesThen(partId: string, faceEdges: readonly RefEdge[], candidates: readonly RefEdge[] | null): TopoRef[] | null {
  if (!candidates || candidates.length >= MOST_REFS) return null;
  const seen = new Set<string>();
  const out: TopoRef[] = [];
  for (const e of [...faceEdges, ...candidates]) {
    if (e.pick?.partId !== partId) continue;
    // (A Pierce place carries the same edge as the edge itself.)
    const key = JSON.stringify(e.pick.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e.pick.ref);
  }
  return out;
}

/** Whether an edge of the finished part was there at the sketch's point (null: can't tell). */
export function edgeThen(partId: string, ref: EdgeRef, size: number, faceEdges: readonly RefEdge[], candidates: readonly RefEdge[] | null): boolean | null {
  const then = edgesThen(partId, faceEdges, candidates);
  if (!then) return null;
  return strictMatch(ref, then, size, LINK_REACH) !== null;
}

/** Whether a corner of the finished part was there at the sketch's point — some edge then ended near it (null: can't tell). */
export function cornerThen(partId: string, p: Vec3, size: number, faceEdges: readonly RefEdge[], candidates: readonly RefEdge[] | null): boolean | null {
  const then = edgesThen(partId, faceEdges, candidates);
  if (!then) return null;
  const reach = Math.max(0.5, 0.1 * size);
  const near = (q: Vec3) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) <= reach;
  return then.some((r) => r.kind === "edge" && (near(r.a) || near(r.b)));
}

/** A part's size, as the engine measures it (its box's diagonal), from its display mesh. */
export function meshSize(vertices: ArrayLike<number>): number {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < vertices.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], vertices[i + k]);
      hi[k] = Math.max(hi[k], vertices[i + k]);
    }
  return lo[0] === Infinity ? 0 : Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
}

/** What the sketch panel says when such an edge (or corner, or face) is clicked. */
export const NOT_THERE_YET =
  "That was made by a feature further down the list, so it isn't there yet at this sketch (the see-through part shows the finished model). Pick an edge that's there before it.";
