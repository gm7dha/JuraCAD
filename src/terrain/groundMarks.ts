/**
 * Map features pressed into the printed ground (pure): paths, tracks, roads, rivers and streams as shallow rounded
 * grooves, lochs as flat water a little below their lowest shore (one flat surface each: the land under them built up
 * where it's lower, taken down where it's higher; the callers put each level on a whole print layer), buildings as
 * small raised blocks. Worked out once on a
 * fine grid over the puzzle (mm), then `apply` changes a ground height there — so every piece, the "whole cubes
 * under the top" count and the snow line all see the same ground.
 */
import { GrooveIndex, grooveDepth, type GrooveLine } from "./grooveCut";
import type { MapFeatures, OsmLineKind } from "./osm";

type XY = [number, number];

/** Groove width and depth (mm on the puzzle) for each kind of line (everything from the map, the old way). */
export const GROOVES: Record<OsmLineKind, { width: number; depth: number }> = {
  path: { width: 1.0, depth: 0.5 },
  track: { width: 1.3, depth: 0.5 },
  road: { width: 1.8, depth: 0.6 },
  stream: { width: 1.0, depth: 0.6 },
  river: { width: 1.6, depth: 0.8 },
};
/**
 * Tidy marks (hill routes, trunk roads: `thin` lines) are one neat line: 0.6 mm wide (one and a half nozzle widths on a
 * 0.4 mm nozzle), 0.4 mm (two layers) deep. Paths, tracks and roads (thin or not) are channels with a flat bottom out to
 * `THIN_FLAT` of the half-width and straight walls, cut exactly into the pieces' tops (grooveCut.ts); rivers and streams
 * keep their rounded grooves on the grid.
 */
export const THIN_GROOVE = { width: 0.6, depth: 0.4 };
export const THIN_FLAT = 2 / 3;
/** A line's groove: its own kind's, or the thin one for a tidy mark. */
export const grooveOf = (l: { kind: OsmLineKind; thin?: true }) => (l.thin ? THIN_GROOVE : GROOVES[l.kind]);

/** How deep a thin groove is `r` mm from its middle. */
export function thinDepth(r: number): number {
  const hw = THIN_GROOVE.width / 2;
  return grooveDepth(r, hw, hw * THIN_FLAT, THIN_GROOVE.depth);
}

/** Lines cut exactly as channels: footpaths, tracks and roads. */
export const isChannel = (l: { kind: OsmLineKind }) => l.kind === "path" || l.kind === "track" || l.kind === "road";
/** How far water sits below the lowest of its shore (mm). */
export const WATER_DROP = 0.5;
/**
 * The print layer heights water levels are put on (mm): the first layer and every layer after it (Bambu's usual 0.2 mm
 * profiles). A loch's flat top then lies on a whole layer as the piece is printed.
 */
export const PRINT_LAYER = 0.2;

/** The print layers loch levels go on (from the colour panel); missing: `PRINT_LAYER` throughout. */
export interface PrintLayers {
  layer: number;
  /** The first layer's height, when it isn't `layer`. */
  first?: number;
}

/**
 * What a puzzle window adds to its spec for lochs: the colour panel's layers, only when printing in colour with water on
 * the map and layers other than the usual 0.2 mm (so nothing else rebuilds when the layer height changes, and the usual
 * spec stays as it was).
 */
export function lochLayers(colourOn: boolean, colour: { layer: number; firstLayer?: number }, features: MapFeatures): { printLayer?: PrintLayers } {
  if (!colourOn || !features.shapes.some((s) => s.kind === "water")) return {};
  const first = colour.firstLayer ?? colour.layer;
  if (Math.abs(colour.layer - PRINT_LAYER) < 1e-9 && Math.abs(first - PRINT_LAYER) < 1e-9) return {};
  return { printLayer: first === colour.layer ? { layer: colour.layer } : { layer: colour.layer, first } };
}

/** `z` moved onto the nearest print layer boundary of a piece standing on `z0` (never onto the bed itself). */
export function onPrintLayer(z: number, z0: number, layer = PRINT_LAYER, first = layer): number {
  const h = z - z0;
  return z0 + (h < first ? first : first + Math.round((h - first) / layer) * layer);
}
/** Buildings stand this high (mm), and at least this big across, so they print. */
export const BUILDING_HEIGHT = 0.8;
export const BUILDING_LEAST = 1.2;

export interface GroundMarks {
  /** The ground height (mm) at x, y in the puzzle, given the plain ground's height z there. */
  apply(x: number, y: number, z: number): number;
  /** Nothing to change. */
  empty: boolean;
  /**
   * The map's water inside the land (missing: none): every point inside a loch's outline is EXACTLY its level — the
   * ground under it built up where it's lower and taken down where it's higher, so each loch is one flat surface. `snap`
   * moves each level (from the one worked out from its shore) once its print layers are known: `onLayer(level, x, y)`, x, y
   * a point inside that loch.
   */
  water?: WaterLevels;
  /**
   * The paths', tracks' and roads' channels (missing: none): meshes are made with `base` (everything else) and then
   * cut along them (`cutGrooves`), so `apply` = `base` less their depth.
   */
  channels?: GrooveIndex;
  base?: GroundMarks;
}

export interface WaterLevels {
  /** Each loch's level now (mm). */
  levels: Float64Array;
  /** The loch at x, y (an index into `levels`), or −1. */
  at(x: number, y: number): number;
  snap(onLayer: (level: number, x: number, y: number) => number): void;
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
  // Each grid point's loch (−1: none), and each loch's level as worked out from its shore.
  const lochOf = new Int32Array(nx * ny).fill(-1);
  const waterRaw: number[] = [];
  const raise = new Float32Array(nx * ny);
  const at = ([e, n]: XY): XY => [(e - e0) * k, (n - n0) * k];
  const onPuzzle = ([x, y]: XY, m: number) => x >= -m && y >= -m && x <= width + m && y <= height + m;

  // Paths, tracks and roads: exact channels, cut into the meshes later.
  const channelLines: GrooveLine[] = [];
  for (const line of f.lines) {
    if (isChannel(line)) {
      const pts = line.pts.map(at);
      if (!pts.some((p) => onPuzzle(p, 50)) && !pts.some((p, i) => i > 0 && crossesBox(pts[i - 1], p, width, height))) continue;
      const { width: w, depth } = grooveOf(line);
      channelLines.push({ kind: line.kind, pts, hw: w / 2, flat: (w / 2) * THIN_FLAT, depth });
      continue;
    }
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
          const d = depth * (0.5 + 0.5 * Math.cos((Math.PI * r) / hw));
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
      // The lowest of its shore — every ring (islands in it too), looked at about every grid cell along each side.
      for (const ring of rings)
        for (let i = 0; i < ring.length; i++) {
          const [p, q] = [ring[i], ring[(i + 1) % ring.length]];
          const steps = Math.min(400, Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / cell)));
          for (let s = 0; s < steps; s++) {
            const pt: XY = [p[0] + ((q[0] - p[0]) * s) / steps, p[1] + ((q[1] - p[1]) * s) / steps];
            if (onPuzzle(pt, 0)) level = Math.min(level, groundZ(pt[0], pt[1]));
          }
        }
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
    if (shape.kind === "water") {
      const w = waterRaw.length;
      waterRaw.push(level);
      fillRings(rings, cell, nx, ny, (c) => {
        // Where two lochs overlap, the lower one.
        if (lochOf[c] < 0 || waterRaw[lochOf[c]] > level) lochOf[c] = w;
      });
    } else fillRings(rings, cell, nx, ny, (c) => (raise[c] = BUILDING_HEIGHT));
  }
  const lochAt = (x: number, y: number) => lochOf[Math.max(0, Math.min(ny - 1, Math.round(y / cell))) * nx + Math.max(0, Math.min(nx - 1, Math.round(x / cell)))];
  // A point inside each loch, for its print layers: the cell of it nearest the middle of its cells.
  const levels = Float64Array.from(waterRaw);
  const anchors: XY[] = [];
  if (waterRaw.length) {
    const sums = waterRaw.map(() => [0, 0, 0]);
    for (let c = 0; c < lochOf.length; c++) if (lochOf[c] >= 0) {
      const s = sums[lochOf[c]];
      s[0] += c % nx;
      s[1] += Math.floor(c / nx);
      s[2]++;
    }
    const best = waterRaw.map(() => [Infinity, 0, 0]);
    for (let c = 0; c < lochOf.length; c++) if (lochOf[c] >= 0) {
      const w = lochOf[c];
      const [i, j] = [c % nx, Math.floor(c / nx)];
      const d = (i - sums[w][0] / sums[w][2]) ** 2 + (j - sums[w][1] / sums[w][2]) ** 2;
      if (d < best[w][0]) best[w] = [d, i * cell, j * cell];
    }
    for (const b of best) anchors.push([b[1], b[2]]);
  }
  const water: WaterLevels | undefined = waterRaw.length
    ? {
        levels,
        at: (x, y) => lochAt(x, y),
        snap(onLayer) {
          waterRaw.forEach((l, w) => (levels[w] = onLayer(l, anchors[w][0], anchors[w][1])));
        },
      }
    : undefined;

  const read = (a: Float32Array, x: number, y: number): number => {
    const fx = Math.max(0, Math.min(nx - 1.000001, x / cell));
    const fy = Math.max(0, Math.min(ny - 1.000001, y / cell));
    const [i, j] = [Math.floor(fx), Math.floor(fy)];
    const [u, v] = [fx - i, fy - j];
    const c = j * nx + i;
    return (a[c] * (1 - u) + a[c + 1] * u) * (1 - v) + (a[c + nx] * (1 - u) + a[c + nx + 1] * u) * v;
  };
  const nearest = (a: Float32Array, x: number, y: number) => a[Math.max(0, Math.min(ny - 1, Math.round(y / cell))) * nx + Math.max(0, Math.min(nx - 1, Math.round(x / cell)))];
  // Inside a loch the ground is its level, flat: no grooves, channels or buildings in the water.
  const plainLines = channelLines.length < f.lines.length;
  const base: GroundMarks = !plainLines && !f.shapes.length
    ? PLAIN_GROUND
    : {
        empty: false,
        ...(water ? { water } : {}),
        apply(x, y, z) {
          if (water) {
            const w = lochAt(x, y);
            if (w >= 0) return levels[w];
          }
          const lift = nearest(raise, x, y);
          return z - read(groove, x, y) + lift;
        },
      };
  if (!channelLines.length) return base;
  const channels = new GrooveIndex(channelLines);
  if (channels.empty) return base;
  return {
    empty: false,
    channels,
    base,
    ...(water ? { water } : {}),
    apply(x, y, z) {
      if (water) {
        const w = lochAt(x, y);
        if (w >= 0) return levels[w];
      }
      const lift = nearest(raise, x, y);
      return z - Math.max(read(groove, x, y), channels.depthAt(x, y)) + lift;
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
