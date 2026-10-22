/**
 * The geometry engine: turns the feature list into solid parts using
 * OpenCascade (through replicad). Runs inside the Web Worker, and directly in
 * Node for the automated tests.
 */
import { basicFaceExtrusion, cast, makePolygon, Vector, getOC, makeCompound, makeProjectedEdges, ProjectionCamera, makeBox, measureArea, measureDistanceBetween, measureLength, makeCylinder, makeVertex, makeSphere, measureVolume, type Edge, type Face, type Shape3D } from "replicad";

import { analyzeMesh, estimateThickness, withoutDegenerateTriangles } from "../geometry/meshCheck";
import { writeBinaryStl } from "../geometry/stl";
import { matchRefs, refDistance, relativeTo, roundVec, type EdgeRef, type FaceRef, type TopoPick, type Vec3 } from "../geometry/topoRef";
import { FEATURE_DEFS, isPatternFeature, isPickFeature, isSolidFeature, resolveParams } from "../model/features";
import { planeFrame, toWorld } from "../sketch/planes";
import { planeFeatureFrame } from "../sketch/planeFeature";
import { getCurrentScope, setCurrentScope } from "../model/expr";
import { MESH_TOLERANCES, type Axis, type Feature, type ImportedFile, type MeshQuality, type Operation } from "../model/types";
import { deleteFaces, draftFaces, extrudeSketch } from "./extrude";
import { centreRevolve, revolveSketch } from "./revolve";
import { holeTool, type ThreadedHoleCache } from "./hole";
import { HOLE_LEAD_IN, SCREW_SIZES, straightStart, type HoleSize } from "../model/holes";
import { copyNumber, isSkipped } from "../model/patterns";
import { materialRuns, shapeDistance, upToFaceSolid, upToPartsSolid } from "./upTo";
import { loftSketches, sweepSketch } from "./sweep";
import { textSolid, wrappedTextSolid, wrapShapes, wrapStart, type Cylinder } from "./textSolid";
import { offsetSolid, shellByCutting } from "./surface";
import { encloseSurfaces, extendSurface, extrudeSurface, fillEdges, gapReport, gathered, joinSurfaces, loftSurface, offsetSurface, removeFaces, revolveSurface, ruledSurface, splitBySurface, sweepSurface, thickenSurface } from "./surface";
import { grooveVolume, threadPieces } from "./thread";
import { fastenerSolid } from "./fastener";
import { coilSolid } from "./thread";
import { pathStations, walkPath } from "../sketch/pathSample";
import { findRegions } from "../sketch/regions";
import { openChain, profileSheet } from "../sheetmetal/profile";
import { chainLoops, cornerBreakCut, findSheetCorner, findSheetEdge, flatPattern, flatPoint, foldSheet, jogSpacing, mapSegments, outlinePoints, sideAreas, turnBetween, wallOnPlane, type CornerBreak, type FlangeSpec, type FoldedSheet, type P2, type SheetSpec } from "../sheetmetal/sheet";
import { bendCutLines, bendCutToFlat, bendSolid, cornerReliefSolid, cutFlatCornerReliefs, cutFlatLoops, flatBoundary, fusePieces, unfoldedSolid, wallCutLines, wallSolid } from "./sheetMetal";
import { flatProjection, outsideOnly } from "../sheetmetal/flatExport";
import { fastenerName, fastenerSize, hasLength, shankOf } from "../model/fasteners";
import { measureContacts } from "./clash";
import type { CheckResult, ContactMeasure, ExportResult, FlatPatternData, InstanceInput, PartMesh, RebuildResult, StepResult, StudioInput, ThreeMfResult, ViewProjection } from "./protocol";
import { VIEW_CAMERAS } from "../drawing/cameras";
import { fromRel, sectionGeometry, type BreakOutRequest, type SectionRequest } from "../drawing/sections";
import { dropCoveredHidden } from "../drawing/hidden";
import type { ViewKind } from "../model/types";
import { write3mf } from "../geometry/threeMf";
import { DEFAULT_PART_COLOUR } from "../model/colours";
import { writeStep } from "./stepExport";
import { importKey, importSolids, isImportedSurface } from "./importer";
import { edgesOf, facesOf, shellsOf, solidsOf } from "./topology";
import { angleBetween, centreGap, circleThrough3D, describePick, type MeasuredItem, type Measurement } from "../geometry/measureMath";

/** Id of the first Part Studio (matches MAIN_STUDIO in model/studios.ts). */
const MAIN_STUDIO_ID = "main";

interface BuiltPart {
  /** Built in another configuration, only for assemblies (left out when "all parts" are meant). */
  configured?: boolean;
  id: string;
  name: string;
  featureIds: string[];
  shape: Shape3D;
  /** For a part straight from an imported file: identifies its display mesh, which is kept between rebuilds while the part is unchanged. */
  meshKey?: string;
  /** A surface: a thin skin with no inside. */
  surface?: boolean;
  /**
   * Threads on it (modelled or not), for drawing them the standard way: the
   * axis, how far along it they run, the outside and root diameters, and
   * whether it's a rod's (external) or a hole's (internal).
   */
  threads?: ThreadMark[];
  /** Sheet metal parts: the sheet they're folded from (for flanges and the flat pattern), and the features that made it. */
  sheet?: SheetSpec;
  sheetFeatures?: string[];
  /**
   * Cuts made in the sheet afterwards, traced on its walls (in each wall's own coordinates) and its bends (`bend`:
   * the flange whose bend it is, in the bend's unrolled coordinates), for the flat pattern.
   */
  sheetCuts?: { wall: string; bend?: string; lines: [[number, number], [number, number]][] }[];
}

interface ThreadMark {
  origin: Vec3;
  axis: Vec3;
  from: number;
  to: number;
  major: number;
  minor: number;
  external: boolean;
}

/**
 * Threads drawn the standard way (ISO 6410) on a view looking along `toward`.
 * Seen from the side: thin lines along the thread at its root diameter for a
 * rod (the outline already shows its outside), or dashed at its outside
 * diameter for a hole. Seen end-on: a thin three-quarter circle at the root
 * diameter of a rod or the outside diameter of a hole.
 */
export function threadMarkLines(marks: ThreadMark[], toward: Vec3, right: Vec3, up: Vec3): { line: number[]; hidden: boolean }[] {
  const flat = (p: Vec3): [number, number] => [dot3(p, right), dot3(p, up)];
  const out: { line: number[]; hidden: boolean }[] = [];
  for (const m of marks) {
    const along = dot3(m.axis, toward);
    const r = (m.external ? m.minor : m.major) / 2;
    if (Math.abs(along) > 0.999) {
      // End-on: three quarters round, the top-right quarter left open.
      const [cx, cy] = flat(m.origin);
      const arc: number[] = [];
      for (let i = 0; i <= 36; i++) {
        const a = Math.PI / 2 + (i / 36) * 1.5 * Math.PI;
        arc.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
      }
      out.push({ line: arc, hidden: false });
    } else if (Math.abs(along) < 1e-3) {
      const at = (t: number): Vec3 => [m.origin[0] + m.axis[0] * t, m.origin[1] + m.axis[1] * t, m.origin[2] + m.axis[2] * t];
      const [ax, ay] = flat(at(m.from));
      const [bx, by] = flat(at(m.to));
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 1e-9) continue;
      const nx = (-(by - ay) / L) * r;
      const ny = ((bx - ax) / L) * r;
      for (const sgn of [1, -1]) out.push({ line: [ax + sgn * nx, ay + sgn * ny, bx + sgn * nx, by + sgn * ny], hidden: !m.external });
    }
  }
  return out;
}

/** `v` turned `angle` radians about the unit direction `k` (Rodrigues). */
function rotateAbout(v: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = dot3(k, v);
  const x = cross3(k, v);
  return [v[0] * c + x[0] * s + k[0] * d * (1 - c), v[1] * c + x[1] * s + k[1] * d * (1 - c), v[2] * c + x[2] * s + k[2] * d * (1 - c)];
}

/** A fastener's thread, for drawings (whether it's modelled or not): along a screw's shank, or through a nut. */
function fastenerThreads(feature: Feature, v: Record<string, number>): ThreadMark[] {
  const f = feature.fastener;
  const s = f ? fastenerSize(f.size) : undefined;
  if (!f || !s || f.kind === "washer") return [];
  const minor = s.d - 1.0825 * s.pitch;
  const axis: Vec3 = [0, 0, 1];
  const origin: Vec3 = [v.x, v.y, v.z];
  if (f.kind === "nut") return [{ origin, axis, from: 0, to: s.nut, major: s.d, minor, external: false }];
  const shank = shankOf(f.kind, s, v.length);
  return [{ origin, axis, from: shank.top - shank.length, to: shank.top, major: s.d, minor, external: true }];
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
/** True when two boxes (min and max corners) overlap or touch. */
const boxesOverlap = (a: [Vec3, Vec3], b: [Vec3, Vec3]) => [0, 1, 2].every((k) => a[0][k] <= b[1][k] + 1e-6 && b[0][k] <= a[1][k] + 1e-6);
/** A length for a message: at most two decimals ("2.5", not "2.500000001"). */
const fmt = (x: number) => String(Math.round(x * 100) / 100);

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
 * Seams: the line down the side of a cylinder, cone or sphere where the
 * surface meets itself (a face's outline runs along it twice). Onshape doesn't
 * show those (they aren't real edges of the shape), and clicking one would get
 * in the way of picking the round face. The free edges of a surface (a skin)
 * are real edges, and are kept.
 */
export function seamEdgeIds(shape: Shape3D): Set<number> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const seams = new Set<number>();
  for (const f of facesOf(shape)) {
    try {
      // A seam runs round the face twice (once each way), so it turns up twice when the face's edges are walked.
      const seen = new Map<number, number>();
      const explorer = new oc.TopExp_Explorer(f.wrapped, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      try {
        for (; explorer.More(); explorer.Next()) {
          const h = oc.ReplicadShapeHasher.HashCode(explorer.Current(), 2147483647) as number;
          seen.set(h, (seen.get(h) ?? 0) + 1);
        }
      } finally {
        explorer.delete();
      }
      for (const [h, n] of seen) if (n > 1) seams.add(h);
    } finally {
      f.delete();
    }
  }
  return seams;
  /* eslint-enable @typescript-eslint/no-explicit-any */
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
    // The tip a drill leaves at the bottom of a blind hole (a narrower cone on the end) counts as part of it here.
    let tipLo = lo;
    let tipHi = hi;
    for (const b of g.bits) {
      if (b.kind !== "cone" || extras.includes(b)) continue;
      if (near(b.hi, tipLo)) tipLo = b.lo;
      else if (near(b.lo, tipHi)) tipHi = b.hi;
    }
    // Is there material just past this end? Past a blind hole's bottom the part is within `step`
    // (or all round); past an open end the nearest material is the rim, further away than that.
    const step = Math.min(0.5, r * 0.5);
    const open = (t: number, out: number) => {
      const v = makeVertex(at(t + out * step));
      try {
        return measureDistanceBetween(shape, v) > (step + Math.hypot(step, r)) / 2;
      } catch {
        return false;
      } finally {
        v.delete();
      }
    };
    const openHi = open(tipHi, 1);
    const openLo = open(tipLo, -1);
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
 * Like replicad's makeProjectedEdges, but leaving out tangent edges (where
 * faces meet smoothly, e.g. along the sides of a fillet): only sharp edges and
 * outlines.
 */
function projectedEdgesWithoutTangents(shape: Shape3D, camera: ProjectionCamera, withHidden: boolean): { visible: Edge[]; hidden: Edge[] } {
  const oc = getOC();
  const algo = new oc.HLRBRep_Algo();
  const projector = new oc.HLRAlgo_Projector(camera.wrapped);
  // Mark which edges are smooth (faces meeting at under ~0.1°), so the hidden-line pass can tell them apart.
  oc.BRepLib.EncodeRegularity(shape.wrapped, 2e-3);
  const toShape = (() => {
    algo.Add(shape.wrapped, 0);
    algo.Projector(projector);
    algo.Update();
    algo.Hide();
    return new oc.HLRBRep_HLRToShape(algo);
  })();
  const edges = (c: { IsNull(): boolean }) => (c.IsNull() ? [] : (cast(c as never) as unknown as { edges: Edge[] }).edges);
  try {
    const visible = [...edges(toShape.VCompound()), ...edges(toShape.OutLineVCompound())];
    const hidden = withHidden ? [...edges(toShape.HCompound()), ...edges(toShape.OutLineHCompound())] : [];
    for (const e of [...visible, ...hidden]) oc.BRepLib.BuildCurves3d(e.wrapped as never);
    return { visible, hidden };
  } finally {
    toShape.delete();
    projector.delete();
    algo.delete();
  }
}

/**
 * One drawing view: the shape seen along `toward`, with the lines hidden
 * behind it (when asked), its circles for dimensions, and the centre lines of
 * round faces seen from the side (`axes`, in 3D).
 */
function projectView(shape: Shape3D, kind: string, toward: Vec3, right: Vec3, withHidden: boolean, axes: [Vec3, Vec3][], tangent = true): ViewProjection {
  const up = cross3(toward, right);
  const flat = (p: Vec3): [number, number] => [dot3(p, right), dot3(p, up)];
  const camera = new ProjectionCamera([0, 0, 0], toward, right);
  try {
    const { visible, hidden } = tangent ? makeProjectedEdges(shape, camera, withHidden) : projectedEdgesWithoutTangents(shape, camera, withHidden);
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
  // What's left: solids, or (for a surface, which has no inside) faces.
  const solids = solidsOf(cut);
  const pieces = solids.length ? solids : facesOf(cut);
  pieces.forEach((x) => x.delete());
  if (pieces.length === 0) {
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

/**
 * One picked face, found on the part as it is now. When several faces look
 * just the same (the inside and outside of a pipe share an axis and centre),
 * the one nearest where it was clicked is taken.
 */
function findPickedFace(shape: Shape3D, pick: TopoPick): Face {
  if (!pick.at) return findPickedFaces(shape, [pick])[0];
  const faces = facesOf(shape);
  const bounds = boundsOf(shape);
  const size = Math.hypot(bounds[1][0] - bounds[0][0], bounds[1][1] - bounds[0][1], bounds[1][2] - bounds[0][2]);
  const gaps = faces.map((f) => refDistance(pick.ref, faceRefOf(f, bounds), size));
  const best = Math.min(...gaps);
  const near = faces.filter((_, i) => gaps[i] <= best + 1e-6 && Number.isFinite(best) && best <= Math.max(1, 0.3 * size));
  if (near.length <= 1) {
    faces.forEach((f) => f.delete());
    return findPickedFaces(shape, [pick])[0];
  }
  const point = makeVertex(pick.at);
  const chosen = near.map((f) => ({ f, d: shapeDistance(point, f) })).sort((a, b) => a.d - b.d)[0].f;
  point.delete();
  faces.forEach((f) => f !== chosen && f.delete());
  return chosen;
}

/**
 * A chamfer that isn't the same both ways: `first` mm along one face and
 * `second` mm along the other ("twoDistances"), or `first` mm along one face at
 * `second` degrees ("distanceAngle"). The first distance runs along the face
 * that was picked, or — for a picked edge — the face beside it that faces most
 * upwards (then most towards +Y, then +X); `flip` swaps to the other face.
 */
function lopsidedChamfer(shape: Shape3D, picks: TopoPick[], kind: "twoDistances" | "distanceAngle", first: number, second: number, flip: boolean): Shape3D {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const faces = facesOf(shape);
  const pickedFaces = picks.some((p) => p.ref.kind === "face") ? findPickedFaces(shape, picks.filter((p) => p.ref.kind === "face")) : [];
  const pickedEdges = picks.some((p) => p.ref.kind === "edge") ? findPickedEdges(shape, picks.filter((p) => p.ref.kind === "edge")) : [];
  const items: { edge: Edge; face: Face }[] = [];
  const extra: Edge[] = [];
  const beside = (e: Edge) =>
    faces.filter((f) => {
      const es = edgesOf(f);
      const hit = es.some((x) => x.isSame(e));
      es.forEach((x) => x.delete());
      return hit;
    });
  const upness = (f: Face): Vec3 => {
    try {
      const n = take(f.normalAt(take(f.center)));
      return [n[2], n[1], n[0]];
    } catch {
      return [0, 0, 0];
    }
  };
  const add = (edge: Edge, preferred: Face | null) => {
    if (items.some((i) => i.edge.isSame(edge))) return;
    const two = beside(edge);
    // A seam, or a free edge: nothing to bevel between.
    if (two.length !== 2) return;
    let face: Face;
    if (preferred) face = two.find((f) => (flip ? !f.isSame(preferred) : f.isSame(preferred))) ?? two[0];
    else {
      const [a, b] = two.map(upness);
      const aFirst = a[0] - b[0] > 1e-6 || (Math.abs(a[0] - b[0]) <= 1e-6 && (a[1] - b[1] > 1e-6 || (Math.abs(a[1] - b[1]) <= 1e-6 && a[2] >= b[2])));
      face = aFirst !== flip ? two[0] : two[1];
    }
    items.push({ edge, face });
  };
  const builder = new oc.BRepFilletAPI_MakeChamfer(shape.wrapped);
  try {
    for (const f of pickedFaces) {
      for (const e of edgesOf(f)) {
        extra.push(e);
        add(e, f);
      }
    }
    for (const e of pickedEdges) add(e, null);
    if (!items.length) throw new Error("There are no edges here to bevel (a ball's face has none). Click edges, or faces with edges round them.");
    for (const { edge, face } of items) {
      if (kind === "twoDistances") builder.Add(first, second, edge.wrapped, face.wrapped);
      else builder.AddDA(first, (second * Math.PI) / 180, edge.wrapped, face.wrapped);
    }
    return cast(builder.Shape()) as Shape3D;
  } finally {
    builder.delete();
    [...faces, ...pickedFaces, ...pickedEdges, ...extra].forEach((x) => {
      try {
        x.delete();
      } catch {
        // already freed
      }
    });
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
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

/**
 * Shell with the walls outside: the faces are pushed out by `thickness`, with
 * sharp outside corners (like the part grown all round), the picked faces left
 * open, and the part itself becoming the space inside.
 */
function outwardShell(shape: Shape3D, open: Face[], thickness: number): Shape3D {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const list = new oc.NCollection_List_TopoDS_Shape();
  const builder = new oc.BRepOffsetAPI_MakeThickSolid();
  try {
    for (const f of open) list.Append(f.wrapped);
    builder.MakeThickSolidByJoin(shape.wrapped, list, thickness, 1e-3, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Intersection, false);
    return cast(builder.Shape()) as Shape3D;
  } finally {
    builder.delete();
    list.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

const OUTWARD_FAILED = "Couldn't build walls round the outside of this part. Try putting the walls inside instead (untick Walls outside).";
const OUTWARD_APART =
  "With those faces left open, the walls outside would come apart into separate pieces (where the open face meets the part's other faces). Leave a different face open, or put the walls inside instead (untick Walls outside). Where a gap or slot is narrower than twice the wall thickness, thinner walls may help.";
const OUTWARD_OPEN_FAILED = "Couldn't build walls round the outside with those faces left open. Try leaving different faces open, or put the walls inside instead (untick Walls outside). Where a gap or slot is narrower than twice the wall thickness, thinner walls may help.";
const OUTWARD_CURVED_OPEN = "Walls outside can only leave flat faces open, not curved ones. Leave a flat face open, or put the walls inside instead (untick Walls outside).";

/**
 * Walls outside, the slow sure way: sealed walls all round (the part grown by
 * `thickness`, minus the part); then, for each flat face left open, the walls
 * over that face (its rims, a wall's thickness to the side, and any wall past
 * the plane joined on to those) are cut off at its plane — but not the cover (and rims) over other faces in the same plane
 * that aren't open, nor the walls round any of the part that stands out past the plane (a
 * boss on an open top keeps its whole sleeve, down to the face). Curved open
 * faces aren't handled.
 */
function outwardByCutting(shape: Shape3D, open: Face[], thickness: number): Shape3D {
  const grown = offsetSolid(shape, thickness);
  let walls: Shape3D;
  try {
    walls = grown.cut(shape);
  } finally {
    grown.delete();
  }
  const reach = thickness * 1.01 + 0.01;
  const scrap: Shape3D[] = [];
  const keepAway = (cutter: Shape3D, what: Shape3D): Shape3D => {
    const next: Shape3D = cutter.cut(what);
    cutter.delete();
    return next;
  };
  const allFaces = facesOf(shape);
  try {
    for (const face of open) {
      if (face.geomType !== "PLANE") throw new Error("curved opening");
      const centre = take(face.center);
      const normal = take(face.normalAt(centre));
      const along = (f: Face, d: number) => {
        const v = new Vector([normal[0] * d, normal[1] * d, normal[2] * d]);
        try {
          return basicFaceExtrusion(f, v) as Shape3D;
        } finally {
          v.delete();
        }
      };
      // Over the face, widened by a wall's thickness all round (its rims), past its plane only.
      const over = along(face, reach);
      scrap.push(over);
      const widened = offsetSolid(over, reach);
      const beyond = halfSpace(walls, centre, normal);
      scrap.push(widened, beyond);
      let cutter = widened.intersect(beyond) as Shape3D;
      // And all of any piece of wall past the plane that runs on from there (the wrap round rounded edges).
      const wallsPast = walls.intersect(beyond) as Shape3D;
      scrap.push(wallsPast);
      for (const piece of solidsOf(wallsPast)) {
        try {
          const shared = piece.intersect(widened) as Shape3D;
          let touches = false;
          try {
            touches = measureVolume(shared) > 1e-9;
          } catch {
            touches = false;
          } finally {
            shared.delete();
          }
          if (touches) {
            const next: Shape3D = cutter.fuse(piece);
            cutter.delete();
            cutter = next;
          }
        } finally {
          piece.delete();
        }
      }
      // Other faces in the same plane, facing the same way, that aren't open keep their cover.
      for (const other of allFaces) {
        if (other.geomType !== "PLANE" || open.some((o) => o.isSame(other))) continue;
        const c = take(other.center);
        const n = take(other.normalAt(c));
        if (dot3(n, normal) < 1 - 1e-9 || Math.abs(dot3([c[0] - centre[0], c[1] - centre[1], c[2] - centre[2]], normal)) > 1e-6) continue;
        // Its cover and rims: swept and widened just as the open face's are.
        const swept = along(other, reach);
        let cover: Shape3D;
        try {
          cover = offsetSolid(swept, reach);
        } finally {
          swept.delete();
        }
        try {
          cutter = keepAway(cutter, cover);
        } finally {
          cover.delete();
        }
      }
      // The part past the plane (each separate piece of it), with its own walls round it: those stay.
      const past = shape.intersect(beyond) as Shape3D;
      scrap.push(past);
      for (const piece of solidsOf(past)) {
        try {
          if (measureVolume(piece) <= 1e-6) continue;
          const keep = offsetSolid(piece, thickness);
          try {
            cutter = keepAway(cutter, keep);
          } finally {
            keep.delete();
          }
        } finally {
          piece.delete();
        }
      }
      try {
        const next: Shape3D = walls.cut(cutter);
        walls.delete();
        walls = next;
      } finally {
        cutter.delete();
      }
    }
    return walls;
  } catch (e) {
    walls.delete();
    throw e;
  } finally {
    [...scrap, ...allFaces].forEach((x) => {
      try {
        x.delete();
      } catch {
        // already freed
      }
    });
  }
}

/**
 * True when `after` (walls built round `before`) has some volume, and sticks out
 * past `before` by no more than `by` (plus a little) on any side.
 */
function grewWithin(before: Shape3D, after: Shape3D, by: number): boolean {
  try {
    if (!(measureVolume(after) > 1e-6)) return false;
    const [a0, a1] = boundsOf(before);
    const [b0, b1] = boundsOf(after);
    const tol = 1e-3 + 1e-6 * Math.hypot(a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]) + by * 1e-3;
    return [0, 1, 2].every((i) => b0[i] >= a0[i] - by - tol && b1[i] <= a1[i] + by + tol);
  } catch {
    return false;
  }
}

/** True when the shape is at least one solid and passes OpenCascade's own check. */
/** The surfaces (skins) in an imported file, as one shape, or null when it has none. */
function importedSurface(file: ImportedFile): Shape3D | null {
  const shapes = importSolids(file);
  let skin: Shape3D | null = null;
  for (const s of shapes) {
    if (isImportedSurface(s) && !skin) skin = s;
    else s.delete();
  }
  return skin;
}

function isValidSolid(shape: Shape3D, surface = false): boolean {
  try {
    const pieces = surface ? facesOf(shape) : solidsOf(shape);
    const count = pieces.length;
    pieces.forEach((x) => x.delete());
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

function buildSolid(feature: Feature, v: Record<string, number>, sketches: SketchMap, all: Feature[], parts: BuiltPart[], threaded?: ThreadedHoleCache): Shape3D {
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
        const ropts = { axis: opts.axis, angle: v.angle, flip: opts.flip, areas: feature.areas };
        const { plane, data } = sketch.sketch;
        const shape = feature.surface ? revolveSurface(plane, data, ropts) : revolveSketch(plane, data, ropts);
        // Symmetric: half the angle each way from the sketch.
        return opts.symmetric ? centreRevolve(shape, plane, data, ropts) : shape;
      }
      const opts = feature.extrude ?? { end: "blind", flip: false };
      if (feature.surface) {
        if (opts.end !== "blind" && opts.end !== "symmetric") throw new Error("A surface can be extruded a set depth (or symmetric), not through all or up to a face.");
        return extrudeSurface(sketch.sketch.plane, sketch.sketch.data, { depth: v.depth, end: opts.end, flip: opts.flip });
      }
      if (opts.end === "throughAll") {
        if (feature.operation !== "remove") throw new Error("Through all only works with Remove — it cuts right through the part.");
        // Long enough to pass through every part, both ways from the sketch.
        const depth = 2 * reach(sketch.sketch.plane, parts) + 2;
        return extrudeSketch(sketch.sketch.plane, sketch.sketch.data, { depth, end: "symmetric", flip: false, areas: feature.areas });
      }
      const frame = planeFrame(sketch.sketch.plane);
      const n = frame.n;
      const offset = v.offset ?? 0;
      /** A one-way extrude ending `d` mm along the sketch's normal (minus: the other way), moved on by the offset. */
      const toDistance = (d: number, what: string) => {
        const total = d + Math.sign(d) * offset;
        if (Math.abs(d) < 1e-6) throw new Error(`That ${what} is level with the sketch, so there's nothing to extrude. Pick another.`);
        if (Math.sign(total) !== Math.sign(d) || Math.abs(total) < 1e-6) {
          throw new Error(`The offset takes the end back past the sketch. Make the offset smaller than ${fmt(Math.abs(d))} mm.`);
        }
        return extrudeSketch(sketch.sketch!.plane!, sketch.sketch!.data, { depth: Math.abs(total), end: "blind", flip: total < 0, draft: v.draft, areas: feature.areas });
      };
      /** A long one-way extrude, to be cut back to where it should stop. */
      const long = (flip: boolean) => {
        const length = 2 * reach(sketch.sketch!.plane!, parts) + 2;
        return { length, shape: extrudeSketch(sketch.sketch!.plane!, sketch.sketch!.data, { depth: length, end: "blind", flip, areas: feature.areas }) };
      };
      if (opts.end === "upToFace") {
        if (!opts.upTo || opts.upTo.ref.kind !== "face") throw new Error("Click the face to extrude up to.");
        const part = parts.find((p) => p.id === opts.upTo!.partId);
        if (!part) throw new Error("The part with the face to extrude up to has gone. Edit this extrude and pick another face.");
        const face = findPickedFace(part.shape, opts.upTo);
        try {
          const centre = take(face.center);
          if (face.geomType === "PLANE") {
            const normal = take(face.normalAt(centre));
            const d = (centre[0] - frame.origin[0]) * n[0] + (centre[1] - frame.origin[1]) * n[1] + (centre[2] - frame.origin[2]) * n[2];
            // Parallel to the sketch: a plain extrude of the right depth (draft allowed).
            if (Math.abs(dot3(normal, n)) >= 0.999) return toDistance(d, "face");
            if (Math.abs(dot3(normal, n)) < 1e-3) throw new Error("That face runs alongside the extrude (parallel to its direction), so the extrude would never reach it. Pick a face across its path.");
          }
          // Slanted or curved: extrude well past it, then cut back to the face.
          if (Math.abs(v.draft) > 1e-9) throw new Error("A draft only works up to a flat face parallel to the sketch. Set the draft to 0 for this face.");
          const ahead = dot3([centre[0] - frame.origin[0], centre[1] - frame.origin[1], centre[2] - frame.origin[2]], n);
          const flip = Math.abs(ahead) > 1e-6 ? ahead < 0 : opts.flip;
          const { length, shape } = long(flip);
          try {
            const dir: Vec3 = flip ? [-n[0], -n[1], -n[2]] : n;
            return upToFaceSolid(shape, frame.origin, dir, length, face, offset);
          } finally {
            shape.delete();
          }
        } finally {
          face.delete();
        }
      }
      if (opts.end === "upToVertex") {
        if (!opts.upTo || opts.upTo.ref.kind !== "edge") throw new Error("Click near the end of an edge: that corner is where the extrude stops.");
        const part = parts.find((p) => p.id === opts.upTo!.partId);
        if (!part) throw new Error("The part with the corner to extrude up to has gone. Edit this extrude and pick another.");
        const ref = opts.upTo.ref;
        const want = opts.upToEnd === "b" ? ref.b : ref.a;
        const [edge] = findPickedEdges(part.shape, [opts.upTo]);
        let corner: Vec3;
        try {
          const ends = [take(edge.startPoint), take(edge.endPoint)];
          corner = ends.sort((p, q) => Math.hypot(...p.map((x, k) => x - want[k])) - Math.hypot(...q.map((x, k) => x - want[k])))[0];
        } finally {
          edge.delete();
        }
        return toDistance(dot3([corner[0] - frame.origin[0], corner[1] - frame.origin[1], corner[2] - frame.origin[2]], n), "corner");
      }
      if (opts.end === "upToNext" || opts.end === "upToPart") {
        let stops: BuiltPart[];
        let what: string;
        if (opts.end === "upToPart") {
          const part = opts.upTo ? parts.find((p) => p.id === opts.upTo!.partId) : undefined;
          if (!opts.upTo) throw new Error("Click the part to extrude up to.");
          if (!part) throw new Error("The part to extrude up to has gone. Edit this extrude and click another part.");
          stops = [part];
          what = part.name;
        } else {
          stops = parts.filter((p) => !p.surface);
          what = "a part";
        }
        // Up to next cuts through the wall it starts in; otherwise it fills the gap up to the part.
        const keep = opts.end === "upToNext" && (feature.operation === "remove" || feature.operation === "intersect") ? "material" : "air";
        const { length, shape } = long(opts.flip);
        try {
          const dir: Vec3 = opts.flip ? [-n[0], -n[1], -n[2]] : n;
          return upToPartsSolid(shape, frame.origin, dir, length, stops.map((p) => p.shape), keep, what);
        } finally {
          shape.delete();
        }
      }
      const second = opts.end === "blind" && opts.second ? v.depth2 : 0;
      return extrudeSketch(sketch.sketch.plane, sketch.sketch.data, { depth: v.depth, end: opts.end, flip: opts.flip, draft: v.draft, depth2: second, areas: feature.areas });
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
      if (feature.surface) return sweepSurface(profile.plane!, profile.data, path.plane!, path.data);
      return sweepSketch(profile.plane!, profile.data, path.plane!, path.data, feature.areas);
    }
    case "wrap": {
      // A sketch's closed shapes wrapped round a round face, raised (Add) or engraved (Remove).
      if (!feature.sketchRef) throw new Error("Choose a sketch with the shapes to wrap.");
      const sketch = sketches.get(feature.sketchRef);
      if (!sketch?.sketch) throw new Error("Its sketch has been deleted, or comes after this in the list. Pick another sketch.");
      const pick = feature.picks?.find((p) => p.ref.kind === "face");
      if (!pick) throw new Error("Click the round face to wrap the shapes round.");
      const part = parts.find((p) => p.id === pick.partId);
      if (!part) throw new Error("The part it was wrapped round no longer exists. Click a round face.");
      const { regions } = findRegions(sketch.sketch.data);
      if (!regions.length) throw new Error("The sketch has no closed shapes to wrap.");
      const shapes = regions.map((r) => ({ outer: r.outer.polygon, holes: r.holes.map((h) => h.polygon) }));
      const xs = shapes.flatMap((sh) => sh.outer.map((p) => p[0]));
      const ys = shapes.flatMap((sh) => sh.outer.map((p) => p[1]));
      const centre: [number, number] = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
      const [face] = findPickedFaces(part.shape, [pick]);
      if (!face) throw new Error("The round face it was wrapped round can't be found any more. Click it again.");
      try {
        const cyl = cylinderOfFace(face);
        if (!cyl) throw new Error("Wrap goes round a round (cylinder) face. Click the side of a rod, boss or hole.");
        const start = wrapStart(cyl, take(face.center));
        const onSurface: Vec3 = [0, 1, 2].map((i) => cyl.origin[i] + cyl.axis[i] * start.height + start.radial[i] * cyl.radius) as Vec3;
        let convex = true;
        try {
          convex = dot3(take(face.normalAt(onSurface)), start.radial) > 0;
        } catch {
          // no normal there: assume the outside of a rod
        }
        return wrapShapes(cyl, start, convex, shapes, centre, { depth: v.depth, x: v.x, y: v.y, angle: v.angle, flip: feature.operation === "remove" }, "A shape is too wide to wrap — it would go more than once round the face. Make it smaller.");
      } finally {
        face.delete();
      }
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
      if (feature.surface) return loftSurface(sections);
      return loftSketches(sections);
    }
    case "fill": {
      const picks = (feature.picks ?? []).filter((p) => p.ref.kind === "edge");
      if (!picks.length) throw new Error("Click the edges round the opening to fill (on any parts).");
      const edges: Edge[] = [];
      try {
        const supports: (Face | null)[] = [];
        const allFaces: Face[] = [];
        for (const partId of new Set(picks.map((p) => p.partId))) {
          const part = parts.find((p) => p.id === partId);
          if (!part) throw new Error("A part the edges were on no longer exists. Edit this and pick the edges again.");
          const found = findPickedEdges(part.shape, picks.filter((p) => p.partId === partId));
          edges.push(...found);
          if (feature.continuity) {
            // The face beside each edge, to meet smoothly.
            const faces = facesOf(part.shape);
            allFaces.push(...faces);
            for (const edge of found) {
              supports.push(
                faces.find((f) => {
                  const mine = edgesOf(f);
                  const has = mine.some((e) => e.isSame(edge));
                  mine.forEach((e) => e.delete());
                  return has;
                }) ?? null,
              );
            }
          }
        }
        try {
          return fillEdges(edges, feature.continuity ? { supports } : undefined);
        } finally {
          allFaces.forEach((f) => f.delete());
        }
      } finally {
        edges.forEach((e) => e.delete());
      }
    }
    case "ruled": {
      const picks = (feature.picks ?? []).filter((p) => p.ref.kind === "edge");
      if (!picks.length) throw new Error("Click the edges to sweep the strips from (on any parts).");
      const frame = planeFrame(feature.neutral ?? { kind: "default", name: "Top" });
      const sign = feature.flipSide ? -1 : 1;
      const edges: Edge[] = [];
      try {
        for (const partId of new Set(picks.map((p) => p.partId))) {
          const part = parts.find((p) => p.id === partId);
          if (!part) throw new Error("A part the edges were on no longer exists. Edit this and pick the edges again.");
          edges.push(...findPickedEdges(part.shape, picks.filter((p) => p.partId === partId)));
        }
        return ruledSurface(edges, [frame.n[0] * sign, frame.n[1] * sign, frame.n[2] * sign], v.distance, v.angle);
      } finally {
        edges.forEach((e) => e.delete());
      }
    }
    case "offsetSurface": {
      const pick = feature.picks?.find((p) => p.ref.kind === "face");
      if (!pick) throw new Error("Click a face of the surface to offset.");
      const part = parts.find((p) => p.id === pick.partId);
      if (!part) throw new Error("The surface no longer exists. Click a face of another.");
      if (!part.surface) throw new Error("Offset surface works on surfaces (skins). For a solid, use Move face or Shell.");
      if (Math.abs(v.distance) < 1e-9) throw new Error("Distance: enter how far to move the surface (minus for the other side).");
      return offsetSurface(part.shape, v.distance);
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
      const span = 2 * reach(sketch.sketch.plane, parts) + 2;
      const back = through && h.bothWays ? span : 0;
      const size: HoleSize = {
        kind: h.kind,
        diameter: v.diameter,
        depth: v.depth,
        throughAll: through,
        throughLength: through ? span : 0,
        // Through all, both ways (if asked): also back the other way, so a sketch inside the part drills right through.
        ...(back ? { backLength: back } : {}),
        cboreDiameter: v.cboreDiameter,
        cboreDepth: v.cboreDepth,
        cskDiameter: v.cskDiameter,
        cskAngle: v.cskAngle,
      };
      const screw = h.fit === "tapped" ? SCREW_SIZES.find((x) => x.name === h.standard) : undefined;
      if (screw && h.end === "blind" && v.threadDepth > v.depth + 1e-9) {
        throw new Error(`The thread (${fmt(v.threadDepth)} mm) is deeper than the hole (${fmt(v.depth)} mm). Make the thread depth smaller, or the hole deeper.`);
      }
      const target = [...parts].reverse().find((p) => !p.surface);
      if (h.end === "upToNext" && !target) throw new Error("There's no part to drill into yet. Make a part first.");
      /** This hole's depth (up to next: through the first wall the drill meets, passing over any gap before it). */
      const drilled = (at: Vec3, dir: Vec3): HoleSize => {
        if (h.end !== "upToNext") return size;
        const runs = materialRuns(target!.shape, at, dir, v.diameter / 2, span);
        if (runs.length === 0) {
          throw new Error(`The hole at (${at.map(fmt).join(", ")}) doesn't meet the part going that way. Tick Flip direction, or move the point onto the part.`);
        }
        const [, exit] = runs[0];
        // Just past the far side so the drill breaks through cleanly, but not into anything beyond.
        const gap = runs[1] ? runs[1][0] - exit : Infinity;
        // (A modelled thread runs out past the far side: the drill goes a little further too, so they end cleanly together.)
        const past = h.modelThread && screw ? 2 * screw.pitch : HOLE_LEAD_IN;
        return { ...size, depth: exit + Math.min(past, gap / 2), flatBottom: true };
      };
      /**
       * Modelled thread (for 3D printing): from where the drill enters the part (below any counterbore), down the
       * thread depth (0: as far as the hole goes in the part), out past the far side where it comes out.
       */
      const withThread = (at: Vec3, dir: Vec3, hole: HoleSize): HoleSize => {
        if (!h.modelThread || !screw || !target) return hole;
        const pitch = screw.pitch;
        const end = h.end === "blind" ? v.depth : h.end === "upToNext" ? hole.depth : span;
        const start: Vec3 = [at[0] - dir[0] * back, at[1] - dir[1] * back, at[2] - dir[2] * back];
        // All the material along the drill (beyond the hole too, to see how much room there is past its far end).
        const all = materialRuns(target.shape, start, dir, v.diameter / 2, span + back).map(([a, b]): [number, number] => [a - back, b - back]);
        const runs = all.filter(([a]) => a < end - 1e-6).map(([a, b]): [number, number] => [a, Math.min(b, end)]);
        if (runs.length === 0) return hole;
        // Below a counterbore or countersink (a plain hole can start anywhere, even behind the sketch when both ways).
        const first = hole.kind === "simple" ? runs[0][0] : Math.max(runs[0][0], straightStart(hole));
        let stop = v.threadDepth > 0 ? runs[0][0] + v.threadDepth : Infinity;
        if (h.end === "blind") stop = Math.min(stop, v.depth - pitch / 2);
        const reached = runs.filter(([a]) => a < stop);
        const last = Math.max(...reached.map(([, b]) => b));
        const comesOut = last < stop && last < end - 1e-6;
        let to = Math.min(stop, last);
        if (comesOut) {
          // Run out a pitch past the far side — but the groove (about 0.4 of a pitch either side of its line) mustn't
          // reach the next material. With too little room it ends a pitch inside the wall instead.
          const next = all.find(([a]) => a > last + 1e-6)?.[0] ?? Infinity;
          const runOut = Math.min(last + pitch, next - 0.5 * pitch);
          to = runOut >= last + 0.1 * pitch ? runOut : last - pitch;
        }
        if (to - first < pitch) throw new Error("The thread would be less than one turn long. Make the thread depth (or the hole) deeper, or untick Model the thread.");
        return { ...hole, thread: { from: first - pitch, to, pitch } };
      };
      return holeTool(sketch.sketch.plane, sketch.sketch.data, (at, dir) => withThread(at, dir, drilled(at, dir)), h.flip, threaded);
    }
    case "transform":
    case "sketch":
    case "fillet":
    case "chamfer":
    case "shell":
    case "mirror":
    case "linearPattern":
    case "circularPattern":
    case "curvePattern":
      throw new Error("This feature doesn't make a solid of its own.");
    case "import": {
      if (!feature.import) throw new Error("This import has lost its file. Delete it and import the file again.");
      const shapes = importSolids(feature.import);
      const solids = shapes.filter((s) => !isImportedSurface(s));
      shapes.filter((s) => isImportedSurface(s)).forEach((s) => s.delete());
      if (solids.length === 0 && feature.operation !== "new") throw new Error("The file holds only surfaces, which can't be added to or cut from a part. Import it as New.");
      if (solids.length === 0) return makeCompound([]) as Shape3D;
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
        if (hasLength(f.kind)) {
          // Along the shank, leaving a pitch plain under the head (a grub screw is threaded all the way);
          // the groove runs out past the tip.
          const shank = shankOf(f.kind, s, v.length);
          const len = shank.length;
          const cyl: Cylinder = { origin: [v.x, v.y, v.z + shank.top - len], axis: [0, 0, 1], radius: s.d / 2 };
          const end = f.kind === "grub" ? len + s.pitch : Math.max(len - s.pitch, s.pitch);
          const out = cutThread(solid, cyl, -s.pitch, end, 0, len, s.pitch, true);
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
  /** Threaded holes already made (see hole.ts), kept between rebuilds. */
  private threadedHoles: ThreadedHoleCache = new Map();
  /** The part just after a hole with modelled threads, by everything that went into it (see the rebuild loop). */
  private threadedResults = new Map<string, { shape: Shape3D; tool: Shape3D; error?: string }>();
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
    this.studiosWanted = wanted;
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
    // Part Studios using parts from others (Derived) are built after them, and again whenever they change.
    const sourcesOf = (s: StudioInput) => [...new Set(s.features.filter((f) => f.type === "derived" && !f.suppressed && f.derived).map((f) => f.derived!.studioId))].filter((id) => id !== s.id);
    const ordered: StudioInput[] = [];
    const pending = [...studios];
    while (pending.length) {
      const i = pending.findIndex((s) => sourcesOf(s).every((id) => !pending.some((p) => p.id === id && p !== s) || ordered.some((o) => o.id === id)));
      // A loop (two studios using each other's parts): build the rest as they are; Derived says what's wrong.
      ordered.push(...pending.splice(i >= 0 ? i : 0, 1));
    }
    this.studiosBuilt = new Set();
    for (const studio of ordered) {
      const deps = sourcesOf(studio).map((id) => (this.studiosBuilt.has(id) ? this.builds.get(id)?.key ?? "" : "?"));
      const key = JSON.stringify(studio.features) + shared + (studio.partSuffix ? JSON.stringify([studio.variables, studio.partSuffix]) : "") + (deps.length ? JSON.stringify(deps) : "");
      let b = this.builds.get(studio.id);
      if (!b || b.key !== key) {
        if (b) this.disposeBuild(b);
        this.parts = [];
        this.tools = new Map();
        setCurrentScope(studio.variables ?? variables);
        const errors = this.buildFeatures(studio.features);
        setCurrentScope(variables);
        // Names the user gave parts (used in the lists and in exported files).
        for (const p of this.parts) if (partNames[p.id]) p.name = partNames[p.id];
        // Another configuration's copies of the parts (for assemblies).
        if (studio.partSuffix) for (const p of this.parts) Object.assign(p, { id: p.id + studio.partSuffix, configured: true });
        b = { key, parts: this.parts, tools: this.tools, errors };
        this.builds.set(studio.id, b);
        rebuilt.push(studio.id);
        const configuration = studio.partSuffix?.replace(/^@/, "");
        for (const p of b.parts) meshes.push({ ...this.meshPart(p), studioId: studio.id, ...(configuration ? { configuration } : {}) });
      }
      // Problems are shown for the configuration on show only.
      if (!studio.partSuffix) Object.assign(featureErrors, b.errors);
      this.studiosBuilt.add(studio.id);
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

  /** Part Studios built so far in this rebuild (Derived may only use those). */
  private studiosBuilt = new Set<string>();
  /** The Part Studios in the document (being built now). */
  private studiosWanted = new Set<string>();

  /** The part a Derived feature brings in, as built in its own Part Studio (null if it can't be found). */
  private derivedSource(feature: Feature): BuiltPart | null {
    const d = feature.derived;
    if (!d || !this.studiosBuilt.has(d.studioId)) return null;
    return this.builds.get(d.studioId)?.parts.find((p) => p.id === d.partId) ?? null;
  }

  /** A copy of the part a Derived feature brings in, moved by its X, Y, Z. */
  private derivedSolid(feature: Feature, v: Record<string, number>): Shape3D {
    const d = feature.derived;
    if (!d) throw new Error("Choose a part from another Part Studio.");
    if (!this.studiosWanted.has(d.studioId)) throw new Error("The Part Studio this part came from has been deleted.");
    if (!this.studiosBuilt.has(d.studioId)) throw new Error("That Part Studio uses parts from this one, so this one can't use its parts too.");
    const src = this.derivedSource(feature);
    if (!src) throw new Error("That part isn't in its Part Studio any more. Edit this and choose another.");
    let shape = src.shape.clone();
    if (v.x || v.y || v.z) shape = shape.translate([v.x ?? 0, v.y ?? 0, v.z ?? 0]);
    return shape;
  }

  /** Build one Part Studio's features into this.parts and this.tools; returns the features' problems. */
  private buildFeatures(features: Feature[]): Record<string, string> {
    const featureErrors: Record<string, string> = {};
    let partCounter = 0;
    let surfaceCounter = 0;
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
        featureErrors[feature.id] = "JuraCAD doesn't know this kind of feature.";
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
      if (feature.type === "sheetMetal") {
        const r = this.applySheetMetal(feature, sketches, partCounter + 1);
        if (r.error) featureErrors[feature.id] = r.error;
        if (r.newPart) partCounter++;
        continue;
      }
      if (feature.type === "extendSurface") {
        const err = this.applyExtendSurface(feature);
        if (err) featureErrors[feature.id] = err;
        continue;
      }
      if (feature.type === "bend" || feature.type === "jog") {
        const err = this.applyLineBend(feature, sketches);
        if (err) featureErrors[feature.id] = err;
        continue;
      }
      if (feature.type === "tab") {
        const err = this.applyTab(feature, sketches);
        if (err) featureErrors[feature.id] = err;
        continue;
      }
      if (feature.type === "cornerBreak") {
        const err = this.applyCornerBreak(feature);
        if (err) featureErrors[feature.id] = err;
        continue;
      }
      if (feature.type === "flange" || feature.type === "hem") {
        const err = this.applyFlange(feature);
        if (err) featureErrors[feature.id] = err;
        continue;
      }
      if (feature.type === "thread") {
        const err = this.applyThread(feature);
        if (err) featureErrors[feature.id] = err;
        continue;
      }
      if (feature.type === "fullRound") {
        const err = this.applyFullRound(feature);
        if (err) featureErrors[feature.id] = err;
        continue;
      }
      if (feature.type === "draft" || feature.type === "moveFace" || feature.type === "replaceFace" || feature.type === "deleteFace") {
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
      if (feature.type === "mirror" && feature.mirror?.part !== undefined) {
        const r = this.applyMirrorPart(feature, partCounter + 1);
        if (r.error) featureErrors[feature.id] = r.error;
        if (r.newPart) partCounter++;
        continue;
      }
      if (isPatternFeature(feature.type)) {
        const r = this.applyPattern(feature, features);
        if (r.error) featureErrors[feature.id] = r.error;
        continue;
      }

      const { values, errors } = resolveParams(feature);
      const badParam = def.params.find((p) => errors[p.key]);
      if (badParam) {
        featureErrors[feature.id] = `${badParam.label}: ${errors[badParam.key]}`;
        continue;
      }

      // Surfaces are always new parts; Enclose closes surfaces up into a solid.
      if (feature.surface || feature.type === "fill" || feature.type === "offsetSurface" || feature.type === "enclose" || feature.type === "ruled") {
        if (feature.type === "enclose") {
          const r = this.applyEnclose(feature, partCounter + 1);
          if (r.error) featureErrors[feature.id] = r.error;
          if (r.newPart) partCounter++;
          continue;
        }
        try {
          const skin = buildSolid(feature, values, sketches, features, this.parts, this.threadedHoles);
          surfaceCounter++;
          this.tools.set(feature.id, { shape: skin.clone(), operation: "new", partId: feature.id });
          this.parts.push({ id: feature.id, name: `Surface ${surfaceCounter}`, featureIds: [feature.id], shape: skin, surface: true });
        } catch (e) {
          featureErrors[feature.id] = describeError(e, `Couldn't make this ${def.label.toLowerCase()}.`);
        }
        continue;
      }
      // Wrap goes on the part whose face it's wrapped round; everything else on the latest solid part.
      const wrapOn = feature.type === "wrap" ? this.parts.find((p) => p.id === feature.picks?.find((x) => x.ref.kind === "face")?.partId) : undefined;
      const target = wrapOn ?? [...this.parts].reverse().find((p) => !p.surface);
      if (feature.operation !== "new" && !target) {
        featureErrors[feature.id] =
          feature.type === "hole"
            ? "There's no part to drill into yet. Make a part first."
            : feature.operation === "add"
            ? "There's no part to add to yet. Use New for the first solid."
            : "There's no part to remove from yet. Use New for the first solid.";
        continue;
      }

      // A hole with modelled threads is slow to cut: reuse the result while nothing before it (or it) has changed.
      const at = features.indexOf(feature);
      const threadKey =
        feature.type === "hole" && feature.hole?.modelThread && target && !target.sheet && !features.slice(0, at).some((f) => f.type === "derived")
          ? JSON.stringify([getCurrentScope(), features.slice(0, at + 1)])
          : null;
      const done = threadKey ? this.threadedResults.get(threadKey) : undefined;
      if (done && target) {
        target.shape.delete();
        target.shape = done.shape.clone();
        target.featureIds.push(feature.id);
        this.tools.set(feature.id, { shape: done.tool.clone(), operation: "remove", partId: target.id });
        if (done.error) featureErrors[feature.id] = done.error;
        continue;
      }

      let tool: Shape3D;
      try {
        tool = feature.type === "derived" ? this.derivedSolid(feature, values) : buildSolid(feature, values, sketches, features, this.parts, this.threadedHoles);
      } catch (e) {
        featureErrors[feature.id] = describeError(e, `Couldn't make this ${def.label.toLowerCase()}.`);
        continue;
      }

      if (feature.operation === "new" && feature.type === "import") {
        // A STEP file may hold several parts: each solid becomes its own part, and any surfaces one surface part.
        this.tools.set(feature.id, { shape: tool.clone(), operation: "new", partId: feature.id });
        const solids = solidsOf(tool);
        solids.forEach((solid, i) => {
          partCounter++;
          const id = i === 0 ? feature.id : `${feature.id}~${i + 1}`;
          this.parts.push({ id, name: `Part ${partCounter}`, featureIds: [feature.id], shape: solid, meshKey: `${importKey(feature.import!)}#${i}` });
        });
        const skin = importedSurface(feature.import!);
        if (skin) {
          surfaceCounter++;
          const id = solids.length === 0 ? feature.id : `${feature.id}~${solids.length + 1}`;
          this.parts.push({ id, name: `Surface ${surfaceCounter}`, featureIds: [feature.id], shape: skin, surface: true, meshKey: `${importKey(feature.import!)}#s` });
        }
        tool.delete();
        continue;
      }

      if (feature.operation === "new") {
        partCounter++;
        this.tools.set(feature.id, { shape: tool.clone(), operation: "new", partId: feature.id });
        // Fasteners are named for what they are ("M6 × 20 hex bolt"); derived parts keep their name.
        const name =
          feature.type === "fastener" && feature.fastener
            ? fastenerName(feature.fastener.kind, feature.fastener.size, values.length)
            : feature.type === "derived" && feature.derived
              ? (this.derivedSource(feature)?.name ?? `Part ${partCounter}`)
              : `Part ${partCounter}`;
        this.parts.push({ id: feature.id, name, featureIds: [feature.id], shape: tool, ...(feature.type === "fastener" ? { threads: fastenerThreads(feature, values) } : {}) });
        continue;
      }

      try {
        if (!target) throw new Error("There's no part to change yet.");
        let result = feature.operation === "add" ? target.shape.fuse(tool) : feature.operation === "intersect" ? (target.shape.intersect(tool) as Shape3D) : target.shape.cut(tool);
        if (solidsOf(result).length === 0) {
          result.delete();
          throw new Error(feature.operation === "intersect" ? "This doesn't overlap the part, so nothing would be left." : "This would remove the whole part.");
        }
        // A modelled thread must leave one sound piece with less in it; if not, drill the plain hole and say so.
        // (Checked against the plain hole: the thread can only take more away.)
        if (feature.type === "hole" && feature.hole?.modelThread) {
          const plain = buildSolid({ ...feature, hole: { ...feature.hole, modelThread: undefined } }, values, sketches, features, this.parts);
          const plainResult: Shape3D = target.shape.cut(plain);
          if (this.soundCut(plainResult, result)) {
            plain.delete();
            plainResult.delete();
          } else {
            result.delete();
            tool.delete();
            tool = plain;
            result = plainResult;
            featureErrors[feature.id] = "The hole is drilled, but its thread couldn't be cut cleanly here (too little room past it, perhaps). Untick \"Model the thread\", or change the thread depth.";
          }
        }
        // An extrude cut that's nowhere near any part is almost always a mistake: say so (it still counts, so
        // patterns and mirrors of it — a seed cut off the part — keep working).
        const missed =
          feature.type === "extrude" &&
          feature.operation === "remove" &&
          !features.some((f) => (f.pattern?.sources ?? f.mirror?.sources ?? []).includes(feature.id)) &&
          !this.parts.some((p) => !p.surface && boxesOverlap(boundsOf(p.shape), boundsOf(tool))) &&
          Math.abs(measureVolume(target.shape) - measureVolume(result)) < 1e-9;
        target.shape.delete();
        target.shape = result;
        target.featureIds.push(feature.id);
        this.tools.set(feature.id, { shape: tool.clone(), operation: feature.operation, partId: target.id });
        if (target.sheet && feature.operation === "remove") this.traceSheetCut(target, feature.id, tool);
        if (missed) featureErrors[feature.id] = `This doesn't reach any part, so it cuts nothing (Remove cuts the latest part, ${target.name}). Check the direction (Flip), the depth and where the sketch is.`;
        if (threadKey) {
          this.threadedResults.set(threadKey, { shape: result.clone(), tool: tool.clone(), ...(featureErrors[feature.id] ? { error: featureErrors[feature.id] } : {}) });
          for (const [k, old] of this.threadedResults) {
            if (this.threadedResults.size <= 6) break;
            old.shape.delete();
            old.tool.delete();
            this.threadedResults.delete(k);
          }
        }
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
    let front: Shape3D | null = null;
    let back: Shape3D | null = null;
    if (sp.toolPartId) {
      // Split with a surface: the pieces on the side its faces point to, and the pieces behind it.
      const tool = this.parts.find((p) => p.id === sp.toolPartId);
      if (!tool) return { error: "The surface it splits with no longer exists. Edit this feature and pick another." };
      if (tool === part) return { error: "A surface can't split itself. Pick a different surface to split with." };
      if (!tool.surface) return { error: `${tool.name} is a solid. Split with a surface, a plane or a flat face.` };
      try {
        const sides = splitBySurface(part.shape, tool.shape, !!part.surface);
        if (sides.front.length === 0 || sides.back.length === 0) {
          [...sides.front, ...sides.back].forEach((x) => x.delete());
          return { error: `${tool.name} doesn't go right through ${part.name}, so there's nothing to split. Extend the surface first.` };
        }
        front = gathered(sides.front, !!part.surface);
        back = gathered(sides.back, !!part.surface);
      } catch (e) {
        return { error: describeError(e, "Couldn't split this part with that surface.") };
      }
    } else {
      const f = planeFrame(sp.plane);
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
        // A surface splits into faces rather than solids.
        const pieces = part.surface ? facesOf(s) : solidsOf(s);
        pieces.forEach((x) => x.delete());
        return pieces.length;
      };
      if (count(front) === 0 || count(back) === 0) {
        front.delete();
        back.delete();
        return { error: "The plane doesn't go through this part, so there's nothing to split." };
      }
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
    this.parts.push({ id: feature.id, name: part.surface ? `${part.name} (cut)` : `Part ${nextPartNumber}`, featureIds: [...part.featureIds], shape: front, ...(part.surface ? { surface: true } : {}) });
    return { newPart: !part.surface };
  }

  /** Grow picked flat faces into a solid, then make it a new part or add it to, cut it from or intersect it with their part. */
  /** Tab: closed shapes sketched on a face of a sheet metal part, joined onto that wall as more sheet. */
  private applyTab(feature: Feature, sketches: SketchMap): string | null {
    if (!feature.sketchRef) return "Choose the sketch with the tab's shape.";
    const sketch = sketches.get(feature.sketchRef);
    if (!sketch?.sketch?.plane) return "The sketch it uses can't be found (deleted, suppressed, or after this in the list).";
    const { regions, problems } = findRegions(sketch.sketch.data);
    if (regions.length === 0) return `The sketch has no closed shape for the tab.${problems.length ? ` ${problems.join(" ")}` : ""}`;
    const sf = planeFrame(sketch.sketch.plane);
    // The sheet metal part (latest first) with a wall in the sketch's plane.
    for (const part of [...this.parts].reverse()) {
      if (!part.sheet) continue;
      const spec = part.sheet;
      const wall = wallOnPlane(foldSheet(spec), spec.thickness, sf.origin, sf.n);
      if (!wall) continue;
      const f = wall.frame;
      const toWall = (p: [number, number]): [number, number] => {
        const w = toWorld(sf, p[0], p[1]);
        const d: Vec3 = [w[0] - f.origin[0], w[1] - f.origin[1], w[2] - f.origin[2]];
        return [dot3(d, f.u), dot3(d, f.v)];
      };
      const tabs = regions.map((r, i) => ({
        id: `${feature.id}:${i}`,
        wall: wall.id,
        outline: mapSegments(r.outer.segments, toWall),
        holes: r.holes.map((h) => mapSegments(h.segments, toWall)),
      }));
      const next: SheetSpec = { ...spec, tabs: [...(spec.tabs ?? []), ...tabs] };
      const folded = foldSheet(next);
      const problem = tabs.map((t) => folded.errors[t.id]).find(Boolean);
      if (problem) return problem;
      const ids = new Set(tabs.map((t) => t.id));
      // Just the new tabs, as solids on the wall.
      const solids = folded.walls
        .filter((w) => w.id === wall.id)
        .flatMap((w) => (w.tabs ?? []).slice(-tabs.length).map((t) => wallSolid({ ...w, outline: t.outline, holes: t.holes, tabs: [] }, spec.thickness)));
      const extra = fusePieces(solids);
      if (!extra || ids.size === 0) return "The sketch has no closed shape for the tab.";
      let result: Shape3D;
      try {
        result = part.shape.fuse(extra);
      } catch (e) {
        return describeError(e, "Couldn't join this tab onto the sheet.");
      } finally {
        extra.delete();
      }
      if (solidsOf(result).length !== 1) {
        solidsOf(result).forEach((x) => x.delete());
        result.delete();
        return "The tab doesn't touch the sheet. Draw it so it overlaps or meets the wall's edge.";
      }
      part.shape.delete();
      part.shape = result;
      part.sheet = next;
      part.featureIds.push(feature.id);
      part.sheetFeatures = [...(part.sheetFeatures ?? []), feature.id];
      return null;
    }
    return "Sketch the tab on a face of a sheet metal part (its top or bottom face, or a flange's face): use that face as the sketch's plane.";
  }

  /**
   * Bend (and Jog): a flat wall of a sheet metal part bent along a line
   * sketched on its face. The material on the moving side (with any holes or
   * cuts in it) is turned up into place; the flat pattern keeps its shape.
   */
  private applyLineBend(feature: Feature, sketches: SketchMap): string | null {
    const jog = feature.type === "jog";
    const what = jog ? "jog" : "bend";
    const { values, errors } = resolveParams(feature);
    const bad = FEATURE_DEFS[feature.type].params.find((p) => errors[p.key]);
    if (bad) return `${bad.label}: ${errors[bad.key]}`;
    if (!feature.sketchRef) return `Choose the sketch with the line to ${jog ? "step" : "bend"} along.`;
    const sketch = sketches.get(feature.sketchRef);
    if (!sketch?.sketch?.plane) return "The sketch it uses can't be found (deleted, suppressed, or after this in the list).";
    const data = sketch.sketch.data;
    const lines = data.curves.filter((c) => !c.construction && c.type === "line");
    if (lines.length !== 1 || data.curves.some((c) => !c.construction && c.type !== "line"))
      return lines.length > 1 || data.curves.some((c) => !c.construction && c.type !== "line")
        ? `Draw just one line in the sketch: the line to ${jog ? "step" : "bend"} along. (Make any others construction lines.)`
        : "Draw a line in the sketch, across the face, where the sheet should bend.";
    const pos = (id: string): [number, number] => {
      if (id === "origin") return [0, 0];
      const p = data.points.find((q) => q.id === id);
      return p ? [p.x, p.y] : [NaN, NaN];
    };
    const line = lines[0] as Extract<(typeof lines)[number], { type: "line" }>;
    const sf = planeFrame(sketch.sketch.plane);
    for (const part of [...this.parts].reverse()) {
      if (!part.sheet) continue;
      const spec = part.sheet;
      const T = spec.thickness;
      const wall = wallOnPlane(foldSheet(spec), T, sf.origin, sf.n);
      if (!wall) continue;
      const f = wall.frame;
      const toWall = (p: [number, number]): P2 => {
        const w = toWorld(sf, p[0], p[1]);
        const d: Vec3 = [w[0] - f.origin[0], w[1] - f.origin[1], w[2] - f.origin[2]];
        return [dot3(d, f.u), dot3(d, f.v)];
      };
      let from = toWall(pos(line.p1));
      let to = toWall(pos(line.p2));
      const L = Math.hypot(to[0] - from[0], to[1] - from[1]);
      if (!(L > 1e-9)) return "The bend line has no length. Draw a line across the face.";
      if ((spec.tabs ?? []).some((t) => t.wall === wall.id)) return `This wall has a tab on it. Make the ${what} first: drag it above the Tab in the feature list.`;
      if ((spec.corners ?? []).some((c) => c.wall === wall.id)) return `This wall has corners rounded or cut off. Make the ${what} first: drag it above the Corner break in the feature list.`;
      // Which side moves: the one on the line's right (going from → to).
      const dir: P2 = [(to[0] - from[0]) / L, (to[1] - from[1]) / L];
      const rightOf = (p: P2) => (p[0] - from[0]) * dir[1] - (p[1] - from[1]) * dir[0];
      let flip: boolean;
      if (wall.bendEdge !== undefined) {
        // A wall bent off another: the side joined to it stays still.
        if (feature.keepOtherSide) return "This wall is joined to the rest of the sheet on one side, so that side has to stay still. Untick “Keep the other side still”.";
        const e = wall.outline[wall.bendEdge];
        const mid: P2 = e.kind === "line" ? [(e.from[0] + e.to[0]) / 2, (e.from[1] + e.to[1]) / 2] : from;
        flip = rightOf(mid) > 0;
      } else {
        // The side with flanges or bends already on it stays still; otherwise the smaller piece moves (or the other, if asked).
        const folded = foldSheet(spec);
        const sides = folded.bends
          .filter((b) => b.parent === wall.id)
          .map((b) => {
            const e = wall.outline[b.edge];
            return e.kind === "line" ? Math.sign(rightOf([(e.from[0] + e.to[0]) / 2, (e.from[1] + e.to[1]) / 2])) : 0;
          });
        const [left, right] = sideAreas(wall.outline, from, dir);
        const smallerRight = right <= left + 1e-9;
        const rightMoves = sides.some((x) => x > 0) && !sides.some((x) => x < 0) ? false : sides.some((x) => x < 0) && !sides.some((x) => x > 0) ? true : smallerRight;
        flip = rightMoves === !!feature.keepOtherSide;
      }
      if (flip) [from, to] = [to, from];
      // Cuts already made through the wall mustn't cross the bend (their material can't be bent).
      const R = values.radius > 0 ? values.radius : spec.radius;
      const half = (((values.angle * Math.PI) / 180) * (R + spec.k * T)) / 2;
      const d2: P2 = [(to[0] - from[0]) / L, (to[1] - from[1]) / L];
      const across = (p: [number, number]) => (p[0] - from[0]) * d2[1] - (p[1] - from[1]) * d2[0];
      if ((part.sheetCuts ?? []).some((c) => c.wall === wall.id && !c.bend && c.lines.some(([a, b]) => Math.min(across(a), across(b)) < half && Math.max(across(a), across(b)) > -half)))
        return `A cut through the sheet crosses the ${what}. Move the line so the ${what} misses it, or drag the ${what} above that cut in the feature list.`;
      const radius = values.radius > 0 ? { radius: values.radius } : {};
      const down = !!feature.flipSide;
      const added: FlangeSpec[] = [{ id: `${feature.id}:0`, wall: wall.id, edge: -1, length: 0, angle: values.angle, down, ...radius, line: { from, to } }];
      if (jog) {
        const s = jogSpacing(values.height, values.angle, R, T, spec.k);
        if (typeof s === "string") return s;
        // Both bends and some straight after them must fit on the moving side.
        const a = 2 * half;
        const room = Math.max(...outlinePoints(wall.outline).map((p) => across(p)));
        if (room < s + a + 0.01)
          return `Not enough room past the line for a step this high (it needs ${Math.ceil((s + a + 0.01) * 100) / 100} mm, there's ${Math.floor(room * 100) / 100} mm): move the line further from the edge, make the step lower, or tick “Keep the other side still”.`;
        // The second bend, the other way, across the piece the first one turned up (its y runs on from the bend).
        added.push({ id: `${feature.id}:1`, wall: `${feature.id}:0`, edge: -1, length: 0, angle: values.angle, down: !down, ...radius, line: { from: [1, s], to: [0, s] } });
      }
      let shape = part.shape;
      let next = spec;
      try {
        for (const fl of added) {
          const prev = next;
          next = { ...prev, flanges: [...prev.flanges, fl] };
          const before = foldSheet(prev);
          const after = foldSheet(next);
          const problem = after.errors[fl.id];
          if (problem) return problem;
          const w0 = before.walls.find((w) => w.id === fl.wall)!;
          const w1 = after.walls.find((w) => w.id === fl.wall)!;
          const child = after.walls.find((w) => w.id === fl.id)!;
          const bend = after.bends.find((b) => b.flangeId === fl.id)!;
          const bent = this.bendMaterial(shape, w0, w1, child, bend, T);
          if (shape !== part.shape) shape.delete();
          shape = bent;
        }
      } catch (e) {
        if (shape !== part.shape) shape.delete();
        return describeError(e, `Couldn't make this ${what}.`);
      }
      if (!isValidSolid(shape) || solidsOf(shape).length !== 1) {
        shape.delete();
        return `The bent part runs into the rest of the sheet. Try a different angle, bend the other way, or keep the other side still.`;
      }
      part.shape.delete();
      part.shape = shape;
      part.sheet = next;
      part.featureIds.push(feature.id);
      part.sheetFeatures = [...(part.sheetFeatures ?? []), feature.id];
      return null;
    }
    return `Sketch the ${what} line on a flat face of a sheet metal part (its top or bottom face, or a flange's face): use that face as the sketch's plane.`;
  }

  /**
   * One bend along a line, made in the part's solid: the wall's material past
   * the fixed piece (`w0` was the whole wall, `w1` is the piece that stays)
   * is taken off, the moving piece's material turned into its new place,
   * and the bend joined in between. Returns a new shape (the old one is kept).
   */
  private bendMaterial(shape: Shape3D, w0: FoldedSheet["walls"][number], w1: FoldedSheet["walls"][number], child: FoldedSheet["walls"][number], bend: FoldedSheet["bends"][number], T: number): Shape3D {
    const whole = wallSolid({ ...w0, holes: [], tabs: [] }, T);
    const fixed = wallSolid({ ...w1, holes: [], tabs: [] }, T);
    const region: Shape3D = whole.cut(fixed);
    whole.delete();
    fixed.delete();
    let piece: Shape3D | null = null;
    let rest: Shape3D | null = null;
    try {
      piece = shape.intersect(region) as Shape3D;
      rest = shape.cut(region) as Shape3D;
      // Turn the moving material from the wall's frame to where it goes (each step frees the one before).
      const to = bend.moved!;
      const turn = turnBetween(w0.frame, to);
      piece = piece.translate([-w0.frame.origin[0], -w0.frame.origin[1], -w0.frame.origin[2]]);
      if (turn.angle > 1e-9) piece = piece.rotate(turn.angle, [0, 0, 0], turn.axis);
      piece = piece.translate(to.origin);
      // Only what's past the bend: the strip it came from is the bend now.
      const slab = wallSolid({ ...child, holes: [], tabs: [] }, T);
      const kept = piece.intersect(slab) as Shape3D;
      slab.delete();
      piece.delete();
      piece = kept;
      const joined = fusePieces([rest, bendSolid(bend), piece])!;
      rest = null;
      piece = null;
      return joined;
    } finally {
      region.delete();
      piece?.delete();
      rest?.delete();
    }
  }

  /** Sheet metal: a flat sheet from a closed sketch, kept as a sheet so flanges can be bent off it. */
  private applySheetMetal(feature: Feature, sketches: SketchMap, nextPartNumber: number): { error?: string; newPart?: boolean } {
    const { values, errors } = resolveParams(feature);
    const bad = FEATURE_DEFS.sheetMetal.params.find((p) => errors[p.key]);
    if (bad) return { error: `${bad.label}: ${errors[bad.key]}` };
    if (values.kFactor > 1) return { error: "K-factor: use a value from 0 to 1 (0.45 is usual)." };
    if (!feature.sketchRef) return { error: "Choose the sketch with the sheet's shape." };
    const sketch = sketches.get(feature.sketchRef);
    if (!sketch?.sketch?.plane) return { error: "The sketch it uses can't be found (deleted, suppressed, or after this in the list)." };
    const { regions } = findRegions(sketch.sketch.data);
    if (regions.length > 1)
      return {
        error: `Sheet metal needs one closed outline (holes inside it are fine), but this sketch has ${regions.length}. Shapes that overlap each other count separately: use Trim to cut away the pieces where they cross, so they make one outline, or move the other shapes to another sketch.`,
      };
    const frame = planeFrame(sketch.sketch.plane);
    const T = values.thickness;
    if (regions.length === 0) {
      // Connected lines: a bent sheet, its corners the bends.
      const chain = openChain(sketch.sketch.data);
      if (typeof chain === "string") return { error: chain };
      const spec = profileSheet(frame, chain, { depth: values.depth, thickness: T, radius: values.radius, k: values.kFactor, reverse: !!feature.flipSide, idPrefix: feature.id });
      if (typeof spec === "string") return { error: spec };
      const folded = foldSheet(spec);
      const problem = Object.values(folded.errors)[0];
      if (problem) return { error: problem };
      let shape: Shape3D | null = null;
      try {
        shape = fusePieces([...folded.walls.map((w) => wallSolid(w, T)), ...folded.bends.map((b) => bendSolid(b))]);
      } catch (e) {
        return { error: describeError(e, "Couldn't make the sheet.") };
      }
      if (!shape) return { error: "Draw the sheet's side view as connected lines." };
      this.tools.set(feature.id, { shape: shape.clone(), operation: "new", partId: feature.id });
      this.parts.push({ id: feature.id, name: `Part ${nextPartNumber}`, featureIds: [feature.id], shape, sheet: spec, sheetFeatures: [feature.id] });
      return { newPart: true };
    }
    // Flipped: the sheet sits below the sketch.
    const origin = feature.flipSide ? ([frame.origin[0] - frame.n[0] * T, frame.origin[1] - frame.n[1] * T, frame.origin[2] - frame.n[2] * T] as Vec3) : frame.origin;
    const spec: SheetSpec = {
      thickness: T,
      radius: values.radius,
      k: values.kFactor,
      base: { frame: { origin, u: frame.u, v: frame.v, n: frame.n }, outer: regions[0].outer.segments, holes: regions[0].holes.map((h) => h.segments) },
      flanges: [],
    };
    let shape: Shape3D;
    try {
      shape = wallSolid(foldSheet(spec).walls[0], T);
    } catch (e) {
      return { error: describeError(e, "Couldn't make the sheet.") };
    }
    this.tools.set(feature.id, { shape: shape.clone(), operation: "new", partId: feature.id });
    this.parts.push({ id: feature.id, name: `Part ${nextPartNumber}`, featureIds: [feature.id], shape, sheet: spec, sheetFeatures: [feature.id] });
    return { newPart: true };
  }

  /** A cut through a sheet metal part: where it goes through each wall, so the flat pattern shows it. */
  private traceSheetCut(part: BuiltPart, featureId: string, tool: Shape3D): void {
    if (!part.sheet) return;
    let found = false;
    try {
      const folded = foldSheet(part.sheet);
      for (const wall of folded.walls) {
        const lines = wallCutLines(wall, part.sheet.thickness, tool);
        if (!lines.length) continue;
        (part.sheetCuts ??= []).push({ wall: wall.id, lines });
        found = true;
      }
      // Through the bends too (a slot across a fold), unrolled flat.
      for (const bend of folded.bends) {
        const lines = bendCutLines(bend, part.sheet.thickness, tool);
        if (!lines.length) continue;
        (part.sheetCuts ??= []).push({ wall: bend.parent, bend: bend.flangeId, lines });
        found = true;
      }
    } catch {
      // Not traced: it's listed as not shown in the flat pattern.
    }
    if (found) part.sheetFeatures = [...(part.sheetFeatures ?? []), featureId];
  }

  /** Flange: a wall bent up (or down) off each picked straight edge of a sheet metal part. */
  private applyFlange(feature: Feature): string | null {
    const hem = feature.type === "hem";
    const what = hem ? "hem" : "flange";
    const { values, errors } = resolveParams(feature);
    const bad = FEATURE_DEFS[feature.type].params.find((p) => errors[p.key]);
    if (bad) return `${bad.label}: ${errors[bad.key]}`;
    if (feature.mitreCorners && values.cornerGap < 0.01) return "Gap at mitred corners: make it at least 0.01 mm (the walls can't be cut to meet exactly).";
    const picks = (feature.picks ?? []).filter((p) => p.ref.kind === "edge");
    if (picks.length === 0) return hem ? "Click the straight edges of the sheet to fold over." : "Click the straight edges of the sheet to bend flanges off.";
    const partIds = [...new Set(picks.map((p) => p.partId))];
    if (partIds.length > 1) return `A ${what} works on one sheet metal part at a time. Remove the edges picked on the other part.`;
    const part = this.parts.find((p) => p.id === partIds[0]);
    if (!part) return `The part these edges were on no longer exists. Edit this ${what} and pick the edges again.`;
    if (!part.sheet) return "That isn't a sheet metal part. Make one with Sheet metal (from a sketch) first.";
    let spec = part.sheet;
    const added: FlangeSpec[] = [];
    for (let i = 0; i < picks.length; i++) {
      const ref = picks[i].ref;
      if (ref.kind !== "edge" || ref.curve !== "LINE") return `${hem ? "Hems fold" : "Flanges bend"} straight edges. Remove the curved edge.`;
      // Edges of flanges made earlier in this same feature count too. (Picked on the part as it was, before this
      // feature's flanges cut any edges back to sit flush.)
      const asPicked = { ...spec, flanges: spec.flanges.map((f) => (added.includes(f) && f.position ? { ...f, position: undefined } : f)) };
      const where = findSheetEdge(foldSheet(asPicked), spec.thickness, ref.a, ref.b, 0.01);
      if (!where) return `One of the edges isn't a free straight edge along the sheet's top or bottom face (or it's already bent). Edit this ${what} and pick it again.`;
      const fl: FlangeSpec = hem
        ? {
            id: `${feature.id}:${i}`,
            wall: where.wall,
            edge: where.edge,
            length: 0,
            angle: 180,
            down: !!feature.flipSide,
            hem: true,
            // Folded flat against the sheet (a closed hem) needs a tiny bend radius; a gap opens it up.
            radius: Math.max(0.05, values.gap / 2),
            straight: values.length,
            ...(values.inset > 0 ? { inset: values.inset } : {}),
            ...(feature.mitreCorners ? { mitre: values.cornerGap } : {}),
          }
        : {
            id: `${feature.id}:${i}`,
            wall: where.wall,
            edge: where.edge,
            length: values.length,
            angle: values.angle,
            down: !!feature.flipSide,
            ...(values.inset > 0 ? { inset: values.inset } : {}),
            ...(feature.closeCorners ? { closeCorners: true } : {}),
            ...(feature.reliefShape && feature.reliefShape !== "rectangle" ? { reliefShape: feature.reliefShape } : {}),
            ...(feature.cornerRelief ? { cornerRelief: feature.cornerRelief } : {}),
            ...(feature.flangePosition ? { position: feature.flangePosition } : {}),
            ...(feature.mitreCorners ? { mitre: values.cornerGap } : {}),
          };
      added.push(fl);
      spec = { ...spec, flanges: [...spec.flanges, fl] };
    }
    const oldFold = foldSheet(part.sheet);
    const mitredBefore = new Set((oldFold.mitres ?? []).flatMap((m) => m.walls));
    if (added.some((f) => f.position && mitredBefore.has(f.wall)))
      return "A flange on a mitred flange can only bend off the edge (it can't sit flush there). Set the position to “Bend off the edge”.";
    const folded = foldSheet(spec);
    const problem = added.map((f) => folded.errors[f.id]).find(Boolean);
    if (problem) return problem;
    const ids = new Set(added.map((f) => f.id));
    // Walls cut back so the new flanges sit flush: not next to a flange made before (it was bent off the whole edge).
    const trims = (folded.trims ?? []).filter((t) => ids.has(t.flangeId));
    for (const t of trims) {
      const wall = folded.walls.find((w) => w.id === t.wall)!;
      const fl = added.find((f) => f.id === t.flangeId)!;
      const k = wall.outline.length;
      const old = folded.bends.find((b) => b.parent === wall.id && !ids.has(b.flangeId) && (b.edge === (fl.edge + 1) % k || b.edge === (fl.edge - 1 + k) % k));
      if (old && part.sheetFeatures?.[0] && old.flangeId.startsWith(`${part.sheetFeatures[0]}:`))
        return "That edge is next to a bend of the sheet, so the flange can't sit flush there. Set the position to “Bend off the edge”.";
      if (old) return "To sit flush, this flange cuts back the edge next to a flange made earlier. Pick both edges in one Flange (so they're made together), or set the position to “Bend off the edge”.";
    }
    // Walls of flanges made before, trimmed now where they meet the new ones at mitred corners: what comes off them.
    const mitred = new Set((folded.mitres ?? []).filter((m) => m.flanges.some((id) => ids.has(id))).flatMap((m) => m.walls).filter((id) => !ids.has(id)));
    const reshaped = [...mitred]
      .map((id) => ({ was: oldFold.walls.find((w) => w.id === id), now: folded.walls.find((w) => w.id === id) }))
      .filter((x): x is { was: NonNullable<typeof x.was>; now: NonNullable<typeof x.now> } => !!x.was && !!x.now && JSON.stringify(x.was.outline) !== JSON.stringify(x.now.outline));
    let pieces: Shape3D[] = [];
    let result: Shape3D | null = null;
    let base: Shape3D = part.shape;
    try {
      for (const r of reshaped) {
        const was = wallSolid({ ...r.was, holes: [], tabs: [] }, spec.thickness);
        const now = wallSolid({ ...r.now, holes: [], tabs: [] }, spec.thickness);
        try {
          const off = was.cut(now);
          try {
            const cut = base.cut(off);
            if (base !== part.shape) base.delete();
            base = cut;
          } finally {
            off.delete();
          }
        } finally {
          was.delete();
          now.delete();
        }
      }
      if (trims.length) {
        const strips = fusePieces(trims.map((t) => wallSolid({ ...folded.walls.find((w) => w.id === t.wall)!, outline: t.outline, holes: [], tabs: [] }, spec.thickness)))!;
        try {
          const cut = base.cut(strips);
          if (base !== part.shape) base.delete();
          base = cut;
        } finally {
          strips.delete();
        }
      }
      pieces = [
        ...folded.bends.filter((b) => ids.has(b.flangeId)).map((b) => bendSolid(b)),
        ...folded.walls.filter((w) => ids.has(w.id)).map((w) => wallSolid(w, spec.thickness)),
      ];
      const extra = fusePieces(pieces);
      pieces = [];
      if (!extra) return hem ? "Click the straight edges of the sheet to fold over." : "Click the straight edges of the sheet to bend flanges off.";
      try {
        result = base.fuse(extra);
      } finally {
        extra.delete();
      }
      // Bend reliefs: notches cut into the wall each shortened flange bends off.
      const reliefs = folded.bends
        .filter((b) => ids.has(b.flangeId) && b.reliefs.length)
        .flatMap((b) => {
          const parent = folded.walls.find((w) => w.id === b.parent)!;
          return b.reliefs.map((r) => wallSolid({ ...parent, outline: r, holes: [], tabs: [] }, spec.thickness));
        });
      // Corner reliefs where the new flanges meet others.
      for (const c of folded.cornerReliefs ?? []) {
        if (!c.flanges.some((id) => ids.has(id))) continue;
        const wall = folded.walls.find((w) => w.id === c.wall);
        if (wall) reliefs.push(cornerReliefSolid(wall, c, spec.thickness));
      }
      const notches = fusePieces(reliefs);
      if (notches) {
        try {
          const cut: Shape3D = result.cut(notches);
          result.delete();
          result = cut;
        } finally {
          notches.delete();
        }
      }
      if (!isValidSolid(result)) {
        result.delete();
        return hem
          ? "The hem runs into the rest of the part. Shorten its ends (Shorten each end by), or make it shorter."
          : "The flange runs into the rest of the part. Shorten its ends (Shorten each end by), or try a shorter flange or a different angle.";
      }
    } catch (e) {
      pieces.forEach((p) => p.delete());
      return describeError(e, `Couldn't ${hem ? "fold this hem" : "bend this flange"}.`);
    } finally {
      if (base !== part.shape) base.delete();
    }
    part.shape.delete();
    part.shape = result;
    part.sheet = spec;
    part.featureIds.push(feature.id);
    part.sheetFeatures = [...(part.sheetFeatures ?? []), feature.id];
    return null;
  }

  /** Corner break: outside corners of a sheet metal part's walls rounded or cut off (the flat pattern follows). */
  private applyCornerBreak(feature: Feature): string | null {
    const { values, errors } = resolveParams(feature);
    if (errors.size) return `${feature.breakStyle === "chamfer" ? "Distance" : "Radius"}: ${errors.size}`;
    const picks = (feature.picks ?? []).filter((p) => p.ref.kind === "edge");
    if (!picks.length) return "Click the short edge through the sheet at each corner to round off.";
    const partIds = [...new Set(picks.map((p) => p.partId))];
    if (partIds.length > 1) return "A corner break works on one sheet metal part at a time. Remove the corners picked on the other part.";
    const part = this.parts.find((p) => p.id === partIds[0]);
    if (!part) return "The part these corners were on no longer exists. Edit this and pick the corners again.";
    if (!part.sheet) return "That isn't a sheet metal part. Corner break rounds the corners of sheet metal; use Fillet on other parts.";
    const spec = part.sheet;
    const folded = foldSheet(spec);
    const kind = feature.breakStyle === "chamfer" ? "chamfer" : "round";
    const added: CornerBreak[] = [];
    const cutters: Shape3D[] = [];
    try {
      for (let i = 0; i < picks.length; i++) {
        const ref = picks[i].ref;
        if (ref.kind !== "edge") continue;
        const where = findSheetCorner(folded, spec.thickness, ref.a, ref.b, 0.01);
        if (!where) return "One of the picked edges isn't at a corner of the sheet. Pick the short edge that runs through the sheet, from one face to the other, at an outside corner.";
        const near = (q: [number, number]) => Math.hypot(q[0] - where.at[0], q[1] - where.at[1]) < 1e-6;
        if ([...(spec.corners ?? []), ...added].some((x) => x.wall === where.wall && near(x.at))) return "That corner has already been rounded or cut off. Edit the earlier corner break to change it.";
        const c: CornerBreak = { id: `${feature.id}:${i}`, wall: where.wall, at: where.at, kind, size: values.size };
        const cut = cornerBreakCut(folded, c);
        if (typeof cut === "string") return cut;
        const wall = folded.walls.find((w) => w.id === where.wall)!;
        cutters.push(wallSolid({ ...wall, outline: cut, holes: [], tabs: [] }, spec.thickness));
        added.push(c);
      }
      const cutter = fusePieces(cutters.splice(0))!;
      let result: Shape3D;
      try {
        result = part.shape.cut(cutter);
      } finally {
        cutter.delete();
      }
      if (!isValidSolid(result)) {
        result.delete();
        return "Couldn't round those corners cleanly. Try a smaller radius.";
      }
      part.shape.delete();
      part.shape = result;
    } catch (e) {
      return describeError(e, "Couldn't round those corners.");
    } finally {
      cutters.forEach((c) => c.delete());
    }
    part.sheet = { ...spec, corners: [...(spec.corners ?? []), ...added] };
    part.featureIds.push(feature.id);
    part.sheetFeatures = [...(part.sheetFeatures ?? []), feature.id];
    return null;
  }

  /** Extend surface: the surface grown out past the picked edges. */
  private applyExtendSurface(feature: Feature): string | null {
    const { values, errors } = resolveParams(feature);
    if (errors.distance) return `Distance: ${errors.distance}`;
    const upTo = feature.extendTo;
    const picks = (feature.picks ?? []).filter((p) => p.ref.kind === "edge");
    if (!picks.length) return "Click the edges of the surface to extend.";
    const ids = [...new Set(picks.map((p) => p.partId))];
    if (ids.length > 1) return "Extend one surface at a time. Remove the edges picked on the other.";
    const part = this.parts.find((p) => p.id === ids[0]);
    if (!part) return "The surface no longer exists. Edit this and pick the edges again.";
    if (!part.surface) return "Extend surface works on surfaces (skins), not solid parts.";
    // Up to a face or part: what it stops at, and a length sure to get past it.
    let limit: Shape3D | null = null;
    let ownLimit = false;
    let reach = values.distance;
    if (upTo) {
      if (!upTo.target) return upTo.mode === "face" ? "Click the face to extend up to." : "Click a face of the part to extend up to.";
      const other = this.parts.find((p) => p.id === upTo.target!.partId);
      if (!other) return `The ${upTo.mode} it extends up to can't be found any more. Click it again.`;
      if (other === part) return "Pick a face of another part or surface, not of the surface being extended.";
      if (upTo.mode === "part") {
        if (other.surface) return "“Up to a part” stops at a solid part. To stop at a surface, choose “Up to a face” and click it.";
        limit = other.shape;
      } else {
        const [face] = findPickedFaces(other.shape, [upTo.target]);
        if (!face) return "The face it extends up to can't be found any more (that part has changed). Click it again.";
        limit = face as unknown as Shape3D;
        ownLimit = true;
      }
      const a = boundsOf(part.shape);
      const b = boundsOf(other.shape);
      const lo = [0, 1, 2].map((i) => Math.min(a[0][i], b[0][i]));
      const hi = [0, 1, 2].map((i) => Math.max(a[1][i], b[1][i]));
      reach = 2 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + 1;
    }
    let edges: Edge[] = [];
    try {
      edges = findPickedEdges(part.shape, picks);
      if (limit && upTo && edges.some((e) => measureDistanceBetween(e as unknown as Shape3D, limit!) < 1e-6))
        return `That ${upTo.mode} already touches an edge being extended, so there's nothing to extend up to there. Pick a ${upTo.mode} further along, or extend by a distance.`;
      const grown = extendSurface(part.shape, edges, reach, limit ?? undefined);
      part.shape.delete();
      part.shape = grown;
      part.featureIds.push(feature.id);
      return null;
    } catch (e) {
      return describeError(e, "Couldn't extend this surface.");
    } finally {
      edges.forEach((e) => e.delete());
      if (ownLimit) limit?.delete();
    }
  }

  /** Enclose: the surfaces whose faces were picked, sewn and closed into one solid (the surfaces are used up). */
  private applyEnclose(feature: Feature, nextPartNumber: number): { error?: string; newPart?: boolean } {
    const picks = (feature.picks ?? []).filter((p) => p.ref.kind === "face");
    const ids = [...new Set(picks.map((p) => p.partId))];
    const surfaces = ids.map((id) => this.parts.find((p) => p.id === id)).filter((p): p is BuiltPart => !!p);
    if (!surfaces.length) return { error: "Click a face of each surface to close up into a solid." };
    if (surfaces.some((p) => !p.surface)) return { error: "Enclose closes up surfaces (skins). Remove the faces picked on solid parts." };
    let solid: Shape3D;
    try {
      solid = encloseSurfaces(surfaces.map((p) => p.shape));
    } catch (e) {
      return { error: describeError(e, "Couldn't close these surfaces into a solid.") };
    }
    if (solidsOf(solid).length === 0 || !isValidSolid(solid)) {
      solid.delete();
      return { error: gapReport(surfaces.map((p) => p.shape)) };
    }
    for (const p of surfaces) {
      this.parts.splice(this.parts.indexOf(p), 1);
      p.shape.delete();
    }
    this.tools.set(feature.id, { shape: solid.clone(), operation: "new", partId: feature.id });
    this.parts.push({ id: feature.id, name: `Part ${nextPartNumber}`, featureIds: [...new Set([...surfaces.flatMap((p) => p.featureIds), feature.id])], shape: solid });
    return { newPart: true };
  }

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
      // A surface (skin): the whole of it thickened into a solid, curved faces and all.
      if (part.surface) {
        faces.forEach((f) => f.delete());
        faces = [];
        solid = thickenSurface(part.shape, values.thickness * (feature.flipSide && !feature.bothSides ? -1 : 1), !!feature.bothSides);
        if (feature.operation === "new") {
          // The skin becomes the solid: it's no longer listed as a surface of its own.
          this.parts.splice(this.parts.indexOf(part), 1);
          part.shape.delete();
          this.tools.set(feature.id, { shape: solid.clone(), operation: "new", partId: feature.id });
          this.parts.push({ id: feature.id, name: `Part ${nextPartNumber}`, featureIds: [...part.featureIds, feature.id], shape: solid });
          return { newPart: true };
        }
        const onto = [...this.parts].reverse().find((p) => !p.surface);
        if (!onto) return { error: "There's no solid part to add this to yet. Use New to make one from the surface." };
        const result = feature.operation === "add" ? onto.shape.fuse(solid) : feature.operation === "intersect" ? (onto.shape.intersect(solid) as Shape3D) : onto.shape.cut(solid);
        solid.delete();
        if (solidsOf(result).length === 0) {
          result.delete();
          return { error: "This would remove the whole part." };
        }
        onto.shape.delete();
        onto.shape = result;
        onto.featureIds.push(feature.id);
        return {};
      }
      for (const face of faces) {
        if (face.geomType !== "PLANE") throw new Error("Thicken works on flat faces. Remove the curved face.");
        const n = take(face.normalAt());
        const t = values.thickness * (feature.flipSide && !feature.bothSides ? -1 : 1);
        // Both sides: from half the thickness behind the face to half in front.
        const from = feature.bothSides ? face.clone().translate([(-n[0] * t) / 2, (-n[1] * t) / 2, (-n[2] * t) / 2]) : face;
        const v = new Vector([n[0] * t, n[1] * t, n[2] * t]);
        let piece: Shape3D;
        try {
          piece = basicFaceExtrusion(from, v) as Shape3D;
        } finally {
          v.delete();
          if (from !== face) from.delete();
        }
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
    const marks: ThreadMark[] = [];
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
        // For drawings: where it runs, and its outside and root sizes (60° metric: root = outside − 1.0825 × pitch).
        const d = external ? 2 * cyl.radius : 2 * cyl.radius + 1.0825 * pitch;
        marks.push({ origin: cyl.origin, axis: cyl.axis, from: Math.max(lo, from), to: hi, major: d, minor: d - 1.0825 * pitch, external });
      }
      const solids = solidsOf(shape);
      solids.forEach((x) => x.delete());
      if (solids.length === 0 || !isValidSolid(shape)) throw new Error("The thread couldn't be cut cleanly — try a different pitch or length.");
      part.shape.delete();
      part.shape = shape;
      part.featureIds.push(feature.id);
      part.threads = [...(part.threads ?? []), ...marks];
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
    // Delete face on a surface, or leaving the hole open on a solid: the faces just taken away (a solid becomes a surface).
    if (part.surface || (feature.type === "deleteFace" && feature.leaveOpen)) {
      if (feature.type !== "deleteFace") return `${def.label} works on solid parts; ${part.name} is a surface.`;
      try {
        result = removeFaces(part.shape, faces);
      } catch (e) {
        return describeError(e, "Couldn't remove those faces.");
      } finally {
        faces.forEach((f) => f.delete());
      }
      part.shape.delete();
      part.shape = result;
      part.featureIds.push(feature.id);
      if (!part.surface) {
        part.surface = true;
        delete part.sheet;
      }
      return null;
    }
    try {
      if (feature.type === "draft") {
        if (Math.abs(values.angle) < 1e-9) return "Enter an angle to taper by.";
        result = draftFaces(part.shape, faces, planeFrame(feature.neutral ?? { kind: "default", name: "Top" }), !!feature.flipSide, values.angle);
      } else if (feature.type === "deleteFace") {
        result = deleteFaces(part.shape, faces);
      } else {
        // How far each flat face moves along its own outward normal.
        const moves: { face: Face; d: number }[] = [];
        if (feature.type === "replaceFace") {
          const target = feature.replaceDef?.target;
          if (!target) return "Click the face (or plane) to move them onto: press “Pick the face to move them onto”, then click it.";
          const frame = planeFrame(target);
          for (const face of faces) {
            if (face.geomType !== "PLANE") return "Replace face works on flat faces. Remove the curved face.";
            const n = take(face.normalAt());
            if (Math.abs(dot3(n, frame.n)) < 0.9999) return "The faces must be parallel to the face they're moved onto (it can't tilt them). Pick a parallel face or plane.";
            const c = take(face.center);
            const gap = dot3([frame.origin[0] - c[0], frame.origin[1] - c[1], frame.origin[2] - c[2]], n);
            moves.push({ face, d: gap + values.offset });
          }
          if (moves.every((m) => Math.abs(m.d) < 1e-9)) return "The faces are already on that face — nothing to move.";
        } else {
          const d = values.distance;
          if (Math.abs(d) < 1e-9) return "Enter a distance to move the faces by.";
          for (const face of faces) {
            if (face.geomType !== "PLANE") throw new Error("Move face works on flat faces. Remove the curved face.");
            moves.push({ face, d });
          }
        }
        // Each face swept out (or in) along its normal: what's swept outwards is added, inwards is cut.
        const join = (a: Shape3D | null, b: Shape3D): Shape3D => {
          if (!a) return b;
          const next: Shape3D = a.fuse(b);
          a.delete();
          b.delete();
          return next;
        };
        let grow: Shape3D | null = null;
        let shrink: Shape3D | null = null;
        for (const { face, d } of moves) {
          if (Math.abs(d) < 1e-9) continue;
          const n = take(face.normalAt());
          const piece = basicFaceExtrusion(face, new Vector([n[0] * d, n[1] * d, n[2] * d])) as Shape3D;
          if (d > 0) grow = join(grow, piece);
          else shrink = join(shrink, piece);
        }
        if (!grow && !shrink) return "Click the faces to move.";
        let shape: Shape3D = part.shape;
        try {
          if (grow) shape = shape.fuse(grow);
          if (shrink) {
            const cut: Shape3D = shape.cut(shrink);
            if (shape !== part.shape) shape.delete();
            shape = cut;
          }
          result = shape;
        } finally {
          grow?.delete();
          shrink?.delete();
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
   * Full round: each picked flat face — the top of a rib or wall, a strip
   * with two long straight parallel sides — replaced by a half-round as wide
   * as the strip, tangent to both sides. Built directly: the strip is cut back
   * by half its width and a half-cylinder put in its place (a fillet of
   * exactly half the width is too much for OpenCascade's fillets).
   */
  private applyFullRound(feature: Feature): string | null {
    const picks = (feature.picks ?? []).filter((p) => p.ref.kind === "face");
    if (picks.length === 0) return "Click the flat top face of a rib or wall to round over.";
    const partIds = [...new Set(picks.map((p) => p.partId))];
    if (partIds.length > 1) return "A full round works on one part at a time. Remove the faces picked on the other part.";
    const part = this.parts.find((p) => p.id === partIds[0]);
    if (!part) return "The part these faces were on no longer exists. Edit this feature and pick the faces again.";
    let faces: Face[];
    try {
      faces = findPickedFaces(part.shape, picks);
    } catch (e) {
      return describeError(e, "Couldn't find the picked faces.");
    }
    let shape: Shape3D | null = part.shape.clone();
    try {
      for (const face of faces) {
        if (face.geomType !== "PLANE") return "Full round works on flat faces. Pick the flat top of the rib or wall.";
        const n = take(face.normalAt());
        // The two longest straight edges: the sides, which must be parallel.
        const lines = edgesOf(face)
          .map((e) => {
            try {
              if (e.geomType !== "LINE") return null;
              const a = take(e.startPoint);
              const b = take(e.endPoint);
              return { a, b, len: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) };
            } finally {
              e.delete();
            }
          })
          .filter((x): x is { a: Vec3; b: Vec3; len: number } => !!x)
          .sort((x, y) => y.len - x.len);
        if (lines.length < 2) return "Full round needs a face with two long straight sides (the top of a straight rib or wall).";
        const [s1, s2] = lines;
        const axis: Vec3 = [(s1.b[0] - s1.a[0]) / s1.len, (s1.b[1] - s1.a[1]) / s1.len, (s1.b[2] - s1.a[2]) / s1.len];
        const d2: Vec3 = [(s2.b[0] - s2.a[0]) / s2.len, (s2.b[1] - s2.a[1]) / s2.len, (s2.b[2] - s2.a[2]) / s2.len];
        if (Math.abs(Math.abs(dot3(axis, d2)) - 1) > 1e-6) return "The face's two long sides aren't parallel. Full round works on straight ribs and walls.";
        const across0 = cross3(n, axis);
        const off = (p: Vec3) => dot3([p[0] - s1.a[0], p[1] - s1.a[1], p[2] - s1.a[2]], across0);
        const width = Math.abs(off(s2.a));
        if (width < 1e-6) return "That face has no width to round over.";
        const across: Vec3 = off(s2.a) > 0 ? across0 : [-across0[0], -across0[1], -across0[2]];
        const r = width / 2;
        // Along the strip: from its first end to its last.
        const ts = [s1.a, s1.b, s2.a, s2.b].map((p) => dot3([p[0] - s1.a[0], p[1] - s1.a[1], p[2] - s1.a[2]], axis));
        const t0 = Math.min(...ts);
        const t1 = Math.max(...ts);
        const at = (t: number, w: number, h: number): Vec3 => [
          s1.a[0] + axis[0] * t + across[0] * w + n[0] * h,
          s1.a[1] + axis[1] * t + across[1] * w + n[1] * h,
          s1.a[2] + axis[2] * t + across[2] * w + n[2] * h,
        ];
        // The block taken away: the strip, half its width deep (and a little above, to be sure).
        const base = makePolygon([at(t0, 0, -r), at(t1, 0, -r), at(t1, width, -r), at(t0, width, -r)]);
        const lift = new Vector([n[0] * (r + 1), n[1] * (r + 1), n[2] * (r + 1)]);
        let block: Shape3D;
        try {
          block = basicFaceExtrusion(base, lift) as Shape3D;
        } finally {
          base.delete();
          lift.delete();
        }
        // Is the part solid all the way down there? (Otherwise the sides are too short for a full round.)
        const inside = shape.intersect(block) as Shape3D;
        const filled = measureVolume(inside);
        inside.delete();
        if (filled < (t1 - t0) * width * r * 0.999) {
          block.delete();
          return `The sides aren't tall enough for a full round: it needs ${Math.round(r * 100) / 100} mm of straight side below the face.`;
        }
        const cyl = makeCylinder(r, t1 - t0, at(t0, r, -r), axis);
        let round: Shape3D;
        try {
          round = cyl.intersect(block) as Shape3D;
        } finally {
          cyl.delete();
        }
        try {
          const trimmed: Shape3D = shape.cut(block);
          shape.delete();
          shape = trimmed;
          const rounded: Shape3D = shape.fuse(round);
          shape.delete();
          shape = rounded;
        } finally {
          block.delete();
          round.delete();
        }
      }
      if (!isValidSolid(shape)) return "That would leave the part broken.";
      part.shape.delete();
      part.shape = shape;
      part.featureIds.push(feature.id);
      shape = null;
      return null;
    } catch (e) {
      return describeError(e, "Couldn't round this over.");
    } finally {
      faces.forEach((f) => f.delete());
      shape?.delete();
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
    const part = [...this.parts].reverse().find((p) => !p.surface);
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
    const skin = [...ts, ...tls].find((p) => p.surface);
    if (skin) return `${skin.name} is a surface, with no inside to join or cut. Thicken it or Enclose it into a solid first.`;
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
        // What made the joined parts is now part of the first one, so a later pattern or mirror of it repeats on that.
        // (Only for Join: repeating a feature of an intersected part would add its whole solid back.)
        const joined = new Set(b.op === "union" ? ts.slice(1).map((p) => p.id) : []);
        for (const tool of this.tools.values()) if (joined.has(tool.partId)) tool.partId = ts[0].id;
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
    const turns: [number, Vec3][] = [
      [values.rx, [1, 0, 0]],
      [values.ry, [0, 1, 0]],
      [values.rz, [0, 0, 1]],
    ];
    const turning = turns.some(([a]) => Math.abs(a) > 1e-12);
    if (!turning && Math.abs(values.dx) + Math.abs(values.dy) + Math.abs(values.dz) < 1e-12 && !t.copy) {
      return { error: "Nothing to do yet — enter a distance to move or an angle to turn." };
    }
    const [lo, hi] = boundsOf(part.shape);
    const centre: [number, number, number] = t.about === "origin" ? [0, 0, 0] : [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const move = (s: Shape3D): Shape3D => {
      let out = s;
      for (const [a, axis] of turns) if (Math.abs(a) > 1e-12) out = out.rotate(a, centre, axis);
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
    // Its threads (for drawings) go with it.
    const turnVec = (p: Vec3, withCentre: boolean): Vec3 => {
      let q: Vec3 = withCentre ? [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]] : p;
      for (const [a, axis] of turns) if (Math.abs(a) > 1e-12) q = rotateAbout(q, axis, (a * Math.PI) / 180);
      return withCentre ? [q[0] + centre[0] + values.dx, q[1] + centre[1] + values.dy, q[2] + centre[2] + values.dz] : q;
    };
    const threads = part.threads?.map((m) => ({ ...m, origin: turnVec(m.origin, true), axis: turnVec(m.axis, false) }));
    // A sheet metal part's sheet moves with it, so flanges can still be added and its flat pattern still drawn.
    const f0 = part.sheet?.base.frame;
    const sheet = part.sheet && f0 ? { ...part.sheet, base: { ...part.sheet.base, frame: { origin: turnVec(f0.origin, true), u: turnVec(f0.u, false), v: turnVec(f0.v, false), n: turnVec(f0.n, false) } } } : undefined;
    const sheetCopy = sheet ? { sheet, sheetFeatures: [...(part.sheetFeatures ?? []), feature.id], ...(part.sheetCuts ? { sheetCuts: part.sheetCuts.map((c) => ({ ...c, lines: c.lines.map((l) => l.map((q) => [...q]) as [[number, number], [number, number]]) })) } : {}) } : {};
    if (t.copy) {
      // A copy of a surface is another surface.
      if (part.surface) {
        this.parts.push({ id: feature.id, name: `${part.name} (copy)`, featureIds: [feature.id], shape, surface: true });
        return {};
      }
      this.parts.push({ id: feature.id, name: `Part ${nextPartNumber}`, featureIds: [feature.id], shape, ...(threads ? { threads } : {}), ...sheetCopy });
      return { newPart: true };
    }
    part.shape.delete();
    part.shape = shape;
    part.featureIds.push(feature.id);
    if (threads) part.threads = threads;
    if (sheet) {
      part.sheet = sheet;
      part.sheetFeatures = [...(part.sheetFeatures ?? []), feature.id];
    }
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
  private applyPattern(feature: Feature, all: Feature[]): { error?: string } {
    const def = FEATURE_DEFS[feature.type];
    const { values, errors } = resolveParams(feature);
    const badParam = def.params.find((p) => errors[p.key]);
    if (badParam) return { error: `${badParam.label}: ${errors[badParam.key]}` };
    const mirror = feature.type === "mirror";
    const sourceIds = (mirror ? feature.mirror?.sources : feature.pattern?.sources) ?? [];
    if (sourceIds.length === 0) {
      return { error: `Pick the features to ${mirror ? "mirror" : "repeat"} — click them in the feature list while this dialog is open.` };
    }

    // Use the sources in the order they were built.
    const ordered = all.filter((f) => sourceIds.includes(f.id));
    const at = all.indexOf(feature);
    for (const id of sourceIds) {
      const f = all.find((x) => x.id === id);
      if (!f) return { error: "One of the features it repeats has been deleted. Edit this feature and pick again." };
      if (all.indexOf(f) > at) return { error: `${f.name} comes after this ${def.label.toLowerCase()} in the list.` };
      if (!isSolidFeature(f.type)) return { error: `${f.name} can't be ${mirror ? "mirrored" : "patterned"} — pick features that add or cut a solid.` };
      if (f.operation === "intersect") return { error: `${f.name} intersects, so it can't be ${mirror ? "mirrored" : "patterned"} — pick features that add or cut a solid.` };
      if (f.suppressed) return { error: `${f.name} is suppressed, so there's nothing to ${mirror ? "mirror" : "repeat"}.` };
      if (!this.tools.has(id)) return { error: `${f.name} couldn't be built, so it can't be ${mirror ? "mirrored" : "repeated"}.` };
    }

    // Where each copy goes (skipped copies are left out).
    const placements: ((s: Shape3D) => Shape3D)[] = [];
    const skip = feature.pattern?.skip;
    // A direction or axis picked in the 3D view, found on the part as it is now.
    let along: { dir: Vec3; through: Vec3 } | null = null;
    let along2: Vec3 | null = null;
    if (!mirror && feature.type !== "curvePattern") {
      try {
        if (feature.pattern?.along) along = this.pickedAxis(feature.pattern.along, feature.type === "circularPattern");
        if (feature.type === "linearPattern" && feature.pattern?.along2) along2 = this.pickedAxis(feature.pattern.along2, false).dir;
      } catch (e) {
        return { error: describeError(e, "Couldn't find the picked direction.") };
      }
    }
    if (mirror) {
      const frame = planeFrame(feature.mirror!.plane);
      placements.push((s) => s.mirror(frame.n, frame.origin));
    } else {
      const axis = AXES[feature.pattern?.axis ?? "x"];
      const sign = feature.pattern?.flip ? -1 : 1;
      const count = values.count;
      if (feature.type === "curvePattern") {
        const sk = all.find((f) => f.id === feature.pathRef);
        if (!feature.pathRef || !sk) return { error: "Choose the sketch with the path to follow." };
        if (all.indexOf(sk) > all.indexOf(feature)) return { error: `${sk.name} comes after this curve pattern in the list.` };
        if (sk.suppressed || !sk.sketch?.plane) return { error: `${sk.name} can't be used as the path.` };
        // Walk the path from the end nearest the first thing being repeated.
        const firstTool = this.tools.get(ordered[0]?.id ?? "");
        let near: Vec3 | undefined;
        if (firstTool) {
          const [lo, hi] = boundsOf(firstTool.shape);
          near = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
        }
        const walk = walkPath(sk.sketch.plane, sk.sketch.data, near);
        if (typeof walk === "string") return { error: walk };
        const stations = pathStations(walk, count);
        const first = walk.at(0);
        const flipped = !!feature.pattern?.flip;
        // From the end instead of the start.
        const along = (d: number) => walk.at(flipped ? walk.length - d : d);
        const origin = flipped ? walk.at(walk.length) : first;
        for (const [k, d] of stations.entries()) {
          if (k === 0 || isSkipped(skip, k + 1)) continue;
          const here = along(d);
          const move: Vec3 = [here.point[0] - origin.point[0], here.point[1] - origin.point[1], here.point[2] - origin.point[2]];
          if (feature.pattern?.follow) {
            // Turn with the path: by the angle between the directions at the start and here, about the start.
            const t0 = origin.tangent;
            const t1 = here.tangent;
            const axis = cross3(t0, t1);
            const sin = Math.hypot(...axis);
            const angle = (Math.atan2(sin, dot3(t0, t1)) * 180) / Math.PI;
            placements.push((s) => {
              const turned = sin > 1e-9 ? s.rotate(angle, origin.point, axis) : s;
              return turned.translate(move);
            });
          } else placements.push((s) => s.translate(move));
        }
      } else if (feature.type === "linearPattern") {
        // A grid when there's more than one row: rows of `count`, `count2` of them along the second direction.
        const rows = values.count2 ?? 1;
        const axis2Name = feature.pattern?.axis2 ?? (feature.pattern?.axis === "y" ? "x" : "y");
        const dir = along?.dir ?? axis;
        const axis2 = along2 ?? AXES[axis2Name];
        if (rows > 1 && Math.abs(dot3(dir, axis2)) > 0.999) return { error: "The rows must go along a different axis from the copies in each row. Choose (or click) another second direction." };
        const sign2 = feature.pattern?.flip2 ? -1 : 1;
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < count; i++) {
            if ((i === 0 && j === 0) || isSkipped(skip, copyNumber(i, j, count))) continue;
            const d = values.spacing * i * sign;
            const d2 = (values.spacing2 ?? 0) * j * sign2;
            placements.push((s) => s.translate([dir[0] * d + axis2[0] * d2, dir[1] * d + axis2[1] * d2, dir[2] * d + axis2[2] * d2]));
          }
        }
      } else {
        if (values.angle > 360) return { error: "Spread over: must be at most 360°" };
        const step = values.angle >= 360 - 1e-9 ? 360 / count : values.angle / (count - 1);
        // The axis goes through (cx, cy, cz) — the origin unless moved.
        const through: Vec3 = along?.through ?? [values.cx ?? 0, values.cy ?? 0, values.cz ?? 0];
        const turnAxis = along?.dir ?? axis;
        for (let i = 1; i < count; i++) if (!isSkipped(skip, i + 1)) placements.push((s) => s.rotate(step * i * sign, through, turnAxis));
      }
    }

    if (placements.length === 0) return { error: "Every copy is skipped, so the pattern does nothing. Take some numbers out of Skip copies." };

    // Work on copies of the parts, and only keep them if everything succeeds.
    const working = new Map<string, Shape3D>();
    const release = () => working.forEach((s) => s.delete());
    try {
      for (const source of ordered) {
        const tool = this.tools.get(source.id)!;
        const part = this.parts.find((p) => p.id === tool.partId);
        if (!part) {
          release();
          return { error: `The part ${source.name} belonged to no longer exists.` };
        }
        let shape = working.get(part.id) ?? part.shape.clone();
        if (part.surface) {
          // Copies of a surface are joined on as more of the same skin (sewn where they touch).
          const copies = placements.map((place) => place(tool.shape.clone()));
          try {
            const next = joinSurfaces([shape, ...copies]);
            shape.delete();
            shape = next;
          } finally {
            copies.forEach((c) => c.delete());
          }
          working.set(part.id, shape);
          continue;
        }
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
          return { error: "This would remove the whole part." };
        }
        working.set(part.id, shape);
      }
    } catch (e) {
      release();
      return { error: describeError(e, `Couldn't make this ${def.label.toLowerCase()}.`) };
    }
    for (const [id, shape] of working) {
      const part = this.parts.find((p) => p.id === id)!;
      part.shape.delete();
      part.shape = shape;
      part.featureIds.push(feature.id);
    }
    return {};
  }

  /** A cut came out right: a valid solid, with as many solids and shells as `plain` (the same cut without the extras), and less in it. */
  private soundCut(before: Shape3D, after: Shape3D): boolean {
    if (!isValidSolid(after)) return false;
    const count = (s: Shape3D) => {
      const shells = shellsOf(s);
      shells.forEach((x) => x.delete());
      return shells.length;
    };
    const solids = (s: Shape3D) => {
      const list = solidsOf(s);
      list.forEach((x) => x.delete());
      return list.length;
    };
    return count(after) === count(before) && solids(after) === solids(before) && measureVolume(after) < measureVolume(before) - 1e-3;
  }

  /**
   * A direction or axis picked in the 3D view, found on its part as it is now:
   * a straight edge (along it, as picked), a flat face (straight out of it),
   * or — for an axis — a round face or round edge (through its centre).
   */
  private pickedAxis(pick: TopoPick, round: boolean): { dir: Vec3; through: Vec3 } {
    const part = this.parts.find((p) => p.id === pick.partId);
    if (!part) throw new Error("The part with the picked direction no longer exists. Edit this pattern and click another edge.");
    const unit = (v: Vec3): Vec3 => {
      const l = Math.hypot(...v);
      return [v[0] / l, v[1] / l, v[2] / l];
    };
    if (pick.ref.kind === "edge") {
      const ref = pick.ref;
      const [edge] = findPickedEdges(part.shape, [pick]);
      try {
        const a = take(edge.startPoint);
        const b = take(edge.endPoint);
        if (edge.geomType === "LINE") {
          let dir = unit([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
          // The way it pointed when picked (OpenCascade may number the ends the other way round).
          if (dot3(dir, [ref.b[0] - ref.a[0], ref.b[1] - ref.a[1], ref.b[2] - ref.a[2]]) < 0) dir = [-dir[0], -dir[1], -dir[2]];
          return { dir, through: a };
        }
        if (round && edge.geomType === "CIRCLE") {
          const p0 = take(edge.pointAt(0));
          const p1 = take(edge.pointAt(1 / 3));
          const p2 = take(edge.pointAt(2 / 3));
          const c = circleThrough3D(p0, p1, p2);
          const n = cross3([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]]);
          if (c && Math.hypot(...n) > 1e-12) return { dir: unit(n), through: c.centre };
        }
      } finally {
        edge.delete();
      }
      throw new Error(round ? "That edge is neither straight nor round. Click a straight edge, a round edge or a round face for the axis." : "That edge is curved. Click a straight edge, or a flat face, for the direction.");
    }
    const [face] = findPickedFaces(part.shape, [pick]);
    try {
      if (round) {
        const cyl = cylinderOfFace(face);
        if (cyl) return { dir: cyl.axis, through: cyl.origin };
        throw new Error("That face isn't round. Click a round face (such as a hole or boss), a round edge or a straight edge for the axis.");
      }
      if (face.geomType !== "PLANE") throw new Error("That face is curved. Click a flat face (the copies go straight out of it) or a straight edge.");
      const c = take(face.center);
      return { dir: unit(take(face.normalAt(c))), through: c };
    } finally {
      face.delete();
    }
  }

  /**
   * Mirror a whole part across a plane: as a new part, or joined onto the
   * original (model one half, mirror it for the other).
   */
  private applyMirrorPart(feature: Feature, nextPartNumber: number): { error?: string; newPart?: boolean } {
    const m = feature.mirror!;
    if (!m.part) return { error: "Choose the part to mirror." };
    const part = this.parts.find((p) => p.id === m.part);
    if (!part) return { error: "The part it mirrors no longer exists (or is made later in the list). Edit this mirror and choose another part." };
    if (part.sheet) return { error: "Sheet metal parts can't be mirrored whole yet — the flat pattern couldn't follow. Mirror the features that made it, or copy it with Move / copy." };
    const frame = planeFrame(m.plane);
    // Its threads (for drawings), mirrored too.
    const reflect = (p: Vec3, point: boolean): Vec3 => {
      const k = 2 * dot3(point ? [p[0] - frame.origin[0], p[1] - frame.origin[1], p[2] - frame.origin[2]] : p, frame.n);
      return [p[0] - k * frame.n[0], p[1] - k * frame.n[1], p[2] - k * frame.n[2]];
    };
    const threads = part.threads?.map((t) => ({ ...t, origin: reflect(t.origin, true), axis: reflect(t.axis, false) }));
    let copy: Shape3D;
    try {
      copy = part.shape.clone().mirror(frame.n, frame.origin);
    } catch (e) {
      return { error: describeError(e, "Couldn't mirror this part.") };
    }
    if (m.join) {
      let joined: Shape3D;
      try {
        joined = part.surface ? joinSurfaces([part.shape, copy]) : part.shape.fuse(copy);
      } catch (e) {
        return { error: describeError(e, "Couldn't join the mirror image onto the part.") };
      } finally {
        copy.delete();
      }
      if (!part.surface) {
        const count = (x: Shape3D) => {
          const list = solidsOf(x);
          list.forEach((y) => y.delete());
          return list.length;
        };
        if (count(joined) > count(part.shape)) {
          joined.delete();
          return { error: "The mirror image doesn't touch the part, so they can't be joined into one. Untick Join to make it a new part, or mirror across a plane the part touches." };
        }
      }
      part.shape.delete();
      part.shape = joined;
      part.featureIds.push(feature.id);
      if (threads?.length) part.threads = [...(part.threads ?? []), ...threads];
      return {};
    }
    if (part.surface) {
      this.parts.push({ id: feature.id, name: `${part.name} (mirror)`, featureIds: [feature.id], shape: copy, surface: true });
      return {};
    }
    this.tools.set(feature.id, { shape: copy.clone(), operation: "new", partId: feature.id });
    this.parts.push({ id: feature.id, name: `Part ${nextPartNumber}`, featureIds: [feature.id], shape: copy, ...(threads?.length ? { threads } : {}) });
    return { newPart: true };
  }

  /** Hollow out a part, removing the picked faces. Returns an error message, or null. */
  private applyShell(feature: Feature): string | null {
    const { values, errors } = resolveParams(feature);
    if (errors.thickness) return `Wall thickness: ${errors.thickness}`;
    const facePicks = (feature.picks ?? []).filter((p) => p.ref.kind === "face");
    const partIds = [...new Set(facePicks.map((p) => p.partId))];
    if (partIds.length > 1) return "Shell works on one part at a time. Remove the faces picked on the other part.";
    const part = facePicks.length ? this.parts.find((p) => p.id === partIds[0]) : [...this.parts].reverse().find((p) => !p.surface);
    // Hollow: sealed inside, so the picked face only says which part.
    const picks = feature.hollow ? [] : facePicks;
    if (!part) return picks.length ? "The part these faces were on no longer exists. Edit this feature and pick the faces again." : "There's no part to hollow yet.";
    if (part.surface) return `${part.name} is a surface, with no inside to hollow. Use Thicken to give it walls instead.`;
    // Walls outside: the part itself becomes the space inside.
    const outward = !!feature.flipSide;
    // No faces picked — or every face (a ball has only one) — hollows it closed inside, with no opening.
    const all = facesOf(part.shape);
    const faceCount = all.length;
    all.forEach((f) => f.delete());
    if (picks.length === 0 || picks.length >= faceCount) {
      let inner: Shape3D | null = null;
      try {
        if (outward) {
          inner = offsetSolid(part.shape, values.thickness);
          const hollow = inner.cut(part.shape);
          if (!isValidSolid(hollow) || !grewWithin(part.shape, hollow, values.thickness)) {
            hollow.delete();
            return OUTWARD_FAILED;
          }
          part.shape.delete();
          part.shape = hollow;
          part.featureIds.push(feature.id);
          return null;
        }
        inner = offsetSolid(part.shape, -values.thickness);
        const hollow = part.shape.cut(inner);
        if (!isValidSolid(hollow) || !shrankWithin(part.shape, hollow)) {
          hollow.delete();
          return "Couldn't hollow this part. Try thinner walls — rounded corners and thin areas must be thicker than the walls.";
        }
        part.shape.delete();
        part.shape = hollow;
        part.featureIds.push(feature.id);
        return null;
      } catch {
        return outward ? OUTWARD_FAILED : "Couldn't hollow this part. Try thinner walls — rounded corners and thin areas must be thicker than the walls.";
      } finally {
        inner?.delete();
      }
    }

    let faces: Face[];
    try {
      faces = findPickedFaces(part.shape, picks);
    } catch (e) {
      return describeError(e, "Couldn't find the picked faces.");
    }
    const failed =
      "Couldn't hollow this part. Try thinner walls — rounded corners and thin areas must be thicker than the walls.";
    let shape: Shape3D | null = null;
    // A hollowed part must be valid, lighter than before, and no bigger than before. (With walls
    // thicker than the part, OpenCascade can "succeed" with a strange inside-out solid.)
    const pieceCount = (x: Shape3D) => {
      const list = solidsOf(x);
      list.forEach((y) => y.delete());
      return list.length;
    };
    const startPieces = pieceCount(part.shape);
    const curvedOpen = faces.some((f) => f.geomType !== "PLANE");
    // Walls outside that come apart (more separate pieces than the part had) aren't accepted.
    let cameApart = false;
    const good = (s: Shape3D) => {
      if (!isValidSolid(s)) return false;
      if (!outward) return shrankWithin(part.shape, s);
      if (!grewWithin(part.shape, s, values.thickness)) return false;
      if (pieceCount(s) > startPieces) {
        cameApart = true;
        return false;
      }
      return true;
    };
    try {
      try {
        // Walls outside: sealed walls with the openings cut away first — OpenCascade's own outward shell
        // can lose or add walls where an open face meets the part's other faces.
        shape = outward ? outwardByCutting(part.shape, faces, values.thickness) : part.shape.shell(values.thickness, (f) => f.inList(faces));
        if (!good(shape)) {
          shape.delete();
          shape = null;
        }
      } catch {
        shape = null;
      }
      // Round fillets OpenCascade's shell can come out broken: hollow it closed and cut the opening instead.
      // Walls outside: then OpenCascade's outward shell, sharp then with round joins.
      for (const attempt of outward ? [() => outwardShell(part.shape, faces, values.thickness), () => part.shape.shell(-values.thickness, (f) => f.inList(faces))] : []) {
        if (shape) break;
        try {
          shape = attempt();
          if (!good(shape)) {
            shape.delete();
            shape = null;
          }
        } catch {
          shape = null;
        }
      }
      if (!shape && !outward) {
        try {
          shape = shellByCutting(part.shape, faces, values.thickness);
          if (!good(shape)) {
            shape.delete();
            shape = null;
          }
        } catch {
          shape = null;
        }
      }
    } finally {
      faces.forEach((f) => f.delete());
    }
    if (!shape) return outward ? (cameApart ? OUTWARD_APART : curvedOpen ? OUTWARD_CURVED_OPEN : OUTWARD_OPEN_FAILED) : failed;
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
    const lopsided = feature.type === "chamfer" && feature.chamferType ? feature.chamferType : null;
    if (lopsided === "distanceAngle" && !(values.angle < 90)) return "Angle: use an angle between 0° and 90° (45° makes an even bevel).";

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
        if (lopsided) {
          // Two distances, or a distance and an angle: each edge needs the face its first distance runs along.
          const failed = "Couldn't bevel these edges. Try smaller distances — they have to fit on the faces next to each edge.";
          let shape: Shape3D;
          try {
            shape = lopsidedChamfer(part.shape, picks.filter((p) => p.partId === partId), lopsided, size, lopsided === "twoDistances" ? values.distance2 : values.angle, !!feature.flipSide);
          } catch (e) {
            if (e instanceof Error && /can't be found|no edges here/.test(e.message)) throw e;
            throw new Error(failed);
          }
          if (!isValidSolid(shape, !!part.surface)) {
            shape.delete();
            throw new Error(failed);
          }
          results.push({ part, shape });
          continue;
        }
        const chosen = findPickedEdges(part.shape, picks.filter((p) => p.partId === partId));
        // A variable fillet runs from one radius at the start of each edge to another at its end.
        const end = feature.type === "fillet" ? (values.endRadius ?? 0) : 0;
        const radius: number | [number, number] = end > 0 && Math.abs(end - size) > 1e-9 ? [size, end] : size;
        const pick = (e: Edge) => (chosen.some((c) => c.isSame(e)) ? radius : null);
        const failed =
          feature.type === "fillet"
            ? "Couldn't round these edges. Try a smaller radius — it has to fit on the faces next to each edge."
            : "Couldn't bevel these edges. Try a smaller distance — it has to fit on the faces next to each edge.";
        let shape: Shape3D;
        try {
          shape = feature.type === "fillet" ? part.shape.fillet(pick) : part.shape.chamfer((e: Edge) => (chosen.some((c) => c.isSame(e)) ? size : null));
        } catch {
          throw new Error(failed);
        } finally {
          chosen.forEach((c) => c.delete());
        }
        // OpenCascade sometimes "succeeds" with a broken solid when the size is too big.
        if (!isValidSolid(shape, !!part.surface)) {
          shape.delete();
          throw new Error(failed);
        }
        if (part.surface) {
          // The rounded surface comes back in pieces: one skin again.
          const sewnUp = joinSurfaces([shape]);
          shape.delete();
          shape = sewnUp;
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
    const chosen = partIds.length ? this.parts.filter((p) => partIds.includes(p.id)) : this.parts.filter((p) => !p.configured);
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
          exactVolume = p.surface ? 0 : measureVolume(p.shape);
        } catch {
          exactVolume = null;
        }
        const m = p.shape.mesh(tol);
        const mesh = analyzeMesh(m.vertices, m.triangles);
        // Measuring wall thickness only makes sense on a closed surface.
        const thinnest = mesh.watertight && !p.surface ? estimateThickness(m.vertices, m.triangles) : null;
        return { partId: p.id, name: p.name, geometryValid, exactVolume, mesh, thinnest, ...(p.surface ? { surface: true } : {}) };
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
      const chosen = partIds.length ? this.parts.filter((p) => partIds.includes(p.id)) : this.parts.filter((p) => !p.configured);
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
  private placeInstances(instances: InstanceInput[]): { id: string; partId: string; name: string; shape: Shape3D; surface?: boolean }[] {
    const out: { id: string; partId: string; name: string; shape: Shape3D; surface?: boolean }[] = [];
    for (const i of instances) {
      // A part in another configuration, or (in the one on show) the ordinary part.
      const part = this.parts.find((p) => p.id === i.partId) ?? this.parts.find((p) => p.id === i.partId.split("@")[0]);
      if (!part) continue;
      let shape = part.shape.clone();
      // A mirrored copy: the part's mirror image, flipped across its own YZ plane.
      if (i.mirrored) shape = shape.mirror("YZ", [0, 0, 0]);
      const [x, y, z, w] = i.rotation;
      const s = Math.sqrt(Math.max(0, 1 - w * w));
      const angle = (2 * Math.acos(Math.max(-1, Math.min(1, w))) * 180) / Math.PI;
      if (s > 1e-9 && Math.abs(angle) > 1e-9) shape = shape.rotate(angle, [0, 0, 0], [x / s, y / s, z / s]);
      if (Math.abs(i.position[0]) + Math.abs(i.position[1]) + Math.abs(i.position[2]) > 0) shape = shape.translate(i.position);
      out.push({ id: i.id, partId: i.partId, name: i.name, shape, ...(part.surface ? { surface: true } : {}) });
    }
    return out;
  }

  /**
   * Drawing views: the chosen parts (or an assembly's placed copies) seen from
   * each direction, with the lines hidden behind the part worked out.
   */
  project(partIds: string[], instances: InstanceInput[] | undefined, views: ViewKind[], withHidden = true, sections: SectionRequest[] = [], breakouts: BreakOutRequest[] = [], tangent = true): ViewProjection[] {
    const placed = instances?.length ? this.placeInstances(instances) : [];
    const chosen = partIds.length ? this.parts.filter((p) => partIds.includes(p.id)) : this.parts.filter((p) => !p.configured);
    const shapes = placed.length ? placed.map((p) => p.shape) : chosen.map((p) => p.shape);
    const empty = (kind: string): ViewProjection => ({ kind, visible: [], hidden: [], circles: [], points: [], bounds: null });
    // The flat pattern view: the one sheet metal part drawn (nothing for assemblies or several parts).
    const flatView = (): ViewProjection => {
      const sheets = placed.length ? [] : chosen.filter((p) => p.sheet);
      const flat = sheets.length === 1 ? this.flatOf(sheets[0]) : null;
      return flat ? flatProjection(flat) : empty("flat");
    };
    const standard = views.filter((k) => k !== "section" && k !== "flat");
    const flats = views.filter((k) => k === "flat").map(flatView);
    if (shapes.length === 0) {
      placed.forEach((p) => p.shape.delete());
      return [...standard.map(empty), ...flats, ...sections.map((s) => empty(s.key))];
    }
    const whole = (shapes.length === 1 ? shapes[0] : makeCompound(shapes)) as Shape3D;
    let wholeAxes: [Vec3, Vec3][] | null = null;
    try {
      const out: ViewProjection[] = standard.map((kind) => {
        const { toward, right } = VIEW_CAMERAS[kind];
        // Centre lines of round faces seen from the side (not in the 3D view).
        return projectView(whole, kind, toward, right, withHidden, kind === "iso" ? [] : (wholeAxes ??= cylinderAxes(whole)), tangent);
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
          // Seen from the side: the hole's length on the view, for thread symbols on tapped holes.
          const flatP = (p: Vec3): [number, number] => [dot3(p, right), dot3(p, up)];
          const side = found
            .filter((h) => Math.abs(dot3(h.into, toward)) < 1e-3)
            .map((h) => ({ a: flatP(h.entry), b: flatP([h.entry[0] + h.into[0] * h.depth, h.entry[1] + h.into[1] * h.depth, h.entry[2] + h.into[2] * h.depth]), d: h.diameter }));
          if (side.length) view.sideHoles = side;
        });
        // Threads on rods and in holes (Thread features and fasteners), drawn the standard way.
        const marks = chosen.flatMap((p) => p.threads ?? []);
        if (marks.length) {
          out.forEach((view, i) => {
            const kind = standard[i];
            if (kind === "iso") return;
            const { toward, right } = VIEW_CAMERAS[kind];
            const up = cross3(toward, right);
            const lines = threadMarkLines(marks, toward, right, up);
            if (lines.length) view.threadMarks = lines;
          });
        }
      }
      // How deep each flat view sees the part (front to back), for broken-out cuts.
      const [blo, bhi] = boundsOf(whole);
      const corners: Vec3[] = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i & 1 ? bhi[0] : blo[0], i & 2 ? bhi[1] : blo[1], i & 4 ? bhi[2] : blo[2]]);
      const along = (t: Vec3) => corners.map((c) => dot3(c, t));
      out.forEach((view, i) => {
        if (standard[i] === "iso") return;
        const a = along(VIEW_CAMERAS[standard[i]].toward);
        view.depth = Math.max(...a) - Math.min(...a);
      });
      // Broken-out cuts: the view drawn again with the material inside each rectangle cut away to its depth.
      for (const host of [...new Set(breakouts.map((b) => b.host))]) {
        const at = out.findIndex((p) => p.kind === host);
        const plain = out[at];
        if (at < 0 || !plain?.bounds) continue;
        const { toward, right } = VIEW_CAMERAS[host];
        const up = cross3(toward, right);
        const front = Math.max(...along(toward));
        const diag = Math.hypot(bhi[0] - blo[0], bhi[1] - blo[1], bhi[2] - blo[2]);
        const mine = breakouts.filter((b) => b.host === host);
        const rects = mine.map((b) => {
          const p = fromRel(plain.bounds!, b.a);
          const q = fromRel(plain.bounds!, b.b);
          return { x0: Math.min(p[0], q[0]), y0: Math.min(p[1], q[1]), x1: Math.max(p[0], q[0]), y1: Math.max(p[1], q[1]), h: front - b.depth };
        });
        const at3 = (x: number, y: number, h: number): Vec3 => [x * right[0] + y * up[0] + h * toward[0], x * right[1] + y * up[1] + h * toward[1], x * right[2] + y * up[2] + h * toward[2]];
        let cut: Shape3D | null = null;
        try {
          const L = 2 * diag + 10;
          const boxes = rects.filter((r) => r.x1 - r.x0 > 1e-6 && r.y1 - r.y0 > 1e-6).map((r) => {
            const face = makePolygon([at3(r.x0, r.y0, r.h), at3(r.x1, r.y0, r.h), at3(r.x1, r.y1, r.h), at3(r.x0, r.y1, r.h)]);
            const v = new Vector([toward[0] * L, toward[1] * L, toward[2] * L]);
            try {
              return basicFaceExtrusion(face, v) as Shape3D;
            } finally {
              face.delete();
              v.delete();
            }
          });
          const cutter = fusePieces(boxes);
          if (!cutter) continue;
          try {
            cut = whole.cut(cutter);
          } finally {
            cutter.delete();
          }
          const view = projectView(cut, host, toward, right, withHidden, cylinderAxes(cut), tangent);
          // The faces left at the bottom of each cut, hatched like a section.
          const m = cut.mesh(MESH_TOLERANCES.display);
          const vs = m.vertices;
          const tol = 1e-4 * Math.max(1, diag);
          const faces: number[] = [];
          for (let i = 0; i + 2 < m.triangles.length; i += 3) {
            const ids = [m.triangles[i], m.triangles[i + 1], m.triangles[i + 2]];
            const pts = ids.map((k): Vec3 => [vs[3 * k], vs[3 * k + 1], vs[3 * k + 2]]);
            const r = rects.find((rc) => pts.every((p) => Math.abs(dot3(p, toward) - rc.h) < tol && dot3(p, right) > rc.x0 - tol && dot3(p, right) < rc.x1 + tol && dot3(p, up) > rc.y0 - tol && dot3(p, up) < rc.y1 + tol));
            if (r) for (const p of pts) faces.push(dot3(p, right), dot3(p, up));
          }
          view.cutFaces = faces;
          view.breakLines = rects.map((r) => [r.x0, r.y0, r.x1, r.y0, r.x1, r.y1, r.x0, r.y1, r.x0, r.y0]);
          view.depth = plain.depth;
          view.holes = plain.holes;
          // Thread symbols stay (the plain view's).
          if (plain.threadMarks) view.threadMarks = plain.threadMarks;
          if (plain.sideHoles) view.sideHoles = plain.sideHoles;
          // Keep the plain view's box, so dimensions and other views stay where they were.
          view.bounds = plain.bounds;
          out[at] = view;
        } catch {
          // Left as it was: the plain view.
        } finally {
          cut?.delete();
        }
      }
      out.push(...flats);
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
        if (req.aux) {
          // Auxiliary view: the whole part, looked at square-on to the line.
          out.push(projectView(whole, req.key, geo.toward, geo.right, withHidden, (wholeAxes ??= cylinderAxes(whole)), tangent));
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
          const view = projectView(cut.shape, req.key, geo.toward, geo.right, false, cylinderAxes(cut.shape), tangent);
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

  /** How pairs of assembly instances meet: overlapping, or within `tolerance` (mm) of each other (see clash.ts). */
  clashes(instances: InstanceInput[], tolerance = 0, withGaps = true): ContactMeasure[] {
    const placed = this.placeInstances(instances);
    try {
      return measureContacts(placed, tolerance, withGaps);
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
    return { stl: writeBinaryStl(meshes, `JuraCAD export: ${names}`), triangleCount };
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

  /**
   * A sheet metal part laid out flat: its walls (with whatever was cut from
   * them) laid down, its bends unrolled into strips with any cuts through them,
   * and corner reliefs cut out. Null if it can't be.
   */
  private laidFlat(p: BuiltPart, folded: FoldedSheet): Shape3D | null {
    if (!p.sheet) return null;
    const T = p.sheet.thickness;
    let out = unfoldedSolid(p.shape, folded, T);
    if (!out) return null;
    if (folded.cornerReliefs?.length) out = cutFlatCornerReliefs(out, folded, T);
    const loops = (p.sheetCuts ?? []).flatMap((c) => {
      const bend = c.bend ? folded.bends.find((b) => b.flangeId === c.bend) : undefined;
      return bend ? chainLoops(c.lines, 1e-5).map((loop) => loop.map((q) => flatPoint(bend.flat, q))) : [];
    });
    if (loops.length) out = cutFlatLoops(out, folded.walls[0].frame, loops, T);
    return out;
  }

  /** A sheet metal part laid out flat (its walls laid down, bends unrolled into strips), meshed for display. */
  unfold(partId: string): PartMesh | null {
    const part = this.parts.find((p) => p.id === partId);
    if (!part?.sheet) return null;
    let solid: Shape3D | null = null;
    try {
      solid = this.laidFlat(part, foldSheet(part.sheet));
      if (!solid) return null;
      return this.meshPartShape({ id: part.id, name: part.name, featureIds: [...part.featureIds], shape: solid });
    } catch {
      return null;
    } finally {
      solid?.delete();
    }
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
    this.threadedHoles.forEach((s) => s.delete());
    this.threadedHoles.clear();
    this.threadedResults.forEach((r) => (r.shape.delete(), r.tool.delete()));
    this.threadedResults.clear();
  }

  private meshPart(p: BuiltPart): PartMesh {
    const mesh = this.meshPartShape(p);
    const flat = this.flatOf(p);
    // The exact volume, for weights in parts lists (quick next to making the mesh).
    let volume: number | null = null;
    if (!p.surface) {
      try {
        volume = measureVolume(p.shape);
      } catch {
        volume = null;
      }
    }
    return { ...mesh, ...(flat ? { flat } : {}), ...(p.surface ? { surface: true } : {}), ...(volume !== null && Number.isFinite(volume) && volume > 0 ? { volume } : {}) };
  }

  /** A sheet metal part's flat pattern (null for other parts, or if it can't be unfolded). */
  private flatOf(p: BuiltPart): FlatPatternData | null {
    if (!p.sheet) return null;
    try {
      const folded = foldSheet(p.sheet);
      const flat = flatPattern(folded);
      const s = p.sheet;
      const cuts = outsideOnly(
        (p.sheetCuts ?? []).flatMap((c) => {
          if (c.bend) {
            const bend = folded.bends.find((b) => b.flangeId === c.bend);
            if (!bend) return [];
            return bendCutToFlat(bend, c.lines);
          }
          const wall = folded.walls.find((w) => w.id === c.wall);
          return wall ? c.lines.map(([a, b]): [[number, number], [number, number]] => [flatPoint(wall.flat, a), flatPoint(wall.flat, b)]) : [];
        }),
      );
      const out: FlatPatternData = { ...flat, cuts, thickness: s.thickness, radius: s.radius, k: s.k, notShown: p.featureIds.filter((id) => !p.sheetFeatures?.includes(id)) };
      // With tabs, corner reliefs or cuts the outline isn't a simple walk round the walls: take it from the part laid out flat.
      if (s.tabs?.length || s.corners?.length || folded.cornerReliefs?.length || p.sheetCuts?.length) {
        const unfolded = this.laidFlat(p, folded);
        if (unfolded) {
          try {
            out.boundary = flatBoundary(unfolded, folded.walls[0].frame);
          } finally {
            unfolded.delete();
          }
        }
      }
      return out;
    } catch {
      return null;
    }
  }

  private meshPartShape(p: BuiltPart): PartMesh {
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
