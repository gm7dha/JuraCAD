/** Matching things up one to one at least cost (pure). */

/**
 * The cheapest way to give each row its own column (the Hungarian method; more rows than columns leaves some rows
 * without one): the column for each row, or −1. Costs at `big` or more are never chosen.
 */
export function assignCheapest(cost: number[][], big: number): number[] {
  const n = cost.length;
  const m = cost[0]?.length ?? 0;
  if (!n || !m) return cost.map(() => -1);
  const size = Math.max(n, m);
  const a = (i: number, j: number) => (i < n && j < m ? Math.min(cost[i][j], big) : big);
  // Kuhn–Munkres with potentials (1-based), on a square matrix padded with `big`.
  const u = new Array(size + 1).fill(0);
  const v = new Array(size + 1).fill(0);
  const p = new Array(size + 1).fill(0);
  const way = new Array(size + 1).fill(0);
  for (let i = 1; i <= size; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(size + 1).fill(Infinity);
    const used = new Array(size + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= size; j++) {
        if (used[j]) continue;
        const cur = a(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= size; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const out = new Array(n).fill(-1);
  for (let j = 1; j <= size; j++) if (p[j] >= 1 && p[j] <= n && j <= m && cost[p[j] - 1][j - 1] < big) out[p[j] - 1] = j - 1;
  return out;
}
