/**
 * The coast from OpenStreetMap (pure): which cells of a grid are land, from the map's coastline rather than the heights.
 *
 * Why: the height tiles blend the land with coarse sea depths, so a narrow sea passage or the mouth of a sea loch can
 * read as land a few metres high; the loch behind is then closed off and filled in as land (Arran's Lamlash Bay, Jura's
 * Loch Tarbert and Small Isles Bay). The map's coastline knows where the sea is.
 *
 * OpenStreetMap's rule: coastline ways run with the land on their LEFT. Ways are joined end to end into chains; a closed
 * chain lying wholly in the box is an island (or, the other way round, sea inside land); the rest are cut to the box, and
 * each piece is carried on from where it leaves the box round the box's edge, anticlockwise (so the land stays on the
 * left), to where the next piece comes in — the usual way land polygons are built. The rings are then filled on the grid
 * by their winding number (land where it is positive).
 */
import { gridToLatLon, latLonToGrid, type GridPoint, type LatLon } from "./osGrid";

type XY = [number, number];

/** The widest area (m, the longer side) whose coastline is fetched from OpenStreetMap. */
export const COAST_MOST = 130_000;
/** Fetched this far (m) past the area's edges, so every coastline way crossing it comes too. */
const COAST_MARGIN = 2000;

/** The query for the coastline round an area, as an .osm file (read with readOsm: its `coastline`). Null when too big. */
export function coastQuery(sw: GridPoint, width: number, height: number): string | null {
  if (Math.max(width, height) > COAST_MOST) return null;
  const m = COAST_MARGIN;
  const corners = [
    gridToLatLon({ e: sw.e - m, n: sw.n - m }),
    gridToLatLon({ e: sw.e + width + m, n: sw.n - m }),
    gridToLatLon({ e: sw.e - m, n: sw.n + height + m }),
    gridToLatLon({ e: sw.e + width + m, n: sw.n + height + m }),
  ];
  const r = (x: number) => x.toFixed(4);
  const box = [Math.min(...corners.map((c) => c.lat)), Math.min(...corners.map((c) => c.lon)), Math.max(...corners.map((c) => c.lat)), Math.max(...corners.map((c) => c.lon))].map(r).join(",");
  return `[out:xml][timeout:90][maxsize:62914560];way["natural"="coastline"](${box});(._;>;);out qt;`;
}

/** Coastline ways (as the map gives them, land on the left) on the OS grid (m). */
export function coastOnGrid(ways: LatLon[][]): XY[][] {
  return ways.filter((w) => w.length >= 2).map((w) => w.map((p) => {
    const g = latLonToGrid(p);
    return [g.e, g.n] as XY;
  }));
}

const key = (p: XY) => `${p[0]},${p[1]}`;

/** Ways joined end to end (each way's end is the next one's start), in the ways' own direction. */
export function joinCoast(ways: XY[][]): XY[][] {
  const chains = ways.filter((w) => w.length >= 2).map((w) => [...w]);
  const alive = chains.map(() => true);
  const byStart = new Map<string, number[]>();
  chains.forEach((c, i) => {
    const k = key(c[0]);
    byStart.set(k, [...(byStart.get(k) ?? []), i]);
  });
  for (let i = 0; i < chains.length; i++) {
    if (!alive[i]) continue;
    for (;;) {
      const c = chains[i];
      const endKey = key(c[c.length - 1]);
      if (endKey === key(c[0])) break;
      const next = (byStart.get(endKey) ?? []).find((j) => j !== i && alive[j]);
      if (next === undefined) break;
      alive[next] = false;
      chains[i] = [...c, ...chains[next].slice(1)];
    }
  }
  // A chain that was extended forward may still be the continuation of another one processed earlier: join again.
  let out = chains.filter((_, i) => alive[i]);
  for (let round = 0; round < 4; round++) {
    const before = out.length;
    const starts = new Map<string, number>();
    out.forEach((c, i) => {
      if (key(c[0]) !== key(c[c.length - 1])) starts.set(key(c[0]), i);
    });
    const used = out.map(() => false);
    const merged: XY[][] = [];
    for (let i = 0; i < out.length; i++) {
      if (used[i]) continue;
      let c = out[i];
      used[i] = true;
      for (;;) {
        if (key(c[0]) === key(c[c.length - 1])) break;
        const j = starts.get(key(c[c.length - 1]));
        if (j === undefined || used[j]) break;
        used[j] = true;
        c = [...c, ...out[j].slice(1)];
      }
      merged.push(c);
    }
    out = merged;
    if (out.length === before) break;
  }
  return out;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Where a point on the box's edge is, measured anticlockwise round it from the south-west corner. */
function around(b: Box, p: XY): number {
  const [w, h] = [b.x1 - b.x0, b.y1 - b.y0];
  const eps = 1e-6 * Math.max(w, h);
  if (Math.abs(p[1] - b.y0) <= eps) return Math.min(w, Math.max(0, p[0] - b.x0));
  if (Math.abs(p[0] - b.x1) <= eps) return w + Math.min(h, Math.max(0, p[1] - b.y0));
  if (Math.abs(p[1] - b.y1) <= eps) return w + h + Math.min(w, Math.max(0, b.x1 - p[0]));
  return 2 * w + h + Math.min(h, Math.max(0, b.y1 - p[1]));
}

/** The box's corners passed going anticlockwise from `from` for `span` round it (both measured round it), in order. */
function cornersBetween(b: Box, from: number, span: number): XY[] {
  const [w, h] = [b.x1 - b.x0, b.y1 - b.y0];
  const P = 2 * (w + h);
  const marks: [number, XY][] = [
    [w, [b.x1, b.y0]],
    [w + h, [b.x1, b.y1]],
    [2 * w + h, [b.x0, b.y1]],
    [0, [b.x0, b.y0]],
  ];
  const out: [number, XY][] = [];
  for (const [s, c] of marks) {
    let d = (((s - from) % P) + P) % P;
    if (d === 0) d = P;
    if (d < span) out.push([d, c]);
  }
  return out.sort((x, y) => x[0] - y[0]).map(([, c]) => c);
}

const inside = (b: Box, p: XY) => p[0] > b.x0 && p[0] < b.x1 && p[1] > b.y0 && p[1] < b.y1;

/**
 * A chain cut to the box: the stretches inside it, each from where it comes in to where it goes out (on the box's edge).
 * Null when a stretch starts or ends inside the box (the coastline has a gap there).
 */
function clipChain(b: Box, c: XY[]): XY[][] | null {
  const pieces: XY[][] = [];
  let cur: XY[] | null = inside(b, c[0]) ? [c[0]] : null;
  if (cur) return null;
  for (let s = 0; s + 1 < c.length; s++) {
    const [p, q] = [c[s], c[s + 1]];
    // Liang–Barsky.
    const [dx, dy] = [q[0] - p[0], q[1] - p[1]];
    let [t0, t1] = [0, 1];
    let hit = true;
    for (const [pp, qq] of [
      [-dx, p[0] - b.x0],
      [dx, b.x1 - p[0]],
      [-dy, p[1] - b.y0],
      [dy, b.y1 - p[1]],
    ]) {
      if (pp === 0) {
        if (qq < 0) hit = false;
        continue;
      }
      const r = qq / pp;
      if (pp < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
    }
    if (!hit || t0 >= t1) continue;
    const at = (t: number): XY => [p[0] + dx * t, p[1] + dy * t];
    if (!cur) cur = [at(t0)];
    if (t1 < 1) {
      cur.push(at(t1));
      if (cur.length >= 2) pieces.push(cur);
      cur = null;
    } else cur.push(q);
  }
  if (cur) {
    // Ended exactly on the edge counts; inside, it's a gap.
    const last = cur[cur.length - 1];
    if (inside(b, last)) return null;
    if (cur.length >= 2) pieces.push(cur);
  }
  return pieces;
}

/**
 * The land as rings (anticlockwise round land, clockwise round sea inside land) inside the box, from coastline ways.
 * Null when no coastline lies in the box (inland, or open sea) or the coastline has a gap in the box.
 */
export function coastRings(ways: XY[][], b: Box): XY[][] | null {
  const chains = joinCoast(ways);
  const rings: XY[][] = [];
  const pieces: XY[][] = [];
  for (const c of chains) {
    const closed = key(c[0]) === key(c[c.length - 1]);
    if (closed && c.every((p) => inside(b, p))) {
      rings.push(c);
      continue;
    }
    let from = c;
    if (closed) {
      // Start the ring outside the box, so it's cut into stretches cleanly.
      const out = c.findIndex((p) => !inside(b, p));
      from = [...c.slice(out, -1), ...c.slice(0, out + 1)];
    }
    const cut = clipChain(b, from);
    if (!cut) return null;
    pieces.push(...cut);
  }
  if (!rings.length && !pieces.length) return null;
  // Each stretch carried on round the box's edge, anticlockwise, to the next one coming in.
  const ins = pieces.map((p) => around(b, p[0]));
  const outs = pieces.map((p) => around(b, p[p.length - 1]));
  const P = 2 * (b.x1 - b.x0 + b.y1 - b.y0);
  const used = pieces.map(() => false);
  for (let first = 0; first < pieces.length; first++) {
    if (used[first]) continue;
    const ring: XY[] = [];
    let i = first;
    for (let guard = 0; guard <= pieces.length; guard++) {
      used[i] = true;
      ring.push(...pieces[i]);
      // The next stretch to come in, going round from where this one went out (itself included).
      let best = -1;
      let bd = Infinity;
      for (let j = 0; j < pieces.length; j++) {
        if (used[j] && j !== first) continue;
        let d = ins[j] - outs[i];
        if (d < 0) d += P;
        if (d === 0 && j === i && pieces[i].length > 1) d = P;
        if (d < bd) [bd, best] = [d, j];
      }
      if (best < 0) return null;
      ring.push(...cornersBetween(b, outs[i], bd));
      if (best === first) break;
      i = best;
    }
    ring.push(ring[0]);
    rings.push(ring);
  }
  return rings;
}

/**
 * Which cells of a grid are land by the coastline (1 land, 0 sea): cells `cellM` metres across, `nx` × `ny` from `sw`,
 * each judged at its middle. Null when the coastline can't say (see `coastRings`).
 */
export function coastMask(ways: XY[][], sw: GridPoint, cellM: number, nx: number, ny: number): Uint8Array | null {
  const b: Box = { x0: sw.e, y0: sw.n, x1: sw.e + nx * cellM, y1: sw.n + ny * cellM };
  const rings = coastRings(ways, b);
  if (!rings) return null;
  const mask = new Uint8Array(nx * ny);
  // Per row: where edges cross its middle, and which way (up +1, down −1); land where the winding number is positive.
  const rows: [number, number][][] = Array.from({ length: ny }, () => []);
  for (const r of rings)
    for (let s = 0; s + 1 < r.length; s++) {
      const [p, q] = [r[s], r[s + 1]];
      if (p[1] === q[1]) continue;
      const up = q[1] > p[1];
      const [lo, hi] = up ? [p, q] : [q, p];
      // Rows whose middle y lies in [lo.y, hi.y).
      const j0 = Math.max(0, Math.ceil((lo[1] - sw.n) / cellM - 0.5));
      const j1 = Math.min(ny - 1, Math.ceil((hi[1] - sw.n) / cellM - 0.5) - 1);
      for (let j = j0; j <= j1; j++) {
        const y = sw.n + (j + 0.5) * cellM;
        const x = lo[0] + ((y - lo[1]) * (hi[0] - lo[0])) / (hi[1] - lo[1]);
        rows[j].push([x, up ? 1 : -1]);
      }
    }
  for (let j = 0; j < ny; j++) {
    const xs = rows[j].sort((a, z) => a[0] - z[0]);
    // Winding at x = −(sum of signs of crossings at or left of x): the total along a whole row is 0.
    let w = 0;
    let k = 0;
    for (let i = 0; i < nx; i++) {
      const x = sw.e + (i + 0.5) * cellM;
      while (k < xs.length && xs[k][0] <= x) w -= xs[k++][1];
      if (w > 0) mask[j * nx + i] = 1;
    }
  }
  return mask;
}

/** Height (m) above which ground is certainly land, for checking the coastline against the heights. */
const SURE_LAND = 20;

/**
 * Does the coastline agree with the heights? Of the cells the heights put well above the sea, at most a tenth may be
 * sea by the coastline (a coastline the wrong way round, or for somewhere else, would make most of them sea).
 */
export function coastAgrees(mask: Uint8Array, heightOf: (c: number) => number): boolean {
  let high = 0;
  let wet = 0;
  for (let c = 0; c < mask.length; c++)
    if (heightOf(c) > SURE_LAND) {
      high++;
      if (!mask[c]) wet++;
    }
  return high === 0 || wet <= 0.1 * high;
}

/** A height the land left out of a trimmed island is lowered to when the coastline decides the land (see trimmedIsland). */
export const LEFT_OUT = -9999;
/** Ground below this is land left out (blended from `LEFT_OUT`), whatever the coastline says. */
export const LEFT_OUT_BELOW = LEFT_OUT / 2;
