/**
 * An island (or any land) as a flat jigsaw of 3D printed pieces (pure, mm, z up): the coast is the puzzle's edge,
 * pieces are cut along real boundaries (counties, from an OpenStreetMap file) or into irregular pieces of about a chosen
 * size, neighbouring pieces lock together with a dovetail, and each piece's top is the ground, its relief raised.
 *
 * How: the land is drawn on a fine grid (`cell` mm). Each grid cell gets a piece number: sea is −1; land goes to the
 * boundary it's in, or to the nearest of a scatter of seeded points (Voronoi cells). Pieces split by the sea become
 * pieces of their own; pieces too small to pick up join a neighbour. Then a dovetail is painted across each long
 * enough border, into one side or the other. Each piece's outline is traced from a signed distance to its edge (a
 * Euclidean distance transform), `fit` inside its own cells, so neighbours have a gap of 2 × fit; marching squares give a
 * watertight mesh: the ground on top, flat underneath, walls round every edge.
 */
import { heightAt, type HeightGrid } from "./elevation";
import type { Body, PuzzlePiece } from "./mountainPuzzle";

type XY = [number, number];

/** Which land to keep: every island (land running off the area's edge is left out), the biggest only, or all of it. */
export type IslandLand = "islands" | "biggest" | "all";

export interface IslandSpec {
  bed: [number, number, number];
  /** 1 = the puzzle fills the bed. */
  scale: number;
  /** About how big pieces are (mm) when they're cut into cells. */
  piece: number;
  /** Solid under the coast (mm). */
  base: number;
  /** How far the highest ground stands above the coast (mm). */
  relief: number;
  /** Gap each side between pieces (mm). */
  fit: number;
  seed: number;
  /** Height (m) below which it's sea. */
  sea: number;
  land: IslandLand;
}

export const ISLAND_DEFAULTS: Omit<IslandSpec, "bed"> = { scale: 1, piece: 35, base: 3, relief: 8, fit: 0.15, seed: 1, sea: 0.5, land: "islands" };

/** Lines to cut along (boundaries, on the OS grid, metres) and names for the areas between them. */
export interface IslandCuts {
  lines: XY[][];
  names: { text: string; at: XY }[];
}

export interface IslandPiece extends PuzzlePiece {
  /** The area it's from, when cut along boundaries that have names. */
  region?: string;
  area: number;
}

export interface IslandPuzzle {
  width: number;
  height: number;
  /** mm per metre across. */
  k: number;
  /** The highest ground (m). */
  high: number;
  pieces: IslandPiece[];
  /** Cut along the map's boundaries. */
  alongBoundaries: boolean;
  /** Dovetails made, and borders too short or crowded for one. */
  joins: number;
  unjoined: number;
  warnings: string[];
}

/** The smallest piece kept on its own (mm²); smaller ones join a neighbour. */
export const smallestPiece = (piece: number) => Math.max(60, (0.4 * piece) ** 2);

export function islandChecks(spec: IslandSpec): string[] {
  const out: string[] = [];
  if (!(spec.piece >= 15 && spec.piece <= 150)) out.push("Pieces should be between 15 and 150 mm.");
  if (!(spec.base >= 1.5 && spec.base <= 30)) out.push("The base should be between 1.5 and 30 mm.");
  if (!(spec.relief >= 0 && spec.relief <= 150)) out.push("The highest ground should be between 0 and 150 mm above the base.");
  if (!(spec.fit >= 0 && spec.fit <= 0.5)) out.push("The fit gap should be between 0 and 0.5 mm.");
  return out;
}

/** A small seeded random number maker (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Squared distance to the nearest `true` cell (in cells), Felzenszwalb–Huttenlocher, separable. */
export function distanceTransform(mask: Uint8Array, nx: number, ny: number): Float64Array {
  const INF = 1e20;
  const d = new Float64Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) d[i] = mask[i] ? 0 : INF;
  const n = Math.max(nx, ny);
  const f = new Float64Array(n);
  const z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  const out = new Float64Array(n);
  const pass = (len: number, get: (k: number) => number, set: (k: number, x: number) => void) => {
    for (let q = 0; q < len; q++) f[q] = get(q);
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      out[q] = (q - v[k]) ** 2 + f[v[k]];
    }
    for (let q = 0; q < len; q++) set(q, out[q]);
  };
  for (let y = 0; y < ny; y++) pass(nx, (x) => d[y * nx + x], (x, val) => (d[y * nx + x] = val));
  for (let x = 0; x < nx; x++) pass(ny, (y) => d[y * nx + x], (y, val) => (d[y * nx + x] = val));
  return d;
}

const STEPS: XY[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Number each 4-connected stretch of cells where `ok` holds (−1 elsewhere); returns the numbers and how many. */
function stretches(nx: number, ny: number, ok: (c: number) => boolean, same: (a: number, b: number) => boolean = () => true): { id: Int32Array; count: number } {
  const id = new Int32Array(nx * ny).fill(-1);
  let count = 0;
  for (let c0 = 0; c0 < nx * ny; c0++) {
    if (!ok(c0) || id[c0] >= 0) continue;
    const n = count++;
    id[c0] = n;
    const stack = [c0];
    while (stack.length) {
      const c = stack.pop()!;
      const [i, j] = [c % nx, Math.floor(c / nx)];
      for (const [di, dj] of STEPS) {
        const [a, b] = [i + di, j + dj];
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const d = b * nx + a;
        if (id[d] < 0 && ok(d) && same(c0, d)) {
          id[d] = n;
          stack.push(d);
        }
      }
    }
  }
  return { id, count };
}

/** Give unowned land cells (owner −1, land true) the owner of the nearest owned cell, spreading out step by step. */
function spreadOwners(owner: Int32Array, nx: number, ny: number, land: (c: number) => boolean) {
  let frontier: number[] = [];
  for (let c = 0; c < owner.length; c++) if (owner[c] >= 0) frontier.push(c);
  while (frontier.length) {
    const next: number[] = [];
    for (const c of frontier) {
      const [i, j] = [c % nx, Math.floor(c / nx)];
      for (const [di, dj] of STEPS) {
        const [a, b] = [i + di, j + dj];
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const d = b * nx + a;
        if (land(d) && owner[d] < 0) {
          owner[d] = owner[c];
          next.push(d);
        }
      }
    }
    frontier = next;
  }
}

/**
 * The puzzle from heights over an area `areaWidth` × `areaHeight` m whose south-west corner is grid point `sw`. Cut
 * along `cuts`' lines when given (and they divide the land), else into pieces of about `spec.piece` mm.
 */
export function makeIslandPuzzle(grid: HeightGrid, sw: { e: number; n: number }, areaWidth: number, areaHeight: number, spec: IslandSpec, cuts?: IslandCuts): IslandPuzzle {
  const problems = islandChecks(spec);
  if (problems.length) throw new Error(problems[0]);
  const k = Math.min((spec.bed[0] - 10) / areaWidth, (spec.bed[1] - 10) / areaHeight) * spec.scale;
  const W = areaWidth * k;
  const H = areaHeight * k;
  const cell = Math.min(0.6, Math.max(0.25, Math.sqrt((W * H) / 700000)));
  const nx = Math.ceil(W / cell);
  const ny = Math.ceil(H / cell);
  const N = nx * ny;
  const ground = (x: number, y: number) => heightAt(grid, sw.e + x / k, sw.n + y / k);
  const warnings: string[] = [];

  // Land, then only the land asked for.
  const isLand = new Uint8Array(N);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) isLand[j * nx + i] = ground((i + 0.5) * cell, (j + 0.5) * cell) > spec.sea ? 1 : 0;
  const masses = stretches(nx, ny, (c) => isLand[c] === 1);
  if (!masses.count) throw new Error("There's no land in this area — it's all sea.");
  if (spec.land !== "all") {
    const size = new Int32Array(masses.count);
    const edge = new Uint8Array(masses.count);
    for (let c = 0; c < N; c++) {
      const m = masses.id[c];
      if (m < 0) continue;
      size[m]++;
      const [i, j] = [c % nx, Math.floor(c / nx)];
      if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) edge[m] = 1;
    }
    let keep: (m: number) => boolean;
    if (spec.land === "biggest") {
      const big = size.indexOf(Math.max(...size));
      keep = (m) => m === big;
    } else if (edge.some((e, m) => !e && size[m] > 0) ) {
      keep = (m) => !edge[m];
      if (edge.some(Boolean)) warnings.push("Land running off the edge of the area (the mainland, say) is left out.");
    } else {
      keep = () => true;
      warnings.push("All the land runs off the edge of the area, so all of it is used — make the area bigger to take in a whole island.");
    }
    for (let c = 0; c < N; c++) if (isLand[c] && !keep(masses.id[c])) isLand[c] = 0;
  }
  let high = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (isLand[j * nx + i]) high = Math.max(high, ground((i + 0.5) * cell, (j + 0.5) * cell));
  const label = new Int32Array(N).fill(-1);
  for (let c = 0; c < N; c++) if (isLand[c]) label[c] = 0;

  // Who owns each land cell: the area between boundaries it's in, or the nearest of a seeded scatter of points.
  const names: (string | undefined)[] = [];
  let alongBoundaries = false;
  if (cuts?.lines.length) {
    const wall = new Uint8Array(N);
    const mark = (x: number, y: number) => {
      const [i, j] = [Math.floor(x / cell), Math.floor(y / cell)];
      if (i >= 0 && j >= 0 && i < nx && j < ny) wall[j * nx + i] = 1;
    };
    for (const line of cuts.lines)
      for (let n = 0; n + 1 < line.length; n++) {
        const [p, q] = [line[n], line[n + 1]].map(([e, nn]): XY => [(e - sw.e) * k, (nn - sw.n) * k]);
        const steps = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / (cell * 0.5)) + 1;
        for (let s = 0; s <= steps; s++) mark(p[0] + ((q[0] - p[0]) * s) / steps, p[1] + ((q[1] - p[1]) * s) / steps);
      }
    const areas = stretches(nx, ny, (c) => isLand[c] === 1 && !wall[c]);
    // Specks between boundary lines that run close together don't count.
    const size = new Int32Array(areas.count);
    for (let c = 0; c < N; c++) if (areas.id[c] >= 0) size[areas.id[c]]++;
    const owner = new Int32Array(N).fill(-1);
    for (let c = 0; c < N; c++) if (areas.id[c] >= 0 && size[areas.id[c]] * cell * cell >= 4) owner[c] = areas.id[c];
    const real = new Set<number>();
    for (let c = 0; c < N; c++) if (owner[c] >= 0) real.add(owner[c]);
    // They divide the land if there are more areas than separate bits of land.
    const bits = stretches(nx, ny, (c) => isLand[c] === 1);
    const bigBits = new Set<number>();
    for (let c = 0; c < N; c++) if (owner[c] >= 0) bigBits.add(bits.id[c]);
    if (real.size > bigBits.size) {
      alongBoundaries = true;
      spreadOwners(owner, nx, ny, (c) => isLand[c] === 1);
      for (let c = 0; c < N; c++) if (isLand[c]) label[c] = owner[c];
      for (const { text, at } of cuts.names) {
        const [i, j] = [Math.floor(((at[0] - sw.e) * k) / cell), Math.floor(((at[1] - sw.n) * k) / cell)];
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        const a = label[j * nx + i];
        if (a >= 0 && names[a] === undefined) names[a] = text;
      }
    } else warnings.push("The map's boundaries don't divide this land, so it's cut into pieces instead.");
  }
  if (!alongBoundaries) {
    const rnd = seeded(spec.seed * 7919 + 3);
    const P = spec.piece;
    const [cx, cy] = [Math.ceil(W / P) + 1, Math.ceil(H / P) + 1];
    const pts: XY[] = [];
    for (let b = 0; b < cy; b++) for (let a = 0; a < cx; a++) pts.push([(a + 0.15 + 0.7 * rnd()) * P, (b + 0.15 + 0.7 * rnd()) * P]);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (label[c] < 0) continue;
        const [x, y] = [(i + 0.5) * cell, (j + 0.5) * cell];
        const [ga, gb] = [Math.floor(x / P), Math.floor(y / P)];
        let best = 0;
        let bd = Infinity;
        for (let b = gb - 1; b <= gb + 1; b++)
          for (let a = ga - 1; a <= ga + 1; a++) {
            if (a < 0 || b < 0 || a >= cx || b >= cy) continue;
            const p = pts[b * cx + a];
            const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
            if (d < bd) [bd, best] = [d, b * cx + a];
          }
        label[c] = best;
      }
  }

  // Each connected stretch of one label is a piece of its own.
  const piece = new Int32Array(N).fill(-1);
  const pieceRegion: (string | undefined)[] = [];
  let count = 0;
  for (let c0 = 0; c0 < N; c0++) {
    if (label[c0] < 0 || piece[c0] >= 0) continue;
    const id = count++;
    pieceRegion.push(alongBoundaries ? names[label[c0]] : undefined);
    const stack = [c0];
    piece[c0] = id;
    while (stack.length) {
      const c = stack.pop()!;
      const [i, j] = [c % nx, Math.floor(c / nx)];
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const [a, b] = [i + di, j + dj];
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const d = b * nx + a;
        if (piece[d] < 0 && label[d] === label[c0]) {
          piece[d] = id;
          stack.push(d);
        }
      }
    }
  }

  // Pieces too small to handle join the neighbour they share most border with; tiny lone islets are dropped.
  const least = smallestPiece(spec.piece) / (cell * cell);
  let dropped = 0;
  for (let pass = 0; pass < 6; pass++) {
    const size = new Int32Array(count);
    for (let c = 0; c < N; c++) if (piece[c] >= 0) size[piece[c]]++;
    const border = new Map<number, Map<number, number>>();
    for (let c = 0; c < N; c++) {
      const a = piece[c];
      if (a < 0 || size[a] >= least) continue;
      const [i, j] = [c % nx, Math.floor(c / nx)];
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const [x, y] = [i + di, j + dj];
        if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
        const b = piece[y * nx + x];
        if (b < 0 || b === a) continue;
        const m = border.get(a) ?? new Map<number, number>();
        m.set(b, (m.get(b) ?? 0) + 1);
        border.set(a, m);
      }
    }
    const into = new Int32Array(count).map((_, i) => i);
    let changed = false;
    for (let a = 0; a < count; a++) {
      if (!size[a] || size[a] >= least) continue;
      const m = border.get(a);
      if (m?.size) {
        into[a] = [...m.entries()].sort((x, y) => y[1] - x[1])[0][0];
        changed = true;
      } else if (size[a] * cell * cell < 20) {
        into[a] = -1;
        changed = true;
      }
    }
    if (!changed) break;
    const root = (a: number): number => (into[a] === a || into[a] < 0 ? into[a] : root(into[a]));
    for (let c = 0; c < N; c++)
      if (piece[c] >= 0) {
        const r = root(piece[c]);
        if (r < 0) {
          piece[c] = -1;
          dropped++;
        } else piece[c] = r;
      }
  }
  if (dropped) warnings.push("Some specks of land too small to print were left out.");

  // Dovetails across borders long enough for one.
  const P = spec.piece;
  const neck = Math.min(12, Math.max(4, 0.26 * P));
  const head = 1.4 * neck;
  const reach = 0.7 * neck;
  const margin = 1.6 + spec.fit;
  const borders = new Map<string, XY[]>();
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const a = piece[j * nx + i];
      if (a < 0) continue;
      for (const [di, dj] of [[1, 0], [0, 1]]) {
        if (i + di >= nx || j + dj >= ny) continue;
        const b = piece[(j + dj) * nx + i + di];
        if (b < 0 || b === a) continue;
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        const list = borders.get(key) ?? [];
        list.push([(i + 0.5 + di / 2) * cell, (j + 0.5 + dj / 2) * cell]);
        borders.set(key, list);
      }
    }
  // Each piece's box of cells, kept up to date as tabs move cells between pieces.
  const boxes = new Map<number, number[]>();
  for (let c = 0; c < N; c++) {
    const p = piece[c];
    if (p < 0) continue;
    const [i, j] = [c % nx, Math.floor(c / nx)];
    const b = boxes.get(p);
    if (!b) boxes.set(p, [i, j, i, j]);
    else [b[0], b[1], b[2], b[3]] = [Math.min(b[0], i), Math.min(b[1], j), Math.max(b[2], i), Math.max(b[3], j)];
  }
  const rnd = seeded(spec.seed * 31 + 17);
  const at =(x: number, y: number) => {
    const [i, j] = [Math.floor(x / cell), Math.floor(y / cell)];
    return i < 0 || j < 0 || i >= nx || j >= ny ? -1 : piece[j * nx + i];
  };
  let joins = 0;
  let unjoined = 0;
  for (const [key, pts] of borders) {
    if (pts.length * cell < 1.6 * head) {
      unjoined++;
      continue;
    }
    const [a, b] = key.split(",").map(Number);
    const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    // Try spots along the border, nearest its middle first, each way round.
    const spots = [...pts].sort((p, q) => (p[0] - mx) ** 2 + (p[1] - my) ** 2 - ((q[0] - mx) ** 2 + (q[1] - my) ** 2));
    let made = false;
    for (let s = 0; s < spots.length && s < 120 && !made; s += 2) {
      const o = spots[s];
      // The border's direction there: the spread of nearby border points.
      const near = pts.filter((p) => (p[0] - o[0]) ** 2 + (p[1] - o[1]) ** 2 < head * head);
      let [sxx, sxy, syy] = [0, 0, 0];
      for (const p of near) {
        const [dx, dy] = [p[0] - o[0], p[1] - o[1]];
        sxx += dx * dx;
        sxy += dx * dy;
        syy += dy * dy;
      }
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      const t: XY = [Math.cos(ang), Math.sin(ang)];
      const owners = rnd() < 0.5 ? [a, b] : [b, a];
      for (const [from, into] of [owners, [owners[1], owners[0]]]) {
        // Normal pointing into `into`.
        let nrm: XY = [-t[1], t[0]];
        if (at(o[0] + nrm[0] * reach * 0.5, o[1] + nrm[1] * reach * 0.5) !== into) nrm = [-nrm[0], -nrm[1]];
        if (at(o[0] + nrm[0] * reach * 0.5, o[1] + nrm[1] * reach * 0.5) !== into) continue;
        const local = (u: number, v: number): XY => [o[0] + t[0] * u + nrm[0] * v, o[1] + t[1] * u + nrm[1] * v];
        // Every cell the tab covers, and a margin round its head, must be the other piece's; its neck's base meets ours.
        const inTab = (u: number, v: number) => v >= 0 && v <= reach && Math.abs(u) <= neck / 2 + (head - neck) / 2 * (v / reach);
        const ok = (() => {
          const R = head / 2 + margin;
          for (let v = -margin; v <= reach + margin; v += cell / 2)
            for (let u = -R; u <= R; u += cell / 2) {
              const inside = Math.abs(u) <= neck / 2 + ((head - neck) / 2) * (Math.max(0, v) / reach) + margin && v <= reach + margin;
              if (!inside) continue;
              const [x, y] = local(u, v);
              const p = at(x, y);
              if (v > margin * 0.6 && p !== into) return false;
              if (v <= margin * 0.6 && p !== into && p !== from) return false;
            }
          return true;
        })();
        if (!ok) continue;
        // Paint it, then make sure the piece it went into is still one piece.
        const changed: number[] = [];
        const R = Math.ceil((head + reach) / cell) + 2;
        const [ci, cj] = [Math.floor(o[0] / cell), Math.floor(o[1] / cell)];
        for (let j = Math.max(0, cj - R); j <= Math.min(ny - 1, cj + R); j++)
          for (let i = Math.max(0, ci - R); i <= Math.min(nx - 1, ci + R); i++) {
            const c = j * nx + i;
            if (piece[c] !== into) continue;
            const [x, y] = [(i + 0.5) * cell - o[0], (j + 0.5) * cell - o[1]];
            const [u, v] = [x * t[0] + y * t[1], x * nrm[0] + y * nrm[1]];
            if (inTab(u, v)) {
              piece[c] = from;
              changed.push(c);
            }
          }
        if (!changed.length || !wholePiece(piece, nx, ny, into, boxes.get(into)!)) {
          for (const c of changed) piece[c] = into;
          continue;
        }
        const fb = boxes.get(from)!;
        for (const c of changed) {
          const [i, j] = [c % nx, Math.floor(c / nx)];
          [fb[0], fb[1], fb[2], fb[3]] = [Math.min(fb[0], i), Math.min(fb[1], j), Math.max(fb[2], i), Math.max(fb[3], j)];
        }
        made = true;
        break;
      }
    }
    if (made) joins++;
    else unjoined++;
  }

  // Each piece's mesh.
  const lift = spec.relief / Math.max(high, 1);
  const top = (x: number, y: number) => spec.base + Math.max(0, ground(x, y)) * lift;
  const pieces: IslandPiece[] = [];
  const order: { id: number; x: number; y: number; n: number }[] = [];
  const sums = new Map<number, [number, number, number]>();
  for (let c = 0; c < N; c++) {
    const p = piece[c];
    if (p < 0) continue;
    const s = sums.get(p) ?? [0, 0, 0];
    s[0] += c % nx;
    s[1] += Math.floor(c / nx);
    s[2]++;
    sums.set(p, s);
  }
  for (const [id, [sx, sy, n]] of sums) order.push({ id, x: (sx / n + 0.5) * cell, y: (sy / n + 0.5) * cell, n });
  // Numbered from the north-west, row by row.
  order.sort((p, q) => Math.round((q.y - p.y) / P) * 1e6 + (p.x - q.x) || q.y - p.y);
  order.forEach((o, n) => {
    const body = pieceMesh(piece, nx, ny, cell, o.id, spec.fit, top);
    if (!body) return;
    let [x0, y0, x1, y1, z1] = [Infinity, Infinity, -Infinity, -Infinity, 0];
    for (let i = 0; i < body.vertices.length; i += 3) {
      x0 = Math.min(x0, body.vertices[i]);
      x1 = Math.max(x1, body.vertices[i]);
      y0 = Math.min(y0, body.vertices[i + 1]);
      y1 = Math.max(y1, body.vertices[i + 1]);
      z1 = Math.max(z1, body.vertices[i + 2]);
    }
    const region = pieceRegion[o.id];
    pieces.push({
      name: `${n + 1}${region ? ` ${region}` : ""}`,
      col: Math.round(o.x / P),
      row: Math.round(o.y / P),
      layer: 0,
      top: true,
      z0: 0,
      height: z1,
      outline: [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ],
      key: null,
      pocket: null,
      bodies: [body],
      region,
      area: o.n * cell * cell,
    });
  });
  if (unjoined) warnings.push(`${unjoined} ${unjoined === 1 ? "border is" : "borders are"} too short or crowded for a dovetail; those pieces just sit side by side there.`);
  return { width: W, height: H, k, high, pieces, alongBoundaries, joins, unjoined, warnings };
}

/** Is piece `id` (within its box [i0, j0, i1, j1]) still one 4-connected stretch of cells? */
function wholePiece(piece: Int32Array, nx: number, ny: number, id: number, box: number[]): boolean {
  let start = -1;
  let total = 0;
  for (let j = box[1]; j <= box[3]; j++)
    for (let i = box[0]; i <= box[2]; i++)
      if (piece[j * nx + i] === id) {
        total++;
        if (start < 0) start = j * nx + i;
      }
  if (start < 0) return false;
  const seen = new Set<number>([start]);
  const stack = [start];
  let n = 0;
  while (stack.length) {
    const c = stack.pop()!;
    n++;
    const [i, j] = [c % nx, Math.floor(c / nx)];
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const [a, b] = [i + di, j + dj];
      if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
      const d = b * nx + a;
      if (!seen.has(d) && piece[d] === id) {
        seen.add(d);
        stack.push(d);
      }
    }
  }
  return n === total;
}

/**
 * One piece as a closed mesh: its outline `fit` inside its cells (marching squares on the signed distance to its edge,
 * sampled at cell centres), the ground on top (`top(x, y)`), flat at z = 0 underneath, walls round every edge.
 */
export function pieceMesh(piece: Int32Array, nx: number, ny: number, cell: number, id: number, fit: number, top: (x: number, y: number) => number): Body | null {
  // The piece's box, with room round it.
  let [i0, j0, i1, j1] = [nx, ny, -1, -1];
  for (let c = 0; c < piece.length; c++)
    if (piece[c] === id) {
      const [i, j] = [c % nx, Math.floor(c / nx)];
      i0 = Math.min(i0, i);
      j0 = Math.min(j0, j);
      i1 = Math.max(i1, i);
      j1 = Math.max(j1, j);
    }
  if (i1 < 0) return null;
  const pad = 2 + Math.ceil(fit / cell);
  [i0, j0, i1, j1] = [i0 - pad, j0 - pad, i1 + pad, j1 + pad];
  const [w, h] = [i1 - i0 + 1, j1 - j0 + 1];
  const mine = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && piece[j * nx + i] === id;
  const inMask = new Uint8Array(w * h);
  const outMask = new Uint8Array(w * h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const m = mine(i + i0, j + j0);
      inMask[j * w + i] = m ? 1 : 0;
      outMask[j * w + i] = m ? 0 : 1;
    }
  const dIn = distanceTransform(inMask, w, h);
  const dOut = distanceTransform(outMask, w, h);
  // Signed distance (mm) less the fit: > 0 inside the piece's outline. Inside, from the cell's middle to the nearest
  // other cell's middle less half a diagonal: never more than the real distance to its edge, so neighbours never get
  // closer than 2 × fit.
  const f = new Float64Array(w * h);
  for (let c = 0; c < w * h; c++) f[c] = (inMask[c] ? Math.sqrt(dOut[c]) - Math.SQRT1_2 : -(Math.sqrt(dIn[c]) - 0.5)) * cell - fit;
  // The mesh is made on every `step`-th sample: the distance changes smoothly, so its crossings are found as well,
  // with far fewer triangles (the ground's heights are much coarser than the cells anyway).
  const step = Math.max(1, Math.round(0.7 / cell));
  const X = (i: number) => (i * step + i0 + 0.5) * cell;
  const Y = (j: number) => (j * step + j0 + 0.5) * cell;
  const [mw, mh] = [Math.ceil(w / step), Math.ceil(h / step)];

  const v: number[] = [];
  const t: number[] = [];
  const topIds = new Map<string, number>();
  const botIds = new Map<string, number>();
  const vert = (key: string, x: number, y: number, up: boolean) => {
    const m = up ? topIds : botIds;
    let id = m.get(key);
    if (id === undefined) {
      id = v.length / 3;
      v.push(x, y, up ? top(x, y) : 0);
      m.set(key, id);
    }
    return id;
  };
  const val = (i: number, j: number) => (i < 0 || j < 0 || i >= mw || j >= mh ? -1 : f[j * step * w + i * step]);
  for (let j = -1; j < mh; j++)
    for (let i = -1; i < mw; i++) {
      // The square's corners, anticlockwise, and where the outline crosses its sides.
      const cs: [number, number][] = [
        [i, j],
        [i + 1, j],
        [i + 1, j + 1],
        [i, j + 1],
      ];
      const fv = cs.map(([a, b]) => val(a, b));
      const ins = fv.map((x) => x > 0);
      if (!ins.some(Boolean)) continue;
      type Pt = { key: string; x: number; y: number; cross: boolean };
      const corner = (n: number): Pt => ({ key: `n${cs[n][0]},${cs[n][1]}`, x: X(cs[n][0]), y: Y(cs[n][1]), cross: false });
      const crossing = (n: number): Pt => {
        const m = (n + 1) % 4;
        const [a, b] = [cs[n], cs[m]];
        const s = fv[n] / (fv[n] - fv[m]);
        // The same key from either square that shares the side.
        const key = a[0] === b[0] ? `v${a[0]},${Math.min(a[1], b[1])}` : `h${Math.min(a[0], b[0])},${a[1]}`;
        return { key, x: X(a[0]) + (X(b[0]) - X(a[0])) * s, y: Y(a[1]) + (Y(b[1]) - Y(a[1])) * s, cross: true };
      };
      // Each bit of the square inside the outline, its corners anticlockwise (always convex).
      const polys: Pt[][] = [];
      const saddle = ins[0] === ins[2] && ins[1] === ins[3] && ins[0] !== ins[1];
      if (saddle && (fv[0] + fv[1] + fv[2] + fv[3]) / 4 <= 0) {
        for (const n of ins[0] ? [0, 2] : [1, 3]) polys.push([corner(n), crossing(n), crossing((n + 3) % 4)]);
      } else {
        const p: Pt[] = [];
        for (let n = 0; n < 4; n++) {
          if (ins[n]) p.push(corner(n));
          if (ins[n] !== ins[(n + 1) % 4]) p.push(crossing(n));
        }
        polys.push(p);
      }
      for (const p of polys) {
        const T = p.map((q) => vert(q.key, q.x, q.y, true));
        const B = p.map((q) => vert(q.key, q.x, q.y, false));
        for (let n = 1; n + 1 < p.length; n++) {
          t.push(T[0], T[n], T[n + 1]);
          t.push(B[0], B[n + 1], B[n]);
        }
        // An edge between two crossings is the outline: a wall, facing out (the piece is on its left).
        for (let n = 0; n < p.length; n++) {
          const m = (n + 1) % p.length;
          if (p[n].cross && p[m].cross) t.push(B[n], B[m], T[m], B[n], T[m], T[n]);
        }
      }
    }
  return v.length ? { part: "rock", vertices: v, triangles: t } : null;
}
