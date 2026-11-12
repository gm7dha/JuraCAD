/**
 * Loft with Onshape's further choices: sections that are sketches (or one
 * picked area of one), flat faces of parts or a point at either end; end
 * conditions; one guide curve; a path; lining up corners by hand; a closed
 * ring of sections. Plain lofts (no `Feature.loft`) never come here.
 *
 * OpenCascade's loft (BRepOffsetAPI_ThruSections) has no end conditions, so a
 * condition is made by extra copies of the end section placed just beyond it
 * along the way it must leave ("helper sections"): two copies, one very close
 * (it sets the direction) and one further on (how far the condition reaches,
 * the magnitude). A rounded tip is the neighbouring section shrunk along a
 * quarter ellipse to the point. A guide or path uses OpenCascade's pipe shell
 * (BRepOffsetAPI_MakePipeShell) with the sections; a guide is its auxiliary
 * spine with contact, so the sections are scaled to keep touching it — it
 * takes one guide only (OpenCascade has nothing for several).
 */
import { Vertex, cast, downcast, getOC, iterTopo, isShape3D, makeBSplineApproximation, makeLine, makePolygon, makeVertex, measureDistanceBetween, assembleWire, type Edge, type Face, type Shape3D, type Wire } from "replicad";
import { planeFrame, toWorld, type SketchPlane } from "../sketch/planes";
import { findChains, type Segment } from "../sketch/regions";
import { chosenRegions } from "../sketch/areas";
import type { SketchData } from "../sketch/types";
import type { TopoPick } from "../geometry/topoRef";
import type { Feature, GeomPick, LoftCurve, LoftDef, LoftEnd, LoftProfile } from "../model/types";
import { loftProfiles, profilesProblem } from "../model/loft";
import { segmentsWire } from "./extrude";
import { loopStart, pathWire } from "./sweep";
import { asIs } from "./surface";

type Vec3 = [number, number, number];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 1e-12 ? mul(a, 1 / l) : a;
};
const tuple = (v: { x: number; y: number; z: number } | number[]): Vec3 => (Array.isArray(v) ? [v[0], v[1], v[2]] : [v.x, v.y, v.z]);

/** What the loft needs from the engine to find its sections, guide and path. */
export interface LoftContext {
  /** A sketch by id as built so far (null: deleted, suppressed or later in the list). */
  sketch(id: string): { plane: SketchPlane; data: SketchData; name: string } | null;
  /** A part's shape by id (null when it's gone). */
  part(id: string): Shape3D | null;
  /** A picked face found on its part. */
  face(shape: Shape3D, pick: TopoPick): Face;
  /** Picked edges found on their part. */
  edges(shape: Shape3D, picks: TopoPick[]): Edge[];
  /** Names features in messages. */
  name(id: string): string | undefined;
}

/** A section, ready: a closed (or, for surfaces, open) wire, or a point. */
type Section =
  | {
      kind: "wire";
      wire: Wire;
      centre: Vec3;
      /** The section's plane's normal (a face: pointing out of the part). */
      normal: Vec3;
      name: string;
      /** A face section: how its neighbouring faces carry on (outward slope across per mm out), when asked for. */
      spread?: number;
      isFace?: boolean;
      /** For lining up corners: the sketch's pieces and frame. */
      pieces?: { segments: Segment[]; plane: SketchPlane };
      turn?: number;
    }
  | { kind: "point"; at: Vec3; name: string };

/** How far each helper section goes, as a share of the distance to the neighbouring section. */
const CLOSE = 0.01;
const REACH = 0.05;
/** A rounded tip: the angles round the quarter ellipse the neighbour is shrunk along. */
const TIP_ANGLES = [25, 50, 70, 82];
/** Magnitudes kept so helpers never pass halfway to the next section. */
const MOST_MAGNITUDE = 4;

const centreOf = (s: Section): Vec3 => (s.kind === "wire" ? s.centre : s.at);

function pointOf(g: GeomPick, ctx: LoftContext): Vec3 {
  if (g.sketchPoint) {
    const sk = ctx.sketch(g.sketchPoint.sketch);
    if (!sk) throw new Error(`The sketch with the loft's point (${ctx.name(g.sketchPoint.sketch) ?? "deleted"}) can't be used: it's deleted, suppressed or comes later in the list.`);
    const id = g.sketchPoint.point;
    const pt = id === "origin" ? { x: 0, y: 0 } : sk.data.points.find((q) => q.id === id);
    if (!pt) throw new Error(`The point picked in ${sk.name} has been deleted. Choose another point for the loft.`);
    return toWorld(planeFrame(sk.plane), pt.x, pt.y);
  }
  if (g.pick) {
    const shape = ctx.part(g.pick.partId);
    if (!shape) throw new Error("The part with the loft's corner no longer exists (or comes later in the list). Click another corner.");
    const [edge] = ctx.edges(shape, [g.pick]);
    try {
      const a = tuple(edge.startPoint);
      const b = tuple(edge.endPoint);
      if (g.pick.ref.kind !== "edge" || !g.end || g.end === "mid") return tuple(edge.pointAt(0.5));
      const ra = g.pick.ref.a;
      const swapped = len(sub(a, ra)) > len(sub(b, ra)) + 1e-9;
      return g.end === "a" ? (swapped ? b : a) : swapped ? a : b;
    } finally {
      edge.delete();
    }
  }
  return g.p;
}

/** One section, found. */
function sectionOf(p: LoftProfile, ctx: LoftContext, surface: boolean, start: { dir?: Vec3 }): Section {
  if ("point" in p) return { kind: "point", at: pointOf(p.point, ctx), name: "the point" };
  if ("face" in p) {
    const shape = ctx.part(p.face.partId);
    if (!shape) throw new Error("A part with a face the loft uses no longer exists (or comes later in the list). Edit the loft and pick the face again.");
    const face = ctx.face(shape, p.face);
    try {
      if (face.geomType !== "PLANE") throw new Error("A loft section must be a flat face; the picked one is curved now. Edit the loft.");
      const loops = face.wires;
      const holes = loops.length;
      loops.forEach((w) => w.delete());
      if (holes > 1) throw new Error("The picked face has a hole in it — lofts can only join plain outlines. Pick a face without holes, or draw the outline in a sketch.");
      const wire = face.clone().outerWire();
      const c = tuple(face.center);
      const normal = unit(tuple(face.normalAt(c)));
      return { kind: "wire", wire, centre: tuple(wire.boundingBox.center), normal, name: "the picked face", isFace: true, ...(p.turn !== undefined ? { turn: p.turn } : {}) };
    } finally {
      face.delete();
    }
  }
  const sk = ctx.sketch(p.sketch);
  if (!sk) {
    const n = ctx.name(p.sketch);
    throw new Error(n ? `${n} can't be used (it's suppressed, comes later in the list, or has no plane).` : "One of its sketches has been deleted. Edit the loft.");
  }
  const frame = planeFrame(sk.plane);
  let segments: Segment[];
  if (surface) {
    const { chains } = findChains(sk.data);
    if (chains.length !== 1) throw new Error(`${sk.name} needs exactly one run of lines or curves to loft through (it has ${chains.length}).`);
    segments = chains[0].segments;
  } else {
    const { regions } = chosenRegions(sk.data, p.areas, "loft");
    if (regions.length !== 1) throw new Error(p.areas?.length ? `Pick one area of ${sk.name} to loft through.` : `${sk.name} needs exactly one closed shape to loft through (it has ${regions.length}). Tick it, then pick one of its areas.`);
    if (regions[0].holes.length) throw new Error(`${sk.name}'s shape has a hole in it — lofts can only join plain outlines.`);
    segments = regions[0].outer.segments;
  }
  start.dir ??= loopStart(segments, frame);
  const wire = segmentsWire(segments, frame, 0, start.dir);
  return { kind: "wire", wire, centre: tuple(wire.boundingBox.center), normal: frame.n, name: sk.name, pieces: { segments, plane: sk.plane }, ...(p.turn !== undefined ? { turn: p.turn } : {}) };
}

/** The same run of pieces walked the other way. */
function reversedPieces(segments: Segment[]): Segment[] {
  return [...segments].reverse().map((sg): Segment => {
    if (sg.kind === "line") return { kind: "line", from: sg.to, to: sg.from };
    if (sg.kind === "arc") return { kind: "arc", from: sg.to, mid: sg.mid, to: sg.from };
    if (sg.kind === "bezier") return { kind: "bezier", from: sg.to, c1: sg.c2, c2: sg.c1, to: sg.from };
    if (sg.kind === "ellipseArc") return { ...sg, from: sg.to, to: sg.from };
    return sg;
  });
}

/** Which way round a closed run goes, seen along `ref` (+1 anticlockwise). */
function turning(segments: Segment[], plane: SketchPlane, ref: Vec3): number {
  const pts = segments.flatMap((s) => ("from" in s ? [s.from] : []));
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    area += x0 * y1 - x1 * y0;
  }
  const sign = pts.length >= 3 ? Math.sign(area) || 1 : 1;
  return sign * (dot(planeFrame(plane).n, ref) >= 0 ? 1 : -1);
}

/**
 * Onshape's Match connections, simply: every outline walked the same way round as the first and started `turn`
 * corners on, so corner k of each joins corner k of the next. They must all have the same number of pieces.
 */
function lineUpCorners(sections: Section[]): void {
  const wires = sections.filter((s): s is Extract<Section, { kind: "wire" }> => s.kind === "wire");
  const first = wires[0];
  if (!first) return;
  for (const s of wires) if (!s.pieces) throw new Error("Lining up corners works with sketch shapes only, not faces of parts. Untick “Line up the corners myself”.");
  const counts = wires.map((s) => s.pieces!.segments.length);
  if (counts.some((c) => c !== counts[0])) throw new Error(`Lining up corners needs the same number of sides on every shape (${wires.map((s, i) => `${s.name}: ${counts[i]}`).join(", ")}).`);
  const ref = first.normal;
  for (const s of wires) {
    let segs = s.pieces!.segments;
    if (turning(segs, s.pieces!.plane, ref) < 0) segs = reversedPieces(segs);
    const n = segs.length;
    const k = (((s.turn ?? 0) % n) + n) % n;
    segs = [...segs.slice(k), ...segs.slice(0, k)];
    s.wire.delete();
    s.wire = segmentsWire(segs, planeFrame(s.pieces!.plane), 0);
  }
}

/**
 * Every section must sit on the path: the path passes through each outline's plane inside the outline's reach (a
 * point: within a little of it). Refused plainly otherwise (OpenCascade would move the shapes onto the path).
 */
function offPath(sections: Section[], path: Wire): void {
  const N = 512;
  const pts = Array.from({ length: N + 1 }, (_, i) => tuple(path.pointAt(i / N)));
  for (const s of sections) {
    if (s.kind === "point") {
      const gap = Math.min(...pts.map((p) => len(sub(p, s.at))));
      if (gap > 0.05) throw new Error("The loft's point must lie on the path (at one of its ends).");
      continue;
    }
    const reach = diag(s.wire) / 2 + 1e-3;
    const side = pts.map((p) => dot(sub(p, s.centre), s.normal));
    let ok = false;
    for (let i = 0; i <= N && !ok; i++) {
      const here = Math.abs(side[i]) < 1e-6 ? pts[i] : i < N && side[i] * side[i + 1] < 0 ? add(pts[i], mul(sub(pts[i + 1], pts[i]), side[i] / (side[i] - side[i + 1]))) : null;
      if (here && len(sub(here, s.centre)) <= reach) ok = true;
    }
    if (!ok) throw new Error(`${s.name} doesn't sit on the path. Draw each shape on a plane the path passes through, round the place where it crosses.`);
  }
}

/**
 * Along a path: a reference direction carried from the first outline's start along the path without turning about it
 * (projected step by step, a rotation-minimising frame), and each sketch outline restarted there — a circle or ellipse
 * from that direction, a polygon at its corner nearest it, walked the same way round the path as the first. The new
 * wires replace the old (which are freed) and are returned.
 */
function alignAlongPath(sections: Section[], path: Wire): Wire[] {
  const N = 256;
  const pts: Vec3[] = [];
  const tans: Vec3[] = [];
  for (let i = 0; i <= N; i++) {
    pts.push(tuple(path.pointAt(i / N)));
    tans.push(unit(tuple(path.tangentAt(i / N))));
  }
  const nearest = (q: Vec3) => {
    let best = 0;
    for (let i = 1; i <= N; i++) if (len(sub(pts[i], q)) < len(sub(pts[best], q))) best = i;
    return best;
  };
  const first = sections.find((s): s is Extract<Section, { kind: "wire" }> => s.kind === "wire");
  if (!first) return [];
  const flat = (v: Vec3, n: Vec3) => unit(sub(v, mul(n, dot(v, n))));
  const i0 = nearest(first.centre);
  let r = flat(sub(tuple(first.wire.startPoint), first.centre), tans[i0]);
  if (len(r) < 0.5) r = flat(Math.abs(tans[i0][2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], tans[i0]);
  // Carried both ways from the first outline's place.
  const refs: Vec3[] = new Array(N + 1);
  refs[i0] = r;
  for (let i = i0 + 1; i <= N; i++) refs[i] = flat(refs[i - 1], tans[i]);
  for (let i = i0 - 1; i >= 0; i--) refs[i] = flat(refs[i + 1], tans[i]);
  const out: Wire[] = [];
  for (const s of sections) {
    if (s.kind !== "wire" || !s.pieces || s === first) continue;
    const k = nearest(s.centre);
    const frame = planeFrame(s.pieces.plane);
    const d = flat(refs[k], s.normal);
    let segs = s.pieces.segments;
    if (segs.length > 1) {
      if (turning(segs, s.pieces.plane, tans[k]) !== turning(first.pieces?.segments ?? segs, first.pieces?.plane ?? s.pieces.plane, tans[i0])) segs = reversedPieces(segs);
      let best = 0;
      let bestDot = -Infinity;
      segs.forEach((sg, j) => {
        if (!("from" in sg)) return;
        const q = toWorld(frame, sg.from[0], sg.from[1]);
        const k2 = dot(unit(sub(q, s.centre)), d);
        if (k2 > bestDot) {
          bestDot = k2;
          best = j;
        }
      });
      segs = [...segs.slice(best), ...segs.slice(0, best)];
    }
    const w = segmentsWire(segs, frame, 0, d);
    s.wire.delete();
    s.wire = w;
    out.push(w);
  }
  return out;
}

/** A copy of a wire moved and (in its plane) made `grow` mm bigger all round. */
function movedCopy(wire: Wire, by: Vec3, grow: number): Wire {
  let w = wire.clone().translate(by) as Wire;
  if (Math.abs(grow) > 1e-9) {
    const before = diag(w);
    const tryGrow = (d: number) => w.clone().offset2D(d, "intersection");
    let out = tryGrow(grow);
    if ((diag(out) - before) * grow < 0) {
      out.delete();
      out = tryGrow(-grow);
    }
    w.delete();
    w = out;
  }
  return w;
}
const diag = (w: Wire) => {
  const [a, b] = w.boundingBox.bounds;
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
};

/**
 * How a face's neighbours carry on past its outline: for each edge, the neighbouring face's direction square to the
 * edge, split into out of the face (`a`) and outwards across it (`b`); the mean b / a (they should agree for one
 * uniform slope). Refused when a neighbour lies (nearly) flat with the face.
 */
function faceSpread(shape: Shape3D, pick: TopoPick, ctx: LoftContext, outward: Vec3, centre: Vec3): { spread: number; uneven: boolean } {
  const face = ctx.face(shape, pick);
  const faces = shape.faces;
  try {
    const rates: number[] = [];
    for (const e of face.clone().outerWire().edges) {
      const mid = tuple(e.pointAt(0.5));
      const t = unit(tuple(e.tangentAt(0.5)));
      const other = faces.find((f) => !f.isSame(face) && f.edges.some((x) => x.isSame(e)));
      if (!other) continue;
      const m = unit(tuple(other.normalAt(mid)));
      let d = unit(cross(t, m));
      if (dot(d, outward) < 0) d = mul(d, -1);
      const a = dot(d, outward);
      if (a < 0.05) throw new Error("The faces round the picked face lie too flat to carry on from. Choose “Square to the shape” instead.");
      const across = sub(d, mul(outward, a));
      const away = sub(mid, centre);
      const b = len(across) * (dot(across, away) >= 0 ? 1 : -1);
      rates.push(b / a);
    }
    if (!rates.length) return { spread: 0, uneven: false };
    const mean = rates.reduce((s, r) => s + r, 0) / rates.length;
    return { spread: mean, uneven: rates.some((r) => Math.abs(r - mean) > 0.02) };
  } finally {
    face.delete();
    faces.forEach((f) => f.delete());
  }
}

/** The helper sections beyond an end (nearest the end first). */
function helpers(end: Section, next: Section, cond: LoftEnd, which: string): (Wire | Vec3)[] {
  const D = len(sub(centreOf(next), centreOf(end)));
  if (D < 1e-6) throw new Error(`The ${which} section and the one next to it are in the same place, so the ${which} can't be shaped.`);
  if (end.kind === "point") {
    if (cond.kind !== "tangent") throw new Error(`A point at the ${which} can only have a rounded tip (or nothing).`);
    if (next.kind !== "wire") throw new Error(`A rounded tip needs a shape next to the point.`);
    const C = next.centre;
    const T = end.at;
    // Along a quarter ellipse from the neighbour (angle 0) to the tip (90°): shrunk by cos θ, moved on towards the tip
    // by sin θ square to the shape and by 1 − cos θ across it — so an off-centre tip is never passed.
    const n = next.normal;
    const axial = mul(n, dot(sub(T, C), n));
    const across = sub(sub(T, C), axial);
    return [...TIP_ANGLES]
      .reverse()
      .map((deg) => {
        const a = (deg * Math.PI) / 180;
        const w = next.wire.clone().scale(Math.cos(a), C) as Wire;
        return w.translate(add(mul(axial, Math.sin(a)), mul(across, 1 - Math.cos(a)))) as Wire;
      });
  }
  const m = Math.min(MOST_MAGNITUDE, Math.max(0.1, cond.magnitude ?? 1));
  let dir: Vec3;
  let spread = 0;
  if (cond.kind === "normal") {
    dir = dot(sub(centreOf(next), end.centre), end.normal) >= 0 ? end.normal : mul(end.normal, -1);
  } else if (cond.kind === "matchTangent" || cond.kind === "matchCurvature") {
    if (!end.isFace) throw new Error(`“Carry on from the faces” is for a face of a part at the ${which}. Choose “Square to the shape” for a sketch.`);
    // Into the part (a pocket cut from the face): the neighbours carried on the other way.
    const inward = dot(sub(centreOf(next), end.centre), end.normal) < 0;
    dir = inward ? mul(end.normal, -1) : end.normal;
    spread = (end.spread ?? 0) * (inward ? -1 : 1);
  } else throw new Error(`A rounded tip is for a point at the ${which}. Choose “Square to the shape” for a shape.`);
  const far = Math.min(0.3, Math.max(3 * CLOSE, REACH * m));
  const steps = cond.kind === "matchCurvature" ? [CLOSE, far / 2, far] : [CLOSE, far];
  // Never shrunk past a quarter of the outline's size (it would turn inside out).
  const most = diag(end.wire) / 8;
  return steps.map((h) => movedCopy(end.wire, mul(dir, h * D), Math.sign(spread) * Math.min(Math.abs(spread * h * D), most)));
}

/**
 * How fast the shape changes across a gap, 0 → 1: t − t(1 − t)^k at a conditioned start (flat there, so the sides leave
 * square to the shape, then soon as a plain loft), its mirror image at a conditioned end. A bigger magnitude is a smaller
 * k (fuller; k = 1 is t²); "very smoothly" is fuller still.
 */
function easing(start: LoftEnd | undefined, end: LoftEnd | undefined): (t: number) => number {
  const k = (c: LoftEnd | undefined) => {
    if (!c) return 0;
    const m = Math.min(MOST_MAGNITUDE, Math.max(0.1, c.magnitude ?? 1));
    return Math.min(40, Math.max(1, (c.kind === "matchCurvature" ? 2 : 4) / m));
  };
  const a = k(start);
  const b = k(end);
  const flat = (x: number, k: number) => (k ? x - x * (1 - x) ** k : x);
  return (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - flat(1 - flat(t, a), b));
}

/** An edge as a line, or a cubic curve through 17 of its points. */
function lighter(e: Edge): Edge {
  const a = tuple(e.startPoint);
  const b = tuple(e.endPoint);
  const pts = Array.from({ length: 17 }, (_, i) => tuple(e.pointAt(i / 16)));
  const chord = len(sub(b, a));
  const straight = chord > 1e-9 && pts.every((p) => len(cross(sub(p, a), unit(sub(b, a)))) < 1e-6);
  return straight ? makeLine(a, b) : makeBSplineApproximation(pts, { tolerance: 1e-4, degMax: 3, degMin: 3 });
}

/** Cut outlines across a gap between two parallel shapes. */
const EASED_STATIONS = 6;

/**
 * End conditions between two parallel outlines, Onshape-like: the plain loft between them is cut across at eased
 * places h(t) and each cut moved square to the shapes to t, so near a conditioned end the outline barely changes —
 * the sides leave square to it (or, for a face, carrying on its neighbours' slope by growing as they do). The cuts
 * are the plain loft's own outlines, so nothing reaches past either shape.
 */
function easedStations(plain: Shape3D, a: Extract<Section, { kind: "wire" }>, b: Extract<Section, { kind: "wire" }>, start: LoftEnd | undefined, end: LoftEnd | undefined): Wire[] {
  const n = dot(sub(b.centre, a.centre), a.normal) >= 0 ? a.normal : mul(a.normal, -1);
  const D = dot(sub(b.centre, a.centre), n);
  const h = easing(start, end);
  const size = diagOf(plain) * 2 + 10;
  const slope = (sec: typeof a, c: LoftEnd | undefined, sign: number) => (c && (c.kind === "matchTangent" || c.kind === "matchCurvature") ? (sec.spread ?? 0) * sign : 0);
  // Carrying on a face's neighbours: grown by (slope) × the extra distance the outline is held back by.
  const sa = slope(a, start, dot(n, a.normal) >= 0 ? 1 : -1);
  const sb = slope(b, end, dot(n, b.normal) <= 0 ? 1 : -1);
  const out: Wire[] = [];
  for (let k = 1; k <= EASED_STATIONS; k++) {
    const t = k / (EASED_STATIONS + 1);
    const s = h(t);
    const cut = cutBy(plain, add(a.centre, mul(n, D * s)), n, size);
    if (!Array.isArray(cut) || !cut.length) continue;
    let w: Wire;
    try {
      // Each cut edge as a light curve (the cuts of OpenCascade's own lofts carry hundreds of poles, which makes the
      // loft through them very slow); straight ones stay straight.
      w = assembleWire(cut.map((e) => lighter(e)));
    } catch {
      continue;
    }
    w = w.translate(mul(n, D * (t - s))) as Wire;
    const grow = sa * D * Math.max(0, t - s) * (1 - t) + sb * D * Math.max(0, s - t) * t;
    if (Math.abs(grow) > 1e-6) w = movedCopy(w, [0, 0, 0], grow);
    out.push(w);
  }
  return out;
}

/** A guide or path as one wire: a sketch's one run of curves, or picked part edges joined end to end. */
function curveWire(c: LoftCurve, ctx: LoftContext, what: string, near?: Vec3): Wire {
  if ("sketch" in c) {
    const sk = ctx.sketch(c.sketch);
    if (!sk) throw new Error(`The ${what} sketch (${ctx.name(c.sketch) ?? "deleted"}) can't be used: it's deleted, suppressed or comes later in the list.`);
    try {
      return pathWire(sk.plane, sk.data, near);
    } catch (e) {
      throw new Error(`The ${what}: ${e instanceof Error ? e.message.replace(/^The path/, "It") : String(e)}`);
    }
  }
  const edges: Edge[] = [];
  for (const partId of new Set(c.edges.map((e) => e.partId))) {
    const shape = ctx.part(partId);
    if (!shape) throw new Error(`A part with the ${what}'s edges no longer exists. Edit the loft and pick them again.`);
    edges.push(...ctx.edges(shape, c.edges.filter((e) => e.partId === partId)));
  }
  try {
    return assembleWire(edges);
  } catch {
    throw new Error(`The ${what}'s edges must join end to end into one run.`);
  }
}

/** Is a wire (nearly) touching a guide? */
function touches(wire: Wire, guide: Wire): boolean {
  const tol = Math.max(0.01, 1e-3 * diag(wire));
  return measureDistanceBetween(wire, guide) <= tol;
}

/** How many cut outlines a guide curve shapes between each two sections. */
const STATIONS = 5;

/** OpenCascade's loft through wires (and points at the ends). */
function thruSections(seq: (Wire | Vec3)[], solid: boolean, ruled: boolean, check: boolean, made: { delete(): void }[]): Shape3D {
  const oc = getOC();
  const builder = new oc.BRepOffsetAPI_ThruSections(solid, ruled, 1e-6);
  try {
    builder.CheckCompatibility(check);
    for (const s of seq) {
      if (Array.isArray(s)) {
        const v = makeVertex(s);
        made.push(v);
        builder.AddVertex(v.wrapped);
      } else builder.AddWire(s.wrapped);
    }
    builder.Build();
    const shape = cast(builder.Shape());
    if (!isShape3D(shape)) throw new Error("no shape");
    return shape;
  } finally {
    builder.delete();
  }
}

/** Where a shape is cut by the plane through `at` square to `n`: its edges (the caller frees them). */
function cutBy(shape: Shape3D | Wire, at: Vec3, n: Vec3, size: number): Edge[] | { vertices: Vec3[] } {
  const oc = getOC();
  const u = unit(Math.abs(n[2]) < 0.9 ? cross(n, [0, 0, 1]) : cross(n, [1, 0, 0]));
  const v = cross(n, u);
  const P = (a: number, b: number): Vec3 => add(at, add(mul(u, a), mul(v, b)));
  const r = size;
  const sheet = makePolygon([P(-r, -r), P(r, -r), P(r, r), P(-r, r)]);
  const op = new oc.BRepAlgoAPI_Section(shape.wrapped, sheet.wrapped, true);
  try {
    const cut = cast(op.Shape()) as unknown as Shape3D;
    const edges = cut.edges;
    if (edges.length) return edges;
    const vertices: Vec3[] = [];
    for (const v of iterTopo(cut.wrapped, "vertex")) {
      const vx = new Vertex(downcast(v) as never);
      vertices.push(tuple(vx.asTuple()));
      vx.delete();
    }
    return { vertices };
  } finally {
    op.delete();
    sheet.delete();
  }
}

/** One station of a guided loft: the unguided loft cut across there, scaled about its middle out (or in) to the guide. */
function guidedStation(base: Shape3D, guide: Wire, at: Vec3, n: Vec3): Wire | null {
  const size = diagOf(base) * 2 + 10;
  const cut = cutBy(base, at, n, size);
  if (!Array.isArray(cut) || !cut.length) return null;
  let wire: Wire;
  try {
    wire = assembleWire(cut);
  } catch {
    return null;
  }
  const hit = cutBy(guide, at, n, size);
  const points = Array.isArray(hit) ? hit.flatMap((e) => [tuple(e.startPoint)]) : hit.vertices;
  if (Array.isArray(hit)) hit.forEach((e) => e.delete());
  if (!points.length) throw new Error("The guide curve must run all the way from the first shape to the last.");
  const c = tuple(wire.boundingBox.center);
  // The outline's point in the guide's direction from its middle (sampled), and how far out it is.
  const samples = Array.from({ length: 240 }, (_, i) => tuple(wire.pointAt(i / 240)));
  const g = points.reduce((best, p) => (len(sub(p, c)) > 0 && minDist(samples, p) < minDist(samples, best) ? p : best), points[0]);
  const dir = unit(sub(g, c));
  // Stretched along the guide's direction only, from the outline's far side (which stays where it is): the side
  // nearest the guide moves out (or in) to it, the rest by less and less.
  const along = (q: Vec3) => dot(sub(q, c), dir);
  const proj = samples.map(along);
  const lo = Math.min(...proj);
  const hi = Math.max(...proj);
  const want = along(g);
  if (hi - lo < 1e-9 || Math.abs(want - hi) < 1e-9) return wire;
  const k = (want - lo) / (hi - lo);
  const map = (q: Vec3): Vec3 => add(q, mul(dir, (along(q) - lo) * (k - 1)));
  const edges = wire.edges.map((e) => {
    if (e.geomType === "LINE") return makeLine(map(tuple(e.startPoint)), map(tuple(e.endPoint)));
    const pts = Array.from({ length: 33 }, (_, i) => map(tuple(e.pointAt(i / 32))));
    return makeBSplineApproximation(pts, { tolerance: 1e-5, degMax: 5, degMin: 3 });
  });
  wire.delete();
  try {
    return assembleWire(edges);
  } catch {
    return null;
  }
}
const minDist = (pts: Vec3[], p: Vec3) => pts.reduce((m, q) => Math.min(m, len(sub(q, p))), Infinity);
const diagOf = (s: Shape3D) => {
  const [a, b] = s.boundingBox.bounds;
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
};

/** Builds a loft with further choices: a solid (or a surface when `surface`). `notes` gets anything worth telling. */
export function buildLoft(feature: Pick<Feature, "sections" | "loft" | "loftRuled" | "surface">, ctx: LoftContext, notes?: string[]): Shape3D {
  const def: LoftDef = feature.loft ?? {};
  const profiles = loftProfiles(feature);
  const problem = profilesProblem(profiles);
  if (problem) throw new Error(problem);
  const surface = !!feature.surface;
  const ruled = !!feature.loftRuled;
  const made: { delete(): void }[] = [];
  try {
    const start: { dir?: Vec3 } = {};
    const sections = profiles.map((p) => sectionOf(p, ctx, surface, start));
    for (const s of sections) if (s.kind === "wire") made.push(s.wire);
    if (def.matchCorners) {
      lineUpCorners(sections);
      made.length = 0;
      for (const s of sections) if (s.kind === "wire") made.push(s.wire);
    }
    // Along a path, every outline starts where the first one's start is carried to (else the pipe twists between them).
    const pathW = def.path ? curveWire(def.path, ctx, "path", centreOf(sections[0])) : null;
    if (pathW) {
      made.push(pathW);
      offPath(sections, pathW);
      if (!def.matchCorners) for (const w of alignAlongPath(sections, pathW)) made.push(w);
    }
    // Faces that must carry on from their neighbours.
    const wantsSpread = (cond: LoftEnd | undefined) => cond?.kind === "matchTangent" || cond?.kind === "matchCurvature";
    const ends: [LoftEnd | undefined, number][] = [
      [def.start, 0],
      [def.end, sections.length - 1],
    ];
    for (const [cond, i] of ends) {
      const s = sections[i];
      const p = profiles[i];
      if (wantsSpread(cond) && s.kind === "wire" && s.isFace && "face" in p) {
        const shape = ctx.part(p.face.partId)!;
        const { spread, uneven } = faceSpread(shape, p.face, ctx, s.normal, s.centre);
        s.spread = spread;
        if (uneven) notes?.push("The faces round the picked face slope by different amounts, so the loft carries on from them only roughly.");
      }
    }
    const periodic = !!def.periodic;
    const guided = !!def.guide || !!def.path;
    if (periodic) {
      if (sections.some((s) => s.kind === "point")) throw new Error("A closed ring of sections can't have a point in it.");
      if (def.start || def.end) throw new Error("A closed ring of sections has no ends, so it can't have start or end conditions.");
      if (sections.length < 3) throw new Error("A closed ring needs at least three sections.");
      if (guided) throw new Error("A closed ring of sections can't follow a guide or path as well.");
    }
    if (guided && ruled) throw new Error("“Straight between shapes” can't follow a guide or path. Untick one of them.");
    // The order the loft goes through, with helper sections at its ends.
    const seq: (Wire | Vec3)[] = sections.map((s) => (s.kind === "wire" ? s.wire : s.at));
    // Conditions that don't suit their section, refused in plain words.
    for (const [cond, i, which] of [[def.start, 0, "start"], [def.end, sections.length - 1, "end"]] as const) {
      if (!cond) continue;
      const sec = sections[i];
      if (cond.kind === "tangent" && sec.kind !== "point") throw new Error(`A rounded tip is for a point at the ${which}. Choose “Square to the shape” for a shape.`);
      if (cond.kind !== "tangent" && sec.kind === "point") throw new Error(`A point at the ${which} can only have a rounded tip (or nothing).`);
      if ((cond.kind === "matchTangent" || cond.kind === "matchCurvature") && !(sec.kind === "wire" && sec.isFace))
        throw new Error(`“Carry on from the faces” is for a face of a part at the ${which}. Choose “Square to the shape” for a sketch.`);
      // From a part's face back into the part, a shaped end would run along the part's own sides (nothing sensible to
      // cut or add), so it's refused plainly.
      const nb = sections[i === 0 ? 1 : sections.length - 2];
      if (sec.kind === "wire" && sec.isFace && nb && dot(sub(centreOf(nb), sec.centre), sec.normal) < 0)
        throw new Error(`The loft goes from the picked face into its part, so its ${which} can't be shaped there (it would run along the part's own sides). Leave the ${which} free, or draw the outline in a sketch on the face, a little inside its edges.`);
    }
    // End conditions between two parallel shapes (no guide, path or hand-lined corners): eased cuts of the plain loft.
    const easable = (i: number, j: number, cond: LoftEnd | undefined) => {
      const x = sections[i];
      const y = sections[j];
      return !!cond && cond.kind !== "tangent" && !def.guide && !def.path && !def.matchCorners && !ruled && x?.kind === "wire" && y?.kind === "wire" && Math.abs(dot(x.normal, y.normal)) > 0.9999 && Math.abs(dot(unit(sub(y.centre, x.centre)), x.normal)) > 0.05;
    };
    const last = sections.length - 1;
    const easeStart = sections.length >= 2 && easable(0, 1, def.start);
    const easeEnd = sections.length >= 2 && easable(last, last - 1, def.end);
    if (easeStart || easeEnd) {
      const plain = thruSections(seq, false, false, true, made);
      made.push(plain);
      const gaps = last === 1 ? [0] : [...(easeStart ? [0] : []), ...(easeEnd ? [last - 1] : [])];
      for (const g of [...gaps].sort((x, y) => y - x)) {
        const st = easeStart && g === 0 ? def.start : undefined;
        const en = easeEnd && g === last - 1 ? def.end : undefined;
        const ws = easedStations(plain, sections[g] as Extract<Section, { kind: "wire" }>, sections[g + 1] as Extract<Section, { kind: "wire" }>, st, en);
        made.push(...ws);
        seq.splice(g + 1, 0, ...ws);
      }
    }
    if (sections.length >= 2) {
      if (def.end && !easeEnd) {
        const h = helpers(sections[sections.length - 1], sections[sections.length - 2], def.end, "end");
        for (const w of h) if (!Array.isArray(w)) made.push(w);
        seq.splice(seq.length - 1, 0, ...[...h].reverse());
      }
      if (def.start && !easeStart) {
        const h = helpers(sections[0], sections[1], def.start, "start");
        for (const w of h) if (!Array.isArray(w)) made.push(w);
        seq.splice(1, 0, ...h);
      }
    }
    if (def.guide && def.path) throw new Error("A loft can follow a guide curve or a path, not both. Take one of them out.");
    if (def.guide) {
      const guide = curveWire(def.guide, ctx, "guide curve", centreOf(sections[0]));
      made.push(guide);
      for (const s of sections) if (s.kind === "wire" && !touches(s.wire, guide)) throw new Error(`The guide curve must touch the outline of every shape, but it misses ${s.name}.`);
      // The loft without the guide, cut across at stations between the sections; each cut outline is then scaled about
      // its middle until it reaches the guide, and the loft is made again through the sections and those outlines.
      const base = thruSections(seq, false, false, !def.matchCorners, made);
      made.push(base);
      const first = centreOf(sections[0]);
      const axis = unit(sub(centreOf(sections[sections.length - 1]), first));
      const along = (p: Vec3) => dot(sub(p, first), axis);
      const stations: { at: number; wire: Wire }[] = [];
      for (let i = 0; i + 1 < sections.length; i++) {
        const a = along(centreOf(sections[i]));
        const b = along(centreOf(sections[i + 1]));
        if (b - a < 1e-6) throw new Error("With a guide curve, the shapes must follow one another in one direction (each further on than the last).");
        for (let k = 1; k <= STATIONS; k++) {
          const t = a + ((b - a) * k) / (STATIONS + 1);
          const w = guidedStation(base, guide, add(first, mul(axis, t)), axis);
          if (w) {
            made.push(w);
            stations.push({ at: t, wire: w });
          }
        }
      }
      // Everything in order along the way: points first/last, helper and real sections and stations by how far along they are.
      const wiresAlong = seq.filter((x): x is Wire => !Array.isArray(x)).map((w) => ({ at: along(tuple(w.boundingBox.center)), wire: w }));
      const all = [...wiresAlong, ...stations].sort((x, y) => x.at - y.at).map((x) => x.wire as Wire | Vec3);
      if (Array.isArray(seq[0])) all.unshift(seq[0]);
      if (seq.length > 1 && Array.isArray(seq[seq.length - 1])) all.push(seq[seq.length - 1]);
      try {
        const shape = thruSections(all, !surface, false, true, made);
        return surface ? asIs(shape) : shape;
      } catch {
        throw new Error("Couldn't loft along that guide curve. It must touch every shape's outline and run from the first shape to the last.");
      }
    }
    if (def.path) {
      const oc = getOC();
      const path = pathW!;
      const builder = new oc.BRepOffsetAPI_MakePipeShell(path.wrapped);
      try {
        builder.SetMode(false);
        // Sharp corners of the path: the pieces meet in a mitre, as Onshape's.
        builder.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner);
        for (const s of seq) {
          if (Array.isArray(s)) {
            const v = makeVertex(s);
            made.push(v);
            builder.Add(v.wrapped, false, false);
          } else builder.Add(s.wrapped, false, false);
        }
        builder.Build();
        if (!builder.IsDone()) throw new Error("no shape");
        if (!surface) builder.MakeSolid();
        const shape = cast(builder.Shape());
        if (!isShape3D(shape)) throw new Error("no shape");
        return surface ? asIs(shape) : shape;
      } catch {
        throw new Error("Couldn't loft along that path. Draw the shapes across the path (each standing square to it, near where it passes).");
      } finally {
        builder.delete();
      }
    }
    // A ring: back to the very same first outline, which OpenCascade joins up smoothly.
    const ring = periodic ? [...seq, seq[0]] : seq;
    try {
      const shape = thruSections(ring, !surface, ruled, !def.matchCorners, made);
      return surface ? asIs(shape) : shape;
    } catch {
      throw new Error(
        def.matchCorners
          ? "Couldn't loft with the corners lined up that way. Try another turn for one of the shapes."
          : "Couldn't loft between those shapes. Try sketches on parallel planes, or outlines with the same number of sides.",
      );
    }
  } finally {
    for (const m of made) {
      try {
        m.delete();
      } catch {
        // already freed
      }
    }
  }
}
