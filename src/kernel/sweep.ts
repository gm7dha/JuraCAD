/**
 * Sweep (a profile carried along a path) and loft (a smooth solid joining
 * outlines on different sketches), with OpenCascade.
 */
import { cast, genericSweep, getOC, isShape3D, loft, makeBSplineApproximation, makeFace, measureArea, measureLength, measureVolume, assembleWire, Wire, type Face, type Shape3D } from "replicad";

import { planeFrame, toWorld, type SketchPlane } from "../sketch/planes";
import { findChains, findRegions, type Segment } from "../sketch/regions";
import { chosenRegions, type AreaPick } from "../sketch/areas";
import type { SketchData } from "../sketch/types";
import { loopWire, release, segmentsWire } from "./extrude";
import { hasSharpCorner, loopFrom, profilePlace, smoothRuns, scaleAlong, segmentLength, shareHalves, splitAtPlace, twistStretches, wholeTurns, wholeTurnsMessage, type PathPlace } from "./sweepPath";

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
  /** A twist given as a pitch instead: mm along the path per whole turn (minus = the other way). Wins over `twist`. */
  pitch?: number;
  /** Keep the profile facing the same way all along (it doesn't tilt to follow the path). */
  lockOrientation?: boolean;
  /** Onshape's "Lock profile direction": the profile keeps the same angle to this direction all along (no twist). */
  lockDirection?: Vec3;
  /** Size at the path's end, as a share of the size at the profile (1 = the same all along). */
  scale?: number;
}

/** The twist in degrees, a pitch worked out over the path's `length`. */
export function twistOf(control: SweepControl, length: () => number): number {
  if (control.lockOrientation || control.lockDirection) return 0;
  if (control.pitch !== undefined) {
    if (!(Math.abs(control.pitch) > 1e-9)) throw new Error("The twist's pitch (how far along the path one whole turn takes) must be more than 0.");
    return (360 * length()) / control.pitch;
  }
  return control.twist ?? 0;
}

/** Is it scaled at all? */
const scaledOf = (control: SweepControl) => control.scale !== undefined && Math.abs(control.scale - 1) > 1e-9;

/** A scale must be more than 0, and at most 100 times. */
function checkScale(control: SweepControl) {
  if (control.scale === undefined) return;
  if (!(control.scale > 1e-3) || control.scale > 100) throw new Error("The scale (the size at the end of the path compared with the start) must be more than 0 and at most 100.");
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

/** The size along a pipe: from `f0` at its start to `f1` at its end, in step with the length (null = the same all along). */
type SizeLaw = { f0: number; f1: number } | null;

/** A size change worth a law (else the section is just added). */
const lawOf = (f0: number, f1: number): SizeLaw => (Math.abs(f0 - 1) > 1e-9 || Math.abs(f1 - 1) > 1e-9 ? { f0, f1 } : null);

/**
 * Adds the section to a pipe-shell: plainly, or with a size law (OpenCascade's SetLaw with a Law_Linear: the law's
 * range is spread over the path by length, and the section is scaled about the path).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function addSection(pipe: any, wire: Wire, law: SizeLaw, correction: boolean) {
  const oc = getOC() as any;
  if (!law) {
    pipe.Add(wire.wrapped, false, correction);
    return;
  }
  // OpenCascade keeps the law (in a handle of its own), so it isn't deleted here.
  const l = new oc.Law_Linear();
  l.Set(0, law.f0, 1, law.f1);
  pipe.SetLaw(wire.wrapped, l, false, correction);
}

/** "Lock profile direction": the pipe keeps the profile at the same angle to `dir` (OpenCascade's binormal mode). */
function lockTo(pipe: any, dir: Vec3) {
  const oc = getOC() as any;
  const d = new oc.gp_Dir(...dir);
  try {
    pipe.SetMode(d);
  } finally {
    d.delete();
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * OpenCascade's pipe-shell for one closed outline, with a twist (a guide path
 * wound round the spine), a fixed orientation or a locked direction, and
 * optionally a size law. Returns a closed solid.
 */
function controlledSweep(wire: Wire, spine: Wire, control: SweepControl, guide: Wire | null, startAxis: { p: Vec3; n: Vec3; x: Vec3 } | null, law: SizeLaw = null, corner: "round" | "right" = "round", frenet = false): Shape3D {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const pipe = new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);
  const made: any[] = [];
  try {
    pipe.SetTransitionMode(corner === "round" ? oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner : oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner);
    if (guide) pipe.SetMode(guide.wrapped, false, oc.BRepFill_TypeOfContact.BRepFill_NoContact);
    else if (control.lockOrientation && startAxis) {
      const p = new oc.gp_Pnt(...startAxis.p);
      const n = new oc.gp_Dir(...startAxis.n);
      const x = new oc.gp_Dir(...startAxis.x);
      const ax = new oc.gp_Ax2(p, n, x);
      made.push(p, n, x, ax);
      pipe.SetMode(ax);
    } else if (control.lockDirection) lockTo(pipe, control.lockDirection);
    else if (frenet) pipe.SetMode(true);
    // Locked: the profile stays as drawn (no turning it square to the path).
    addSection(pipe, wire, law, !control.lockOrientation);
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
export interface PathFrame {
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
  /** Its length (mm), for sharing out a change of size. */
  length: number;
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
function pathStretches(segments: Segment[], closed: boolean, frame: ReturnType<typeof planeFrame>, twistDeg: number, reach: number, corners = false): Stretch[] {
  const { runs, cornerAfter } = smoothRuns(segments, closed);
  const out: Stretch[] = [];
  const spines: Wire[] = [];
  try {
    // Kept facing one way: just the smooth runs (the profile doesn't turn, so the corners need nothing). Turning with
    // the path (`corners`), even untwisted, each sharp corner gets its rounded stretch as below.
    if (Math.abs(twistDeg) < 1e-9 && !corners) {
      for (const run of runs) {
        const spine = segmentsWire(run, frame, 0);
        const first = spineStart(spine);
        out.push({ spine, mode: "fixed", guide: null, start: { p: first.p, t: first.t, d: startReference(first.t) }, length: measureLength(spine) });
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
        out.push({ spine, mode: "twist", guide: wound.guide, start, length: lengths[i] });
        r = wound.rEnd;
        angle += share;
      } else {
        out.push({ spine, mode: "round", guide: null, start, length: measureLength(spine) });
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
export function soundSolid(shape: Shape3D): boolean {
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
export function fuseInto(pieces: Shape3D[]): Shape3D {
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
export function placedSection(wire: Wire, from: PathFrame, to: PathFrame): Wire {
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
function pipeStretch(section: Wire, st: Stretch, startAxis: { p: Vec3; n: Vec3; x: Vec3 } | null, law: SizeLaw = null): Shape3D | null {
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
    addSection(pipe, section, law, false);
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

/** A wire scaled by `k` about the point `at`. */
function scaledAbout(wire: Wire, at: Vec3, k: number): Wire {
  if (Math.abs(k - 1) < 1e-12) return wire.clone();
  return wire.clone().scale(k, at);
}

/**
 * One closed outline carried along the stretches in turn. Each stretch starts
 * from the drawn outline itself, moved to where that stretch begins (so no
 * error builds up from stretch to stretch); kept facing one way, it's just
 * moved along. The pieces only touch end to end, and are fused into one solid.
 * `size`: the outline's size at the start and the end (a share of the drawn one), changing in step with the length
 * of the stretches that can carry a change of size — every one but those rounding a corner, which keep the size they
 * start with (OpenCascade can't round a corner while scaling).
 */
function stretchedSweep(wire: Wire, stretches: Stretch[], startAxis: { p: Vec3; n: Vec3; x: Vec3 } | null, size: { f0: number; f1: number } = { f0: 1, f1: 1 }): Shape3D {
  const pieces: Shape3D[] = [];
  const first = stretches[0].start;
  // Twisted: turned square to the path at its start first (as a single twisted sweep does).
  const square = startAxis ? wire.clone() : squareTo(wire, first);
  const scaling = stretches.reduce((t, st) => t + (st.mode === "round" ? 0 : st.length), 0);
  let along = 0;
  try {
    stretches.forEach((st, i) => {
      const to = startAxis ? { ...first, p: st.start.p } : st.start;
      const placed = i === 0 ? square.clone() : placedSection(square, first, to);
      const changes = st.mode !== "round";
      const [f0, f1] = scaleAlong(size.f0, size.f1, scaling, along, changes ? st.length : 0);
      if (changes) along += st.length;
      // A rounded corner keeps its size: the section is scaled to it before it goes round.
      const section = changes ? placed : scaledAbout(placed, to.p, f0);
      if (!changes) placed.delete();
      try {
        const piece = pipeStretch(section, st, startAxis, changes ? lawOf(f0, f1) : null);
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
export function squareTo(wire: Wire, at: PathFrame): Wire {
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
export function liesAlongPath(spine: Wire, n: Vec3, centre: Vec3): boolean {
  const pieces = samplePath(spine, 64);
  let at: PathSample | null = pieces[0]?.[0] ?? null;
  if (spine.isClosed) {
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
  return !!at && Math.abs(dot(at.t, n)) < Math.sin(Math.PI / 180);
}

/**
 * A profile ready to sweep: its closed outlines (holes stay holes), where it lies, and what's needed to place and
 * check it. Made from a sketch's closed shapes (`sketchProfile`) or a flat face of a part (`faceProfile`).
 */
export interface SweepProfile {
  /** Each outline as a fresh wire (the caller frees it), its holes the same, and points round the outline (world mm). */
  loops: { outer: () => Wire; holes: (() => Wire)[]; outline: Vec3[] }[];
  /** Its plane's normal, a point on that plane and a direction in it (the frame "Keep profile orientation" holds). */
  normal: Vec3;
  origin: Vec3;
  x: Vec3;
  /** The middle of its first outline. */
  centre: Vec3;
  /** Where an open path should start from (its nearer end to this). */
  near?: Vec3;
  /** Its area, holes taken out. */
  area: number;
  /** Frees anything it holds. */
  dispose?: () => void;
}

/** A sketch's closed shapes (or just the picked areas) as a sweep's profile. */
export function sketchProfile(plane: SketchPlane, data: SketchData, areas?: AreaPick[]): SweepProfile {
  const { regions, problems } = chosenRegions(data, areas, "sweep");
  if (regions.length === 0) throw new Error(`The profile sketch has no closed shapes.${problems.length ? ` ${problems.join(" ")}` : ""}`);
  const frame = planeFrame(plane);
  const w = (p: [number, number]) => toWorld(frame, p[0], p[1]) as Vec3;
  const outline = regions[0].outer.polygon;
  const mid = outline.reduce((acc, p) => [acc[0] + p[0] / outline.length, acc[1] + p[1] / outline.length], [0, 0]);
  return {
    loops: regions.map((r) => ({ outer: () => loopWire(r.outer, frame, 0), holes: r.holes.map((h) => () => loopWire(h, frame, 0)), outline: r.outer.polygon.map(w) })),
    normal: frame.n as Vec3,
    origin: frame.origin as Vec3,
    x: frame.u as Vec3,
    centre: w(mid as [number, number]),
    near: profileAt(plane, data),
    area: regions.reduce((t, r) => t + loopArea(r.outer.polygon) - r.holes.reduce((h, x) => h + loopArea(x.polygon), 0), 0),
  };
}

/** Points along a wire's edges (world mm). */
function wirePoints(wire: Wire, per = 12): Vec3[] {
  const out: Vec3[] = [];
  for (const e of wire.edges) {
    for (let k = 0; k < per; k++) {
      const v = e.pointAt(k / per);
      out.push([v.x, v.y, v.z]);
      v.delete();
    }
    e.delete();
  }
  return out;
}

/** A flat face of a part (its outline, and any holes in it) as a sweep's profile. The face is left as it was. */
export function faceProfile(face: Face): SweepProfile {
  if (face.geomType !== "PLANE") throw new Error("A sweep's profile face must be flat, and the picked one is curved. Pick a flat face, or draw the shape in a sketch.");
  const outer = face.clone().outerWire();
  const holes = face.clone().innerWires();
  const c = face.center;
  const centre: Vec3 = [c.x, c.y, c.z];
  c.delete();
  const nv = face.normalAt(centre);
  const normal = unit([nv.x, nv.y, nv.z]);
  nv.delete();
  return {
    loops: [{ outer: () => outer.clone(), holes: holes.map((h) => () => h.clone()), outline: wirePoints(outer) }],
    normal,
    origin: centre,
    x: startReference(normal),
    centre,
    near: centre,
    area: measureArea(face),
    dispose: () => release(outer, ...holes),
  };
}

/** Kept facing one way, does the path run along the profile's own plane for a stretch (not just at a point)? */
function edgeOnAlong(spine: Wire, n: Vec3): boolean {
  let total = 0;
  let flat = 0;
  for (const piece of samplePath(spine, 64)) {
    for (let i = 1; i < piece.length; i++) {
      const ds = Math.hypot(...sub(piece[i].p, piece[i - 1].p));
      total += ds;
      if (Math.abs(dot(piece[i].t, n)) < 1e-4 && Math.abs(dot(piece[i - 1].t, n)) < 1e-4) flat += ds;
    }
  }
  return flat > Math.max(1e-3, 1e-4 * total);
}

/** Does the path anywhere run (within 1°) along the direction a "Lock profile direction" holds? */
function runsAlong(spine: Wire, d: Vec3): boolean {
  for (const piece of samplePath(spine, 32)) {
    for (const q of piece) if (Math.hypot(...cross(q.t, d)) < Math.sin(Math.PI / 180)) return true;
  }
  return false;
}

/** What to say when the path runs along the locked direction. */
const ALONG_LOCKED =
  'The path runs along the direction the profile is locked to (somewhere along it), so there\'s no telling which way the profile should face there. Pick a direction that crosses the path everywhere — e.g. square to the plane the path is drawn on — or choose "None" for the profile control.';

/** What to say when a locked direction and a scale can't go round a sketch path's sharp corners together. */
const SCALE_CORNERS_LOCKED =
  'Couldn\'t change the profile\'s size round the path\'s sharp corners with its direction locked. Round the corners with a sketch fillet, set the scale to 1, or choose "None" for the profile control (a scale goes round sharp corners then).';

/** What to say when a scale can't be used on a closed loop. */
const SCALE_LOOP = "A sweep that changes size needs a path with two ends (round a closed loop it would meet itself at a different size). Set the scale to 1, or open the path.";

/** Carry each closed shape of the profile sketch along the path (holes stay holes), optionally twisting or keeping its orientation. */
export function sweepSketch(profilePlane: SketchPlane, profile: SketchData, pathPlane: SketchPlane, path: SketchData, areas?: AreaPick[], control: SweepControl = {}): Shape3D {
  return sweepAlongSketch(sketchProfile(profilePlane, profile, areas), pathPlane, path, control);
}

/** One piece of the path swept on its own (the whole path, or one of the halves either side of a profile part way along). */
interface Half {
  segments: Segment[];
  twist: number;
  /** The size at its far end, a share of the profile's (1 at the profile). */
  scale: number;
  /** Built stretch by stretch. */
  stretches: Stretch[] | null;
  /** Else built in one go: its path, and a twist's guide. */
  spine?: Wire;
  guide?: Wire | null;
}

function releaseHalf(h: Half) {
  if (h.stretches) releaseStretches(h.stretches);
  if (h.spine) release(h.spine);
  if (h.guide) release(h.guide);
}

/** Carry the profile's closed outlines along the path drawn in a sketch (holes stay holes), twisting, scaling or holding it as asked. */
export function sweepAlongSketch(prof: SweepProfile, pathPlane: SketchPlane, path: SketchData, control: SweepControl = {}): Shape3D {
  checkScale(control);
  const chain = pathChain(pathPlane, path, prof.near);
  const pathFrame = planeFrame(pathPlane);
  const whole = () => segmentsWire(chain.segments, pathFrame, 0);
  {
    // A profile lying along the path (the path runs in its plane where they meet) can't be swept: say so first.
    const spine = whole();
    const along = liesAlongPath(spine, prof.normal, prof.centre);
    release(spine);
    if (along) throw new Error(PROFILE_ALONG_PATH);
  }
  const lock = !!control.lockOrientation;
  const dir = lock ? undefined : control.lockDirection;
  const twist = twistOf(control, () => {
    const sp = whole();
    try {
      return measureLength(sp);
    } finally {
      release(sp);
    }
  });
  const scaled = scaledOf(control);
  const scale = scaled ? control.scale! : 1;
  if (scaled && chain.closed) throw new Error(SCALE_LOOP);
  const plain = Math.abs(twist) < 1e-9 && !lock && !dir && !scaled;
  const startAxis = lock ? { p: prof.origin, n: prof.normal, x: prof.x } : null;
  const reachFrom = (segments: Segment[]) => profileReach(prof, toWorld(pathFrame, ...startOf(segments)));
  // Twisted (or changing size) round sharp corners, or twisted / kept facing one way round a closed loop: built stretch by stretch.
  const needsStretches = (segments: Segment[], tw: number) => !dir && hasSharpCorner(segments, false) && (Math.abs(tw) >= 1e-9 || scaled);
  const halves: Half[] = [];
  try {
    if (!plain) checkTwistSize(twist);
    if (!plain && chain.closed) {
      let segments = chain.segments;
      if (Math.abs(twist) >= 1e-9 && !wholeTurns(twist)) throw new Error(wholeTurnsMessage(twist));
      if (lock && !hasSharpCorner(segments, true)) {
        throw new Error(
          "A profile kept facing one way can't go round a smooth closed loop: somewhere the path would run along the profile's own plane, flattening it. Turn off \"Keep profile orientation\", or use a loop with straight sides.",
        );
      }
      if (lock) {
        // A straight side running along the profile's own plane would flatten it there.
        const edgeOn = segments.some((sg) => {
          if (sg.kind !== "line") return false;
          const a = toWorld(pathFrame, ...sg.from);
          const b = toWorld(pathFrame, ...sg.to);
          const t = unit(sub(b, a));
          return Math.abs(dot(t, prof.normal)) < 1e-6;
        });
        if (edgeOn) {
          throw new Error(
            "Couldn't keep the profile facing the same way round that loop: the profile is edge-on to some sides; tilt it so it isn't parallel to any side (or turn off \"Keep profile orientation\").",
          );
        }
      }
      if (!dir) {
        segments = loopFrom(segments, startOnLoop(segments, pathFrame, prof));
        halves.push({ segments, twist, scale: 1, stretches: pathStretches(segments, true, pathFrame, twist, reachFrom(segments), !lock) });
      } else halves.push({ segments, twist, scale: 1, stretches: null });
    } else if (!plain && (scaled || needsStretches(chain.segments, twist)) && !dir) {
      // A profile part way along the path: swept both ways from it, the twist shared by length and the size 1 there.
      const [before, after] = splitAtPlace(chain.segments, startOnLoop(chain.segments, pathFrame, prof));
      const lb = before.reduce((t, sg) => t + segmentLength(sg), 0);
      const la = after.reduce((t, sg) => t + segmentLength(sg), 0);
      const parts: { segments: Segment[]; twist: number; scale: number }[] = [];
      if (lb > 1e-6 * (la + lb) + 1e-6 && after.length) {
        const share = shareHalves(lb, la, twist, scale);
        if (!(share.before.scale > 1e-3)) {
          throw new Error(
            `With the profile part way along the path, a scale of ${Number(scale.toFixed(4))} at the end would shrink it to nothing before it reaches the start. Use a smaller scale, or put the profile at the start of the path.`,
          );
        }
        parts.push({ segments: reversed(before), ...share.before }, { segments: after, ...share.after });
      } else parts.push({ segments: chain.segments, twist, scale });
      for (const h of parts) halves.push({ ...h, stretches: needsStretches(h.segments, h.twist) ? pathStretches(h.segments, false, pathFrame, h.twist, reachFrom(h.segments), !lock) : null });
    } else halves.push({ segments: chain.segments, twist, scale, stretches: null });
    // The rest are made in one go: their paths, and the guides a twist winds round them.
    for (const h of halves) {
      if (h.stretches) continue;
      h.spine = segmentsWire(h.segments, pathFrame, 0);
      if (!plain && Math.abs(h.twist) >= 1e-9) h.guide = twistGuide(h.spine, h.twist);
    }
    // Kept facing one way, a stretch of the path running along the profile's plane flattens it: refused first.
    if (lock) {
      const sp = whole();
      const flat = edgeOnAlong(sp, prof.normal);
      release(sp);
      if (flat) throw new Error(EDGE_ON_LOCKED);
    }
    if (dir) {
      const sp = whole();
      const bad = runsAlong(sp, dir);
      release(sp);
      if (bad) throw new Error(ALONG_LOCKED);
    }
  } catch (e) {
    halves.forEach(releaseHalf);
    throw e;
  }
  const stretched = halves.some((h) => h.stretches);
  const sharp = hasSharpCorner(chain.segments, chain.closed);
  const buildHalf = (h: Half, wire: Wire): Shape3D => {
    if (h.stretches) return stretchedSweep(wire, h.stretches, startAxis, { f0: 1, f1: h.scale });
    const spine = h.spine!;
    if (plain) return genericSweep(wire, spine, { transitionMode: "round", forceProfileSpineOthogonality: false });
    const law = lawOf(1, h.scale);
    try {
      return controlledSweep(wire, spine, control, h.guide ?? null, startAxis, law);
    } catch (e) {
      // OpenCascade can't round a corner while changing size: a mitred corner instead (a locked direction).
      if (!law || !sharp) throw e;
      return controlledSweep(wire, spine, control, h.guide ?? null, startAxis, law, "right");
    }
  };
  const sweepOne = (make: () => Wire): Shape3D => {
    const pieces: Shape3D[] = [];
    try {
      for (const h of halves) {
        const wire = make();
        try {
          pieces.push(buildHalf(h, wire));
        } finally {
          release(wire);
        }
      }
      return pieces.length === 1 ? pieces.pop()! : fuseInto(pieces);
    } catch {
      throw new Error(
        plain
          ? "Couldn't sweep the profile along that path. Check the profile sits at the start of the path and is small enough for its bends."
          : Math.abs(twist) >= 1e-9
            ? stretched && sharp
              ? "Couldn't twist the profile round that path's sharp corners. Try a different twist or a smaller profile, or round the corners with a sketch fillet."
              : "Couldn't twist the profile along that path. Try a smaller twist, a smaller profile, or a smoother path."
            : lock
              ? "Couldn't sweep the profile along that path while keeping it facing the same way. Try without \"Keep profile orientation\", or a gentler path."
              : dir
                ? scaled && sharp
                  ? SCALE_CORNERS_LOCKED
                  : "Couldn't sweep the profile along that path with its direction locked. Try another direction, or \"None\" for the profile control."
                : "Couldn't sweep the profile along that path while changing its size. Try a scale nearer 1, a smaller profile, or round the path's corners with a sketch fillet.",
      );
    } finally {
      release(...pieces);
    }
  };
  try {
    const result = sweepLoops(prof, sweepOne);
    if (lock) {
      // A profile that went edge-on somewhere comes out flattened: refused instead of kept.
      const sp = whole();
      try {
        refuseFlattened(result, prof.area, prof.normal, sp);
      } finally {
        release(sp);
      }
    }
    return result;
  } finally {
    halves.forEach(releaseHalf);
  }
}

/** Every outline of the profile swept by `sweepOne`, its holes cut out, all put together. */
export function sweepLoops(prof: SweepProfile, sweepOne: (make: () => Wire) => Shape3D): Shape3D {
  let result: Shape3D | null = null;
  try {
    for (const loop of prof.loops) {
      let solid = sweepOne(loop.outer);
      for (const hole of loop.holes) {
        let cutter: Shape3D;
        try {
          cutter = sweepOne(hole);
        } catch (e) {
          release(solid);
          throw e;
        }
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
  } catch (e) {
    if (result) release(result);
    throw e;
  }
  return result!;
}

/** The first point of a run of segments. */
const startOf = (segments: Segment[]): [number, number] => {
  const s = segments[0];
  return "from" in s ? s.from : [s.center[0] + ("radius" in s ? s.radius : 0), s.center[1]];
};

/** How far the profile reaches from the path (measured from where the path starts, at the profile). */
function profileReach(prof: SweepProfile, at: Vec3): number {
  let reach = 0;
  for (const loop of prof.loops) {
    for (const w of loop.outline) reach = Math.max(reach, Math.hypot(w[0] - at[0], w[1] - at[1], w[2] - at[2]));
  }
  return reach;
}

/** Where on the path the profile sits: where its plane crosses the path, nearest the middle of its outline. */
function startOnLoop(segments: Segment[], pathFrame: ReturnType<typeof planeFrame>, prof: SweepProfile): PathPlace {
  const centre = prof.centre;
  const n = prof.normal;
  const o = prof.origin;
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
  return sweepProfileAlongSpine(sketchProfile(profilePlane, profile, areas), spine, control, frenet);
}

/** Is the profile part way along the path (the path passes nearer its middle somewhere than at its start)? */
function midSpine(spine: Wire, centre: Vec3): boolean {
  const pieces = samplePath(spine, 32);
  const start = pieces[0]?.[0];
  if (!start) return false;
  const d0 = Math.hypot(...sub(start.p, centre));
  let best = d0;
  let length = 0;
  for (const piece of pieces) {
    for (let i = 1; i < piece.length; i++) {
      length += Math.hypot(...sub(piece[i].p, piece[i - 1].p));
      best = Math.min(best, Math.hypot(...sub(piece[i].p, centre)));
    }
  }
  return d0 - best > 1e-3 * length + 1e-6;
}

/** The profile's closed outlines carried along a ready-made path (`sweepAlongSpine`'s work, for a sketch's shapes or a face). */
export function sweepProfileAlongSpine(prof: SweepProfile, spine: Wire, control: SweepControl = {}, frenet = false): Shape3D {
  checkScale(control);
  if (liesAlongPath(spine, prof.normal, prof.centre)) throw new Error(PROFILE_ALONG_PATH);
  const lock = !!control.lockOrientation;
  const dir = lock ? undefined : control.lockDirection;
  const twist = twistOf(control, () => measureLength(spine));
  const scaled = scaledOf(control);
  const plain = Math.abs(twist) < 1e-9 && !lock && !dir && !scaled;
  let guide: Wire | null = null;
  if (scaled) {
    if (spine.isClosed) throw new Error(SCALE_LOOP);
    if (midSpine(spine, prof.centre)) {
      throw new Error("To change size along a curve or part edges, the profile must sit at one end of the path. Move it there, or draw the path in a sketch (then the profile can sit part way along).");
    }
  }
  if (lock && edgeOnAlong(spine, prof.normal)) throw new Error(EDGE_ON_LOCKED);
  if (dir && runsAlong(spine, dir)) throw new Error(ALONG_LOCKED);
  if (!plain && Math.abs(twist) >= 1e-9) {
    checkTwistSize(twist);
    if (spineHasCorner(spine)) {
      throw new Error(
        "A twist can't go round the sharp corners of a curve or of part edges yet. Draw the path in a sketch instead (a twist goes round a sketch's corners), round the corners, or set the twist to 0.",
      );
    }
    guide = twistGuide(spine, twist);
  }
  const startAxis = lock ? { p: prof.origin, n: prof.normal, x: prof.x } : null;
  const law = lawOf(1, scaled ? control.scale! : 1);
  const sweepOne = (make: () => Wire): Shape3D => {
    const wire = make();
    try {
      if (plain) return genericSweep(wire, spine, { frenet, transitionMode: "round", forceProfileSpineOthogonality: false });
      // Only a scale alone follows a helix's own bending (as a plain sweep does).
      const own = frenet && !guide && !lock && !dir;
      try {
        return controlledSweep(wire, spine, control, guide, startAxis, law, "round", own);
      } catch (e) {
        if (!law) throw e;
        return controlledSweep(wire, spine, control, guide, startAxis, law, "right", own);
      }
    } catch {
      throw new Error(
        scaled
          ? spineHasCorner(spine)
            ? "Couldn't change the profile's size round the sharp corners of that curve or those part edges. Draw the path in a sketch instead (a scale goes round a sketch's sharp corners), or set the scale to 1."
            : "Couldn't sweep the profile along that path while changing its size. Try a scale nearer 1, a smaller profile, or a smoother path."
          : "Couldn't sweep the profile along that path. Check the profile sits at the start of the path and is small enough for its bends.",
      );
    } finally {
      release(wire);
    }
  };
  try {
    const result = sweepLoops(prof, sweepOne);
    // Kept facing one way, a profile that went edge-on somewhere comes out flattened: refused instead of kept.
    if (lock) refuseFlattened(result, prof.area, prof.normal, spine);
    return result;
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

/** A loop's area (shoelace). */
function loopArea(p: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[(i + 1) % p.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

/**
 * How far the path carries a profile lying in the plane with normal `n` out of that plane: ∫|t·n| ds along it. A
 * profile kept facing one way encloses exactly its area times this (where the sweep doesn't run over itself).
 */
export function pathCrossing(spine: Wire, n: Vec3): number {
  let total = 0;
  for (const piece of samplePath(spine, 64)) {
    for (let i = 1; i < piece.length; i++) {
      const ds = Math.hypot(...sub(piece[i].p, piece[i - 1].p));
      total += ds * (Math.abs(dot(piece[i].t, n)) + Math.abs(dot(piece[i - 1].t, n))) / 2;
    }
  }
  return total;
}

/**
 * A sweep kept facing one way that came out far thinner (under 5%) than its profile's real area (holes taken out)
 * times how far the path carries it out of its plane: the profile went edge-on somewhere and OpenCascade made a
 * flattened, broken solid. Refused in plain words (the shape is freed).
 */
function refuseFlattened(shape: Shape3D, area: number, n: Vec3, spine: Wire): void {
  let volume = 0;
  try {
    volume = measureVolume(shape);
  } catch {
    volume = 0;
  }
  const expected = area * pathCrossing(spine, n);
  if (!(volume > 0.05 * expected) || !(volume > 1e-9)) {
    release(shape);
    throw new Error(EDGE_ON_LOCKED);
  }
}
