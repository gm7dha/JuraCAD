/**
 * Onshape's other Plane types, worked out from points, lines and directions
 * (pure): Plane point, Point normal, Line angle, Three point, Curve point and
 * Fit. The clicked things are `GeomPick`s, kept as numbers as last found (the
 * engine finds them again on the model as it changes; see engine.ts
 * `followPlaneDef`), so this only does the maths.
 *
 * And a Part Studio mate connector's frame: where it sits, then the moves and
 * turns typed (Onshape's Mate connector feature).
 */
import type { GeomPick, MateConnectorDef, PlaneMoreMode, PlaneOptions, TransformFrame } from "../model/types";
import { cross, dot, normalize, planeFrame, type PlaneFrame, type Vec3 } from "./planes";

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const neg = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];

/** The plane types added after offset / angle / midplane. */
export const MORE_PLANE_MODES: readonly PlaneMoreMode[] = ["point", "pointNormal", "lineAngle", "threePoint", "curvePoint", "fit"];

export function isMorePlaneMode(mode: string): mode is PlaneMoreMode {
  return (MORE_PLANE_MODES as readonly string[]).includes(mode);
}

/** How many points each type needs (fit: at least this many). */
export function pointsNeeded(mode: PlaneMoreMode): number {
  return mode === "threePoint" || mode === "fit" ? 3 : mode === "lineAngle" ? 0 : 1;
}

/** Does this type need a line (or direction)? */
export function needsLine(mode: PlaneMoreMode): boolean {
  return mode === "pointNormal" || mode === "lineAngle" || mode === "curvePoint";
}

/** In-plane directions for a normal, chosen the same way every time (u towards world X, else world Y — as mate connectors). */
export function basisFor(n: Vec3): { u: Vec3; v: Vec3 } {
  const ref: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(sub(ref, scale(n, dot(ref, n))));
  return { u, v: normalize(cross(n, u)) };
}

/** A plane through `origin` with normal `n` (and, when given, `u` as its across direction). */
export function frameFrom(origin: Vec3, n: Vec3, u?: Vec3): PlaneFrame {
  const nn = normalize(n);
  if (u) {
    const uu = sub(u, scale(nn, dot(u, nn)));
    if (len(uu) > 1e-9) {
      const un = normalize(uu);
      return { origin, u: un, v: normalize(cross(nn, un)), n: nn };
    }
  }
  return { origin, ...basisFor(nn), n: nn };
}

/** Turn `w` about the unit axis `k` by `deg` degrees. */
export function rotateAbout(w: Vec3, k: Vec3, deg: number): Vec3 {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const kw = cross(k, w);
  const d = dot(k, w) * (1 - c);
  return [w[0] * c + kw[0] * s + k[0] * d, w[1] * c + kw[1] * s + k[1] * d, w[2] * c + kw[2] * s + k[2] * d];
}

/**
 * Line angle's starting plane (Onshape's default reference): the plane that holds the line and stands upright —
 * holding the Z axis's direction — or, for an upright line, the one that also holds X.
 */
export function lineAngleReference(dir: Vec3): Vec3 {
  const d = normalize(dir);
  const n = cross(d, [0, 0, 1]);
  return len(n) > 1e-6 ? normalize(n) : normalize(cross(d, [1, 0, 0]));
}

/** Best-fit plane through points (least squares): their middle and the direction they spread least in. Null for fewer than 3 or points all in a line. */
export function fitPlane(points: Vec3[]): { origin: Vec3; n: Vec3 } | null {
  if (points.length < 3) return null;
  const c = scale(points.reduce((a, p) => add(a, p), [0, 0, 0] as Vec3), 1 / points.length);
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const p of points) {
    const d = sub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += d[i] * d[j];
  }
  const { values, vectors } = eigen(m);
  const order = [0, 1, 2].sort((a, b) => values[a] - values[b]);
  // Spread in a line only (the two smallest are both ~0): no single plane.
  const size = Math.max(values[order[2]], 1e-30);
  if (values[order[1]] <= size * 1e-12) return null;
  let n = normalize(vectors[order[0]]);
  // The same way every time: facing up, else towards +Y, else +X.
  const w = Math.abs(n[2]) > 1e-9 ? n[2] : Math.abs(n[1]) > 1e-9 ? n[1] : n[0];
  if (w < 0) n = neg(n);
  return { origin: c, n };
}

/** Eigenvalues and eigenvectors of a symmetric 3×3 matrix (Jacobi). */
function eigen(input: number[][]): { values: number[]; vectors: Vec3[] } {
  const a = input.map((r) => [...r]);
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-30) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k];
        const aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p];
        const vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: [a[0][0], a[1][1], a[2][2]], vectors: [0, 1, 2].map((i) => [v[0][i], v[1][i], v[2][i]] as Vec3) };
}

const MISSING_POINT: Record<PlaneMoreMode, string> = {
  point: "Click a point for the plane to go through: a corner, an edge's middle, a sketch point or a mate connector.",
  pointNormal: "Click a point for the plane to go through: a corner, an edge's middle, a sketch point or a mate connector.",
  lineAngle: "",
  threePoint: "Click three points for the plane to go through: corners, edges' middles, sketch points or mate connectors.",
  curvePoint: "Click an edge: the plane stands square to it, at the place along it you choose.",
  fit: "Click at least three points (corners, sketch points or mate connectors) for the plane to fit through.",
};

/** Where one of the newer plane types is, or why it can't be made. `angle` is in degrees (Line angle). */
export function morePlaneFrame(def: PlaneOptions & { mode: PlaneMoreMode }, values: { angle?: number }): PlaneFrame | string {
  const mode = def.mode;
  const pts = (def.points ?? []).map((p) => p.p);
  const flipped = (f: PlaneFrame): PlaneFrame => (def.flip ? { origin: f.origin, u: neg(f.u), v: f.v, n: neg(f.n) } : f);
  if (pts.length < pointsNeeded(mode)) return MISSING_POINT[mode];
  const line = def.line;
  const lineDir = line?.dir && len(line.dir) > 1e-12 ? normalize(line.dir) : null;
  switch (mode) {
    case "point": {
      const base = planeFrame(def.ref);
      return flipped({ ...base, origin: pts[0] });
    }
    case "pointNormal": {
      if (!lineDir) return "Click what the plane stands square to: a straight edge, a sketch line, an axis, or a flat face (then it lies flat to it).";
      return flipped(frameFrom(pts[0], lineDir));
    }
    case "curvePoint": {
      // The edge's direction where the point is (found with the point), else as clicked.
      const at = def.points?.[0]?.dir;
      const dir = at && len(at) > 1e-12 ? normalize(at) : lineDir;
      if (!dir) return MISSING_POINT.curvePoint;
      return flipped(frameFrom(pts[0], dir));
    }
    case "lineAngle": {
      if (!line || !lineDir) return "Click a straight edge, a sketch line or an axis for the plane to turn about.";
      const n0 = lineAngleReference(lineDir);
      const n = rotateAbout(n0, lineDir, values.angle ?? 0);
      // Across = along the line, so the plane holds the line.
      return flipped(frameFrom(line.p, n, lineDir));
    }
    case "threePoint": {
      const [a, b, c] = pts;
      const n = cross(sub(b, a), sub(c, a));
      const scaleOf = Math.max(len(sub(b, a)), len(sub(c, a)), 1e-9);
      if (len(n) <= 1e-9 * scaleOf * scaleOf) return "The three points are in a line (or two are the same), so they don't make a plane. Click a different point.";
      return flipped(frameFrom(a, n, sub(b, a)));
    }
    case "fit": {
      const fit = fitPlane(pts);
      if (!fit) return "The points are all in a line, so no one plane fits them. Click a point off that line.";
      return flipped(frameFrom(fit.origin, fit.n));
    }
  }
}

/** The things a plane follows, for listing and checking (points, then the line). */
export function planePicks(def: PlaneOptions): GeomPick[] {
  return [...(def.points ?? []), ...(def.line ? [def.line] : [])];
}

/** Plain words for a clicked point or line. */
export function geomPickLabel(g: GeomPick, names: (id: string) => string | undefined = () => undefined): string {
  if (g.axis) return `${g.axis.toUpperCase()} axis`;
  if (g.connector) return names(g.connector) ?? "A mate connector";
  if (g.curve) return `${g.end === "a" ? "The start of " : g.end === "b" ? "The end of " : g.end === "mid" ? "The middle of " : ""}${names(g.curve) ?? "a curve"}`;
  if (g.sketchPoint) return g.sketchPoint.point === "origin" ? `Origin of ${names(g.sketchPoint.sketch) ?? "a sketch"}` : `A point of ${names(g.sketchPoint.sketch) ?? "a sketch"}`;
  if (g.sketchLine) return `A line of ${names(g.sketchLine.sketch) ?? "a sketch"}`;
  if (g.pick) {
    const part = names(g.pick.partId) ?? "a part";
    if (g.pick.ref.kind === "face") return `${g.pick.ref.surface === "PLANE" ? "A flat face" : "A round face"} of ${part}`;
    if (g.end === "a" || g.end === "b") return `A corner of ${part}`;
    if (g.end === "mid") return `An edge's middle of ${part}`;
    return `${g.pick.ref.curve === "LINE" ? "A straight edge" : "An edge"} of ${part}`;
  }
  return "A point";
}

// ---------------------------------------------------------------------------
// Part Studio mate connectors

/** A frame with its Y worked out. */
export interface FullFrame {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

/** The connector's frame: where it sits (`base`), turned over when `flipZ`, then moved along and turned about its own X, Y and Z (degrees). */
export function connectorFrame(def: Pick<MateConnectorDef, "base" | "flipZ">, v: { dx?: number; dy?: number; dz?: number; rx?: number; ry?: number; rz?: number }): FullFrame {
  let z = normalize(def.base.z);
  let x = normalize(sub(def.base.x, scale(z, dot(def.base.x, z))));
  let y = normalize(cross(z, x));
  // Turned over about its X: Z and Y the other way.
  if (def.flipZ) {
    z = neg(z);
    y = neg(y);
  }
  const origin = add(def.base.origin, add(add(scale(x, v.dx ?? 0), scale(y, v.dy ?? 0)), scale(z, v.dz ?? 0)));
  // Turns about its own axes, one after another (X, then the new Y, then the new Z).
  const turn = (axis: Vec3, deg: number) => {
    if (!deg) return;
    x = normalize(rotateAbout(x, axis, deg));
    y = normalize(rotateAbout(y, axis, deg));
    z = normalize(rotateAbout(z, axis, deg));
  };
  turn(x, v.rx ?? 0);
  turn(y, v.ry ?? 0);
  turn(z, v.rz ?? 0);
  return { origin, x, y, z };
}

/** A frame as Move / copy keeps it (origin, X, Z). */
export function asTransformFrame(f: FullFrame): TransformFrame {
  return { origin: f.origin, x: f.x, z: f.z };
}

/** A connector's XY plane, to sketch on (the plane's normal is its Z). */
export function connectorPlane(f: FullFrame): PlaneFrame {
  return { origin: f.origin, u: f.x, v: f.y, n: f.z };
}

/** A frame square to a normal, X chosen the usual way: for a connector on a plane or a sketch point. */
export function frameOnPlane(origin: Vec3, plane: PlaneFrame): TransformFrame {
  return { origin, x: plane.u, z: plane.n };
}
