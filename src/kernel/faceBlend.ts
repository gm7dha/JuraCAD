/**
 * Face blend (Onshape's): a rolling-ball blend between two sets of faces, on
 * any parts or surfaces. A ball of the given radius rolls touching a face of
 * each side: its middle runs along where the two faces, each moved out by the
 * radius (to the ball's side), meet — the spine. At each place along it the
 * blend's cross-section is the arc of the ball between where it touches the two
 * faces; the arcs are lofted into the blend surface.
 *
 * Which side of each face the ball is on is worked out (the way that gives a
 * spine: both faces outwards, both inwards, then one of each); `flip1`/`flip2`
 * turn a side over from that.
 */
import { assembleWire, cast, getOC, makeLine, makeThreePointArc, measureLength, type Face, type Shape3D, type Wire } from "replicad";
import { chainEdges, interpolatedEdge, sectionEdges, takeVec } from "./curves";
import { facesOf } from "./topology";

type Vec3 = [number, number, number];
/* eslint-disable @typescript-eslint/no-explicit-any */

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** One piece of blend (between one face of each side), with where it touches each. */
export interface BlendPiece {
  shape: Shape3D;
  /** Which faces of each side it touches (indexes into the lists given). */
  a: number;
  b: number;
  /** Points where it touches each face, and at each the way along that face towards the blend (under it). */
  touchA: { p: Vec3; under: Vec3 }[];
  touchB: { p: Vec3; under: Vec3 }[];
  /** It goes all the way round (a ring, as round a boss): the touching points don't repeat the first. */
  closed: boolean;
}

/** A face moved out along its normal (minus: in), as a skin. Null when it can't be (a round face moved in past its axis). */
function movedFace(face: Face, distance: number): Shape3D | null {
  const oc = getOC() as any;
  const builder = new oc.BRepOffsetAPI_MakeOffsetShape();
  try {
    builder.PerformByJoin(face.wrapped, distance, 1e-5, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false);
    if (!builder.IsDone()) return null;
    const out = cast(builder.Shape()) as Shape3D;
    const faces = facesOf(out);
    const any = faces.length > 0;
    faces.forEach((f) => f.delete());
    if (!any) {
      out.delete();
      return null;
    }
    return out;
  } catch {
    return null;
  } finally {
    builder.delete();
  }
}

/** The nearest point of a face to `p`. */
export function nearestOnFace(face: Face, p: Vec3): Vec3 | null {
  const oc = getOC() as any;
  const pnt = new oc.gp_Pnt(p[0], p[1], p[2]);
  const vertex = new oc.BRepBuilderAPI_MakeVertex(pnt);
  const dist = new oc.BRepExtrema_DistShapeShape();
  try {
    dist.LoadS1(vertex.Vertex());
    dist.LoadS2(face.wrapped);
    if (!dist.Perform() || dist.NbSolution() === 0) return null;
    const q = dist.PointOnShape2(1);
    const out: Vec3 = [q.X(), q.Y(), q.Z()];
    q.delete();
    return out;
  } finally {
    dist.delete();
    vertex.delete();
    pnt.delete();
  }
}

/** Where the ball's middle runs between two faces (with the ball on side `sa` of a and `sb` of b): wires, maybe none. */
function spineOf(a: Face, b: Face, r: number, sa: number, sb: number): Wire[] {
  const ma = movedFace(a, sa * r);
  if (!ma) return [];
  const mb = movedFace(b, sb * r);
  if (!mb) {
    ma.delete();
    return [];
  }
  try {
    const edges = sectionEdges(ma, mb).filter((e) => {
      let l = 0;
      try {
        l = measureLength(e);
      } catch {
        l = 0;
      }
      if (l > 1e-4) return true;
      e.delete();
      return false;
    });
    return edges.length ? chainEdges(edges, 1e-3) : [];
  } finally {
    ma.delete();
    mb.delete();
  }
}

/** The arcs along a spine, lofted into one piece of blend. Null when the ball doesn't really touch both faces there. */
function blendAlong(spine: Wire, a: Face, b: Face, r: number): Omit<BlendPiece, "a" | "b"> | null {
  const oc = getOC() as any;
  let length = 0;
  try {
    length = measureLength(spine);
  } catch {
    return null;
  }
  if (length < 1e-3) return null;
  const closed = spine.isClosed;
  const straight = (() => {
    const s = takeVec(spine.startPoint);
    const e = takeVec(spine.endPoint);
    return !closed && Math.abs(len(sub(e, s)) - length) < 1e-6 * Math.max(1, length);
  })();
  const n = straight ? 2 : Math.max(12, Math.min(96, Math.ceil(length / Math.max(0.5, r / 2))));
  const count = closed ? n : n + 1;
  const arcs: Wire[] = [];
  const touchA: BlendPiece["touchA"] = [];
  const touchB: BlendPiece["touchB"] = [];
  try {
    for (let i = 0; i < count; i++) {
      const c = takeVec(spine.pointAt(i / n));
      const p1 = nearestOnFace(a, c);
      const p2 = nearestOnFace(b, c);
      if (!p1 || !p2) return null;
      const r1 = sub(p1, c);
      const r2 = sub(p2, c);
      // The ball must touch both faces (its middle is the radius from each).
      const tol = Math.max(1e-3, 1e-3 * r);
      if (Math.abs(len(r1) - r) > tol || Math.abs(len(r2) - r) > tol) return null;
      const between = add(unit(r1), unit(r2));
      if (len(between) < 1e-3) return null; // touching on opposite sides: no arc between
      if (len(sub(p1, p2)) < 1e-5) return null; // the faces meet there: nothing to blend
      const pm = add(c, mul(unit(between), r));
      const arc = makeThreePointArc(p1, pm, p2);
      arcs.push(assembleWire([arc]));
      arc.delete();
      touchA.push({ p: p1, under: unit(sub(sub(p2, p1), mul(unit(r1), dot(sub(p2, p1), unit(r1))))) });
      touchB.push({ p: p2, under: unit(sub(sub(p1, p2), mul(unit(r2), dot(sub(p1, p2), unit(r2))))) });
    }
    const builder = new oc.BRepOffsetAPI_ThruSections(false, false, 1e-6);
    try {
      builder.CheckCompatibility(false);
      for (const w of arcs) builder.AddWire(w.wrapped);
      if (closed) builder.AddWire(arcs[0].wrapped);
      builder.Build();
      if (!builder.IsDone()) return null;
      const shape = cast(builder.Shape()) as Shape3D;
      return { shape, touchA, touchB, closed };
    } catch {
      return null;
    } finally {
      builder.delete();
    }
  } finally {
    arcs.forEach((w) => w.delete());
  }
}

/** Every piece of blend between the two sides with the ball on sides (sa, sb). */
function blendsFor(sideA: Face[], sideB: Face[], r: number, sa: number, sb: number): BlendPiece[] {
  const out: BlendPiece[] = [];
  sideA.forEach((fa, i) => {
    sideB.forEach((fb, j) => {
      for (const spine of spineOf(fa, fb, r, sa, sb)) {
        try {
          const piece = blendAlong(spine, fa, fb, r);
          if (piece) out.push({ ...piece, a: i, b: j });
        } finally {
          spine.delete();
        }
      }
    });
  });
  return out;
}

/**
 * The blend between two sets of faces: its pieces (the caller frees their shapes) and which side of each set the ball
 * was on (+1: the way the faces face, −1 the other). Throws a plain message when a ball of that radius can't touch both.
 */
export function faceBlend(sideA: Face[], sideB: Face[], radius: number, flip1 = false, flip2 = false): { pieces: BlendPiece[]; sides: [number, number] } {
  if (!sideA.length || !sideB.length) throw new Error("Click faces for both sides of the blend.");
  if (!(radius > 0)) throw new Error("Radius: enter how big the rolling ball is.");
  const tries: [number, number][] = [
    [1, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
  ];
  const f1 = flip1 ? -1 : 1;
  const f2 = flip2 ? -1 : 1;
  for (const [sa, sb] of tries) {
    const pieces = blendsFor(sideA, sideB, radius, sa, sb);
    if (!pieces.length) continue;
    if (f1 === 1 && f2 === 1) return { pieces, sides: [sa, sb] };
    pieces.forEach((p) => p.shape.delete());
    const flipped = blendsFor(sideA, sideB, radius, sa * f1, sb * f2);
    if (!flipped.length) throw new Error("With that side flipped, a ball of that size can't touch both sides. Flip it back, or change the radius.");
    return { pieces: flipped, sides: [sa * f1, sb * f2] };
  }
  throw new Error("A ball of that size can't roll touching both sides: the faces are too far apart, or too close, or curve away. Try another radius.");
}

/** A strip standing square to a face along where the blend touches it (to cut the face there): the touching line pushed both ways. */
export function cutterAlong(touch: { p: Vec3; under: Vec3 }[], face: Face, reach: number, closed = false, height = 1): Shape3D | null {
  const oc = getOC() as any;
  if (touch.length < 2) return null;
  const normals = touch.map((t) => {
    try {
      return unit(takeVec(face.normalAt(t.p)));
    } catch {
      return null;
    }
  });
  if (normals.some((n) => !n)) return null;
  // Carried on a little past each end, so the cut reaches the face's edges.
  const ext = (p: Vec3, q: Vec3) => add(p, mul(unit(sub(p, q)), reach));
  const pts = touch.map((t) => t.p);
  const ns = normals as Vec3[];
  const line = closed ? pts : [ext(pts[0], pts[1]), ...pts, ext(pts[pts.length - 1], pts[pts.length - 2])];
  const lineN = closed ? ns : [ns[0], ...ns, ns[ns.length - 1]];
  const lower = line.map((p, i) => sub(p, mul(lineN[i], height)));
  const upper = line.map((p, i) => add(p, mul(lineN[i], height)));
  const wires: Wire[] = [];
  const builder = new oc.BRepOffsetAPI_ThruSections(false, true, 1e-6);
  try {
    for (const run of [lower, upper]) {
      // A smooth curve through the points (as the blend's own edge is), or straight pieces for a straight run.
      const straight = run.length === 2 || run.every((q) => len(sub(q, run[0])) < 1e-9 || Math.abs(dot(unit(sub(q, run[0])), unit(sub(run[run.length - 1], run[0])))) > 1 - 1e-10);
      if (straight && !closed) {
        const e = makeLine(run[0], run[run.length - 1]);
        wires.push(assembleWire([e]));
        e.delete();
      } else {
        const e = interpolatedEdge(run, closed);
        wires.push(assembleWire([e]));
        e.delete();
      }
    }
    wires.forEach((w) => builder.AddWire(w.wrapped));
    builder.Build();
    if (!builder.IsDone()) return null;
    return cast(builder.Shape()) as Shape3D;
  } catch {
    return null;
  } finally {
    builder.delete();
    wires.forEach((w) => w.delete());
  }
}

/** Faces and skins sewn together, a little more forgivingly than usual (the blend's edges are fitted through points). */
export function sewnLoosely(shapes: Shape3D[], tolerance = 1e-2): Shape3D {
  const oc = getOC() as any;
  const sewing = new oc.BRepBuilderAPI_Sewing(tolerance, true, true, true, false);
  try {
    for (const s of shapes) sewing.Add(s.wrapped);
    sewing.Perform();
    return cast(sewing.SewedShape()) as Shape3D;
  } finally {
    sewing.delete();
  }
}

/**
 * A surface cut where the blend touches one of its faces, the piece under the blend taken away. Returns the faces
 * left (the caller sews them), or null when the cut couldn't be made.
 */
export function trimUnder(sheet: Shape3D, face: Face, touch: { p: Vec3; under: Vec3 }[], radius: number, closed = false): Face[] | null {
  // Carried on only a little past its ends (enough to cross the face's edge where it ends on one): carried on far, a
  // curved touching line's straight extensions cut across the face where the blend isn't.
  const reach = 2 * radius + 1;
  // Only a little way off the face either side: it crosses the face right where the blend touches it.
  const cutter = cutterAlong(touch, face, reach, closed, Math.min(1, radius * 0.25));
  if (!cutter) return null;
  const oc = getOC() as any;
  const splitter = new oc.BRepAlgoAPI_Splitter();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  let pieces: Face[];
  try {
    args.Append(sheet.wrapped);
    tools.Append(cutter.wrapped);
    splitter.SetArguments(args);
    splitter.SetTools(tools);
    splitter.Build();
    if (splitter.HasErrors()) return null;
    const result = cast(splitter.Shape()) as Shape3D;
    pieces = facesOf(result);
    result.delete();
  } catch {
    return null;
  } finally {
    splitter.delete();
    args.delete();
    tools.delete();
    cutter.delete();
  }
  // The piece under the blend: just past where it touches, on the blend's side, all along.
  const mid = touch[Math.floor(touch.length / 2)];
  const step = Math.min(radius * 0.25, 0.5);
  const probe = add(mid.p, mul(mid.under, step));
  let best = -1;
  let bestD = Infinity;
  pieces.forEach((f, i) => {
    const q = nearestOnFace(f, probe);
    const d = q ? len(sub(q, probe)) : Infinity;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  if (best < 0 || bestD > step * 0.5 || pieces.length < 2) {
    pieces.forEach((f) => f.delete());
    return null;
  }
  pieces[best].delete();
  return pieces.filter((_, i) => i !== best);
}
