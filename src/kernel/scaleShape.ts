/** Making a shape bigger or smaller by the same amount every way (Import's Scale, Move / copy's Scale uniformly). */
import { cast, getOC, type Shape3D } from "replicad";

/** A new shape: `shape` scaled by `k` (> 0) about `about`. The input is left as it is (the caller still owns it). */
export function scaledShape(shape: Shape3D, k: number, about: [number, number, number] = [0, 0, 0]): Shape3D {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const p = new oc.gp_Pnt(about[0], about[1], about[2]);
  const trsf = new oc.gp_Trsf();
  try {
    trsf.SetScale(p, k);
    const t = new oc.BRepBuilderAPI_Transform(shape.wrapped, trsf, true, false);
    try {
      return cast(t.Shape()) as Shape3D;
    } finally {
      t.delete();
    }
  } finally {
    p.delete();
    trsf.delete();
  }
}
