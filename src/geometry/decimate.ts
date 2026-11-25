/**
 * Reducing a triangle mesh to fewer triangles (quadric-error edge collapse, after Garland and Heckbert, 1997).
 *
 * Each corner carries the sum of the squared distances to the planes of the triangles round it (weighted by their
 * area). Collapsing an edge joins its two ends into one corner, placed where that sum is least, so flat areas lose
 * triangles first and sharp edges and corners stay where they were. The cheapest edge goes first, until the mesh is
 * down to the triangles wanted.
 *
 * A collapse is only made when the mesh stays a proper surface: the two ends may share only the corners opposite
 * the edge (so no edge ever gets three triangles and a closed body stays closed), no triangle round it may turn over
 * or become a sliver of no area, and a body is never made smaller than four corners. Open edges (a mesh that isn't
 * closed) are held by extra planes standing up from them, so holes keep their outline.
 */

export interface DecimateResult {
  vertices: number[];
  triangles: number[];
}

/** Planes standing up from open edges count this many times as much as an ordinary triangle's plane. */
const OPEN_EDGE_WEIGHT = 1000;
/** A triangle round a collapse may turn by at most this much (cosine of the angle) — 78°. */
const MOST_TURN = 0.2;

/**
 * The mesh reduced to about `target` triangles (never more than it had). `vertices` are x, y, z per corner;
 * `triangles` three corner numbers each, corners shared between triangles (weld first). Corners no triangle uses
 * are dropped.
 */
export function decimate(vertices: ArrayLike<number>, triangles: ArrayLike<number>, target: number): DecimateResult {
  const nv = Math.floor(vertices.length / 3);
  const nt = Math.floor(triangles.length / 3);
  const pos = Float64Array.from(vertices as ArrayLike<number>);
  const tri = Int32Array.from(triangles as ArrayLike<number>);
  const aliveTri = new Uint8Array(nt).fill(1);
  let alive = nt;
  // Drop triangles that use a corner twice.
  for (let t = 0; t < nt; t++) {
    const a = tri[3 * t], b = tri[3 * t + 1], c = tri[3 * t + 2];
    if (a === b || b === c || a === c) {
      aliveTri[t] = 0;
      alive--;
    }
  }
  if (alive <= target) return compact(pos, tri, aliveTri, nv);

  // The triangles round each corner.
  const around: number[][] = Array.from({ length: nv }, () => []);
  for (let t = 0; t < nt; t++) if (aliveTri[t]) for (let k = 0; k < 3; k++) around[tri[3 * t + k]].push(t);

  // Quadrics: a symmetric 4 × 4 matrix per corner, kept as its 10 numbers.
  const Q = new Float64Array(nv * 10);
  const addPlane = (v: number, nx: number, ny: number, nz: number, d: number, w: number) => {
    const q = v * 10;
    Q[q] += w * nx * nx;
    Q[q + 1] += w * nx * ny;
    Q[q + 2] += w * nx * nz;
    Q[q + 3] += w * nx * d;
    Q[q + 4] += w * ny * ny;
    Q[q + 5] += w * ny * nz;
    Q[q + 6] += w * ny * d;
    Q[q + 7] += w * nz * nz;
    Q[q + 8] += w * nz * d;
    Q[q + 9] += w * d * d;
  };
  // Edge uses, to find open edges.
  const edgeUse = new Map<number, number>();
  const edgeKey = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
  for (let t = 0; t < nt; t++) {
    if (!aliveTri[t]) continue;
    const a = tri[3 * t], b = tri[3 * t + 1], c = tri[3 * t + 2];
    const n = normal(pos, a, b, c);
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len > 0) {
      const nx = n[0] / len, ny = n[1] / len, nz = n[2] / len;
      const d = -(nx * pos[3 * a] + ny * pos[3 * a + 1] + nz * pos[3 * a + 2]);
      const area = len / 2;
      addPlane(a, nx, ny, nz, d, area);
      addPlane(b, nx, ny, nz, d, area);
      addPlane(c, nx, ny, nz, d, area);
    }
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = edgeKey(p, q);
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }
  const openCorner = new Uint8Array(nv);
  for (let t = 0; t < nt; t++) {
    if (!aliveTri[t]) continue;
    const a = tri[3 * t], b = tri[3 * t + 1], c = tri[3 * t + 2];
    const n = normal(pos, a, b, c);
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      if (edgeUse.get(edgeKey(p, q)) !== 1) continue;
      openCorner[p] = openCorner[q] = 1;
      // A plane through the edge, standing up from the triangle.
      const ex = pos[3 * q] - pos[3 * p], ey = pos[3 * q + 1] - pos[3 * p + 1], ez = pos[3 * q + 2] - pos[3 * p + 2];
      let sx = ey * n[2] - ez * n[1], sy = ez * n[0] - ex * n[2], sz = ex * n[1] - ey * n[0];
      const sl = Math.hypot(sx, sy, sz);
      if (!(sl > 0)) continue;
      sx /= sl;
      sy /= sl;
      sz /= sl;
      const d = -(sx * pos[3 * p] + sy * pos[3 * p + 1] + sz * pos[3 * p + 2]);
      const w = OPEN_EDGE_WEIGHT * (ex * ex + ey * ey + ez * ez);
      addPlane(p, sx, sy, sz, d, w);
      addPlane(q, sx, sy, sz, d, w);
    }
  }
  edgeUse.clear();

  // How many corners each body has (a body is never made smaller than a tetrahedron).
  const body = new Int32Array(nv);
  for (let i = 0; i < nv; i++) body[i] = i;
  const find = (i: number): number => {
    while (body[i] !== i) i = body[i] = body[body[i]];
    return i;
  };
  for (let t = 0; t < nt; t++) {
    if (!aliveTri[t]) continue;
    const r = find(tri[3 * t]);
    body[find(tri[3 * t + 1])] = r;
    body[find(tri[3 * t + 2])] = r;
  }
  const bodyCorners = new Int32Array(nv);
  const used = new Uint8Array(nv);
  for (let t = 0; t < nt; t++) if (aliveTri[t]) for (let k = 0; k < 3; k++) used[tri[3 * t + k]] = 1;
  for (let i = 0; i < nv; i++) if (used[i]) bodyCorners[find(i)]++;

  const stamp = new Int32Array(nv);
  const gone = new Uint8Array(nv);
  const heap = new EdgeHeap(Math.max(16, nt * 2));
  const place = new Float64Array(3);

  /** The cost of collapsing a–b, leaving the best place in `place`. */
  const cost = (a: number, b: number): number => {
    const qa = a * 10, qb = b * 10;
    const q0 = Q[qa] + Q[qb], q1 = Q[qa + 1] + Q[qb + 1], q2 = Q[qa + 2] + Q[qb + 2], q3 = Q[qa + 3] + Q[qb + 3];
    const q4 = Q[qa + 4] + Q[qb + 4], q5 = Q[qa + 5] + Q[qb + 5], q6 = Q[qa + 6] + Q[qb + 6];
    const q7 = Q[qa + 7] + Q[qb + 7], q8 = Q[qa + 8] + Q[qb + 8], q9 = Q[qa + 9] + Q[qb + 9];
    const err = (x: number, y: number, z: number) =>
      q0 * x * x + 2 * q1 * x * y + 2 * q2 * x * z + 2 * q3 * x + q4 * y * y + 2 * q5 * y * z + 2 * q6 * y + q7 * z * z + 2 * q8 * z + q9;
    const ax = pos[3 * a], ay = pos[3 * a + 1], az = pos[3 * a + 2];
    const bx = pos[3 * b], by = pos[3 * b + 1], bz = pos[3 * b + 2];
    const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2;
    let best = err(mx, my, mz);
    place[0] = mx;
    place[1] = my;
    place[2] = mz;
    // An open corner keeps its place on the body's edge: its partner comes to it (both open: the middle, or an end).
    const oa = openCorner[a], ob = openCorner[b];
    const tryAt = (x: number, y: number, z: number) => {
      const e = err(x, y, z);
      if (e < best) {
        best = e;
        place[0] = x;
        place[1] = y;
        place[2] = z;
      }
    };
    if (oa && !ob) {
      best = err(ax, ay, az);
      place[0] = ax;
      place[1] = ay;
      place[2] = az;
      return Math.max(0, best);
    }
    if (ob && !oa) {
      best = err(bx, by, bz);
      place[0] = bx;
      place[1] = by;
      place[2] = bz;
      return Math.max(0, best);
    }
    tryAt(ax, ay, az);
    tryAt(bx, by, bz);
    // Where the error is least along the edge (a parabola through the ends and the middle). Off the edge is not
    // tried: on rough, noisy meshes the planes' best point can lie well inside the body.
    const f0 = err(ax, ay, az), f1 = err(bx, by, bz), fm = err(mx, my, mz);
    const curve = 2 * (f0 + f1 - 2 * fm);
    if (curve > 0) {
      const t = (3 * f0 + f1 - 4 * fm) / (2 * curve);
      if (t > 0 && t < 1) tryAt(ax + t * (bx - ax), ay + t * (by - ay), az + t * (bz - az));
    }
    return Math.max(0, best);
  };

  const pushEdge = (a: number, b: number) => {
    const c = cost(a, b);
    heap.push(c, a, b, stamp[a], stamp[b]);
  };

  // Every edge once.
  const mark = new Int32Array(nv).fill(-1);
  for (let v = 0; v < nv; v++) {
    for (const t of around[v])
      for (let k = 0; k < 3; k++) {
        const w = tri[3 * t + k];
        if (w > v && mark[w] !== v) {
          mark[w] = v;
          pushEdge(v, w);
        }
      }
  }

  let tag = 0;
  const seen = new Int32Array(nv);
  /** The other corners of the triangles round v, tagged in `seen` (returns the tag). */
  const tagNeighbours = (v: number): number => {
    tag++;
    for (const t of around[v])
      for (let k = 0; k < 3; k++) {
        const w = tri[3 * t + k];
        if (w !== v) seen[w] = tag;
      }
    return tag;
  };

  /** Whether moving corner `v` (whose triangles don't use `other`) to `place` keeps every triangle the way round it was. */
  const keepsFacing = (v: number, other: number): boolean => {
    for (const t of around[v]) {
      const a = tri[3 * t], b = tri[3 * t + 1], c = tri[3 * t + 2];
      if (a === other || b === other || c === other) continue;
      const before = normal(pos, a, b, c);
      const ox = pos[3 * v], oy = pos[3 * v + 1], oz = pos[3 * v + 2];
      pos[3 * v] = place[0];
      pos[3 * v + 1] = place[1];
      pos[3 * v + 2] = place[2];
      const after = normal(pos, a, b, c);
      pos[3 * v] = ox;
      pos[3 * v + 1] = oy;
      pos[3 * v + 2] = oz;
      const lb = Math.hypot(before[0], before[1], before[2]);
      const la = Math.hypot(after[0], after[1], after[2]);
      if (!(la > 1e-12 * Math.max(lb, 1e-300)) || la === 0) return false;
      if (lb === 0) continue;
      const cos = (before[0] * after[0] + before[1] * after[1] + before[2] * after[2]) / (lb * la);
      if (cos < MOST_TURN) return false;
      // No new sliver: the smallest height of the moved triangle at least a little of its longest side — or, for a
      // triangle that was a sliver already (CAD files are full of them: fans on flat faces, strips round holes), no
      // thinner than it was. (Refusing every move of a sliver left such meshes stuck far above the triangles asked
      // for, until only bad collapses were left.)
      const thin = thinness(pos, a, b, c, v, place);
      if (thin < SLIVER && thin < thinness(pos, a, b, c, v, pos.subarray(3 * v, 3 * v + 3))) return false;
    }
    return true;
  };

  while (alive > target && heap.size > 0) {
    const e = heap.pop();
    const a = e.a, b = e.b;
    if (gone[a] || gone[b] || stamp[a] !== e.sa || stamp[b] !== e.sb) continue;
    // Recompute the place (it may have been overwritten).
    cost(a, b);
    // Corners shared with both ends must be exactly those opposite the edge.
    const shared: number[] = [];
    for (const t of around[a]) {
      const x = tri[3 * t], y = tri[3 * t + 1], z = tri[3 * t + 2];
      if (x === b || y === b || z === b) shared.push(x !== a && x !== b ? x : y !== a && y !== b ? y : z);
    }
    if (shared.length === 0) continue; // no longer an edge
    if (shared.length > 2) continue; // more than two triangles on it
    const tg = tagNeighbours(a);
    let common = 0;
    for (const t of around[b])
      for (let k = 0; k < 3; k++) {
        const w = tri[3 * t + k];
        if (w !== b && w !== a && seen[w] === tg) {
          seen[w] = -tg; // count each once
          common++;
        }
      }
    if (common !== shared.length) continue;
    // An edge between two open corners that isn't itself open would pinch the body.
    if (openCorner[a] && openCorner[b] && shared.length === 2) continue;
    if (bodyCorners[find(a)] <= 4) continue;
    if (!keepsFacing(a, b) || !keepsFacing(b, a)) continue;

    // Collapse b into a.
    pos[3 * a] = place[0];
    pos[3 * a + 1] = place[1];
    pos[3 * a + 2] = place[2];
    for (let k = 0; k < 10; k++) Q[a * 10 + k] += Q[b * 10 + k];
    if (openCorner[b]) openCorner[a] = 1;
    const kept: number[] = [];
    for (const t of around[a]) {
      if (!aliveTri[t]) continue;
      const x = tri[3 * t], y = tri[3 * t + 1], z = tri[3 * t + 2];
      if (x === b || y === b || z === b) {
        aliveTri[t] = 0;
        alive--;
      } else kept.push(t);
    }
    for (const t of around[b]) {
      if (!aliveTri[t]) continue;
      for (let k = 0; k < 3; k++) if (tri[3 * t + k] === b) tri[3 * t + k] = a;
      kept.push(t);
    }
    around[a] = kept;
    around[b] = [];
    // The two triangles that went are taken off the lists of the corners opposite the edge too.
    for (const c of shared) around[c] = around[c].filter((t) => aliveTri[t] === 1);
    gone[b] = 1;
    bodyCorners[find(a)]--;
    stamp[a]++;
    stamp[b]++;
    // The edges round a, priced again (edges elsewhere keep their cost: nothing about their ends changed).
    tag++;
    for (const t of kept)
      for (let k = 0; k < 3; k++) {
        const w = tri[3 * t + k];
        if (w !== a && seen[w] !== tag) {
          seen[w] = tag;
          pushEdge(a, w);
        }
      }
  }
  return compact(pos, tri, aliveTri, nv);
}

function normal(pos: Float64Array, a: number, b: number, c: number): [number, number, number] {
  const ux = pos[3 * b] - pos[3 * a], uy = pos[3 * b + 1] - pos[3 * a + 1], uz = pos[3 * b + 2] - pos[3 * a + 2];
  const vx = pos[3 * c] - pos[3 * a], vy = pos[3 * c + 1] - pos[3 * a + 1], vz = pos[3 * c + 2] - pos[3 * a + 2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/** A triangle's smallest height over its longest side: below this it's a sliver. */
const SLIVER = 0.01;

/** How thin triangle a b c is with corner v moved to `to`: its smallest height over its longest side (0 = no area). */
function thinness(pos: Float64Array, a: number, b: number, c: number, v: number, to: ArrayLike<number>): number {
  const p = (i: number, k: number) => (i === v ? to[k] : pos[3 * i + k]);
  const ab = Math.hypot(p(b, 0) - p(a, 0), p(b, 1) - p(a, 1), p(b, 2) - p(a, 2));
  const bc = Math.hypot(p(c, 0) - p(b, 0), p(c, 1) - p(b, 1), p(c, 2) - p(b, 2));
  const ca = Math.hypot(p(a, 0) - p(c, 0), p(a, 1) - p(c, 1), p(a, 2) - p(c, 2));
  const ux = p(b, 0) - p(a, 0), uy = p(b, 1) - p(a, 1), uz = p(b, 2) - p(a, 2);
  const wx = p(c, 0) - p(a, 0), wy = p(c, 1) - p(a, 1), wz = p(c, 2) - p(a, 2);
  const twiceArea = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
  const longest = Math.max(ab, bc, ca);
  return longest === 0 ? 0 : twiceArea / (longest * longest);
}

function compact(pos: Float64Array, tri: Int32Array, aliveTri: Uint8Array, nv: number): DecimateResult {
  const remap = new Int32Array(nv).fill(-1);
  const vertices: number[] = [];
  const triangles: number[] = [];
  for (let t = 0; t < aliveTri.length; t++) {
    if (!aliveTri[t]) continue;
    for (let k = 0; k < 3; k++) {
      const v = tri[3 * t + k];
      if (remap[v] < 0) {
        remap[v] = vertices.length / 3;
        vertices.push(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]);
      }
      triangles.push(remap[v]);
    }
  }
  return { vertices, triangles };
}

/** A binary heap of edges by cost (cheapest first), in growing typed arrays. */
class EdgeHeap {
  private cost: Float64Array;
  private ab: Int32Array;
  size = 0;
  private out = { a: 0, b: 0, sa: 0, sb: 0 };
  constructor(capacity: number) {
    this.cost = new Float64Array(capacity);
    this.ab = new Int32Array(capacity * 4);
  }
  push(c: number, a: number, b: number, sa: number, sb: number) {
    if (this.size === this.cost.length) {
      const cost = new Float64Array(this.size * 2);
      cost.set(this.cost);
      this.cost = cost;
      const ab = new Int32Array(this.size * 8);
      ab.set(this.ab);
      this.ab = ab;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cost[p] <= c) break;
      this.move(p, i);
      i = p;
    }
    this.cost[i] = c;
    this.ab[4 * i] = a;
    this.ab[4 * i + 1] = b;
    this.ab[4 * i + 2] = sa;
    this.ab[4 * i + 3] = sb;
  }
  pop(): { a: number; b: number; sa: number; sb: number } {
    const o = this.out;
    o.a = this.ab[0];
    o.b = this.ab[1];
    o.sa = this.ab[2];
    o.sb = this.ab[3];
    const last = --this.size;
    if (last > 0) {
      const c = this.cost[last];
      const la = this.ab[4 * last], lb = this.ab[4 * last + 1], lsa = this.ab[4 * last + 2], lsb = this.ab[4 * last + 3];
      let i = 0;
      for (;;) {
        let k = 2 * i + 1;
        if (k >= last) break;
        if (k + 1 < last && this.cost[k + 1] < this.cost[k]) k++;
        if (this.cost[k] >= c) break;
        this.move(k, i);
        i = k;
      }
      this.cost[i] = c;
      this.ab[4 * i] = la;
      this.ab[4 * i + 1] = lb;
      this.ab[4 * i + 2] = lsa;
      this.ab[4 * i + 3] = lsb;
    }
    return o;
  }
  private move(from: number, to: number) {
    this.cost[to] = this.cost[from];
    this.ab[4 * to] = this.ab[4 * from];
    this.ab[4 * to + 1] = this.ab[4 * from + 1];
    this.ab[4 * to + 2] = this.ab[4 * from + 2];
    this.ab[4 * to + 3] = this.ab[4 * from + 3];
  }
}

/**
 * Loose triangle corners (x, y, z per corner, three corners per triangle, as an STL holds them) joined where they
 * meet: corners within 0.01 µm (rounded as the STL import's own joining does) become one. Triangles that then use a
 * corner twice are dropped. A hash table on numbers, so a million triangles take well under a second.
 */
export function weldCorners(corners: ArrayLike<number>): DecimateResult {
  const n = Math.floor(corners.length / 3);
  let size = 1;
  while (size < n * 2) size <<= 1;
  const table = new Int32Array(size).fill(-1);
  const keys = new Float64Array(n * 3);
  const vertices: number[] = [];
  const remap = new Int32Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const x = corners[3 * i], y = corners[3 * i + 1], z = corners[3 * i + 2];
    const kx = Math.round(x * 1e5), ky = Math.round(y * 1e5), kz = Math.round(z * 1e5);
    let h = (Math.imul(kx | 0, 73856093) ^ Math.imul(ky | 0, 19349663) ^ Math.imul(kz | 0, 83492791)) & (size - 1);
    for (;;) {
      const j = table[h];
      if (j < 0) {
        table[h] = count;
        keys[3 * count] = kx;
        keys[3 * count + 1] = ky;
        keys[3 * count + 2] = kz;
        vertices.push(x, y, z);
        remap[i] = count++;
        break;
      }
      if (keys[3 * j] === kx && keys[3 * j + 1] === ky && keys[3 * j + 2] === kz) {
        remap[i] = j;
        break;
      }
      h = (h + 1) & (size - 1);
    }
  }
  const triangles: number[] = [];
  for (let t = 0; t + 2 < n; t += 3) {
    const a = remap[t], b = remap[t + 1], c = remap[t + 2];
    if (a !== b && b !== c && a !== c) triangles.push(a, b, c);
  }
  return { vertices, triangles };
}
