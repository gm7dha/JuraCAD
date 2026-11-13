/**
 * Map features pressed into the printed ground (pure): paths, tracks, roads, rivers and streams as shallow rounded
 * grooves, lochs as flat water a little below their shore, buildings as small raised blocks. Worked out once on a
 * fine grid over the puzzle (mm), then `apply` changes a ground height there — so every piece, the "whole cubes
 * under the top" count and the snow line all see the same ground.
 */
import type { MapFeatures, OsmLineKind } from "./osm";

type XY = [number, number];

/**
 * Groove width and depth (mm on the puzzle) for each kind of line. Paths, tracks and roads are thin, shallow lines —
 * about one and a half nozzle widths on a 0.4 mm nozzle, a layer and a half deep — so they read as a neat line.
 */
export const GROOVES: Record<OsmLineKind, { width: number; depth: number }> = {
  path: { width: 0.6, depth: 0.3 },
  track: { width: 0.6, depth: 0.3 },
  road: { width: 0.6, depth: 0.3 },
  stream: { width: 1.0, depth: 0.6 },
  river: { width: 1.6, depth: 0.8 },
};
/** Lines narrower than this (mm) are flat-bottomed in the middle. */
export const THIN_LINE = 1;
/** How far water sits below the lowest of its shore (mm). */
export const WATER_DROP = 0.5;
/** Buildings stand this high (mm), and at least this big across, so they print. */
export const BUILDING_HEIGHT = 0.8;
export const BUILDING_LEAST = 1.2;

export interface GroundMarks {
  /** The ground height (mm) at x, y in the puzzle, given the plain ground's height z there. */
  apply(x: number, y: number, z: number): number;
  /** Nothing to change. */
  empty: boolean;
}

export const PLAIN_GROUND: GroundMarks = { apply: (_x, _y, z) => z, empty: true };

/**
 * Marks for features on the OS grid (metres), for a puzzle `width` × `height` mm whose (0, 0) is grid point (e0, n0)
 * at `k` mm per metre. `groundZ(x, y)` is the plain ground's height in the puzzle (mm), for water levels.
 */
export function groundMarks(f: MapFeatures, e0: number, n0: number, k: number, width: number, height: number, groundZ: (x: number, y: number) => number): GroundMarks {
  if (!f.lines.length && !f.shapes.length) return PLAIN_GROUND;
  const cell = Math.max(0.25, Math.sqrt((width * height) / 2e6));
  const nx = Math.ceil(width / cell) + 1;
  const ny = Math.ceil(height / cell) + 1;
  const groove = new Float32Array(nx * ny);
  const cap = new Float32Array(nx * ny).fill(Infinity);
  const raise = new Float32Array(nx * ny);
  const at = ([e, n]: XY): XY => [(e - e0) * k, (n - n0) * k];
  const onPuzzle = ([x, y]: XY, m: number) => x >= -m && y >= -m && x <= width + m && y <= height + m;

  for (const line of f.lines) {
    const { width: w, depth } = GROOVES[line.kind];
    const hw = w / 2;
    const pts = line.pts.map(at);
    for (let s = 0; s + 1 < pts.length; s++) {
      const [a, b] = [pts[s], pts[s + 1]];
      if (!onPuzzle(a, 50) && !onPuzzle(b, 50) && !crossesBox(a, b, width, height)) continue;
      const [i0, i1] = [Math.max(0, Math.floor((Math.min(a[0], b[0]) - hw) / cell)), Math.min(nx - 1, Math.ceil((Math.max(a[0], b[0]) + hw) / cell))];
      const [j0, j1] = [Math.max(0, Math.floor((Math.min(a[1], b[1]) - hw) / cell)), Math.min(ny - 1, Math.ceil((Math.max(a[1], b[1]) + hw) / cell))];
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const L2 = dx * dx + dy * dy;
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const [x, y] = [i * cell, j * cell];
          const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)) : 0;
          const r = Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
          if (r >= hw) continue;
          // Thin lines keep their full depth over the middle half, so a coarse mesh still finds the groove.
          const d = w < THIN_LINE ? (r <= hw / 2 ? depth : depth * (0.5 + 0.5 * Math.cos((Math.PI * (2 * r - hw)) / hw))) : depth * (0.5 + 0.5 * Math.cos((Math.PI * r) / hw));
          const c = j * nx + i;
          if (d > groove[c]) groove[c] = d;
        }
    }
  }

  for (const shape of f.shapes) {
    let rings = shape.rings.map((r) => r.map(at));
    if (!rings[0].some((p) => onPuzzle(p, 0)) && !rings[0].some((p, i) => crossesBox(p, rings[0][(i + 1) % rings[0].length], width, height))) continue;
    let level = Infinity;
    if (shape.kind === "water") {
      for (const [x, y] of rings[0]) if (onPuzzle([x, y], 0)) level = Math.min(level, groundZ(x, y));
      if (!Number.isFinite(level)) continue;
      level -= WATER_DROP;
    } else {
      // Small buildings are drawn at least BUILDING_LEAST across, so they print.
      const xs = rings[0].map((p) => p[0]);
      const ys = rings[0].map((p) => p[1]);
      const [cx, cy] = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
      const h = BUILDING_LEAST / 2;
      if (Math.max(...xs) - Math.min(...xs) < BUILDING_LEAST && Math.max(...ys) - Math.min(...ys) < BUILDING_LEAST)
        rings = [
          [
            [cx - h, cy - h],
            [cx + h, cy - h],
            [cx + h, cy + h],
            [cx - h, cy + h],
          ],
        ];
    }
    fillRings(rings, cell, nx, ny, (c) => {
      if (shape.kind === "water") cap[c] = Math.min(cap[c], level);
      else raise[c] = BUILDING_HEIGHT;
    });
  }

  const read = (a: Float32Array, x: number, y: number): number => {
    const fx = Math.max(0, Math.min(nx - 1.000001, x / cell));
    const fy = Math.max(0, Math.min(ny - 1.000001, y / cell));
    const [i, j] = [Math.floor(fx), Math.floor(fy)];
    const [u, v] = [fx - i, fy - j];
    const c = j * nx + i;
    return (a[c] * (1 - u) + a[c + 1] * u) * (1 - v) + (a[c + nx] * (1 - u) + a[c + nx + 1] * u) * v;
  };
  const nearest = (a: Float32Array, x: number, y: number) => a[Math.max(0, Math.min(ny - 1, Math.round(y / cell))) * nx + Math.max(0, Math.min(nx - 1, Math.round(x / cell)))];
  return {
    empty: false,
    apply(x, y, z) {
      const top = Math.min(z, nearest(cap, x, y));
      const lift = nearest(raise, x, y);
      return top - read(groove, x, y) + (lift && top === z ? lift : 0);
    },
  };
}

function crossesBox(a: XY, b: XY, w: number, h: number): boolean {
  return Math.max(a[0], b[0]) >= 0 && Math.min(a[0], b[0]) <= w && Math.max(a[1], b[1]) >= 0 && Math.min(a[1], b[1]) <= h;
}

/** Every grid point (i·cell, j·cell) inside the rings (even–odd). */
function fillRings(rings: XY[][], cell: number, nx: number, ny: number, set: (c: number) => void) {
  const ys = rings.flat().map((p) => p[1]);
  const j0 = Math.max(0, Math.ceil(Math.min(...ys) / cell));
  const j1 = Math.min(ny - 1, Math.floor(Math.max(...ys) / cell));
  for (let j = j0; j <= j1; j++) {
    const y = j * cell;
    const xs: number[] = [];
    for (const ring of rings)
      for (let i = 0; i < ring.length; i++) {
        const [p, q] = [ring[i], ring[(i + 1) % ring.length]];
        if (p[1] > y !== q[1] > y) xs.push(p[0] + ((q[0] - p[0]) * (y - p[1])) / (q[1] - p[1]));
      }
    xs.sort((u, v) => u - v);
    for (let m = 0; m + 1 < xs.length; m += 2) {
      const i0 = Math.max(0, Math.ceil(xs[m] / cell));
      const i1 = Math.min(nx - 1, Math.floor(xs[m + 1] / cell));
      for (let i = i0; i <= i1; i++) set(j * nx + i);
    }
  }
}
