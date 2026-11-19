/**
 * Loft with Onshape's further choices: sections that are sketches (or one
 * picked area of one), flat faces of parts or a point at either end; end
 * conditions; guide curves (several); a path; lining up corners by hand or by Connections; a closed
 * ring of sections. Plain lofts (no `Feature.loft`) never come here.
 *
 * OpenCascade's loft (BRepOffsetAPI_ThruSections) has no end conditions, so a
 * condition is made by extra copies of the end section placed just beyond it
 * along the way it must leave ("helper sections"): two copies, one very close
 * (it sets the direction) and one further on (how far the condition reaches,
 * the magnitude). A rounded tip is the neighbouring section shrunk along a
 * quarter ellipse to the point. A guide or path uses OpenCascade's pipe shell
 * (BRepOffsetAPI_MakePipeShell) with the sections. Guides: the loft without
 * them is cut across at stations and each cut bent to pass through every
 * guide (OpenCascade has nothing for several), then lofted again.
 */
import { Vertex, makeFace, cast, downcast, getOC, iterTopo, isShape3D, makeBSplineApproximation, makeLine, makePolygon, makeThreePointArc, makeVertex, measureDistanceBetween, assembleWire, type Edge, type Face, type Shape3D, type Wire } from "replicad";
import { planeFrame, toWorld, type SketchPlane } from "../sketch/planes";
import { findChains, findRegions, type Segment } from "../sketch/regions";
import { chosenRegions } from "../sketch/areas";
import type { SketchData } from "../sketch/types";
import type { TopoPick } from "../geometry/topoRef";
import type { Feature, GeomPick, LoftCurve, LoftDef, LoftEnd, LoftProfile } from "../model/types";
import { END_LABELS, loftGuides, loftProfiles, profilesProblem } from "../model/loft";
import { crossedOver, fitWarp, rayHit, type P2 } from "../geometry/warp2d";
import { tangentBend } from "../geometry/guideTangent";
import { segmentsWire } from "./extrude";
import { loopStart, pathWire } from "./sweep";
import { asIs, encloseSurfaces } from "./surface";
import { cornerOnShape } from "./corners";
import { chainEdges, reversedWire } from "./curves";
import { thinSketches, type ThinSides } from "../sketch/thin";

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
  /** A curve feature's wire by id (a fresh copy the loft frees; throws a plain message when it can't be used). */
  curve?(id: string, what: string): Wire | null;
  /** Every part's shape as built so far (to find the face a sketch is drawn on). */
  allParts?(): Shape3D[];
}

/** A section's outline given straight (Thin's walls): its pieces in the sketch's plane, used instead of its areas. */
type Overrides = Map<number, Segment[]>;

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
      /** A sketch on a part's face, carrying on from the faces round that face (Onshape's "Adjacent faces"). */
      adjacent?: boolean;
      /** Not flat (a curved face, or part edges that don't lie in one plane): `normal` is only roughly its way. */
      curved?: boolean;
      /** Part edges, not a sketch or face. */
      isEdges?: boolean;
      /** A curved face section: the face itself, to close a solid loft's end with (no flat face fits its outline). */
      cap?: Face;
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
/** "Tangent to profile": each helper copy's distance on (share of the gap) and how much it grows (share, × magnitude). */
const PROFILE_STEPS: [number, number][] = [
  [0.002, 0.02],
  [0.01, 0.06],
];
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
  if (g.vertex) {
    // A corner clicked as itself.
    const shape = ctx.part(g.vertex.partId);
    if (!shape) throw new Error("The part with the loft's corner no longer exists (or comes later in the list). Click another corner.");
    const at = cornerOnShape(shape, g.vertex.ref);
    if (!at) throw new Error("The loft's corner can't be found on its part any more (the part has changed too much). Click the corner again.");
    return at;
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
function sectionOf(p: LoftProfile, ctx: LoftContext, surface: boolean, start: { dir?: Vec3 }, override?: Segment[]): Section {
  if ("point" in p) return { kind: "point", at: pointOf(p.point, ctx), name: "the point" };
  if ("edges" in p) {
    const edges: Edge[] = [];
    for (const partId of new Set(p.edges.map((e) => e.partId))) {
      const shape = ctx.part(partId);
      if (!shape) throw new Error("A part with edges a loft section uses no longer exists (or comes later in the list). Edit the loft and pick them again.");
      edges.push(...ctx.edges(shape, p.edges.filter((e) => e.partId === partId)));
    }
    // Joined in order (the picks can come in any order or direction).
    const wires = chainEdges(edges);
    if (wires.length !== 1) {
      wires.forEach((w) => w.delete());
      throw new Error(`A section's part edges must join end to end into one run (they make ${wires.length}). Pick edges that follow on from each other.`);
    }
    const wire = wires[0];
    if (!surface && !wire.isClosed) {
      wire.delete();
      throw new Error("For a solid loft, a section made of part edges must go all the way round (a closed outline). Tick Surface to loft through open edges.");
    }
    const { normal, flat } = wireNormal(wire);
    return { kind: "wire", wire, centre: tuple(wire.boundingBox.center), normal, name: "the picked edges", isEdges: true, ...(flat ? {} : { curved: true }) };
  }
  if ("face" in p) {
    const shape = ctx.part(p.face.partId);
    if (!shape) throw new Error("A part with a face the loft uses no longer exists (or comes later in the list). Edit the loft and pick the face again.");
    const face = ctx.face(shape, p.face);
    try {
      const loops = face.wires;
      const holes = loops.length;
      loops.forEach((w) => w.delete());
      if (holes > 1) throw new Error("The picked face has a hole in it — lofts can only join plain outlines. Pick a face without holes, or draw the outline in a sketch.");
      const wire = face.clone().outerWire();
      const c = tuple(face.center);
      const normal = unit(tuple(face.normalAt(c)));
      // A curved face: its outline (which needn't be flat) is the section.
      const curved = face.geomType !== "PLANE";
      return { kind: "wire", wire, centre: tuple(wire.boundingBox.center), normal, name: "the picked face", isFace: true, ...(curved ? { curved: true, cap: face.clone() } : {}), ...(p.turn !== undefined ? { turn: p.turn } : {}) };
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
  if (override) segments = override;
  else if (surface) {
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

/** A wire's plane's normal (Newell's method over samples), and whether it lies in that plane. */
function wireNormal(w: Wire): { normal: Vec3; flat: boolean } {
  const N = 64;
  const pts = Array.from({ length: N }, (_, i) => tuple(w.pointAt(i / N)));
  let n: Vec3 = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % N];
    n = add(n, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]);
  }
  if (len(n) < 1e-9) {
    // A straight run: any plane holding it.
    const d = unit(sub(pts[N - 1], pts[0]));
    return { normal: unit(Math.abs(d[2]) < 0.9 ? cross(d, [0, 0, 1]) : cross(d, [1, 0, 0])), flat: false };
  }
  const normal = unit(n);
  const c = pts.reduce((m, q) => add(m, mul(q, 1 / N)), [0, 0, 0] as Vec3);
  const size = Math.max(1e-6, ...pts.map((q) => len(sub(q, c))));
  return { normal, flat: pts.every((q) => Math.abs(dot(sub(q, c), normal)) <= 1e-6 * size + 1e-7) };
}

/**
 * Every shape on the same plane leaves nothing to loft through (OpenCascade makes a flat part of nothing), so it's
 * refused in plain words. Only some of them on one plane (a step between two shapes on a plane, reached from another)
 * still makes a solid, as it always has, so that's left alone. `ring`: kept for callers (a ring is no different).
 */
export function samePlaneProblem(list: { name: string; n: Vec3; origin: Vec3 }[], ring: boolean): string | null {
  void ring;
  if (list.length < 2) return null;
  const a = list[0];
  if (len(a.n) < 1e-12) return null;
  const onIt = (b: { n: Vec3; origin: Vec3 }) => len(b.n) > 1e-12 && Math.abs(dot(unit(a.n), unit(b.n))) > 1 - 1e-9 && Math.abs(dot(sub(b.origin, a.origin), unit(a.n))) < 1e-6;
  if (!list.every(onIt)) return null;
  const b = list[1];
  return `${a.name === b.name ? "Two of the shapes" : list.length > 2 ? "All the shapes" : `${a.name} and ${b.name}`} lie on the same plane, so there's nothing between them to loft through. Put each shape on its own plane (an offset plane, or a Plane feature).`;
}

/** Which way a "direction" end leaves: the picked line's, edge's, face's (its normal), axis's or connector's direction. */
function dirOf(g: GeomPick, ctx: LoftContext): Vec3 {
  if (g.axis) return g.axis === "x" ? [1, 0, 0] : g.axis === "y" ? [0, 1, 0] : [0, 0, 1];
  if (g.pick) {
    const shape = ctx.part(g.pick.partId);
    if (!shape) throw new Error("The part with the loft's direction no longer exists (or comes later in the list). Pick the direction again.");
    if (g.pick.ref.kind === "face") {
      const face = ctx.face(shape, g.pick);
      try {
        // A round face: its axis, as the dialog took it; a flat one: its normal.
        if (g.dir && face.geomType !== "PLANE") return unit(g.dir);
        return unit(tuple(face.normalAt(tuple(face.center))));
      } finally {
        face.delete();
      }
    }
    const [edge] = ctx.edges(shape, [g.pick]);
    try {
      if (edge.geomType === "LINE") return unit(sub(tuple(edge.endPoint), tuple(edge.startPoint)));
      if (g.dir) return unit(g.dir);
      return unit(tuple(edge.tangentAt(0.5)));
    } finally {
      edge.delete();
    }
  }
  if (!g.dir || len(g.dir) < 1e-12) throw new Error("Pick a direction for the loft's end: a straight edge, a flat face, an axis or a mate connector.");
  return unit(g.dir);
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
  return spreadOf(shape, ctx.face(shape, pick), outward, centre);
}

/** As `faceSpread`, for a face already found (freed here). */
function spreadOf(shape: Shape3D, face: Face, outward: Vec3, centre: Vec3): { spread: number; uneven: boolean } {
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
function helpers(end: Section, next: Section, cond: LoftEnd, which: string, ctx: LoftContext): (Wire | Vec3)[] {
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
  const towardsNext = dot(sub(centreOf(next), end.centre), end.normal) >= 0 ? end.normal : mul(end.normal, -1);
  if (cond.kind === "profileTangent") {
    // Along the shape's own plane: copies a hair further on and grown (or, towards a smaller neighbour, shrunk) a lot
    // more, so the sides leave lying almost flat in the plane, flaring out (or in) before turning to the next shape.
    const grows = next.kind === "wire" ? diag(next.wire) >= diag(end.wire) : false;
    const most = diag(end.wire) / 8;
    return PROFILE_STEPS.map(([h, g]) => movedCopy(end.wire, mul(towardsNext, h * D), (grows ? 1 : -1) * Math.min(grows ? Infinity : most, g * m * D)));
  }
  if (cond.kind === "direction") {
    if (!cond.towards) throw new Error(`Pick the direction the loft leaves the ${which} shape along.`);
    let d = dirOf(cond.towards, ctx);
    if (dot(d, end.normal) < 0) d = mul(d, -1);
    if (dot(d, towardsNext) < 0) d = mul(d, -1);
    if (Math.abs(dot(d, end.normal)) < 0.05) throw new Error(`The direction picked for the ${which} lies along the shape's own plane, so the loft can't leave it that way. Pick a direction that leans out of the shape.`);
    // Moved along the direction, so many mm further on square to the shape as the usual copies are.
    const k = 1 / Math.abs(dot(d, end.normal));
    const far = Math.min(0.3, Math.max(3 * CLOSE, REACH * m));
    return [CLOSE, far].map((h) => movedCopy(end.wire, mul(d, h * D * k), 0));
  }
  let dir: Vec3;
  let spread = 0;
  if (cond.kind === "normal") {
    dir = dot(sub(centreOf(next), end.centre), end.normal) >= 0 ? end.normal : mul(end.normal, -1);
  } else if (cond.kind === "matchTangent" || cond.kind === "matchCurvature") {
    if (!end.isFace && !end.adjacent) throw new Error(`“Carry on from the faces” is for a face of a part at the ${which}. Choose “Square to the shape” for a sketch.`);
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
  if ("curve" in c) {
    // A curve feature (Helix, Fit spline…): an open one walked from the end nearest the first shape.
    const w = ctx.curve?.(c.curve, what);
    if (!w) throw new Error(`The loft's ${what} (${ctx.name(c.curve) ?? "a curve"}) can't be used here.`);
    if (near && !w.isClosed && len(sub(tuple(w.endPoint), near)) < len(sub(tuple(w.startPoint), near)) - 1e-9) {
      const r = reversedWire(w);
      w.delete();
      return r;
    }
    return w;
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

/**
 * The faces beside a guide's edges (the first edge's two faces on its part), for a guide matching tangent; throws a
 * plain message when there are none.
 */
function facesBeside(edges: TopoPick[], ctx: LoftContext, name: string): Face[] {
  const first = edges[0];
  const shape = first ? ctx.part(first.partId) : null;
  if (!shape) throw new Error(`The part with ${name}'s edges no longer exists. Edit the loft and pick them again.`);
  const [edge] = ctx.edges(shape, [first]);
  const out: Face[] = [];
  try {
    for (const f of shape.faces) {
      const mine = f.edges;
      const has = mine.some((e) => e.isSame(edge));
      mine.forEach((e) => e.delete());
      if (has && out.length < 2) out.push(f);
      else f.delete();
    }
  } finally {
    edge.delete();
  }
  if (!out.length) throw new Error(`${name[0].toUpperCase()}${name.slice(1)} isn't an edge of a face, so it can't match a face's tangent. Set its continuity to None.`);
  return out;
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

/**
 * The end sections as OpenCascade's own loft splits them to match their neighbours (a circle next to a square cut
 * into four arcs). Its splitting fails once helper copies of an end are added (they all need it at once), so the
 * ends are split first, from a plain loft through the same sections: the plain loft's edges lying on each end's
 * outline, joined. Null for an end that is a point or can't be found that way (then the wire is used as drawn).
 */
function compatibleEnds(seq: (Wire | Vec3)[], made: { delete(): void }[]): [Wire | null, Wire | null] {
  const wires = seq.filter((s): s is Wire => !Array.isArray(s));
  const counts = wires.map((w) => w.edges.length);
  if (counts.every((c) => c === counts[0])) return [null, null];
  let plain: Shape3D;
  try {
    plain = thruSections(seq, false, false, true, made);
  } catch {
    return [null, null];
  }
  made.push(plain);
  const all = plain.edges;
  const endWire = (w: Wire | Vec3): Wire | null => {
    if (Array.isArray(w)) return null;
    const tol = 1e-5 + 1e-6 * diag(w);
    const on = all.filter((e) =>
      [0.1, 0.5, 0.9].every((t) => {
        const v = makeVertex(tuple(e.pointAt(t)));
        try {
          return measureDistanceBetween(v, w) <= tol;
        } finally {
          v.delete();
        }
      }),
    );
    if (!on.length) return null;
    try {
      const out = assembleWire(on.map((e) => e.clone()));
      made.push(out);
      return out.edges.length >= w.edges.length ? out : null;
    } catch {
      return null;
    }
  };
  try {
    return [endWire(seq[0]), endWire(seq[seq.length - 1])];
  } finally {
    all.forEach((e) => e.delete());
  }
}

/** A loft's open skin closed into a solid: each end's curved face as it is, a flat one's outline filled. */
function closedWithFaces(skin: Shape3D, ends: Section[], made: { delete(): void }[]): Shape3D {
  made.push(skin);
  const pieces: Shape3D[] = [skin];
  for (const s of ends) {
    if (s.kind !== "wire") continue;
    // (A fresh copy of the face: one shared with the part confuses joining the loft to it.)
    const f = s.cap ? (s.cap.clone().translate([0, 0, 0]) as Face) : makeFace(s.wire.clone());
    made.push(f);
    pieces.push(f as unknown as Shape3D);
  }
  return encloseSurfaces(pieces);
}

/**
 * The flat face a sketch section is drawn on (Onshape's "Adjacent faces"): the sketch's own face when it was drawn on
 * one, else a flat face of a part lying in the sketch's plane under the outline's middle. Null when there is none.
 */
function faceUnder(s: Extract<Section, { kind: "wire" }>, ctx: LoftContext): { shape: Shape3D; face: Face } | null {
  const pl = s.pieces?.plane;
  const pick = pl?.kind === "face" ? pl.face : undefined;
  if (pick) {
    const shape = ctx.part(pick.partId);
    if (shape) {
      try {
        return { shape, face: ctx.face(shape, pick) };
      } catch {
        // lost: looked for below
      }
    }
  }
  // Not picked (Claude's sketches, or the face lost): a flat face lying in the sketch's plane that the whole outline is on.
  // Faces of two parts there (side by side, or overlapping) can't be told apart, so that's refused rather than guessed.
  const tol = 1e-4;
  const samples = Array.from({ length: 16 }, (_, i) => makeVertex(tuple(s.wire.pointAt(i / 16))));
  const at = makeVertex(s.centre);
  const found: { shape: Shape3D; face: Face }[] = [];
  try {
    for (const shape of ctx.allParts?.() ?? []) {
      const faces = shape.faces;
      for (const f of faces) {
        if (f.geomType !== "PLANE") continue;
        const n = unit(tuple(f.normalAt(tuple(f.center))));
        if (Math.abs(dot(n, s.normal)) < 1 - 1e-6) continue;
        if (Math.abs(dot(sub(s.centre, tuple(f.center)), n)) > tol) continue;
        if (measureDistanceBetween(at, f) > tol) continue;
        if (samples.some((q) => measureDistanceBetween(q, f) > tol)) continue;
        found.push({ shape, face: f.clone() });
      }
      faces.forEach((f) => f.delete());
    }
  } finally {
    at.delete();
    samples.forEach((q) => q.delete());
  }
  if (found.length > 1) {
    found.forEach((x) => x.face.delete());
    throw new Error(`${s.name} lies on faces of more than one part, so it isn't clear which faces round it the loft should carry on from. Draw the sketch on the face itself (click the face when starting the sketch), or choose “Square to the shape”.`);
  }
  return found[0] ?? null;
}

/** Two directions square to `n` (a plane's own x and y). */
function planeAxes(n: Vec3): { u: Vec3; v: Vec3 } {
  const u = unit(Math.abs(n[2]) < 0.9 ? cross(n, [0, 0, 1]) : cross(n, [1, 0, 0]));
  return { u, v: cross(n, u) };
}

/**
 * A guide curve, found, with the name messages use; `faces` = the part faces beside its edges when it matches tangent
 * (Onshape's guide continuity), `otherFace` = match the second one.
 */
type GuideWire = { wire: Wire; name: string; faces?: Face[]; otherFace?: boolean };

/**
 * One station of a loft with several guides (or guides with a path or connections): the unguided loft cut by the
 * plane through `at` square to `n`, then bent in that plane so the point of the outline towards each guide (seen from
 * the outline's middle) lands on the guide — two guides by the gentlest stretch and shear, three or more by a smooth
 * bend through them all (src/geometry/warp2d.ts). Null when the cut gives no single outline.
 */
function warpedStation(base: Shape3D, guides: GuideWire[], at: Vec3, n: Vec3, between: string): { wire: Wire; hits: Vec3[] } | null {
  const size = diagOf(base) * 2 + 10;
  const cut = cutBy(base, at, n, size);
  if (!Array.isArray(cut) || !cut.length) return null;
  let wire: Wire;
  try {
    wire = assembleWire(cut);
  } catch {
    return null;
  } finally {
    cut.forEach((e) => e.delete());
  }
  const { u, v } = planeAxes(n);
  const to2 = (q: Vec3): P2 => [dot(sub(q, at), u), dot(sub(q, at), v)];
  const from2 = ([x, y]: P2): Vec3 => add(at, add(mul(u, x), mul(v, y)));
  const samples = Array.from({ length: 240 }, (_, i) => tuple(wire.pointAt(i / 240)));
  const poly = samples.map(to2);
  const c = to2(tuple(wire.boundingBox.center));
  const anchors: P2[] = [];
  const targets: P2[] = [];
  const hits: Vec3[] = [];
  try {
    for (const g of guides) {
      const hit = cutBy(g.wire, at, n, size);
      const points = Array.isArray(hit) ? hit.flatMap((e) => [tuple(e.startPoint)]) : hit.vertices;
      if (Array.isArray(hit)) hit.forEach((e) => e.delete());
      if (!points.length) throw new Error(`${g.name[0].toUpperCase()}${g.name.slice(1)} must run all the way from the first shape to the last.`);
      const target = points.reduce((best, p) => (minDist(samples, p) < minDist(samples, best) ? p : best), points[0]);
      hits.push(target);
      const t2 = to2(target);
      const a2 = outermostTowards(poly, c, t2) ?? rayHit(poly, c, t2) ?? poly.reduce((b, q) => (Math.hypot(q[0] - t2[0], q[1] - t2[1]) < Math.hypot(b[0] - t2[0], b[1] - t2[1]) ? q : b), poly[0]);
      anchors.push(a2);
      targets.push(t2);
    }
    if (crossedOver(anchors, targets, c)) throw new Error(`The guide curves cross over each other ${between}. Each guide must keep to its own side of the shapes.`);
  } catch (e) {
    wire.delete();
    throw e;
  }
  // One guide: stretched along the guide's way only, from the outline's far side (which stays put), as a lone guide
  // between two parallel shapes always is (guidedStation); two or more: bent through them all.
  const warp = anchors.length === 1 ? stretchTowards(poly, c, anchors[0], targets[0]) : fitWarp(anchors, targets);
  // Guides matching tangent: the warped outline turned, near each such guide, to carry on the face beside its edges.
  let bent = (p: P2): P2 => warp.map(p);
  let affine = warp.affine;
  guides.forEach((g, k) => {
    if (!g.faces?.length) return;
    const across: P2[] = [];
    const which: number[] = [];
    g.faces.forEach((f, j) => {
      const d = awayFromFace(f, hits[k], n, size);
      if (d) {
        across.push([dot(d, u), dot(d, v)]);
        which.push(j);
      }
    });
    if (!across.length) return;
    const before = bent;
    const shaped = poly.map((p) => before(p));
    const prefer = Math.max(0, which.indexOf(g.otherFace ? 1 : 0));
    const bend = tangentBend(shaped, targets[k], across, prefer);
    if (!bend) return;
    bent = (p: P2) => bend.map(before(p));
    affine = false;
  });
  const map = (q: Vec3): Vec3 => add(from2(bent(to2(q))), mul(n, dot(sub(q, at), n)));
  const edges = wire.edges.map((e) => {
    if (affine && e.geomType === "LINE") return makeLine(map(tuple(e.startPoint)), map(tuple(e.endPoint)));
    const pts = Array.from({ length: 33 }, (_, i) => map(tuple(e.pointAt(i / 32))));
    return makeBSplineApproximation(pts, { tolerance: 1e-5, degMax: 5, degMin: 3 });
  });
  wire.delete();
  try {
    return { wire: assembleWire(edges), hits };
  } catch {
    return null;
  } finally {
    edges.forEach((e) => e.delete());
  }
}

/**
 * The way the face `f` carries on past the guide at `h`, in the station's plane (normal `n`): along the face, square to
 * the guide, away from the face. Null when the face lies across the station plane there.
 */
function awayFromFace(f: Face, h: Vec3, n: Vec3, size: number): Vec3 | null {
  let nf: Vec3;
  try {
    nf = unit(tuple(f.normalAt(h)));
  } catch {
    return null;
  }
  const line = cross(nf, n);
  if (len(line) < 1e-6) return null;
  const d = unit(line);
  const eps = Math.min(0.05, 1e-3 * size);
  const gap = (p: Vec3) => {
    const vx = makeVertex(p);
    try {
      return measureDistanceBetween(vx, f);
    } finally {
      vx.delete();
    }
  };
  return gap(add(h, mul(d, eps))) >= gap(sub(h, mul(d, eps))) ? d : mul(d, -1);
}

/**
 * The outline's point farthest out from its middle `c` towards `target` (ties — a flat side — broken by nearness to the
 * target), so the guide sets the outline's extent that way and no part of the outline is bent out past it.
 */
function outermostTowards(poly: P2[], c: P2, target: P2): P2 | null {
  const dl = Math.hypot(target[0] - c[0], target[1] - c[1]);
  if (dl < 1e-12 || !poly.length) return null;
  const along = (p: P2) => ((p[0] - c[0]) * (target[0] - c[0]) + (p[1] - c[1]) * (target[1] - c[1])) / dl;
  const most = Math.max(...poly.map(along));
  const size = Math.max(...poly.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])));
  let best: P2 | null = null;
  for (const p of poly)
    if (most - along(p) <= 1e-3 * size && (!best || Math.hypot(p[0] - target[0], p[1] - target[1]) < Math.hypot(best[0] - target[0], best[1] - target[1]))) best = p;
  return best;
}

/** The outline stretched along the way from its middle `c` to `target`, its far side kept, so `anchor` lands on `target`'s line across. */
function stretchTowards(poly: P2[], c: P2, anchor: P2, target: P2): { map: (p: P2) => P2; affine: boolean } {
  const dl = Math.hypot(target[0] - c[0], target[1] - c[1]);
  if (dl < 1e-12) return { map: (p) => p, affine: true };
  const d: P2 = [(target[0] - c[0]) / dl, (target[1] - c[1]) / dl];
  const along = (p: P2) => (p[0] - c[0]) * d[0] + (p[1] - c[1]) * d[1];
  const lo = Math.min(...poly.map(along));
  // The outline's farthest point that way goes to the guide (so nothing pokes out past it).
  const from = Math.max(along(anchor), ...poly.map(along));
  if (from - lo < 1e-9) return { map: (p) => p, affine: true };
  const k = (along(target) - lo) / (from - lo);
  return { map: (p) => { const m = (along(p) - lo) * (k - 1); return [p[0] + d[0] * m, p[1] + d[1] * m]; }, affine: true };
}

/** Where a point lies along a line of points (its distance from the first, by length, at the nearest place). */
function alongLine(line: Vec3[], q: Vec3): number {
  let best = Infinity;
  let at = 0;
  let run = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const d = sub(line[i + 1], a);
    const l = len(d);
    const t = l > 1e-12 ? Math.min(1, Math.max(0, dot(sub(q, a), d) / (l * l))) : 0;
    const gap = len(sub(q, add(a, mul(d, t))));
    if (gap < best - 1e-12) {
      best = gap;
      at = run + t * l;
    }
    run += l;
  }
  return at;
}

/** A stretch of an edge, walked from parameter share `t0` to `t1` (t1 < t0: backwards). */
type Piece = { edge: Edge; t0: number; t1: number };
const piecePoint = (pc: Piece, s: number) => tuple(pc.edge.pointAt(pc.t0 + (pc.t1 - pc.t0) * s));
const pieceLength = (pc: Piece) => {
  let l = 0;
  let q = piecePoint(pc, 0);
  for (let i = 1; i <= 16; i++) {
    const r = piecePoint(pc, i / 16);
    l += len(sub(r, q));
    q = r;
  }
  return l;
};

/** A closed wire's edges in order round it, each walked the way the wire goes (the edges are the caller's to free). */
function chainOf(wire: Wire): Piece[] {
  const left = wire.edges;
  const out: Piece[] = [];
  const first = left.shift()!;
  out.push({ edge: first, t0: 0, t1: 1 });
  let tip = tuple(first.endPoint);
  while (left.length) {
    let best = 0;
    let bestGap = Infinity;
    let forward = true;
    left.forEach((e, i) => {
      const ga = len(sub(tuple(e.startPoint), tip));
      const gb = len(sub(tuple(e.endPoint), tip));
      if (Math.min(ga, gb) < bestGap) {
        bestGap = Math.min(ga, gb);
        best = i;
        forward = ga <= gb;
      }
    });
    const [e] = left.splice(best, 1);
    out.push({ edge: e, t0: forward ? 0 : 1, t1: forward ? 1 : 0 });
    tip = tuple(forward ? e.endPoint : e.startPoint);
  }
  return out;
}

/** A piece made into an edge running the piece's way: a whole edge as it is (or turned round), else a line, an arc or a fitted curve. */
function pieceEdge(pc: Piece): Edge {
  const whole = Math.abs(Math.abs(pc.t1 - pc.t0) - 1) < 1e-12;
  if (whole) return pc.t1 > pc.t0 ? pc.edge.clone() : (cast((pc.edge.wrapped as unknown as { Reversed(): unknown }).Reversed() as never) as Edge);
  const a = piecePoint(pc, 0);
  const b = piecePoint(pc, 1);
  if (pc.edge.geomType === "LINE") return makeLine(a, b);
  if (pc.edge.geomType === "CIRCLE") return makeThreePointArc(a, piecePoint(pc, 0.5), b);
  return makeBSplineApproximation(Array.from({ length: 33 }, (_, i) => piecePoint(pc, i / 32)), { tolerance: 1e-5, degMax: 5, degMin: 3 });
}

/** Where along a chain a point lies: the piece and its share along it (refined from samples). */
function placeOnChain(chain: Piece[], q: Vec3): { piece: number; s: number; gap: number } {
  let best = { piece: 0, s: 0, gap: Infinity };
  chain.forEach((pc, i) => {
    for (let k = 0; k <= 64; k++) {
      const g = len(sub(piecePoint(pc, k / 64), q));
      if (g < best.gap) best = { piece: i, s: k / 64, gap: g };
    }
  });
  // Golden-section search round the best sample.
  const pc = chain[best.piece];
  let lo = Math.max(0, best.s - 1 / 64);
  let hi = Math.min(1, best.s + 1 / 64);
  const f = (s: number) => len(sub(piecePoint(pc, s), q));
  for (let k = 0; k < 40; k++) {
    const m1 = lo + (hi - lo) * 0.382;
    const m2 = lo + (hi - lo) * 0.618;
    if (f(m1) < f(m2)) hi = m2;
    else lo = m1;
  }
  const s = (lo + hi) / 2;
  return f(s) < best.gap ? { piece: best.piece, s, gap: f(s) } : best;
}

/** A piece split at share `s` into two. */
function splitPiece(pc: Piece, s: number): [Piece, Piece] {
  const t = pc.t0 + (pc.t1 - pc.t0) * s;
  return [
    { edge: pc.edge, t0: pc.t0, t1: t },
    { edge: pc.edge, t0: t, t1: pc.t1 },
  ];
}

/** Which way a closed wire goes round `ref` (+1 anticlockwise seen from its tip), from samples (Newell). */
function windingAbout(w: Wire, ref: Vec3): number {
  const { normal } = wireNormal(w);
  return dot(normal, ref) >= 0 ? 1 : -1;
}

/**
 * Onshape's Connections: every outline made to go the same way round, split at each connection's point on it and,
 * between each two connections, into as many pieces as the shape with the most there (its longest pieces halved), then
 * started at the first connection's point — so OpenCascade's loft (its own matching off) joins them point to point.
 */
function connectSections(sections: Section[], def: LoftDef, ctx: LoftContext, made: { delete(): void }[]): void {
  const wires = sections.filter((s): s is Extract<Section, { kind: "wire" }> => s.kind === "wire");
  const sets = (def.connections ?? []).map((c, j) => ({ j, points: c.points.map((g) => pointOf(g, ctx)) }));
  if (!sets.length || wires.length < 2) return;
  // The way along the loft at each shape (from the one before to the one after).
  const centres = sections.map(centreOf);
  const alongAt = (i: number) => unit(sub(centres[Math.min(centres.length - 1, i + 1)], centres[Math.max(0, i - 1)]));
  const plans = wires.map((s) => {
    const i = sections.indexOf(s);
    let ref = alongAt(i);
    if (Math.abs(dot(ref, s.normal)) < 0.05) ref = s.normal;
    const chain = chainOf(s.wire);
    for (const pc of chain) made.push(pc.edge);
    if (windingAbout(s.wire, ref) < 0) {
      chain.reverse();
      for (const pc of chain) [pc.t0, pc.t1] = [pc.t1, pc.t0];
    }
    const tol = Math.max(0.01, 1e-3 * diag(s.wire));
    // Each connection's point on this shape: exactly one.
    const marks = sets.map(({ j, points }) => {
      const on = points.map((q) => ({ q, at: placeOnChain(chain, q) })).filter((x) => x.at.gap <= tol);
      if (!on.length) throw new Error(`Connection ${j + 1} has no point on ${s.name}. Pick one corner of every shape for each connection.`);
      if (on.length > 1) throw new Error(`Connection ${j + 1} has ${on.length} points on ${s.name}. Pick just one corner of each shape for it.`);
      return on[0].at;
    });
    return { s, chain, marks };
  });
  // Split each chain at its marks (latest first, so the earlier places stay right).
  const cutChains = plans.map(({ s, chain, marks }) => {
    let pieces = [...chain];
    // Where each mark starts a piece: split there unless it's already a corner. Latest first, so the places of the
    // ones still to do stay right (one further back on the same piece is rescaled to what's left of it).
    const order = marks
      .map((m, j) => (m.s > 1 - 1e-6 ? { piece: (m.piece + 1) % chain.length, s: 0, j } : { piece: m.piece, s: m.s, j }))
      .sort((a, b) => b.piece - a.piece || b.s - a.s);
    const starts = new Map<number, Piece>();
    const kept = new Map<number, number>();
    for (const m of order) {
      const pc = pieces[m.piece];
      const s = m.s / (kept.get(m.piece) ?? 1);
      if (s < 1e-6) starts.set(m.j, pc);
      else {
        const [a, b] = splitPiece(pc, s);
        pieces.splice(m.piece, 1, a, b);
        kept.set(m.piece, m.s);
        starts.set(m.j, b);
      }
    }
    // Two marks on one corner (or the same piece twice) can't be told apart.
    const at = sets.map((_, j) => pieces.indexOf(starts.get(j)!));
    if (new Set(at).size !== at.length) throw new Error(`Two connections meet at the same corner of ${s.name}. Pick a different corner for one of them.`);
    // Started at connection 1.
    pieces = [...pieces.slice(at[0]), ...pieces.slice(0, at[0])];
    const idx = sets.map((_, j) => pieces.indexOf(starts.get(j)!));
    return { s, pieces, idx };
  });
  // The connections must go round every shape in the same order.
  const rank = (idx: number[]) => idx.map((_, j) => j).sort((a, b) => idx[a] - idx[b]).join(",");
  const first = rank(cutChains[0].idx);
  for (const c of cutChains.slice(1))
    if (rank(c.idx) !== first) throw new Error(`The connections cross over: they go round ${c.s.name} in a different order from ${cutChains[0].s.name}. Pick the corners so they go round each shape the same way.`);
  const sorted = cutChains[0].idx.map((_, j) => j).sort((a, b) => cutChains[0].idx[a] - cutChains[0].idx[b]);
  // Each stretch between two connections: as many pieces on every shape.
  const spans = cutChains.map((c) => sorted.map((j, k) => c.pieces.slice(c.idx[j], k + 1 < sorted.length ? c.idx[sorted[k + 1]] : c.pieces.length)));
  for (let k = 0; k < sorted.length; k++) {
    const most = Math.max(...spans.map((sp) => sp[k].length));
    for (const sp of spans) {
      while (sp[k].length < most) {
        let longest = 0;
        sp[k].forEach((pc, i) => {
          if (pieceLength(pc) > pieceLength(sp[k][longest])) longest = i;
        });
        sp[k].splice(longest, 1, ...splitPiece(sp[k][longest], 0.5));
      }
    }
  }
  cutChains.forEach((c, i) => {
    const edges = spans[i].flat().map(pieceEdge);
    let w: Wire;
    try {
      w = assembleWire(edges);
    } catch {
      throw new Error(`${c.s.name}'s outline couldn't be split at its connections.`);
    } finally {
      edges.forEach((e) => e.delete());
    }
    made.push(w);
    c.s.wire = w;
  });
}

/**
 * A wire started again at its corner nearest `near` and walked round the same way as `ref` (a station of a loft whose
 * corners are joined by hand, so it lines up with the shapes either side). The new wire is pushed to `made`.
 */
function restartNear(w: Wire, near: Vec3, ref: Vec3, made: { delete(): void }[]): Wire {
  const chain = chainOf(w);
  for (const pc of chain) made.push(pc.edge);
  if (windingAbout(w, ref) < 0) {
    chain.reverse();
    for (const pc of chain) [pc.t0, pc.t1] = [pc.t1, pc.t0];
  }
  let k = 0;
  chain.forEach((pc, i) => {
    if (len(sub(piecePoint(pc, 0), near)) < len(sub(piecePoint(chain[k], 0), near))) k = i;
  });
  const edges = [...chain.slice(k), ...chain.slice(0, k)].map(pieceEdge);
  try {
    const out = assembleWire(edges);
    made.push(out);
    return out;
  } finally {
    edges.forEach((e) => e.delete());
  }
}

/** OpenCascade's pipe shell along `path` through the wires (and end points) in order. */
function pipeLoft(path: Wire, seq: (Wire | Vec3)[], surface: boolean, made: { delete(): void }[]): Shape3D {
  const oc = getOC();
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
  } finally {
    builder.delete();
  }
}

/**
 * A loft with several guide curves, or guides along a path or with connections: the loft without the
 * guides cut across at stations between each two shapes — planes turned from one shape's to the next (along a path:
 * square to it) — each cut bent to pass through every guide, then lofted again through the shapes and the stations.
 */
function guidedLoft(opts: {
  sections: Section[];
  seq: (Wire | Vec3)[];
  guides: GuideWire[];
  path: Wire | null;
  surface: boolean;
  lined: boolean;
  made: { delete(): void }[];
}): Shape3D {
  const { sections, seq, guides, path, surface, lined, made } = opts;
  const base = path ? pipeLoft(path, seq, true, made) : thruSections(seq, false, false, !lined, made);
  made.push(base);
  const centres = sections.map(centreOf);
  // Along the path, or along the line through the shapes' middles.
  const line: Vec3[] = path ? Array.from({ length: 513 }, (_, i) => tuple(path.pointAt(i / 512))) : centres;
  const along = (q: Vec3) => alongLine(line, q);
  const stations: { at: number; wire: Wire }[] = [];
  // Where the guides were at the last station: two of them changing places on the way means they cross over.
  let lastHits: Vec3[] | null = null;
  const startOf = (s: Section): Vec3 => (s.kind === "wire" ? tuple(s.wire.startPoint) : s.at);
  for (let i = 0; i + 1 < sections.length; i++) {
    const A = sections[i];
    const B = sections[i + 1];
    const between = `between ${A.name} and ${B.name}`;
    const a = along(centres[i]);
    const b = along(centres[i + 1]);
    if (b - a < 1e-6) throw new Error("With guide curves, the shapes must follow one another along the loft (each further on than the last).");
    const dir = unit(sub(centres[i + 1], centres[i]));
    const facing = (s: Section) => (s.kind === "wire" ? (dot(s.normal, dir) >= 0 ? s.normal : mul(s.normal, -1)) : dir);
    const nA = facing(A);
    const nB = facing(B);
    for (let k = 1; k <= STATIONS; k++) {
      const t = k / (STATIONS + 1);
      let at: Vec3;
      let n: Vec3;
      if (path) {
        const d = a + (b - a) * t;
        // The path's point that far along, and its direction there.
        let run = 0;
        let j = 0;
        while (j + 1 < line.length - 1 && run + len(sub(line[j + 1], line[j])) < d) run += len(sub(line[j + 1], line[j++]));
        const seg = sub(line[j + 1], line[j]);
        at = add(line[j], mul(seg, Math.min(1, Math.max(0, (d - run) / Math.max(1e-12, len(seg))))));
        n = unit(seg);
      } else {
        at = add(centres[i], mul(sub(centres[i + 1], centres[i]), t));
        n = unit(add(mul(nA, 1 - t), mul(nB, t)));
      }
      const near = add(mul(startOf(A), 1 - t), mul(startOf(B), t));
      const got = warpedStation(base, guides, at, n, between);
      if (!got) continue;
      let w = got.wire;
      made.push(w);
      if (lastHits)
        for (let p = 0; p < guides.length; p++)
          for (let q = p + 1; q < guides.length; q++)
            if (dot(sub(got.hits[q], got.hits[p]), sub(lastHits[q], lastHits[p])) <= 0)
              throw new Error(`${guides[p].name[0].toUpperCase()}${guides[p].name.slice(1)} and ${guides[q].name} cross over each other ${between}. Each guide must keep to its own side of the shapes.`);
      lastHits = got.hits;
      if (lined) w = restartNear(w, near, n, made);
      stations.push({ at: along(at), wire: w });
    }
  }
  // Everything in order along the way: points first/last, shapes, helper copies and stations by how far along they are.
  const wiresAlong = seq.filter((x): x is Wire => !Array.isArray(x)).map((w) => ({ at: along(tuple(w.boundingBox.center)), wire: w }));
  const all = [...wiresAlong, ...stations].sort((x, y) => x.at - y.at).map((x) => x.wire as Wire | Vec3);
  if (Array.isArray(seq[0])) all.unshift(seq[0]);
  if (seq.length > 1 && Array.isArray(seq[seq.length - 1])) all.push(seq[seq.length - 1]);
  try {
    if (path) return pipeLoft(path, all, surface, made);
    const shape = thruSections(all, !surface, false, !lined, made);
    return surface ? asIs(shape) : shape;
  } catch {
    throw new Error(`Couldn't loft along ${guides.length > 1 ? "those guide curves" : "that guide curve"}${path ? " and path" : ""}. Each guide must touch every shape's outline and run from the first shape to the last.`);
  }
}

/** Builds a loft with further choices: a solid (or a surface when `surface`). `notes` gets anything worth telling. */
export function buildLoft(feature: Pick<Feature, "sections" | "loft" | "loftRuled" | "surface">, ctx: LoftContext, notes?: string[], thin?: ThinSides, override?: Overrides): Shape3D {
  if (thin && !feature.surface) return thinLoft(feature, ctx, notes, thin);
  let def: LoftDef = feature.loft ?? {};
  const profiles = loftProfiles(feature);
  const problem = profilesProblem(profiles);
  if (problem) throw new Error(problem);
  const surface = !!feature.surface;
  const ruled = !!feature.loftRuled;
  const made: { delete(): void }[] = [];
  try {
    const start: { dir?: Vec3 } = {};
    const sections = profiles.map((p, i) => sectionOf(p, ctx, surface, start, override?.get(i)));
    for (const s of sections) if (s.kind === "wire") made.push(s.wire);
    for (const s of sections) if (s.kind === "wire" && s.cap) made.push(s.cap);
    // A solid's end that isn't flat: closed with the picked face itself (edges that don't lie flat have none).
    const endSecs = [sections[0], sections[sections.length - 1]];
    const capped = !surface && endSecs.some((s) => s.kind === "wire" && s.curved);
    if (capped) {
      if (endSecs.some((s) => s.kind === "wire" && s.curved && !s.cap)) throw new Error("Part edges that don't lie flat can't close a solid loft's end. Tick Surface, or pick a face (or flat edges) for that end.");
      if (loftGuides(def).length || def.path || def.periodic) throw new Error("A curved face at the loft's end can't be used with a guide curve, a path or a closed ring. Put a flat shape at that end.");
      // OpenCascade can't join a solid to a part along a curved face they share exactly.
      const op = (feature as Partial<Feature>).operation;
      if (op && op !== "new") throw new Error("A solid loft from a curved face can only be a new part (it can't yet be joined to or cut from parts along that face). Choose New, or tick Surface.");
    }
    // Every flat shape on the same plane: nothing to loft through (along a path they may well share one: a U-shaped
    // handle's two ends).
    const flat = def.path ? null : samePlaneProblem(
      sections.map((s) => (s.kind === "wire" && !s.curved ? { name: s.name, n: s.normal, origin: s.centre } : { name: s.name, n: [0, 0, 0] as Vec3, origin: centreOf(s) })),
      !!def.periodic,
    );
    if (flat) throw new Error(flat);
    // Curved sections (a curved face, edges not in one plane) have no plane to be square or tangent to: their end
    // conditions are left out, with a note.
    for (const [which, i] of [["start", 0], ["end", sections.length - 1]] as const) {
      const sec = sections[i];
      if (def[which] && sec.kind === "wire" && sec.curved) {
        notes?.push(`The ${which} shape isn't flat, so it can't be shaped there: the loft leaves it as it comes.`);
        def = { ...def, [which]: undefined };
      }
    }
    if (ruled && (def.start || def.end)) throw new Error("“Straight between shapes” has straight sides, so its ends can't be shaped. Untick it, or leave the start and end free.");
    if (def.matchCorners) {
      if (def.connections?.length) throw new Error("Choose either “Line up the corners myself” or Connections, not both.");
      lineUpCorners(sections);
      made.length = 0;
      for (const s of sections) if (s.kind === "wire") made.push(s.wire);
    }
    // Onshape's Connections: the corners picked on each shape join, whatever their numbers of sides.
    if (def.connections?.length) connectSections(sections, def, ctx, made);
    const lined = !!def.matchCorners || !!def.connections?.length;
    const guideCurves = loftGuides(def);
    // Along a path, every outline starts where the first one's start is carried to (else the pipe twists between them).
    const pathW = def.path ? curveWire(def.path, ctx, "path", centreOf(sections[0])) : null;
    if (pathW) {
      made.push(pathW);
      offPath(sections, pathW);
      if (!lined) for (const w of alignAlongPath(sections, pathW)) made.push(w);
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
      } else if (wantsSpread(cond) && s.kind === "wire" && "sketch" in p && !s.curved) {
        // A sketch drawn on a part's face (Onshape's "Adjacent faces"): the faces round that face set the slope.
        const under = faceUnder(s, ctx);
        if (!under) throw new Error(`“Carry on from the faces” needs ${s.name} to be drawn on a flat face of a part (the faces round that face set the slope). Choose “Square to the shape”, or draw the sketch on the face.`);
        const out = unit(tuple(under.face.normalAt(tuple(under.face.center))));
        s.normal = dot(s.normal, out) >= 0 ? s.normal : mul(s.normal, -1);
        s.adjacent = true;
        const { spread, uneven } = spreadOf(under.shape, under.face, s.normal, s.centre);
        s.spread = spread;
        if (uneven) notes?.push(`The faces round the face ${s.name} is drawn on slope by different amounts, so the loft carries on from them only roughly.`);
      }
    }
    const periodic = !!def.periodic;
    const guided = guideCurves.length > 0 || !!def.path;
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
      if ((cond.kind === "matchTangent" || cond.kind === "matchCurvature") && !(sec.kind === "wire" && (sec.isFace || sec.adjacent)))
        throw new Error(`“Carry on from the faces” is for a face of a part at the ${which}. Choose “Square to the shape” for a sketch.`);
      // From a part's face back into the part, a shaped end would run along the part's own sides (nothing sensible to
      // cut or add), so it's refused plainly.
      const nb = sections[i === 0 ? 1 : sections.length - 2];
      if (sec.kind === "wire" && (sec.isFace || sec.adjacent) && nb && dot(sub(centreOf(nb), sec.centre), sec.normal) < 0)
        throw new Error(`The loft goes from the picked face into its part, so its ${which} can't be shaped there (it would run along the part's own sides). Leave the ${which} free, or draw the outline in a sketch on the face, a little inside its edges.`);
    }
    // End conditions between two parallel shapes (no guide, path or hand-lined corners): eased cuts of the plain loft.
    const easable = (i: number, j: number, cond: LoftEnd | undefined) => {
      const x = sections[i];
      const y = sections[j];
      return !!cond && (cond.kind === "normal" || cond.kind === "matchTangent" || cond.kind === "matchCurvature") && !guideCurves.length && !def.path && !lined && !ruled && x?.kind === "wire" && y?.kind === "wire" && Math.abs(dot(x.normal, y.normal)) > 0.9999 && Math.abs(dot(unit(sub(y.centre, x.centre)), x.normal)) > 0.05;
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
    // Helper copies of a shaped end go in, then the loft is made (`finish`). Ends with as many pieces as all the others
    // are used as drawn, exactly as before; when that fails and the outlines differ, the ends are split first as a
    // plain loft splits them and it's tried again (OpenCascade's own splitting gives up once helpers are added).
    const shapedEnds = sections.length >= 2 && ((def.end && !easeEnd) || (def.start && !easeStart));
    const before = [...seq];
    const finish = (): Shape3D => {
      if (sections.length >= 2) {
        if (def.end && !easeEnd) {
          const h = helpers(sections[sections.length - 1], sections[sections.length - 2], def.end, "end", ctx);
          for (const w of h) if (!Array.isArray(w)) made.push(w);
          seq.splice(seq.length - 1, 0, ...[...h].reverse());
        }
        if (def.start && !easeStart) {
          const h = helpers(sections[0], sections[1], def.start, "start", ctx);
          for (const w of h) if (!Array.isArray(w)) made.push(w);
          seq.splice(1, 0, ...h);
        }
      }
      // Several guides, guides along a path or guides with connections: stations bent to every guide. One guide alone
      // (parallel shapes or not) keeps the older way below exactly, so lofts made before build just as they did.
      const matching = guideCurves.some((c) => "edges" in c && c.continuity === "matchTangent");
      if (guideCurves.length && (guideCurves.length > 1 || def.path || def.connections?.length || matching)) {
        const many = guideCurves.length > 1;
        const guides: GuideWire[] = guideCurves.map((c, i) => {
          const name = many ? `guide curve ${i + 1}` : "the guide curve";
          const wire = curveWire(c, ctx, many ? `guide curve ${i + 1}` : "guide curve", centreOf(sections[0]));
          made.push(wire);
          if (!("edges" in c) || c.continuity !== "matchTangent") return { wire, name };
          const faces = facesBeside(c.edges, ctx, name);
          made.push(...faces);
          return { wire, name, faces, ...(c.otherFace ? { otherFace: true } : {}) };
        });
        for (const g of guides)
          for (const x of sections) if (x.kind === "wire" && !touches(x.wire, g.wire)) throw new Error(`${g.name[0].toUpperCase()}${g.name.slice(1)} must touch the outline of every shape, but it misses ${x.name}.`);
        return guidedLoft({ sections, seq, guides, path: pathW, surface, lined, made });
      }
      if (def.guide && def.path) throw new Error("A loft can follow a guide curve or a path, not both. Take one of them out.");
      if (def.guide) {
        const guide = curveWire(def.guide, ctx, "guide curve", centreOf(sections[0]));
        made.push(guide);
        for (const s of sections) if (s.kind === "wire" && !touches(s.wire, guide)) throw new Error(`The guide curve must touch the outline of every shape, but it misses ${s.name}.`);
        // The loft without the guide, cut across at stations between the sections; each cut outline is then scaled about
        // its middle until it reaches the guide, and the loft is made again through the sections and those outlines.
        const base = thruSections(seq, false, false, !lined, made);
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
        try {
          return pipeLoft(pathW!, seq, surface, made);
        } catch {
          throw new Error("Couldn't loft along that path. Draw the shapes across the path (each standing square to it, near where it passes).");
        }
      }
      // A ring: back to the very same first outline, which OpenCascade joins up smoothly.
      const ring = periodic ? [...seq, seq[0]] : seq;
      try {
        if (capped) return closedWithFaces(thruSections(ring, false, ruled, !lined, made), endSecs, made);
        const shape = thruSections(ring, !surface, ruled, !lined, made);
        return surface ? asIs(shape) : shape;
      } catch {
        const shaped = [def.start && `how it leaves the first shape (${END_LABELS[def.start.kind]})`, def.end && `how it reaches the last shape (${END_LABELS[def.end.kind]})`].filter(Boolean);
        throw new Error(
          def.matchCorners
            ? "Couldn't loft with the corners lined up that way. Try another turn for one of the shapes."
            : def.connections?.length
              ? "Couldn't loft with those connections. Try other corners, or fewer connections."
            : shaped.length
              ? `Couldn't shape the loft's ends that way: ${shaped.join(" and ")}. Try a smaller “How far it reaches”, or leave that end free.`
              : "Couldn't loft between those shapes. Try outlines with the same number of sides, or add a shape between them.",
        );
      }
    };
    try {
      return finish();
    } catch (e) {
      if (!shapedEnds) throw e;
      const [a, b] = compatibleEnds(before, made);
      if (!a && !b) throw e;
      seq.length = 0;
      seq.push(...before);
      const swap = (i: number, w: Wire | null) => {
        const s = sections[i];
        if (!w || s.kind !== "wire") return;
        if (seq[i === 0 ? 0 : seq.length - 1] === s.wire) seq[i === 0 ? 0 : seq.length - 1] = w;
        s.wire = w;
      };
      swap(0, a);
      swap(sections.length - 1, b);
      return finish();
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

/**
 * Thin (Onshape's): each sketch shape's wall ring (src/sketch/thin.ts, as a thin extrude makes it — the first side
 * into the shape) gives an outer and an inner outline; the two are lofted with the same settings and the inner taken
 * from the outer, leaving a hollow wall open at both ends.
 */
function thinLoft(feature: Pick<Feature, "sections" | "loft" | "loftRuled" | "surface">, ctx: LoftContext, notes: string[] | undefined, thin: ThinSides): Shape3D {
  const def = feature.loft ?? {};
  const profiles = loftProfiles(feature);
  const problem = profilesProblem(profiles);
  if (problem) throw new Error(problem);
  if (loftGuides(def).length) throw new Error("A thin loft can't follow a guide curve (the inside of the wall wouldn't touch it). Take the guide out, or untick Thin.");
  const outer: Overrides = new Map();
  const inner: Overrides = new Map();
  profiles.forEach((p, i) => {
    if ("point" in p) throw new Error("A thin loft can't come to a point: its wall would have nothing to go round there. Take the point out, or untick Thin.");
    if (!("sketch" in p)) throw new Error("A thin loft goes through sketch shapes only. Draw the face's outline in a sketch on it, or untick Thin.");
    const sk = ctx.sketch(p.sketch);
    // A sketch that can't be used: the usual message, from the ordinary loft.
    if (!sk) return;
    let rings;
    try {
      rings = thinSketches(sk.data, thin, { areas: p.areas, verb: "loft through" }).flatMap((d) => findRegions(d).regions);
    } catch (e) {
      throw new Error(`${sk.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (rings.length !== 1 || rings[0].holes.length !== 1)
      throw new Error(`${sk.name} needs exactly one closed shape (and no loose lines) for a thin loft — it makes ${rings.length} walls. Pick one of its areas.`);
    outer.set(i, rings[0].outer.segments);
    inner.set(i, rings[0].holes[0].segments);
  });
  const plain = { ...feature, thin: undefined };
  const a = buildLoft(plain, ctx, notes, undefined, outer);
  let b: Shape3D;
  try {
    b = buildLoft(plain, ctx, [], undefined, inner);
  } catch (e) {
    a.delete();
    throw e;
  }
  try {
    return a.cut(b);
  } finally {
    a.delete();
    b.delete();
  }
}
