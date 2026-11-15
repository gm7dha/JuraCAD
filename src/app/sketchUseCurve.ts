/** The sketch's Use tool on curved edges: asks the geometry engine for the edge's exact shape. */
import type { EdgeRef } from "../geometry/topoRef";
import { getKernel } from "../kernel/connect";
import { useStore } from "../model/store";
import { linkEdge, type RefEdge } from "../sketch/links";
import type { SketchPlane } from "../sketch/planes";

/**
 * "Use" on a curved part edge (a spline, an ellipse, or a circle seen at a
 * slant): it comes in as a spline or an ellipse that follows the edge.
 */
/**
 * A curved part edge's exact shape seen on the open sketch's plane, from the geometry engine — or what went wrong
 * (null when the sketch was closed or moved to another plane while the engine worked).
 */
export async function readCurvedEdge(partId: string, ref: EdgeRef, plane: SketchPlane): Promise<RefEdge | string | null> {
  let result;
  try {
    result = await getKernel().useEdge(partId, ref, plane);
  } catch (e) {
    return e instanceof Error ? e.message : "Something went wrong reading that edge.";
  }
  const now = useStore.getState();
  if (!now.editing?.draft.sketch?.data || !now.sketch || JSON.stringify(now.editing?.draft.sketch?.plane) !== JSON.stringify(plane)) return null;
  return "error" in result ? result.error : result.edge;
}

export async function bringInCurvedEdge(partId: string, ref: EdgeRef): Promise<void> {
  const s = useStore.getState();
  const plane = s.editing?.draft.sketch?.plane;
  if (!plane || !s.sketch) return;
  let result;
  try {
    result = await getKernel().useEdge(partId, ref, plane);
  } catch (e) {
    s.setSketchMessage(e instanceof Error ? e.message : "Something went wrong reading that edge.", "error");
    return;
  }
  const now = useStore.getState();
  const data = now.editing?.draft.sketch?.data;
  // The sketch was closed, or put on another plane, while the engine worked.
  if (!data || !now.sketch || JSON.stringify(now.editing?.draft.sketch?.plane) !== JSON.stringify(plane)) return;
  if ("error" in result) {
    now.setSketchMessage(result.error, "error");
    return;
  }
  const r = linkEdge(data, result.edge, false);
  if (r.error) {
    now.setSketchMessage(r.error, "error");
    return;
  }
  now.updateSketch(r.sketch, { selection: [r.curveId] });
  now.setSketchMessage(null);
}
