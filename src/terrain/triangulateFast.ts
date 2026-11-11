/**
 * `triangulate` (triangulate.ts) with its ear test looking only at corners near the ear (a grid), for the big flat caps
 * colour bands need — the same ears, so the same triangles, but in about linear time. Kept apart so the puzzles'
 * own meshes (and their files) stay byte for byte as they were.
 */
type P2 = [number, number];

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

function inTriangle(p: P2, a: P2, b: P2, c: P2, eps: number): boolean {
  return cross(a, b, p) >= -eps && cross(b, c, p) >= -eps && cross(c, a, p) >= -eps;
}

export function triangulateFast(outer: P2[], holes: P2[][] = []): [number, number, number][] {
  const pts: P2[] = [];
  const ring = (poly: P2[], ccw: boolean): number[] => {
    const base = pts.length;
    pts.push(...poly);
    const ids = poly.map((_, i) => base + i);
    return (area(poly) > 0) === ccw ? ids : ids.reverse();
  };
  let list = ring(outer, true);
  const holeRings = holes.map((h) => ring(h, false));
  const scale = outer.reduce((m, p) => Math.max(m, Math.abs(p[0]), Math.abs(p[1])), 1);
  const eps = 1e-12 * scale * scale;

  // Join each hole (rightmost first) to the outline through a corner it can see.
  const rightmost = new Map<number[], number>();
  for (const h of holeRings) rightmost.set(h, h.reduce((m, i) => Math.max(m, pts[i][0]), -Infinity));
  holeRings.sort((a, b) => rightmost.get(b)! - rightmost.get(a)!);
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

  // Ear clipping on a linked list; corners found through a grid, so big outlines stay quick.
  const n = list.length;
  const prev = list.map((_, i) => (i + n - 1) % n);
  const next = list.map((_, i) => (i + 1) % n);
  const alive = new Array<boolean>(n).fill(true);
  const P = (i: number) => pts[list[i]];
  const reflex = (i: number) => cross(P(prev[i]), P(i), P(next[i])) <= eps;
  const out: [number, number, number][] = [];
  let [gx0, gy0, gx1, gy1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const [x, y] = P(i);
    [gx0, gy0, gx1, gy1] = [Math.min(gx0, x), Math.min(gy0, y), Math.max(gx1, x), Math.max(gy1, y)];
  }
  const side = Math.max(1, Math.ceil(Math.sqrt(n)));
  const cw = Math.max((gx1 - gx0) / side, (gy1 - gy0) / side, 1e-9);
  const gw = Math.floor((gx1 - gx0) / cw) + 1;
  const gh = Math.floor((gy1 - gy0) / cw) + 1;
  const cells: number[][] = Array.from({ length: gw * gh }, () => []);
  const cx = (x: number) => Math.min(gw - 1, Math.max(0, Math.floor((x - gx0) / cw)));
  const cy = (y: number) => Math.min(gh - 1, Math.max(0, Math.floor((y - gy0) / cw)));
  for (let i = 0; i < n; i++) cells[cy(P(i)[1]) * gw + cx(P(i)[0])].push(i);
  const isEar = (i: number): boolean => {
    const [a, b, c] = [P(prev[i]), P(i), P(next[i])];
    if (cross(a, b, c) <= eps) return false;
    const [x0, x1] = [cx(Math.min(a[0], b[0], c[0])), cx(Math.max(a[0], b[0], c[0]))];
    const [y0, y1] = [cy(Math.min(a[1], b[1], c[1])), cy(Math.max(a[1], b[1], c[1]))];
    for (let gy = y0; gy <= y1; gy++)
      for (let gx = x0; gx <= x1; gx++)
        for (const j of cells[gy * gw + gx]) {
          if (!alive[j] || j === i || j === prev[i] || j === next[i]) continue;
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
      alive[i] = false;
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
