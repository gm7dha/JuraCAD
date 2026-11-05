/**
 * A mountain as a 3D printed puzzle (pure, numbers in mm; z up, x east, y north): the ground is cut into columns of
 * cubes. Inside the mountain each layer is a jigsaw — classic round tabs (src/library/puzzle.ts) running the full
 * height of the layer, so the pieces lock side to side — and every piece has pegs on top that fit sockets in the
 * underside of the piece above. Everything goes together by dropping pieces in from above, the way the tabs and
 * pegs both point.
 *
 * Each column ends in a "top" piece: the ground's surface on top, flat sides (its neighbours' tops are different
 * heights, so tabs would stick out into the air), held by the pegs of the cube below. A top piece is never thinner
 * than its sockets need. Pieces on the outside of the puzzle have flat outer faces.
 *
 * Snow: every piece is split at the snow line into a rock part and a snow part, so a multi-colour printer (Bambu AMS)
 * prints the snow in white. The split is moved a little where it would fall right by a socket or peg, so no piece
 * gets a sliver of a different colour.
 *
 * Every mesh is watertight: faces meet the walls corner to corner (src/terrain/triangulate.ts).
 */
import { offsetPolygon } from "../library/outlines";
import { edgePolyline, makePuzzle, narrowestGap, MIN_GAP, NECK, SIZE_SPREAD, TAB_RISE, type Puzzle, type PuzzleEdge } from "../library/puzzle";
import { heightAt, type HeightGrid } from "./elevation";
import { triangulate, type P2 } from "./triangulate";

export interface MountainSpec {
  /** The printer's build volume, mm. */
  bed: [number, number, number];
  /** 1 = the finished puzzle is as big as the bed; 2 = twice as wide (more pieces, printed over several plates). */
  scale: number;
  /** Cube size, mm. */
  cube: number;
  /** Heights × this (mountains look flat at true scale). */
  exaggeration: number;
  /**
   * Solid below the lowest ground, mm. Never less than `baseFor` gives: the lowest ground still stands on one whole
   * layer of jigsaw cubes, so every column is locked to its neighbours.
   */
  base: number;
  /** Height above sea level (m) where the snow starts; null = no snow. */
  snowline: number | null;
  /** Gap between neighbouring pieces, each side, mm (0.15 suits most printers with PLA). */
  fit: number;
  /** Pattern number: which way the tabs point. */
  seed: number;
}

export const MOUNTAIN_DEFAULTS: Omit<MountainSpec, "bed"> = { scale: 1, cube: 30, exaggeration: 1.5, base: 6, snowline: null, fit: 0.15, seed: 1 };

/** A tab's height as a share of the cube (a little bigger than the laser jigsaw's, for strength). */
export const TAB = 0.28;
/** The thinnest a tab's neck may be (mm) after the fit gap is taken off both sides: thinner snaps. */
export const MIN_NECK = 2;
/** Necks thinner than this (mm) work but are fragile: warned about. */
export const GOOD_NECK = 3;
/** Plastic left round a socket or peg, mm. */
export const WALL = 1.2;
/** Points round a peg or socket. */
const ROUND = 24;
/** Points on each arc of a tab. */
const ARC_STEPS = 6;
/** At most this many pieces in one layer (the jigsaw's own limit). */
export const MAX_COLUMNS = 400;

export interface PegSizes {
  /** Peg radius, its height, the chamfer round its top. */
  r: number;
  h: number;
  chamfer: number;
  /** Socket radius (peg + fit) and depth (peg + 0.4 mm). */
  socketR: number;
  depth: number;
}

export function pegSizes(spec: Pick<MountainSpec, "cube" | "fit">): PegSizes {
  const d = Math.min(8, Math.max(3.5, 0.14 * spec.cube));
  const h = Math.min(6, Math.max(3, 0.18 * spec.cube));
  return { r: d / 2, h, chamfer: Math.min(0.6, h / 4, d / 6), socketR: d / 2 + spec.fit, depth: h + 0.4 };
}

/** The narrowest tab neck a cube size gives (mm), with the fit gap taken off both sides. */
export function neckFor(cube: number, fit: number): number {
  const R = ((TAB * cube) / TAB_RISE) * (1 - SIZE_SPREAD);
  return 2 * NECK * R - 2 * fit;
}

/** The smallest cube (mm, rounded up to a whole mm) whose necks are at least `neck` wide. */
export function smallestCube(fit: number, neck = MIN_NECK): number {
  return Math.ceil((neck + 2 * fit) / (2 * NECK * (TAB / TAB_RISE) * (1 - SIZE_SPREAD)));
}

/** The solid under the lowest ground (mm): as asked, but at least one jigsaw layer plus the thinnest top piece. */
export function baseFor(spec: Pick<MountainSpec, "base" | "cube" | "fit">): number {
  return Math.max(spec.base, spec.cube + pegSizes(spec).depth + 3);
}

/** How the ground maps onto the puzzle. */
export interface MountainLayout {
  cols: number;
  rows: number;
  /** mm of puzzle per metre of ground. */
  k: number;
  /** The ground used (metres): the area asked for, trimmed a little to whole cubes, centred. */
  e0: number;
  n0: number;
  width: number;
  height: number;
  /** Lowest and highest ground in it (m). */
  low: number;
  high: number;
}

/** Fit the area to the bed × scale, in whole cubes. */
export function layoutFor(grid: HeightGrid, areaWidth: number, areaHeight: number, spec: MountainSpec): MountainLayout {
  const fitBed = Math.min((spec.bed[0] - 10) / areaWidth, (spec.bed[1] - 10) / areaHeight);
  const target = fitBed * spec.scale;
  const cols = Math.max(1, Math.round((areaWidth * target) / spec.cube));
  const rows = Math.max(1, Math.round((areaHeight * target) / spec.cube));
  const k = Math.min((cols * spec.cube) / areaWidth, (rows * spec.cube) / areaHeight);
  const width = (cols * spec.cube) / k;
  const height = (rows * spec.cube) / k;
  const e0 = grid.e0 + (areaWidth - width) / 2;
  const n0 = grid.n0 + (areaHeight - height) / 2;
  let low = Infinity;
  let high = -Infinity;
  const n = 120;
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      const h = heightAt(grid, e0 + (width * i) / n, n0 + (height * j) / n);
      low = Math.min(low, h);
      high = Math.max(high, h);
    }
  return { cols, rows, k, e0, n0, width, height, low, high };
}

/** What's wrong with the sizes (plain English): `problems` stop it, `warnings` don't. */
export function mountainChecks(spec: MountainSpec, layout?: MountainLayout): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const neck = neckFor(spec.cube, spec.fit);
  const smallest = smallestCube(spec.fit, MIN_NECK);
  const good = smallestCube(spec.fit, GOOD_NECK);
  if (neck < MIN_NECK) problems.push(`Cubes of ${spec.cube} mm are too small: the tabs' necks would be only ${neck.toFixed(1)} mm wide and would snap. Use at least ${smallest} mm.`);
  else if (neck < GOOD_NECK) warnings.push(`The tabs' necks will be ${neck.toFixed(1)} mm wide — they'll work, but handle them gently. ${good} mm cubes or bigger give sturdy necks (${GOOD_NECK} mm).`);
  if (spec.fit < 0 || spec.fit > 0.5) problems.push("The fit gap should be between 0 and 0.5 mm.");
  if (!(spec.exaggeration > 0 && spec.exaggeration <= 5)) problems.push("Height stretch should be between 0.1 and 5.");
  if (!(spec.scale >= 0.2 && spec.scale <= 10)) problems.push("Scale should be between 20% and 1000%.");
  const pegs = pegSizes(spec);
  if (!problems.length && pegs.r * 2 < 4) warnings.push(`The pegs will be ${(pegs.r * 2).toFixed(1)} mm across — small; print them slowly.`);
  if (layout) {
    if (layout.cols * layout.rows > MAX_COLUMNS) problems.push(`That's ${layout.cols} × ${layout.rows} cubes in each layer — at most ${MAX_COLUMNS}. Use bigger cubes or a smaller scale.`);
    const tall = baseFor(spec) + (layout.high - layout.low) * layout.k * spec.exaggeration;
    if (tall > spec.cube * 40) problems.push(`The mountain would be ${Math.round(tall)} mm tall — over 40 layers. Lower the height stretch or use bigger cubes.`);
  }
  return { problems, warnings };
}

// ---------------------------------------------------------------------------------------------------------------
// Meshes

export interface Body {
  part: "rock" | "snow";
  vertices: number[];
  triangles: number[];
}

export interface PuzzlePiece {
  /** "C4-2": column letter, row (from the south), layer (from the bottom). */
  name: string;
  col: number;
  row: number;
  layer: number;
  /** The column's top piece (ground on top, flat sides). */
  top: boolean;
  /** Where its underside sits in the finished puzzle (mm). */
  z0: number;
  /** Its height including pegs (mm), as printed standing on its underside. */
  height: number;
  /** Its footprint (mm, puzzle coordinates). */
  outline: P2[];
  pegs: number;
  sockets: number;
  bodies: Body[];
}

export interface MountainPuzzle {
  spec: MountainSpec;
  layout: MountainLayout;
  pegs: PegSizes;
  /** The snow line in the puzzle (mm), Infinity for none. */
  snowZ: number;
  /** Layers in the tallest column. */
  layers: number;
  pieces: PuzzlePiece[];
  warnings: string[];
  /** The narrowest tab neck used (mm). */
  neck: number;
}

class Mesh {
  v: number[] = [];
  t: number[] = [];
  point(x: number, y: number, z: number): number {
    this.v.push(x, y, z);
    return this.v.length / 3 - 1;
  }
  tri(a: number, b: number, c: number) {
    this.t.push(a, b, c);
  }
  /** A flat face at height z: the outline less the holes, facing up or down. */
  face(outer: P2[], holes: P2[][], z: number, up: boolean) {
    const all = [outer, ...holes].flat();
    const ids = all.map(([x, y]) => this.point(x, y, z));
    for (const [a, b, c] of triangulate(outer, holes)) up ? this.tri(ids[a], ids[b], ids[c]) : this.tri(ids[a], ids[c], ids[b]);
  }
  /**
   * Walls up a closed loop (anticlockwise seen from above) from `lo` to `hi` (each a height per corner, or one for
   * all), facing out — or in, for a hole.
   */
  wall(loop: P2[], lo: number | number[], hi: number | number[], out = true, top?: P2[]) {
    const n = loop.length;
    const zl = (i: number) => (typeof lo === "number" ? lo : lo[i]);
    const zh = (i: number) => (typeof hi === "number" ? hi : hi[i]);
    const upper = top ?? loop;
    const L = loop.map(([x, y], i) => this.point(x, y, zl(i)));
    const H = upper.map(([x, y], i) => this.point(x, y, zh(i)));
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (out) {
        this.tri(L[i], L[j], H[j]);
        this.tri(L[i], H[j], H[i]);
      } else {
        this.tri(L[i], H[j], L[j]);
        this.tri(L[i], H[i], H[j]);
      }
    }
  }
  body(part: "rock" | "snow"): Body {
    return { part, vertices: this.v, triangles: this.t };
  }
}

const circle = (c: P2, r: number, n = ROUND): P2[] => Array.from({ length: n }, (_, i) => [c[0] + r * Math.cos((2 * Math.PI * i) / n), c[1] + r * Math.sin((2 * Math.PI * i) / n)] as P2);

function distanceToOutline(p: P2, poly: P2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const l2 = dx * dx + dy * dy;
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy));
  }
  return best;
}

function inside(p: P2, poly: P2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Where a piece's pegs go: in corners clear of every tab and blank, of the piece below and the one above. */
export function pegPlaces(centre: P2, cube: number, below: P2[], above: P2[], pegs: PegSizes): P2[] {
  const ok = (p: P2) =>
    inside(p, below) && inside(p, above) && distanceToOutline(p, below) >= pegs.r + WALL && distanceToOutline(p, above) >= pegs.socketR + WALL;
  const corners: (P2 | null)[] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sy]) => {
    for (const u of [0.2, 0.18, 0.22, 0.16, 0.24, 0.14, 0.26, 0.12]) {
      const p: P2 = [centre[0] + sx * (0.5 - u) * cube, centre[1] + sy * (0.5 - u) * cube];
      if (ok(p)) return p;
    }
    return null;
  });
  // Two pegs on a diagonal hold the piece square; any two will do; one, or the middle, at a pinch.
  for (const [a, b] of [
    [0, 2],
    [1, 3],
  ])
    if (corners[a] && corners[b]) return [corners[a]!, corners[b]!];
  const found = corners.filter((c): c is P2 => !!c);
  if (found.length) return found.slice(0, 2);
  return ok(centre) ? [centre] : [];
}

/** A layer's jigsaw, with a pattern number whose tabs keep clear of each other. */
function layerPuzzle(cols: number, rows: number, cube: number, fit: number, seed: number): Puzzle {
  const spec = { width: cols * cube, height: rows * cube, rows, columns: cols, tab: TAB, seed, minNeck: MIN_NECK };
  const need = MIN_GAP + 2 * fit;
  let first: Puzzle | null = null;
  for (let s = 0; s < 20; s++) {
    const p = makePuzzle({ ...spec, seed: (seed + s * 7919) % 1000003 });
    first ??= p;
    if (rows * cols < 2 || narrowestGap(p, need) >= need) return p;
  }
  return first!;
}

/** A layer piece's outline with tabs only on the sides `tabbed` allows (bottom, right, top, left), anticlockwise. */
function blockOutline(p: Puzzle, r: number, c: number, tabbed: (side: number) => boolean): P2[] {
  const { rows, columns } = p.spec;
  const line = (e: PuzzleEdge) => edgePolyline(e, ARC_STEPS) as P2[];
  const [x0, y0, x1, y1] = [c * p.pw, r * p.ph, (c + 1) * p.pw, (r + 1) * p.ph];
  const bottom = r > 0 && tabbed(0) ? line(p.across[r - 1][c]) : [[x0, y0], [x1, y0]] as P2[];
  const right = c < columns - 1 && tabbed(1) ? line(p.down[c][r]) : [[x1, y0], [x1, y1]] as P2[];
  const top = r < rows - 1 && tabbed(2) ? line(p.across[r][c]) : [[x0, y1], [x1, y1]] as P2[];
  const left = c > 0 && tabbed(3) ? line(p.down[c - 1][r]) : [[x0, y0], [x0, y1]] as P2[];
  return [...bottom.slice(0, -1), ...right.slice(0, -1), ...[...top].reverse().slice(0, -1), ...[...left].reverse().slice(0, -1)];
}

interface BlockShape {
  outline: P2[];
  z0: number;
  z1: number;
  sockets: P2[];
  pegs: P2[];
  sizes: PegSizes;
}

/** The part of a layer piece between heights lo and hi (both within it), as one closed mesh. */
function blockBody(s: BlockShape, lo: number, hi: number, part: "rock" | "snow"): Body | null {
  const m = new Mesh();
  const { outline: O, z0, z1, sizes: g } = s;
  const sd = z0 + g.depth;
  const holesBelow = s.sockets.map((c) => circle(c, g.socketR));
  const pegBase = s.pegs.map((c) => circle(c, g.r));
  const a = Math.max(lo, z0);
  const b = Math.min(hi, z1);
  if (b > a + 1e-9) {
    m.wall(O, a, b);
    const socketsHere = s.sockets.length > 0 && a < sd;
    // Underside: less the sockets' mouths if they start here.
    m.face(O, socketsHere ? holesBelow : [], a, false);
    if (socketsHere) {
      const top = Math.min(b, sd);
      for (const h of holesBelow) m.wall(h, a, top, false);
      if (sd < b) for (const h of holesBelow) m.face(h, [], sd, false);
    }
    const throughTop = socketsHere && b <= sd;
    const pegsHere = b >= z1 - 1e-9 && hi > z1 + 1e-9 && s.pegs.length > 0;
    m.face(O, [...(throughTop ? holesBelow : []), ...(pegsHere ? pegBase : [])], b, true);
  }
  // Pegs: straight, then a chamfer in to the top.
  const pa = Math.max(lo, z1);
  const pb = Math.min(hi, z1 + g.h);
  if (pb > pa + 1e-9) {
    const zc = z1 + g.h - g.chamfer;
    const rAt = (z: number) => (z <= zc ? g.r : g.r - (z - zc));
    for (const c of s.pegs) {
      const levels = [pa, ...(zc > pa && zc < pb ? [zc] : []), pb];
      for (let i = 0; i + 1 < levels.length; i++)
        m.wall(circle(c, rAt(levels[i])), levels[i], levels[i + 1], true, circle(c, rAt(levels[i + 1])));
      if (pa > z1 + 1e-9) m.face(circle(c, rAt(pa)), [], pa, false);
      m.face(circle(c, rAt(pb)), [], pb, true);
    }
  }
  return m.t.length ? m.body(part) : null;
}

/** A column's top piece: a square from z0 up to the ground, split at `zs` into rock and snow. */
function topBodies(
  square: [number, number, number, number],
  n: number,
  Z: (x: number, y: number) => number,
  z0: number,
  zs: number,
  sockets: P2[],
  g: PegSizes,
): Body[] {
  const [xa, ya, xb, yb] = square;
  const N = n + 1;
  const X = (i: number) => (i === n ? xb : xa + ((xb - xa) * i) / n);
  const Y = (j: number) => (j === n ? yb : ya + ((yb - ya) * j) / n);
  const H = new Float64Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) H[j * N + i] = Z(X(i), Y(j));
  interface V {
    x: number;
    y: number;
    h: number;
  }
  const node = (i: number, j: number): V => ({ x: X(i), y: Y(j), h: H[j * N + i] });
  // Where the snow line crosses between two nodes: worked out once per pair, so both sides use the very same point.
  const crossings = new Map<string, V>();
  const crossing = (a: number, b: number): V => {
    const [p, q] = a < b ? [a, b] : [b, a];
    const key = `${p},${q}`;
    let v = crossings.get(key);
    if (!v) {
      const A = node(p % N, Math.floor(p / N));
      const B = node(q % N, Math.floor(q / N));
      const t = (zs - A.h) / (B.h - A.h);
      v = { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t, h: zs };
      crossings.set(key, v);
    }
    return v;
  };
  const below = (id: number) => H[id] <= zs;
  const vOf = (id: number): V => node(id % N, Math.floor(id / N));

  const rock = new Mesh();
  const snow = new Mesh();
  const fan = (m: Mesh, poly: V[], z: (v: V) => number, up: boolean) => {
    if (poly.length < 3) return;
    const ids = poly.map((v) => m.point(v.x, v.y, z(v)));
    for (let k = 1; k + 1 < ids.length; k++) up ? m.tri(ids[0], ids[k], ids[k + 1]) : m.tri(ids[0], ids[k + 1], ids[k]);
  };
  // The ground, triangle by triangle, cut at the snow line.
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * N + i;
      const b = a + 1;
      const c = a + N + 1;
      const d = a + N;
      for (const tri of [
        [a, b, c],
        [a, c, d],
      ]) {
        const lowPart: V[] = [];
        const highPart: V[] = [];
        for (let k = 0; k < 3; k++) {
          const p = tri[k];
          const q = tri[(k + 1) % 3];
          (below(p) ? lowPart : highPart).push(vOf(p));
          if (below(p) !== below(q)) {
            const x = crossing(p, q);
            lowPart.push(x);
            highPart.push(x);
          }
        }
        fan(rock, lowPart, (v) => v.h, true);
        fan(rock, highPart, () => zs, true);
        fan(snow, highPart, (v) => v.h, true);
        fan(snow, highPart, () => zs, false);
      }
    }
  // Round the edge, anticlockwise, with the snow line's crossings in their places.
  const ring: number[] = [];
  for (let i = 0; i < n; i++) ring.push(i);
  for (let j = 0; j < n; j++) ring.push(j * N + n);
  for (let i = n; i > 0; i--) ring.push(n * N + i);
  for (let j = n; j > 0; j--) ring.push(j * N);
  const edge: V[] = [];
  ring.forEach((id, k) => {
    const next = ring[(k + 1) % ring.length];
    edge.push(vOf(id));
    if (below(id) !== below(next)) edge.push(crossing(id, next));
  });
  const loop = edge.map((v) => [v.x, v.y] as P2);
  rock.wall(
    loop,
    z0,
    edge.map((v) => Math.min(v.h, zs)),
  );
  const holes = sockets.map((c) => circle(c, g.socketR));
  rock.face(loop, holes, z0, false);
  for (const h of holes) {
    rock.wall(h, z0, z0 + g.depth, false);
    rock.face(h, [], z0 + g.depth, false);
  }
  // The snow's own sides: only where the ground is above the snow line.
  const snowIds = edge.map((v) => [snow.point(v.x, v.y, zs), snow.point(v.x, v.y, Math.max(v.h, zs))]);
  for (let k = 0; k < edge.length; k++) {
    const l = (k + 1) % edge.length;
    if (edge[k].h < zs - 1e-12 || edge[l].h < zs - 1e-12) continue;
    snow.tri(snowIds[k][0], snowIds[l][0], snowIds[l][1]);
    snow.tri(snowIds[k][0], snowIds[l][1], snowIds[k][1]);
  }
  const out: Body[] = [rock.body("rock")];
  if (snow.t.length && H.some((h) => h > zs)) out.push(snow.body("snow"));
  return out;
}

const columnName = (c: number): string => (c < 26 ? String.fromCharCode(65 + c) : columnName(Math.floor(c / 26) - 1) + String.fromCharCode(65 + (c % 26)));

/** The whole puzzle from the heights of an area `areaWidth` × `areaHeight` m. Throws if `mountainChecks` has problems. */
export function makeMountainPuzzle(grid: HeightGrid, areaWidth: number, areaHeight: number, spec: MountainSpec): MountainPuzzle {
  const layout = layoutFor(grid, areaWidth, areaHeight, spec);
  const checks = mountainChecks(spec, layout);
  if (checks.problems.length) throw new Error(checks.problems[0]);
  const { cols, rows, k } = layout;
  const cube = spec.cube;
  const fit = spec.fit;
  const g = pegSizes(spec);
  const base = baseFor(spec);
  const zOf = (h: number) => base + (h - layout.low) * k * spec.exaggeration;
  const Z = (x: number, y: number) => zOf(heightAt(grid, layout.e0 + x / k, layout.n0 + y / k));
  const snowZ = spec.snowline === null ? Infinity : zOf(spec.snowline);
  // Samples along each side of a top piece: about one per height-data point, 8 to 48.
  const n = Math.min(48, Math.max(8, Math.ceil(cube / Math.max(0.6, grid.spacing * k))));
  const thinnest = g.depth + 2;

  // How many whole cubes each column has under its top piece.
  const full: number[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      let low = Infinity;
      for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) low = Math.min(low, Z(c * cube + (cube * i) / n, r * cube + (cube * j) / n));
      full.push(Math.max(0, Math.floor((low - 0.5 - thinnest) / cube)));
    }
  const fullAt = (c: number, r: number) => (c < 0 || r < 0 || c >= cols || r >= rows ? 0 : full[r * cols + c]);
  const layers = Math.max(...full) + 1;

  // Each layer's jigsaw, and its pieces' outlines (tabs only between two whole cubes).
  const puzzles: Puzzle[] = [];
  for (let L = 0; L < layers - 1; L++) puzzles.push(layerPuzzle(cols, rows, cube, fit, spec.seed * 31 + L * 977));
  let neck = Infinity;
  const outlineOf = (L: number, c: number, r: number): P2[] => {
    if (L >= fullAt(c, r)) {
      const s: P2[] = [
        [c * cube + fit, r * cube + fit],
        [(c + 1) * cube - fit, r * cube + fit],
        [(c + 1) * cube - fit, (r + 1) * cube - fit],
        [c * cube + fit, (r + 1) * cube - fit],
      ];
      return s;
    }
    const neighbours = [
      [c, r - 1],
      [c + 1, r],
      [c, r + 1],
      [c - 1, r],
    ];
    const p = puzzles[L];
    const tabbed = (side: number) => fullAt(neighbours[side][0], neighbours[side][1]) > L;
    const sides: (PuzzleEdge | undefined)[] = [r > 0 ? p.across[r - 1]?.[c] : undefined, p.down[c]?.[r], p.across[r]?.[c], c > 0 ? p.down[c - 1]?.[r] : undefined];
    sides.forEach((e, side) => {
      if (e && tabbed(side)) neck = Math.min(neck, 2 * NECK * e.R - 2 * fit);
    });
    return offsetPolygon(blockOutline(p, r, c, tabbed), -fit);
  };

  const pieces: PuzzlePiece[] = [];
  const pegsMissing: string[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const f = fullAt(c, r);
      const outlines = Array.from({ length: f + 1 }, (_, L) => outlineOf(L, c, r));
      const centre: P2 = [(c + 0.5) * cube, (r + 0.5) * cube];
      // Pegs between each piece and the one above it.
      const joins = Array.from({ length: f }, (_, L) => pegPlaces(centre, cube, outlines[L], outlines[L + 1], g));
      for (let L = 0; L <= f; L++) {
        const name = `${columnName(c)}${r + 1}-${L + 1}`;
        const sockets = L > 0 ? joins[L - 1] : [];
        if (L > 0 && !sockets.length) pegsMissing.push(name);
        const z0 = L * cube;
        if (L < f) {
          const shape: BlockShape = { outline: outlines[L], z0, z1: z0 + cube, sockets, pegs: joins[L], sizes: g };
          // The snow line, moved clear of the sockets and the very top.
          let cut = snowZ;
          if (cut <= z0 + (sockets.length ? g.depth + 1 : 1)) cut = -Infinity;
          else if (cut >= z0 + cube - 1) cut = Infinity;
          const top = z0 + cube + (joins[L].length ? g.h : 0);
          const bodies =
            cut === -Infinity
              ? [blockBody(shape, z0, top, "snow")]
              : cut === Infinity
                ? [blockBody(shape, z0, top, "rock")]
                : [blockBody(shape, z0, cut, "rock"), blockBody(shape, cut, top, "snow")];
          pieces.push({ name, col: c, row: r, layer: L, top: false, z0, height: top - z0, outline: outlines[L], pegs: joins[L].length, sockets: sockets.length, bodies: bodies.filter((b): b is Body => !!b) });
        } else {
          const sq: [number, number, number, number] = [c * cube + fit, r * cube + fit, (c + 1) * cube - fit, (r + 1) * cube - fit];
          const zs = Math.max(snowZ, z0 + (sockets.length ? g.depth + 1 : 1));
          const bodies = topBodies(sq, n, Z, z0, zs, sockets, g);
          let peak = z0;
          for (const b of bodies) for (let i = 2; i < b.vertices.length; i += 3) peak = Math.max(peak, b.vertices[i]);
          pieces.push({ name, col: c, row: r, layer: L, top: true, z0, height: peak - z0, outline: outlines[L], pegs: 0, sockets: sockets.length, bodies });
        }
      }
    }
  const warnings = [...checks.warnings];
  if (pegsMissing.length) warnings.push(`No room for pegs under ${pegsMissing.length === 1 ? "piece" : "pieces"} ${pegsMissing.slice(0, 6).join(", ")}${pegsMissing.length > 6 ? "…" : ""}: ${pegsMissing.length === 1 ? "it rests" : "they rest"} on the piece below with nothing to hold ${pegsMissing.length === 1 ? "it" : "them"}.`);
  const tallest = Math.max(...pieces.map((p) => p.height));
  if (tallest > spec.bed[2]) warnings.push(`The tallest piece is ${Math.round(tallest)} mm — taller than the printer (${spec.bed[2]} mm). Lower the height stretch.`);
  return { spec, layout, pegs: g, snowZ, layers, pieces, warnings, neck: Number.isFinite(neck) ? neck : neckFor(cube, fit) };
}
