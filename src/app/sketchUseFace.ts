/** The sketch's Use tool on a face: every edge round it comes in at once (its outline and any holes), as in Onshape. */
import type { PartMesh } from "../kernel/protocol";
import type { EdgeRef } from "../geometry/topoRef";
import { edgesOfFace } from "../model/faceEdges";
import { useStore } from "../model/store";
import { linkAllEdges, projectEdge, type RefEdge } from "../sketch/links";
import { planeFrame } from "../sketch/planes";
import { copyEdge } from "../sketch/tools";
import { readCurvedEdge } from "./sketchUseCurve";

/**
 * Each edge is brought in the way clicking it would (straight and round edges linked to the part, curved ones read
 * exactly by the engine and linked too, anything else copied as plain geometry), all in one undo step, and
 * everything brought in is selected.
 */
export async function takeWholeFace(part: PartMesh, face: number): Promise<void> {
  const s = useStore.getState();
  const plane = s.editing?.draft.sketch?.plane;
  if (!plane || !s.editing?.draft.sketch?.data || !s.sketch) return;
  const frame = planeFrame(plane);
  const linked: RefEdge[] = [];
  const curved: EdgeRef[] = [];
  const plain: EdgeRef[] = [];
  for (const index of edgesOfFace(part, face)) {
    const ref = part.edgeRefs[index];
    if (!ref) continue;
    const seen = ref.curve === "UNKNOWN" ? null : projectEdge(frame, { partId: part.id, ref });
    if (ref.curve !== "UNKNOWN" && ref.curve !== "LINE" && (!seen || seen.kind === "curve")) curved.push(ref);
    else if (seen && seen.kind !== "curve") linked.push(seen);
    else plain.push(ref);
  }
  // The engine reads curved edges first; nothing is changed until every answer is in.
  for (const ref of curved) {
    const r = await readCurvedEdge(part.id, ref, plane);
    if (r === null) return;
    if (typeof r !== "string") linked.push(r);
  }
  const now = useStore.getState();
  let data = now.editing?.draft.sketch?.data;
  if (!data || !now.sketch) return;
  const ids: string[] = [];
  let following = 0;
  if (linked.length) {
    const r = linkAllEdges(data, linked);
    if (!r.error) {
      data = r.sketch;
      ids.push(...r.curveIds);
      following = r.curveIds.length;
    }
  }
  for (const ref of plain) {
    const r = copyEdge(data, frame, ref);
    if (r.error) continue;
    data = r.sketch;
    ids.push(...r.curveIds);
  }
  if (!ids.length) {
    now.setSketchMessage("None of this face's edges could be used here. Try clicking its edges one at a time.", "info");
    return;
  }
  now.updateSketch(data, { record: true, selection: ids });
  const copied = ids.length - following;
  const words = (n: number) => `${n} edge${n === 1 ? "" : "s"}`;
  now.setSketchMessage(
    copied === 0
      ? `Used ${words(following)} of the face. They follow the part if it changes.`
      : following === 0
        ? `Copied ${words(copied)} of the face into the sketch (as plain shapes: they won't follow the part).`
        : `Used ${words(ids.length)} of the face: ${following} follow the part if it changes, ${copied} copied as plain shapes that won't.`,
    "info",
  );
}
