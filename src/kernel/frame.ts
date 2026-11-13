/**
 * Frame solids (OpenCascade): each member's profile pushed along its path (a prism along a line, a revolve round an
 * arc, the pieces of a merged run fused), lengthened at its ends where a corner needs it, then cut by the corner's
 * half-spaces, and coped members cut to the member running through. The planning is pure, in model/frame.ts.
 */
import { assembleWire, basicFaceExtrusion, cast, getOC, isShape3D, makeBox, makeCircle, makeFace, makeLine, revolution, Vector, type Shape3D, type Wire } from "replicad";
import { dot, segLength, segTangent, type Axes, type CurveSeg, type MemberPlan, type PathSeg, type V3 } from "../model/frame";
import { reversedWire } from "./curves";
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

/** One closed loop of the profile pushed along a curve's real edge (OpenCascade's pipe shell). */
function pipeLoop(loop: Wire, spine: Wire, frenet: boolean): Shape3D {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const pipe = new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);
  try {
    // Frenet: the profile keeps its place relative to the curve's bending (a helix); else it turns as little as it can.
    pipe.SetMode(frenet);
    pipe.Add(loop.wrapped, false, false);
    pipe.Build();
    if (!pipe.IsDone()) throw new Error("not built");
    pipe.MakeSolid();
    const shape = cast(pipe.Shape());
    if (!isShape3D(shape)) throw new Error("not a solid");
    return shape;
  } finally {
    pipe.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** The profile swept along a curve segment's real edge, starting with axes `f` at its start. */
function curveSolid(shape: ProfileShape, s: CurveSeg, f: Axes, spines: FrameSpines | undefined): Shape3D {
  const edge = spines?.get(s.id);
  if (!edge) throw new Error("A curved part of the path couldn't be found. Edit the frame and pick it again.");
  const spine = s.reversed ? reversedWire(edge) : edge;
  try {
    const pieces: Shape3D[] = [];
    for (const r of shape.regions) {
      const outer = loopWire(r.outer, s.a, f.x, f.y, false);
      let solid: Shape3D;
      try {
        solid = pipeLoop(outer, spine, !!s.normals);
      } finally {
        outer.delete();
      }
      for (const h of r.holes) {
        const hw = loopWire(h, s.a, f.x, f.y, false);
        let hole: Shape3D;
        try {
          hole = pipeLoop(hw, spine, !!s.normals);
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
    return fuseAll(pieces);
  } finally {
    if (spine !== edge) spine.delete();
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
