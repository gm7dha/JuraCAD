/**
 * Geometry from elsewhere, seen square-on to a sketch (projected onto its
 * plane), so any sketch can snap to and use it: other sketches' points, lines,
 * circles and arcs, and parts' corners, edges and circle centres wherever they
 * are. The geometry engine lists these for the sketch being edited, and finds
 * them again on every rebuild so references follow when their source changes.
 *
 * Pure: positions in, sketch millimetres out.
 */
import type { EdgeRef, TopoPick, Vec3 } from "../geometry/topoRef";
import { crossings, curveParam, type CurveParam } from "./curves";
import { projectEdge, type CurveShape, type RefEdge } from "./links";
import { pointPos, radiusOf } from "./ops";
import { planeFrame, toSketch, toWorld, type PlaneFrame, type SketchPlane } from "./planes";
import type { SketchData, SketchItemLink } from "./types";

type P2 = [number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dist2 = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The centre of a round edge, in 3D (null when it isn't one). */
export function circleCentre3(ref: EdgeRef): Vec3 | null {
  if (ref.curve !== "CIRCLE") return null;
  const ab = sub(ref.b, ref.a);
  // A whole circle: its ends are the same point and its middle is straight across.
  if (Math.hypot(...ab) < 1e-6) return scale(add(ref.a, ref.mid), 0.5);
  const p = sub(ref.mid, ref.a);
  const q = sub(ref.b, ref.a);
  const n = cross(p, q);
  const nn = dot(n, n);
  if (nn < 1e-18) return null;
  const t = add(scale(cross(n, p), dot(q, q)), scale(cross(q, n), dot(p, p)));
  return add(ref.a, scale(t, 1 / (2 * nn)));
}

/** Where an end (a, b), the middle or the centre of a part edge is, in 3D. */
export function edgePoint3(ref: EdgeRef, end: "a" | "b" | "centre" | "mid"): Vec3 | null {
  return end === "a" ? ref.a : end === "b" ? ref.b : end === "mid" ? ref.mid : circleCentre3(ref);
}

/**
 * A part edge seen square-on to the sketch, from wherever it is. Edges lying
 * flat to the sketch (in its plane or parallel to it) keep their shape; a
 * straight edge at a slant is still straight (or a single point, seen
 * end-on); other edges, and circles at a slant, become a curve to snap to the
 * ends (and centre) of. `samples`: points along the edge (needed for curves
 * other than straight lines, and to tell whether a circle is flat).
 */
export function seeEdge(frame: PlaneFrame, pick: TopoPick, samples?: Vec3[]): RefEdge | null {
  const ref = pick.ref;
  if (ref.kind !== "edge") return null;
  const flat = projectEdge(frame, pick, samples);
  if (flat) return { ...flat, project: true };
  const a = toSketch(frame, ref.a);
  const b = toSketch(frame, ref.b);
  const mid = toSketch(frame, ref.mid);
  if (ref.curve === "LINE") return dist2(a, b) < 1e-6 ? { pick, project: true, kind: "point", a, b: a, mid: a } : { pick, project: true, kind: "line", a, b, mid };
  const path = samples?.length ? samples.map((p) => toSketch(frame, p)) : [a, mid, b];
  const c3 = circleCentre3(ref);
  return { pick, project: true, kind: "curve", a, b, mid, path, ...(c3 ? { centre: toSketch(frame, c3) } : {}) };
}

/** Another sketch, as a source of references. */
export interface SourceSketch {
  /** Its feature id and name. */
  id: string;
  name?: string;
  plane: SketchPlane;
  data: SketchData;
  /** Further down the feature list than the sketch being edited (shown, but can't be used). */
  later?: boolean;
}

/** Whether two sketch planes face the same way (or exactly opposite ways): circles then stay circles. */
function parallel(a: PlaneFrame, b: PlaneFrame): boolean {
  return Math.abs(dot(a.n, b.n)) > 1 - 1e-9;
}

/** A point of a sketch, seen in another sketch's plane. */
const seePoint = (src: PlaneFrame, frame: PlaneFrame, p: P2): P2 => toSketch(frame, toWorld(src, p[0], p[1]));

/**
 * One line, circle or arc of another sketch, seen square-on to this sketch
 * (`frame`): null when it can't be followed as that kind any more (a line seen
 * end-on, or a circle or arc on a plane at a slant to this one, which would be
 * squashed) or it isn't in that sketch.
 */
export function seeSketchCurve(src: SourceSketch, item: string, frame: PlaneFrame): RefEdge | null {
  const s = src.data;
  const c = s.curves.find((k) => k.id === item);
  if (!c) return null;
  const from = planeFrame(src.plane);
  const source = { sketch: src.id, item, ...(src.name ? { name: src.name } : {}), ...(src.later ? { later: true } : {}) };
  try {
    if (c.type === "line") {
      const a = seePoint(from, frame, pointPos(s, c.p1));
      const b = seePoint(from, frame, pointPos(s, c.p2));
      if (dist2(a, b) < 1e-6) return null;
      return { kind: "line", a, b, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], source: { ...source, ends: { a: c.p1, b: c.p2 } } };
    }
    if ((c.type !== "circle" && c.type !== "arc") || !parallel(from, frame)) return null;
    const centre2 = pointPos(s, c.center);
    const r = radiusOf(s, c);
    const centre = seePoint(from, frame, centre2);
    if (c.type === "circle") {
      const a = seePoint(from, frame, [centre2[0] + r, centre2[1]]);
      const mid = seePoint(from, frame, [centre2[0] - r, centre2[1]]);
      return { kind: "circle", a, b: a, mid, centre, radius: r, source: { ...source, ends: { c: c.center } } };
    }
    const st = pointPos(s, c.start), en = pointPos(s, c.end);
    const a0 = Math.atan2(st[1] - centre2[1], st[0] - centre2[0]);
    let sweep = Math.atan2(en[1] - centre2[1], en[0] - centre2[0]) - a0;
    while (sweep <= 0) sweep += 2 * Math.PI;
    const m2: P2 = [centre2[0] + r * Math.cos(a0 + sweep / 2), centre2[1] + r * Math.sin(a0 + sweep / 2)];
    const a = seePoint(from, frame, st);
    const b = seePoint(from, frame, en);
    // Seen from the other side, anticlockwise turns the other way round.
    const same = dot(from.n, frame.n) > 0;
    return { kind: "arc", a, b, mid: seePoint(from, frame, m2), centre, radius: r, start: same ? a : b, end: same ? b : a, source: { ...source, ends: { a: c.start, b: c.end, c: c.center } } };
  } catch {
    return null;
  }
}

/** Where a point another sketch's point link follows is, seen in this sketch (null when it's gone). */
export function sketchPointAt(src: SourceSketch, link: SketchItemLink & { end?: "mid" }, frame: PlaneFrame): P2 | null {
  const s = src.data;
  const from = planeFrame(src.plane);
  try {
    if (link.end === "mid") {
      const c = s.curves.find((k) => k.id === link.item);
      if (c?.type !== "line") return null;
      const a = pointPos(s, c.p1), b = pointPos(s, c.p2);
      return seePoint(from, frame, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    }
    if (!s.points.some((p) => p.id === link.item)) return null;
    return seePoint(from, frame, pointPos(s, link.item));
  } catch {
    return null;
  }
}

/**
 * Everything of another sketch this sketch can snap to, seen square-on: its
 * lines, circles and arcs (where they keep their shape), and as single points
 * the rest — points placed on their own, curves' points that can't be
 * followed as curves (circles at a slant: their centres; splines: their points).
 */
export function sketchRefs(src: SourceSketch, frame: PlaneFrame): RefEdge[] {
  const out: RefEdge[] = [];
  const from = planeFrame(src.plane);
  const s = src.data;
  const onCurves = new Set<string>();
  const lone = (pointId: string) => {
    if (onCurves.has(pointId)) return;
    onCurves.add(pointId);
    try {
      const a = seePoint(from, frame, pointPos(s, pointId));
      out.push({ kind: "point", a, b: a, mid: a, source: { sketch: src.id, item: pointId, ends: { a: pointId }, ...(src.name ? { name: src.name } : {}), ...(src.later ? { later: true } : {}) } });
    } catch {
      // refers to something that no longer exists
    }
  };
  for (const c of s.curves) {
    const seen = c.type === "line" || c.type === "circle" || c.type === "arc" ? seeSketchCurve(src, c.id, frame) : null;
    if (seen) {
      out.push(seen);
      for (const id of Object.values(seen.source?.ends ?? {})) if (id) onCurves.add(id);
      continue;
    }
    // Can't be seen as itself: offer its points instead.
    const ids = c.type === "line" ? [c.p1] : c.type === "circle" ? [c.center] : c.type === "arc" ? [c.center, c.start, c.end] : c.type === "spline" ? c.points : [c.center];
    ids.forEach(lone);
  }
  for (const p of s.points) if (p.standalone) lone(p.id);
  return out;
}

// ---------------------------------------------------------------------------
// Curved part edges brought in exactly ("Use" on a spline or ellipse)

/**
 * A curved part edge's exact shape, in 3D, from the geometry engine: points
 * along it with its direction and speed there (each piece between two
 * points is a cubic matching both ends: `tangents` are per piece, as a
 * sketch spline's handles are), and for an ellipse also its centre and axes
 * (the ends of its long and short axes from the centre, as vectors) and where
 * it starts and stops (its own angle, radians, increasing along the edge).
 */
export interface CurveShape3 {
  points: Vec3[];
  tangents: Vec3[];
  ellipse?: { centre: Vec3; major: Vec3; minor: Vec3; t0: number; t1: number; whole: boolean };
}

const vecIn = (frame: PlaneFrame, v: Vec3): P2 => [dot(v, frame.u), dot(v, frame.v)];

/**
 * A curved edge's shape seen square-on to the sketch: an ellipse when it is
 * one lying flat to the sketch (in its plane or parallel to it), else a
 * spline through its points (a curve at a slant is seen squashed, which the
 * spline follows just as well).
 */
export function seeShape(frame: PlaneFrame, shape: CurveShape3): CurveShape | null {
  const el = shape.ellipse;
  if (el) {
    const n = cross(el.major, el.minor);
    const nl = Math.hypot(...n);
    const flat = nl > 1e-12 && Math.abs(dot(n, frame.n)) / nl > 1 - 1e-9;
    if (flat) {
      const at = (t: number): Vec3 => add(el.centre, add(scale(el.major, Math.cos(t)), scale(el.minor, Math.sin(t))));
      const centre = toSketch(frame, el.centre);
      const major = toSketch(frame, add(el.centre, el.major));
      const minor = toSketch(frame, add(el.centre, el.minor));
      if (el.whole) return { kind: "ellipse", centre, major, minor };
      // Seen from the side its own angle runs clockwise, its start and end swap (sketch ellipses run anticlockwise).
      const anticlockwise = dot(n, frame.n) > 0;
      const a = toSketch(frame, at(el.t0));
      const b = toSketch(frame, at(el.t1));
      return { kind: "ellipse", centre, major, minor, start: anticlockwise ? a : b, end: anticlockwise ? b : a };
    }
  }
  if (shape.points.length < 2 || shape.points.length !== shape.tangents.length) return null;
  const points = shape.points.map((p) => toSketch(frame, p));
  const tangents = shape.tangents.map((t) => vecIn(frame, t));
  // Seen end-on somewhere (no length on paper): can't be a spline.
  if (points.every((p) => dist2(p, points[0]) < 1e-6)) return null;
  return { kind: "spline", points, tangents };
}

// ---------------------------------------------------------------------------
// Pierce: where a curve from elsewhere passes through the sketch's plane

/** The place in a list nearest to `near` (the first when there's no `near`), or null for an empty list. */
export function nearestPlace(places: P2[], near?: P2): P2 | null {
  if (!places.length) return null;
  if (!near) return places[0];
  let best = places[0];
  for (const p of places) if (dist2(p, near) < dist2(best, near)) best = p;
  return best;
}

/**
 * Where another sketch's curve passes through this sketch's plane (`frame`),
 * in this sketch's coordinates. None when its sketch is parallel to this one
 * (it never passes through), or when it doesn't reach the line where the two
 * planes meet. Every kind of curve is followed exactly (lines, circles, arcs,
 * splines, conics and ellipses).
 */
export function sketchCurvePierces(src: SourceSketch, item: string, frame: PlaneFrame): P2[] {
  const s = src.data;
  const c = s.curves.find((k) => k.id === item);
  if (!c) return [];
  const from = planeFrame(src.plane);
  if (parallel(from, frame)) return [];
  // Height above this sketch's plane is h0 + a·x + b·y in the other sketch: zero along one line there.
  const h0 = dot(sub(from.origin, frame.origin), frame.n);
  const a = dot(from.u, frame.n);
  const b = dot(from.v, frame.n);
  const k = a * a + b * b;
  if (k < 1e-18) return [];
  const q0: P2 = [(-h0 * a) / k, (-h0 * b) / k];
  const dir: P2 = [-b / Math.sqrt(k), a / Math.sqrt(k)];
  let reach = Math.hypot(...q0) + 1;
  for (const p of s.points) reach = Math.max(reach, Math.hypot(p.x - q0[0], p.y - q0[1]) * 2 + 1);
  if (c.type === "circle") reach += 2 * c.radius;
  const meet: CurveParam = { lo: -reach, hi: reach, closed: false, at: (u) => [q0[0] + dir[0] * u, q0[1] + dir[1] * u], d1: () => dir, d2: () => [0, 0], samples: [-reach, reach] };
  try {
    return crossings(curveParam(s, c), meet).map((x) => toSketch(frame, toWorld(from, x.p[0], x.p[1])));
  } catch {
    return [];
  }
}

/**
 * Where a part edge passes through the sketch's plane, from points along it
 * (`at(f)`, f from 0 to 1 along the edge): the stretches where it changes
 * side, homed in on by halving. None when it never crosses, or lies in the
 * plane (all of it on it). `samples` points are tried first; a straight
 * edge needs just its two ends.
 */
export function edgePierces(frame: PlaneFrame, at: (f: number) => Vec3, samples: number): P2[] {
  const h = (f: number) => dot(sub(at(f), frame.origin), frame.n);
  const fs = Array.from({ length: samples + 1 }, (_, i) => i / samples);
  const hs = fs.map(h);
  const tol = 1e-7;
  // Lying in the plane: no single place where it passes through.
  if (hs.every((x) => Math.abs(x) < tol)) return [];
  const out: P2[] = [];
  const push = (f: number) => {
    const p = toSketch(frame, at(f));
    if (!out.some((q) => dist2(p, q) < 1e-6)) out.push(p);
  };
  for (let i = 0; i < fs.length; i++) {
    if (Math.abs(hs[i]) < tol) {
      push(fs[i]);
      continue;
    }
    if (i + 1 < fs.length && Math.abs(hs[i + 1]) >= tol && Math.sign(hs[i]) !== Math.sign(hs[i + 1])) {
      let lo = fs[i], hi = fs[i + 1], hl = hs[i];
      for (let k = 0; k < 60 && hi - lo > 1e-15; k++) {
        const m = (lo + hi) / 2;
        const hm = h(m);
        if (Math.sign(hm) === Math.sign(hl)) {
          lo = m;
          hl = hm;
        } else hi = m;
      }
      push((lo + hi) / 2);
    }
  }
  return out;
}

/**
 * The places another sketch's curves pass through this sketch's plane, as
 * lone points to snap to (Pierce): each follows where its curve passes
 * through. None when the two sketches are parallel.
 */
export function sketchPierceRefs(src: SourceSketch, frame: PlaneFrame): RefEdge[] {
  if (parallel(planeFrame(src.plane), frame)) return [];
  const out: RefEdge[] = [];
  for (const c of src.data.curves) {
    for (const p of sketchCurvePierces(src, c.id, frame))
      out.push({ kind: "point", a: p, b: p, mid: p, pierce: true, source: { sketch: src.id, item: c.id, ...(src.name ? { name: src.name } : {}), ...(src.later ? { later: true } : {}) } });
  }
  return out;
}

/** The places a part edge passes through the sketch's plane, as lone points to snap to (Pierce). */
export function edgePierceRefs(frame: PlaneFrame, pick: TopoPick, at: (f: number) => Vec3): RefEdge[] {
  const ref = pick.ref;
  if (ref.kind !== "edge") return [];
  const h = (p: Vec3) => dot(sub(p, frame.origin), frame.n);
  // A straight edge lying flat to the plane never passes through it (and one in it doesn't count).
  if (ref.curve === "LINE" && Math.abs(h(ref.a) - h(ref.b)) < 1e-7) return [];
  return edgePierces(frame, at, ref.curve === "LINE" ? 1 : 32).map((p): RefEdge => ({ pick, project: true, pierce: true, kind: "point", a: p, b: p, mid: p }));
}
