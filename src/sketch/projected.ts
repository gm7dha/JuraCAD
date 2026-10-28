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
import { projectEdge, type RefEdge } from "./links";
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
