/** The sketch's Use tool on a face: every edge round it comes in at once (its outline and any holes), as in Onshape. */
import type { PartMesh } from "../kernel/protocol";
import { edgesOfFace } from "../model/faceEdges";
import { useStore } from "../model/store";
import { linkAllEdges, projectEdge, type RefEdge } from "../sketch/links";
import { planeFrame } from "../sketch/planes";
import { copyEdge } from "../sketch/tools";
import type { EdgeRef } from "../geometry/topoRef";
import { bringInCurvedEdge } from "./sketchUseCurve";

export async function takeWholeFace(part: PartMesh, face: number): Promise<void> {
  const s = useStore.getState();
  const plane = s.editing?.draft.sketch?.plane;
  let data = s.editing?.draft.sketch?.data;
  if (!plane || !data || !s.sketch) return;
  const frame = planeFrame(plane);
  const flat: RefEdge[] = [];
  const curved: EdgeRef[] = [];
  const copied: string[] = [];
  for (const index of edgesOfFace(part, face)) {
    const ref = part.edgeRefs[index];
    if (!ref) continue;
    // The same three ways as clicking each edge: straight and round edges linked, curved ones read exactly by the engine.
    const seen = ref.curve === "UNKNOWN" ? null : projectEdge(frame, { partId: part.id, ref });
    if (ref.curve !== "UNKNOWN" && ref.curve !== "LINE" && (!seen || seen.kind === "curve")) curved.push(ref);
    else if (seen && seen.kind !== "curve") flat.push(seen);
    else {
      const r = copyEdge(data, frame, ref);
      if (!r.error) {
        data = r.sketch;
        copied.push(...r.curveIds);
      }
    }
  }
  if (!flat.length && !curved.length && !copied.length) {
    s.setSketchMessage("None of this face's edges can be used here. Click its edges one at a time instead.", "info");
    return;
  }
  let ids = copied;
  if (flat.length) {
    const r = linkAllEdges(data, flat);
    if (!r.error) {
      data = r.sketch;
      ids = [...ids, ...r.curveIds];
    }
  }
  if (ids.length) s.updateSketch(data, { record: true, selection: ids });
  for (const ref of curved) await bringInCurvedEdge(part.id, ref);
  const n = ids.length + curved.length;
  useStore.getState().setSketchMessage(`Used ${n} edge${n === 1 ? "" : "s"} of the face. They follow the part if it changes.`, "info");
}
