/**
 * Soundness checks on a triangle mesh — the same triangles that go into
 * the STL file, so what we check is exactly what the slicer will receive.
 *
 * A mesh is "watertight" when every edge is shared by exactly two triangles
 * and neighbouring triangles agree on which side is outside.
 */

export interface MeshAnalysis {
  triangleCount: number;
  /** Distinct corner points after merging duplicates along shared edges. */
  vertexCount: number;
  /** Edges used by only one triangle — holes in the surface. */
  openEdges: number;
  /** Edges used by three or more triangles — surfaces meeting badly. */
  nonManifoldEdges: number;
  /** Edges whose two triangles disagree about which side is outside. */
  flippedEdges: number;
  /** Triangles with (almost) no area. */
  degenerateTriangles: number;
  /** Number of separate, unconnected pieces. */
  pieces: number;
  /** Enclosed volume in mm³ (positive when the surface faces outwards). */
  volume: number;
  /** Surface area in mm². */
  area: number;
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  /** True when the mesh is closed, manifold and consistently oriented. */
  watertight: boolean;
}

const DEGENERATE_DOUBLE_AREA = 1e-10;

function isDegenerate(a: number, b: number, c: number, doubleArea: number): boolean {
  return a === b || b === c || a === c || doubleArea < DEGENERATE_DOUBLE_AREA;
}

/**
 * Returns the triangle index list without zero-area triangles.
 * Used before writing STL files so slicers receive a clean surface.
 */
export function withoutDegenerateTriangles(
  vertices: ArrayLike<number>,
  triangles: ArrayLike<number>,
  weldTolerance = 1e-4,
): Uint32Array {
  const q = 1 / weldTolerance;
  const key = (i: number) =>
    `${Math.round(vertices[3 * i] * q)},${Math.round(vertices[3 * i + 1] * q)},${Math.round(vertices[3 * i + 2] * q)}`;
  const out: number[] = [];
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const i = triangles[t], j = triangles[t + 1], k = triangles[t + 2];
    const ki = key(i), kj = key(j), kk = key(k);
    const ux = vertices[3 * j] - vertices[3 * i];
    const uy = vertices[3 * j + 1] - vertices[3 * i + 1];
    const uz = vertices[3 * j + 2] - vertices[3 * i + 2];
    const vx = vertices[3 * k] - vertices[3 * i];
    const vy = vertices[3 * k + 1] - vertices[3 * i + 1];
    const vz = vertices[3 * k + 2] - vertices[3 * i + 2];
    const doubleArea = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (ki === kj || kj === kk || ki === kk || doubleArea < DEGENERATE_DOUBLE_AREA) continue;
    out.push(i, j, k);
  }
  return Uint32Array.from(out);
}

/**
 * @param vertices flat [x, y, z, x, y, z, …] positions
 * @param triangles flat vertex indices, three per triangle
 * @param weldTolerance points closer than this (mm) are treated as the same point
 */
export function analyzeMesh(
  vertices: ArrayLike<number>,
  triangles: ArrayLike<number>,
  weldTolerance = 1e-4,
): MeshAnalysis {
  const vertexCountIn = Math.floor(vertices.length / 3);
  const triangleCount = Math.floor(triangles.length / 3);

  // 1. Weld: faces are meshed separately, so the same point appears once per
  //    face. Map every input vertex to a canonical welded index by position.
  const weldIndex = new Int32Array(vertexCountIn);
  const cellToIndex = new Map<string, number>();
  const welded: number[] = [];
  const q = 1 / weldTolerance;
  for (let i = 0; i < vertexCountIn; i++) {
    const x = vertices[3 * i];
    const y = vertices[3 * i + 1];
    const z = vertices[3 * i + 2];
    const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    let idx = cellToIndex.get(key);
    if (idx === undefined) {
      idx = welded.length / 3;
      cellToIndex.set(key, idx);
      welded.push(x, y, z);
    }
    weldIndex[i] = idx;
  }
  const vertexCount = welded.length / 3;

  // 2. Walk triangles: count edge use, check orientation, measure volume/area.
  //    Directed edge a→b is stored under the undirected key; +1 for a<b, -1 otherwise.
  const edgeUse = new Map<string, { count: number; balance: number }>();
  let degenerateTriangles = 0;
  let volume = 0;
  let area = 0;

  const parent = new Int32Array(vertexCount).map((_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const used = new Uint8Array(vertexCount);
  for (let t = 0; t < triangleCount; t++) {
    const a = weldIndex[triangles[3 * t]];
    const b = weldIndex[triangles[3 * t + 1]];
    const c = weldIndex[triangles[3 * t + 2]];
    used[a] = used[b] = used[c] = 1;

    const ax = welded[3 * a], ay = welded[3 * a + 1], az = welded[3 * a + 2];
    const bx = welded[3 * b], by = welded[3 * b + 1], bz = welded[3 * b + 2];
    const cx = welded[3 * c], cy = welded[3 * c + 1], cz = welded[3 * c + 2];

    // Cross product (b - a) × (c - a): its length is twice the triangle area.
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const doubleArea = Math.hypot(nx, ny, nz);
    area += doubleArea / 2;
    if (isDegenerate(a, b, c, doubleArea)) {
      // Zero-area slivers (e.g. at a sphere's poles) carry no surface. Slicers
      // ignore them and we strip them on export, so leave them out of the
      // edge bookkeeping rather than reporting false problems.
      degenerateTriangles++;
      continue;
    }

    // Signed volume of the tetrahedron (origin, a, b, c).
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;

    for (const [p, r] of [[a, b], [b, c], [c, a]] as const) {
      if (p === r) continue;
      const key = p < r ? `${p}:${r}` : `${r}:${p}`;
      const e = edgeUse.get(key) ?? { count: 0, balance: 0 };
      e.count++;
      e.balance += p < r ? 1 : -1;
      edgeUse.set(key, e);
      union(p, r);
    }
  }

  let openEdges = 0;
  let nonManifoldEdges = 0;
  let flippedEdges = 0;
  for (const e of edgeUse.values()) {
    if (e.count === 1) openEdges++;
    else if (e.count > 2) nonManifoldEdges++;
    else if (e.balance !== 0) flippedEdges++;
  }

  const roots = new Set<number>();
  for (let i = 0; i < vertexCount; i++) if (used[i]) roots.add(find(i));

  let bounds: MeshAnalysis["bounds"] = null;
  if (vertexCount > 0) {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vertexCount; i++) {
      for (let k = 0; k < 3; k++) {
        const v = welded[3 * i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    bounds = { min, max };
  }

  const watertight =
    triangleCount > 0 && openEdges === 0 && nonManifoldEdges === 0 && flippedEdges === 0 && volume > 0;

  return {
    triangleCount,
    vertexCount,
    openEdges,
    nonManifoldEdges,
    flippedEdges,
    degenerateTriangles,
    pieces: roots.size,
    volume,
    area,
    bounds,
    watertight,
  };
}

/** Where a part is thinnest, found by measuring straight through it. */
export interface ThicknessEstimate {
  /** Smallest wall thickness found, mm. */
  thickness: number;
  /** A point on the surface where it was found. */
  at: [number, number, number];
}

/**
 * Estimate the thinnest wall: from points spread over the surface, measure
 * straight inwards to where the ray leaves the solid again. (The surface must
 * face outwards, as OpenCascade's meshes do.) Checks up to `maxSamples`
 * triangles, so it stays quick on large models; tiny gaps between samples can
 * be missed, so the answer is "about".
 */
export function estimateThickness(
  vertices: ArrayLike<number>,
  triangles: ArrayLike<number>,
  maxSamples = 2500,
): ThicknessEstimate | null {
  const count = triangles.length / 3;
  if (count < 4) return null;
  const V = (i: number): [number, number, number] => [vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]];
  // Pre-compute each triangle's corners for the ray tests.
  const tri = new Float64Array(count * 9);
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      const p = V(triangles[t * 3 + k]);
      tri.set(p, t * 9 + k * 3);
    }
  }
  let best: ThicknessEstimate | null = null;
  const step = Math.max(1, Math.floor(count / maxSamples));
  for (let s = 0; s < count; s += step) {
    const o = s * 9;
    const ax = tri[o], ay = tri[o + 1], az = tri[o + 2];
    const e1x = tri[o + 3] - ax, e1y = tri[o + 4] - ay, e1z = tri[o + 5] - az;
    const e2x = tri[o + 6] - ax, e2y = tri[o + 7] - ay, e2z = tri[o + 8] - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    // Ray from the centre of this triangle, pointing into the solid.
    nx /= -len;
    ny /= -len;
    nz /= -len;
    const cx = ax + (e1x + e2x) / 3;
    const cy = ay + (e1y + e2y) / 3;
    const cz = az + (e1z + e2z) / 3;
    const hit = nearestHit(tri, count, s, cx, cy, cz, nx, ny, nz);
    if (hit !== null && (!best || hit < best.thickness)) best = { thickness: hit, at: [cx, cy, cz] };
  }
  return best;
}

/** Distance along the ray to the nearest triangle (other than `skip`), or null. Möller–Trumbore. */
function nearestHit(tri: Float64Array, count: number, skip: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number | null {
  let nearest = Infinity;
  for (let t = 0; t < count; t++) {
    if (t === skip) continue;
    const o = t * 9;
    const ax = tri[o], ay = tri[o + 1], az = tri[o + 2];
    const e1x = tri[o + 3] - ax, e1y = tri[o + 4] - ay, e1z = tri[o + 5] - az;
    const e2x = tri[o + 6] - ax, e2y = tri[o + 7] - ay, e2z = tri[o + 8] - az;
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const tx = ox - ax, ty = oy - ay, tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
    // Ignore hits right at the start (neighbouring triangles sharing the point).
    if (dist > 1e-6 && dist < nearest) nearest = dist;
  }
  return Number.isFinite(nearest) ? nearest : null;
}
