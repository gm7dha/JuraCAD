/**
 * Paths, tracks and roads as clean channels (pure): each line's groove is a flat bottom `flat` mm either side of its
 * middle, walls sloping straight up to its edge `hw` out, the same depth all along, measured down from the ground there.
 * Rather than hoping a mesh's points fall on the groove (they never all do: the groove came out ragged, narrow in places,
 * shallow in others, and the paint on whole triangles zigzagged across it), the pieces' top surfaces are cut exactly along
 * the groove's edges and the edges of its flat bottom: every ground triangle a line comes near is split into convex
 * cells by those edges (`cutGrooves`), so each cell lies wholly in the flat bottom, on a wall, or outside, and its corners
 * get the ground's height less the groove's depth exactly there. The paint then fills the channel exactly too
 * (`GrooveIndex.kindAt` on a cell's middle), and the full-colour corners follow the same edges.
 *
 * The edges are made of straight pieces: each segment's two sides, short chords round the outside of each bend and
 * round the line's ends (`ARC_STEP`); the cut lines run on across the cell they cut, which only adds corners. Points
 * where cells' edges meet other triangles' edges are shared (no cracks): every new point on a triangle's edge is put on
 * the neighbours' too, and on the walls that share it.
 */
import type { OsmLineKind } from "./osm";

type XY = [number, number];

/** A line's groove in puzzle mm. */
export interface GrooveLine {
  kind: OsmLineKind;
  pts: XY[];
  /** Half its width; its flat bottom's half width; its depth. */
  hw: number;
  flat: number;
  depth: number;
}

/** How deep a groove is `r` mm from its middle: flat to `flat`, then straight up to nothing at `hw`. */
export function grooveDepth(r: number, hw: number, flat: number, depth: number): number {
  if (r >= hw) return 0;
  if (r <= flat) return depth;
  return (depth * (hw - r)) / (hw - flat);
}

/** Bends and ends are rounded by chords at most this angle apart (radians). */
export const ARC_STEP = Math.PI / 12;
/** Lengths this small (mm) count as nothing: points closer are the same point (the 3MF writer welds at 0.01 µm). */
const EPS = 2e-5;
/** Painted kinds' order where two lines' grooves overlap: roads over footpaths over tracks (as mapRaster ranks them). */
const RANK: Record<OsmLineKind, number> = { road: 3, path: 2, track: 1, river: 0, stream: 0 };

/** A straight cut line: from a to b. */
type Cut = [number, number, number, number];

const BUCKET = 1;

/** Lines' grooves in buckets: depth and kind at a point, and the cuts near a triangle. */
export class GrooveIndex {
  readonly lines: GrooveLine[];
  private segs = new Map<string, number[]>();
  /** Per segment: line index, ax, ay, bx, by. */
  private seg: number[] = [];
  private cutBuckets = new Map<string, number[]>();
  private cuts: Cut[] = [];
  readonly empty: boolean;

  constructor(lines: GrooveLine[]) {
    this.lines = lines.filter((l) => l.pts.length >= 1 && l.hw > 0 && l.depth > 0);
    this.empty = !this.lines.length;
    this.lines.forEach((l, li) => {
      const pts = l.pts.length === 1 ? [l.pts[0], l.pts[0]] : l.pts;
      for (let s = 0; s + 1 < pts.length; s++) {
        const [a, b] = [pts[s], pts[s + 1]];
        const id = this.seg.length / 5;
        this.seg.push(li, a[0], a[1], b[0], b[1]);
        this.put(this.segs, id, Math.min(a[0], b[0]) - l.hw, Math.min(a[1], b[1]) - l.hw, Math.max(a[0], b[0]) + l.hw, Math.max(a[1], b[1]) + l.hw);
      }
      for (const r of [l.flat, l.hw]) if (r > EPS) for (const c of edgeCuts(pts, r)) this.addCut(c);
    });
  }

  private put(m: Map<string, number[]>, id: number, x0: number, y0: number, x1: number, y1: number) {
    const [i0, i1, j0, j1] = [Math.floor(x0 / BUCKET), Math.floor(x1 / BUCKET), Math.floor(y0 / BUCKET), Math.floor(y1 / BUCKET)];
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 1e6) return;
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const key = `${i},${j}`;
        const list = m.get(key);
        if (list) list.push(id);
        else m.set(key, [id]);
      }
  }

  private addCut(c: Cut) {
    if (Math.hypot(c[2] - c[0], c[3] - c[1]) < EPS) return;
    const id = this.cuts.length;
    this.cuts.push(c);
    this.put(this.cutBuckets, id, Math.min(c[0], c[2]), Math.min(c[1], c[3]), Math.max(c[0], c[2]), Math.max(c[1], c[3]));
  }

  /** Each line near (x, y): its distance from the middle. */
  private near(x: number, y: number, visit: (line: GrooveLine, r: number) => void) {
    const list = this.segs.get(`${Math.floor(x / BUCKET)},${Math.floor(y / BUCKET)}`);
    if (!list) return;
    for (const id of list) {
      const o = id * 5;
      const [ax, ay, bx, by] = [this.seg[o + 1], this.seg[o + 2], this.seg[o + 3], this.seg[o + 4]];
      const [dx, dy] = [bx - ax, by - ay];
      const L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
      visit(this.lines[this.seg[o]], Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
  }

  /** How deep the grooves are at (x, y): the deepest there. */
  depthAt(x: number, y: number): number {
    let d = 0;
    this.near(x, y, (l, r) => {
      if (r < l.hw) d = Math.max(d, grooveDepth(r, l.hw, l.flat, l.depth));
    });
    return d;
  }

  /** Which line's groove (x, y) is in (strictly inside its edge), roads first; null outside them all. */
  kindAt(x: number, y: number): OsmLineKind | null {
    let best: OsmLineKind | null = null;
    this.near(x, y, (l, r) => {
      if (r < l.hw - EPS && (best === null || RANK[l.kind] > RANK[best])) best = l.kind;
    });
    return best;
  }

  /** Is anything within `m` mm of the box? (A quick test before cutting a triangle.) */
  cutsNear(x0: number, y0: number, x1: number, y1: number): Cut[] {
    const seen = new Set<number>();
    const out: Cut[] = [];
    for (let i = Math.floor(x0 / BUCKET); i <= Math.floor(x1 / BUCKET); i++)
      for (let j = Math.floor(y0 / BUCKET); j <= Math.floor(y1 / BUCKET); j++)
        for (const id of this.cutBuckets.get(`${i},${j}`) ?? []) {
          if (seen.has(id)) continue;
          seen.add(id);
          const c = this.cuts[id];
          if (Math.max(c[0], c[2]) < x0 || Math.min(c[0], c[2]) > x1 || Math.max(c[1], c[3]) < y0 || Math.min(c[1], c[3]) > y1) continue;
          out.push(c);
        }
    return out;
  }
}

/** The straight pieces round a line at distance r: both sides of each segment, chords round bends' outsides and the ends. */
function edgeCuts(pts: XY[], r: number): Cut[] {
  const out: Cut[] = [];
  const n = pts.length;
  const normals: XY[] = [];
  for (let s = 0; s + 1 < n; s++) {
    const [dx, dy] = [pts[s + 1][0] - pts[s][0], pts[s + 1][1] - pts[s][1]];
    const L = Math.hypot(dx, dy);
    normals.push(L > 1e-12 ? [-dy / L, dx / L] : normals[normals.length - 1] ?? [0, 1]);
  }
  const arc = (c: XY, from: number, to: number) => {
    // Round from angle `from` to `to` (to > from), as chords.
    const k = Math.max(1, Math.ceil((to - from) / ARC_STEP));
    for (let i = 0; i < k; i++) {
      const [u, v] = [from + ((to - from) * i) / k, from + ((to - from) * (i + 1)) / k];
      out.push([c[0] + r * Math.cos(u), c[1] + r * Math.sin(u), c[0] + r * Math.cos(v), c[1] + r * Math.sin(v)]);
    }
  };
  for (let s = 0; s + 1 < n; s++) {
    const [a, b] = [pts[s], pts[s + 1]];
    const [nx, ny] = normals[s];
    out.push([a[0] + r * nx, a[1] + r * ny, b[0] + r * nx, b[1] + r * ny]);
    out.push([a[0] - r * nx, a[1] - r * ny, b[0] - r * nx, b[1] - r * ny]);
  }
  for (let i = 1; i + 1 < n; i++) {
    const [n1, n2] = [normals[i - 1], normals[i]];
    const cross = n1[0] * n2[1] - n1[1] * n2[0];
    const dot = n1[0] * n2[0] + n1[1] * n2[1];
    const turn = Math.atan2(cross, dot);
    if (Math.abs(turn) < 1e-9) continue;
    // A left turn (turn > 0) opens on the right (−normal side), a right turn on the left.
    const a1 = Math.atan2(n1[1], n1[0]);
    if (turn > 0) arc(pts[i], a1 + Math.PI, a1 + Math.PI + turn);
    else arc(pts[i], a1 + turn, a1);
  }
  // Round ends.
  const [s0, s1] = [normals[0], normals[normals.length - 1]];
  const b0 = Math.atan2(s0[1], s0[0]);
  arc(pts[0], b0, b0 + Math.PI);
  const b1 = Math.atan2(s1[1], s1[0]);
  arc(pts[n - 1], b1 - Math.PI, b1);
  return out;
}

/** A corner of a cell: where it is, and which of the triangle's edges it's on (−1: inside) at what share along it. */
interface CV {
  x: number;
  y: number;
  e: number;
  t: number;
}

const onEdge = (p: CV, E: number): number | null => (p.e === E ? p.t : p.e === (E + 1) % 3 && p.t === 0 ? 1 : null);

/** The cell split by the line n·p = c: [the side below, the side above], or null when it isn't crossed. */
function split(cell: CV[], nx: number, ny: number, c: number, corners: XY[]): [CV[], CV[]] | null {
  const d = cell.map((p) => nx * p.x + ny * p.y - c);
  if (d.every((v) => v >= -EPS) || d.every((v) => v <= EPS)) return null;
  const lo: CV[] = [];
  const hi: CV[] = [];
  for (let i = 0; i < cell.length; i++) {
    const j = (i + 1) % cell.length;
    const [p, q] = [cell[i], cell[j]];
    const [dp, dq] = [d[i], d[j]];
    if (dp <= EPS) lo.push(p);
    if (dp >= -EPS) hi.push(p);
    if ((dp < -EPS && dq > EPS) || (dp > EPS && dq < -EPS)) {
      // The crossing, worked out the same way whichever way round the edge is walked.
      const swap = p.x > q.x || (p.x === q.x && p.y > q.y);
      const [P, Q, dP, dQ] = swap ? [q, p, dq, dp] : [p, q, dp, dq];
      const s = dP / (dP - dQ);
      let x: CV;
      let E = -1;
      for (let k = 0; k < 3 && E < 0; k++) if (onEdge(P, k) !== null && onEdge(Q, k) !== null) E = k;
      if (E >= 0) {
        const t = onEdge(P, E)! + (onEdge(Q, E)! - onEdge(P, E)!) * s;
        const [A, B] = [corners[E], corners[(E + 1) % 3]];
        x = { x: A[0] + (B[0] - A[0]) * t, y: A[1] + (B[1] - A[1]) * t, e: E, t };
      } else x = { x: P.x + (Q.x - P.x) * s, y: P.y + (Q.y - P.y) * s, e: -1, t: 0 };
      lo.push(x);
      hi.push(x);
    }
  }
  return lo.length >= 3 && hi.length >= 3 ? [lo, hi] : null;
}

/** Does the cut piece a–b reach into the cell (not just its line)? */
function reaches(cell: CV[], c: Cut, nx: number, ny: number, off: number): boolean {
  const [ux, uy] = [c[2] - c[0], c[3] - c[1]];
  const L = Math.hypot(ux, uy);
  let [lo, hi] = [Infinity, -Infinity];
  for (let i = 0; i < cell.length; i++) {
    const [p, q] = [cell[i], cell[(i + 1) % cell.length]];
    const [dp, dq] = [nx * p.x + ny * p.y - off, nx * q.x + ny * q.y - off];
    if ((dp <= 0 && dq >= 0) || (dp >= 0 && dq <= 0)) {
      const s = dp === dq ? 0 : dp / (dp - dq);
      const [x, y] = [p.x + (q.x - p.x) * s, p.y + (q.y - p.y) * s];
      const along = ((x - c[0]) * ux + (y - c[1]) * uy) / L;
      [lo, hi] = [Math.min(lo, along), Math.max(hi, along)];
    }
  }
  return hi > EPS && lo < L - EPS;
}

/** A ground triangle's corners (x, y) cut into convex cells by the cut pieces near it. */
export function cutTriangle(corners: XY[], cuts: Cut[]): CV[][] {
  let cells: CV[][] = [corners.map(([x, y], e) => ({ x, y, e, t: 0 }))];
  for (const c of cuts) {
    const [ux, uy] = [c[2] - c[0], c[3] - c[1]];
    const L = Math.hypot(ux, uy);
    const [nx, ny] = [-uy / L, ux / L];
    const off = nx * c[0] + ny * c[1];
    const next: CV[][] = [];
    for (const cell of cells) {
      const parts = reaches(cell, c, nx, ny, off) ? split(cell, nx, ny, off, corners) : null;
      if (parts) next.push(parts[0], parts[1]);
      else next.push(cell);
    }
    cells = next;
  }
  return cells;
}

/** A body: corners (x, y, z) and triangles. */
export interface CutBody {
  vertices: number[];
  triangles: number[];
}

/**
 * The body with its ground cut along the grooves: `base(x, y)` is the ground as the body was made (without these
 * grooves), `height(x, y)` the ground with them — every corner on the ground takes it, the new ones too. Returns null when
 * no line comes near the body's ground (nothing changed). The body's triangles must share corners (weld it first).
 */
export function cutGrooves(body: CutBody, index: GrooveIndex, base: (x: number, y: number) => number, height: (x: number, y: number) => number): CutBody | null {
  if (index.empty) return null;
  const V = body.vertices;
  const T = body.triangles;
  const nv = V.length / 3;
  const onGround = new Uint8Array(nv);
  for (let i = 0; i < nv; i++) onGround[i] = Math.abs(V[i * 3 + 2] - base(V[i * 3], V[i * 3 + 1])) < 1e-6 ? 1 : 0;
  const nt = T.length / 3;
  const upward = (t: number) => {
    const [a, b, c] = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
    const [ux, uy, uz] = [V[b * 3] - V[a * 3], V[b * 3 + 1] - V[a * 3 + 1], V[b * 3 + 2] - V[a * 3 + 2]];
    const [vx, vy, vz] = [V[c * 3] - V[a * 3], V[c * 3 + 1] - V[a * 3 + 1], V[c * 3 + 2] - V[a * 3 + 2]];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    return n[2] / (Math.hypot(n[0], n[1], n[2]) || 1) > 0.05;
  };
  const ground = new Uint8Array(nt);
  const groundVertex = new Uint8Array(nv);
  for (let t = 0; t < nt; t++)
    if (onGround[T[t * 3]] && onGround[T[t * 3 + 1]] && onGround[T[t * 3 + 2]] && upward(t)) {
      ground[t] = 1;
      for (let k = 0; k < 3; k++) groundVertex[T[t * 3 + k]] = 1;
    }

  // Cut each ground triangle a groove comes near.
  const cellsOf = new Map<number, CV[][]>();
  /** New points on the triangles' edges: edge key → shares along it (from its lower-numbered end). */
  const edgePts = new Map<string, number[]>();
  const edgeKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  let touched = false;
  for (let t = 0; t < nt; t++) {
    if (!ground[t]) continue;
    const ids = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
    const corners = ids.map((i): XY => [V[i * 3], V[i * 3 + 1]]);
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    const cuts = index.cutsNear(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
    if (!cuts.length) continue;
    const cells = cutTriangle(corners, cuts);
    if (cells.length === 1) continue;
    touched = true;
    cellsOf.set(t, cells);
    for (const cell of cells)
      for (const p of cell) {
        if (p.e < 0 || p.t === 0) continue;
        const [a, b] = [ids[p.e], ids[(p.e + 1) % 3]];
        const s = a < b ? p.t : 1 - p.t;
        const key = edgeKey(a, b);
        const list = edgePts.get(key);
        if (list) list.push(s);
        else edgePts.set(key, [s]);
      }
  }
  if (!touched) return null;

  const out = V.slice();
  // Every corner on the ground takes the grooved height.
  for (let i = 0; i < nv; i++) if (groundVertex[i]) out[i * 3 + 2] = height(V[i * 3], V[i * 3 + 1]);
  const newPoint = (x: number, y: number) => {
    out.push(x, y, height(x, y));
    return out.length / 3 - 1;
  };
  // Each edge's new points, merged where they're the same point, in order.
  const edgeIds = new Map<string, { s: number; id: number }[]>();
  for (const [key, list] of edgePts) {
    const [a, b] = key.split(",").map(Number);
    const len = Math.hypot(V[b * 3] - V[a * 3], V[b * 3 + 1] - V[a * 3 + 1], V[b * 3 + 2] - V[a * 3 + 2]) || 1;
    const sorted = [...list].sort((p, q) => p - q);
    const merged: { s: number; id: number }[] = [];
    for (const s of sorted) {
      if (s * len < EPS || (1 - s) * len < EPS) continue;
      if (merged.length && (s - merged[merged.length - 1].s) * len < EPS) continue;
      merged.push({ s, id: newPoint(V[a * 3] + (V[b * 3] - V[a * 3]) * s, V[a * 3 + 1] + (V[b * 3 + 1] - V[a * 3 + 1]) * s) });
    }
    edgeIds.set(key, merged);
  }
  // The edge's points between two of its ends, walking from a to b.
  const between = (a: number, b: number, sa: number, sb: number): number[] => {
    const list = edgeIds.get(edgeKey(a, b));
    if (!list) return [];
    const lowFirst = a < b;
    // Shares from the lower-numbered end.
    const [from, to] = lowFirst ? [sa, sb] : [1 - sa, 1 - sb];
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const inside = list.filter((p) => p.s > lo + 1e-12 && p.s < hi - 1e-12);
    return (from <= to ? inside : inside.reverse()).map((p) => p.id);
  };
  const nearestOn = (a: number, b: number, sa: number): number => {
    const s = a < b ? sa : 1 - sa;
    let [best, gap] = [a < b ? a : b, s];
    if (1 - s < gap) [best, gap] = [a < b ? b : a, 1 - s];
    for (const p of edgeIds.get(edgeKey(a, b)) ?? []) if (Math.abs(p.s - s) < gap) [best, gap] = [p.id, Math.abs(p.s - s)];
    return best;
  };
  // A new point in a polygon's middle: on the ground there (a ground cell), else the corners' average (a wall's plane).
  const middleOf = (onGround: boolean) => (ring: number[]) => {
    let [x, y, z] = [0, 0, 0];
    for (const id of ring) [x, y, z] = [x + out[id * 3], y + out[id * 3 + 1], z + out[id * 3 + 2]];
    [x, y, z] = [x / ring.length, y / ring.length, z / ring.length];
    if (onGround) return newPoint(x, y);
    out.push(x, y, z);
    return out.length / 3 - 1;
  };
  const tris: number[] = [];
  for (let t = 0; t < nt; t++) {
    const ids = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
    const cells = cellsOf.get(t);
    if (!cells) {
      // Untouched — but points put on its edges by a neighbour go in.
      const ring: number[] = [];
      for (let k = 0; k < 3; k++) {
        ring.push(ids[k]);
        ring.push(...between(ids[k], ids[(k + 1) % 3], 0, 1));
      }
      if (ring.length === 3) tris.push(ids[0], ids[1], ids[2]);
      else fanConvex(ring, out, tris, middleOf(!!ground[t]));
      continue;
    }
    // The cells' corners as points of the mesh (new ones inside shared between the cells).
    const inner = new Map<string, number>();
    const pid = (p: CV): number => {
      if (p.e >= 0 && p.t === 0) return ids[p.e];
      if (p.e >= 0) return nearestOn(ids[p.e], ids[(p.e + 1) % 3], p.t);
      const key = `${p.x},${p.y}`;
      let id = inner.get(key);
      if (id === undefined) inner.set(key, (id = newPoint(p.x, p.y)));
      return id;
    };
    const rings = cells.map((cell) => {
      const ring: number[] = [];
      for (let i = 0; i < cell.length; i++) {
        const [p, q] = [cell[i], cell[(i + 1) % cell.length]];
        ring.push(pid(p));
        for (let E = 0; E < 3; E++) {
          const [sp, sq] = [onEdge(p, E), onEdge(q, E)];
          if (sp !== null && sq !== null) {
            ring.push(...between(ids[E], ids[(E + 1) % 3], sp, sq));
            break;
          }
        }
      }
      return ring.filter((id, i) => id !== ring[(i + 1) % ring.length]);
    });
    // Corners of other cells lying on a cell's sides (a cut that stopped at one cell), put in as well.
    const innerIds = [...new Set(rings.flat())];
    for (const ring of rings) {
      const full: number[] = [];
      for (let i = 0; i < ring.length; i++) {
        const [a, b] = [ring[i], ring[(i + 1) % ring.length]];
        full.push(a);
        const [ax, ay, bx, by] = [out[a * 3], out[a * 3 + 1], out[b * 3], out[b * 3 + 1]];
        const L = Math.hypot(bx - ax, by - ay);
        if (L < EPS) continue;
        const on: [number, number][] = [];
        const own = new Set(ring);
        for (const c of innerIds) {
          if (own.has(c)) continue;
          const [cx, cy] = [out[c * 3], out[c * 3 + 1]];
          const s = ((cx - ax) * (bx - ax) + (cy - ay) * (by - ay)) / (L * L);
          if (s * L <= EPS || (1 - s) * L <= EPS) continue;
          // Only a corner made on this very line (a cut that ran on across the next cell): within rounding of it.
          if (Math.abs((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / L < 1e-9) on.push([s, c]);
        }
        on.sort((p, q) => p[0] - q[0]);
        for (const [, c] of on) full.push(c);
      }
      fanConvex(full, out, tris, middleOf(true));
    }
  }
  return { vertices: out, triangles: tris };
}

/**
 * A convex polygon (possibly with corners lying on straight sides) as triangles, the way round it's given: a fan from a
 * real corner whose sides carry no extra corners, so no triangle is flat; failing one, a fan from a new point in its
 * middle (`centre`).
 */
function fanConvex(ring: number[], V: number[], tris: number[], centre: (ring: number[]) => number) {
  const r = ring.filter((id, i) => id !== ring[(i + 1) % ring.length]);
  if (r.length < 3) return;
  const cross = (a: number, b: number, c: number) => {
    const [ux, uy, uz] = [V[b * 3] - V[a * 3], V[b * 3 + 1] - V[a * 3 + 1], V[b * 3 + 2] - V[a * 3 + 2]];
    const [vx, vy, vz] = [V[c * 3] - V[a * 3], V[c * 3 + 1] - V[a * 3 + 1], V[c * 3 + 2] - V[a * 3 + 2]];
    return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / (Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz) || 1);
  };
  const n = r.length;
  if (n === 3) {
    tris.push(r[0], r[1], r[2]);
    return;
  }
  // A real corner: the sides either side of it turn (sine of the turn above a hair).
  const corner = r.map((_, i) => cross(r[i], r[(i + 1) % n], r[(i + n - 1) % n]) > 1e-7);
  for (let i = 0; i < n; i++)
    if (corner[i] && corner[(i + 1) % n] && corner[(i + n - 1) % n]) {
      for (let k = 1; k + 1 < n; k++) tris.push(r[i], r[(i + k) % n], r[(i + k + 1) % n]);
      return;
    }
  const c = centre(r);
  for (let i = 0; i < n; i++) tris.push(c, r[i], r[(i + 1) % n]);
}
