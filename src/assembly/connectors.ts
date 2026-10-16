/**
 * Mate connectors: a little coordinate frame (origin plus X and Z directions)
 * worked out from a picked face or edge, in the part's own coordinates.
 * Like Onshape's inferred connectors:
 *  - a flat face: its centre, Z pointing out of the face
 *  - a round face (hole, pin): on its axis, halfway along, Z along the axis
 *  - a circular edge: its centre, Z along the axis
 *  - a straight edge: its middle, Z along the edge
 *  - a ball: its centre
 * Everything comes from the display mesh, whose corners lie exactly on the
 * real surface, so circles and axes come out exact.
 */
import { circleThrough3D } from "../geometry/measureMath";
import { matchRefs, type TopoPick } from "../geometry/topoRef";
import type { PartMesh } from "../kernel/protocol";
import { add, cross, dot, length, normalize, quatNormalize, scale, sub, type Placement, type Quat, type Vec3 } from "./math";

export interface Frame {
  origin: Vec3;
  /** Unit direction of the connector's Z (primary) axis. */
  z: Vec3;
  /** Unit direction of its X axis (at right angles to Z). */
  x: Vec3;
  /** For Tangent mates: a flat face, or a round one (cylinder: Z along its axis; ball: origin at its centre) and its radius. */
  surface?: "plane" | "cylinder" | "sphere";
  radius?: number;
}

type MeshData = Pick<PartMesh, "vertices" | "normals" | "triangles" | "faceGroups" | "lines" | "edgeGroups" | "faceRefs" | "edgeRefs">;

const at = (a: ArrayLike<number>, i: number): Vec3 => [a[3 * i], a[3 * i + 1], a[3 * i + 2]];

/** An X direction at right angles to `z`, chosen the same way every time (towards world X, else world Y). */
export function perpendicularX(z: Vec3): Vec3 {
  const ref: Vec3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalize(sub(ref, scale(z, dot(ref, z))));
}

function frame(origin: Vec3, z: Vec3): Frame {
  const zz = normalize(z);
  return { origin, z: zz, x: perpendicularX(zz) };
}

/** The turn that takes the world X, Y, Z axes to a frame's axes. */
export function quatFromBasis(x: Vec3, y: Vec3, z: Vec3): Quat {
  // Rotation matrix with columns x, y, z.
  const [m00, m10, m20] = x;
  const [m01, m11, m21] = y;
  const [m02, m12, m22] = z;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return quatNormalize(q);
}

/** A frame as a placement: where the connector's origin is and how its axes are turned. */
export function framePlacement(f: Frame): Placement {
  return { position: f.origin, rotation: quatFromBasis(f.x, cross(f.z, f.x), f.z) };
}

/** Eigenvalues and eigenvectors of a symmetric 3×3 matrix (Jacobi's method). */
export function symmetricEigen(m: number[][]): { values: number[]; vectors: Vec3[] } {
  const a = m.map((r) => [...r]);
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-14) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (Math.abs(a[p][q]) < 1e-18) continue;
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
  return {
    values: [a[0][0], a[1][1], a[2][2]],
    vectors: [0, 1, 2].map((j) => [v[0][j], v[1][j], v[2][j]] as Vec3),
  };
}

/** The corners (and their surface directions) of one face of the mesh, each once. */
function faceVertices(mesh: MeshData, index: number): { points: Vec3[]; normals: Vec3[]; centroid: Vec3; area: number } | null {
  const g = mesh.faceGroups[index];
  if (!g) return null;
  const t = mesh.triangles;
  const seen = new Set<number>();
  const points: Vec3[] = [];
  const normals: Vec3[] = [];
  let area = 0;
  let centroid: Vec3 = [0, 0, 0];
  for (let i = g.start; i < g.start + g.count && i + 2 < t.length; i += 3) {
    const [a, b, c] = [at(mesh.vertices, t[i]), at(mesh.vertices, t[i + 1]), at(mesh.vertices, t[i + 2])];
    const ar = length(cross(sub(b, a), sub(c, a))) / 2;
    area += ar;
    centroid = add(centroid, scale(add(add(a, b), c), ar / 3));
    for (const vi of [t[i], t[i + 1], t[i + 2]]) {
      if (seen.has(vi)) continue;
      seen.add(vi);
      points.push(at(mesh.vertices, vi));
      normals.push(normalize(at(mesh.normals, vi)));
    }
  }
  if (points.length === 0) return null;
  if (area < 1e-12) centroid = scale(points.reduce(add, [0, 0, 0] as Vec3), 1 / points.length);
  else centroid = scale(centroid, 1 / area);
  return { points, normals, centroid, area };
}

/**
 * Centre of a round surface where every point is the same distance r from it
 * along its surface direction (cylinder: in the plane across `axis`; ball: in 3D).
 */
function roundCentre(points: Vec3[], normals: Vec3[], axis: Vec3 | null): Vec3 | null {
  const flat = (v: Vec3) => (axis ? sub(v, scale(axis, dot(v, axis))) : v);
  const n = points.length;
  let s: Vec3 = [0, 0, 0];
  let P: Vec3 = [0, 0, 0];
  let q = 0;
  let w = 0;
  for (let i = 0; i < n; i++) {
    const p = flat(points[i]);
    const m = flat(normals[i]);
    s = add(s, m);
    P = add(P, p);
    q += dot(m, m);
    w += dot(m, p);
  }
  const denom = q - dot(s, s) / n;
  if (Math.abs(denom) < 1e-9 * Math.max(1, q)) return null;
  const r = (w - dot(s, P) / n) / denom;
  return scale(sub(P, scale(s, r)), 1 / n);
}

/** Connector for a face of a part (in the part's own coordinates), or null. */
export function faceFrame(mesh: MeshData, index: number): Frame | null {
  const f = faceVertices(mesh, index);
  if (!f) return null;
  const surface = mesh.faceRefs?.[index]?.surface ?? "UNKNOWN";
  const avgNormal = normalize(f.normals.reduce(add, [0, 0, 0] as Vec3));

  if (surface === "PLANE") return { ...frame(f.centroid, length(avgNormal) > 0 ? avgNormal : mesh.faceRefs[index].normal), surface: "plane" };

  if (surface === "SPHERE") {
    const c = roundCentre(f.points, f.normals, null);
    if (!c) return null;
    const radius = f.points.reduce((t, p) => t + length(sub(p, c)), 0) / f.points.length;
    return { ...frame(c, [0, 0, 1]), surface: "sphere", radius };
  }

  // Surfaces of revolution: the axis is the direction the surface directions
  // treat differently from the other two (for a cylinder, the one they never point along).
  const M = [0, 1, 2].map((r) => [0, 1, 2].map((c) => f.normals.reduce((sum, nv) => sum + nv[r] * nv[c], 0)));
  const { values, vectors } = symmetricEigen(M);
  const gaps = [0, 1, 2].map((i) => Math.min(...[0, 1, 2].filter((j) => j !== i).map((j) => Math.abs(values[i] - values[j]))));
  const axisIndex = gaps.indexOf(Math.max(...gaps));
  let axis = normalize(vectors[axisIndex]);
  // Point Z the same way as the face's overall direction where that's meaningful (e.g. a cone), else +.
  if (dot(axis, avgNormal) < -1e-9 || (Math.abs(dot(axis, avgNormal)) <= 1e-9 && axis[0] + axis[1] + axis[2] < 0)) axis = scale(axis, -1);
  if (length(axis) < 0.5) return frame(f.centroid, avgNormal);

  const heights = f.points.map((p) => dot(p, axis));
  const mid = (Math.min(...heights) + Math.max(...heights)) / 2;
  const centre = surface === "CYLINDER" || surface === "CYLINDRE" ? roundCentre(f.points, f.normals, axis) : null;
  // Elsewhere (cones and the like) the area centre of a whole round face sits on its axis.
  const base = centre ?? sub(f.centroid, scale(axis, dot(f.centroid, axis)));
  const out = frame(add(sub(base, scale(axis, dot(base, axis))), scale(axis, mid)), axis);
  if (!centre) return out;
  // A cylinder: how far its surface is from the axis.
  const fromAxis = (p: Vec3) => {
    const v = sub(p, out.origin);
    return length(sub(v, scale(axis, dot(v, axis))));
  };
  return { ...out, surface: "cylinder", radius: f.points.reduce((t, p) => t + fromAxis(p), 0) / f.points.length };
}

/** The points of one edge of the mesh, in order. */
function edgePoints(mesh: MeshData, index: number): Vec3[] {
  const g = mesh.edgeGroups[index];
  if (!g) return [];
  const pts: Vec3[] = [];
  for (let j = g.start; j < g.start + g.count; j++) {
    const p = at(mesh.lines, j);
    const last = pts[pts.length - 1];
    if (!last || length(sub(p, last)) > 1e-9) pts.push(p);
  }
  return pts;
}

/** Connector for an edge of a part (in the part's own coordinates), or null. */
export function edgeFrame(mesh: MeshData, index: number): Frame | null {
  const pts = edgePoints(mesh, index);
  if (pts.length < 2) return null;
  const curve = mesh.edgeRefs?.[index]?.curve ?? "UNKNOWN";
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (curve === "LINE") return frame(scale(add(first, last), 0.5), sub(last, first));
  if (curve === "CIRCLE" && pts.length >= 3) {
    const a = pts[0];
    const b = pts[Math.floor(pts.length / 3)];
    const c = pts[Math.floor((2 * pts.length) / 3)];
    const circle = circleThrough3D(a, b, c);
    const z = cross(sub(b, a), sub(c, a));
    if (circle && length(z) > 1e-12) return frame(circle.centre, z);
  }
  // Any other curve: its middle, Z along it there.
  const m = Math.floor(pts.length / 2);
  const before = pts[Math.max(0, m - 1)];
  const after = pts[Math.min(pts.length - 1, m + 1)];
  return frame(pts[m], sub(after, before));
}

export function connectorFrame(mesh: MeshData, kind: "face" | "edge", index: number): Frame | null {
  return kind === "face" ? faceFrame(mesh, index) : edgeFrame(mesh, index);
}

/** Size of a part (its box diagonal), for deciding how far a face may move and still be the same one. */
const sizeCache = new WeakMap<PartMesh, number>();
function partSize(part: PartMesh): number {
  let s = sizeCache.get(part);
  if (s === undefined) {
    const v = part.vertices;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < v.length; i += 3)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], v[i + k]);
        hi[k] = Math.max(hi[k], v[i + k]);
      }
    s = v.length ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) : 1;
    sizeCache.set(part, s);
  }
  return s;
}

/** Which face or edge of a part (as built now) a pick means, or -1. Survives the part being resized or changed a little. */
export function findPick(part: PartMesh, pick: TopoPick): number {
  const list = pick.ref.kind === "edge" ? part.edgeRefs : part.faceRefs;
  return matchRefs([pick.ref], list ?? [], partSize(part))[0] ?? -1;
}

/** A mate connector's frame on its part as built now (null if the face or edge can't be found). */
export function frameOnParts(parts: PartMesh[], pick: TopoPick): Frame | null {
  const part = parts.find((p) => p.id === pick.partId);
  if (!part) return null;
  const index = findPick(part, pick);
  return index >= 0 ? connectorFrame(part, pick.ref.kind, index) : null;
}

/**
 * A Width mate's connector: halfway between two flat faces that face each
 * other (or the same way), its Z along the first face's normal. Null when
 * they aren't flat and parallel.
 */
export function widthFrame(f1: Frame, f2: Frame): Frame | null {
  if (Math.abs(dot(f1.z, f2.z)) < 0.999) return null;
  // Halfway between the two faces' middles lies on the plane halfway between them.
  return frame(scale(add(f1.origin, f2.origin), 0.5), f1.z);
}

/** A connector's frame on its part as built now — halfway between both faces for a Width mate (null if it can't be found). */
export function connectorFrameOnParts(parts: PartMesh[], c: { pick: TopoPick; pick2?: TopoPick }): Frame | null {
  const f1 = frameOnParts(parts, c.pick);
  if (!c.pick2 || !f1) return f1;
  if (c.pick.ref.kind !== "face" || c.pick2.ref.kind !== "face" || c.pick.ref.surface !== "PLANE" || c.pick2.ref.surface !== "PLANE") return null;
  const f2 = frameOnParts(parts, c.pick2);
  return f2 ? widthFrame(f1, f2) : null;
}

/**
 * Other faces or edges on a part just like the picked one — the same kind of
 * face or edge, the same size, pointing the same way (every other hole of the
 * same size drilled from the same side). For Replicate.
 */
export function matchingConnectors(part: PartMesh, pick: TopoPick): TopoPick[] {
  const index = findPick(part, pick);
  if (index < 0) return [];
  const kind = pick.ref.kind;
  const want = connectorFrame(part, kind, index);
  if (!want) return [];
  const sizeOf = (i: number): number | null => {
    if (kind === "face") return faceVertices(part, i)?.area ?? null;
    const f = edgeFrame(part, i);
    const ref = part.edgeRefs[i];
    return f && ref ? length(sub(ref.mid, f.origin)) : null;
  };
  const typeOf = (i: number) => (kind === "face" ? part.faceRefs[i]?.surface : part.edgeRefs[i]?.curve);
  const size = sizeOf(index);
  if (size === null) return [];
  const count = kind === "face" ? part.faceRefs.length : part.edgeRefs.length;
  const out: TopoPick[] = [];
  const seen: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    if (i === index || typeOf(i) !== typeOf(index)) continue;
    const f = connectorFrame(part, kind, i);
    const s = sizeOf(i);
    if (!f || s === null || Math.abs(dot(f.z, want.z)) < 0.999) continue;
    if (Math.abs(s - size) > Math.max(1e-3, size * 1e-3)) continue;
    // Somewhere else at the same level (not the other end of the same hole, or a piece of the same face).
    const offset = sub(f.origin, want.origin);
    if (Math.abs(dot(offset, want.z)) > 1e-3 || length(offset) < 1e-4) continue;
    // Each hole once (a round face can come in two halves).
    if (seen.some((o) => length(sub(o, f.origin)) < 1e-4)) continue;
    seen.push(f.origin);
    out.push({ partId: part.id, ref: kind === "face" ? part.faceRefs[i] : part.edgeRefs[i] });
  }
  return out;
}
