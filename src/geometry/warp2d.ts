/**
 * Bending a flat outline so chosen points of it land on given places (a loft's guide curves, several at once).
 * Pure 2D maths:
 * - one point: a plain move;
 * - two: the affine map closest to "no change" (a stretch and shear along the line between the two points, and a
 *   move) that takes both exactly where they must go;
 * - three or more: a thin-plate spline (the smoothest bend through every point; with three it is exactly an affine map).
 */
export type P2 = [number, number];

export interface Warp {
  map: (p: P2) => P2;
  /** Straight lines stay straight (one or two points). */
  affine: boolean;
}

const tps = (r2: number) => (r2 < 1e-24 ? 0 : 0.5 * r2 * Math.log(r2)); // r² log r, from r²

/** Solves A x = b (small, dense) by Gaussian elimination with partial pivoting; null when singular. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      if (k) for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** The bend taking each `from` point to its `to` point (as gently as can be). */
export function fitWarp(from: P2[], to: P2[]): Warp {
  const k = from.length;
  if (k === 0) return { map: (p) => p, affine: true };
  if (k === 1) {
    const dx = to[0][0] - from[0][0];
    const dy = to[0][1] - from[0][1];
    return { map: ([x, y]) => [x + dx, y + dy], affine: true };
  }
  if (k === 2) {
    // (A − I) = Δ eᵀ / |e|² is the smallest change of shape with (A − I) e = Δ, where e joins the two points.
    const e: P2 = [from[1][0] - from[0][0], from[1][1] - from[0][1]];
    const d0: P2 = [to[0][0] - from[0][0], to[0][1] - from[0][1]];
    const d1: P2 = [to[1][0] - from[1][0], to[1][1] - from[1][1]];
    const D: P2 = [d1[0] - d0[0], d1[1] - d0[1]];
    const ee = e[0] * e[0] + e[1] * e[1];
    if (ee < 1e-18) return fitWarp([from[0]], [to[0]]);
    const m = [
      [(D[0] * e[0]) / ee, (D[0] * e[1]) / ee],
      [(D[1] * e[0]) / ee, (D[1] * e[1]) / ee],
    ];
    const bx = d0[0] - (m[0][0] * from[0][0] + m[0][1] * from[0][1]);
    const by = d0[1] - (m[1][0] * from[0][0] + m[1][1] * from[0][1]);
    return { map: ([x, y]) => [x + m[0][0] * x + m[0][1] * y + bx, y + m[1][0] * x + m[1][1] * y + by], affine: true };
  }
  // Thin-plate spline: f(p) = a0 + a1 x + a2 y + Σ w_i U(|p − p_i|), Σ w = Σ w x = Σ w y = 0.
  const n = k + 3;
  const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) A[i][j] = tps((from[i][0] - from[j][0]) ** 2 + (from[i][1] - from[j][1]) ** 2);
    A[i][k] = A[k][i] = 1;
    A[i][k + 1] = A[k + 1][i] = from[i][0];
    A[i][k + 2] = A[k + 2][i] = from[i][1];
  }
  const sx = solveLinear(A, [...to.map((t) => t[0]), 0, 0, 0]);
  const sy = solveLinear(A, [...to.map((t) => t[1]), 0, 0, 0]);
  if (!sx || !sy) throw new Error("The guide curves pass through the same place (or all lie on one line) there, so the shape can't be bent to them.");
  const exactlyAffine = k === 3 || [...sx.slice(0, k), ...sy.slice(0, k)].every((w) => Math.abs(w) < 1e-12);
  return {
    map: ([x, y]) => {
      let fx = sx[k] + sx[k + 1] * x + sx[k + 2] * y;
      let fy = sy[k] + sy[k + 1] * x + sy[k + 2] * y;
      for (let i = 0; i < k; i++) {
        const u = tps((x - from[i][0]) ** 2 + (y - from[i][1]) ** 2);
        fx += sx[i] * u;
        fy += sy[i] * u;
      }
      return [fx, fy];
    },
    affine: exactlyAffine,
  };
}

/**
 * Where a ray from `centre` towards `target` leaves a closed outline (points in order): the crossing nearest the target.
 * Null when the ray misses (the centre outside an odd outline).
 */
export function rayHit(outline: P2[], centre: P2, target: P2): P2 | null {
  const d: P2 = [target[0] - centre[0], target[1] - centre[1]];
  const dl = Math.hypot(d[0], d[1]);
  if (dl < 1e-12) return null;
  let best: P2 | null = null;
  let bestGap = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    const e: P2 = [b[0] - a[0], b[1] - a[1]];
    const den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) < 1e-15) continue;
    const w: P2 = [a[0] - centre[0], a[1] - centre[1]];
    const s = (w[0] * e[1] - w[1] * e[0]) / den;
    const t = (w[0] * d[1] - w[1] * d[0]) / den;
    if (s <= 0 || t < -1e-9 || t > 1 + 1e-9) continue;
    const gap = Math.abs(s * dl - dl);
    if (gap < bestGap) {
      bestGap = gap;
      best = [centre[0] + d[0] * s, centre[1] + d[1] * s];
    }
  }
  return best;
}

/**
 * Do the targets go round the centre in a different order from the points they pull (guides crossing over each other)?
 * Two points: the line between them turned round.
 */
export function crossedOver(from: P2[], to: P2[], centre: P2): boolean {
  const k = from.length;
  if (k < 2) return false;
  if (k === 2) return (from[1][0] - from[0][0]) * (to[1][0] - to[0][0]) + (from[1][1] - from[0][1]) * (to[1][1] - to[0][1]) <= 0;
  const angle = (p: P2) => Math.atan2(p[1] - centre[1], p[0] - centre[0]);
  const order = (ps: P2[]) => ps.map((p, i) => ({ i, a: angle(p) })).sort((x, y) => x.a - y.a).map((x) => x.i);
  const a = order(from);
  const b = order(to);
  const at = b.indexOf(a[0]);
  return a.some((v, j) => b[(at + j) % k] !== v);
}
