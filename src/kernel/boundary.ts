/**
 * Boundary surface (Onshape's): a surface through boundary curves in two
 * directions — up to two each way, round one patch. Curves that don't close
 * the outline (two opposite curves, or two plus one) are joined end to end by
 * straight lines. A part edge's side may meet the face beside it smoothly
 * (tangent) or bending the same (curvature). OpenCascade's filling
 * (BRepOffsetAPI_MakeFilling, as Fill uses) builds it, the curves as its
 * edges, so it passes exactly through them.
 */
import { cast, getOC, makeLine, measureLength, type Edge, type Face, type Shape3D, type Wire } from "replicad";
import { chainEdges, endsOf } from "./curves";
import { edgesOf, facesOf } from "./topology";
import { acrossEdge } from "./surface";

type Vec3 = [number, number, number];
/* eslint-disable @typescript-eslint/no-explicit-any */

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** One boundary curve: its wire (the caller frees it), and, for a part's edge, the face beside it to meet. */
export interface BoundaryInput {
  wire: Wire;
  face?: Face | null;
  match?: "tangent" | "curvature";
}

/** How close ends must be to count as meeting. */
const MEET = 1e-3;

/**
 * The surface through the curves (u then v, up to two each way). Throws a plain message when they can't make one.
 * `u`/`v` are how many of `curves` go each way (the first `u` are U).
 */
export function boundarySurface(curves: BoundaryInput[], u: number, v: number): Shape3D {
  if (u > 2 || v > 2) throw new Error("Pick at most two curves each way (U and V): the two opposite sides of the patch.");
  if (u + v < 2) throw new Error("Pick at least two boundary curves: two opposite sides, or the curves all round the patch.");
  if (u === 1 && v === 1) throw new Error("With one curve each way the outline can't close. Pick the opposite side in either direction too.");
  for (const c of curves) if (c.match && !c.face) throw new Error("Tangent and curvature match the face beside a part's edge, so they're only for part edges.");
  const oc = getOC() as any;
  // Every curve's edges, with which curve each came from.
  const pieces: { edge: Edge; from: number }[] = [];
  const made: Edge[] = [];
  try {
    curves.forEach((c, i) => {
      for (const e of edgesOf(c.wire)) {
        let l = 0;
        try {
          l = measureLength(e);
        } catch {
          l = 0;
        }
        if (l > 1e-6) pieces.push({ edge: e, from: i });
        else e.delete();
      }
    });
    if (!pieces.length) throw new Error("The curves have no length.");
    // Join them up; close the outline with straight lines where curves don't meet.
    const runs = chainEdges(pieces.map((p) => p.edge.clone() as Edge), MEET);
    const ends = runs.map((w) => (w.isClosed ? null : endsOf(w)));
    runs.forEach((w) => w.delete());
    if (runs.length === 1 && !ends[0]) {
      // Closed already.
    } else if (runs.length === 1 && ends[0]) {
      made.push(makeLine(ends[0][1], ends[0][0]));
    } else if (runs.length === 2 && ends[0] && ends[1]) {
      const [a0, a1] = ends[0];
      const [b0, b1] = ends[1];
      // Join each end to the nearer of the other's, the way that doesn't cross over.
      if (dist(a0, b0) + dist(a1, b1) <= dist(a0, b1) + dist(a1, b0)) {
        made.push(makeLine(a0, b0), makeLine(a1, b1));
      } else made.push(makeLine(a0, b1), makeLine(a1, b0));
    } else {
      throw new Error("The curves don't make one outline: each must meet the next end to end (or pick two opposite sides only, which are joined by straight lines).");
    }
    // Curvature first asks OpenCascade for G2; where that can't be built (it often can't on a flat face) the points
    // carried on past the edge still shape it, with G1.
    const tryFill = (g2: boolean): Shape3D | null => {
      const filling = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 1e-2, 0.1, 8, 9);
      try {
        for (const p of pieces) {
          const c = curves[p.from];
          if (c.match && c.face) filling.Add(p.edge.wrapped, c.face.wrapped, c.match === "curvature" && g2 ? oc.GeomAbs_Shape.GeomAbs_G2 : oc.GeomAbs_Shape.GeomAbs_G1, true);
          else filling.Add(p.edge.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
        }
        for (const e of made) filling.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
        // OpenCascade's filling often can't bend away from a flat outline on its own (it stays flat and misses the
        // tangent), so a matched side also gets a row of points a little way on past it, along the face carried on —
        // two rows for curvature, which also keeps it from bending at first.
        const size = outlineSize(pieces.map((p) => p.edge));
        const step = 0.08 * size;
        const pts: unknown[] = [];
        for (const p of pieces) {
          const c = curves[p.from];
          if (!c.match || !c.face) continue;
          let across: { at: Vec3[]; out: Vec3[] };
          try {
            across = acrossEdge(p.edge, c.face, 8);
          } catch {
            continue;
          }
          const rows = c.match === "curvature" && g2 ? [step * 0.5, step] : [step];
          across.at.forEach((q, i) => {
            if (i === 0 || i === across.at.length - 1) return; // the corners are held by the edges themselves
            const d = across.out[i];
            for (const h of rows) {
              const pnt = new oc.gp_Pnt(q[0] + d[0] * h, q[1] + d[1] * h, q[2] + d[2] * h);
              pts.push(pnt);
              filling.Add(pnt);
            }
          });
        }
        filling.Build();
        pts.forEach((p) => (p as { delete(): void }).delete());
        if (!filling.IsDone()) throw new Error("no");
        const out = cast(filling.Shape()) as Shape3D;
        const faces = facesOf(out);
        const any = faces.length > 0;
        faces.forEach((f) => f.delete());
        if (!any) {
          out.delete();
          throw new Error("no");
        }
        return out;
      } catch {
        return null;
      } finally {
        filling.delete();
      }
    };
    const wantsG2 = curves.some((c) => c.match === "curvature");
    const out = tryFill(true) ?? (wantsG2 ? tryFill(false) : null);
    if (!out) throw new Error("Couldn't fit a surface through those curves. Check they make one outline (U curves opposite each other, V curves joining their ends).");
    return out;
  } finally {
    pieces.forEach((p) => p.edge.delete());
    made.forEach((e) => e.delete());
  }
}

/** How big the outline is: across its edges' points. */
function outlineSize(edges: Edge[]): number {
  const pts: Vec3[] = [];
  for (const e of edges) for (let i = 0; i <= 4; i++) {
    const v = e.pointAt(i / 4);
    pts.push([v.x, v.y, v.z]);
    v.delete();
  }
  let most = 0;
  for (const a of pts) for (const b of pts) most = Math.max(most, dist(a, b));
  return most;
}
