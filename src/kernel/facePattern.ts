/**
 * Face pattern and face mirror (Onshape's Pattern type "Face"): faces picked on
 * one part — the sides and top of a boss, the walls and floor of a pocket, the
 * inside of a hole — stand for the piece of solid (or of empty space) they
 * bound. That piece is found by closing the faces up: where they stop (their
 * open rim, which lies on the face they sit on) each loop is capped with a flat
 * face, and the faces and caps are made a solid. If that solid is part of the
 * part (a boss) its copies are added; if it's empty space (a pocket or a hole)
 * its copies are cut.
 *
 * Covered: faces whose open rim is made of flat loops (bosses, pockets, holes
 * and slots on flat faces, with their fillets and chamfers if picked too). A
 * rim that isn't flat (a boss on a round face) is refused in plain words.
 */
import { assembleWire, cast, getOC, makeSolid, measureVolume, type Edge, type Face, type Shape3D } from "replicad";
import { edgesOf, solidsOf } from "./topology";

type P = [number, number, number];
const take = (v: { x: number; y: number; z: number; delete?: () => void }): P => {
  const p: P = [v.x, v.y, v.z];
  v.delete?.();
  return p;
};
const gap = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The edges only one of the faces runs along (once): their open rim. Seams (run along twice by one face) aren't. */
function rimEdges(faces: Face[]): Edge[] {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const count = new Map<number, { edge: Edge; n: number }[]>();
  for (const face of faces) {
    const explorer = new oc.TopExp_Explorer(face.wrapped, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; explorer.More(); explorer.Next()) {
      const edge = cast(explorer.Current()) as Edge;
      const bucket = count.get(edge.hashCode) ?? [];
      const seen = bucket.find((b) => b.edge.wrapped.IsSame(edge.wrapped));
      if (seen) {
        seen.n++;
        edge.delete();
      } else {
        bucket.push({ edge, n: 1 });
        count.set(edge.hashCode, bucket);
      }
    }
    explorer.delete();
  }
  const out: Edge[] = [];
  for (const bucket of count.values()) {
    for (const { edge, n } of bucket) {
      if (n === 1 && !oc.BRep_Tool.Degenerated(edge.wrapped)) out.push(edge);
      else edge.delete();
    }
  }
  return out;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** The rim's edges joined end to end into loops (each in walking order), or null if they don't close up. */
function loopsOf(edges: Edge[], tol: number): Edge[][] | null {
  const ends = edges.map((e) => ({ a: take(e.startPoint), b: take(e.endPoint) }));
  const used = new Set<number>();
  const loops: Edge[][] = [];
  for (let i = 0; i < edges.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const loop = [edges[i]];
    const start = ends[i].a;
    let end = ends[i].b;
    while (gap(start, end) > tol) {
      let next = -1;
      for (let j = 0; j < edges.length; j++) {
        if (used.has(j)) continue;
        if (gap(ends[j].a, end) <= tol) {
          next = j;
          end = ends[j].b;
          break;
        }
        if (gap(ends[j].b, end) <= tol) {
          next = j;
          end = ends[j].a;
          break;
        }
      }
      if (next < 0) return null;
      used.add(next);
      loop.push(edges[next]);
    }
    loops.push(loop);
  }
  return loops;
}

/** A flat face filling a closed loop of edges (throws when the loop isn't flat). */
function capOf(loop: Edge[]): Face {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const wire = assembleWire(loop);
  const maker = new oc.BRepBuilderAPI_MakeFace(wire.wrapped, true);
  try {
    if (!maker.IsDone()) throw new Error("not flat");
    return cast(maker.Face()) as Face;
  } finally {
    maker.delete();
    wire.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

export interface FaceRegion {
  /** The solid the faces bound (a boss's material, or a pocket's or hole's space). */
  tool: Shape3D;
  /** Copies join the part (a boss) or cut it (a pocket or hole). */
  operation: "add" | "remove";
}

/**
 * The piece of solid or space that faces of `part` bound, closed up with flat
 * caps where they stop. Throws a plain-English error when it can't be found.
 */
export function regionOfFaces(faces: Face[], part: Shape3D): FaceRegion {
  if (!faces.length) throw new Error("Click the faces to repeat — for example the side and top of a boss, or the walls and floor of a pocket or hole.");
  const rim = rimEdges(faces);
  const caps: Face[] = [];
  let solid: Shape3D | null = null;
  try {
    if (rim.length) {
      const all = edgesOf(part);
      const scale = Math.max(1, ...all.map((e) => e.length));
      all.forEach((e) => e.delete());
      const loops = loopsOf(rim, Math.max(1e-4, scale * 1e-6));
      if (!loops) throw new Error("The picked faces don't close up into one piece. Pick every face of the boss or pocket (its sides as well as its top or floor).");
      for (const loop of loops) {
        try {
          caps.push(capOf(loop));
        } catch {
          throw new Error("Where the picked faces meet the rest of the part isn't flat, so the boss or pocket can't be repeated. Face patterns work on bosses, pockets and holes on flat faces — pattern the features that made it instead.");
        }
      }
    }
    try {
      solid = makeSolid([...faces, ...caps] as never[]) as unknown as Shape3D;
    } catch {
      throw new Error("The picked faces don't close up into one piece. Pick every face of the boss or pocket (its sides as well as its top or floor).");
    }
    const volume = measureVolume(solid);
    const pieces = solidsOf(solid);
    pieces.forEach((p) => p.delete());
    if (!(volume > 1e-6) || pieces.length !== 1) throw new Error("The picked faces don't close up into one piece. Pick every face of the boss or pocket (its sides as well as its top or floor) — not just its floor or top.");
    // Inside the part = a boss (its copies are added); outside = a pocket or hole (its copies are cut).
    let inside = 0;
    const common = part.clone().intersect(solid);
    try {
      inside = measureVolume(common);
    } finally {
      common.delete();
    }
    const share = inside / volume;
    if (share > 0.02 && share < 0.98) throw new Error("The picked faces enclose some of the part and some empty space, so it can't tell whether to add or cut. Pick the faces of just one boss, pocket or hole.");
    const tool = solid;
    solid = null;
    return { tool, operation: share >= 0.5 ? "add" : "remove" };
  } finally {
    rim.forEach((e) => e.delete());
    caps.forEach((c) => c.delete());
    solid?.delete();
  }
}
