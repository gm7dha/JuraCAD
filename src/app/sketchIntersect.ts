/** The sketch's Intersect tool: asks the geometry engine where the sketch cuts a part. */
import type { FaceRef } from "../geometry/topoRef";
import { getKernel } from "../kernel/connect";
import { useStore } from "../model/store";
import { linkEdge, projectEdge } from "../sketch/links";
import { planeFrame } from "../sketch/planes";

/**
 * Intersect: bring in where the sketch's plane cuts the clicked part (or just
 * the clicked face), as construction lines, arcs and circles that follow the part.
 */
export async function intersectWith(partId: string, face: FaceRef | null): Promise<void> {
  const s = useStore.getState();
  const plane = s.editing?.draft.sketch?.plane;
  if (!plane || !s.sketch) return;
  const whole = s.sketch.intersectWhole || !face;
  let result;
  try {
    result = await getKernel().intersect(partId, plane, whole ? undefined : face!);
  } catch (e) {
    s.setSketchMessage(e instanceof Error ? e.message : "Something went wrong working out where the sketch cuts the part.", "error");
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
  const frame = planeFrame(plane);
  let next = data;
  const ids: string[] = [];
  let skipped = 0;
  for (const ref of result.edges) {
    const seen = projectEdge(frame, { partId, ref });
    const r = seen ? linkEdge(next, seen, true, whole ? {} : { face: face! }) : null;
    if (!r || r.error) {
      skipped++;
      continue;
    }
    next = r.sketch;
    ids.push(r.curveId);
  }
  if (!ids.length) {
    now.setSketchMessage("Where the sketch cuts that is curved in a way the sketch can't follow yet (only straight lines, circles and arcs can be brought in).", "error");
    return;
  }
  now.updateSketch(next, { record: true, selection: ids });
  now.setSketchMessage(
    `Brought in ${ids.length} line${ids.length === 1 ? "" : "s"} where the sketch cuts ${whole ? "the part" : "that face"} (dashed: snap to them, dimension to them, or select them and press Q to use them as real lines). They follow the part if it changes.${skipped ? ` ${skipped} curved piece${skipped === 1 ? " was" : "s were"} left out (only straight lines, circles and arcs can be).` : ""}`,
    "info",
  );
}

