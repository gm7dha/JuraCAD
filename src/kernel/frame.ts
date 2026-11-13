/**
 * Frame solids (OpenCascade): each member's profile pushed along its path (a prism along a line, a revolve round an
 * arc, the pieces of a merged run fused), lengthened at its ends where a corner needs it, then cut by the corner's
 * half-spaces, and coped members cut to the member running through. The planning is pure, in model/frame.ts.
 */
import { assembleWire, basicFaceExtrusion, cast, getOC, isShape3D, makeBox, makeBSplineApproximation, makeCircle, makeFace, makeLine, revolution, Vector, type Shape3D, type Wire } from "replicad";
import { curveAcross, dot, segLength, segTangent, type Axes, type CurveSeg, type MemberPlan, type PathSeg, type V3 } from "../model/frame";
import { reversedWire } from "./curves";
import { edgesOf } from "./topology";
import type { ProfileLoop, ProfileShape } from "../model/frameProfiles";

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function signedArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** A loop of the profile placed at `at` with axes x, y (x × y = t); anticlockwise seen from t, or clockwise for a hole. */
function loopWire(l: ProfileLoop, at: V3, x: V3, y: V3, hole: boolean): Wire {
  const to3 = (p: [number, number]): V3 => add(at, add(mul(x, p[0]), mul(y, p[1])));
  const t = cross(x, y);
  if (l.kind === "circle") return assembleWire([makeCircle(l.r, to3(l.c), hole ? mul(t, -1) : t)]);
  let pts = l.pts;
  if (signedArea(pts) > 0 === hole) pts = [...pts].reverse();
  const p3 = pts.map(to3);
  return assembleWire(p3.map((p, i) => makeLine(p, p3[(i + 1) % p3.length])));
}

/** The profile's faces (one per region) at a place on the path. */
function profileFaces(shape: ProfileShape, at: V3, x: V3, y: V3) {
  return shape.regions.map((r) => {
    const outer = loopWire(r.outer, at, x, y, false);
    const holes = r.holes.map((h) => loopWire(h, at, x, y, true));
    try {
      return makeFace(outer, holes);
    } finally {
      outer.delete();
      holes.forEach((h) => h.delete());
    }
  });
}

function fuseAll(pieces: Shape3D[]): Shape3D {
  let out = pieces[0];
  for (const p of pieces.slice(1)) {
    const next = out.fuse(p) as Shape3D;
    out.delete();
    p.delete();
    out = next;
  }
  return out;
}

/** The profile pushed from `from` along `dir` by `length`. */
function prism(shape: ProfileShape, from: V3, dir: V3, { x, y }: Axes, length: number): Shape3D {
  const faces = profileFaces(shape, from, x, y);
  const solids = faces.map((f) => {
    const v = new Vector(mul(dir, length));
    try {
      return basicFaceExtrusion(f, v) as Shape3D;
    } finally {
      v.delete();
      f.delete();
    }
  });
  return fuseAll(solids);
}

/**
 * The real edges of curve segments (part edges, curve features), by segment id, each as a one-edge wire in the
 * edge's own direction (the caller owns them). A segment walked the other way (`reversed`) goes along it backwards.
 */
export type FrameSpines = Map<string, Wire>;

/**
 * A guide a little way off the curve along the planned across direction at every sample: the pipe turns the profile to
 * keep facing it, so it follows the plan's rotation-minimising frames exactly (OpenCascade's own "corrected Frenet"
 * drifts from them on curves that aren't flat, about a degree on a 3D spline). As sweep.ts's twistGuide. Null when it
 * can't be made (the pipe then goes unguided).
 */
function plannedGuide(pts: V3[], tans: V3[], xs: V3[], length: number): Wire | null {
  try {
    let tightest = Infinity;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[i - 1];
      const ds = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      const turn = Math.acos(Math.min(1, Math.max(-1, dot(tans[i], tans[i - 1]))));
      if (turn > 1e-9 && ds > 1e-12) tightest = Math.min(tightest, ds / turn);
    }
    const radius = Math.min(length / 4, tightest * 0.2, 5);
    const edge = makeBSplineApproximation(
      pts.map((p, i) => add(p, mul(xs[i], radius))),
      { tolerance: radius * 1e-4, degMax: 8, degMin: 3 },
    );
    try {
      return assembleWire([edge]);
    } finally {
      edge.delete();
    }
  } catch {
    return null;
  }
}

/**
 * A closed curve's real edge cut in two at the middle of its parameter (where its middle sample is, as the samples
 * are even in it), each piece a wire running the same way as the edge. Null when it can't be done.
 */
function halves(edge: Wire): [Wire, Wire] | null {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const made: any[] = [];
  try {
    const es = edgesOf(edge);
    made.push(...es);
    if (es.length !== 1) return null;
    const ad = new oc.BRepAdaptor_Curve(es[0].wrapped);
    made.push(ad);
    const f = ad.FirstParameter();
    const l = ad.LastParameter();
    const got = oc.BRep_Tool.Curve(es[0].wrapped, 0, 0);
    const curve = got.returnValue;
    made.push(curve);
    const m = (f + l) / 2;
    const piece = (a: number, b: number): Wire => {
      const mk = new oc.BRepBuilderAPI_MakeEdge(curve, a, b);
      made.push(mk);
      const w = new oc.BRepBuilderAPI_MakeWire(mk.Edge());
      made.push(w);
      return cast(w.Wire()) as Wire;
    };
    return [piece(f, m), piece(m, l)];
  } catch {
    return null;
  } finally {
    made.reverse().forEach((x) => x.delete());
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Is a solid sound (OpenCascade's check)? */
function sound(shape: Shape3D): boolean {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const check = new oc.BRepCheck_Analyzer(shape.wrapped, true, false, false);
  try {
    return check.IsValid();
  } finally {
    check.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** One closed loop of the profile pushed along a curve's real edge (OpenCascade's pipe shell), steered by `guide` if given. */
function pipeLoop(loop: Wire, spine: Wire, frenet: boolean, guide: Wire | null, closed = false): Shape3D {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const pipe = new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);
  try {
    // Frenet: the profile keeps its place relative to the curve's bending (a helix); else it follows the planned guide.
    if (guide) pipe.SetMode(guide.wrapped, false, oc.BRepFill_TypeOfContact.BRepFill_NoContact);
    else pipe.SetMode(frenet);
    pipe.Add(loop.wrapped, false, false);
    pipe.Build();
    if (!pipe.IsDone()) throw new Error("not built");
    if (closed) {
      // Round a closed spine the pipe closes on itself: a shell with no ends, made a solid as it is (MakeSolid would
      // add two end caps lying on each other at the seam, which OpenCascade's check rejects).
      const raw = pipe.Shape();
      if (raw.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SHELL) throw new Error("not a shell");
      const fix = new oc.ShapeFix_Solid();
      try {
        const solid = cast(fix.SolidFromShell(oc.TopoDS.Shell(raw)));
        if (!isShape3D(solid)) throw new Error("not a solid");
        return solid;
      } finally {
        fix.delete();
      }
    }
    pipe.MakeSolid();
    const shape = cast(pipe.Shape());
    if (!isShape3D(shape)) throw new Error("not a solid");
    return shape;
  } finally {
    pipe.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** The profile (outlines less holes) swept along a spine, steered by `guide` (or Frenet, or unguided). */
function sweptProfile(shape: ProfileShape, s: CurveSeg, f: Axes, spine: Wire, guide: Wire | null): Shape3D {
  const pieces: Shape3D[] = [];
  try {
    for (const r of shape.regions) {
      const outer = loopWire(r.outer, s.a, f.x, f.y, false);
      let solid: Shape3D;
      try {
        solid = pipeLoop(outer, spine, !!s.normals, guide, !!s.closed);
      } finally {
        outer.delete();
      }
      for (const h of r.holes) {
        const hw = loopWire(h, s.a, f.x, f.y, false);
        let hole: Shape3D;
        try {
          hole = pipeLoop(hw, spine, !!s.normals, guide, !!s.closed);
        } catch (e) {
          solid.delete();
          throw e;
        } finally {
          hw.delete();
        }
        const next = solid.cut(hole) as Shape3D;
        solid.delete();
        hole.delete();
        solid = next;
      }
      pieces.push(solid);
    }
  } catch (e) {
    pieces.forEach((p) => p.delete());
    throw e;
  }
  return fuseAll(pieces);
}

/**
 * The profile swept along a curve segment's real edge, starting with axes `f` at its start: steered by the planned
 * frames, else (no guide could be made, or the result isn't sound) left to OpenCascade; failing that a plain message.
 * A closed curve is swept in two halves (a guide round a closed curve can't be followed), the planned turn round it
 * shared out (`curveAcross`), so the halves meet the same way round at both ends.
 */
function curveSolid(shape: ProfileShape, s: CurveSeg, f: Axes, spines: FrameSpines | undefined): Shape3D {
  const edge = spines?.get(s.id);
  if (!edge) throw new Error("A curved part of the path couldn't be found. Edit the frame and pick it again.");
  const made: Wire[] = [];
  const own = (w: Wire) => (made.push(w), w);
  try {
    const attempts: (() => Shape3D)[] = [];
    if (!s.normals && s.closed) {
      const xs = curveAcross(s, f, true);
      const cut = halves(edge);
      const mid = (s.pts.length - 1) / 2;
      // (Only when the pieces are where the samples say: the middle sample is the middle of the edge's parameter.)
      const at = (w: Wire, end: boolean) => {
        const v = end ? w.endPoint : w.startPoint;
        const p: V3 = [v.x, v.y, v.z];
        v.delete();
        return p;
      };
      const near = (p: V3, q: V3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-4 * Math.max(1, s.length);
      if (cut && !(Number.isInteger(mid) && near(at(cut[0], true), s.pts[mid]) && near(at(cut[1], false), s.pts[mid]))) {
        cut.forEach((w) => w.delete());
      } else if (cut) {
        cut.forEach(own);
        // In the segment's own direction: a segment walked backwards runs the second half (backwards) first.
        const spinesInOrder = s.reversed ? [own(reversedWire(cut[1])), own(reversedWire(cut[0]))] : cut;
        const parts = [
          { from: 0, to: mid, spine: spinesInOrder[0] },
          { from: mid, to: s.pts.length - 1, spine: spinesInOrder[1] },
        ];
        attempts.push(() => {
          const solids: Shape3D[] = [];
          try {
            for (const p of parts) {
              const pts = s.pts.slice(p.from, p.to + 1);
              const tans = s.tans.slice(p.from, p.to + 1);
              const x = xs.slice(p.from, p.to + 1);
              const g = plannedGuide(pts, tans, x, s.length / 2);
              if (!g) throw new Error("no guide");
              own(g);
              const piece: CurveSeg = { ...s, a: pts[0], b: pts[pts.length - 1], pts, tans, closed: undefined };
              solids.push(sweptProfile(shape, piece, { x: x[0], y: cross(tans[0], x[0]) }, p.spine, g));
            }
          } catch (e) {
            solids.forEach((x) => x.delete());
            throw e;
          }
          return fuseAll(solids);
        });
      }
    }
    const spine = s.reversed ? own(reversedWire(edge)) : edge;
    if (!s.normals && !s.closed) {
      const g = plannedGuide(s.pts, s.tans, curveAcross(s, f), s.length);
      if (g) {
        own(g);
        attempts.push(() => sweptProfile(shape, s, f, spine, g));
      }
    }
    attempts.push(() => sweptProfile(shape, s, f, spine, null));
    let kept: Shape3D | null = null;
    for (const attempt of attempts) {
      let solid: Shape3D;
      try {
        solid = attempt();
      } catch {
        continue;
      }
      if (sound(solid)) {
        kept?.delete();
        return solid;
      }
      if (!kept) kept = solid;
      else solid.delete();
    }
    if (kept) return kept;
    throw new Error("The profile couldn't be swept along a curved part of the path. Try a smaller profile, or a smoother curve with gentler bends.");
  } finally {
    made.forEach((w) => w.delete());
  }
}

function segmentSolid(shape: ProfileShape, s: PathSeg, f: Axes, spines?: FrameSpines): Shape3D {
  if (s.kind === "line") return prism(shape, s.a, segTangent(s, false), f, segLength(s));
  if (s.kind === "curve") return curveSolid(shape, s, f, spines);
  const { x, y } = f;
  const faces = profileFaces(shape, s.a, x, y);
  const solids = faces.map((f) => {
    try {
      return revolution(f, s.c, s.axis, (s.angle * 180) / Math.PI);
    } finally {
      f.delete();
    }
  });
  return fuseAll(solids);
}

/** A huge box filling everything where n·(p − o) < 0, round `size` of the origin. */
function behind(n: V3, o: V3, size: number): Shape3D {
  const L = size;
  let box: Shape3D = makeBox([-L, -L, -2 * L], [L, L, 0]);
  const z: V3 = [0, 0, 1];
  const axis = cross(z, n);
  const s = Math.hypot(...axis);
  const angle = (Math.atan2(s, n[2]) * 180) / Math.PI;
  if (s > 1e-9) box = box.rotate(angle, [0, 0, 0], mul(axis, 1 / s));
  else if (n[2] < 0) box = box.rotate(180, [0, 0, 0], [1, 0, 0]);
  return box.translate(o);
}

/** One member's solid, before any cope. */
export function memberSolid(plan: MemberPlan, shape: ProfileShape, spines?: FrameSpines): Shape3D {
  const m = plan.member;
  const [e0, e1] = m.closed ? [0, 0] : [plan.ends[0].extend, plan.ends[1].extend];
  let solid: Shape3D;
  if (plan.straight) {
    const s = m.segs[0];
    const t = segTangent(s, false);
    solid = prism(shape, add(s.a, mul(t, -e0)), t, plan.frames[0], segLength(s) + e0 + e1);
  } else {
    const pieces: Shape3D[] = [];
    const first = m.segs[0];
    const last = m.segs[m.segs.length - 1];
    if (e0 > 0) {
      const t = segTangent(first, false);
      pieces.push(prism(shape, add(first.a, mul(t, -e0)), t, plan.frames[0], e0));
    }
    m.segs.forEach((s, k) => pieces.push(segmentSolid(shape, s, plan.frames[k], spines)));
    if (e1 > 0) {
      const t = segTangent(last, true);
      pieces.push(prism(shape, last.b, t, plan.frames[plan.frames.length - 1], e1));
    }
    solid = fuseAll(pieces);
  }
  const cuts = [...plan.ends[0].cuts, ...plan.ends[1].cuts];
  if (!cuts.length) return solid;
  const reach = plan.pathLength + e0 + e1 + 1000;
  for (const c of cuts) {
    const box = behind(c.n, c.o, reach * 4);
    const next = solid.cut(box) as Shape3D;
    box.delete();
    solid.delete();
    solid = next;
  }
  return solid;
}

/** The solid cut by a plane, keeping where n·(p − o) ≥ 0. */
export function keepSide(solid: Shape3D, n: V3, o: V3, size: number): Shape3D {
  const box = behind(n, o, size);
  try {
    return solid.cut(box) as Shape3D;
  } finally {
    box.delete();
  }
}

export { dot };
