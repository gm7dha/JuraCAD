/**
 * Split face (Onshape's Split, "Face" type): faces of a part divided along
 * lines — where a plane or a sketch's curves (pushed straight along the
 * sketch's normal) cross them, or along edges lying on them — leaving one
 * part with more faces and exactly the same shape. The new faces can then be
 * picked on their own (to draft half a face, move part of it, and so on).
 */
import { cast, getOC, measureVolume, type Edge, type Face, type Shape3D } from "replicad";
import { edgesOf, facesOf, solidsOf } from "./topology";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Where a tool (a big plane, a sheet of surfaces, or edges) meets one face: edges lying on that face. */
function sectionEdges(face: Face, tool: Shape3D): Edge[] {
  const oc = getOC() as any;
  const op = new oc.BRepAlgoAPI_Section(face.wrapped, tool.wrapped, true);
  let cut: Shape3D | null = null;
  try {
    if (op.HasErrors && op.HasErrors()) return [];
    cut = cast(op.Shape()) as unknown as Shape3D;
    return edgesOf(cut);
  } catch {
    return [];
  } finally {
    cut?.delete();
    op.delete();
  }
}

/**
 * The part with the picked faces divided where `tool` crosses them (`tool`
 * may be surfaces or a plane's sheet — its section with each face is used —
 * or, with `onFace`, edges already lying on the faces). Throws plain errors;
 * the input is left alone.
 */
export function splitFaces(shape: Shape3D, faces: Face[], tool: Shape3D, opts: { onFace?: boolean; surface?: boolean } = {}): { shape: Shape3D; added: number } {
  const oc = getOC() as any;
  const lines: Edge[] = opts.onFace ? edgesOf(tool) : faces.flatMap((f) => sectionEdges(f, tool));
  if (lines.length === 0) throw new Error("Nothing crosses the picked faces, so there's nothing to split them along. Move the plane or sketch so it runs across them.");
  const before = facesOf(shape);
  const countBefore = before.length;
  before.forEach((f) => f.delete());
  const splitter = new oc.BRepAlgoAPI_Splitter();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  let result: Shape3D;
  try {
    args.Append(shape.wrapped);
    for (const e of lines) tools.Append(e.wrapped);
    splitter.SetArguments(args);
    splitter.SetTools(tools);
    splitter.Build();
    if (splitter.HasErrors()) throw new Error("Couldn't split the faces along those lines.");
    result = cast(splitter.Shape()) as Shape3D;
  } finally {
    splitter.delete();
    args.delete();
    tools.delete();
    lines.forEach((e) => e.delete());
  }
  // The splitter hands back a compound: take the solid (or the surface's shell) out of it again.
  if (!opts.surface) {
    const solids = solidsOf(result);
    if (solids.length === 1) {
      result.delete();
      result = solids[0];
    } else solids.forEach((s) => s.delete());
  }
  const after = facesOf(result);
  const added = after.length - countBefore;
  after.forEach((f) => f.delete());
  if (added <= 0) {
    result.delete();
    throw new Error("The lines don't divide the picked faces (they must run right across a face, or round a closed loop on it).");
  }
  if (!opts.surface) {
    let same = false;
    try {
      const a = measureVolume(shape);
      const b = measureVolume(result);
      same = Math.abs(a - b) <= Math.max(1e-6, Math.abs(a) * 1e-7);
    } catch {
      same = false;
    }
    if (!same) {
      result.delete();
      throw new Error("Splitting these faces would change the part's shape, so it wasn't done.");
    }
  }
  return { shape: result, added };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
