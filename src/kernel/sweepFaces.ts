/**
 * Onshape's Sweep › Profile control › "Lock profile faces": the profile keeps the same angle to picked faces of a part
 * as it travels along a path of that part's edges (a lip round a box's top edges kept square to its sides, a groove
 * round a curved face). OpenCascade's pipe-shell does this with SetMode(support): each edge of the path must lie on one
 * of the faces (it reads the edge's curve on that face, so the path must be the part's own edges). It can't take a
 * path with sharp corners in one go, so the smooth runs are swept one by one and each corner is rounded as a plain
 * sweep rounds it — every run and corner starting from the drawn profile, placed by the face's normal there.
 */
import { assembleWire, cast, getOC, isShape3D, makeLine, measureLength, type Edge, type Face, type Shape3D, type Wire } from "replicad";
import { release } from "./extrude";
import { fuseInto, liesAlongPath, placedSection, PROFILE_ALONG_PATH, soundSolid, squareTo, sweepLoops, type PathFrame, type SweepProfile } from "./sweep";

type Vec3 = [number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const unit = (a: Vec3): Vec3 => mul(a, 1 / (Math.hypot(...a) || 1));
const dist = (a: Vec3, b: Vec3) => Math.hypot(...sub(a, b));
const vec = (v: { x: number; y: number; z: number; delete?: () => void }): Vec3 => {
  const out: Vec3 = [v.x, v.y, v.z];
  v.delete?.();
  return out;
};

/** What to say when the path isn't made of the locked faces' own edges. */
export const LOCK_FACES_PATH =
  "To lock the profile to faces, the path must be edges of those faces: choose \"Part edges (click them)\" as the path and click the part's edges that run along the faces you locked to.";

/** Sharp corners whose faces turn differently from the path (the profile can't go round in one piece). */
const CORNER_TWIST =
  "At a sharp corner of the path the locked faces turn differently from the path itself, so the profile can't carry on round it in one piece. Round that corner of the part first (a fillet), or lock to fewer faces.";

/** Where the path passes smoothly from one locked face to another that meets it at an angle. */
const FACES_TURN =
  "Where the path passes from one locked face to the next, the faces meet at an angle, so the profile would have to jump there. Round that edge of the part first (a fillet), or lock to fewer faces.";

/** How sharp a turn between two edges counts as a corner (1°). */
const CORNER = Math.cos(Math.PI / 180);

/** One edge of the path, walked one way or the other. */
interface Walked {
  edge: Edge;
  a: Vec3;
  b: Vec3;
  /** The walked direction at its start and end. */
  ta: Vec3;
  tb: Vec3;
  /** Walked the way the edge's own curve runs. */
  forward: boolean;
}

/** The path's edges in order along it, each the way it's walked (from the wire's start). */
function walkedEdges(spine: Wire): Walked[] {
  const left = spine.edges.map((edge) => {
    // An edge's own curve runs from its start to its end whichever way the edge is turned in the wire; `forward`
    // below is about the edge as it's turned, so a reversed edge's ends and directions are swapped here first.
    const a = vec(edge.startPoint);
    const b = vec(edge.endPoint);
    const ta = unit(vec(edge.tangentAt(0)));
    const tb = unit(vec(edge.tangentAt(1)));
    if (edge.orientation === "backward") return { edge, a: b, b: a, ta: mul(tb, -1), tb: mul(ta, -1), forward: true };
    return { edge, a, b, ta, tb, forward: true };
  });
  const out: Walked[] = [];
  let at = vec(spine.startPoint);
  while (left.length) {
    let best = -1;
    let forward = true;
    let bestD = Infinity;
    left.forEach((e, i) => {
      const da = dist(e.a, at);
      const db = dist(e.b, at);
      if (da < bestD) [bestD, best, forward] = [da, i, true];
      if (db < bestD) [bestD, best, forward] = [db, i, false];
    });
    const [e] = left.splice(best, 1);
    const w: Walked = forward ? e : { edge: e.edge, a: e.b, b: e.a, ta: mul(e.tb, -1), tb: mul(e.ta, -1), forward: false };
    out.push(w);
    at = w.b;
  }
  return out;
}

/**
 * The path cut into runs at its sharp corners and wherever it passes onto another locked face (a closed loop started
 * at a corner or a change of face), so each run lies on one face: a flat one's runs keep a fixed direction, a curved
 * one's follow it.
 */
function smoothRunsOf(walked: Walked[], closed: boolean, faceOfEdge: (w: Walked) => Face | null): Walked[][] {
  const breaks = (a: Walked, b: Walked) => dot(a.tb, b.ta) < CORNER || faceOfEdge(a) !== faceOfEdge(b);
  const runs: Walked[][] = [[walked[0]]];
  for (let i = 1; i < walked.length; i++) {
    if (breaks(walked[i - 1], walked[i])) runs.push([walked[i]]);
    else runs[runs.length - 1].push(walked[i]);
  }
  if (closed && runs.length > 1 && !breaks(walked[walked.length - 1], walked[0])) {
    // The loop's start isn't a corner: the last run carries on into the first.
    const last = runs.pop()!;
    runs[0] = [...last, ...runs[0]];
  }
  return runs;
}

/** The locked face an edge lies on, or null. */
function faceOf(edge: Edge, faces: Face[]): Face | null {
  for (const f of faces) {
    const mine = f.edges;
    const has = mine.some((e) => e.isSame(edge));
    mine.forEach((e) => e.delete());
    if (has) return f;
  }
  return null;
}

/** Where the profile stands at `p` on the path going `t`, on `face`: its reference direction is the face's normal there. */
function frameOn(face: Face, p: Vec3, t: Vec3): PathFrame {
  const n = vec(face.normalAt(p));
  const d = sub(n, mul(t, dot(n, t)));
  if (Math.hypot(...d) < 1e-9) throw new Error(LOCK_FACES_PATH);
  return { p, t, d: unit(d) };
}

/** A run's edges as one wire walked from its start (the same edges, so OpenCascade finds them on the faces), each turned to run the walked way. */
function runWire(run: Walked[]): Wire {
  const edges = run.map((r) => {
    if (r.forward) return r.edge.clone();
    return cast((r.edge.wrapped as unknown as { Reversed(): unknown }).Reversed() as never) as Edge;
  });
  return assembleWire(edges);
}

/**
 * A pipe along `spine` (edges of `face`) with the section kept at the same angle to the face (null when OpenCascade
 * can't make it sound). The face alone is the support: given several faces, OpenCascade can read an edge's curve on the
 * wrong one and fail (a fillet's arc between a box's flat sides).
 */
function lockedPipe(section: Wire, spine: Wire, face: Face): Shape3D | null {
  const flat = flatNormal(face);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const pipe = new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);
  const made: any[] = [];
  try {
    if (flat) {
      // A flat face's normal never changes: the same angle to it is OpenCascade's fixed binormal (its curve-on-surface
      // mode can't take the edges of some planes: "EvalDN not implemented").
      const d = new oc.gp_Dir(...flat);
      made.push(d);
      pipe.SetMode(d);
    } else if (!pipe.SetMode(face.wrapped)) throw new Error(LOCK_FACES_PATH);
    pipe.Add(section.wrapped, false, false);
    pipe.Build();
    if (!pipe.IsDone() || !pipe.MakeSolid()) return null;
    const shape = cast(pipe.Shape());
    if (!isShape3D(shape)) {
      shape.delete();
      return null;
    }
    if (!soundSolid(shape)) {
      shape.delete();
      return null;
    }
    return shape;
  } catch (e) {
    if (e instanceof Error && e.message === LOCK_FACES_PATH) throw e;
    return null;
  } finally {
    pipe.delete();
    made.forEach((m) => m.delete());
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** A flat face's normal (null for a curved face). */
function flatNormal(face: Face): Vec3 | null {
  if (face.geomType !== "PLANE") return null;
  return unit(vec(face.normalAt()));
}

/** A corner rounded as a plain sweep rounds it: the section carried along two short legs meeting at the corner. */
function cornerPiece(section: Wire, p: Vec3, t1: Vec3, t2: Vec3, leg: number): Shape3D | null {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const a = add(p, mul(t1, -leg));
  const b = add(p, mul(t2, leg));
  const spine = assembleWire([makeLine(a, p), makeLine(p, b)]);
  const pipe = new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);
  try {
    pipe.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner);
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
    spine.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** `v` turned by `angle` (radians) about the unit vector `k`. */
function rotated(v: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}

/** Where the profile's plane crosses the path, nearest the profile's middle (a closed loop has no start): run index + frame. */
function profilePlace(runs: Wire[], faces: (Face | null)[], prof: SweepProfile): { run: number; p: Vec3; t: Vec3 } {
  let best: { run: number; p: Vec3; t: Vec3; d: number } | null = null;
  const side = (q: Vec3) => dot(sub(q, prof.origin), prof.normal);
  runs.forEach((w, run) => {
    const N = 64;
    let prev = vec(w.pointAt(0));
    let u0 = 0;
    for (let i = 1; i <= N; i++) {
      const u1 = i / N;
      const q = vec(w.pointAt(u1));
      if ((side(prev) <= 0 && side(q) >= 0) || (side(prev) >= 0 && side(q) <= 0)) {
        let lo = u0;
        let hi = u1;
        const sLo = side(prev);
        const sHi = side(q);
        // A crossing right on a sample (the loop's own start, often) is that sample, not the far end of the step.
        if (sLo === 0) hi = lo;
        else if (sHi === 0) lo = hi;
        else
          for (let k = 0; k < 60; k++) {
            const mid = (lo + hi) / 2;
            const s = side(vec(w.pointAt(mid)));
            if ((s < 0) === (sLo < 0)) lo = mid;
            else hi = mid;
          }
        const u = (lo + hi) / 2;
        const p = vec(w.pointAt(u));
        const d = dist(p, prof.centre);
        if (!best || d < best.d) best = { run, p, t: unit(vec(w.tangentAt(u))), d };
      }
      prev = q;
      u0 = u1;
    }
  });
  if (!best || !faces[(best as { run: number }).run]) throw new Error("The profile must sit on the path: draw it across one of the path's edges.");
  const b = best as { run: number; p: Vec3; t: Vec3 };
  return { run: b.run, p: b.p, t: b.t };
}

/**
 * The profile carried along `spine` (made of edges of `faces`), keeping the same angle to the faces all the way.
 * Throws a plain message when it can't.
 */
export function sweepLockedToFaces(prof: SweepProfile, spine: Wire, faces: Face[]): Shape3D {
  if (!faces.length) throw new Error("Click the faces of the part to lock the profile to.");
  if (liesAlongPath(spine, prof.normal, prof.centre)) throw new Error(PROFILE_ALONG_PATH);
  const walked = walkedEdges(spine);
  const closed = spine.isClosed;
  const edgeFaces = new Map(walked.map((w) => [w, faceOf(w.edge, faces)]));
  const runs = smoothRunsOf(walked, closed, (w) => edgeFaces.get(w) ?? null);
  const runFaces = runs.map((run) => edgeFaces.get(run[0]) ?? null);
  const wires = runs.map((run) => runWire(run));
  try {
    if (runFaces.some((f) => !f) || walked.some((w) => !edgeFaces.get(w))) throw new Error(LOCK_FACES_PATH);
    // Where the profile sits, and its frame there (the faces' normal is its reference).
    // An open path: where the profile crosses it (it may sit part way along), else its start, as before.
    const start = { run: 0, p: runs[0][0].a, t: runs[0][0].ta };
    let place = start;
    if (closed) place = profilePlace(wires, runFaces, prof);
    else {
      try {
        place = profilePlace(wires, runFaces, prof);
      } catch {
        place = start;
      }
    }
    const own = frameOn(runFaces[place.run]!, place.p, place.t);
    // The reach of the profile: the corners' legs are a share of it.
    let reach = 0;
    for (const loop of prof.loops) for (const q of loop.outline) reach = Math.max(reach, dist(q, own.p));
    const starts = runs.map((run, i) => frameOn(runFaces[i]!, run[0].a, run[0].ta));
    const ends = runs.map((run) => {
      const last = run[run.length - 1];
      return frameOn(faceOf(last.edge, faces)!, last.b, last.tb);
    });
    // Each corner: the faces must turn as the path does there, or the pieces wouldn't meet.
    const corners: { at: number; p: Vec3; t1: Vec3; t2: Vec3; frame: PathFrame }[] = [];
    for (let i = 0; i < runs.length; i++) {
      const next = i + 1 < runs.length ? i + 1 : closed ? 0 : -1;
      if (next < 0) break;
      const e = ends[i];
      const s = starts[next];
      // A loop that is one smooth run comes back to its start with no corner.
      if (dot(e.t, s.t) >= CORNER) {
        // Onto another face smoothly: the faces must meet smoothly there too, or the pieces wouldn't line up.
        if (dot(e.d, s.d) < Math.cos((2 * Math.PI) / 180)) throw new Error(FACES_TURN);
        continue;
      }
      const k = cross(e.t, s.t);
      const sin = Math.hypot(...k);
      const angle = Math.atan2(sin, dot(e.t, s.t));
      if (sin < 1e-9 || angle > Math.PI - 1e-3) throw new Error(CORNER_TWIST);
      const carried = rotated(e.d, unit(k), angle);
      if (dot(carried, s.d) < Math.cos((2 * Math.PI) / 180)) throw new Error(CORNER_TWIST);
      corners.push({ at: i, p: e.p, t1: e.t, t2: s.t, frame: e });
    }
    const lengths = wires.map((w) => {
      try {
        return measureLength(w);
      } catch {
        return 0;
      }
    });
    const sweepOne = (make: () => Wire): Shape3D => {
      const drawn = make();
      const square = squareTo(drawn, own);
      release(drawn);
      const pieces: Shape3D[] = [];
      try {
        if (runs.length === 1 && !corners.length) {
          const piece = lockedPipe(square, wires[0], runFaces[0]!);
          if (!piece) throw new Error(FAILED);
          return piece;
        }
        runs.forEach((_, i) => {
          const section = placedSection(square, own, starts[i]);
          try {
            const piece = lockedPipe(section, wires[i], runFaces[i]!);
            if (!piece) throw new Error(FAILED);
            pieces.push(piece);
          } finally {
            section.delete();
          }
        });
        for (const c of corners) {
          const neighbours = [lengths[c.at], lengths[(c.at + 1) % runs.length]].filter((x) => x > 0);
          const leg = Math.max(1e-3, Math.min(reach, ...neighbours.map((x) => x / 2)));
          const before: PathFrame = { ...c.frame, p: add(c.p, mul(c.t1, -leg)) };
          const section = placedSection(square, own, before);
          try {
            const piece = cornerPiece(section, c.p, c.t1, c.t2, leg);
            if (!piece) throw new Error(FAILED);
            pieces.push(piece);
          } finally {
            section.delete();
          }
        }
        const joined = fuseInto(pieces);
        return joined;
      } finally {
        square.delete();
        release(...pieces);
      }
    };
    return sweepLoops(prof, sweepOne);
  } finally {
    release(...wires);
    walked.forEach((w) => w.edge.delete());
  }
}

/** When OpenCascade couldn't make it. */
const FAILED = "Couldn't sweep the profile keeping it locked to those faces. Check the profile sits on the path, is small enough for its bends, and the path is edges of the locked faces.";
