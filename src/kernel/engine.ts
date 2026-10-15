/**
 * The geometry engine: turns the feature list into solid parts using
 * OpenCascade (through replicad). Runs inside the Web Worker, and directly in
 * Node for the automated tests.
 */
import { basicFaceExtrusion, makePolygon, Vector, getOC, makeCompound, makeProjectedEdges, ProjectionCamera, makeBox, measureArea, measureDistanceBetween, measureLength, makeCylinder, makeVertex, makeSphere, measureVolume, type Edge, type Face, type Shape3D } from "replicad";

import { analyzeMesh, estimateThickness, withoutDegenerateTriangles } from "../geometry/meshCheck";
import { writeBinaryStl } from "../geometry/stl";
import { matchRefs, relativeTo, roundVec, type EdgeRef, type FaceRef, type TopoPick, type Vec3 } from "../geometry/topoRef";
import { FEATURE_DEFS, isPatternFeature, isPickFeature, isSolidFeature, resolveParams } from "../model/features";
import { planeFrame, toWorld } from "../sketch/planes";
import { planeFeatureFrame } from "../sketch/planeFeature";
import { setCurrentScope } from "../model/expr";
import { MESH_TOLERANCES, type Axis, type Feature, type MeshQuality, type Operation } from "../model/types";
import { deleteFaces, draftFaces, extrudeSketch } from "./extrude";
import { revolveSketch } from "./revolve";
import { holeTool } from "./hole";
import { loftSketches, sweepSketch } from "./sweep";
import { textSolid, wrappedTextSolid, wrapStart, type Cylinder } from "./textSolid";
import { grooveVolume, threadPieces } from "./thread";
import { fastenerSolid } from "./fastener";
import { coilSolid } from "./thread";
import { fastenerName, fastenerSize } from "../model/fasteners";
import type { CheckResult, ExportResult, InstanceInput, PartMesh, RebuildResult, StepResult, StudioInput, ThreeMfResult, ViewProjection } from "./protocol";
import { VIEW_CAMERAS } from "../drawing/cameras";
import { fromRel, sectionGeometry, type SectionRequest } from "../drawing/sections";
import { dropCoveredHidden } from "../drawing/hidden";
import type { ViewKind } from "../model/types";
import { write3mf } from "../geometry/threeMf";
import { DEFAULT_PART_COLOUR } from "../model/colours";
import { writeStep } from "./stepExport";
import { importKey, importSolids } from "./importer";
import { edgesOf, facesOf, solidsOf } from "./topology";
import { angleBetween, centreGap, circleThrough3D, describePick, type MeasuredItem, type Measurement } from "../geometry/measureMath";

/** Id of the first Part Studio (matches MAIN_STUDIO in model/studios.ts). */
const MAIN_STUDIO_ID = "main";

interface BuiltPart {
  id: string;
  name: string;
  featureIds: string[];
  shape: Shape3D;
  /** For a part straight from an imported file: identifies its display mesh, which is kept between rebuilds while the part is unchanged. */
  meshKey?: string;
}

/** Display meshes of unchanged imported parts (they can take seconds to make). */
const importedMeshes = new Map<string, PartMesh>();
const IMPORTED_MESH_CACHE = 8;

/** Turn whatever OpenCascade threw into a readable sentence. */
export function describeError(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  // OpenCascade C++ exceptions arrive as WebAssembly exceptions; ask the
  // engine for the original message where it can give one.
  try {
    const WasmException = (globalThis as { WebAssembly?: { Exception?: new (...a: never[]) => unknown } })
      .WebAssembly?.Exception;
    if (WasmException && e instanceof WasmException) {
      type WasmEx = Parameters<ReturnType<typeof getOC>["getExceptionMessage"]>[0];
      const [type, message] = getOC().getExceptionMessage(e as WasmEx);
      if (message || type) return `${fallback} (${[type, message].filter(Boolean).join(": ")})`;
    }
  } catch {
    // fall through to the generic message
  }
  return fallback;
}

/** Read a replicad vector into a plain array, freeing the OpenCascade object. */
function take(v: Vector): Vec3 {
  const r: Vec3 = [v.x, v.y, v.z];
  v.delete();
  return r;
}

type Bounds = [Vec3, Vec3];

export function edgeRefOf(e: Edge, bounds: Bounds): EdgeRef {
  const mid = take(e.pointAt(0.5));
  return {
    kind: "edge",
    curve: e.geomType,
    a: roundVec(take(e.startPoint)),
    b: roundVec(take(e.endPoint)),
    mid: roundVec(mid),
    rel: relativeTo(mid, bounds[0], bounds[1]),
  };
}

export function faceRefOf(f: Face, bounds: Bounds): FaceRef {
  const center = take(f.center);
  let normal: Vec3 = [0, 0, 0];
  try {
    normal = take(f.normalAt(center));
  } catch {
    // some surfaces have no normal at their centre of mass; direction is then ignored
  }
  return { kind: "face", surface: f.geomType, center: roundVec(center), normal: roundVec(normal), rel: relativeTo(center, bounds[0], bounds[1]) };
}

function boundsOf(shape: Shape3D): Bounds {
  const box = shape.boundingBox;
  const b = box.bounds as Bounds;
  box.delete();
  return b;
}

/**
 * The middle lines of round faces (holes, pins, bosses): for each cylinder
 * face with round edges at two different places along it, the line between
 * their centres. Rounded edges (fillets) are skipped: their edges are only
 * part-circles less than half way round.
 */
function cylinderAxes(shape: Shape3D): [Vec3, Vec3][] {
  const out: [Vec3, Vec3][] = [];
  for (const face of facesOf(shape)) {
    try {
      if (face.geomType !== "CYLINDRE") continue;
      const centres: Vec3[] = [];
      for (const e of edgesOf(face)) {
        try {
          if (e.geomType !== "CIRCLE") continue;
          const c = circleThrough3D(take(e.pointAt(0)), take(e.pointAt(1 / 3)), take(e.pointAt(2 / 3)));
          if (c && measureLength(e) >= 0.99 * Math.PI * c.radius) centres.push(c.centre);
        } finally {
          e.delete();
        }
      }
      let best: [Vec3, Vec3] | null = null;
      let bestD = 1e-6;
      for (let i = 0; i < centres.length; i++) {
        for (let j = i + 1; j < centres.length; j++) {
          const d = Math.hypot(centres[i][0] - centres[j][0], centres[i][1] - centres[j][1], centres[i][2] - centres[j][2]);
          if (d > bestD) {
            bestD = d;
            best = [centres[i], centres[j]];
          }
        }
      }
      if (best) out.push(best);
    } finally {
      face.delete();
    }
  }
  return out;
}

const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Cut a thread groove into `start` from `from` to `to` along the cylinder's
 * axis (the face itself runs from `lo` to `hi`). Two turns at a time; a piece
 * that cuts the wrong amount (or leaves the part broken) is tried again a
 * turn at a time. Returns the new shape (`start` is left as it is).
 */
function cutThread(start: Shape3D, cyl: Cylinder, from: number, to: number, lo: number, hi: number, pitch: number, external: boolean): Shape3D {
  let shape = start;
  const cutPiece = (pieces: { shape: Shape3D; from: number; to: number }[], retry: boolean) => {
    for (const piece of pieces) {
      try {
        const before = measureVolume(shape);
        const next: Shape3D = shape.cut(piece.shape);
        const removed = before - measureVolume(next);
        const expected = grooveVolume(cyl, pitch, external, piece.from, piece.to, lo, hi);
        const ok = isValidSolid(next) && (expected < 1e-6 || (removed > 0.5 * expected && removed < 1.6 * expected));
        if (!ok) {
          next.delete();
          if (retry) cutPiece(threadPieces(cyl, piece.from, piece.to, pitch, external, 1), false);
          else throw new Error("The thread couldn't be cut cleanly here — try a slightly different pitch or length.");
          continue;
        }
        if (shape !== start) shape.delete();
        shape = next;
      } finally {
        piece.shape.delete();
      }
    }
  };
  try {
    cutPiece(threadPieces(cyl, from, to, pitch, external), true);
  } catch (e) {
    if (shape !== start) shape.delete();
    throw e;
  }
  return shape;
}

/**
 * Edges that only one face uses — the seam down the side of a cylinder, cone
 * or sphere, where the surface meets itself. Onshape doesn't show those (they
 * aren't real edges of the shape), and clicking one would get in the way of
 * picking the round face.
 */
export function seamEdgeIds(shape: Shape3D): Set<number> {
  const faceCount = new Map<number, number>();
  for (const f of facesOf(shape)) {
    try {
      const mine = new Set<number>();
      for (const e of edgesOf(f)) {
        mine.add(e.hashCode);
        e.delete();
      }
      for (const h of mine) faceCount.set(h, (faceCount.get(h) ?? 0) + 1);
    } finally {
      f.delete();
    }
  }
  return new Set([...faceCount].filter(([, n]) => n === 1).map(([h]) => h));
}

/** A part's edge lines without its seams (see seamEdgeIds). */
function withoutSeams(shape: Shape3D, edges: { lines: number[]; edgeGroups: { start: number; count: number; edgeId: number }[] }) {
  const seams = seamEdgeIds(shape);
  if (!seams.size) return edges;
  const lines: number[] = [];
  const edgeGroups: { start: number; count: number; edgeId: number }[] = [];
  for (const g of edges.edgeGroups) {
    if (seams.has(g.edgeId)) continue;
    const start = lines.length / 3;
    for (let i = g.start * 3; i < (g.start + g.count) * 3; i++) lines.push(edges.lines[i]);
    edgeGroups.push({ start, count: g.count, edgeId: g.edgeId });
  }
  return { ...edges, lines, edgeGroups };
}

/** A round face's cylinder, worked out from one of its round edges (null if it has none). */
function cylinderOfFace(face: Face): Cylinder | null {
  if (face.geomType !== "CYLINDRE") return null;
  const edges = edgesOf(face);
  try {
    for (const e of edges) {
      if (e.geomType !== "CIRCLE") continue;
      const p0 = take(e.pointAt(0));
      const p1 = take(e.pointAt(1 / 3));
      const p2 = take(e.pointAt(2 / 3));
      const c = circleThrough3D(p0, p1, p2);
      const n = cross3([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]]);
      const l = Math.hypot(...n);
      if (c && l > 1e-12) return { origin: c.centre, axis: [n[0] / l, n[1] / l, n[2] / l], radius: c.radius };
    }
  } finally {
    edges.forEach((e) => e.delete());
  }
  return null;
}
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A drilled hole found in a part: where it starts, which way it goes in, and its sizes (for hole callouts). */
export interface FoundHole {
  /** Centre of the opening, and the direction into the part (unit). */
  entry: Vec3;
  into: Vec3;
  diameter: number;
  through: boolean;
  /** Blind holes: from the opening to the bottom. */
  depth: number;
  cbore?: { diameter: number; depth: number };
  csk?: { diameter: number; angle: number };
}

/** One round face along an axis: from height lo to hi, its radius at each end (equal for a cylinder). */
interface RoundBit {
  kind: "cyl" | "cone";
  origin: Vec3;
  axis: Vec3;
  lo: number;
  hi: number;
  rLo: number;
  rHi: number;
  inside: boolean;
}

/** The round (cylinder and cone) faces of a shape, each as heights and radii along its axis. */
function roundBits(shape: Shape3D): RoundBit[] {
  const out: RoundBit[] = [];
  for (const face of facesOf(shape)) {
    try {
      const type = face.geomType;
      if (type !== "CYLINDRE" && type !== "CONE") continue;
      // Its round edges: centres and radii (only those going at least half way round count).
      const circles: { centre: Vec3; radius: number; normal: Vec3 }[] = [];
      const ends: Vec3[] = [];
      for (const e of edgesOf(face)) {
        try {
          const p0 = take(e.pointAt(0));
          const p1 = take(e.pointAt(1 / 3));
          const p2 = take(e.pointAt(2 / 3));
          ends.push(p0, take(e.pointAt(1)));
          if (e.geomType !== "CIRCLE") continue;
          const c = circleThrough3D(p0, p1, p2);
          const n = cross3([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]]);
          const l = Math.hypot(...n);
          if (c && l > 1e-12 && measureLength(e) >= 0.99 * Math.PI * c.radius) circles.push({ ...c, normal: [n[0] / l, n[1] / l, n[2] / l] });
        } finally {
          e.delete();
        }
      }
      if (!circles.length) continue;
      let axis = circles[0].normal;
      // One way round for every axis, so matching ones compare equal.
      const big = [0, 1, 2].reduce((a, b) => (Math.abs(axis[b]) > Math.abs(axis[a]) ? b : a), 0);
      if (axis[big] < 0) axis = [-axis[0], -axis[1], -axis[2]];
      const origin = circles[0].centre;
      const h = (p: Vec3) => dot3([p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]], axis);
      let lo: number;
      let hi: number;
      let rLo: number;
      let rHi: number;
      if (type === "CYLINDRE") {
        const hs = ends.map(h);
        lo = Math.min(...hs);
        hi = Math.max(...hs);
        rLo = rHi = circles[0].radius;
      } else {
        // A cone: between two circles, or a circle and a point.
        const placed = circles.map((c) => ({ t: h(c.centre), r: c.radius }));
        const tips = ends.map(h);
        const a = placed[0];
        const b = placed.length > 1 ? placed.reduce((m, c) => (Math.abs(c.t - a.t) > Math.abs(m.t - a.t) ? c : m), placed[0]) : { t: tips.reduce((m, t) => (Math.abs(t - a.t) > Math.abs(m - a.t) ? t : m), a.t), r: 0 };
        if (Math.abs(b.t - a.t) < 1e-6) continue;
        [lo, rLo, hi, rHi] = a.t < b.t ? [a.t, a.r, b.t, b.r] : [b.t, b.r, a.t, a.r];
      }
      // Inside a hole the face points towards the axis.
      let inside = false;
      try {
        const mid = (lo + hi) / 2;
        const r = (rLo + rHi) / 2;
        const side: Vec3 = Math.abs(axis[2]) < 0.9 ? cross3(axis, [0, 0, 1]) : cross3(axis, [1, 0, 0]);
        const sl = Math.hypot(...side);
        const radial: Vec3 = [side[0] / sl, side[1] / sl, side[2] / sl];
        // A point on the face itself (it may not go all the way round): the middle of one of its circles, pushed out.
        const c0 = circles[0];
        const toEdge = take(face.center);
        const off: Vec3 = [toEdge[0] - origin[0] - axis[0] * h(toEdge), toEdge[1] - origin[1] - axis[1] * h(toEdge), toEdge[2] - origin[2] - axis[2] * h(toEdge)];
        const ol = Math.hypot(...off);
        const dir: Vec3 = ol > 1e-6 * c0.radius ? [off[0] / ol, off[1] / ol, off[2] / ol] : radial;
        const on: Vec3 = [origin[0] + axis[0] * mid + dir[0] * r, origin[1] + axis[1] * mid + dir[1] * r, origin[2] + axis[2] * mid + dir[2] * r];
        inside = dot3(take(face.normalAt(on)), dir) < 0;
      } catch {
        inside = false;
      }
      out.push({ kind: type === "CYLINDRE" ? "cyl" : "cone", origin, axis, lo, hi, rLo, rHi, inside });
    } finally {
      face.delete();
    }
  }
  return out;
}

/**
 * Drilled holes in a shape: each run of round faces inside the part along one
 * axis — the narrowest cylinder is the hole, a wider cylinder at one end a
 * counterbore and a cone a countersink. A hole is through when there's no
 * material just past either end.
 */
export function findHoles(shape: Shape3D): FoundHole[] {
  const bits = roundBits(shape).filter((b) => b.inside);
  // Group the bits that share an axis line.
  const groups: { bits: RoundBit[] }[] = [];
  const foot = (b: RoundBit): Vec3 => {
    const t = dot3(b.origin, b.axis);
    return [b.origin[0] - b.axis[0] * t, b.origin[1] - b.axis[1] * t, b.origin[2] - b.axis[2] * t];
  };
  for (const b of bits) {
    const f = foot(b);
    const g = groups.find((x) => {
      const o = x.bits[0];
      if (dot3(o.axis, b.axis) < 1 - 1e-7) return false;
      const fo = foot(o);
      return Math.hypot(f[0] - fo[0], f[1] - fo[1], f[2] - fo[2]) < 1e-4;
    });
    // Heights measured from the group's own origin.
    if (g) {
      const base = g.bits[0];
      const shift = dot3([b.origin[0] - base.origin[0], b.origin[1] - base.origin[1], b.origin[2] - base.origin[2]], base.axis);
      g.bits.push({ ...b, origin: base.origin, lo: b.lo + shift, hi: b.hi + shift });
    } else groups.push({ bits: [b] });
  }
  const out: FoundHole[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
  for (const g of groups) {
    const cyls = g.bits.filter((b) => b.kind === "cyl");
    if (!cyls.length) continue;
    const r = Math.min(...cyls.map((c) => c.rLo));
    // The hole: the narrowest cylinder (its pieces joined up).
    const pieces = cyls.filter((c) => near(c.rLo, r));
    let lo = Math.min(...pieces.map((c) => c.lo));
    let hi = Math.max(...pieces.map((c) => c.hi));
    const holeLo = lo;
    const holeHi = hi;
    // Wider bits joined on to its ends: counterbore and countersink.
    const extras: RoundBit[] = [];
    let grew = true;
    while (grew) {
      grew = false;
      for (const b of g.bits) {
        if (pieces.includes(b) || extras.includes(b) || Math.max(b.rLo, b.rHi) <= r + 1e-6) continue;
        if (near(b.hi, lo) || near(b.lo, hi) || (b.lo > lo - 1e-4 && b.hi < hi + 1e-4)) {
          extras.push(b);
          lo = Math.min(lo, b.lo);
          hi = Math.max(hi, b.hi);
          grew = true;
        }
      }
    }
    const { origin, axis } = g.bits[0];
    const at = (t: number): Vec3 => [origin[0] + axis[0] * t, origin[1] + axis[1] * t, origin[2] + axis[2] * t];
    // Is there material just past this end? (A blind hole's bottom, or the tip of the drill.)
    const step = Math.min(0.5, r * 0.5);
    const open = (t: number, out: number) => {
      const v = makeVertex(at(t + out * step));
      try {
        return measureDistanceBetween(shape, v) > step * 1.05;
      } catch {
        return false;
      } finally {
        v.delete();
      }
    };
    const openHi = open(hi, 1);
    const openLo = open(lo, -1);
    if (!openHi && !openLo) continue; // a closed-off space, not a hole
    const mid = (holeLo + holeHi) / 2;
    const wideAtHi = extras.some((b) => (b.lo + b.hi) / 2 > mid);
    const wideAtLo = extras.some((b) => (b.lo + b.hi) / 2 < mid);
    const fromHi = wideAtHi || (!wideAtLo && openHi);
    const into: Vec3 = fromHi ? [-axis[0], -axis[1], -axis[2]] : axis;
    const cbores = extras.filter((b) => b.kind === "cyl").sort((a, b) => b.rLo - a.rLo);
    const cone = extras.find((b) => b.kind === "cone");
    const hole: FoundHole = {
      entry: at(fromHi ? hi : lo),
      into,
      diameter: 2 * r,
      through: openHi && openLo,
      depth: hi - lo,
    };
    if (cbores.length) hole.cbore = { diameter: 2 * cbores[0].rLo, depth: cbores[0].hi - cbores[0].lo };
    if (cone) {
      const rMax = Math.max(cone.rLo, cone.rHi);
      const rMin = Math.min(cone.rLo, cone.rHi);
      hole.csk = { diameter: 2 * rMax, angle: (2 * Math.atan2(rMax - rMin, cone.hi - cone.lo) * 180) / Math.PI };
    }
    out.push(hole);
  }
  return out;
}

/**
 * One drawing view: the shape seen along `toward`, with the lines hidden
 * behind it (when asked), its circles for dimensions, and the centre lines of
 * round faces seen from the side (`axes`, in 3D).
 */
function projectView(shape: Shape3D, kind: string, toward: Vec3, right: Vec3, withHidden: boolean, axes: [Vec3, Vec3][]): ViewProjection {
  const up = cross3(toward, right);
  const flat = (p: Vec3): [number, number] => [dot3(p, right), dot3(p, up)];
  const camera = new ProjectionCamera([0, 0, 0], toward, right);
  try {
    const { visible, hidden } = makeProjectedEdges(shape, camera, withHidden);
    const out: ViewProjection = { kind, visible: [], hidden: [], circles: [], points: [], bounds: null };
    let lo = [Infinity, Infinity];
    let hi = [-Infinity, -Infinity];
    const addEdge = (e: Edge, isHidden: boolean) => {
      const type = e.geomType;
      let length = 0;
      try {
        length = measureLength(e);
      } catch {
        length = 0;
      }
      const steps = type === "LINE" ? 1 : Math.max(12, Math.min(240, Math.ceil(length / 0.4)));
      const line: number[] = [];
      for (let i = 0; i <= steps; i++) {
        const [x, y] = take(e.pointAt(i / steps));
        line.push(x, y);
        if (!isHidden) {
          lo = [Math.min(lo[0], x), Math.min(lo[1], y)];
          hi = [Math.max(hi[0], x), Math.max(hi[1], y)];
        }
      }
      (isHidden ? out.hidden : out.visible).push(line);
      const n = line.length;
      out.points.push(line[0], line[1], line[n - 2], line[n - 1]);
      if (type === "CIRCLE" && steps >= 3) {
        const a: Vec3 = [line[0], line[1], 0];
        const b: Vec3 = [line[2 * Math.floor(steps / 3)], line[2 * Math.floor(steps / 3) + 1], 0];
        const c: Vec3 = [line[2 * Math.floor((2 * steps) / 3)], line[2 * Math.floor((2 * steps) / 3) + 1], 0];
        const circle = circleThrough3D(a, b, c);
        if (circle) {
          const full = Math.hypot(line[0] - line[n - 2], line[1] - line[n - 1]) < 1e-6;
          out.circles.push({ cx: circle.centre[0], cy: circle.centre[1], r: circle.radius, hidden: isHidden, full });
        }
      }
    };
    visible.forEach((e) => {
      addEdge(e, false);
      e.delete();
    });
    hidden.forEach((e) => {
      addEdge(e, true);
      e.delete();
    });
    if (lo[0] <= hi[0]) out.bounds = [lo[0], lo[1], hi[0], hi[1]];
    // Hidden lines straight behind visible ones only clutter the drawing.
    out.hidden = dropCoveredHidden(out.visible, out.hidden);
    const sideOn = axes.filter(([a, b]) => {
      const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const l = Math.hypot(d[0], d[1], d[2]);
      return l > 1e-9 && Math.abs(dot3(d, toward) / l) < 1e-3;
    });
    if (sideOn.length) out.axes = sideOn.map(([a, b]) => [...flat(a), ...flat(b)]);
    return out;
  } finally {
    camera.delete();
  }
}

/**
 * A huge box filling everything on the `normal` side of the plane through
 * `origin` (around the shape) — cut with it to keep the other side.
 */
function halfSpace(shape: Shape3D, origin: Vec3, normal: Vec3): Shape3D {
  const [lo, hi] = boundsOf(shape);
  const mid: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const nl = Math.hypot(...normal) || 1;
  const n: Vec3 = [normal[0] / nl, normal[1] / nl, normal[2] / nl];
  const off = dot3([mid[0] - origin[0], mid[1] - origin[1], mid[2] - origin[2]], n);
  const o: Vec3 = [mid[0] - n[0] * off, mid[1] - n[1] * off, mid[2] - n[2] * off];
  const L = 2 * diag + 10;
  let box: Shape3D = makeBox([-L, -L, 0], [L, L, 2 * L]);
  const axis = cross3([0, 0, 1], n);
  const s = Math.hypot(axis[0], axis[1], axis[2]);
  const angle = (Math.atan2(s, n[2]) * 180) / Math.PI;
  if (s > 1e-9) box = box.rotate(angle, [0, 0, 0], [axis[0] / s, axis[1] / s, axis[2] / s]);
  else if (n[2] < 0) box = box.rotate(180, [0, 0, 0], [1, 0, 0]);
  return box.translate(o);
}

/**
 * Cut a shape for a section view: everything on the `normal` side of the cut
 * (towards the viewer) is taken away. Returns the rest, and the faces made by
 * the cut as flat triangles in the view.
 */
function sectionCut(shape: Shape3D, origin: Vec3, normal: Vec3, flat: (p: Vec3) => [number, number]): { shape: Shape3D; faces: number[] } | null {
  const [lo, hi] = boundsOf(shape);
  const mid: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  // The cut's point nearest the middle of the shape, so the cutting box is centred on it.
  const off = dot3([mid[0] - origin[0], mid[1] - origin[1], mid[2] - origin[2]], normal);
  const o: Vec3 = [mid[0] - normal[0] * off, mid[1] - normal[1] * off, mid[2] - normal[2] * off];
  const L = 2 * diag + 10;
  // A big box above z = 0, turned so its bottom lies on the cut, facing along `normal`.
  let box: Shape3D = makeBox([-L, -L, 0], [L, L, 2 * L]);
  const axis = cross3([0, 0, 1], normal);
  const s = Math.hypot(axis[0], axis[1], axis[2]);
  const angle = (Math.atan2(s, normal[2]) * 180) / Math.PI;
  if (s > 1e-9) box = box.rotate(angle, [0, 0, 0], [axis[0] / s, axis[1] / s, axis[2] / s]);
  else if (normal[2] < 0) box = box.rotate(180, [0, 0, 0], [1, 0, 0]);
  box = box.translate(o);
  let cut: Shape3D;
  try {
    cut = shape.cut(box) as Shape3D;
  } finally {
    box.delete();
  }
  const solids = solidsOf(cut);
  solids.forEach((x) => x.delete());
  if (solids.length === 0) {
    cut.delete();
    return null;
  }
  // The cut faces: flat on the cut.
  const faces: number[] = [];
  const m = cut.mesh(MESH_TOLERANCES.display);
  const tol = 1e-4 * Math.max(1, diag);
  const v = m.vertices;
  for (let i = 0; i + 2 < m.triangles.length; i += 3) {
    const ids = [m.triangles[i], m.triangles[i + 1], m.triangles[i + 2]];
    if (!ids.every((k) => Math.abs(dot3([v[3 * k] - o[0], v[3 * k + 1] - o[1], v[3 * k + 2] - o[2]], normal)) < tol)) continue;
    for (const k of ids) faces.push(...flat([v[3 * k], v[3 * k + 1], v[3 * k + 2]]));
  }
  return { shape: cut, faces };
}

/**
 * Find the picked edges (and the edges of picked faces) on a part as it is
 * now. Throws a friendly error if some can't be found.
 */
function findPickedEdges(shape: Shape3D, picks: TopoPick[]): Edge[] {
  const edges = edgesOf(shape);
  const faces = facesOf(shape);
  const bounds = boundsOf(shape);
  const size = Math.hypot(bounds[1][0] - bounds[0][0], bounds[1][1] - bounds[0][1], bounds[1][2] - bounds[0][2]);
  const edgePicks = picks.filter((p) => p.ref.kind === "edge").map((p) => p.ref);
  const facePicks = picks.filter((p) => p.ref.kind === "face").map((p) => p.ref);
  const edgeMatch = matchRefs(edgePicks, edges.map((e) => edgeRefOf(e, bounds)), size);
  const faceMatch = matchRefs(facePicks, faces.map((f) => faceRefOf(f, bounds)), size);
  const missing = [...edgeMatch, ...faceMatch].filter((m) => m === null).length;
  if (missing > 0) {
    edges.forEach((e) => e.delete());
    faces.forEach((f) => f.delete());
    throw new Error(
      `${missing} of the picked edges or faces can't be found any more (the part has changed too much). Edit this feature and pick them again.`,
    );
  }
  const chosen: Edge[] = edgeMatch.map((i) => edges[i!]);
  for (const i of faceMatch) {
    for (const e of edgesOf(faces[i!])) {
      if (chosen.some((c) => c.isSame(e))) e.delete();
      else chosen.push(e);
    }
  }
  edges.forEach((e) => !chosen.includes(e) && e.delete());
  faces.forEach((f) => f.delete());
  return chosen;
}

/** Find the picked faces on a part as it is now. Throws a friendly error if some can't be found. */
function findPickedFaces(shape: Shape3D, picks: TopoPick[]): Face[] {
  const faces = facesOf(shape);
  const bounds = boundsOf(shape);
  const size = Math.hypot(bounds[1][0] - bounds[0][0], bounds[1][1] - bounds[0][1], bounds[1][2] - bounds[0][2]);
  const match = matchRefs(
    picks.map((p) => p.ref),
    faces.map((f) => faceRefOf(f, bounds)),
    size,
  );
  const missing = match.filter((m) => m === null).length;
  const chosen = match.filter((m): m is number => m !== null).map((i) => faces[i]);
  faces.forEach((f) => !chosen.includes(f) && f.delete());
  if (missing > 0) {
    chosen.forEach((f) => f.delete());
    throw new Error(`${missing} of the picked faces can't be found any more (the part has changed too much). Edit this feature and pick them again.`);
  }
  return chosen;
}

/** True when `after` has less volume than `before` and fits inside its bounding box. */
function shrankWithin(before: Shape3D, after: Shape3D): boolean {
  try {
    const v0 = measureVolume(before);
    const v1 = measureVolume(after);
    if (!(v1 > 1e-6 && v1 < v0 - 1e-6)) return false;
    const [a0, a1] = boundsOf(before);
    const [b0, b1] = boundsOf(after);
    const tol = 1e-3 + 1e-6 * Math.hypot(a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]);
    return [0, 1, 2].every((i) => b0[i] >= a0[i] - tol && b1[i] <= a1[i] + tol);
  } catch {
    return false;
  }
}

/** True when the shape is at least one solid and passes OpenCascade's own check. */
function isValidSolid(shape: Shape3D): boolean {
  try {
    const solids = solidsOf(shape);
    const count = solids.length;
    solids.forEach((x) => x.delete());
    if (count === 0) return false;
    const analyzer = new (getOC().BRepCheck_Analyzer)(shape.wrapped, true, false, false);
    const ok = analyzer.IsValid();
    analyzer.delete();
    return ok;
  } catch {
    return false;
  }
}

/** Sketches seen so far in the rebuild, by feature id. */
type SketchMap = Map<string, Feature>;

/** The furthest any part reaches from a sketch plane's origin. */
function reach(plane: Parameters<typeof planeFrame>[0], parts: BuiltPart[]): number {
  const o = planeFrame(plane).origin;
  let far = 1;
  for (const p of parts) {
    const [lo, hi] = boundsOf(p.shape);
    for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) far = Math.max(far, Math.hypot(x - o[0], y - o[1], z - o[2]));
  }
  return far;
}

function buildSolid(feature: Feature, v: Record<string, number>, sketches: SketchMap, all: Feature[], parts: BuiltPart[]): Shape3D {
  switch (feature.type) {
    case "extrude":
    case "revolve": {
      const verb = feature.type === "extrude" ? "extrude" : "revolve";
      if (!feature.sketchRef) throw new Error(`Choose a sketch to ${verb}.`);
      const sketch = sketches.get(feature.sketchRef);
      if (!sketch?.sketch?.plane) {
        const exists = all.find((f) => f.id === feature.sketchRef);
        if (!exists) throw new Error("Its sketch has been deleted. Pick another sketch.");
        if (exists.suppressed) throw new Error(`${exists.name} is suppressed, so there's nothing to ${verb}.`);
        if (all.indexOf(exists) > all.indexOf(feature)) throw new Error(`${exists.name} comes after this ${verb} in the list.`);
        throw new Error(`${exists.name} couldn't be used.`);
      }
      if (feature.type === "revolve") {
        const opts = feature.revolve ?? { axis: "vertical", flip: false };
        return revolveSketch(sketch.sketch.plane, sketch.sketch.data, { axis: opts.axis, angle: v.angle, flip: opts.flip });
      }
      const opts = feature.extrude ?? { end: "blind", flip: false };
      if (opts.end === "throughAll") {
        if (feature.operation !== "remove") throw new Error("Through all only works with Remove — it cuts right through the part.");
        // Long enough to pass through every part, both ways from the sketch.
        const depth = 2 * reach(sketch.sketch.plane, parts) + 2;
        return extrudeSketch(sketch.sketch.plane, sketch.sketch.data, { depth, end: "symmetric", flip: false });
      }
      if (opts.end === "upToFace") {
        if (!opts.upTo) throw new Error("Click the flat face to extrude up to.");
        const part = parts.find((p) => p.id === opts.upTo!.partId);
        if (!part) throw new Error("The part with the face to extrude up to has gone. Edit this extrude and pick another face.");
        const [face] = findPickedFaces(part.shape, [opts.upTo]);
        let centre: Vec3;
        let normal: Vec3;
        try {
          if (face.geomType !== "PLANE") throw new Error("Up to face needs a flat face.");
          centre = take(face.center);
          normal = take(face.normalAt(centre));
        } finally {
          face.delete();
        }
        const frame = planeFrame(sketch.sketch.plane);
        const n = frame.n;
        if (Math.abs(normal[0] * n[0] + normal[1] * n[1] + normal[2] * n[2]) < 0.999) {
          throw new Error("Up to face needs a face parallel to the sketch.");
        }
        const d = (centre[0] - frame.origin[0]) * n[0] + (centre[1] - frame.origin[1]) * n[1] + (centre[2] - frame.origin[2]) * n[2];
        if (Math.abs(d) < 1e-6) throw new Error("That face is level with the sketch, so there's nothing to extrude.");
        return extrudeSketch(sketch.sketch.plane, sketch.sketch.data, { depth: Math.abs(d), end: "blind", flip: d < 0, draft: v.draft });
      }
      return extrudeSketch(sketch.sketch.plane, sketch.sketch.data, { depth: v.depth, end: opts.end, flip: opts.flip, draft: v.draft });
    }
    case "sweep": {
      const need = (id: string | undefined, what: string) => {
        if (!id) throw new Error(`Choose the ${what} sketch.`);
        const sk = sketches.get(id);
        if (!sk?.sketch?.plane) {
          const exists = all.find((f) => f.id === id);
          if (!exists) throw new Error(`Its ${what} sketch has been deleted. Pick another.`);
          if (all.indexOf(exists) > all.indexOf(feature)) throw new Error(`${exists.name} comes after this sweep in the list.`);
          throw new Error(`${exists.name} couldn't be used.`);
        }
        return sk.sketch;
      };
      if (feature.sketchRef && feature.sketchRef === feature.pathRef) throw new Error("The profile and the path must be different sketches.");
      const profile = need(feature.sketchRef, "profile");
      const path = need(feature.pathRef, "path");
      return sweepSketch(profile.plane!, profile.data, path.plane!, path.data);
    }
    case "text": {
      const t = feature.text;
      if (t?.face) {
        const part = parts.find((p) => p.id === t.face!.partId);
        if (!part) throw new Error("The part the text was on no longer exists. Click a face to put it on.");
        const [face] = findPickedFaces(part.shape, [t.face]);
        try {
          const cyl = cylinderOfFace(face);
          if (!cyl) throw new Error("Text can only wrap round a round (cylinder) face. Click a flat face, a round face or a plane.");
          const start = wrapStart(cyl, take(face.center));
          const onSurface: Vec3 = [0, 1, 2].map((i) => cyl.origin[i] + cyl.axis[i] * start.height + start.radial[i] * cyl.radius) as Vec3;
          let convex = true;
          try {
            convex = dot3(take(face.normalAt(onSurface)), start.radial) > 0;
          } catch {
            // no normal there: assume the outside of a rod
          }
          return wrappedTextSolid(cyl, start, convex, { value: t.value, bold: t.bold, flip: t.flip, size: v.size, depth: v.depth, x: v.x, y: v.y, angle: v.angle });
        } finally {
          face.delete();
        }
      }
      if (!t?.plane) throw new Error("Click a plane or a face to put the text on.");
      return textSolid(t.plane, { value: t.value, bold: t.bold, flip: t.flip, size: v.size, depth: v.depth, x: v.x, y: v.y, angle: v.angle });
    }
    case "loft": {
      const sections = (feature.sections ?? []).map((id) => {
        const sk = sketches.get(id);
        const f = all.find((x) => x.id === id);
        if (!sk?.sketch?.plane) throw new Error(f ? `${f.name} can't be used (it's suppressed, comes later in the list, or has no plane).` : "One of its sketches has been deleted. Edit the loft.");
        return { plane: sk.sketch.plane, data: sk.sketch.data, name: sk.name };
      });
      return loftSketches(sections);
    }
    case "hole": {
      const h = feature.hole;
      if (!h?.sketchRef) throw new Error("Choose the sketch whose points mark where the holes go.");
      const sketch = sketches.get(h.sketchRef);
      if (!sketch?.sketch?.plane) {
        const exists = all.find((f) => f.id === h.sketchRef);
        if (!exists) throw new Error("Its sketch has been deleted. Pick another sketch.");
        if (exists.suppressed) throw new Error(`${exists.name} is suppressed, so there's nowhere to drill.`);
        if (all.indexOf(exists) > all.indexOf(feature)) throw new Error(`${exists.name} comes after this hole in the list.`);
        throw new Error(`${exists.name} couldn't be used.`);
      }
      const through = h.end === "throughAll";
      return holeTool(
        sketch.sketch.plane,
        sketch.sketch.data,
        {
          kind: h.kind,
          diameter: v.diameter,
          depth: v.depth,
          throughAll: through,
          throughLength: through ? 2 * reach(sketch.sketch.plane, parts) + 2 : 0,
          cboreDiameter: v.cboreDiameter,
          cboreDepth: v.cboreDepth,
          cskDiameter: v.cskDiameter,
          cskAngle: v.cskAngle,
        },
        h.flip,
      );
    }
    case "transform":
    case "sketch":
    case "fillet":
    case "chamfer":
    case "shell":
    case "mirror":
    case "linearPattern":
    case "circularPattern":
      throw new Error("This feature doesn't make a solid of its own.");
    case "import": {
      if (!feature.import) throw new Error("This import has lost its file. Delete it and import the file again.");
      const solids = importSolids(feature.import);
      return solids.length === 1 ? solids[0] : (makeCompound(solids) as Shape3D);
    }
    case "box":
      return makeBox([v.x, v.y, v.z], [v.x + v.width, v.y + v.depth, v.z + v.height]);
    case "cylinder":
      return makeCylinder(v.diameter / 2, v.height, [v.x, v.y, v.z], [0, 0, 1]);
    case "coil":
      return coilSolid(v.diameter / 2, v.wire / 2, v.pitch, v.turns, [v.x, v.y, v.z], !!feature.flipSide);
    case "fastener": {
      const f = feature.fastener ?? { kind: "bolt" as const, size: "M6", threaded: false };
      const solid = fastenerSolid(f.kind, f.size, v.length, v.x, v.y, v.z, f.threaded);
      const s = fastenerSize(f.size);
      if (!f.threaded || f.kind === "washer" || !s) return solid;
      try {
        if (f.kind === "bolt") {
          // Along the shank, leaving a pitch plain under the head; the groove runs out past the tip.
          const cyl: Cylinder = { origin: [v.x, v.y, v.z - v.length], axis: [0, 0, 1], radius: s.d / 2 };
          const out = cutThread(solid, cyl, -s.pitch, Math.max(v.length - s.pitch, s.pitch), 0, v.length, s.pitch, true);
          if (out !== solid) solid.delete();
          return out;
        }
        const cyl: Cylinder = { origin: [v.x, v.y, v.z], axis: [0, 0, 1], radius: s.d / 2 - 0.5413 * s.pitch };
        const out = cutThread(solid, cyl, -s.pitch, s.nut + s.pitch, 0, s.nut, s.pitch, false);
        if (out !== solid) solid.delete();
        return out;
      } catch (e) {
        solid.delete();
        throw e;
      }
    }
    case "sphere":
      return makeSphere(v.diameter / 2).translate([v.x, v.y, v.z]);
    default:
      throw new Error(`A ${feature.type} doesn't make a solid.`);
  }
}

/** The solid a feature added or cut, kept so patterns and mirrors can repeat it. */
interface FeatureTool {
  shape: Shape3D;
  operation: Operation;
  /** The part it changed (or made). */
  partId: string;
}

const AXES: Record<Axis, [number, number, number]> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** What a Part Studio built, kept until its features (or the variables or part names) change. */
interface StudioBuild {
  key: string;
  parts: BuiltPart[];
  tools: Map<string, FeatureTool>;
  errors: Record<string, string>;
}

export class GeometryEngine {
  /** Every part of every Part Studio (for exports, checks and measuring). */
  private parts: BuiltPart[] = [];
  /** While a Part Studio is being built: the solids its features added or cut. */
  private tools = new Map<string, FeatureTool>();
  private builds = new Map<string, StudioBuild>();

  /**
   * Rebuild the Part Studios whose features (or the variables or part names)
   * changed since last time; the others keep what they built. Returns the
   * meshes of the rebuilt studios only, and errors for all of them.
   */
  rebuildStudios(
    studios: StudioInput[],
    variables: Record<string, number> = {},
    partNames: Record<string, string> = {},
  ): RebuildResult & { rebuilt: string[]; studioOrder: string[] } {
    const started = performance.now();
    // Every size below is worked out with the document's variables.
    setCurrentScope(variables);
    const wanted = new Set(studios.map((s) => s.id));
    for (const [id, b] of this.builds) {
      if (!wanted.has(id)) {
        this.disposeBuild(b);
        this.builds.delete(id);
      }
    }
    const rebuilt: string[] = [];
    const meshes: PartMesh[] = [];
    const featureErrors: Record<string, string> = {};
    const shared = JSON.stringify([variables, partNames]);
    for (const studio of studios) {
      const key = JSON.stringify(studio.features) + shared;
      let b = this.builds.get(studio.id);
      if (!b || b.key !== key) {
        if (b) this.disposeBuild(b);
        this.parts = [];
        this.tools = new Map();
        const errors = this.buildFeatures(studio.features);
        // Names the user gave parts (used in the lists and in exported files).
        for (const p of this.parts) if (partNames[p.id]) p.name = partNames[p.id];
        b = { key, parts: this.parts, tools: this.tools, errors };
        this.builds.set(studio.id, b);
        rebuilt.push(studio.id);
        for (const p of b.parts) meshes.push({ ...this.meshPart(p), studioId: studio.id });
      }
      Object.assign(featureErrors, b.errors);
    }
    this.parts = studios.flatMap((s) => this.builds.get(s.id)?.parts ?? []);
    this.tools = new Map();
    return { parts: meshes, featureErrors, durationMs: Math.round(performance.now() - started), rebuilt, studioOrder: studios.map((s) => s.id) };
  }

  /**
   * Delete face can only close up a hole or boss, so a fillet or chamfer
   * rounding the edges next to it gets in the way. Works out which earlier
   * Fillet / Chamfer features on that part are in the way (turning them off
   * lets the Delete face work), or made the picked face itself. Leaves what's
   * already built untouched.
   */
  deleteFaceBlockers(features: Feature[], featureId: string, variables: Record<string, number> = {}): { blockers: string[]; makers: string[] } {
    const none = { blockers: [] as string[], makers: [] as string[] };
    const idx = features.findIndex((f) => f.id === featureId);
    const target = features[idx];
    const partId = target?.picks?.find((p) => p.ref.kind === "face")?.partId;
    if (idx < 0 || target.type !== "deleteFace" || !partId) return none;
    setCurrentScope(variables);
    const upto = features.slice(0, idx + 1);
    const saved = { parts: this.parts, tools: this.tools };
    const run = (off: Set<string>): { error?: string; featureIds: string[] } => {
      this.parts = [];
      this.tools = new Map();
      try {
        const errors = this.buildFeatures(upto.map((f) => (off.has(f.id) ? { ...f, suppressed: true } : f)));
        return { error: errors[featureId], featureIds: [...(this.parts.find((p) => p.id === partId)?.featureIds ?? [])] };
      } finally {
        this.disposeBuild({ key: "", parts: this.parts, tools: this.tools, errors: {} });
        this.parts = saved.parts;
        this.tools = saved.tools;
      }
    };
    try {
      const base = run(new Set());
      if (!base.error) return none;
      const candidates = upto.filter((f) => (f.type === "fillet" || f.type === "chamfer") && !f.suppressed && base.featureIds.includes(f.id)).map((f) => f.id);
      const makers: string[] = [];
      for (const id of candidates) {
        const r = run(new Set([id]));
        if (!r.error) return { blockers: [id], makers: [] };
        // The picked face disappears with this feature: it made that face.
        if (/can't be found|no longer exists/.test(r.error)) makers.push(id);
      }
      if (makers.length) return { blockers: [], makers };
      if (candidates.length > 1 && !run(new Set(candidates)).error) return { blockers: candidates, makers: [] };
      return none;
    } catch {
      return none;
    }
  }

  /** Replays one feature list from scratch (a document with a single Part Studio). */
  rebuild(features: Feature[], variables: Record<string, number> = {}, partNames: Record<string, string> = {}): RebuildResult {
    const old = this.builds.get(MAIN_STUDIO_ID);
    if (old) old.key = "";
    return this.rebuildStudios([{ id: MAIN_STUDIO_ID, features }], variables, partNames);
  }

  /** Build one Part Studio's features into this.parts and this.tools; returns the features' problems. */
  private buildFeatures(features: Feature[]): Record<string, string> {
    const featureErrors: Record<string, string> = {};
    let partCounter = 0;
    const sketches: SketchMap = new Map();

    for (const feature of features) {
      if (feature.suppressed) continue;
      if (feature.type === "plane") {
        // Construction planes make no solid; just say if one can't be placed.
        const { values, errors } = resolveParams(feature);
        const bad = FEATURE_DEFS.plane.params.find((p) => errors[p.key]);
        const frame = feature.planeDef ? planeFeatureFrame(feature.planeDef, values) : "Choose what the plane is based on.";
        if (bad) featureErrors[feature.id] = `${bad.label}: ${errors[bad.key]}`;
        else if (typeof frame === "string") featureErrors[feature.id] = frame;
        continue;
      }
      if (feature.type === "sketch") {
        // Sketches make no solid themselves; extrudes later in the list use them.
        if (!feature.sketch?.plane) featureErrors[feature.id] = "Pick a plane or flat face to sketch on.";
        else sketches.set(feature.id, feature);
        continue;
      }
      const def = FEATURE_DEFS[feature.type];
      if (!def) {
        featureErrors[feature.id] = "PartSmith doesn't know this kind of feature.";
        continue;
      }
      if (isPickFeature(feature.type)) {
        const err = feature.type === "shell" ? this.applyShell(feature) : this.applyEdgeFeature(feature);
        if (err) featureErrors[feature.id] = err;
        continue;
      }
      if (feature.type === "split") {
        const r = this.applySplit(feature, partCounter + 1);
        if (r.error) featureErrors[feature.id] = r.error;
        if (r.newPart) partCounter++;
        continue;
      }
      if (feature.type === "thicken") {
        const r = this.applyThicken(feature, partCounter + 1);
        if (r.error) featureErrors[feature.id] = r.error;
        if (r.newPart) partCounter++;
        continue;
      }
      if (feature.type === "thread") {
        const err = this.applyThread(feature);
        if (err) featureErrors[feature.id] = err;
        continue;
      }
      if (feature.type === "draft" || feature.type === "moveFace" || feature.type === "deleteFace") {
        const err = this.applyFaceEdit(feature);
        if (err) featureErrors[feature.id] = err;
        continue;
      }
      if (feature.type === "rib") {
        const err = this.applyRib(feature, sketches);
        if (err) featureErrors[feature.id] = err;
        continue;
      }
      if (feature.type === "deletePart") {
        const ids = feature.deleteParts ?? [];
        if (!ids.length) {
          featureErrors[feature.id] = "Click the parts to delete.";
          continue;
        }
        const missing = ids.filter((id) => !this.parts.some((p) => p.id === id));
        for (const p of this.parts.filter((x) => ids.includes(x.id))) {
          try {
            p.shape.delete();
          } catch {
            // already freed
          }
        }
        this.parts = this.parts.filter((p) => !ids.includes(p.id));
        if (missing.length) featureErrors[feature.id] = `${missing.length === 1 ? "One of its parts no longer exists" : "Some of its parts no longer exist"}. Edit this feature and pick again.`;
        continue;
      }
      if (feature.type === "boolean") {
        const err = this.applyBoolean(feature);
        if (err) featureErrors[feature.id] = err;
        continue;
      }
      if (feature.type === "transform") {
        const r = this.applyTransform(feature, partCounter + 1);
        if (r.error) featureErrors[feature.id] = r.error;
        if (r.newPart) partCounter++;
        continue;
      }
      if (isPatternFeature(feature.type)) {
        const err = this.applyPattern(feature, features);
        if (err) featureErrors[feature.id] = err;
        continue;
      }

      const { values, errors } = resolveParams(feature);
      const badParam = def.params.find((p) => errors[p.key]);
      if (badParam) {
        featureErrors[feature.id] = `${badParam.label}: ${errors[badParam.key]}`;
        continue;
      }

      const target = this.parts[this.parts.length - 1];
      if (feature.operation !== "new" && !target) {
        featureErrors[feature.id] =
          feature.type === "hole"
            ? "There's no part to drill into yet. Make a part first."
            : feature.operation === "add"
            ? "There's no part to add to yet. Use New for the first solid."
            : "There's no part to remove from yet. Use New for the first solid.";
        continue;
      }

      let tool: Shape3D;
      try {
        tool = buildSolid(feature, values, sketches, features, this.parts);
      } catch (e) {
        featureErrors[feature.id] = describeError(e, `Couldn't make this ${def.label.toLowerCase()}.`);
        continue;
      }

      if (feature.operation === "new" && feature.type === "import") {
        // A STEP file may hold several parts: each solid becomes its own part.
        this.tools.set(feature.id, { shape: tool.clone(), operation: "new", partId: feature.id });
        const solids = solidsOf(tool);
        solids.forEach((solid, i) => {
          partCounter++;
          const id = i === 0 ? feature.id : `${feature.id}~${i + 1}`;
          this.parts.push({ id, name: `Part ${partCounter}`, featureIds: [feature.id], shape: solid, meshKey: `${importKey(feature.import!)}#${i}` });
        });
        tool.delete();
        continue;
      }

      if (feature.operation === "new") {
        partCounter++;
        this.tools.set(feature.id, { shape: tool.clone(), operation: "new", partId: feature.id });
        // Fasteners are named for what they are ("M6 × 20 hex bolt").
        const name = feature.type === "fastener" && feature.fastener ? fastenerName(feature.fastener.kind, feature.fastener.size, values.length) : `Part ${partCounter}`;
        this.parts.push({ id: feature.id, name, featureIds: [feature.id], shape: tool });
        continue;
      }

      try {
        const result = feature.operation === "add" ? target.shape.fuse(tool) : feature.operation === "intersect" ? (target.shape.intersect(tool) as Shape3D) : target.shape.cut(tool);
        if (solidsOf(result).length === 0) {
          result.delete();
          throw new Error(feature.operation === "intersect" ? "This doesn't overlap the part, so nothing would be left." : "This would remove the whole part.");
        }
        target.shape.delete();
        target.shape = result;
        target.featureIds.push(feature.id);
        this.tools.set(feature.id, { shape: tool.clone(), operation: feature.operation, partId: target.id });
      } catch (e) {
        featureErrors[feature.id] = describeError(
          e,
          feature.operation === "add" ? "Couldn't merge this into the part." : feature.operation === "intersect" ? "Couldn't intersect this with the part." : "Couldn't cut this from the part.",
        );
      } finally {
        tool.delete();
      }
    }

    return featureErrors;
  }

  /** Split a part in two along a plane: both halves as parts, or just one side kept. */
  private applySplit(feature: Feature, nextPartNumber: number): { error?: string; newPart?: boolean } {
    const sp = feature.splitDef;
    if (!sp?.partId) return { error: "Click the part to split." };
    const part = this.parts.find((p) => p.id === sp.partId);
    if (!part) return { error: "The part it splits no longer exists. Edit this feature and pick it again." };
    const f = planeFrame(sp.plane);
    let front: Shape3D | null = null;
    let back: Shape3D | null = null;
    try {
      const keepFront = halfSpace(part.shape, f.origin, [-f.n[0], -f.n[1], -f.n[2]]);
      const keepBack = halfSpace(part.shape, f.origin, f.n);
      try {
        front = part.shape.cut(keepFront);
        back = part.shape.cut(keepBack);
      } finally {
        keepFront.delete();
        keepBack.delete();
      }
    } catch (e) {
      front?.delete();
      back?.delete();
      return { error: describeError(e, "Couldn't split this part.") };
    }
    const count = (s: Shape3D) => {
      const solids = solidsOf(s);
      solids.forEach((x) => x.delete());
      return solids.length;
    };
    if (count(front) === 0 || count(back) === 0) {
      front.delete();
      back.delete();
      return { error: "The plane doesn't go through this part, so there's nothing to split." };
    }
    part.shape.delete();
    part.featureIds.push(feature.id);
    if (sp.keep === "front") {
      back.delete();
      part.shape = front;
      return {};
    }
    if (sp.keep === "back") {
      front.delete();
      part.shape = back;
      return {};
    }
    part.shape = back;
    this.parts.push({ id: feature.id, name: `Part ${nextPartNumber}`, featureIds: [...part.featureIds], shape: front });
    return { newPart: true };
  }

  /** Grow picked flat faces into a solid, then make it a new part or add it to, cut it from or intersect it with their part. */
  private applyThicken(feature: Feature, nextPartNumber: number): { error?: string; newPart?: boolean } {
    const { values, errors } = resolveParams(feature);
    if (errors.thickness) return { error: `Thickness: ${errors.thickness}` };
    const picks = (feature.picks ?? []).filter((p) => p.ref.kind === "face");
    if (picks.length === 0) return { error: "Click the flat faces to thicken." };
    const partIds = [...new Set(picks.map((p) => p.partId))];
    if (partIds.length > 1) return { error: "Thicken works on one part at a time. Remove the faces picked on the other part." };
    const part = this.parts.find((p) => p.id === partIds[0]);
    if (!part) return { error: "The part these faces were on no longer exists. Edit this feature and pick the faces again." };
    let faces: Face[];
    try {
      faces = findPickedFaces(part.shape, picks);
    } catch (e) {
      return { error: describeError(e, "Couldn't find the picked faces.") };
    }
    let solid: Shape3D | null = null;
    try {
      for (const face of faces) {
        if (face.geomType !== "PLANE") throw new Error("Thicken works on flat faces. Remove the curved face.");
        const n = take(face.normalAt());
        const t = values.thickness * (feature.flipSide ? -1 : 1);
        const piece = basicFaceExtrusion(face, new Vector([n[0] * t, n[1] * t, n[2] * t])) as Shape3D;
        if (!solid) solid = piece;
        else {
          const next: Shape3D = solid.fuse(piece);
          solid.delete();
          piece.delete();
          solid = next;
        }
      }
    } catch (e) {
      solid?.delete();
      return { error: describeError(e, "Couldn't thicken these faces.") };
    } finally {
      faces.forEach((f) => f.delete());
    }
    if (!solid) return { error: "Click the flat faces to thicken." };
    if (feature.operation === "new") {
      this.tools.set(feature.id, { shape: solid.clone(), operation: "new", partId: feature.id });
      this.parts.push({ id: feature.id, name: `Part ${nextPartNumber}`, featureIds: [feature.id], shape: solid });
      return { newPart: true };
    }
    try {
      const result =
        feature.operation === "add" ? part.shape.fuse(solid) : feature.operation === "intersect" ? (part.shape.intersect(solid) as Shape3D) : part.shape.cut(solid);
      const solids = solidsOf(result);
      solids.forEach((x) => x.delete());
      if (solids.length === 0) {
        result.delete();
        return { error: "This would remove the whole part." };
      }
      part.shape.delete();
      part.shape = result;
      part.featureIds.push(feature.id);
      this.tools.set(feature.id, { shape: solid.clone(), operation: feature.operation, partId: part.id });
      return {};
    } catch (e) {
      return { error: describeError(e, "Couldn't combine the thickened faces with the part.") };
    } finally {
      solid.delete();
    }
  }

  /** Draft, Move face or Delete face on the picked faces of one part. */
  /** Thread: cut a helical V groove round each picked round face (outside of a rod, or inside a hole). */
  private applyThread(feature: Feature): string | null {
    const { values, errors } = resolveParams(feature);
    const bad = FEATURE_DEFS.thread.params.find((p) => errors[p.key]);
    if (bad) return `${bad.label}: ${errors[bad.key]}`;
    const picks = (feature.picks ?? []).filter((p) => p.ref.kind === "face");
    if (picks.length === 0) return "Click the round face to thread — the outside of a rod (bolt) or the inside of a hole (nut).";
    const partIds = [...new Set(picks.map((p) => p.partId))];
    if (partIds.length > 1) return "Thread works on one part at a time. Remove the faces picked on the other part.";
    const part = this.parts.find((p) => p.id === partIds[0]);
    if (!part) return "The part these faces were on no longer exists. Edit this feature and pick the faces again.";
    let faces: Face[];
    try {
      faces = findPickedFaces(part.shape, picks);
    } catch (e) {
      return describeError(e, "Couldn't find the picked faces.");
    }
    let shape = part.shape;
    try {
      for (const face of faces) {
        const cyl = cylinderOfFace(face);
        if (!cyl) throw new Error("Threads go on round (cylinder) faces. Remove the other faces.");
        // How far the face runs along its axis.
        const heights: number[] = [];
        for (const e of edgesOf(face)) {
          try {
            for (const t of [0, 0.5, 1]) {
              const q = take(e.pointAt(t));
              heights.push(dot3([q[0] - cyl.origin[0], q[1] - cyl.origin[1], q[2] - cyl.origin[2]], cyl.axis));
            }
          } finally {
            e.delete();
          }
        }
        const lo = Math.min(...heights);
        const hi = Math.max(...heights);
        // Rod or hole: which way the face points at its middle.
        const c = take(face.center);
        const h = dot3([c[0] - cyl.origin[0], c[1] - cyl.origin[1], c[2] - cyl.origin[2]], cyl.axis);
        const off: Vec3 = [c[0] - cyl.origin[0] - cyl.axis[0] * h, c[1] - cyl.origin[1] - cyl.axis[1] * h, c[2] - cyl.origin[2] - cyl.axis[2] * h];
        let radial: Vec3 = Math.hypot(...off) > 1e-6 ? off : Math.abs(cyl.axis[2]) < 0.9 ? cross3(cyl.axis, [0, 0, 1]) : cross3(cyl.axis, [1, 0, 0]);
        const l = Math.hypot(...radial);
        radial = [radial[0] / l, radial[1] / l, radial[2] / l];
        const onSurface: Vec3 = [cyl.origin[0] + cyl.axis[0] * h + radial[0] * cyl.radius, cyl.origin[1] + cyl.axis[1] * h + radial[1] * cyl.radius, cyl.origin[2] + cyl.axis[2] * h + radial[2] * cyl.radius];
        let external = true;
        try {
          external = dot3(take(face.normalAt(onSurface)), radial) > 0;
        } catch {
          // assume a rod
        }
        const pitch = values.pitch;
        const full = !(values.length > 0) || values.length >= hi - lo - 1e-6;
        // Runs out past the open end (and past the far end too when it's the full length), so the groove ends cleanly.
        const from = full ? lo - pitch : hi - values.length;
        const next = cutThread(shape, cyl, from, hi + pitch, lo, hi, pitch, external);
        if (shape !== part.shape) shape.delete();
        shape = next;
      }
      const solids = solidsOf(shape);
      solids.forEach((x) => x.delete());
      if (solids.length === 0 || !isValidSolid(shape)) throw new Error("The thread couldn't be cut cleanly — try a different pitch or length.");
      part.shape.delete();
      part.shape = shape;
      part.featureIds.push(feature.id);
      return null;
    } catch (e) {
      if (shape !== part.shape) shape.delete();
      return describeError(e, "Couldn't cut the thread.");
    } finally {
      faces.forEach((f) => f.delete());
    }
  }

  private applyFaceEdit(feature: Feature): string | null {
    const def = FEATURE_DEFS[feature.type];
    const { values, errors } = resolveParams(feature);
    const bad = def.params.find((p) => errors[p.key]);
    if (bad) return `${bad.label}: ${errors[bad.key]}`;
    const picks = (feature.picks ?? []).filter((p) => p.ref.kind === "face");
    if (picks.length === 0) return feature.type === "deleteFace" ? "Click the faces to remove (a fillet, a hole's wall…)." : "Click the faces to change.";
    const partIds = [...new Set(picks.map((p) => p.partId))];
    if (partIds.length > 1) return `${def.label} works on one part at a time. Remove the faces picked on the other part.`;
    const part = this.parts.find((p) => p.id === partIds[0]);
    if (!part) return "The part these faces were on no longer exists. Edit this feature and pick the faces again.";
    let faces: Face[];
    try {
      faces = findPickedFaces(part.shape, picks);
    } catch (e) {
      return describeError(e, "Couldn't find the picked faces.");
    }
    let result: Shape3D | null = null;
    try {
      if (feature.type === "draft") {
        if (Math.abs(values.angle) < 1e-9) return "Enter an angle to taper by.";
        result = draftFaces(part.shape, faces, planeFrame(feature.neutral ?? { kind: "default", name: "Top" }), !!feature.flipSide, values.angle);
      } else if (feature.type === "deleteFace") {
        result = deleteFaces(part.shape, faces);
      } else {
        const d = values.distance;
        if (Math.abs(d) < 1e-9) return "Enter a distance to move the faces by.";
        // Each flat face swept out (or in) along its own normal, then added (or cut).
        let prism: Shape3D | null = null;
        for (const face of faces) {
          if (face.geomType !== "PLANE") throw new Error("Move face works on flat faces. Remove the curved face.");
          const n = take(face.normalAt());
          const piece = basicFaceExtrusion(face, new Vector([n[0] * d, n[1] * d, n[2] * d])) as Shape3D;
          if (!prism) prism = piece;
          else {
            const next: Shape3D = prism.fuse(piece);
            prism.delete();
            piece.delete();
            prism = next;
          }
        }
        if (!prism) return "Click the faces to move.";
        try {
          result = d > 0 ? part.shape.fuse(prism) : part.shape.cut(prism);
        } finally {
          prism.delete();
        }
      }
      const solids = solidsOf(result);
      solids.forEach((x) => x.delete());
      if (solids.length === 0 || !isValidSolid(result)) {
        result.delete();
        return feature.type === "deleteFace" ? "Those faces can't be removed cleanly." : "That would leave the part broken — try a smaller amount.";
      }
      part.shape.delete();
      part.shape = result;
      part.featureIds.push(feature.id);
      return null;
    } catch (e) {
      result?.delete();
      return describeError(e, `Couldn't apply this ${def.label.toLowerCase()}.`);
    } finally {
      faces.forEach((f) => f.delete());
    }
  }

  /**
   * Rib: a wall of the given thickness along each line of a sketch, filling
   * the space between the line and the part (within the part's overall box),
   * and joined to the latest part — for gussets and webs. Of the two sides of
   * each line, the one that adds less material is filled (the corner a gusset
   * braces); Flip picks the other.
   */
  private applyRib(feature: Feature, sketches: SketchMap): string | null {
    const { values, errors } = resolveParams(feature);
    if (errors.thickness) return `Thickness: ${errors.thickness}`;
    if (!feature.sketchRef) return "Choose the sketch with the rib's lines.";
    const sketch = sketches.get(feature.sketchRef);
    if (!sketch?.sketch?.plane) return "The sketch it uses can't be found (deleted or suppressed).";
    const part = this.parts[this.parts.length - 1];
    if (!part) return "There's no part to add a rib to yet.";
    const frame = planeFrame(sketch.sketch.plane);
    const data = sketch.sketch.data;
    const lines = data.curves.filter((c) => c.type === "line" && !c.construction);
    if (lines.length === 0) return "Draw the rib as straight lines (not construction) in the sketch.";
    const [lo, hi] = boundsOf(part.shape);
    const L = 2 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + 10;
    const half = values.thickness / 2;
    const n = frame.n;
    let rib: Shape3D | null = null;
    const pos = (id: string) => {
      const p = data.points.find((x) => x.id === id);
      return p ? toWorld(frame, p.x, p.y) : toWorld(frame, 0, 0);
    };
    try {
      for (const line of lines) {
        if (line.type !== "line") continue;
        const a = pos(line.p1);
        const b = pos(line.p2);
        const e: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const len = Math.hypot(...e);
        if (len < 1e-9) continue;
        const d = cross3(n, [e[0] / len, e[1] / len, e[2] / len]);
        const off = (p: Vec3, s: number): Vec3 => [p[0] + n[0] * s, p[1] + n[1] * s, p[2] + n[2] * s];
        /** The wall on one side of the line, inside the part's box, and how much it adds. */
        const side = (sign: number) => {
          const face = makePolygon([off(a, -half), off(b, -half), off(b, half), off(a, half)]);
          const slab = basicFaceExtrusion(face, new Vector([d[0] * L * sign, d[1] * L * sign, d[2] * L * sign])) as Shape3D;
          face.delete();
          const box = makeBox(lo, hi);
          const shape = slab.intersect(box) as Shape3D;
          slab.delete();
          box.delete();
          let added = 0;
          try {
            const extra = shape.cut(part.shape);
            added = measureVolume(extra);
            extra.delete();
          } catch {
            added = Infinity;
          }
          return { shape, added };
        };
        const one = side(1);
        const other = side(-1);
        // The side that adds less (but something), or the other one when flipped.
        const ranked = [one, other].filter((x) => x.added > 1e-6).sort((x, y) => x.added - y.added);
        const choice = ranked.length === 0 ? null : feature.flipSide && ranked.length > 1 ? ranked[1] : ranked[0];
        for (const x of [one, other]) if (x !== choice) x.shape.delete();
        if (!choice) continue;
        const piece = choice.shape;
        if (!rib) rib = piece;
        else {
          const next: Shape3D = rib.fuse(piece);
          rib.delete();
          piece.delete();
          rib = next;
        }
      }
      if (!rib) return "Draw the rib as straight lines (not construction) in the sketch.";
      const result = part.shape.fuse(rib);
      part.shape.delete();
      part.shape = result;
      part.featureIds.push(feature.id);
      this.tools.set(feature.id, { shape: rib.clone(), operation: "add", partId: part.id });
      return null;
    } catch (e) {
      return describeError(e, "Couldn't make this rib.");
    } finally {
      rib?.delete();
    }
  }

  /**
   * Boolean: join parts into the first one, cut some parts with others, or
   * keep only where parts overlap. Parts used up disappear from the list.
   */
  private applyBoolean(feature: Feature): string | null {
    const b = feature.booleanDef;
    if (!b) return "Choose the parts.";
    const find = (ids: string[]) => ids.map((id) => this.parts.find((p) => p.id === id));
    const targets = find(b.targets);
    const tools = find(b.tools);
    if (targets.some((p) => !p) || tools.some((p) => !p)) return "One of its parts no longer exists. Edit this feature and pick again.";
    const ts = targets as BuiltPart[];
    const tls = (tools as BuiltPart[]).filter((p) => !ts.includes(p));
    const fuseAll = (shapes: Shape3D[]): Shape3D => {
      let out = shapes[0].clone();
      for (const s of shapes.slice(1)) {
        const next = out.fuse(s);
        out.delete();
        out = next;
      }
      return out;
    };
    const used = new Set<BuiltPart>();
    try {
      if (b.op === "union" || b.op === "intersect") {
        if (ts.length < 2) return `Pick at least two parts to ${b.op === "union" ? "join" : "intersect"} — click them in the 3D view or the Parts list.`;
        let shape = ts[0].shape.clone();
        for (const p of ts.slice(1)) {
          const next = b.op === "union" ? shape.fuse(p.shape) : (shape.intersect(p.shape) as Shape3D);
          shape.delete();
          shape = next;
        }
        if (solidsOf(shape).length === 0) {
          shape.delete();
          return "These parts don't overlap, so nothing would be left.";
        }
        ts[0].shape.delete();
        ts[0].shape = shape;
        ts.slice(1).forEach((p) => used.add(p));
        ts[0].featureIds.push(feature.id, ...ts.slice(1).flatMap((p) => p.featureIds));
      } else {
        if (ts.length === 0) return "Pick the parts to cut — click them in the 3D view or the Parts list.";
        if (tls.length === 0) return "Now pick the parts to cut with: choose “Cut with” below, then click them.";
        const cutter = fuseAll(tls.map((p) => p.shape));
        try {
          const results = ts.map((p) => p.shape.cut(cutter));
          if (results.some((r) => solidsOf(r).length === 0)) {
            results.forEach((r) => r.delete());
            return "This would cut away a whole part.";
          }
          ts.forEach((p, i) => {
            p.shape.delete();
            p.shape = results[i];
            p.featureIds.push(feature.id);
          });
        } finally {
          cutter.delete();
        }
        if (!b.keepTools) tls.forEach((p) => used.add(p));
      }
    } catch (e) {
      return describeError(e, "Couldn't combine these parts.");
    }
    for (const p of used) {
      p.shape.delete();
      this.parts.splice(this.parts.indexOf(p), 1);
    }
    return null;
  }

  /** Move and/or turn a part, or a copy of it. */
  private applyTransform(feature: Feature, nextPartNumber: number): { error?: string; newPart?: boolean } {
    const def = FEATURE_DEFS.transform;
    const { values, errors } = resolveParams(feature);
    const badParam = def.params.find((p) => errors[p.key]);
    if (badParam) return { error: `${badParam.label}: ${errors[badParam.key]}` };
    const t = feature.transform;
    if (!t?.partId) return { error: "Choose the part to move." };
    const part = this.parts.find((p) => p.id === t.partId);
    if (!part) return { error: "The part it moves no longer exists. Edit this feature and choose another part." };
    if (Math.abs(values.angle) < 1e-12 && Math.abs(values.dx) + Math.abs(values.dy) + Math.abs(values.dz) < 1e-12 && !t.copy) {
      return { error: "Nothing to do yet — enter a distance to move or an angle to turn." };
    }
    const [lo, hi] = boundsOf(part.shape);
    const centre: [number, number, number] = t.about === "origin" ? [0, 0, 0] : [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const move = (s: Shape3D): Shape3D => {
      let out = s;
      if (Math.abs(values.angle) > 1e-12) out = out.rotate(values.angle, centre, AXES[t.axis]);
      if (Math.abs(values.dx) + Math.abs(values.dy) + Math.abs(values.dz) > 0) out = out.translate([values.dx, values.dy, values.dz]);
      return out;
    };
    let shape = part.shape.clone();
    try {
      shape = move(shape);
    } catch (e) {
      shape.delete();
      return { error: describeError(e, "Couldn't move this part.") };
    }
    if (t.copy) {
      this.parts.push({ id: feature.id, name: `Part ${nextPartNumber}`, featureIds: [feature.id], shape });
      return { newPart: true };
    }
    part.shape.delete();
    part.shape = shape;
    part.featureIds.push(feature.id);
    // The features that made this part move with it, so a later pattern or mirror of them starts from where the part is now.
    for (const tool of this.tools.values()) {
      if (tool.partId !== part.id) continue;
      try {
        tool.shape = move(tool.shape);
      } catch {
        // Leave it where it was; a pattern of it would then start from the old place.
      }
    }
    return {};
  }

  /**
   * Mirror or pattern: repeat what earlier features did (add or cut their
   * solid) at mirrored, shifted or turned positions. Returns an error message, or null.
   */
  private applyPattern(feature: Feature, all: Feature[]): string | null {
    const def = FEATURE_DEFS[feature.type];
    const { values, errors } = resolveParams(feature);
    const badParam = def.params.find((p) => errors[p.key]);
    if (badParam) return `${badParam.label}: ${errors[badParam.key]}`;
    const mirror = feature.type === "mirror";
    const sourceIds = (mirror ? feature.mirror?.sources : feature.pattern?.sources) ?? [];
    if (sourceIds.length === 0) {
      return `Pick the features to ${mirror ? "mirror" : "repeat"} — click them in the feature list while this dialog is open.`;
    }

    // Use the sources in the order they were built.
    const ordered = all.filter((f) => sourceIds.includes(f.id));
    const at = all.indexOf(feature);
    for (const id of sourceIds) {
      const f = all.find((x) => x.id === id);
      if (!f) return "One of the features it repeats has been deleted. Edit this feature and pick again.";
      if (all.indexOf(f) > at) return `${f.name} comes after this ${def.label.toLowerCase()} in the list.`;
      if (!isSolidFeature(f.type)) return `${f.name} can't be ${mirror ? "mirrored" : "patterned"} — pick features that add or cut a solid.`;
      if (f.operation === "intersect") return `${f.name} intersects, so it can't be ${mirror ? "mirrored" : "patterned"} — pick features that add or cut a solid.`;
      if (f.suppressed) return `${f.name} is suppressed, so there's nothing to ${mirror ? "mirror" : "repeat"}.`;
      if (!this.tools.has(id)) return `${f.name} couldn't be built, so it can't be ${mirror ? "mirrored" : "repeated"}.`;
    }

    // Where each copy goes.
    const placements: ((s: Shape3D) => Shape3D)[] = [];
    if (mirror) {
      const frame = planeFrame(feature.mirror!.plane);
      placements.push((s) => s.mirror(frame.n, frame.origin));
    } else {
      const axis = AXES[feature.pattern?.axis ?? "x"];
      const sign = feature.pattern?.flip ? -1 : 1;
      const count = values.count;
      if (feature.type === "linearPattern") {
        for (let i = 1; i < count; i++) {
          const d = values.spacing * i * sign;
          placements.push((s) => s.translate([axis[0] * d, axis[1] * d, axis[2] * d]));
        }
      } else {
        if (values.angle > 360) return "Spread over: must be at most 360°";
        const step = values.angle >= 360 - 1e-9 ? 360 / count : values.angle / (count - 1);
        for (let i = 1; i < count; i++) placements.push((s) => s.rotate(step * i * sign, [0, 0, 0], axis));
      }
    }

    // Work on copies of the parts, and only keep them if everything succeeds.
    const working = new Map<string, Shape3D>();
    const release = () => working.forEach((s) => s.delete());
    try {
      for (const source of ordered) {
        const tool = this.tools.get(source.id)!;
        const part = this.parts.find((p) => p.id === tool.partId);
        if (!part) {
          release();
          return `The part ${source.name} belonged to no longer exists.`;
        }
        let shape = working.get(part.id) ?? part.shape.clone();
        for (const place of placements) {
          const copy = place(tool.shape.clone());
          try {
            const next = tool.operation === "remove" ? shape.cut(copy) : shape.fuse(copy);
            shape.delete();
            shape = next;
          } finally {
            copy.delete();
          }
        }
        if (solidsOf(shape).length === 0) {
          shape.delete();
          working.delete(part.id);
          release();
          return "This would remove the whole part.";
        }
        working.set(part.id, shape);
      }
    } catch (e) {
      release();
      return describeError(e, `Couldn't make this ${def.label.toLowerCase()}.`);
    }
    for (const [id, shape] of working) {
      const part = this.parts.find((p) => p.id === id)!;
      part.shape.delete();
      part.shape = shape;
      part.featureIds.push(feature.id);
    }
    return null;
  }

  /** Hollow out a part, removing the picked faces. Returns an error message, or null. */
  private applyShell(feature: Feature): string | null {
    const { values, errors } = resolveParams(feature);
    if (errors.thickness) return `Wall thickness: ${errors.thickness}`;
    const picks = (feature.picks ?? []).filter((p) => p.ref.kind === "face");
    if (picks.length === 0) return "Click the face to leave open (usually the top). The rest of the part becomes walls.";
    const partIds = [...new Set(picks.map((p) => p.partId))];
    if (partIds.length > 1) return "Shell works on one part at a time. Remove the faces picked on the other part.";
    const part = this.parts.find((p) => p.id === partIds[0]);
    if (!part) return "The part these faces were on no longer exists. Edit this feature and pick the faces again.";

    let faces: Face[];
    try {
      faces = findPickedFaces(part.shape, picks);
    } catch (e) {
      return describeError(e, "Couldn't find the picked faces.");
    }
    const failed =
      "Couldn't hollow this part. Try thinner walls — rounded corners and thin areas must be thicker than the walls.";
    let shape: Shape3D;
    try {
      shape = part.shape.shell(values.thickness, (f) => f.inList(faces));
    } catch {
      return failed;
    } finally {
      faces.forEach((f) => f.delete());
    }
    // A hollowed part must be valid, lighter than before, and no bigger than before. (With walls
    // thicker than the part, OpenCascade can "succeed" with a strange inside-out solid.)
    if (!isValidSolid(shape) || !shrankWithin(part.shape, shape)) {
      shape.delete();
      return failed;
    }
    part.shape.delete();
    part.shape = shape;
    part.featureIds.push(feature.id);
    return null;
  }

  /** Fillet or chamfer the picked edges of their parts. Returns an error message, or null. */
  private applyEdgeFeature(feature: Feature): string | null {
    const def = FEATURE_DEFS[feature.type];
    const { values, errors } = resolveParams(feature);
    const badParam = def.params.find((p) => errors[p.key]);
    if (badParam) return `${badParam.label}: ${errors[badParam.key]}`;
    const picks = feature.picks ?? [];
    if (picks.length === 0) return "Click the edges (or faces) you want to " + (feature.type === "fillet" ? "round." : "bevel.");
    const size = feature.type === "fillet" ? values.radius : values.distance;

    // Apply part by part; picks remember which part they're on.
    const partIds = [...new Set(picks.map((p) => p.partId))];
    for (const partId of partIds) {
      const part = this.parts.find((p) => p.id === partId);
      if (!part) return "The part these edges were on no longer exists. Edit this feature and pick the edges again.";
    }
    const results: { part: BuiltPart; shape: Shape3D }[] = [];
    try {
      for (const partId of partIds) {
        const part = this.parts.find((p) => p.id === partId)!;
        const chosen = findPickedEdges(part.shape, picks.filter((p) => p.partId === partId));
        const pick = (e: Edge) => (chosen.some((c) => c.isSame(e)) ? size : null);
        const failed =
          feature.type === "fillet"
            ? "Couldn't round these edges. Try a smaller radius — it has to fit on the faces next to each edge."
            : "Couldn't bevel these edges. Try a smaller distance — it has to fit on the faces next to each edge.";
        let shape: Shape3D;
        try {
          shape = feature.type === "fillet" ? part.shape.fillet(pick) : part.shape.chamfer(pick);
        } catch {
          throw new Error(failed);
        } finally {
          chosen.forEach((c) => c.delete());
        }
        // OpenCascade sometimes "succeeds" with a broken solid when the size is too big.
        if (!isValidSolid(shape)) {
          shape.delete();
          throw new Error(failed);
        }
        results.push({ part, shape });
      }
    } catch (e) {
      results.forEach((r) => r.shape.delete());
      return describeError(e, `Couldn't make this ${def.label.toLowerCase()}.`);
    }
    for (const { part, shape } of results) {
      part.shape.delete();
      part.shape = shape;
      part.featureIds.push(feature.id);
    }
    return null;
  }

  /** Checks the chosen parts (all when the list is empty) are sound, closed solids. */
  check(quality: MeshQuality, partIds: string[] = []): CheckResult {
    const oc = getOC();
    const tol = MESH_TOLERANCES[quality];
    const chosen = partIds.length ? this.parts.filter((p) => partIds.includes(p.id)) : this.parts;
    return {
      overlaps: this.findOverlaps(chosen),
      parts: chosen.map((p) => {
        let geometryValid: boolean | null = null;
        try {
          const analyzer = new oc.BRepCheck_Analyzer(p.shape.wrapped, true, false, false);
          geometryValid = analyzer.IsValid();
          analyzer.delete();
        } catch {
          geometryValid = null;
        }
        let exactVolume: number | null = null;
        try {
          exactVolume = measureVolume(p.shape);
        } catch {
          exactVolume = null;
        }
        const m = p.shape.mesh(tol);
        const mesh = analyzeMesh(m.vertices, m.triangles);
        // Measuring wall thickness only makes sense on a closed surface.
        const thinnest = mesh.watertight ? estimateThickness(m.vertices, m.triangles) : null;
        return { partId: p.id, name: p.name, geometryValid, exactVolume, mesh, thinnest };
      }),
    };
  }

  /** Separate parts that occupy the same space (they would clash). */
  private findOverlaps(parts: BuiltPart[]): NonNullable<CheckResult["overlaps"]> {
    const found: NonNullable<CheckResult["overlaps"]> = [];
    const boxes = parts.map((p) => boundsOf(p.shape));
    const apart = (a: Bounds, b: Bounds) => [0, 1, 2].some((i) => a[1][i] < b[0][i] || b[1][i] < a[0][i]);
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        if (apart(boxes[i], boxes[j])) continue;
        try {
          const common = parts[i].shape.intersect(parts[j].shape);
          const volume = measureVolume(common);
          common.delete();
          if (volume > 1e-3) found.push({ a: parts[i].name, b: parts[j].name, volume });
        } catch {
          // couldn't tell; say nothing rather than guess
        }
      }
    }
    return found;
  }

  /** One binary STL containing the chosen parts (all parts when the list is empty). */
  /**
   * The shapes to export: the chosen parts (all when the list is empty), or —
   * for an assembly — a copy of each instance's part moved into place.
   * Copies are freed after `fn` runs.
   */
  private withChosen<T>(partIds: string[], instances: InstanceInput[] | undefined, fn: (items: { id: string; name: string; shape: Shape3D }[]) => T): T {
    if (!instances?.length) {
      const chosen = partIds.length ? this.parts.filter((p) => partIds.includes(p.id)) : this.parts;
      if (chosen.length === 0) throw new Error("There's nothing to export yet.");
      return fn(chosen.map((p) => ({ id: p.id, name: p.name, shape: p.shape })));
    }
    const placed = this.placeInstances(instances);
    try {
      if (placed.length === 0) throw new Error("There's nothing in this assembly to export yet.");
      return fn(placed.map((p) => ({ id: p.partId, name: p.name, shape: p.shape })));
    } finally {
      placed.forEach((p) => p.shape.delete());
    }
  }

  /** A copy of each instance's part, turned and moved into its place in the assembly (caller frees them). */
  private placeInstances(instances: InstanceInput[]): { id: string; partId: string; name: string; shape: Shape3D }[] {
    const out: { id: string; partId: string; name: string; shape: Shape3D }[] = [];
    for (const i of instances) {
      const part = this.parts.find((p) => p.id === i.partId);
      if (!part) continue;
      let shape = part.shape.clone();
      const [x, y, z, w] = i.rotation;
      const s = Math.sqrt(Math.max(0, 1 - w * w));
      const angle = (2 * Math.acos(Math.max(-1, Math.min(1, w))) * 180) / Math.PI;
      if (s > 1e-9 && Math.abs(angle) > 1e-9) shape = shape.rotate(angle, [0, 0, 0], [x / s, y / s, z / s]);
      if (Math.abs(i.position[0]) + Math.abs(i.position[1]) + Math.abs(i.position[2]) > 0) shape = shape.translate(i.position);
      out.push({ id: i.id, partId: i.partId, name: i.name, shape });
    }
    return out;
  }

  /**
   * Drawing views: the chosen parts (or an assembly's placed copies) seen from
   * each direction, with the lines hidden behind the part worked out.
   */
  project(partIds: string[], instances: InstanceInput[] | undefined, views: ViewKind[], withHidden = true, sections: SectionRequest[] = []): ViewProjection[] {
    const placed = instances?.length ? this.placeInstances(instances) : [];
    const shapes = placed.length ? placed.map((p) => p.shape) : (partIds.length ? this.parts.filter((p) => partIds.includes(p.id)) : this.parts).map((p) => p.shape);
    const empty = (kind: string): ViewProjection => ({ kind, visible: [], hidden: [], circles: [], points: [], bounds: null });
    const standard = views.filter((k) => k !== "section");
    if (shapes.length === 0) {
      placed.forEach((p) => p.shape.delete());
      return [...standard.map(empty), ...sections.map((s) => empty(s.key))];
    }
    const whole = (shapes.length === 1 ? shapes[0] : makeCompound(shapes)) as Shape3D;
    let wholeAxes: [Vec3, Vec3][] | null = null;
    try {
      const out: ViewProjection[] = standard.map((kind) => {
        const { toward, right } = VIEW_CAMERAS[kind];
        // Centre lines of round faces seen from the side (not in the 3D view).
        return projectView(whole, kind, toward, right, withHidden, kind === "iso" ? [] : (wholeAxes ??= cylinderAxes(whole)));
      });
      // Holes seen end-on, for hole callouts (single parts only).
      if (!placed.length) {
        let found: FoundHole[] | null = null;
        out.forEach((view, i) => {
          const kind = standard[i];
          if (kind === "iso") return;
          found ??= findHoles(whole);
          const { toward, right } = VIEW_CAMERAS[kind];
          const up = cross3(toward, right);
          view.holes = found
            // Seen end-on, from the side it's drilled from (through holes from either side).
            .filter((h) => Math.abs(dot3(h.into, toward)) > 0.999 && (h.through || dot3(h.into, toward) < 0))
            .map((h) => ({
              cx: dot3(h.entry, right),
              cy: dot3(h.entry, up),
              d: h.diameter,
              through: h.through,
              depth: h.depth,
              ...(h.cbore ? { cbore: h.cbore } : {}),
              ...(h.csk ? { csk: h.csk } : {}),
            }));
        });
      }
      for (const req of sections) {
        let host = out.find((p) => p.kind === req.host);
        if (!host) {
          const { toward, right } = VIEW_CAMERAS[req.host];
          host = projectView(whole, req.host, toward, right, false, []);
        }
        const geo = host.bounds ? sectionGeometry(req.host, fromRel(host.bounds, req.a), fromRel(host.bounds, req.b), req.flip) : null;
        if (!geo) {
          out.push(empty(req.key));
          continue;
        }
        const up = cross3(geo.toward, geo.right);
        const flat = (p: Vec3): [number, number] => [dot3(p, geo.right), dot3(p, up)];
        const cut = sectionCut(whole, geo.origin, geo.normal, flat);
        if (!cut) {
          out.push(empty(req.key));
          continue;
        }
        try {
          const view = projectView(cut.shape, req.key, geo.toward, geo.right, false, cylinderAxes(cut.shape));
          view.cutFaces = cut.faces;
          out.push(view);
        } finally {
          cut.shape.delete();
        }
      }
      return out;
    } finally {
      if (whole !== shapes[0] || shapes.length > 1) {
        try {
          whole.delete();
        } catch {
          // already freed
        }
      }
      placed.forEach((p) => p.shape.delete());
    }
  }

  /** Pairs of assembly instances that occupy the same space. */
  clashes(instances: InstanceInput[]): NonNullable<CheckResult["overlaps"]> {
    const placed = this.placeInstances(instances);
    try {
      return this.findOverlaps(placed.map((p) => ({ id: p.id, name: p.name, featureIds: [], shape: p.shape })));
    } finally {
      placed.forEach((p) => p.shape.delete());
    }
  }

  exportStl(partIds: string[], quality: MeshQuality, instances?: InstanceInput[]): ExportResult {
    const tol = MESH_TOLERANCES[quality];
    return this.withChosen(partIds, instances, (chosen) => {
    const meshes = chosen.map((p) => {
      const m = p.shape.mesh(tol);
      return { vertices: m.vertices, triangles: withoutDegenerateTriangles(m.vertices, m.triangles) };
    });
    const triangleCount = meshes.reduce((n, m) => n + m.triangles.length / 3, 0);
    const names = chosen.map((p) => p.name).join(", ");
    return { stl: writeBinaryStl(meshes, `PartSmith export: ${names}`), triangleCount };
    });
  }

  /** Measure one or two picked edges/faces: lengths, areas, round sizes, and the gap and angle between them. */
  measure(picks: TopoPick[]): Measurement {
    const found: { item: MeasuredItem; shape: Edge | Face }[] = [];
    for (const pick of picks.slice(0, 2)) {
      const part = this.parts.find((p) => p.id === pick.partId);
      if (!part) continue;
      const bounds = boundsOf(part.shape);
      const size = Math.hypot(bounds[1][0] - bounds[0][0], bounds[1][1] - bounds[0][1], bounds[1][2] - bounds[0][2]);
      const item = describePick(pick.ref);
      if (pick.ref.kind === "edge") {
        const edges = edgesOf(part.shape);
        const [i] = matchRefs([pick.ref], edges.map((e) => edgeRefOf(e, bounds)), size);
        if (i === null) continue;
        const edge = edges[i];
        edges.forEach((e, j) => j !== i && e.delete());
        item.length = measureLength(edge);
        if (pick.ref.curve === "CIRCLE") {
          const c = circleThrough3D(take(edge.pointAt(0)), take(edge.pointAt(1 / 3)), take(edge.pointAt(2 / 3)));
          if (c) Object.assign(item, { radius: c.radius, centre: c.centre });
        }
        found.push({ item, shape: edge });
      } else {
        const faces = facesOf(part.shape);
        const [i] = matchRefs([pick.ref], faces.map((f) => faceRefOf(f, bounds)), size);
        if (i === null) continue;
        const face = faces[i];
        faces.forEach((f, j) => j !== i && f.delete());
        item.area = measureArea(face);
        if (pick.ref.surface === "CYLINDRE") {
          // A round face's size comes from one of its round edges.
          for (const e of edgesOf(face)) {
            if (!item.radius && e.geomType === "CIRCLE") {
              const c = circleThrough3D(take(e.pointAt(0)), take(e.pointAt(1 / 3)), take(e.pointAt(2 / 3)));
              if (c) Object.assign(item, { radius: c.radius, centre: c.centre });
            }
            e.delete();
          }
        }
        found.push({ item, shape: face });
      }
    }
    const result: Measurement = { items: found.map((f) => f.item) };
    if (found.length === 2) {
      try {
        result.distance = measureDistanceBetween(found[0].shape, found[1].shape);
      } catch {
        // leave it out
      }
      const angle = angleBetween(picks[0].ref, picks[1].ref);
      if (angle !== null) result.angle = angle;
      const [a, b] = found.map((f) => f.item.centre);
      if (a && b) result.centreDistance = centreGap(a, b);
    }
    found.forEach((f) => f.shape.delete());
    return result;
  }

  /** Measure whole parts: each one's size, and between two of them the gap (0 if touching) and any overlap. */
  measureParts(partIds: string[]): Measurement {
    const chosen = partIds.slice(0, 2).map((id) => this.parts.find((p) => p.id === id)).filter((p): p is BuiltPart => !!p);
    const items: MeasuredItem[] = chosen.map((p) => {
      const b = boundsOf(p.shape);
      const centre: Vec3 = [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2, (b[0][2] + b[1][2]) / 2];
      let volume: number | undefined;
      try {
        volume = measureVolume(p.shape);
      } catch {
        // leave it out
      }
      return { label: p.name, centre, ...(volume !== undefined ? { volume } : {}) };
    });
    const result: Measurement = { items };
    if (chosen.length === 2) {
      try {
        result.distance = measureDistanceBetween(chosen[0].shape, chosen[1].shape);
      } catch {
        // leave it out
      }
      if (result.distance !== undefined && result.distance < 1e-6) {
        try {
          const common = chosen[0].shape.intersect(chosen[1].shape) as Shape3D;
          try {
            result.overlap = Math.max(0, measureVolume(common));
          } finally {
            common.delete();
          }
        } catch {
          // leave it out
        }
      }
      const [a, b] = items.map((i) => i.centre!);
      result.centreDistance = centreGap(a, b);
    }
    return result;
  }

  /** One 3MF file with each chosen part as a separate, named object. */
  export3mf(partIds: string[], quality: MeshQuality, title: string, colours: Record<string, string> = {}, instances?: InstanceInput[]): ThreeMfResult {
    const tol = MESH_TOLERANCES[quality];
    return this.withChosen(partIds, instances, (chosen) => {
    const meshes = chosen.map((p) => {
      const m = p.shape.mesh(tol);
      return { name: p.name, vertices: m.vertices, triangles: withoutDegenerateTriangles(m.vertices, m.triangles), colour: colours[p.id] };
    });
    const bytes = write3mf(meshes, title);
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return { data, triangleCount: meshes.reduce((n, m) => n + m.triangles.length / 3, 0) };
    });
  }

  /**
   * One STEP file containing the chosen parts (all when the list is empty).
   * STEP keeps the exact shape — curves stay curves — which is what most
   * manufacturers (machining, sheet metal, injection moulding) ask for.
   */
  async exportStep(partIds: string[], colours: Record<string, string> = {}, instances?: InstanceInput[]): Promise<StepResult> {
    return this.withChosen(partIds, instances, (chosen) => {
      const bytes = writeStep(chosen.map((p) => ({ shape: p.shape, name: p.name, colour: colours[p.id] ?? DEFAULT_PART_COLOUR })));
      return { step: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, partCount: chosen.length };
    });
  }

  get partCount(): number {
    return this.parts.length;
  }

  dispose(): void {
    this.disposeParts();
  }

  private meshPart(p: BuiltPart): PartMesh {
    // An imported part nothing has changed since: reuse its mesh (copied, as the arrays are handed over to the app).
    const key = p.meshKey && p.featureIds.length === 1 ? p.meshKey : null;
    const cached = key ? importedMeshes.get(key) : undefined;
    if (cached) {
      return {
        ...cached,
        id: p.id,
        name: p.name,
        featureIds: [...p.featureIds],
        vertices: cached.vertices.slice(),
        normals: cached.normals.slice(),
        triangles: cached.triangles.slice(),
        lines: cached.lines.slice(),
      };
    }
    const mesh = this.makePartMesh(p);
    if (key) {
      importedMeshes.set(key, { ...mesh, vertices: mesh.vertices.slice(), normals: mesh.normals.slice(), triangles: mesh.triangles.slice(), lines: mesh.lines.slice() });
      while (importedMeshes.size > IMPORTED_MESH_CACHE) importedMeshes.delete(importedMeshes.keys().next().value as string);
    }
    return mesh;
  }

  private makePartMesh(p: BuiltPart): PartMesh {
    const faces = p.shape.mesh(MESH_TOLERANCES.display);
    const edges = withoutSeams(p.shape, p.shape.meshEdges(MESH_TOLERANCES.display));
    // Describe each face and edge so picks can be found again after the next rebuild.
    const bounds = boundsOf(p.shape);
    const faceById = new Map<number, Face[]>();
    for (const f of facesOf(p.shape)) faceById.set(f.hashCode, [...(faceById.get(f.hashCode) ?? []), f]);
    const edgeById = new Map<number, Edge[]>();
    for (const e of edgesOf(p.shape)) edgeById.set(e.hashCode, [...(edgeById.get(e.hashCode) ?? []), e]);
    const unknownFace: FaceRef = { kind: "face", surface: "UNKNOWN", center: [0, 0, 0], normal: [0, 0, 0] };
    const unknownEdge: EdgeRef = { kind: "edge", curve: "UNKNOWN", a: [0, 0, 0], b: [0, 0, 0], mid: [0, 0, 0] };
    const faceRefs = faces.faceGroups.map((g) => {
      const f = faceById.get(g.faceId)?.shift();
      if (!f) return unknownFace;
      const ref = faceRefOf(f, bounds);
      f.delete();
      return ref;
    });
    const edgeRefs = edges.edgeGroups.map((g) => {
      const e = edgeById.get(g.edgeId)?.shift();
      if (!e) return unknownEdge;
      const ref = edgeRefOf(e, bounds);
      e.delete();
      return ref;
    });
    for (const list of [...faceById.values(), ...edgeById.values()]) list.forEach((x) => x.delete());
    return {
      id: p.id,
      name: p.name,
      featureIds: [...p.featureIds],
      vertices: Float32Array.from(faces.vertices),
      normals: Float32Array.from(faces.normals),
      triangles: Uint32Array.from(faces.triangles),
      faceGroups: faces.faceGroups,
      lines: Float32Array.from(edges.lines),
      edgeGroups: edges.edgeGroups,
      faceRefs,
      edgeRefs,
    };
  }

  private disposeBuild(b: StudioBuild): void {
    for (const p of b.parts) {
      try {
        p.shape.delete();
      } catch {
        // already freed
      }
    }
    for (const t of b.tools.values()) {
      try {
        t.shape.delete();
      } catch {
        // already freed
      }
    }
    b.parts = [];
    b.tools.clear();
  }

  private disposeParts(): void {
    for (const b of this.builds.values()) this.disposeBuild(b);
    this.builds.clear();
    this.parts = [];
    this.tools = new Map();
  }
}
