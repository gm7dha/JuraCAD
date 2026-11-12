/**
 * Sweep (a profile carried along a path) and loft (a smooth solid joining
 * outlines on different sketches), with OpenCascade.
 */
import { cast, genericSweep, getOC, isShape3D, loft, makeBSplineApproximation, makeFace, measureLength, measureVolume, assembleWire, Wire, type Shape3D } from "replicad";

import { planeFrame, toWorld, type SketchPlane } from "../sketch/planes";
import { findChains, findRegions, type Segment } from "../sketch/regions";
import { chosenRegions, type AreaPick } from "../sketch/areas";
import type { SketchData } from "../sketch/types";
import { loopWire, release, segmentsWire } from "./extrude";
import { hasSharpCorner, loopFrom, profilePlace, smoothRuns, twistStretches, wholeTurns, wholeTurnsMessage, type PathPlace } from "./sweepPath";

type Vec3 = [number, number, number];

/** The same run of curves walked the other way. */
function reversed(segments: Segment[]): Segment[] {
  return [...segments].reverse().map((sg): Segment => {
    if (sg.kind === "line") return { kind: "line", from: sg.to, to: sg.from };
    if (sg.kind === "arc") return { kind: "arc", from: sg.to, mid: sg.mid, to: sg.from };
    if (sg.kind === "bezier") return { kind: "bezier", from: sg.to, c1: sg.c2, c2: sg.c1, to: sg.from };
    if (sg.kind === "ellipseArc") return { ...sg, from: sg.to, to: sg.from };
    return sg;
  });
}

const endsOf = (segments: Segment[]): [[number, number], [number, number]] | null => {
  const a = segments[0];
  const b = segments[segments.length - 1];
  if (!("from" in a) || !("to" in b)) return null;
  return [a.from, b.to];
};

/** The path sketch's curves as one run (open or closed), an open one starting from the end nearest `near`. */
function pathChain(plane: SketchPlane, data: SketchData, near?: Vec3): { segments: Segment[]; closed: boolean } {
  const { chains, problems } = findChains(data);
  if (chains.length === 0) {
    throw new Error(problems.length ? `The path must be one connected run of curves, with no branches. ${problems.join(" ")}` : "The path sketch has no lines or curves.");
  }
  if (chains.length > 1 || problems.length) throw new Error("The path must be one connected run of lines and curves, with no branches or separate pieces.");
  const frame = planeFrame(plane);
  let segments = chains[0].segments;
  const ends = endsOf(segments);
  if (near && ends && !chains[0].closed) {
    const d = (p: [number, number]) => {
      const w = toWorld(frame, p[0], p[1]);
      return Math.hypot(w[0] - near[0], w[1] - near[1], w[2] - near[2]);
    };
    if (d(ends[1]) < d(ends[0]) - 1e-9) segments = reversed(segments);
  }
  return { segments, closed: chains[0].closed };
}

/**
 * The path a sweep follows: the sketch's curves (lines, arcs, splines,
 * ellipses, circles) joined end to end into one run, open or closed. An open
 * run starts from the end nearest `near` (where the profile sits), if given.
 */
export function pathWire(plane: SketchPlane, data: SketchData, near?: Vec3): Wire {
  return segmentsWire(pathChain(plane, data, near).segments, planeFrame(plane), 0);
}

/** A point on a sketch's first closed shape (or first run), in 3D: where a sweep's profile sits. */
export function profileAt(plane: SketchPlane, data: SketchData): Vec3 | undefined {
  const { chains } = findChains(data);
  const first = chains[0]?.segments[0];
  if (!first) return undefined;
  const p = "from" in first ? first.from : first.center;
  return toWorld(planeFrame(plane), p[0], p[1]);
}

/** How the profile turns as it travels: a total twist (degrees, about the path), or kept parallel to where it started. */
export interface SweepControl {
  /** Total turn about the path from start to end, in degrees (0 = none). */
  twist?: number;
  /** Keep the profile facing the same way all along (it doesn't tilt to follow the path). */
  lockOrientation?: boolean;
}

/** The biggest twist allowed, either way (10 full turns): more takes too long to build, and soon fails. */
export const MAX_TWIST = 3600;

/** A point and the path's direction there, sampled along the spine (world mm). */
interface PathSample {
  p: Vec3;
  t: Vec3;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const unit = (a: Vec3): Vec3 => scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));

/**
 * Points and directions along the path, a few per mm of turn, split at the
 * joins between its curves (so a sharp corner shows up as a jump in direction).
 */
function samplePath(spine: Wire, perPiece: number): PathSample[][] {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const curve = new oc.BRepAdaptor_CompCurve(spine.wrapped, true);
  try {
    const C1 = oc.GeomAbs_Shape.GeomAbs_C1;
    const n = curve.NbIntervals(C1);
    const knots = new oc.NCollection_Array1_double(1, n + 1);
    curve.Intervals(knots, C1);
    const pieces: PathSample[][] = [];
    for (let i = 1; i <= n; i++) {
      const a = knots.Value(i);
      const b = knots.Value(i + 1);
      const piece: PathSample[] = [];
      for (let k = 0; k <= perPiece; k++) {
        // Just inside the piece at its ends, so the direction is this piece's, not the next one's.
        const u = a + (b - a) * Math.min(Math.max(k / perPiece, 1e-7), 1 - 1e-7);
        const r = curve.EvalD1(u);
        piece.push({ p: [r.Point.X(), r.Point.Y(), r.Point.Z()], t: unit([r.D1.X(), r.D1.Y(), r.D1.Z()]) });
        r.Point.delete();
        r.D1.delete();
      }
      pieces.push(piece);
    }
    knots.delete();
    return pieces;
  } finally {
    curve.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * A second path wound round the first: at each point it sits a little way off
 * the path, in a direction that turns steadily (by `twist` degrees over the
 * whole length) relative to a frame carried along without any twist of its own
 * (a "rotation-minimising" frame). OpenCascade's pipe-shell then turns the
 * profile to keep facing it.
 */
export function twistGuide(spine: Wire, twistDeg: number): Wire {
  checkTwistSize(twistDeg);
  const turns = Math.abs(twistDeg) / 360;
  const pts = smoothSamples(spine, Math.max(24, Math.ceil(96 * turns)));
  return windGuide(pts, startReference(pts[0].t), 0, (twistDeg * Math.PI) / 180).guide;
}

function checkTwistSize(twistDeg: number) {
  if (Math.abs(twistDeg) > MAX_TWIST + 1e-9) {
    throw new Error(`A twist can be at most ${MAX_TWIST}° (${MAX_TWIST / 360} full turns) either way. Use a smaller twist, or split the path into pieces and sweep each.`);
  }
}

/** Samples along a path that must have no sharp corners, joined into one list. */
function smoothSamples(spine: Wire, perPiece: number): PathSample[] {
  const pieces = samplePath(spine, perPiece);
  const pts: PathSample[] = [];
  pieces.forEach((piece, i) => {
    if (i > 0) {
      const prev = pts[pts.length - 1].t;
      if (dot(prev, piece[0].t) < Math.cos((1 * Math.PI) / 180)) {
        throw new Error("Twist needs a smooth path with no sharp corners. Round the corners with a sketch fillet, or set the twist to 0.");
      }
    }
    pts.push(...(i > 0 ? piece.slice(1) : piece));
  });
  return pts;
}

/** A direction square to the path's start, to measure the twist from. */
const startReference = (t0: Vec3): Vec3 => unit(cross(t0, Math.abs(t0[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));

/** Length along sampled points. */
function arcLengths(pts: PathSample[]): { s: number[]; tightest: number } {
  const s = [0];
  let tightest = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const ds = Math.hypot(...sub(pts[i].p, pts[i - 1].p));
    s.push(s[i - 1] + ds);
    const turn = Math.acos(Math.min(1, Math.max(-1, dot(pts[i].t, pts[i - 1].t))));
    if (turn > 1e-9 && ds > 1e-12) tightest = Math.min(tightest, ds / turn);
  }
  return { s, tightest };
}

/** The untwisted reference direction carried one step along the path (double reflection, Wang et al. 2008). */
function carryStep(r: Vec3, from: PathSample, to: PathSample): Vec3 {
  const v1 = sub(to.p, from.p);
  const c1 = dot(v1, v1);
  if (c1 > 1e-18) {
    const rL = sub(r, scale(v1, (2 / c1) * dot(v1, r)));
    const tL = sub(from.t, scale(v1, (2 / c1) * dot(v1, from.t)));
    const v2 = sub(to.t, tL);
    const c2 = dot(v2, v2);
    r = c2 > 1e-18 ? sub(rL, scale(v2, (2 / c2) * dot(v2, rL))) : rL;
  }
  return unit(sub(r, scale(to.t, dot(r, to.t))));
}

/**
 * The guide for one smooth stretch: the reference direction `r` (square to
 * the path at its start) is carried along without twisting, and the guide
 * sits off the path at angle a0…a1 (radians) from it, in step with the length.
 * Returns the guide and the reference direction at the stretch's end.
 */
function windGuide(pts: PathSample[], r0: Vec3, a0: number, a1: number): { guide: Wire; rEnd: Vec3 } {
  // Arc length along the path, and the tightest bend (so the guide stays well inside it).
  const { s, tightest } = arcLengths(pts);
  const length = s[s.length - 1];
  if (!(length > 1e-6)) throw new Error("The path is too short to twist along.");
  const radius = Math.min(length / 4, tightest * 0.2, 5);
  // Carry the frame along by double reflection (Wang et al. 2008).
  let r: Vec3 = r0;
  const guide: Vec3[] = [];
  const total = a1 - a0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) r = carryStep(r, pts[i - 1], pts[i]);
    const a = a0 + total * (s[i] / length);
    const b = cross(pts[i].t, r);
    const d = unit([r[0] * Math.cos(a) + b[0] * Math.sin(a), r[1] * Math.cos(a) + b[1] * Math.sin(a), r[2] * Math.cos(a) + b[2] * Math.sin(a)]);
    guide.push([pts[i].p[0] + d[0] * radius, pts[i].p[1] + d[1] * radius, pts[i].p[2] + d[2] * radius]);
  }
  const edge = makeBSplineApproximation(guide, { tolerance: radius * 1e-4, degMax: 8, degMin: 3 });
  try {
    return { guide: assembleWire([edge]), rEnd: r };
  } finally {
    edge.delete();
  }
}

/**
 * OpenCascade's pipe-shell for one closed outline, with a twist (a guide path
 * wound round the spine) or a fixed orientation. Returns a closed solid.
 */
function controlledSweep(wire: Wire, spine: Wire, control: SweepControl, guide: Wire | null, startAxis: { p: Vec3; n: Vec3; x: Vec3 } | null): Shape3D {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const pipe = new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);
  const made: any[] = [];
  try {
    pipe.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner);
    if (guide) pipe.SetMode(guide.wrapped, false, oc.BRepFill_TypeOfContact.BRepFill_NoContact);
    else if (control.lockOrientation && startAxis) {
      const p = new oc.gp_Pnt(...startAxis.p);
      const n = new oc.gp_Dir(...startAxis.n);
      const x = new oc.gp_Dir(...startAxis.x);
      const ax = new oc.gp_Ax2(p, n, x);
      made.push(p, n, x, ax);
      pipe.SetMode(ax);
    }
    // Locked: the profile stays as drawn (no turning it square to the path).
    pipe.Add(wire.wrapped, false, !control.lockOrientation);
    pipe.Build();
    if (!pipe.IsDone()) throw new Error("not built");
    if (!pipe.MakeSolid()) throw new Error("not closed");
    const shape = cast(pipe.Shape());
    if (!isShape3D(shape)) throw new Error("not a solid");
    // A profile turned edge-on to the path (e.g. kept facing one way round a sharp corner) makes a flat, broken shape.
    const check = new oc.BRepCheck_Analyzer(shape.wrapped, true, false, false);
    const ok = check.IsValid();
    check.delete();
    if (!ok) {
      shape.delete();
      throw new Error("not valid");
    }
    return shape;
  } finally {
    pipe.delete();
    made.forEach((m) => m.delete());
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Where a stretch starts: a point on the path, the path's direction there, and the profile's reference direction square to it. */
interface PathFrame {
  p: Vec3;
  t: Vec3;
  d: Vec3;
}

/** One stretch of a path, swept in turn: twisted (along a guide), carried round a corner untwisted, or kept facing one way. */
interface Stretch {
  spine: Wire;
  mode: "twist" | "round" | "fixed";
  /** Twisted: the guide wound round this stretch. */
  guide: Wire | null;
  /** Where the profile starts this stretch (it's placed there afresh each time, from the drawn profile). */
  start: PathFrame;
}

/** `v` turned by `angle` (radians) about the unit vector `k` (Rodrigues). */
function rotated(v: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * sn + k[0] * kd, v[1] * c + kv[1] * sn + k[1] * kd, v[2] * c + kv[2] * sn + k[2] * kd];
}

/** The reference direction carried (untwisted) along a spine, turning with it round any sharp corner; and the spine's last sample. */
function carryThrough(spine: Wire, r: Vec3): { r: Vec3; end: PathSample } {
  const pieces = samplePath(spine, 24);
  let prev: PathSample | null = null;
  for (const piece of pieces) {
    for (const q of piece) {
      if (prev) {
        const k = cross(prev.t, q.t);
        const sinA = Math.hypot(...k);
        // A sharp corner between pieces: turn with the path, about the corner's axis.
        if (sinA > 1e-9 && Math.hypot(...sub(q.p, prev.p)) < 1e-6) r = unit(rotated(r, unit(k), Math.atan2(sinA, dot(prev.t, q.t))));
        else r = carryStep(r, prev, q);
      }
      prev = q;
    }
  }
  return { r, end: prev! };
}

const angled = (r: Vec3, t: Vec3, a: number): Vec3 => unit(rotated(r, t, a));

/** The very start of a spine: its first point and direction there (exactly, not a sample just inside). */
function spineStart(spine: Wire): { p: Vec3; t: Vec3 } {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const curve = new oc.BRepAdaptor_CompCurve(spine.wrapped, true);
  try {
    const r = curve.EvalD1(curve.FirstParameter());
    const out = { p: [r.Point.X(), r.Point.Y(), r.Point.Z()] as Vec3, t: unit([r.D1.X(), r.D1.Y(), r.D1.Z()]) };
    r.Point.delete();
    r.D1.delete();
    return out;
  } finally {
    curve.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * The path cut into the stretches a twisted (or kept-facing-one-way) sweep is
 * built from (a closed loop started where the profile sits). Twisted: the
 * twist is shared out by length over the stretches between corners, and near
 * each sharp corner (how near depends on how far the profile `reach`es) the
 * profile is carried round untwisted, as a plain sweep rounds a corner. Kept
 * facing one way: just the smooth runs. Each stretch knows where the profile
 * starts it, so every one starts from the drawn profile, placed exactly.
 */
function pathStretches(segments: Segment[], closed: boolean, frame: ReturnType<typeof planeFrame>, twistDeg: number, reach: number): Stretch[] {
  const { runs, cornerAfter } = smoothRuns(segments, closed);
  const out: Stretch[] = [];
  const spines: Wire[] = [];
  try {
    if (Math.abs(twistDeg) < 1e-9) {
      for (const run of runs) {
        const spine = segmentsWire(run, frame, 0);
        const first = spineStart(spine);
        out.push({ spine, mode: "fixed", guide: null, start: { p: first.p, t: first.t, d: startReference(first.t) } });
      }
      return out;
    }
    const plan = twistStretches(runs, cornerAfter, closed, reach);
    for (const st of plan) spines.push(segmentsWire(st.segments, frame, 0));
    const turns = Math.abs(twistDeg) / 360;
    const samples = plan.map((st, i) => (st.twisted ? smoothSamples(spines[i], Math.max(24, Math.ceil(96 * turns))) : null));
    const lengths = samples.map((pts) => (pts ? ((sv) => sv[sv.length - 1])(arcLengths(pts).s) : 0));
    const total = lengths.reduce((x, y) => x + y, 0);
    const twist = (twistDeg * Math.PI) / 180;
    // r: the untwisted reference, carried along; angle: how far the profile has turned from it so far.
    let r: Vec3 | null = null;
    let angle = 0;
    plan.forEach((_, i) => {
      const spine = spines[i];
      const pts = samples[i];
      const first = spineStart(spine);
      r ??= startReference(first.t);
      const start: PathFrame = { p: first.p, t: first.t, d: angled(r, first.t, angle) };
      if (pts) {
        const share = twist * (lengths[i] / total);
        const wound = windGuide(pts, r, angle, angle + share);
        out.push({ spine, mode: "twist", guide: wound.guide, start });
        r = wound.rEnd;
        angle += share;
      } else {
        out.push({ spine, mode: "round", guide: null, start });
        r = carryThrough(spine, r).r;
      }
    });
    return out;
  } catch (e) {
    // Spines made but not yet handed to a stretch go too.
    const kept = new Set(out.map((st) => st.spine));
    release(...spines.filter((sp) => !kept.has(sp)));
    releaseStretches(out);
    throw e;
  }
}

function releaseStretches(stretches: Stretch[]) {
  for (const st of stretches) {
    release(st.spine);
    if (st.guide) release(st.guide);
  }
}

/** Is it one sound solid with something inside? */
function soundSolid(shape: Shape3D): boolean {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const check = new oc.BRepCheck_Analyzer(shape.wrapped, true, false, false);
  const ok = check.IsValid();
  check.delete();
  return ok && measureVolume(shape) > 1e-9;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * How far apart touching ends may be and still be joined. Each stretch starts
 * exactly on the last one's end, so this only matters where a loop comes back
 * round to its start (there the two ends agree to the guide's accuracy).
 */
const JOIN_FUZZ = 1e-5;

/** All the pieces fused into one solid (faces lying on the same surface merged), or an error. */
function fuseInto(pieces: Shape3D[]): Shape3D {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  args.Append(pieces[0].wrapped);
  for (const pc of pieces.slice(1)) tools.Append(pc.wrapped);
  const fuse = new oc.BRepAlgoAPI_Fuse();
  try {
    fuse.SetArguments(args);
    fuse.SetTools(tools);
    fuse.SetFuzzyValue(JOIN_FUZZ);
    fuse.Build();
    if (!fuse.IsDone()) throw new Error("not joined");
    const fused = fuse.Shape();
    const unify = new oc.ShapeUpgrade_UnifySameDomain(fused, true, true, false);
    fused.delete();
    try {
      unify.Build();
      const joined = cast(unify.Shape());
      // One solid, however OpenCascade wraps it.
      const solids = new oc.TopExp_Explorer(joined.wrapped, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      const found: any[] = [];
      for (; solids.More(); solids.Next()) found.push(solids.Current());
      solids.delete();
      if (found.length !== 1) {
        found.forEach((f) => f.delete());
        joined.delete();
        throw new Error("not one solid");
      }
      const solid = cast(oc.TopoDS.Solid(found[0])) as Shape3D;
      found[0].delete();
      joined.delete();
      if (!soundSolid(solid)) {
        solid.delete();
        throw new Error("not valid");
      }
      return solid;
    } finally {
      unify.delete();
    }
  } finally {
    fuse.delete();
    args.delete();
    tools.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** The drawn profile moved rigidly from where it starts the sweep to where it starts another stretch. */
function placedSection(wire: Wire, from: PathFrame, to: PathFrame): Wire {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const made: any[] = [];
  const ax = (f: PathFrame) => {
    const p = new oc.gp_Pnt(...f.p);
    const t = new oc.gp_Dir(...f.t);
    const d = new oc.gp_Dir(...f.d);
    made.push(p, t, d);
    return new oc.gp_Ax3(p, t, d);
  };
  const a = ax(from);
  const b = ax(to);
  const trsf = new oc.gp_Trsf();
  try {
    trsf.SetDisplacement(a, b);
    const move = new oc.BRepBuilderAPI_Transform(wire.wrapped, trsf, true, false);
    try {
      return cast(move.Shape()) as Wire;
    } finally {
      move.delete();
    }
  } finally {
    a.delete();
    b.delete();
    trsf.delete();
    made.forEach((m) => m.delete());
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** One stretch's pipe-shell from `section` (already square to the path, placed where the stretch starts): a sound solid, or null. */
function pipeStretch(section: Wire, st: Stretch, startAxis: { p: Vec3; n: Vec3; x: Vec3 } | null): Shape3D | null {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const pipe = new oc.BRepOffsetAPI_MakePipeShell(st.spine.wrapped);
  const made: any[] = [];
  try {
    if (st.mode === "round") pipe.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner);
    if (st.guide) pipe.SetMode(st.guide.wrapped, false, oc.BRepFill_TypeOfContact.BRepFill_NoContact);
    else if (st.mode === "fixed" && startAxis) {
      const p = new oc.gp_Pnt(...startAxis.p);
      const n = new oc.gp_Dir(...startAxis.n);
      const x = new oc.gp_Dir(...startAxis.x);
      const ax = new oc.gp_Ax2(p, n, x);
      made.push(p, n, x, ax);
      pipe.SetMode(ax);
    }
    pipe.Add(section.wrapped, false, false);
    pipe.Build();
    if (!pipe.IsDone() || !pipe.MakeSolid()) return null;
    const shape = cast(pipe.Shape());
    if (!isShape3D(shape) || !soundSolid(shape)) {
      shape.delete();
      return null;
    }
    return shape;
  } catch {
    return null;
  } finally {
    pipe.delete();
    made.forEach((m) => m.delete());
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * One closed outline carried along the stretches in turn. Each stretch starts
 * from the drawn outline itself, moved to where that stretch begins (so no
 * error builds up from stretch to stretch); kept facing one way, it's just
 * moved along. The pieces only touch end to end, and are fused into one solid.
 */
function stretchedSweep(wire: Wire, stretches: Stretch[], startAxis: { p: Vec3; n: Vec3; x: Vec3 } | null): Shape3D {
  const pieces: Shape3D[] = [];
  const first = stretches[0].start;
  // Twisted: turned square to the path at its start first (as a single twisted sweep does).
  const square = startAxis ? wire.clone() : squareTo(wire, first);
  try {
    stretches.forEach((st, i) => {
      const to = startAxis ? { ...first, p: st.start.p } : st.start;
      const section = i === 0 ? square.clone() : placedSection(square, first, to);
      try {
        const piece = pipeStretch(section, st, startAxis);
        if (!piece) throw new Error(`piece ${i} not made`);
        pieces.push(piece);
      } finally {
        section.delete();
      }
    });
    return pieces.length === 1 ? pieces.pop()! : fuseInto(pieces);
  } finally {
    square.delete();
    release(...pieces);
  }
}

/** The outline turned (the least amount, about the path's start) so it lies square to the path there. */
function squareTo(wire: Wire, at: PathFrame): Wire {
  const face = makeFace(wire);
  const nv = face.normalAt();
  const n: Vec3 = [nv.x, nv.y, nv.z];
  nv.delete();
  face.delete();
  const m = dot(n, at.t) < 0 ? scale(n, -1) : n;
  const k = cross(m, at.t);
  const sinA = Math.hypot(...k);
  if (sinA < 1e-9) return wire.clone();
  return wire.clone().rotate((Math.atan2(sinA, dot(m, at.t)) * 180) / Math.PI, at.p, unit(k));
}

/** What to say when the profile is drawn lying along the path instead of across it. */
export const PROFILE_ALONG_PATH =
  "The profile lies along the path, not across it: where they meet, the path runs in the profile's own plane, so sweeping it would make a flat, broken shape. Draw the profile on a plane across the path (square to it is best).";

/**
 * Does the path, where the profile sits on it, run (within 1°) in the
 * profile's own plane? Then a sweep has nothing to carry: OpenCascade makes a
 * flat or inside-out solid from it. An open path already starts at the end
 * nearest the profile, so that's where it's measured; a closed loop has no
 * start, so it's measured at the place nearest the middle of the profile.
 */
function liesAlongPath(spine: Wire, frame: ReturnType<typeof planeFrame>, outline: [number, number][]): boolean {
  const pieces = samplePath(spine, 64);
  let at: PathSample | null = pieces[0]?.[0] ?? null;
  if (spine.isClosed && outline.length > 0) {
    const mid = outline.reduce((acc, p) => [acc[0] + p[0] / outline.length, acc[1] + p[1] / outline.length], [0, 0]);
    const centre = toWorld(frame, mid[0], mid[1]);
    let bestD = Infinity;
    for (const piece of pieces) {
      for (const q of piece) {
        const d = Math.hypot(...sub(q.p, centre));
        if (d < bestD) {
          bestD = d;
          at = q;
        }
      }
    }
  }
  return !!at && Math.abs(dot(at.t, frame.n as Vec3)) < Math.sin(Math.PI / 180);
}

/** Carry each closed shape of the profile sketch along the path (holes stay holes), optionally twisting or keeping its orientation. */
export function sweepSketch(profilePlane: SketchPlane, profile: SketchData, pathPlane: SketchPlane, path: SketchData, areas?: AreaPick[], control: SweepControl = {}): Shape3D {
  const { regions, problems } = chosenRegions(profile, areas, "sweep");
  if (regions.length === 0) throw new Error(`The profile sketch has no closed shapes.${problems.length ? ` ${problems.join(" ")}` : ""}`);
  const chain = pathChain(pathPlane, path, profileAt(profilePlane, profile));
  const pathFrame = planeFrame(pathPlane);
  const frame = planeFrame(profilePlane);
  {
    // A profile lying along the path (the path runs in its plane where they meet) can't be swept: say so first.
    const spine = segmentsWire(chain.segments, pathFrame, 0);
    const along = liesAlongPath(spine, frame, regions[0].outer.polygon);
    release(spine);
    if (along) throw new Error(PROFILE_ALONG_PATH);
  }
  const twist = control.lockOrientation ? 0 : control.twist ?? 0;
  const plain = Math.abs(twist) < 1e-9 && !control.lockOrientation;
  // Twisted round sharp corners, or twisted / kept facing one way round a closed loop: built stretch by stretch.
  const stretched = !plain && (chain.closed || (Math.abs(twist) >= 1e-9 && hasSharpCorner(chain.segments, false)));
  let stretches: Stretch[] | null = null;
  let spine: Wire | null = null;
  let guide: Wire | null = null;
  if (stretched) {
    checkTwistSize(twist);
    let segments = chain.segments;
    if (chain.closed) {
      if (Math.abs(twist) >= 1e-9 && !wholeTurns(twist)) throw new Error(wholeTurnsMessage(twist));
      if (control.lockOrientation && !hasSharpCorner(segments, true)) {
        throw new Error(
          "A profile kept facing one way can't go round a smooth closed loop: somewhere the path would run along the profile's own plane, flattening it. Turn off \"Keep profile orientation\", or use a loop with straight sides.",
        );
      }
      if (control.lockOrientation) {
        // A straight side running along the profile's own plane would flatten it there.
        const edgeOn = segments.some((sg) => {
          if (sg.kind !== "line") return false;
          const a = toWorld(pathFrame, ...sg.from);
          const b = toWorld(pathFrame, ...sg.to);
          const t = unit(sub(b, a));
          return Math.abs(dot(t, frame.n as Vec3)) < 1e-6;
        });
        if (edgeOn) {
          throw new Error(
            "Couldn't keep the profile facing the same way round that loop: the profile is edge-on to some sides; tilt it so it isn't parallel to any side (or turn off \"Keep profile orientation\").",
          );
        }
      }
      segments = loopFrom(segments, startOnLoop(segments, pathFrame, frame, regions[0].outer.polygon));
    }
    stretches = pathStretches(segments, chain.closed, pathFrame, twist, profileReach(regions, frame, toWorld(pathFrame, ...startOf(segments))));
  } else {
    spine = segmentsWire(chain.segments, pathFrame, 0);
    if (!plain && Math.abs(twist) >= 1e-9) {
      try {
        guide = twistGuide(spine, twist);
      } catch (e) {
        release(spine);
        throw e;
      }
    }
  }
  const startAxis = control.lockOrientation ? { p: frame.origin as Vec3, n: frame.n as Vec3, x: frame.u as Vec3 } : null;
  const sweepOne = (wire: Wire): Shape3D => {
    try {
      if (stretches) return stretchedSweep(wire, stretches, startAxis);
      if (plain) return genericSweep(wire, spine!, { transitionMode: "round", forceProfileSpineOthogonality: false });
      return controlledSweep(wire, spine!, control, guide, startAxis);
    } catch {
      throw new Error(
        plain
          ? "Couldn't sweep the profile along that path. Check the profile sits at the start of the path and is small enough for its bends."
          : Math.abs(twist) >= 1e-9
            ? stretches && hasSharpCorner(chain.segments, chain.closed)
              ? "Couldn't twist the profile round that path's sharp corners. Try a different twist or a smaller profile, or round the corners with a sketch fillet."
              : "Couldn't twist the profile along that path. Try a smaller twist, a smaller profile, or a smoother path."
            : "Couldn't sweep the profile along that path while keeping it facing the same way. Try without \"Keep profile orientation\", or a gentler path.",
      );
    } finally {
      release(wire);
    }
  };
  try {
    let result: Shape3D | null = null;
    for (const region of regions) {
      let solid = sweepOne(loopWire(region.outer, frame, 0));
      for (const hole of region.holes) {
        const cutter = sweepOne(loopWire(hole, frame, 0));
        const next = solid.cut(cutter);
        release(solid, cutter);
        solid = next;
      }
      if (!result) result = solid;
      else {
        const merged: Shape3D = result.fuse(solid);
        release(result, solid);
        result = merged;
      }
    }
    if (control.lockOrientation) {
      // A profile that went edge-on somewhere comes out flattened: refused instead of kept.
      const whole = segmentsWire(chain.segments, pathFrame, 0);
      let length = 0;
      try {
        length = measureLength(whole);
      } finally {
        release(whole);
      }
      refuseFlattened(result!, regions, frame, length);
    }
    return result!;
  } finally {
    if (spine) release(spine);
    if (guide) release(guide);
    if (stretches) releaseStretches(stretches);
  }
}

/** The first point of a run of segments. */
const startOf = (segments: Segment[]): [number, number] => {
  const s = segments[0];
  return "from" in s ? s.from : [s.center[0] + ("radius" in s ? s.radius : 0), s.center[1]];
};

/** How far the profile reaches from the path (measured from where the path starts, at the profile). */
function profileReach(regions: { outer: { polygon: [number, number][] } }[], frame: ReturnType<typeof planeFrame>, at: Vec3): number {
  let reach = 0;
  for (const r of regions) {
    for (const [x, y] of r.outer.polygon) {
      const w = toWorld(frame, x, y);
      reach = Math.max(reach, Math.hypot(w[0] - at[0], w[1] - at[1], w[2] - at[2]));
    }
  }
  return reach;
}

/** Where on a closed path the profile sits: where its plane crosses the loop, nearest the middle of its outline. */
function startOnLoop(segments: Segment[], pathFrame: ReturnType<typeof planeFrame>, profileFrame: ReturnType<typeof planeFrame>, outline: [number, number][]): PathPlace {
  const mid = outline.reduce((acc, p) => [acc[0] + p[0] / outline.length, acc[1] + p[1] / outline.length], [0, 0]);
  const centre = toWorld(profileFrame, mid[0], mid[1]);
  const n = profileFrame.n;
  const o = profileFrame.origin;
  return profilePlace(
    segments,
    (p) => {
      const w = toWorld(pathFrame, p[0], p[1]);
      return (w[0] - o[0]) * n[0] + (w[1] - o[1]) * n[1] + (w[2] - o[2]) * n[2];
    },
    (p) => {
      const w = toWorld(pathFrame, p[0], p[1]);
      return Math.hypot(w[0] - centre[0], w[1] - centre[1], w[2] - centre[2]);
    },
  );
}

/** Which way a lone circle or ellipse starts from its centre (an ellipse at its long axis; a circle along the sketch's X). */
export function loopStart(segments: Segment[], frame: ReturnType<typeof planeFrame>): [number, number, number] | undefined {
  if (segments.length !== 1) return undefined;
  const s = segments[0];
  const a = s.kind === "ellipse" ? s.angle + (s.rx >= s.ry ? 0 : Math.PI / 2) : s.kind === "circle" ? 0 : null;
  if (a === null) return undefined;
  const { u, v } = frame;
  return [u[0] * Math.cos(a) + v[0] * Math.sin(a), u[1] * Math.cos(a) + v[1] * Math.sin(a), u[2] * Math.cos(a) + v[2] * Math.sin(a)];
}

/** A solid passing through one closed shape on each of the sketches, in order: smooth, or `ruled` (straight from each to the next). */
export function loftSketches(sections: { plane: SketchPlane; data: SketchData; name: string }[], opts: { ruled?: boolean } = {}): Shape3D {
  if (sections.length < 2) throw new Error("Pick at least two sketches to loft between.");
  const wires: Wire[] = [];
  try {
    let start: [number, number, number] | undefined;
    for (const s of sections) {
      const { regions } = findRegions(s.data);
      if (regions.length !== 1) throw new Error(`${s.name} needs exactly one closed shape to loft through (it has ${regions.length}).`);
      if (regions[0].holes.length) throw new Error(`${s.name}'s shape has a hole in it — lofts can only join plain outlines for now.`);
      const frame = planeFrame(s.plane);
      // Whole circles and ellipses all start the same way round, so the loft doesn't cut them in two to line them up.
      start ??= loopStart(regions[0].outer.segments, frame);
      wires.push(loopWire(regions[0].outer, frame, 0, start));
    }
    try {
      return loft(wires, { ruled: !!opts.ruled });
    } catch {
      throw new Error("Couldn't loft between those shapes. Try sketches on parallel planes, or outlines with the same number of sides.");
    }
  } finally {
    release(...wires);
  }
}

/**
 * Sweep along a ready-made path (a curve feature, or part edges joined end to end): each closed shape of the profile
 * carried along `spine` (holes stay holes), twisted or kept facing one way as asked. `frenet` follows the path's own
 * bending (best for a helix: the profile keeps its place round the axis); otherwise the profile turns as little as it can.
 */
export function sweepAlongSpine(profilePlane: SketchPlane, profile: SketchData, spine: Wire, areas: AreaPick[] | undefined, control: SweepControl = {}, frenet = false): Shape3D {
  const { regions, problems } = chosenRegions(profile, areas, "sweep");
  if (regions.length === 0) throw new Error(`The profile sketch has no closed shapes.${problems.length ? ` ${problems.join(" ")}` : ""}`);
  const frame = planeFrame(profilePlane);
  if (liesAlongPath(spine, frame, regions[0].outer.polygon)) throw new Error(PROFILE_ALONG_PATH);
  const twist = control.lockOrientation ? 0 : control.twist ?? 0;
  const plain = Math.abs(twist) < 1e-9 && !control.lockOrientation;
  let guide: Wire | null = null;
  if (!plain && Math.abs(twist) >= 1e-9) {
    checkTwistSize(twist);
    if (spineHasCorner(spine)) {
      throw new Error(
        "A twist can't go round the sharp corners of a curve or of part edges yet. Draw the path in a sketch instead (a twist goes round a sketch's corners), round the corners, or set the twist to 0.",
      );
    }
    guide = twistGuide(spine, twist);
  }
  // Kept facing one way, the profile mustn't turn edge-on to the path anywhere (it would flatten there).
  if (control.lockOrientation && edgeOnSomewhere(spine, frame.n as Vec3)) throw new Error(EDGE_ON_LOCKED);
  const startAxis = control.lockOrientation ? { p: frame.origin as Vec3, n: frame.n as Vec3, x: frame.u as Vec3 } : null;
  const sweepOne = (wire: Wire): Shape3D => {
    try {
      if (plain) return genericSweep(wire, spine, { frenet, transitionMode: "round", forceProfileSpineOthogonality: false });
      return controlledSweep(wire, spine, control, guide, startAxis);
    } catch {
      throw new Error("Couldn't sweep the profile along that path. Check the profile sits at the start of the path and is small enough for its bends.");
    } finally {
      release(wire);
    }
  };
  try {
    let result: Shape3D | null = null;
    for (const region of regions) {
      let solid = sweepOne(loopWire(region.outer, frame, 0));
      for (const hole of region.holes) {
        const cutter = sweepOne(loopWire(hole, frame, 0));
        const next = solid.cut(cutter);
        release(solid, cutter);
        solid = next;
      }
      if (!result) result = solid;
      else {
        const merged: Shape3D = result.fuse(solid);
        release(result, solid);
        result = merged;
      }
    }
    if (control.lockOrientation) refuseFlattened(result!, regions, frame, measureLength(spine));
    return result!;
  } finally {
    if (guide) release(guide);
  }
}

/** Kept facing one way, the profile went edge-on to the path somewhere: what to say. */
const EDGE_ON_LOCKED =
  'Kept facing one way, the profile would turn edge-on to the path somewhere along it, flattening the sweep there. Turn off "Keep profile orientation" (then it turns with the path), or use a path that never runs along the profile\'s plane.';

/** Does the path have a sharp corner (a jump in direction between its pieces)? */
function spineHasCorner(spine: Wire): boolean {
  const pieces = samplePath(spine, 4);
  for (let i = 1; i < pieces.length; i++) {
    const a = pieces[i - 1][pieces[i - 1].length - 1].t;
    if (dot(a, pieces[i][0].t) < Math.cos((1 * Math.PI) / 180)) return true;
  }
  if (spine.isClosed && pieces.length > 1) return dot(pieces[pieces.length - 1][pieces[pieces.length - 1].length - 1].t, pieces[0][0].t) < Math.cos((1 * Math.PI) / 180);
  return false;
}

/** Does the path anywhere run (within 2°) along a plane with this normal? */
function edgeOnSomewhere(spine: Wire, n: Vec3): boolean {
  return samplePath(spine, 48).some((piece) => piece.some((q) => Math.abs(dot(q.t, n)) < Math.sin((2 * Math.PI) / 180)));
}

/**
 * A sweep kept facing one way that came out far thinner than its profile carried along the path (under 1%): the
 * profile went edge-on somewhere and OpenCascade made a flattened, broken solid. Refused in plain words (the shape is freed).
 */
function refuseFlattened(shape: Shape3D, regions: { outer: { polygon: [number, number][] } }[], frame: ReturnType<typeof planeFrame>, pathLength: number): void {
  void frame;
  const area = regions.reduce((t, r) => {
    const p = r.outer.polygon;
    let a = 0;
    for (let i = 0; i < p.length; i++) {
      const [x0, y0] = p[i];
      const [x1, y1] = p[(i + 1) % p.length];
      a += x0 * y1 - x1 * y0;
    }
    return t + Math.abs(a) / 2;
  }, 0);
  let volume = 0;
  try {
    volume = measureVolume(shape);
  } catch {
    volume = 0;
  }
  if (area > 0 && pathLength > 0 && volume < 0.01 * area * pathLength) {
    release(shape);
    throw new Error(EDGE_ON_LOCKED);
  }
}
