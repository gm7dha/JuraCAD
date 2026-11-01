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
import { crossings, curveParam, ellipseParam, ellipseSpan, type CurveParam } from "./curves";
import { ellipseAt, ellipseFrom } from "./ellipse";
import { projectEdge, type CurveShape, type RefEdge } from "./links";
import { pointPos, radiusOf, splineHandles, splineHandlesIn, splinePoints } from "./ops";
import { splineBeziers } from "./spline";
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
  const c3 = circleCentre3(ref);
  // A circle or arc at a slant is seen as an ellipse (or part of one): its exact shape, so it can be used and dimensioned to.
  const round = ref.curve === "CIRCLE" ? circleOf(ref, samples) : null;
  const shape = round ? seeConic(frame, round) : null;
  if (shape) return { pick, project: true, kind: "curve", a, b, mid, path: shapePath(shape, a), centre: shape.centre, shape };
  const path = samples?.length ? samples.map((p) => toSketch(frame, p)) : [a, mid, b];
  return { pick, project: true, kind: "curve", a, b, mid, path, ...(c3 ? { centre: toSketch(frame, c3) } : {}) };
}

// ---------------------------------------------------------------------------
// Circles and ellipses seen at a slant

/**
 * A circle or ellipse in 3D: centre + major·cos t + minor·sin t, for t from
 * t0 to t1 (radians, rising along it; `whole` when it goes all the way round).
 * `major` and `minor` needn't be its axes: any two halves of diameters that
 * meet square-on as seen along its own normal do (a circle's are any two
 * square radii).
 */
export interface Conic3 {
  centre: Vec3;
  major: Vec3;
  minor: Vec3;
  t0: number;
  t1: number;
  whole: boolean;
}

/**
 * A round part edge (a circle or an arc) as a Conic3, from its ends, middle
 * and points along it (`samples`, by its own parameter from a): its own angle
 * starts at its first end. Null when it can't be told.
 */
export function circleOf(ref: EdgeRef, samples?: Vec3[]): Conic3 | null {
  if (ref.curve !== "CIRCLE" || !samples || samples.length < 3) return null;
  const c = circleCentre3(ref);
  if (!c) return null;
  const x = sub(ref.a, c);
  const r = Math.hypot(...x);
  if (r < 1e-9) return null;
  const xh = scale(x, 1 / r);
  // Square to the start, towards the way the edge runs.
  const w = sub(samples[1], c);
  const yv = sub(w, scale(xh, dot(w, xh)));
  const yl = Math.hypot(...yv);
  if (yl < 1e-9 * r) return null;
  const y = scale(yv, r / yl);
  const whole = Math.hypot(...sub(ref.a, ref.b)) < 1e-6;
  let t1 = 2 * Math.PI;
  if (!whole) {
    const q = sub(ref.b, c);
    t1 = Math.atan2(dot(q, y), dot(q, x));
    if (t1 <= 1e-12) t1 += 2 * Math.PI;
  }
  return { centre: c, major: x, minor: y, t0: 0, t1, whole };
}

/**
 * A circle or ellipse from anywhere, seen square-on to the sketch: an ellipse
 * (its centre and the ends of its long and short axes; with start and end,
 * only that part of it, anticlockwise), or null when it's seen side-on (it
 * looks like a straight line). The long axis' end is always the one to the
 * right (or, upright, the top one), so it's found in the same place on every rebuild.
 */
export function seeConic(frame: PlaneFrame, el: Conic3): Extract<CurveShape, { kind: "ellipse" }> | null {
  const c = toSketch(frame, el.centre);
  const p = vecIn(frame, el.major);
  const q = vecIn(frame, el.minor);
  const size = Math.max(Math.hypot(...p), Math.hypot(...q));
  const turn = p[0] * q[1] - p[1] * q[0];
  if (!(size > 1e-9) || Math.abs(turn) < 1e-6 * size * size) return null;
  // Its axes, from the two halves of diameters (where its distance from the centre is greatest and least).
  const tm = 0.5 * Math.atan2(2 * (p[0] * q[0] + p[1] * q[1]), p[0] * p[0] + p[1] * p[1] - q[0] * q[0] - q[1] * q[1]);
  let A: P2 = [p[0] * Math.cos(tm) + q[0] * Math.sin(tm), p[1] * Math.cos(tm) + q[1] * Math.sin(tm)];
  const B: P2 = [-p[0] * Math.sin(tm) + q[0] * Math.cos(tm), -p[1] * Math.sin(tm) + q[1] * Math.cos(tm)];
  let rx = Math.hypot(...A);
  let ry = Math.hypot(...B);
  if (ry > rx) {
    // (Only by rounding, near a circle.)
    A = B;
    [rx, ry] = [ry, rx];
  }
  if (ry < 1e-6) return null;
  if (A[0] < -1e-9 * rx || (Math.abs(A[0]) <= 1e-9 * rx && A[1] < 0)) A = [-A[0], -A[1]];
  const major: P2 = [c[0] + A[0], c[1] + A[1]];
  const minor: P2 = [c[0] - (A[1] * ry) / rx, c[1] + (A[0] * ry) / rx];
  if (el.whole) return { kind: "ellipse", centre: c, major, minor };
  const at = (t: number): P2 => [c[0] + p[0] * Math.cos(t) + q[0] * Math.sin(t), c[1] + p[1] * Math.cos(t) + q[1] * Math.sin(t)];
  const a = at(el.t0), b = at(el.t1);
  // Seen from the side its own angle runs clockwise, its start and end swap (sketch ellipses run anticlockwise).
  return turn > 0 ? { kind: "ellipse", centre: c, major, minor, start: a, end: b } : { kind: "ellipse", centre: c, major, minor, start: b, end: a };
}

/**
 * A curved edge's exact shape seen in the sketch, whatever way it lies: as
 * seeShape, and a circle or ellipse at a slant (when its circle or ellipse is
 * known) as the ellipse it's seen as.
 */
export function seeShapeAll(frame: PlaneFrame, shape: CurveShape3 & { circle?: Conic3 }): CurveShape | null {
  const el = shape.ellipse ?? shape.circle;
  if (el) {
    const flat = shape.ellipse ? seeShape(frame, shape) : null;
    if (flat?.kind === "ellipse") return flat;
    const seen = seeConic(frame, el);
    if (seen) return seen;
  }
  return seeShape(frame, shape);
}

/** Most points a reference's drawn path gets (a long spline is drawn with fewer per piece). */
const MAX_PATH = 256;

/**
 * Points along a curve's exact shape, to draw it and find it under the pointer:
 * an ellipse from its start round to its end (a whole one from `from`, so the
 * path's ends are its first end), a spline along each piece. Begins at `from`
 * when that's its other end.
 */
export function shapePath(sh: CurveShape, from?: P2): P2[] {
  let out: P2[];
  if (sh.kind === "ellipse") {
    const g = ellipseFrom(sh.centre, sh.major, sh.minor);
    let t0 = 0, t1 = 2 * Math.PI;
    if (sh.start && sh.end) {
      t0 = ellipseParam(g, sh.start);
      t1 = ellipseParam(g, sh.end);
      while (t1 <= t0 + 1e-12) t1 += 2 * Math.PI;
    } else if (from) {
      t0 = ellipseParam(g, from);
      t1 = t0 + 2 * Math.PI;
    }
    const n = Math.max(8, Math.ceil((64 * (t1 - t0)) / (2 * Math.PI)));
    out = Array.from({ length: n + 1 }, (_, i) => ellipseAt(g, t0 + ((t1 - t0) * i) / n));
    if (sh.start && sh.end) {
      out[0] = sh.start;
      out[n] = sh.end;
    } else if (from) out[0] = out[n] = from;
  } else {
    const m = sh.points.length - 1;
    const per = Math.max(1, Math.min(8, Math.floor(MAX_PATH / Math.max(1, m))));
    out = [sh.points[0]];
    for (let i = 0; i < m; i++) {
      const [p0, p1, t0, t1] = [sh.points[i], sh.points[i + 1], sh.tangents[i], sh.tangents[i + 1]];
      for (let k = 1; k <= per; k++) {
        const t = k / per;
        const h00 = 2 * t ** 3 - 3 * t ** 2 + 1, h10 = t ** 3 - 2 * t ** 2 + t, h01 = -2 * t ** 3 + 3 * t ** 2, h11 = t ** 3 - t ** 2;
        out.push(k === per ? p1 : [h00 * p0[0] + h10 * t0[0] + h01 * p1[0] + h11 * t1[0], h00 * p0[1] + h10 * t0[1] + h01 * p1[1] + h11 * t1[1]]);
      }
    }
  }
  if (from && !(sh.kind === "ellipse" && !sh.start) && dist2(out[out.length - 1], from) < dist2(out[0], from)) out.reverse();
  return out;
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
    if (c.type === "spline" || c.type === "ellipse" || !parallel(from, frame)) return seeSketchShape(src, item, frame);
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

/**
 * Another sketch's circle or arc on a plane at a slant to this one, or its
 * spline (or conic) or ellipse, seen square-on to this sketch with its exact
 * shape (`RefEdge.shape`), so it can be snapped to at its ends and centre,
 * dimensioned to, and used: circles and ellipses are seen as ellipses (or
 * parts of them), splines as splines. Null when seen side-on.
 */
export function seeSketchShape(src: SourceSketch, item: string, frame: PlaneFrame): RefEdge | null {
  const s = src.data;
  const c = s.curves.find((k) => k.id === item);
  if (!c || c.type === "line") return null;
  const from = planeFrame(src.plane);
  const world = (v: P2): Vec3 => add(scale(from.u, v[0]), scale(from.v, v[1]));
  const source = { sketch: src.id, item, ...(src.name ? { name: src.name } : {}), ...(src.later ? { later: true } : {}) };
  try {
    if (c.type === "spline") {
      const shape = splineShapeOf(s, c, (p) => seePoint(from, frame, p), (v) => vecIn(frame, world(v)));
      if (!shape) return null;
      const first = shape.points[0];
      const path = shapePath(shape, first);
      const ends = c.closed ? {} : { a: c.points[0], b: c.points[c.points.length - 1] };
      return { kind: "curve", a: path[0], b: path[path.length - 1], mid: path[Math.floor(path.length / 2)], path, shape, source: { ...source, ends } };
    }
    let el: Conic3;
    let start: string | undefined;
    if (c.type === "ellipse") {
      const { g, t0, t1, whole } = ellipseSpan(s, c);
      const [ca, sa] = [Math.cos(g.angle), Math.sin(g.angle)];
      el = { centre: toWorld(from, g.centre[0], g.centre[1]), major: world([g.rx * ca, g.rx * sa]), minor: world([-g.ry * sa, g.ry * ca]), t0, t1, whole };
      start = whole ? undefined : c.start;
    } else {
      const centre2 = pointPos(s, c.center);
      const r = radiusOf(s, c);
      let t0 = 0, t1 = 2 * Math.PI;
      if (c.type === "arc") {
        const st = pointPos(s, c.start), en = pointPos(s, c.end);
        t0 = Math.atan2(st[1] - centre2[1], st[0] - centre2[0]);
        t1 = Math.atan2(en[1] - centre2[1], en[0] - centre2[0]);
        while (t1 <= t0) t1 += 2 * Math.PI;
        start = c.start;
      }
      el = { centre: toWorld(from, centre2[0], centre2[1]), major: world([r, 0]), minor: world([0, r]), t0, t1, whole: c.type === "circle" };
    }
    const shape = seeConic(frame, el);
    if (!shape) return null;
    const a = start ? seePoint(from, frame, pointPos(s, start)) : undefined;
    const path = shapePath(shape, a);
    const end = c.type === "arc" ? c.end : c.type === "ellipse" ? c.end : undefined;
    const ends = start && end ? { a: start, b: end, c: c.center } : { c: c.center };
    return { kind: "curve", a: path[0], b: path[path.length - 1], mid: path[Math.floor(path.length / 2)], path, centre: shape.centre, shape, source: { ...source, ends } };
  } catch {
    return null;
  }
}

/**
 * A sketch spline's (or conic's) exact shape, its own cubic pieces, seen
 * through `pt`/`vec` (where its points and directions are seen): its points,
 * the direction and speed it leaves each at, and where it arrives at a point
 * differently (as Split leaves it), that too. Null when seen side-on.
 */
export function splineShapeOf(s: SketchData, c: Extract<SketchData["curves"][number], { type: "spline" }>, pt: (p: P2) => P2, vec: (v: P2) => P2): Extract<CurveShape, { kind: "spline" }> | null {
  const bz = splineBeziers(splinePoints(s, c), c.closed, c.conic, splineHandles(c), splineHandlesIn(c));
  if (!bz.length) return null;
  const tan = (a: P2, b: P2): P2 => [3 * (b[0] - a[0]), 3 * (b[1] - a[1])];
  const m = bz.length;
  const points: P2[] = [...bz.map((b) => b[0]), c.closed ? bz[0][0] : bz[m - 1][3]];
  const leaving: P2[] = bz.map((b) => tan(b[0], b[1]));
  const arriving: (P2 | null)[] = [c.closed ? tan(bz[m - 1][2], bz[m - 1][3]) : null, ...bz.map((b) => tan(b[2], b[3]))];
  const tangents: P2[] = [...leaving, c.closed ? leaving[0] : arriving[m]!];
  const size = 1 + Math.max(...points.map((p) => Math.abs(p[0]) + Math.abs(p[1])));
  const differs = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-12 * size;
  let kinked = false;
  const tangentsIn: (P2 | null)[] = points.map((_, i) => {
    const a = i === m && c.closed ? arriving[0] : arriving[i];
    if (!a || !differs(a, tangents[i])) return null;
    kinked = true;
    return vec(a);
  });
  const seen = points.map(pt);
  if (c.closed) seen[m] = seen[0];
  const shape: Extract<CurveShape, { kind: "spline" }> = { kind: "spline", points: seen, tangents: tangents.map(vec), ...(kinked ? { tangentsIn } : {}) };
  // Side-on (all of it along one straight line, on paper): nothing to copy.
  const far = seen.reduce((best, p) => (dist2(p, seen[0]) > dist2(best, seen[0]) ? p : best), seen[0]);
  const reach = dist2(far, seen[0]);
  if (reach < 1e-6) return null;
  const across = (v: P2) => Math.abs((far[0] - seen[0][0]) * v[1] - (far[1] - seen[0][1]) * v[0]) / reach;
  if (seen.every((p) => across([p[0] - seen[0][0], p[1] - seen[0][1]]) < 1e-6) && shape.tangents.every((t) => across(t) < 1e-6)) return null;
  return shape;
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
    const seen = seeSketchCurve(src, c.id, frame);
    if (seen) {
      out.push(seen);
      for (const id of Object.values(seen.source?.ends ?? {})) if (id) onCurves.add(id);
      // A spline's points between its ends (and a conic's corner) can still be snapped to, as before.
      if (c.type === "spline") c.points.forEach(lone);
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
  // Seen end-on or edge-on (all of it on one straight line, or a single point, on paper): no curve to copy.
  const far = points.reduce((best, p) => (dist2(p, points[0]) > dist2(best, points[0]) ? p : best), points[0]);
  const span = dist2(far, points[0]);
  if (span < 1e-6) return null;
  const side = (p: P2) => Math.abs((far[0] - points[0][0]) * (p[1] - points[0][1]) - (far[1] - points[0][1]) * (p[0] - points[0][0])) / span;
  if (points.every((p) => side(p) < 1e-6)) return null;
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

/** How many pieces a curved edge is sampled in at least to find where it passes through a sketch's plane (the same for snapping and rebuilding). */
export const PIERCE_SAMPLES = 32;
/** At most this many, for a very wiggly edge. */
export const PIERCE_MAX_SAMPLES = 4096;
/** Neighbouring pieces turning more than this between them (degrees) means the edge wiggles too much for that many. */
const PIERCE_TURN = 30;

/** The same walk along an edge, remembering the places already asked for (pierceSamples then edgePierces ask for the same ones). */
export function remembered(at: (f: number) => Vec3): (f: number) => Vec3 {
  const known = new Map<number, Vec3>();
  return (f) => {
    let p = known.get(f);
    if (!p) known.set(f, (p = at(f)));
    return p;
  };
}

/**
 * How many pieces a curved edge must be sampled in for Pierce to find every
 * place it passes through the plane: PIERCE_SAMPLES for ordinary curves (so
 * snap lists stay quick); at least 4 per span of its own (`spans`: a spline
 * edge's knot spans, which a long wavy edge such as a coil's has many of),
 * then doubled while neighbouring pieces turn sharply from one to the next
 * (wiggles the spans don't show), up to PIERCE_MAX_SAMPLES. The same edge
 * always gets the same count, so snapping and rebuilding agree.
 */
export function pierceSamples(at: (f: number) => Vec3, spans = 1): number {
  const limit = Math.cos((PIERCE_TURN * Math.PI) / 180);
  let start = PIERCE_SAMPLES;
  while (start < 4 * spans && start < PIERCE_MAX_SAMPLES) start *= 2;
  for (let n = start; ; n *= 2) {
    if (n >= PIERCE_MAX_SAMPLES) return PIERCE_MAX_SAMPLES;
    let prev: Vec3 | null = null;
    let last = at(0);
    let smooth = true;
    for (let i = 1; i <= n && smooth; i++) {
      const p = at(i / n);
      const d = sub(p, last);
      const l = Math.hypot(...d);
      if (l < 1e-12) continue;
      const u = scale(d, 1 / l);
      if (prev && dot(prev, u) < limit) smooth = false;
      prev = u;
      last = p;
    }
    if (smooth) return n;
  }
}

/** An edge closer to the plane than this (mm) counts as on it. */
const ON_PLANE = 1e-7;

/**
 * Where a part edge passes through the sketch's plane, from points along it
 * (`at(f)`, f from 0 to 1 along the edge): each change of side is homed in on
 * by halving, and so is each place where it comes close to the plane between
 * samples (a dip through and back, or a touch, that the samples alone would
 * miss). Stretches lying in the plane are left out (there's no single place
 * there), as is an edge lying wholly in it. `samples` pieces are tried first;
 * a straight edge needs just one.
 */
export function edgePierces(frame: PlaneFrame, at: (f: number) => Vec3, samples: number): P2[] {
  const h = (f: number) => dot(sub(at(f), frame.origin), frame.n);
  const fs = Array.from({ length: samples + 1 }, (_, i) => i / samples);
  const hs = fs.map(h);
  const on = hs.map((x) => Math.abs(x) < ON_PLANE);
  if (on.every(Boolean)) return [];
  const found: number[] = [];
  /** Where between lo and hi (heights of opposite signs at the two) it passes through. */
  const halve = (lo: number, hi: number) => {
    let hl = h(lo);
    for (let k = 0; k < 60 && hi - lo > 1e-15; k++) {
      const m = (lo + hi) / 2;
      const hm = h(m);
      if (Math.abs(hm) < ON_PLANE / 10) return m;
      if (Math.sign(hm) === Math.sign(hl)) {
        lo = m;
        hl = hm;
      } else hi = m;
    }
    return (lo + hi) / 2;
  };
  for (let i = 0; i < fs.length; i++) {
    if (on[i]) {
      // On the plane at a sample: a place it passes through or touches, unless a neighbour is on it too (a stretch lying in it).
      if (!(i > 0 && on[i - 1]) && !(i + 1 < fs.length && on[i + 1])) found.push(fs[i]);
      continue;
    }
    if (i + 1 < fs.length && !on[i + 1] && Math.sign(hs[i]) !== Math.sign(hs[i + 1])) found.push(halve(fs[i], fs[i + 1]));
  }
  // Coming close between samples without changing side there: look for the lowest point near each sample nearest the plane.
  for (let i = 1; i + 1 < fs.length; i++) {
    if (on[i] || on[i - 1] || on[i + 1]) continue;
    const sg = Math.sign(hs[i]);
    if (sg !== Math.sign(hs[i - 1]) || sg !== Math.sign(hs[i + 1])) continue;
    const [a, b, c] = [hs[i - 1], hs[i], hs[i + 1]].map((x) => x * sg);
    if (!(b <= a && b <= c)) continue;
    // Could it reach the plane? Only if it's as near as it changes across a step.
    if (b > Math.max(a - b, c - b)) continue;
    let lo = fs[i - 1], hi = fs[i + 1];
    for (let k = 0; k < 50; k++) {
      const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
      if (h(m1) * sg < h(m2) * sg) hi = m2;
      else lo = m1;
    }
    const fm = (lo + hi) / 2;
    const low = h(fm) * sg;
    if (low < -ON_PLANE) found.push(halve(fs[i - 1], fm), halve(fm, fs[i + 1]));
    else if (low < ON_PLANE) found.push(fm);
  }
  const out: P2[] = [];
  for (const f of found.sort((x, y) => x - y)) {
    const p = toSketch(frame, at(f));
    if (!out.some((q) => dist2(p, q) < 1e-6)) out.push(p);
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
export function edgePierceRefs(frame: PlaneFrame, pick: TopoPick, at: (f: number) => Vec3, spans = 1): RefEdge[] {
  const ref = pick.ref;
  if (ref.kind !== "edge") return [];
  const h = (p: Vec3) => dot(sub(p, frame.origin), frame.n);
  // A straight edge lying flat to the plane never passes through it (and one in it doesn't count).
  if (ref.curve === "LINE" && Math.abs(h(ref.a) - h(ref.b)) < 1e-7) return [];
  const walk = ref.curve === "LINE" ? at : remembered(at);
  return edgePierces(frame, walk, ref.curve === "LINE" ? 1 : pierceSamples(walk, spans)).map((p): RefEdge => ({ pick, project: true, pierce: true, kind: "point", a: p, b: p, mid: p }));
}
