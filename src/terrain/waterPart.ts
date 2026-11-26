/**
 * The map's lochs as their own part in colour bands (pure, mm, z up): a loch's top is one flat surface (groundMarks.ts),
 * so the water filament can be a real slab just `WATER_LAYERS` print layers thick — the piece within the loch's outline
 * from its level down that far — instead of paint, which the slicer carries several layers down into the piece.
 *
 * `splitWater` finds the flat, upward faces of a piece the map calls water (edge-joined pieces of one height, at least
 * half of them water by area), and splits the piece into the rest (`main`: the loch's floor dropped by the slab's
 * thickness, with a wall up to the shore all round) and the slab (`water`: the loch's own top, its floor, and walls all
 * round — up the shore and, where the loch reaches the piece's side, the top strip of that side). Both are closed meshes
 * sharing their corners where they meet, and their volumes add up to the piece; anything that doesn't come out so
 * (an odd mesh) gives null, and the water is painted on as before.
 */
import { weld } from "../geometry/threeMf";
import type { MeshData } from "./colour";

/** The water filament is this many print layers thick. */
export const WATER_LAYERS = 2;

export interface WaterSplit {
  main: MeshData;
  /** One slab per loch level (lowest first), so each counts only on its own layers. */
  waters: { level: number; mesh: MeshData }[];
  /** The lochs' levels (mm), each once, lowest first. */
  levels: number[];
}

const FLAT = 1e-7;
/** How far (mm) each side's floor copy of a pinch corner moves into its own side: well past welding's 1e-5. */
export const PINCH_SHIFT = 1e-3;

/**
 * `isWater(x, y)`: the map's water there. `depth`: the slab's thickness. `lowest`: no loch floor below this (else that loch
 * is left alone). `wanted(level)`: whether to make a slab for a loch at this level (not when its band is the water's colour).
 */
export function splitWater(
  body: { vertices: ArrayLike<number>; triangles: ArrayLike<number> },
  isWater: (x: number, y: number) => boolean,
  depth: number,
  lowest: number,
  wanted: (level: number) => boolean = () => true,
): WaterSplit | null {
  const m = weld(body.vertices, body.triangles);
  const V = m.vertices;
  const T = m.triangles;
  const nv = V.length / 3;
  const nt = T.length / 3;
  const z = (i: number) => V[i * 3 + 2];
  const normal = (t: number): [number, number, number] => {
    const [a, b, c] = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
    const [ux, uy, uz] = [V[b * 3] - V[a * 3], V[b * 3 + 1] - V[a * 3 + 1], V[b * 3 + 2] - V[a * 3 + 2]];
    const [vx, vy, vz] = [V[c * 3] - V[a * 3], V[c * 3 + 1] - V[a * 3 + 1], V[c * 3 + 2] - V[a * 3 + 2]];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  };
  const area2 = (t: number) => Math.hypot(...normal(t));
  const nz = (t: number) => {
    const n = normal(t);
    return n[2] / (Math.hypot(...n) || 1);
  };
  // Directed edges a→b to their triangle.
  const edge = new Map<number, number>();
  for (let t = 0; t < nt; t++)
    for (let k = 0; k < 3; k++) {
      const key = T[t * 3 + k] * nv + T[t * 3 + ((k + 1) % 3)];
      if (edge.has(key)) return null;
      edge.set(key, t);
    }
  const flatAt = new Float64Array(nt).fill(NaN);
  for (let t = 0; t < nt; t++) {
    const [a, b, c] = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
    if (Math.abs(z(a) - z(b)) < FLAT && Math.abs(z(a) - z(c)) < FLAT && nz(t) > 0.999) flatAt[t] = z(a);
  }
  // Flat pieces of one height, joined by their edges; the ones mostly water are the lochs.
  const inR = new Uint8Array(nt);
  const seen = new Uint8Array(nt);
  const levels: number[] = [];
  for (let s = 0; s < nt; s++) {
    if (seen[s] || Number.isNaN(flatAt[s])) continue;
    const comp: number[] = [];
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const t = stack.pop()!;
      comp.push(t);
      for (let k = 0; k < 3; k++) {
        const n = edge.get(T[t * 3 + ((k + 1) % 3)] * nv + T[t * 3 + k]);
        if (n === undefined) return null;
        if (!seen[n] && Math.abs(flatAt[n] - flatAt[s]) < FLAT) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    let all = 0;
    let wet = 0;
    for (const t of comp) {
      const a = area2(t);
      all += a;
      const [p, q, r] = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
      if (isWater((V[p * 3] + V[q * 3] + V[r * 3]) / 3, (V[p * 3 + 1] + V[q * 3 + 1] + V[r * 3 + 1]) / 3)) wet += a;
    }
    const level = flatAt[s];
    if (wet < all / 2 || level - depth < lowest || !wanted(level)) continue;
    for (const t of comp) inR[t] = 1;
    if (!levels.some((l) => Math.abs(l - level) < FLAT)) levels.push(level);
  }
  if (!levels.length) return null;

  // Every corner of the lochs gets a copy at its floor — one per fan of loch triangles round it. Where a loch touches
  // itself at a single corner (a narrow neck, two lochs corner to corner) each side gets its own copy, moved
  // `PINCH_SHIFT` into its own fan, so the two walls meeting there don't share an edge and both parts stay closed.
  const out = V.slice();
  const corner = new Int32Array(nt * 3).fill(-1);
  const root = new Int32Array(nt * 3);
  for (let i = 0; i < root.length; i++) root[i] = i;
  const find = (i: number): number => {
    while (root[i] !== i) i = root[i] = root[root[i]];
    return i;
  };
  const cornerAt = (t: number, v: number) => t * 3 + [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]].indexOf(v);
  for (let t = 0; t < nt; t++) {
    if (!inR[t]) continue;
    for (let k = 0; k < 3; k++) {
      const [a, b] = [T[t * 3 + k], T[t * 3 + ((k + 1) % 3)]];
      const n = edge.get(b * nv + a)!;
      if (!inR[n]) continue;
      // Across the edge a→b both corners a and b are the same fan on either side.
      const [p, q] = [find(t * 3 + k), find(cornerAt(n, a))];
      if (p !== q) root[p] = q;
      const [r, u] = [find(t * 3 + ((k + 1) % 3)), find(cornerAt(n, b))];
      if (r !== u) root[r] = u;
    }
  }
  // Fans per corner: their own copy, and the way into the fan (for the shift).
  const fans = new Map<number, number>();
  const fanList: { v: number; id: number; dx: number; dy: number }[][] = Array.from({ length: nv }, () => []);
  for (let t = 0; t < nt; t++) {
    if (!inR[t]) continue;
    const cx = (V[T[t * 3] * 3] + V[T[t * 3 + 1] * 3] + V[T[t * 3 + 2] * 3]) / 3;
    const cy = (V[T[t * 3] * 3 + 1] + V[T[t * 3 + 1] * 3 + 1] + V[T[t * 3 + 2] * 3 + 1]) / 3;
    for (let k = 0; k < 3; k++) {
      const v = T[t * 3 + k];
      const f = find(t * 3 + k);
      let id = fans.get(f);
      if (id === undefined) {
        id = out.length / 3;
        fans.set(f, id);
        out.push(V[v * 3], V[v * 3 + 1], V[v * 3 + 2] - depth);
        fanList[v].push({ v, id, dx: 0, dy: 0 });
      }
      corner[t * 3 + k] = id;
      const fan = fanList[v].find((e) => e.id === id)!;
      const len = Math.hypot(cx - V[v * 3], cy - V[v * 3 + 1]) || 1;
      fan.dx += (cx - V[v * 3]) / len;
      fan.dy += (cy - V[v * 3 + 1]) / len;
    }
  }
  for (const list of fanList) {
    if (list.length < 2) continue;
    for (const f of list) {
      const len = Math.hypot(f.dx, f.dy) || 1;
      [f.dx, f.dy] = [f.dx / len, f.dy / len];
    }
  }
  /**
   * The floor copy of corner i: its only one, else (for the piece's side under a pinch on it) the fan running along that
   * side the way the side's triangle lies.
   */
  const prime = new Int32Array(nv).fill(-1);
  for (let v = 0; v < nv; v++) if (fanList[v].length) prime[v] = fanList[v][0].id;
  const primeNear = (i: number, tx: number, ty: number) => {
    const all = fanList[i];
    if (all.length < 2) return prime[i];
    const onSide = all.filter((f) => alongSide.has(f.id));
    const list = onSide.length ? onSide : all;
    const toward = (f: (typeof list)[number]) => f.dx * (tx - V[i * 3]) + f.dy * (ty - V[i * 3 + 1]);
    let best = list[0];
    for (const f of list) if (toward(f) > toward(best)) best = f;
    return best.id;
  };

  // The loch's edges: shore (land beside it) or side (the piece's upright side under it).
  const sides: [number, number][] = [];
  /** Shore edges a→b with a's and b's floor copies. */
  const shores: [number, number, number, number][] = [];
  const edgesOut: [number, number, number, number, number][] = [];
  const wallSeeds: number[] = [];
  const alongSide = new Map<number, [number, number][]>();
  for (let t = 0; t < nt; t++) {
    if (!inR[t]) continue;
    for (let k = 0; k < 3; k++) {
      const [a, b] = [T[t * 3 + k], T[t * 3 + ((k + 1) % 3)]];
      const n = edge.get(b * nv + a)!;
      if (inR[n]) continue;
      const [pa, pb] = [corner[t * 3 + k], corner[t * 3 + ((k + 1) % 3)]];
      edgesOut.push([a, b, flatAt[t], pa, pb]);
      const third = [T[n * 3], T[n * 3 + 1], T[n * 3 + 2]].find((i) => i !== a && i !== b)!;
      if (Math.abs(nz(n)) < 0.05 && z(third) < z(a) - depth / 2) {
        sides.push([a, b]);
        // A pinch on the piece's side: its floor copy moves along the side, never off it.
        for (const [v, id, w] of [[a, pa, b], [b, pb, a]]) {
          if (fanList[v].length < 2) continue;
          const len = Math.hypot(V[w * 3] - V[v * 3], V[w * 3 + 1] - V[v * 3 + 1]) || 1;
          const list = alongSide.get(id) ?? [];
          list.push([(V[w * 3] - V[v * 3]) / len, (V[w * 3 + 1] - V[v * 3 + 1]) / len]);
          alongSide.set(id, list);
        }
        wallSeeds.push(n);
      } else shores.push([a, b, pa, pb]);
    }
  }
  // Each side's copy of a pinch corner moved into its own fan (along the piece's side when it's on it; at a corner of
  // the piece, where it can't stay on both sides, not at all).
  for (const list of fanList) {
    if (list.length < 2) continue;
    for (const f of list) {
      const along = alongSide.get(f.id);
      const [dx, dy] = !along ? [f.dx, f.dy] : along.length === 1 ? along[0] : [0, 0];
      out[f.id * 3] += dx * PINCH_SHIFT;
      out[f.id * 3 + 1] += dy * PINCH_SHIFT;
    }
  }
  // The piece's sides under the loch: upright faces reached from under its side edges, across their slanting edges
  // only (an edge straight up and down is where one side of the outline meets the next).
  const underWater = new Uint8Array(nt);
  const upright = (a: number, b: number) => Math.abs(V[a * 3] - V[b * 3]) < FLAT && Math.abs(V[a * 3 + 1] - V[b * 3 + 1]) < FLAT;
  const stack = [...wallSeeds];
  for (const t of stack) underWater[t] = 1;
  while (stack.length) {
    const t = stack.pop()!;
    for (let k = 0; k < 3; k++) {
      const [a, b] = [T[t * 3 + k], T[t * 3 + ((k + 1) % 3)]];
      if (upright(a, b)) continue;
      const n = edge.get(b * nv + a)!;
      if (underWater[n] || inR[n] || !(Math.abs(nz(n)) < 0.05)) continue;
      if (![T[n * 3], T[n * 3 + 1], T[n * 3 + 2]].some((i) => prime[i] >= 0)) continue;
      underWater[n] = 1;
      stack.push(n);
    }
  }
  // The rest of the piece: the lochs' floors dropped, the sides under them stopping there, a wall up to every shore.
  const main: number[] = [];
  for (let t = 0; t < nt; t++) {
    const [a, b, c] = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
    if (inR[t]) main.push(corner[t * 3], corner[t * 3 + 1], corner[t * 3 + 2]);
    else if (underWater[t]) {
      const cx = (V[a * 3] + V[b * 3] + V[c * 3]) / 3;
      const cy = (V[a * 3 + 1] + V[b * 3 + 1] + V[c * 3 + 1]) / 3;
      main.push(...[a, b, c].map((i) => (prime[i] >= 0 ? primeNear(i, cx, cy) : i)));
    }
    else main.push(a, b, c);
  }
  for (const [a, b, pa, pb] of shores) main.push(a, b, pb, a, pb, pa);
  if (!heal(out, main)) return null;
  // The slabs, one per level: the lochs' tops, their floors, and walls all round.
  levels.sort((p, q) => p - q);
  const slabOf = (z: number) => levels.findIndex((l) => Math.abs(l - z) < FLAT);
  const water: number[][] = levels.map(() => []);
  for (let t = 0; t < nt; t++) {
    if (!inR[t]) continue;
    const [a, b, c] = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
    water[slabOf(flatAt[t])].push(a, b, c, corner[t * 3], corner[t * 3 + 2], corner[t * 3 + 1]);
  }
  for (const [a, b, l, pa, pb] of edgesOut) water[slabOf(l)].push(b, a, pa, b, pa, pb);
  const mainMesh = compact(out, main);
  const waters = water.map((w, i) => ({ level: levels[i], mesh: compact(out, w) }));
  // All closed, and adding up to the piece.
  const whole = volumeOf(V, T);
  let sum = volumeOf(mainMesh.vertices, mainMesh.triangles);
  for (const w of waters) {
    const v = volumeOf(w.mesh.vertices, w.mesh.triangles);
    if (!closedMesh(w.mesh) || !(v > 0)) return null;
    sum += v;
  }
  if (!closedMesh(mainMesh) || Math.abs(sum - whole) > 1e-6 * Math.max(1, Math.abs(whole))) return null;
  return { main: mainMesh, waters, levels };
}

/**
 * Close the gaps left where an upright side under a loch meets one under land: a triangle whose edge has a dropped corner
 * on it (straight below the shore's end) is split there; any other little hole, lying in one upright face, is filled.
 */
function heal(V: number[], tris: number[]): boolean {
  for (let round = 0; round < 20; round++) {
    const nv = V.length / 3;
    const edge = new Map<number, number>();
    for (let t = 0; t < tris.length / 3; t++) for (let k = 0; k < 3; k++) edge.set(tris[t * 3 + k] * nv + tris[t * 3 + ((k + 1) % 3)], t);
    const open: [number, number][] = [];
    for (const [key] of edge) {
      const [a, b] = [Math.floor(key / nv), key % nv];
      if (!edge.has(b * nv + a)) open.push([a, b]);
    }
    if (!open.length) return true;
    // Chain the open edges into loops (b → the edge leaving b).
    const next = new Map<number, number>();
    for (const [a, b] of open) {
      if (next.has(a)) return false;
      next.set(a, b);
    }
    const done = new Set<number>();
    // Triangles split this round (their entries in `edge` are out of date until the next).
    const touched = new Set<number>();
    let changed = false;
    for (const [start] of open) {
      if (done.has(start)) continue;
      const loop: number[] = [];
      let v = start;
      while (!done.has(v)) {
        done.add(v);
        loop.push(v);
        const w = next.get(v);
        if (w === undefined) return false;
        v = w;
      }
      if (v !== start || loop.length < 3) return false;
      // Collinear (a corner sitting on another triangle's edge): split that triangle at it.
      const P = (i: number): [number, number, number] => [V[i * 3], V[i * 3 + 1], V[i * 3 + 2]];
      if (loop.length === 3 && flatLoop(P(loop[0]), P(loop[1]), P(loop[2]))) {
        let split = false;
        // The long edge a→b of some triangle (a, b, X), with the loop's third corner c on it: (a, c, X) + (c, b, X).
        for (let k = 0; k < 3; k++) {
          const [a, b, c] = [loop[k], loop[(k + 1) % 3], loop[(k + 2) % 3]];
          const t = edge.get(a * nv + b);
          if (t === undefined || !between(P(a), P(b), P(c))) continue;
          if (touched.has(t)) {
            split = true;
            break;
          }
          touched.add(t);
          const X = [tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]].find((i) => i !== a && i !== b)!;
          tris.splice(t * 3, 3, a, c, X);
          touched.add(tris.length / 3);
          tris.push(c, b, X);
          changed = split = true;
          break;
        }
        if (!split) return false;
        continue;
      }
      // A small hole in one upright face: filled by a fan.
      if (loop.length > 6) return false;
      const ps = loop.map(P);
      const n = newell(ps);
      if (Math.abs(n[2]) > 1e-6 * Math.hypot(...n)) return false;
      for (let i = 1; i + 1 < loop.length; i++) tris.push(loop[0], loop[i + 1], loop[i]);
      changed = true;
    }
    if (!changed) return false;
  }
  return false;
}

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function flatLoop(a: number[], b: number[], c: number[]): boolean {
  const n = cross(sub(b, a), sub(c, a));
  return Math.hypot(n[0], n[1], n[2]) < 1e-9 * Math.max(1, Math.hypot(...sub(b, a)) * Math.hypot(...sub(c, a)));
}
/** Is c strictly between a and b (they all lie on one line)? */
function between(a: number[], b: number[], c: number[]): boolean {
  const ab = sub(b, a);
  const t = (ab[0] * (c[0] - a[0]) + ab[1] * (c[1] - a[1]) + ab[2] * (c[2] - a[2])) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1);
  return t > 1e-9 && t < 1 - 1e-9;
}
function newell(ps: number[][]): number[] {
  const n = [0, 0, 0];
  for (let i = 0; i < ps.length; i++) {
    const [p, q] = [ps[i], ps[(i + 1) % ps.length]];
    n[0] += (p[1] - q[1]) * (p[2] + q[2]);
    n[1] += (p[2] - q[2]) * (p[0] + q[0]);
    n[2] += (p[0] - q[0]) * (p[1] + q[1]);
  }
  return n;
}

function compact(V: number[], tris: number[]): MeshData {
  const map = new Map<number, number>();
  const vertices: number[] = [];
  const triangles = tris.map((i) => {
    let j = map.get(i);
    if (j === undefined) {
      j = vertices.length / 3;
      map.set(i, j);
      vertices.push(V[i * 3], V[i * 3 + 1], V[i * 3 + 2]);
    }
    return j;
  });
  return { vertices, triangles };
}

function volumeOf(V: ArrayLike<number>, T: ArrayLike<number>): number {
  let v = 0;
  for (let t = 0; t < T.length; t += 3) {
    const [a, b, c] = [T[t] * 3, T[t + 1] * 3, T[t + 2] * 3];
    v += (V[a] * (V[b + 1] * V[c + 2] - V[b + 2] * V[c + 1]) - V[a + 1] * (V[b] * V[c + 2] - V[b + 2] * V[c]) + V[a + 2] * (V[b] * V[c + 1] - V[b + 1] * V[c])) / 6;
  }
  return v;
}

function closedMesh(m: MeshData): boolean {
  const nv = m.vertices.length / 3;
  const edges = new Map<number, number>();
  for (let t = 0; t < m.triangles.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const key = m.triangles[t + k] * nv + m.triangles[t + ((k + 1) % 3)];
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  for (const [key, n] of edges) if (n !== 1 || edges.get((key % nv) * nv + Math.floor(key / nv)) !== 1) return false;
  return true;
}
