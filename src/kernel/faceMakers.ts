/**
 * Which feature made each face of a part (Onshape's "the feature that made this face"), worked out while a Part
 * Studio builds: after each feature, the faces of parts whose shape changed are looked at. A face OpenCascade kept as
 * it was (same TShape — booleans and fillets leave untouched faces alone) keeps its maker; a new face lying on a
 * surface the part already had (a top face trimmed by a fillet, split by a cut) keeps that surface's maker; any other
 * new face was made by this feature. Cheap: parts whose shape didn't change aren't looked at.
 */
import { getOC, type Shape3D } from "replicad";

/** Parts with more faces than this (an imported mesh: a face per triangle) aren't tagged; their faces count as the part's latest feature's. */
export const MOST_FACES = 3000;

interface Tagged {
  id: string;
  shape: Shape3D;
}

export class FaceMakers {
  /** Face hash → feature id. */
  private readonly byFace = new Map<number, string>();
  /** Part id → surface key → feature id (the first feature to put a face on that surface). */
  private readonly bySurface = new Map<string, Map<string, string>>();
  /** Part id → the shape last looked at. */
  private readonly seen = new Map<string, Shape3D>();

  /** Part id → each face's maker, in the order OpenCascade walks the faces (for a part moved as a whole). */
  private readonly order = new Map<string, string[]>();

  /**
   * After `featureId` built: tag the new faces of the parts it changed. `moved`: the feature only moved parts (a Move /
   * copy without a copy) — a moved part's faces are new to OpenCascade (copied, placed elsewhere) but are the same
   * faces in the same order, so they keep their makers when the count is unchanged (as in Onshape).
   */
  after(featureId: string, parts: Tagged[], moved = false): void {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const oc = getOC() as any;
    for (const p of parts) {
      if (this.seen.get(p.id) === p.shape) continue;
      this.seen.set(p.id, p.shape);
      let surfaces = this.bySurface.get(p.id);
      if (!surfaces) this.bySurface.set(p.id, (surfaces = new Map()));
      // Walked with OpenCascade's explorer (no replicad Face per face); parts with very many faces (an imported mesh) aren't tagged.
      const ex = new oc.TopExp_Explorer(p.shape.wrapped, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      try {
        let n = 0;
        for (; ex.More(); ex.Next()) if (++n > MOST_FACES) break;
        if (n > MOST_FACES) {
          this.order.delete(p.id);
          continue;
        }
        const before = this.order.get(p.id);
        const carried = moved && before?.length === n ? before : null;
        const now: string[] = [];
        let i = 0;
        for (ex.ReInit(); ex.More(); ex.Next(), i++) {
          const current = ex.Current();
          try {
            const hash = oc.ReplicadShapeHasher.HashCode(current, 2147483647) as number;
            // A face kept as it was keeps its maker (its surface was noted when it was first seen).
            const known = this.byFace.get(hash);
            if (known && !carried) {
              now.push(known);
              continue;
            }
            const face = oc.TopoDS.Face(current);
            let key: string | null = null;
            try {
              key = surfaceKey(face);
            } finally {
              face.delete?.();
            }
            // Moved: its maker from before; the surface it's on now is noted for it.
            const maker = carried?.[i] || (key && surfaces.get(key)) || featureId;
            this.byFace.set(hash, maker);
            if (key && !surfaces.has(key)) surfaces.set(key, maker);
            now.push(maker);
          } catch {
            now.push("");
          } finally {
            current.delete?.();
          }
        }
        this.order.set(p.id, now);
      } finally {
        ex.delete();
      }
    }
  }

  /** The feature that made the face with this hash, if known. */
  makerOf(hash: number): string | undefined {
    return this.byFace.get(hash);
  }
}

const r = (v: number) => Math.round(v * 1e4) / 1e4;

/** A direction turned to point one fixed way (its first clear component positive). */
function canonical(d: [number, number, number]): [number, number, number] {
  const i = Math.abs(d[0]) > 1e-9 ? 0 : Math.abs(d[1]) > 1e-9 ? 1 : 2;
  return d[i] < 0 ? [-d[0], -d[1], -d[2]] : d;
}

/** Planes and cylinders: a short text that is the same for faces on the same surface (null for other kinds). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function surfaceKey(face: any): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const s = new oc.BRepAdaptor_Surface(face, true);
  try {
    const T = oc.GeomAbs_SurfaceType;
    const type = s.GetType();
    if (type !== T.GeomAbs_Plane && type !== T.GeomAbs_Cylinder) return null;
    if (type === T.GeomAbs_Plane) {
      const pl = s.Plane();
      const ax = pl.Axis();
      const loc = ax.Location();
      const dir = ax.Direction();
      const n = canonical([dir.X(), dir.Y(), dir.Z()]);
      const d = n[0] * loc.X() + n[1] * loc.Y() + n[2] * loc.Z();
      [dir, loc, ax, pl].forEach((x) => x.delete());
      return `P${r(n[0])},${r(n[1])},${r(n[2])},${r(d)}`;
    }
    const cyl = s.Cylinder();
    const ax = cyl.Axis();
    const loc = ax.Location();
    const dir = ax.Direction();
    const a = canonical([dir.X(), dir.Y(), dir.Z()]);
    const p: [number, number, number] = [loc.X(), loc.Y(), loc.Z()];
    // The axis' point nearest the origin, so any point along it gives the same key.
    const t = p[0] * a[0] + p[1] * a[1] + p[2] * a[2];
    const q = [p[0] - t * a[0], p[1] - t * a[1], p[2] - t * a[2]];
    const radius = cyl.Radius();
    [dir, loc, ax, cyl].forEach((x) => x.delete());
    return `C${r(a[0])},${r(a[1])},${r(a[2])},${r(q[0])},${r(q[1])},${r(q[2])},${r(radius)}`;
  } finally {
    s.delete();
  }
}
