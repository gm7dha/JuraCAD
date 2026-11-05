/**
 * Flat faces into triangles (pure): an outline with holes in it, cut into triangles that use exactly the corners given
 * — none added, none left out — so a face meets the walls round it corner to corner and the mesh stays watertight.
 * Holes are joined to the outline by a cut (as earcut does), then ears are clipped, checking only against corners that
 * turn inwards (the only ones that can lie inside an ear).
 */
export type P2 = [number, number];

const cross = (a: P2, b: P2, c: P2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function area(poly: P2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [p, q] = [poly[i], poly[(i + 1) % poly.length]];
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
}

const same = (a: P2, b: P2) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

/** Is p inside triangle abc (anticlockwise) or on its sides? */
function inTriangle(p: P2, a: P2, b: P2, c: P2, eps: number): boolean {
  return cross(a, b, p) >= -eps && cross(b, c, p) >= -eps && cross(c, a, p) >= -eps;
}

/**
 * Triangles of the region inside `outer` and outside every hole. Points are numbered outer first, then each hole in
 * turn; triangles come back anticlockwise (seen from +z) as triples of those numbers.
 */
export function triangulate(outer: P2[], holes: P2[][] = []): [number, number, number][] {
  const pts: P2[] = [];
  const ring = (poly: P2[], ccw: boolean): number[] => {
    const base = pts.length;
    pts.push(...poly);
    const ids = poly.map((_, i) => base + i);
    return (area(poly) > 0) === ccw ? ids : ids.reverse();
  };
  let list = ring(outer, true);
  const holeRings = holes.map((h) => ring(h, false));
  const scale = Math.max(1, ...outer.map((p) => Math.max(Math.abs(p[0]), Math.abs(p[1]))));
  const eps = 1e-12 * scale * scale;

  // Join each hole (rightmost first) to the outline through a corner it can see.
  holeRings.sort((a, b) => Math.max(...b.map((i) => pts[i][0])) - Math.max(...a.map((i) => pts[i][0])));
  for (const hole of holeRings) {
    let mi = 0;
    for (let k = 1; k < hole.length; k++) if (pts[hole[k]][0] > pts[hole[mi]][0]) mi = k;
    const M = pts[hole[mi]];
    // The nearest outline edge straight to the right of M.
    let bestX = Infinity;
    let at = -1;
    for (let k = 0; k < list.length; k++) {
      const a = pts[list[k]];
      const b = pts[list[(k + 1) % list.length]];
      if ((a[1] - M[1]) * (b[1] - M[1]) > 0 || a[1] === b[1]) continue;
      const x = a[0] + ((M[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
      if (x >= M[0] - 1e-12 && x < bestX) {
        bestX = x;
        at = a[0] > b[0] ? k : (k + 1) % list.length;
      }
    }
    if (at < 0) continue; // a hole outside the outline: ignored
    // A corner of the outline inside the triangle M–(hit)–P would block the view: take the one nearest the ray.
    const P = pts[list[at]];
    const I: P2 = [bestX, M[1]];
    let tan = Infinity;
    const tri = cross(M, I, P) > 0 ? [M, I, P] : [M, P, I];
    // Does a cut from corner k to M leave k into the face (not into a hole, nor behind an earlier cut)?
    const opensTowards = (k: number) => {
      const a = pts[list[(k + list.length - 1) % list.length]];
      const q = pts[list[k]];
      const c = pts[list[(k + 1) % list.length]];
      return cross(a, q, c) < 0 ? cross(a, q, M) >= 0 || cross(q, c, M) >= 0 : cross(a, q, M) >= 0 && cross(q, c, M) >= 0;
    };
    for (let k = 0; k < list.length; k++) {
      const q = pts[list[k]];
      if (k === at || q[0] < M[0] || !inTriangle(q, tri[0] as P2, tri[1] as P2, tri[2] as P2, 0)) continue;
      const prev = pts[list[(k + list.length - 1) % list.length]];
      const next = pts[list[(k + 1) % list.length]];
      if (cross(prev, q, next) > 0 || !opensTowards(k)) continue; // only corners turning inwards can block
      const t = Math.abs(q[1] - M[1]) / Math.max(q[0] - M[0], 1e-12);
      if (t < tan) {
        tan = t;
        at = k;
      }
    }
    // An earlier cut doubles its corners: take the copy the cut to M leaves through.
    if (!opensTowards(at)) {
      const here = pts[list[at]];
      const other = list.findIndex((id, k) => k !== at && same(pts[id], here) && opensTowards(k));
      if (other >= 0) at = other;
    }
    const h = [...hole.slice(mi), ...hole.slice(0, mi), hole[mi]];
    list = [...list.slice(0, at + 1), ...h, ...list.slice(at)];
  }

  // Ear clipping on a linked list.
  const n = list.length;
  const prev = list.map((_, i) => (i + n - 1) % n);
  const next = list.map((_, i) => (i + 1) % n);
  const alive = new Array<boolean>(n).fill(true);
  const P = (i: number) => pts[list[i]];
  const reflex = (i: number) => cross(P(prev[i]), P(i), P(next[i])) <= eps;
  const out: [number, number, number][] = [];
  const isEar = (i: number): boolean => {
    const [a, b, c] = [P(prev[i]), P(i), P(next[i])];
    if (cross(a, b, c) <= eps) return false;
    for (let j = next[next[i]]; j !== prev[i]; j = next[j]) {
      const q = P(j);
      if (same(q, a) || same(q, b) || same(q, c)) continue;
      if (reflex(j) && inTriangle(q, a, b, c, eps)) return false;
    }
    return true;
  };
  let left = n;
  let i = 0;
  let stall = 0;
  while (left > 3) {
    if (isEar(i)) {
      out.push([list[prev[i]], list[i], list[next[i]]]);
      alive[i] = false;
      next[prev[i]] = next[i];
      prev[next[i]] = prev[i];
      left--;
      i = prev[i];
      stall = 0;
      continue;
    }
    i = next[i];
    if (++stall > left) {
      // No ear left: what remains has no area (corners in a line), or rounding has tied it in a knot. Clip the corner
      // that turns outwards most (if any) so every corner is still used.
      let best = -1;
      let most = eps;
      for (let j = i, k = 0; k < left; j = next[j], k++) {
        const c = cross(P(prev[j]), P(j), P(next[j]));
        if (c > most) {
          most = c;
          best = j;
        }
      }
      if (best < 0) break;
      i = best;
      out.push([list[prev[i]], list[i], list[next[i]]]);
      next[prev[i]] = next[i];
      prev[next[i]] = prev[i];
      left--;
      i = prev[i];
      stall = 0;
    }
  }
  if (left === 3 && cross(P(prev[i]), P(i), P(next[i])) > eps) out.push([list[prev[i]], list[i], list[next[i]]]);
  return out;
}
