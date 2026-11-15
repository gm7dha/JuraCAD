/**
 * Which edges of a part's display mesh go round one of its faces (for the sketch's Use tool: clicking a face
 * uses its whole outline, holes too, as in Onshape). Pure: an edge belongs to the face when every point of its
 * polyline (and a straight edge's middle) lies on the face's triangles.
 */
type Vec3 = [number, number, number];

export interface FaceEdgeMesh {
  vertices: Float32Array;
  triangles: Uint32Array;
  faceGroups: { start: number; count: number }[];
  lines: Float32Array;
  edgeGroups: { start: number; count: number }[];
}

const at = (a: Float32Array, i: number): Vec3 => [a[3 * i], a[3 * i + 1], a[3 * i + 2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Distance from p to triangle abc (closest point by regions, as in Ericson's Real-Time Collision Detection). */
function toTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  const near = (q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const along = (o: Vec3, d: Vec3, t: number): Vec3 => [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
  if (d1 <= 0 && d2 <= 0) return near(a);
  const bp = sub(p, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return near(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return near(along(a, ab, d1 / (d1 - d3)));
  const cp = sub(p, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return near(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return near(along(a, ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return near(along(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const den = 1 / (va + vb + vc);
  const v = vb * den, w = vc * den;
  return near([a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]);
}

/** The edges (indexes into edgeGroups) round face `face`, within `tol` mm (default: 1/2000 of the face's size, between 1 µm and 0.05 mm). */
export function edgesOfFace(mesh: FaceEdgeMesh, face: number, tol?: number): number[] {
  const g = mesh.faceGroups[face];
  if (!g) return [];
  const tris: [Vec3, Vec3, Vec3][] = [];
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = g.start; i < g.start + g.count && i + 2 < mesh.triangles.length; i += 3) {
    const t: [Vec3, Vec3, Vec3] = [at(mesh.vertices, mesh.triangles[i]), at(mesh.vertices, mesh.triangles[i + 1]), at(mesh.vertices, mesh.triangles[i + 2])];
    tris.push(t);
    for (const p of t) for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[k]);
      hi[k] = Math.max(hi[k], p[k]);
    }
  }
  if (!tris.length) return [];
  const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  // (A curved edge's polyline needn't share the face's triangle corners: allow for the mesh's sag, a little.)
  const reach = tol ?? Math.max(1e-3, Math.min(0.05, size * 5e-4));
  const inBox = (p: Vec3) => p.every((v, k) => v >= lo[k] - reach && v <= hi[k] + reach);
  const onFace = (p: Vec3) => inBox(p) && tris.some(([a, b, c]) => toTriangle(p, a, b, c) <= reach);
  const out: number[] = [];
  mesh.edgeGroups.forEach((e, index) => {
    const pts: Vec3[] = [];
    for (let j = e.start; j < e.start + e.count; j++) pts.push(at(mesh.lines, j));
    if (!pts.length) return;
    const checks = [...pts];
    // A straight edge has just its ends: its middle must be on the face too (an upright edge only touches it at a corner).
    if (pts.length === 2) for (let k = 0; k + 1 < pts.length; k++) checks.push([(pts[k][0] + pts[k + 1][0]) / 2, (pts[k][1] + pts[k + 1][1]) / 2, (pts[k][2] + pts[k + 1][2]) / 2]);
    if (checks.every(onFace)) out.push(index);
  });
  return out;
}
