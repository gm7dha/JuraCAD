/**
 * What a click in the 3D view gives a newer Plane feature or a Part Studio
 * mate connector (pure): a point (a corner, an edge's middle, a flat face's
 * centre, a mate connector), a line (a straight edge, a round edge's or face's
 * axis, a flat face's normal, a sketch line, a connector's Z) or a place for a
 * connector — each kept with what it's on, so the engine can follow it.
 */
import type { EdgeRef, TopoPick } from "../geometry/topoRef";
import type { PlaneFrame, SketchPlane } from "../sketch/planes";
import type { SketchLineRef } from "./patternRefs";
import type { ConnectorSpot, Feature, GeomPick, MateConnectorDef, PlaneOptions, TransformFrame } from "./types";
import { circleOf, spotFrame, type SpotSource } from "./transformPicks";
import { tidyVec } from "./transformPicks";

type Vec3 = [number, number, number];

/** What was clicked. */
export type GeomClick =
  /** A part's face or edge; `at` where it was clicked; `points` the edge as drawn (to find a round edge's centre). */
  | { kind: "part"; pick: TopoPick; at?: Vec3; points?: Vec3[] }
  /** Top/Front/Right or a Plane feature. */
  | { kind: "plane"; plane: SketchPlane; frame: PlaneFrame }
  /** A Part Studio mate connector. */
  | { kind: "connector"; id: string; origin: Vec3; z: Vec3; x: Vec3 }
  /** A straight line of a sketch. */
  | { kind: "sketchLine"; line: SketchLineRef; a: Vec3; b: Vec3 };

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** An edge's end nearest the click, when the click is within a sixth of its length of it (a corner, as Onshape infers). */
export function nearEnd(ref: EdgeRef, at: Vec3 | undefined): "a" | "b" | null {
  if (!at || dist(ref.a, ref.b) < 1e-6) return null;
  const da = dist(at, ref.a);
  const db = dist(at, ref.b);
  const reach = dist(ref.a, ref.b) / 6;
  if (Math.min(da, db) > reach) return null;
  return da <= db ? "a" : "b";
}

/** How far along a line of points (0…1, by length) the point nearest `q` is. */
export function fractionAlong(points: Vec3[], q: Vec3): number {
  if (points.length < 2) return 0.5;
  let total = 0;
  let best = { d: Infinity, at: 0 };
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const d = sub(points[i + 1], a);
    const l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * d[0] + (q[1] - a[1]) * d[1] + (q[2] - a[2]) * d[2]) / l2)) : 0;
    const p: Vec3 = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
    const gap = dist(p, q);
    const len = Math.sqrt(l2);
    if (gap < best.d) best = { d: gap, at: total + t * len };
    total += len;
  }
  return total > 0 ? Math.round((best.at / total) * 1e4) / 1e4 : 0.5;
}

/** A point for a plane to go through. */
export function pointFromClick(c: GeomClick): GeomPick | string {
  if (c.kind === "connector") return { p: tidyVec(c.origin), connector: c.id };
  if (c.kind === "plane") return "Click a point: a corner (near the end of an edge), an edge's middle, a flat face's centre or a mate connector.";
  if (c.kind === "sketchLine") return { p: tidyVec(c.a), dir: tidyVec(sub(c.b, c.a)), sketchLine: c.line };
  const ref = c.pick.ref;
  if (ref.kind === "face") {
    if (ref.surface !== "PLANE") return "That face is curved. Click a corner, an edge, a flat face or a mate connector.";
    return { p: tidyVec(ref.center), dir: tidyVec(ref.normal), pick: stripAt(c.pick) };
  }
  const end = nearEnd(ref, c.at);
  if (end) return { p: tidyVec(ref[end]), pick: stripAt(c.pick), end };
  // A round edge: its centre (closed) or the middle of its arc.
  const circle = ref.curve === "CIRCLE" && c.points ? circleOf(c.points) : null;
  if (circle && dist(ref.a, ref.b) < 1e-6) return { p: tidyVec(circle.centre), dir: tidyVec(circle.normal), pick: stripAt(c.pick) };
  return { p: tidyVec(ref.mid), pick: stripAt(c.pick), end: "mid" };
}

/** A line or direction for a plane: along a straight edge, round a round one, out of a flat face, along a sketch line or a connector's Z. */
export function lineFromClick(c: GeomClick): GeomPick | string {
  if (c.kind === "connector") return { p: tidyVec(c.origin), dir: tidyVec(c.z), connector: c.id };
  if (c.kind === "plane") return { p: tidyVec(c.frame.origin), dir: tidyVec(c.frame.n) };
  if (c.kind === "sketchLine") return { p: tidyVec(c.a), dir: tidyVec(sub(c.b, c.a)), sketchLine: c.line };
  const ref = c.pick.ref;
  const pick = stripAt(c.pick);
  if (ref.kind === "face") {
    if (ref.surface === "PLANE") return { p: tidyVec(ref.center), dir: tidyVec(ref.normal), pick };
    if (ref.surface.startsWith("CYLIND") || ref.surface === "CONE") return { p: tidyVec(ref.center), dir: tidyVec(ref.normal), pick };
    return "That face is neither flat nor round. Click a straight edge, a round edge or face, a flat face or a sketch line.";
  }
  if (ref.curve === "LINE") return { p: tidyVec(ref.a), dir: tidyVec(sub(ref.b, ref.a)), pick };
  const circle = c.points ? circleOf(c.points) : null;
  if (circle) return { p: tidyVec(circle.centre), dir: tidyVec(circle.normal), pick };
  return "That edge is neither straight nor round. Click a straight edge, a round edge or face, a flat face or a sketch line.";
}

/** Curve point: the edge clicked, and how far along it the click was. */
export function curveFromClick(c: GeomClick): { point: GeomPick; position: number } | string {
  if (c.kind !== "part" || c.pick.ref.kind !== "edge") return "Click an edge: the plane stands square to it where you choose along it.";
  const ref = c.pick.ref;
  const position = c.at && c.points?.length ? fractionAlong(orientedPoints(c.points, ref), c.at) : 0.5;
  const dir = ref.curve === "LINE" ? sub(ref.b, ref.a) : c.at && c.points && c.points.length > 1 ? nearestPiece(orientedPoints(c.points, ref), c.at) : undefined;
  return { point: { p: tidyVec(c.at ?? ref.mid), ...(dir ? { dir: tidyVec(dir) } : {}), pick: stripAt(c.pick) }, position };
}

/** The direction of the drawn piece of an edge nearest `q` (roughly the edge's direction there, until the engine works it out exactly). */
function nearestPiece(points: Vec3[], q: Vec3): Vec3 {
  let best: { d: number; dir: Vec3 } = { d: Infinity, dir: sub(points[1], points[0]) };
  for (let i = 0; i + 1 < points.length; i++) {
    const mid: Vec3 = [(points[i][0] + points[i + 1][0]) / 2, (points[i][1] + points[i + 1][1]) / 2, (points[i][2] + points[i + 1][2]) / 2];
    const d = dist(mid, q);
    if (d < best.d) best = { d, dir: sub(points[i + 1], points[i]) };
  }
  return best.dir;
}

/** An edge's drawn points, running from its `a` end. */
function orientedPoints(points: Vec3[], ref: EdgeRef): Vec3[] {
  return dist(points[0], ref.a) <= dist(points[points.length - 1], ref.a) ? points : [...points].reverse();
}

/** Where a mate connector goes for a click (and, until the engine has found it, roughly where that is). */
export function connectorFromClick(c: GeomClick): Pick<MateConnectorDef, "at" | "plane" | "base"> | string {
  if (c.kind === "connector") return { at: { p: tidyVec(c.origin), connector: c.id }, base: { origin: c.origin, x: c.x, z: c.z } };
  if (c.kind === "sketchLine") return "Click a face, an edge, a corner, a mate connector or a plane for the mate connector.";
  if (c.kind === "plane") return { at: { p: tidyVec(c.frame.origin) }, plane: c.plane, base: { origin: c.frame.origin, x: c.frame.u, z: c.frame.n } };
  const ref = c.pick.ref;
  const src: SpotSource = ref.kind === "face" ? { kind: "face", ref, at: c.at } : { kind: "edge", ref, at: c.at, points: c.points ?? [] };
  const f = spotFrame(src);
  if (typeof f === "string" && !(ref.kind === "face" && (ref.surface.startsWith("CYLIND") || ref.surface === "CONE"))) return f;
  let spot: ConnectorSpot | undefined;
  if (ref.kind === "edge") {
    const end = nearEnd(ref, c.at);
    if (end) spot = end === "a" ? "start" : "end";
  }
  const base: TransformFrame = typeof f === "string" ? { origin: ref.kind === "face" ? ref.center : [0, 0, 0], x: [1, 0, 0], z: [0, 0, 1] } : { origin: f.origin, x: f.x, z: f.z };
  return { at: { p: tidyVec(base.origin), pick: stripAt(c.pick), ...(spot ? { spot } : {}) }, base };
}

/** A pick kept without where it was clicked (that's only for telling look-alike faces apart, and changes every click). */
function stripAt(p: TopoPick): TopoPick {
  return { partId: p.partId, ref: p.ref };
}

/** True when a click is a point rather than a line for Point normal: a corner, a round edge's centre, or a connector (when no point is chosen yet). */
function looksLikePoint(c: GeomClick, havePoint: boolean): boolean {
  if (c.kind === "connector") return !havePoint;
  if (c.kind !== "part" || c.pick.ref.kind !== "edge") return false;
  return nearEnd(c.pick.ref, c.at) !== null;
}

/** Same pick (the same thing clicked again). */
function samePick(a: GeomPick, b: GeomPick): boolean {
  return JSON.stringify([a.pick?.partId, a.pick?.ref, a.end, a.connector, a.sketchLine, a.sketchPoint, a.pick ? null : a.p]) === JSON.stringify([b.pick?.partId, b.pick?.ref, b.end, b.connector, b.sketchLine, b.sketchPoint, b.pick ? null : b.p]);
}

/**
 * A click while a Plane feature of a newer type is open: what it changes. Clicking a point that's already chosen
 * takes it out again (three point and fit).
 */
export function planeClick(def: PlaneOptions, c: GeomClick): PlaneOptions | string {
  switch (def.mode) {
    case "point": {
      if (c.kind === "plane") return { ...def, ref: c.plane };
      const pt = pointFromClick(c);
      return typeof pt === "string" ? pt : { ...def, points: [pt] };
    }
    case "pointNormal": {
      const havePoint = !!def.points?.length;
      if (looksLikePoint(c, havePoint)) {
        const pt = pointFromClick(c);
        return typeof pt === "string" ? pt : { ...def, points: [pt] };
      }
      const line = lineFromClick(c);
      if (typeof line !== "string") return { ...def, line };
      const pt = pointFromClick(c);
      return typeof pt === "string" ? line : { ...def, points: [pt] };
    }
    case "lineAngle": {
      const line = lineFromClick(c);
      return typeof line === "string" ? line : { ...def, line };
    }
    case "curvePoint": {
      const r = curveFromClick(c);
      return typeof r === "string" ? r : { ...def, points: [r.point], position: r.position };
    }
    case "threePoint":
    case "fit": {
      const pt = pointFromClick(c);
      if (typeof pt === "string") return pt;
      const list = def.points ?? [];
      const at = list.findIndex((q) => samePick(q, pt));
      if (at >= 0) return { ...def, points: list.filter((_, i) => i !== at) };
      if (def.mode === "threePoint" && list.length >= 3) return "It already has three points. Take one out (click it again, or its × in the dialog) to choose another.";
      return { ...def, points: [...list, pt] };
    }
    default:
      return def;
  }
}

/**
 * Whether a click may pick a mate connector now: only while what's open takes one (a Mate connector or Plane, Move /
 * copy's From or To, a sketch waiting for its plane, a Mirror's plane, Text's plane), a mate is being made in an
 * assembly, or nothing is open (it's selected). Otherwise clicks go to faces and edges as usual.
 */
export function connectorWanted(s: { editing: { draft: Feature } | null; sketch: unknown; mateDraft: unknown }, inAssembly: boolean): boolean {
  if (inAssembly) return !!s.mateDraft;
  const d = s.editing?.draft;
  if (!d) return !s.sketch;
  if (d.type === "sketch") return !!s.sketch && !d.sketch?.plane;
  if (d.type === "mateConnector" || d.type === "plane" || d.type === "mirror" || d.type === "text") return true;
  return d.type === "transform" && (d.transform?.picking === "from" || d.transform?.picking === "to");
}

