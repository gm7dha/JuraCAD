/**
 * Contour lines of a value sampled on a grid (marching squares), for curves such as an isocline: where a face's
 * slope against a direction is a set angle. Pure: numbers in, polylines out. Also the small helpers they need —
 * whether a (u, v) point is inside a face's outline (even–odd, from its edges' pieces), runs joined end to end in
 * 3D (across a round face's seam), and thinning a polyline before a spline is fitted through it.
 */

export type P2 = [number, number];
export type Vec3 = [number, number, number];

/** Values on a grid of nu × nv points at u(i), v(j); NaN = not on the face (no line goes through that cell). */
export interface ContourGrid {
  nu: number;
  nv: number;
  u: (i: number) => number;
  v: (j: number) => number;
  /** values[i + j * nu] */
  values: Float64Array;
}

/** One contour line in (u, v): its points in order, and whether it comes back round to its first. */
export interface ContourRun {
  points: P2[];
  closed: boolean;
}

/**
 * Where the value is 0, as lines through the grid. `refine` (optional) finds the crossing between two grid points
 * more exactly than a straight-line guess (it's given both ends and their values). Lines stop at cells with a point
 * off the face.
 */
export function contourRuns(g: ContourGrid, refine?: (a: P2, b: P2, fa: number, fb: number) => P2): ContourRun[] {
  const { nu, nv, values } = g;
  const val = (i: number, j: number) => values[i + j * nu];
  const at = (i: number, j: number): P2 => [g.u(i), g.v(j)];
  const points = new Map<string, P2>();
  // A crossing on the grid edge from (i, j) to the next point along u ("h") or along v ("v").
  const crossing = (kind: "h" | "v", i: number, j: number): string => {
    const key = `${kind}${i},${j}`;
    if (!points.has(key)) {
      const a = at(i, j);
      const b = kind === "h" ? at(i + 1, j) : at(i, j + 1);
      const fa = val(i, j);
      const fb = kind === "h" ? val(i + 1, j) : val(i, j + 1);
      const t = fa / (fa - fb);
      points.set(key, refine ? refine(a, b, fa, fb) : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    return key;
  };
  const segments: [string, string][] = [];
  const above = (x: number) => x > 0;
  for (let j = 0; j + 1 < nv; j++) {
    for (let i = 0; i + 1 < nu; i++) {
      const f00 = val(i, j), f10 = val(i + 1, j), f11 = val(i + 1, j + 1), f01 = val(i, j + 1);
      if (!(Number.isFinite(f00) && Number.isFinite(f10) && Number.isFinite(f11) && Number.isFinite(f01))) continue;
      // Round the cell: bottom (h i,j), right (v i+1,j), top (h i,j+1), left (v i,j).
      const sides: (string | null)[] = [
        above(f00) !== above(f10) ? crossing("h", i, j) : null,
        above(f10) !== above(f11) ? crossing("v", i + 1, j) : null,
        above(f01) !== above(f11) ? crossing("h", i, j + 1) : null,
        above(f00) !== above(f01) ? crossing("v", i, j) : null,
      ];
      const hit = sides.filter((s): s is string => s !== null);
      if (hit.length === 2) segments.push([hit[0], hit[1]]);
      else if (hit.length === 4) {
        // A saddle: the middle's value says which corners are joined.
        const mid = (f00 + f10 + f11 + f01) / 4;
        if (above(mid) === above(f00)) {
          segments.push([sides[0]!, sides[1]!], [sides[2]!, sides[3]!]);
        } else {
          segments.push([sides[0]!, sides[3]!], [sides[1]!, sides[2]!]);
        }
      }
    }
  }
  return chainKeys(segments).map((r) => ({ points: r.keys.map((k) => points.get(k)!), closed: r.closed }));
}

/** Segments joined end to end by their ends' keys (each key is met by at most two segments). */
export function chainKeys(segments: [string, string][]): { keys: string[]; closed: boolean }[] {
  const at = new Map<string, number[]>();
  segments.forEach(([a, b], k) => {
    at.set(a, [...(at.get(a) ?? []), k]);
    at.set(b, [...(at.get(b) ?? []), k]);
  });
  const used = new Uint8Array(segments.length);
  const next = (key: string): number | undefined => (at.get(key) ?? []).find((k) => !used[k]);
  const out: { keys: string[]; closed: boolean }[] = [];
  // Open runs first (from an end met by one segment), then loops.
  const starts = [...at.entries()].filter(([, ks]) => ks.length === 1).map(([key]) => key);
  const walk = (from: string) => {
    const keys = [from];
    let cur = from;
    for (;;) {
      const k = next(cur);
      if (k === undefined) break;
      used[k] = 1;
      const [a, b] = segments[k];
      cur = a === cur ? b : a;
      keys.push(cur);
    }
    return keys;
  };
  for (const s of starts) if (next(s) !== undefined) out.push({ keys: walk(s), closed: false });
  segments.forEach(([a], k) => {
    if (used[k]) return;
    const keys = walk(a);
    const closed = keys.length > 2 && keys[keys.length - 1] === keys[0];
    out.push({ keys: closed ? keys.slice(0, -1) : keys, closed });
  });
  return out;
}

/** Whether a point is inside the outline made by these pieces (even–odd: holes count as outside). */
export function insidePieces(p: P2, pieces: readonly [P2, P2][]): boolean {
  let inside = false;
  for (const [a, b] of pieces) {
    if (a[1] > p[1] !== b[1] > p[1]) {
      const x = a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
      if (x > p[0]) inside = !inside;
    }
  }
  return inside;
}

const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Runs joined where their ends meet (within `tol`) — a contour cut at a round face's seam is one line again — and a
 * run whose ends meet is closed.
 */
export function joinRuns(runs: { points: Vec3[]; closed: boolean }[], tol: number): { points: Vec3[]; closed: boolean }[] {
  const open = runs.filter((r) => !r.closed && r.points.length >= 2).map((r) => [...r.points]);
  const done: { points: Vec3[]; closed: boolean }[] = runs.filter((r) => r.closed && r.points.length >= 3).map((r) => ({ points: r.points, closed: true }));
  while (open.length) {
    const run = open.shift()!;
    let grew = true;
    while (grew) {
      grew = false;
      for (let k = 0; k < open.length; k++) {
        const o = open[k];
        const head = run[0];
        const tail = run[run.length - 1];
        if (dist3(tail, o[0]) <= tol) run.push(...o.slice(1));
        else if (dist3(tail, o[o.length - 1]) <= tol) run.push(...[...o].reverse().slice(1));
        else if (dist3(head, o[o.length - 1]) <= tol) run.unshift(...o.slice(0, -1));
        else if (dist3(head, o[0]) <= tol) run.unshift(...[...o].reverse().slice(0, -1));
        else continue;
        open.splice(k, 1);
        grew = true;
        break;
      }
    }
    const closed = run.length > 3 && dist3(run[0], run[run.length - 1]) <= tol;
    done.push({ points: closed ? run.slice(0, -1) : run, closed });
  }
  return done;
}

/** Points closer together than `gap` (along the run) thinned out, and at most `most` kept, evenly by length; the ends stay. */
export function thinRun(points: Vec3[], gap: number, most: number): Vec3[] {
  if (points.length <= 2) return points;
  const lens = [0];
  for (let i = 1; i < points.length; i++) lens.push(lens[i - 1] + dist3(points[i], points[i - 1]));
  const total = lens[lens.length - 1];
  const step = Math.max(gap, total / Math.max(1, most - 1));
  const out: Vec3[] = [points[0]];
  let last = 0;
  for (let i = 1; i < points.length - 1; i++) {
    if (lens[i] - last >= step && total - lens[i] >= step * 0.5) {
      out.push(points[i]);
      last = lens[i];
    }
  }
  out.push(points[points.length - 1]);
  return out;
}
