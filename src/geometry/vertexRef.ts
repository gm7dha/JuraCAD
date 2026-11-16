/**
 * Remembering a picked corner (a vertex of a part) across rebuilds, as
 * topoRef.ts does for edges and faces: we keep where it is (also as a share
 * of the part's box, so a corner "at the far top right" stays there when the
 * part grows) and which ways its edges leave it, and on each rebuild look for
 * the corner that matches — near and unambiguous, else it's reported lost.
 *
 * The corners themselves come from the ends of the part's edges (closed
 * edges such as a whole circle have no corner).
 */
import { relativeTo, roundVec, type Vec3 } from "./topoRef";

/** A picked corner: where it is, and the directions its edges leave it in (unit vectors). */
export interface VertexRef {
  kind: "vertex";
  p: Vec3;
  /** `p` as a share of the part's bounding box on each axis (0 = min side, 1 = max side). */
  rel?: Vec3;
  /** Which way each edge meeting here leaves it (unit vectors, as found when picked). */
  dirs?: Vec3[];
}

/** A picked corner on a particular part. */
export interface VertexPick {
  partId: string;
  ref: VertexRef;
}

/** One end of an edge: where it is and which way the edge leaves it (null when unknown). */
export interface EdgeEnd {
  p: Vec3;
  dir: Vec3 | null;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const dist = (a: Vec3, b: Vec3) => len(sub(a, b));
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A direction made unit length and tidied (null when it has none). */
export function unitDir(v: Vec3): Vec3 | null {
  const l = len(v);
  if (!(l > 1e-12)) return null;
  return v.map((x) => Math.round((x / l) * 1e4) / 1e4) as Vec3;
}

/** Parts with more edges than this (a mesh brought in) have no corners offered or found (the engine and the view agree). */
export const MOST_CORNER_EDGES = 20000;

/** Ends nearer than this (mm) are one corner. */
export const SAME_CORNER = 1e-3;

/**
 * The corners made by edge ends: ends at the same place joined into one corner (with every edge's direction from
 * it), in the order they're first met. `min`/`max` is the part's bounding box.
 */
export function cornersFromEnds(ends: EdgeEnd[], min: Vec3, max: Vec3, tol = SAME_CORNER): VertexRef[] {
  const cell = (x: number) => Math.floor(x / tol);
  const grid = new Map<string, number[]>();
  const groups: { p: Vec3; dirs: Vec3[] }[] = [];
  for (const e of ends) {
    if (!e.p.every(Number.isFinite)) continue;
    const [cx, cy, cz] = e.p.map(cell);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++)
      for (let dy = -1; dy <= 1 && found < 0; dy++)
        for (let dz = -1; dz <= 1 && found < 0; dz++) {
          for (const i of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) if (dist(groups[i].p, e.p) <= tol) found = i;
        }
    if (found < 0) {
      found = groups.length;
      groups.push({ p: e.p, dirs: [] });
      const key = `${cx},${cy},${cz}`;
      grid.set(key, [...(grid.get(key) ?? []), found]);
    }
    const d = e.dir ? unitDir(e.dir) : null;
    if (d && !groups[found].dirs.some((q) => dot(q, d) > 0.9999)) groups[found].dirs.push(d);
  }
  return groups.map((g) => ({ kind: "vertex", p: roundVec(g.p), rel: relativeTo(g.p, min, max), ...(g.dirs.length ? { dirs: g.dirs } : {}) }));
}

/** Two corners' edges leave them about the same ways (each of `want`'s directions is one of `have`'s). */
function sameDirections(want: VertexRef, have: VertexRef): boolean {
  if (!want.dirs?.length || !have.dirs?.length) return true;
  return want.dirs.every((d) => have.dirs!.some((q) => dot(d, q) >= 0.9));
}

/**
 * How different two corners are, in millimetres (roughly how far it would have had to move); Infinity when they
 * can't be the same corner (their edges leave it different ways). With `size` (the part's size), the place as a
 * share of the part's box counts too, so a corner of a box that grows is still the one meant.
 */
export function vertexDistance(want: VertexRef, have: VertexRef, size?: number): number {
  if (!sameDirections(want, have)) return Infinity;
  const d = dist(want.p, have.p);
  if (size && want.rel && have.rel) return Math.min(d, dist(want.rel, have.rel) * size);
  return d;
}

/** Index of the corner in `candidates` at exactly that place (within a micron), or -1. */
export function indexOfVertex(candidates: VertexRef[], ref: VertexRef): number {
  let best = -1;
  let bestD = SAME_CORNER;
  candidates.forEach((c, i) => {
    const d = dist(ref.p, c.p);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/**
 * Find a picked corner again, strictly: the nearest counts only when it's close (within `reach` of the part's
 * size — a tenth unless said — or half a millimetre) and clearly nearer than any other; else null (lost).
 */
export function matchVertex(want: VertexRef, candidates: VertexRef[], size: number, reach = 0.1): number | null {
  let best = -1;
  let bestD = Infinity;
  let second = Infinity;
  candidates.forEach((c, i) => {
    const d = vertexDistance(want, c, size);
    if (d < bestD) {
      second = bestD;
      bestD = d;
      best = i;
    } else if (d < second) second = d;
  });
  if (best < 0 || bestD > Math.max(0.5, reach * size)) return null;
  if (bestD > 1e-3 && second < 1.5 * bestD) return null;
  return best;
}

/** Check untrusted JSON for a picked corner. */
export function parseVertexPick(data: unknown): VertexPick | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const ref = d.ref as Record<string, unknown> | undefined;
  if (typeof d.partId !== "string" || !ref || typeof ref !== "object" || ref.kind !== "vertex") return null;
  const vec = (v: unknown): Vec3 | null =>
    Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? (v as Vec3) : null;
  const p = vec(ref.p);
  if (!p) return null;
  const rel = vec(ref.rel);
  const dirs = Array.isArray(ref.dirs) ? ref.dirs.map(vec).filter((x): x is Vec3 => x !== null) : [];
  return { partId: d.partId, ref: { kind: "vertex", p, ...(rel ? { rel } : {}), ...(dirs.length ? { dirs } : {}) } };
}

/** The part's corners as the 3D view's mesh shows them (from its edges' ends and drawn lines). */
export interface MeshEdges {
  edgeRefs: { curve: string; a: Vec3; b: Vec3 }[];
  edgeGroups: { start: number; count: number }[];
  lines: ArrayLike<number>;
  vertices: ArrayLike<number>;
}

/**
 * A part's corners from its display mesh: each open edge's two ends (closed edges — whole circles — have none), the
 * way it leaves each end taken from its drawn line. Corners on unknown edges are left out.
 */
export function meshCorners(m: MeshEdges): VertexRef[] {
  if (m.edgeRefs.length > MOST_CORNER_EDGES) return [];
  const ends: EdgeEnd[] = [];
  const at = (k: number): Vec3 => [m.lines[3 * k], m.lines[3 * k + 1], m.lines[3 * k + 2]];
  m.edgeRefs.forEach((ref, i) => {
    if (ref.curve === "UNKNOWN" || dist(ref.a, ref.b) <= SAME_CORNER) return;
    const g = m.edgeGroups[i];
    let first: Vec3 | null = null;
    let second: Vec3 | null = null;
    let last: Vec3 | null = null;
    let beforeLast: Vec3 | null = null;
    if (g && g.count >= 2) {
      first = at(g.start);
      second = at(g.start + 1);
      last = at(g.start + g.count - 1);
      beforeLast = at(g.start + g.count - 2);
    }
    // The drawn line may run either way round: each end's direction is from the line's end nearer it.
    const leaving = (p: Vec3): Vec3 | null => {
      if (!first || !second || !last || !beforeLast) return null;
      return dist(first, p) <= dist(last, p) ? sub(second, first) : sub(beforeLast, last);
    };
    ends.push({ p: ref.a, dir: leaving(ref.a) }, { p: ref.b, dir: leaving(ref.b) });
  });
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < m.vertices.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], m.vertices[i + k]);
      max[k] = Math.max(max[k], m.vertices[i + k]);
    }
  if (!Number.isFinite(min[0])) {
    for (const e of ends)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], e.p[k]);
        max[k] = Math.max(max[k], e.p[k]);
      }
  }
  return cornersFromEnds(ends, min, max);
}

/** Cached per mesh object (meshes are replaced, never changed, on a rebuild). */
const cache = new WeakMap<object, VertexRef[]>();

/** `meshCorners`, worked out once per mesh. */
export function cornersOf(m: MeshEdges): VertexRef[] {
  let c = cache.get(m);
  if (!c) {
    c = meshCorners(m);
    cache.set(m, c);
  }
  return c;
}

/** Of `points` (in screen pixels, x/y pairs), the index of the nearest within `reach` pixels of (x, y), or -1. */
export function nearestOnScreen(points: ArrayLike<number>, x: number, y: number, reach: number): number {
  let best = -1;
  let bestD = reach;
  for (let i = 0; 2 * i + 1 < points.length; i++) {
    const d = Math.hypot(points[2 * i] - x, points[2 * i + 1] - y);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** "Corner at (10, 0, 5)", for lists and messages. */
export function describeVertex(ref: VertexRef): string {
  const n = (v: number) => String(Math.round(v * 100) / 100);
  return `Corner at (${ref.p.map(n).join(", ")})`;
}
