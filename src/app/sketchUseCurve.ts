/** The sketch's Use tool on curved edges: asks the geometry engine for the edge's exact shape. */
import type { EdgeRef } from "../geometry/topoRef";
import { getKernel } from "../kernel/connect";
import { useStore } from "../model/store";
import { linkEdge } from "../sketch/links";

/**
 * "Use" on a curved part edge (a spline, an ellipse, or a circle seen at a
 * slant): it comes in as a spline or an ellipse that follows the edge.
 */
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
