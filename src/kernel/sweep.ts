/**
 * Sweep (a profile carried along a path) and loft (a smooth solid joining
 * outlines on different sketches), with OpenCascade.
 */
import { cast, Face, genericSweep, getOC, isShape3D, loft, makeBSplineApproximation, makeFace, measureVolume, assembleWire, Wire, type Shape3D } from "replicad";

import { planeFrame, toWorld, type SketchPlane } from "../sketch/planes";
import { findChains, findRegions, type Segment } from "../sketch/regions";
import { chosenRegions, type AreaPick } from "../sketch/areas";
import type { SketchData } from "../sketch/types";
import { loopWire, release, segmentsWire } from "./extrude";
import { hasSharpCorner, loopFrom, profilePlace, smoothRuns, wholeTurns, wholeTurnsMessage, type PathPlace } from "./sweepPath";

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
    if (i > 0) {
      const v1 = sub(pts[i].p, pts[i - 1].p);
      const c1 = dot(v1, v1);
      if (c1 > 1e-18) {
        const rL = sub(r, scale(v1, (2 / c1) * dot(v1, r)));
        const tL = sub(pts[i - 1].t, scale(v1, (2 / c1) * dot(v1, pts[i - 1].t)));
        const v2 = sub(pts[i].t, tL);
        const c2 = dot(v2, v2);
        r = c2 > 1e-18 ? sub(rL, scale(v2, (2 / c2) * dot(v2, rL))) : rL;
      }
      r = unit(sub(r, scale(pts[i].t, dot(r, pts[i].t))));
    }
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

/** One smooth stretch of a path cut at its sharp corners, ready to sweep along. */
interface Stretch {
  spine: Wire;
  /** Twisted: the guide wound round this stretch. */
  guide: Wire | null;
  /** The sharp corner after it: the profile is turned round `axis` through `at` by `angle` (radians) to face the next stretch. */
  corner: { at: Vec3; axis: Vec3; angle: number } | null;
}

/** `v` turned by `angle` (radians) about the unit vector `k` (Rodrigues). */
function rotated(v: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * sn + k[0] * kd, v[1] * c + kv[1] * sn + k[1] * kd, v[2] * c + kv[2] * sn + k[2] * kd];
}

/**
 * The path cut into smooth stretches at its sharp corners (a closed loop
 * started where the profile sits), each with its share of the twist: the
 * twist runs on steadily along the length, and stays put going round a corner.
 */
function pathStretches(segments: Segment[], closed: boolean, frame: ReturnType<typeof planeFrame>, twistDeg: number): Stretch[] {
  const { runs, cornerAfter } = smoothRuns(segments, closed);
  const out: Stretch[] = [];
  try {
    const turns = Math.abs(twistDeg) / 360;
    const spines = runs.map((run) => segmentsWire(run, frame, 0));
    out.push(...spines.map((spine): Stretch => ({ spine, guide: null, corner: null })));
    // Samples along each stretch (more for bigger twists, shared out by length below).
    const samples = spines.map((sp) => smoothSamples(sp, Math.max(24, Math.ceil(96 * turns))));
    const lengths = samples.map((pts) => ((s) => s[s.length - 1])(arcLengths(pts).s));
    const total = lengths.reduce((x, y) => x + y, 0);
    const twist = (twistDeg * Math.PI) / 180;
    let r = startReference(samples[0][0].t);
    let along = 0;
    samples.forEach((pts, i) => {
      const next = samples[(i + 1) % samples.length];
      if (cornerAfter[i]) {
        const tA = pts[pts.length - 1].t;
        const tB = next[0].t;
        const k = cross(tA, tB);
        const angle = Math.atan2(Math.hypot(...k), dot(tA, tB));
        if (Math.hypot(...k) < 1e-9) {
          throw new Error("The path turns straight back on itself at a corner, so the profile can't be carried round it. Change the path so no corner doubles back.");
        }
        out[i].corner = { at: pts[pts.length - 1].p, axis: unit(k), angle };
      }
      if (twist === 0) return;
      const a0 = twist * (along / total);
      along += lengths[i];
      const a1 = i === samples.length - 1 ? twist : twist * (along / total);
      const wound = windGuide(pts, r, a0, a1);
      out[i].guide = wound.guide;
      r = out[i].corner ? rotated(wound.rEnd, out[i].corner!.axis, out[i].corner!.angle) : wound.rEnd;
    });
    return out;
  } catch (e) {
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

/** The outline at one end of a sweep or turn (its end face's outer edge, or the wire itself). */
function endWire(shape: unknown): Wire {
  const end = cast(shape as never) as Face | Wire;
  if (end instanceof Wire) return end;
  if (end instanceof Face) {
    const w = end.outerWire();
    end.delete();
    return w;
  }
  throw new Error("no end");
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

/** How far apart touching pieces may be and still be joined: the closing end of a twisted loop meets its start only to the guide's accuracy. */
const JOIN_FUZZ = Number(process.env.FUZZ ?? 1e-4);

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
    const unify = new oc.ShapeUpgrade_UnifySameDomain(fuse.Shape(), true, true, false);
    try {
      unify.Build();
      const joined = cast(unify.Shape());
      // One solid, however OpenCascade wraps it.
      const solids = new oc.TopExp_Explorer(joined.wrapped, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      const found: any[] = [];
      for (; solids.More(); solids.Next()) found.push(solids.Current());
      solids.delete();
      if (found.length !== 1) {
        joined.delete();
        throw new Error("not one solid");
      }
      const solid = cast(oc.TopoDS.Solid(found[0])) as Shape3D;
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

/**
 * The profile turned round a sharp corner (as a plain sweep's round corner):
 * the corner's axis runs through the profile, and a face turned about a line
 * across it would fold through itself, so each side of that line is turned
 * on its own.
 */
function cornerTurn(section: Wire, corner: NonNullable<Stretch["corner"]>): Shape3D[] {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const face = makeFace(section);
  const made: any[] = [];
  const out: Shape3D[] = [];
  try {
    // Cut the face along the axis: by the plane through the axis, square to the face.
    const faceNormal = face.normalAt();
    const n = unit(cross(corner.axis, [faceNormal.x, faceNormal.y, faceNormal.z]));
    faceNormal.delete();
    const at = new oc.gp_Pnt(...corner.at);
    const pln = new oc.gp_Pln(at, new oc.gp_Dir(...n));
    const cutter = new oc.BRepBuilderAPI_MakeFace(pln);
    const args = new oc.NCollection_List_TopoDS_Shape();
    const tools = new oc.NCollection_List_TopoDS_Shape();
    made.push(at, pln, cutter, args, tools);
    args.Append(face.wrapped);
    tools.Append(cutter.Face());
    const split = new oc.BRepAlgoAPI_Splitter();
    made.push(split);
    split.SetArguments(args);
    split.SetTools(tools);
    split.Build();
    if (split.HasErrors()) throw new Error("not split");
    const halves = new oc.TopExp_Explorer(split.Shape(), oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    made.push(halves);
    const axis = new oc.gp_Ax1(new oc.gp_Pnt(...corner.at), new oc.gp_Dir(...corner.axis));
    made.push(axis);
    for (; halves.More(); halves.Next()) {
      const turn = new oc.BRepPrimAPI_MakeRevol(halves.Current(), axis, corner.angle, false);
      try {
        const shape = cast(turn.Shape());
        if (!isShape3D(shape)) throw new Error("not a solid");
        out.push(shape);
      } finally {
        turn.delete();
      }
    }
    if (out.length === 0) throw new Error("nothing turned");
    return out;
  } catch (e) {
    release(...out);
    throw e;
  } finally {
    face.delete();
    made.forEach((m) => m.delete());
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * One closed outline carried along the stretches in turn: each stretch's
 * pipe-shell starts from exactly where the last one (or the turn round the
 * corner before it) ended, and the pieces are fused into one solid.
 */
function stretchedSweep(wire: Wire, stretches: Stretch[], startAxis: { p: Vec3; n: Vec3; x: Vec3 } | null): Shape3D {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const pieces: Shape3D[] = [];
  let section: Wire = wire;
  try {
    stretches.forEach((st, i) => {
      const pipe = new oc.BRepOffsetAPI_MakePipeShell(st.spine.wrapped);
      const made: any[] = [];
      try {
        if (st.guide) pipe.SetMode(st.guide.wrapped, false, oc.BRepFill_TypeOfContact.BRepFill_NoContact);
        else if (startAxis) {
          const p = new oc.gp_Pnt(...startAxis.p);
          const n = new oc.gp_Dir(...startAxis.n);
          const x = new oc.gp_Dir(...startAxis.x);
          const ax = new oc.gp_Ax2(p, n, x);
          made.push(p, n, x, ax);
          pipe.SetMode(ax);
        }
        // The first stretch turns the profile square to the path (as a single twisted sweep does); the rest start exactly where the last ended.
        pipe.Add(section.wrapped, false, i === 0 && !startAxis);
        pipe.Build();
        if (!pipe.IsDone()) throw new Error("not built");
        if (!pipe.MakeSolid()) throw new Error("not closed");
        const shape = cast(pipe.Shape());
        if (!isShape3D(shape)) throw new Error("not a solid");
        pieces.push(shape);
        if (!soundSolid(shape)) throw new Error("not valid");
        const end = endWire(pipe.LastShape());
        if (section !== wire) section.delete();
        section = end;
      } finally {
        pipe.delete();
        made.forEach((m) => m.delete());
      }
      if (st.corner) {
        pieces.push(...cornerTurn(section, st.corner));
        const end = section.clone().rotate((st.corner.angle * 180) / Math.PI, st.corner.at, st.corner.axis);
        section.delete();
        section = end;
      }
    });
    if (process.env.SWEEP_DEBUG) for (const pc of pieces) { const b = pc.boundingBox; console.log("DEBUG piece", measureVolume(pc).toFixed(3), JSON.stringify(b.bounds.map((q) => q.map((x) => +x.toFixed(3))))); }
    return pieces.length === 1 ? pieces.pop()! : fuseInto(pieces);
  } finally {
    if (section !== wire) section.delete();
    release(...pieces);
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Carry each closed shape of the profile sketch along the path (holes stay holes), optionally twisting or keeping its orientation. */
export function sweepSketch(profilePlane: SketchPlane, profile: SketchData, pathPlane: SketchPlane, path: SketchData, areas?: AreaPick[], control: SweepControl = {}): Shape3D {
  const { regions, problems } = chosenRegions(profile, areas, "sweep");
  if (regions.length === 0) throw new Error(`The profile sketch has no closed shapes.${problems.length ? ` ${problems.join(" ")}` : ""}`);
  const chain = pathChain(pathPlane, path, profileAt(profilePlane, profile));
  const pathFrame = planeFrame(pathPlane);
  const frame = planeFrame(profilePlane);
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
      segments = loopFrom(segments, startOnLoop(segments, pathFrame, frame, regions[0].outer.polygon));
    }
    stretches = pathStretches(segments, chain.closed, pathFrame, twist);
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
    } catch (e) {
      if (process.env.SWEEP_DEBUG) console.log("DEBUG sweepOne", e instanceof Error ? e.message : e);
      throw new Error(
        plain
          ? "Couldn't sweep the profile along that path. Check the profile sits at the start of the path and is small enough for its bends."
          : Math.abs(twist) >= 1e-9
            ? "Couldn't twist the profile along that path. Try a smaller twist, a smaller profile, or a smoother path."
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
    return result!;
  } finally {
    if (spine) release(spine);
    if (guide) release(guide);
    if (stretches) releaseStretches(stretches);
  }
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

/** A smooth solid passing through one closed shape on each of the sketches, in order. */
export function loftSketches(sections: { plane: SketchPlane; data: SketchData; name: string }[]): Shape3D {
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
      return loft(wires, { ruled: false });
    } catch {
      throw new Error("Couldn't loft between those shapes. Try sketches on parallel planes, or outlines with the same number of sides.");
    }
  } finally {
    release(...wires);
  }
}
