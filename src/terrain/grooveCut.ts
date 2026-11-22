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
 * The edges are made of straight pieces: each side carried along the line, short chords round the outside of each bend
 * and round the line's ends (`ARC_STEP`); the cut lines run on across the cell they cut, which only adds corners. Points
 * where cells' edges meet other triangles' edges are shared (no cracks): every new point on a triangle's edge is put on
 * the neighbours' too, and on the walls that share it.
 */
import type { OsmLineKind } from "./osm";
import { triangulate, type P2 } from "./triangulate";

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
/** A bucket's number (puzzles are well under 100 m across). */
const bucketKey = (i: number, j: number) => (i + 100000) * 200001 + (j + 100000);

/** Lines' grooves in buckets: depth and kind at a point, and the cuts near a triangle. */
export class GrooveIndex {
  readonly lines: GrooveLine[];
  private segs = new Map<number, number[]>();
  /** Per segment: line index, ax, ay, bx, by. */
  private seg: number[] = [];
  private cutBuckets = new Map<number, number[]>();
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

  private put(m: Map<number, number[]>, id: number, x0: number, y0: number, x1: number, y1: number) {
    const [i0, i1, j0, j1] = [Math.floor(x0 / BUCKET), Math.floor(x1 / BUCKET), Math.floor(y0 / BUCKET), Math.floor(y1 / BUCKET)];
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 1e6) return;
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const key = bucketKey(i, j);
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
    const list = this.segs.get(bucketKey(Math.floor(x / BUCKET), Math.floor(y / BUCKET)));
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

  /** Does any line's groove (by its pieces' boxes) come into the box? */
  touches(x0: number, y0: number, x1: number, y1: number): boolean {
    for (let i = Math.floor(x0 / BUCKET); i <= Math.floor(x1 / BUCKET); i++)
      for (let j = Math.floor(y0 / BUCKET); j <= Math.floor(y1 / BUCKET); j++) if (this.segs.has(bucketKey(i, j))) return true;
    return false;
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

  /** The cut pieces whose boxes meet the box. */
  private stamp = new Uint32Array(0);
  private round = 0;
  cutsNear(x0: number, y0: number, x1: number, y1: number): Cut[] {
    if (this.stamp.length < this.cuts.length) this.stamp = new Uint32Array(this.cuts.length);
    const mark = ++this.round;
    const out: Cut[] = [];
    for (let i = Math.floor(x0 / BUCKET); i <= Math.floor(x1 / BUCKET); i++)
      for (let j = Math.floor(y0 / BUCKET); j <= Math.floor(y1 / BUCKET); j++)
        for (const id of this.cutBuckets.get(bucketKey(i, j)) ?? []) {
          if (this.stamp[id] === mark) continue;
          this.stamp[id] = mark;
          const c = this.cuts[id];
          if (Math.max(c[0], c[2]) < x0 || Math.min(c[0], c[2]) > x1 || Math.max(c[1], c[3]) < y0 || Math.min(c[1], c[3]) > y1) continue;
          out.push(c);
        }
    return out;
  }
}

/**
 * The outline round a line at distance r, as straight pieces: each side carried along the line — meeting its next piece
 * where the side is on the inside of a bend, joined by chords round the outside — and round ends.
 */
function edgeCuts(pts: XY[], r: number): Cut[] {
  const n = pts.length;
  const normals: XY[] = [];
  for (let s = 0; s + 1 < n; s++) {
    const [dx, dy] = [pts[s + 1][0] - pts[s][0], pts[s + 1][1] - pts[s][1]];
    const L = Math.hypot(dx, dy);
    normals.push(L > 1e-12 ? [-dy / L, dx / L] : normals[normals.length - 1] ?? [0, 1]);
  }
  const at = (c: XY, a: number): XY => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
  // Round from angle `from` to `to` (either way), the end points only past the start.
  const arc = (c: XY, from: number, to: number, out: XY[]) => {
    const k = Math.max(1, Math.ceil(Math.abs(to - from) / ARC_STEP));
    for (let i = 1; i <= k; i++) out.push(at(c, from + ((to - from) * i) / k));
  };
  /** One side (+1 left, −1 right) from the first point to the last. */
  const side = (sign: number): XY[] => {
    const out: XY[] = [[pts[0][0] + sign * r * normals[0][0], pts[0][1] + sign * r * normals[0][1]]];
    for (let i = 1; i + 1 < n; i++) {
      const [n1, n2] = [normals[i - 1], normals[i]];
      const turn = Math.atan2(n1[0] * n2[1] - n1[1] * n2[0], n1[0] * n2[0] + n1[1] * n2[1]);
      const p = pts[i];
      const a1 = Math.atan2(sign * n1[1], sign * n1[0]);
      const dot = n1[0] * n2[0] + n1[1] * n2[1];
      // Left turns have the left side inside, right turns the right side.
      const inside = turn * sign > 0;
      if (Math.abs(turn) < 1e-9) out.push([p[0] + sign * r * n2[0], p[1] + sign * r * n2[1]]);
      else if (inside && dot > -0.8) {
        const m = r / (1 + dot);
        out.push([p[0] + sign * m * (n1[0] + n2[0]), p[1] + sign * m * (n1[1] + n2[1])]);
      } else {
        out.push(at(p, a1));
        arc(p, a1, a1 + turn, out);
      }
    }
    const last = normals[normals.length - 1];
    out.push([pts[n - 1][0] + sign * r * last[0], pts[n - 1][1] + sign * r * last[1]]);
    return out;
  };
  const left = side(1);
  const right = side(-1);
  const loop: XY[] = [...left];
  const [s0, s1] = [normals[0], normals[normals.length - 1]];
  const b1 = Math.atan2(s1[1], s1[0]);
  arc(pts[n - 1], b1, b1 - Math.PI, loop);
  loop.push(...right.reverse().slice(1));
  const b0 = Math.atan2(-s0[1], -s0[0]);
  arc(pts[0], b0, b0 - Math.PI, loop);
  const out: Cut[] = [];
  for (let i = 0; i + 1 < loop.length; i++) out.push([loop[i][0], loop[i][1], loop[i + 1][0], loop[i + 1][1]]);
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
  {
    // Nothing near the body at all: nothing to do (most pieces of a big puzzle).
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < nv; i++) [x0, y0, x1, y1] = [Math.min(x0, V[i * 3]), Math.min(y0, V[i * 3 + 1]), Math.max(x1, V[i * 3]), Math.max(y1, V[i * 3 + 1])];
    if (!index.touches(x0, y0, x1, y1)) return null;
  }
  // Which corners lie on the ground, worked out only for triangles a line comes near (−1: not yet asked).
  const onGroundAt = new Int8Array(nv).fill(-1);
  const onGround = (i: number) => {
    if (onGroundAt[i] < 0) onGroundAt[i] = Math.abs(V[i * 3 + 2] - base(V[i * 3], V[i * 3 + 1])) < 1e-6 ? 1 : 0;
    return onGroundAt[i] === 1;
  };
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
  for (let t = 0; t < nt; t++) {
    const [a, b, c] = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
    // Only triangles some line's groove (its box) comes near can be cut or lowered.
    if (!index.touches(Math.min(V[a * 3], V[b * 3], V[c * 3]), Math.min(V[a * 3 + 1], V[b * 3 + 1], V[c * 3 + 1]), Math.max(V[a * 3], V[b * 3], V[c * 3]), Math.max(V[a * 3 + 1], V[b * 3 + 1], V[c * 3 + 1]))) continue;
    if (onGround(a) && onGround(b) && onGround(c) && upward(t)) {
      ground[t] = 1;
      for (let k = 0; k < 3; k++) groundVertex[T[t * 3 + k]] = 1;
    }
  }

  // Cut each ground triangle a groove comes near.
  const cellsOf = new Map<number, CV[][]>();
  /** New points on the triangles' edges: edge key → shares along it (from its lower-numbered end). */
  const edgePts = new Map<number, number[]>();
  const edgeKey = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
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
  // Corners in a channel (also of triangles lying wholly inside one, which no edge crosses).
  const lowered = new Uint8Array(nv);
  for (let i = 0; i < nv; i++)
    if (groundVertex[i] && index.depthAt(V[i * 3], V[i * 3 + 1]) > 0) {
      lowered[i] = 1;
      touched = true;
    }
  if (!touched) return null;

  const out = V.slice();
  // Every corner on the ground in a channel takes the grooved height (elsewhere it's the same).
  for (let i = 0; i < nv; i++) if (lowered[i]) out[i * 3 + 2] = height(V[i * 3], V[i * 3 + 1]);
  const newPoint = (x: number, y: number) => {
    out.push(x, y, height(x, y));
    return out.length / 3 - 1;
  };
  // Each edge's new points, merged where they're the same point, in order.
  const edgeIds = new Map<number, { s: number; id: number }[]>();
  for (const [key, list] of edgePts) {
    const [a, b] = [Math.floor(key / nv), key % nv];
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
  const hasPoints = (t: number) => {
    for (let k = 0; k < 3; k++) if (edgeIds.has(edgeKey(T[t * 3 + k], T[t * 3 + (k + 1) % 3]))) return true;
    return false;
  };
  // Walls (not ground) whose top edge took a channel's points: the points dip below the edge, so a wall triangle is
  // taken together with its partner across its other edges (the quad's two halves) and the outline triangulated in the
  // wall's plane — a fan of the triangle alone could reach below its diagonal and fold over its partner.
  const byEdge = new Map<number, number[]>();
  let wallsAt = false;
  for (let t = 0; t < nt && !wallsAt; t++) if (!ground[t] && !cellsOf.has(t) && hasPoints(t)) wallsAt = true;
  if (wallsAt)
    for (let t = 0; t < nt; t++)
      for (let k = 0; k < 3; k++) {
        const key = edgeKey(T[t * 3 + k], T[t * 3 + (k + 1) % 3]);
        const list = byEdge.get(key);
        if (list) list.push(t);
        else byEdge.set(key, [t]);
      }
  const taken = new Uint8Array(nt);
  const walls = new Map<number, number[]>();
  const normalOf = (t: number): [number, number, number] => {
    const [a, b, c] = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
    const [ux, uy, uz] = [V[b * 3] - V[a * 3], V[b * 3 + 1] - V[a * 3 + 1], V[b * 3 + 2] - V[a * 3 + 2]];
    const [vx, vy, vz] = [V[c * 3] - V[a * 3], V[c * 3 + 1] - V[a * 3 + 1], V[c * 3 + 2] - V[a * 3 + 2]];
    const n: [number, number, number] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const L = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / L, n[1] / L, n[2] / L];
  };
  for (let t = 0; t < nt; t++) {
    if (ground[t] || cellsOf.has(t) || taken[t] || !hasPoints(t)) continue;
    const n = normalOf(t);
    const ring: number[] = [];
    const used = [t];
    for (let k = 0; k < 3; k++) {
      const [a, b] = [T[t * 3 + k], T[t * 3 + (k + 1) % 3]];
      ring.push(a);
      const key = edgeKey(a, b);
      if (edgeIds.has(key)) {
        ring.push(...between(a, b, 0, 1));
        continue;
      }
      // The triangle across this edge, if it lies in the same plane and is otherwise untouched: its far corner joins in.
      const other = (byEdge.get(key) ?? []).find((u) => u !== t);
      if (other === undefined || ground[other] || cellsOf.has(other) || taken[other] || hasPoints(other)) continue;
      const m = normalOf(other);
      if (n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < 1 - 1e-9) continue;
      const far = [0, 1, 2].map((q) => T[other * 3 + q]).find((v) => v !== a && v !== b);
      if (far === undefined || ring.includes(far)) continue;
      ring.push(far);
      used.push(other);
    }
    walls.set(t, ring);
    for (const u of used) taken[u] = 1;
  }
  /** A wall's outline (corners in `out`) as triangles in its plane (normal n), the way round it's given; false if it can't. */
  const wallTriangles = (ring: number[], n: [number, number, number]): boolean => {
    const r = ring.filter((id, i) => id !== ring[(i + 1) % ring.length]);
    if (r.length < 3) return true;
    // u, v across the plane with u × v = n, so the outline keeps its way round.
    const ax: [number, number, number] = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let u = [ax[1] * n[2] - ax[2] * n[1], ax[2] * n[0] - ax[0] * n[2], ax[0] * n[1] - ax[1] * n[0]];
    const lu = Math.hypot(u[0], u[1], u[2]);
    u = u.map((c) => c / lu);
    const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    const pts: P2[] = r.map((id) => {
      const [x, y, z] = [out[id * 3], out[id * 3 + 1], out[id * 3 + 2]];
      return [x * u[0] + y * u[1] + z * u[2], x * v[0] + y * v[1] + z * v[2]];
    });
    let area = 0;
    for (let i = 0; i < pts.length; i++) area += pts[i][0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * pts[i][1];
    if (!(area > 0)) return false;
    // Simple outline only (no side crossing another).
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 2; j < pts.length; j++) {
        if (i === 0 && j === pts.length - 1) continue;
        if (segmentsCross(pts[i], pts[(i + 1) % pts.length], pts[j], pts[(j + 1) % pts.length])) return false;
      }
    let made: [number, number, number][];
    try {
      made = triangulate(pts);
    } catch {
      return false;
    }
    if (made.length !== pts.length - 2) return false;
    for (const [a, b, c] of made) tris.push(r[a], r[b], r[c]);
    return true;
  };
  for (let t = 0; t < nt; t++) {
    const cells = cellsOf.get(t);
    const ids = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
    const wall = walls.get(t);
    if (wall) {
      if (!wallTriangles(wall, normalOf(t))) fanConvex(wall, out, tris, middleOf(false), false);
      continue;
    }
    if (taken[t]) continue;
    if (!cells) {
      // Untouched — but points put on its edges by a neighbour go in.
      if (!edgeIds.has(edgeKey(ids[0], ids[1])) && !edgeIds.has(edgeKey(ids[1], ids[2])) && !edgeIds.has(edgeKey(ids[2], ids[0]))) {
        tris.push(ids[0], ids[1], ids[2]);
        continue;
      }
      const ring: number[] = [];
      for (let k = 0; k < 3; k++) {
        ring.push(ids[k]);
        ring.push(...between(ids[k], ids[(k + 1) % 3], 0, 1));
      }
      if (ring.length === 3) tris.push(ids[0], ids[1], ids[2]);
      else fanConvex(ring, out, tris, middleOf(!!ground[t]), !!ground[t]);
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
    // Corners made inside the triangle lying on another cell's side (a cut that stopped at one cell), put in as well.
    const loose = [...inner.values()];
    for (const ring of rings) {
      if (!loose.length) {
        fanConvex(ring, out, tris, middleOf(true), true);
        continue;
      }
      const full: number[] = [];
      for (let i = 0; i < ring.length; i++) {
        const [a, b] = [ring[i], ring[(i + 1) % ring.length]];
        full.push(a);
        const [ax, ay, bx, by] = [out[a * 3], out[a * 3 + 1], out[b * 3], out[b * 3 + 1]];
        const L = Math.hypot(bx - ax, by - ay);
        if (L < EPS) continue;
        const [x0, x1, y0, y1] = [Math.min(ax, bx) - 1e-9, Math.max(ax, bx) + 1e-9, Math.min(ay, by) - 1e-9, Math.max(ay, by) + 1e-9];
        let on: [number, number][] | null = null;
        for (const c of loose) {
          const [cx, cy] = [out[c * 3], out[c * 3 + 1]];
          if (cx < x0 || cx > x1 || cy < y0 || cy > y1 || c === a || c === b) continue;
          const s = ((cx - ax) * (bx - ax) + (cy - ay) * (by - ay)) / (L * L);
          if (s * L <= EPS || (1 - s) * L <= EPS) continue;
          // Only a corner made on this very line (a cut that ran on across the next cell): within rounding of it.
          if (Math.abs((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / L < EPS && !ring.includes(c)) (on ??= []).push([s, c]);
        }
        if (on) {
          on.sort((p, q) => p[0] - q[0]);
          for (const [, c] of on) full.push(c);
        }
      }
      fanConvex(full, out, tris, middleOf(true), true);
    }
  }
  return { vertices: out, triangles: tris };
}

/** Do the segments p–q and r–s cross (properly, not just touching at an end)? */
function segmentsCross(p: P2, q: P2, r: P2, s: P2): boolean {
  const c = (a: P2, b: P2, d: P2) => (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
  const [d1, d2, d3, d4] = [c(r, s, p), c(r, s, q), c(p, q, r), c(p, q, s)];
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * A convex polygon (possibly with corners lying on straight sides) as triangles, the way round it's given: a fan from a
 * real corner whose sides carry no extra corners, so no triangle is flat; failing one, a fan from a new point in its
 * middle (`centre`).
 */
function fanConvex(ring: number[], V: number[], tris: number[], centre: (ring: number[]) => number, plan = false) {
  const r = ring.filter((id, i) => id !== ring[(i + 1) % ring.length]);
  if (r.length < 3) return;
  // How far corner a lies off the straight line through its neighbours b and c. On the ground, cells are convex seen
  // from above, so it's measured seen from above: a point on a straight side where only the height bends is no corner
  // (a fan from beside it would stand a triangle on its edge there). Points merged within `EPS` count as on the line.
  const off = (a: number, b: number, c: number) => {
    const [ux, uy, uz] = [V[c * 3] - V[b * 3], V[c * 3 + 1] - V[b * 3 + 1], plan ? 0 : V[c * 3 + 2] - V[b * 3 + 2]];
    const [wx, wy, wz] = [V[a * 3] - V[b * 3], V[a * 3 + 1] - V[b * 3 + 1], plan ? 0 : V[a * 3 + 2] - V[b * 3 + 2]];
    return Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / (Math.hypot(ux, uy, uz) || 1);
  };
  const n = r.length;
  if (n === 3) {
    tris.push(r[0], r[1], r[2]);
    return;
  }
  // A real corner: off the line through its neighbours by more than `EPS`.
  const corner = r.map((_, i) => off(r[i], r[(i + n - 1) % n], r[(i + 1) % n]) > EPS);
  for (let i = 0; i < n; i++)
    if (corner[i] && corner[(i + 1) % n] && corner[(i + n - 1) % n]) {
      for (let k = 1; k + 1 < n; k++) tris.push(r[i], r[(i + k) % n], r[(i + k + 1) % n]);
      return;
    }
  const c = centre(r);
  for (let i = 0; i < n; i++) tris.push(c, r[i], r[(i + 1) % n]);
}
