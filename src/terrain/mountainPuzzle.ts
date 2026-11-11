/**
 * A mountain as a 3D printed puzzle (pure, numbers in mm; z up, x east, y north): the ground is cut into columns of
 * cubes. Inside the mountain each layer is a jigsaw — chunky dovetail tabs (`dovetail`) running the full
 * height of the layer, so the pieces lock side to side — and every piece has a key on top (a low, wide square pad
 * with sloping sides) that fits a matching pocket in the underside of the piece above. Everything goes together by
 * dropping pieces in from above, the way the tabs and keys both point; the slopes steer each piece into place and let
 * it lift straight out, and there's nothing thin to snap.
 *
 * The bottom layer is a thin jigsaw plate rather than a full cube, so there's only a little plain side (`base`, 10 mm
 * by default) under the lowest ground; the layers above it are full cubes.
 *
 * Each column ends in a "top" piece: the ground's surface on top, flat sides (its neighbours' tops are different
 * heights, so tabs would stick out into the air), held by the key of the cube below. A top piece is never thinner
 * than its pocket needs. Pieces on the outside of the puzzle have flat outer faces.
 *
 * Snow: every piece is split at the snow line into a rock part and a snow part, so a multi-colour printer (Bambu AMS)
 * prints the snow in white. The split is moved a little where it would fall right by a pocket or key, so no piece
 * gets a sliver of a different colour.
 *
 * Every mesh is watertight: faces meet the walls corner to corner (src/terrain/triangulate.ts).
 */
import { insideGap, offsetPolygon } from "../library/outlines";
import { heightAt, type HeightGrid } from "./elevation";
import { groundMarks } from "./groundMarks";
import { NO_FEATURES, type MapFeatures } from "./osm";
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
   * Plain side under the lowest ground, mm. The bottom layer is a jigsaw plate this less the thinnest top piece (and a
   * little room) thick, so every column is still locked to its neighbours. Never less than `baseFor` gives.
   */
  base: number;
  /** Height above sea level (m) where the snow starts; null = no snow. */
  snowline: number | null;
  /** Gap between neighbouring pieces, each side, mm (0.15 suits most printers with PLA). */
  fit: number;
  /** Pattern number: which way the tabs point. */
  seed: number;
}

export const MOUNTAIN_DEFAULTS: Omit<MountainSpec, "bed"> = { scale: 1, cube: 30, exaggeration: 1.5, base: 10, snowline: null, fit: 0.15, seed: 1 };

/**
 * The tabs are chunky dovetails with rounded corners. Each join is one of `DOVE_SHAPES` (shares of the side): pointing
 * either way, a narrow or wide head, shallow or deep, and a narrow one set left, centre or right — 16 in all, each
 * differing from the others by well over the fit gap, so a piece only goes in properly where its own neighbours are
 * (`uniqueBlocks` makes sure no two pieces match, however they're turned). The neck is the head less `DOVE_LOCK` each
 * side (the lock). Every shape stays clear of the tabs on the sides next to it: a head starts at least `DOVE_CLEAR` in
 * from the corner, and no tab reaches further in than that.
 */
export const DOVE_HEADS = [0.38, 0.46];
export const DOVE_DEPTHS = [0.15, 0.21];
export const DOVE_OFFSETS = [-0.04, 0, 0.04];
export const DOVE_LOCK = 0.06;
export const DOVE_CLEAR = 0.27;
const DOVE_ROUND = 0.03;
/** One join's shape: which way (+1/−1, as `dovetail`'s sign), head and depth (indices), offset along the side (index). */
export interface DoveShape {
  sign: number;
  head: number;
  depth: number;
  offset: number;
}
/** Every allowed shape (a wide head only in the middle, so it keeps clear of the corners). */
export const DOVE_SHAPES: DoveShape[] = [];
for (const sign of [1, -1])
  for (let head = 0; head < DOVE_HEADS.length; head++)
    for (let depth = 0; depth < DOVE_DEPTHS.length; depth++)
      for (let offset = 0; offset < DOVE_OFFSETS.length; offset++)
        if (0.5 - Math.abs(DOVE_OFFSETS[offset]) - DOVE_HEADS[head] / 2 >= DOVE_CLEAR - 1e-9) DOVE_SHAPES.push({ sign, head, depth, offset });
/** The narrowest neck as a share of the side. */
const NARROWEST = Math.min(...DOVE_HEADS) - 2 * DOVE_LOCK;
/** The thinnest a tab's neck may be (mm) after the fit gap is taken off both sides: thinner snaps. */
export const MIN_NECK = 3;
/** Necks thinner than this (mm) work but are fragile: warned about. */
export const GOOD_NECK = 5;
/** Plastic left round a key or its pocket, mm. */
export const WALL = 1.2;
/** Points on each rounded corner of a tab. */
const ROUND_STEPS = 5;
/** At most this many pieces in one layer (the jigsaw's own limit). */
export const MAX_COLUMNS = 400;

/**
 * The locating key: a square pad with rounded corners and sloping sides on top of each cube, and a matching pocket
 * under the piece above (the fit gap bigger all round, 0.4 mm deeper, the same slope).
 */
export interface KeySizes {
  /** Height of the pad. */
  h: number;
  /** How far each side slopes in from its foot to its top (mm): about 31° from upright. */
  slope: number;
  /** Gap all round the key in its pocket (the puzzle's fit). */
  fit: number;
  /** Pocket depth. */
  depth: number;
  /** The biggest and smallest half-width tried for the key's foot. */
  most: number;
  least: number;
}

export function keySizes(spec: Pick<MountainSpec, "cube" | "fit">): KeySizes {
  const h = Math.min(3, Math.max(1.8, 0.07 * spec.cube));
  return { h, slope: 0.6 * h, fit: spec.fit, depth: h + 0.4, most: Math.min(9, 0.22 * spec.cube), least: 0.6 * h + 1 };
}

/** Which corner a key's cut-off corner is, for each of the four: [corner sign x, y, cut's start and end directions]. */
const CORNERS: [number, number, number, P2, P2][] = [
  [1, -1, -90, [-1, 0], [0, 1]],
  [1, 1, 0, [0, -1], [-1, 0]],
  [-1, 1, 90, [1, 0], [0, -1]],
  [-1, -1, 180, [0, 1], [1, 0]],
];
/** How much of a side the cut-off corner takes off, as a share of the half-width. */
export const CUT = 0.55;

/**
 * A key's foot (or its pocket's mouth): a square of half-width `half` with rounded corners, anticlockwise — and one
 * corner (`cut`, 0–3; −1 for none) cut off square across, so it only goes in one way round. Always the same number of
 * corners, so the sloping sides join level to level.
 */
export function keyLoop(c: P2, half: number, corner: number, cut = -1): P2[] {
  const r = Math.min(corner, half * 0.45);
  const k = half - r;
  const out: P2[] = [];
  CORNERS.forEach(([sx, sy, a0, from, to], q) => {
    if (q === cut) {
      const ch = CUT * half;
      const P: P2 = [c[0] + sx * half, c[1] + sy * half];
      for (let i = 0; i <= 4; i++) {
        const t = i / 4;
        out.push([P[0] + ch * ((1 - t) * from[0] + t * to[0]), P[1] + ch * ((1 - t) * from[1] + t * to[1])]);
      }
      return;
    }
    for (let i = 0; i <= 4; i++) {
      const a = ((a0 + (90 * i) / 4) * Math.PI) / 180;
      out.push([c[0] + sx * k + r * Math.cos(a), c[1] + sy * k + r * Math.sin(a)]);
    }
  });
  return out;
}

/** Where a key sits, how big its foot is (half-width, mm) and which corner is cut off (its code with the place). */
export interface Key {
  c: P2;
  half: number;
  cut: number;
}

/** How far a key may be moved off its spot to make its code (mm): far more than the fit, so a wrong one won't go in. */
export const CODE_STEP = 1;
/** The codes: a move of −1, 0 or +1 steps each way, and which corner is cut off — 36 in all. */
export const KEY_CODES: { dx: number; dy: number; cut: number }[] = [];
for (const cut of [0, 1, 2, 3]) for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1]) KEY_CODES.push({ dx, dy, cut });

/** The narrowest tab neck a cube size gives (mm), with the fit gap taken off both sides. */
export function neckFor(cube: number, fit: number): number {
  return NARROWEST * cube - 2 * fit;
}

/** The smallest cube (mm, rounded up to a whole mm) whose necks are at least `neck` wide. */
export function smallestCube(fit: number, neck = MIN_NECK): number {
  return Math.ceil((neck + 2 * fit) / NARROWEST);
}

/** The bottom jigsaw plate is never thinner than this (mm). */
export const PLATE_MIN = 3;
/** Room between the plate's top and the thinnest top piece's underside (mm), for grooves and water from a map. */
const HEADROOM = 1.5;
/** The thinnest a top piece is (mm): its pocket and 2 mm over it. */
const thinnestTop = (spec: Pick<MountainSpec, "cube" | "fit">) => keySizes(spec).depth + 2;

/** The plain side under the lowest ground (mm): as asked, but room for the bottom plate and the thinnest top piece. */
export function baseFor(spec: Pick<MountainSpec, "base" | "cube" | "fit">): number {
  return Math.max(spec.base, PLATE_MIN + thinnestTop(spec) + HEADROOM);
}

/** How thick the bottom jigsaw plate is (mm). */
export function plateFor(spec: Pick<MountainSpec, "base" | "cube" | "fit">): number {
  return baseFor(spec) - thinnestTop(spec) - HEADROOM;
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
  /** Its height including its key (mm), as printed standing on its underside. */
  height: number;
  /** Its footprint (mm, puzzle coordinates). */
  outline: P2[];
  /** The key on top of it and the pocket under it (null where there's none). */
  key: Key | null;
  pocket: Key | null;
  bodies: Body[];
  /** Dovetails holding it to pieces beside it at its own level, and how many such pieces there are (Mountain puzzle). */
  joints?: number;
  neighbours?: number;
}

export interface MountainPuzzle {
  spec: MountainSpec;
  layout: MountainLayout;
  keys: KeySizes;
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

function inside(p: P2, poly: P2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/**
 * The key between a piece and the one above: as big as fits inside both outlines — clear of every tab and blank by
 * `WALL` — up to `most`, in the middle if it fits there, else nudged towards whichever corner has room; null if not
 * even `least` fits anywhere.
 */
export function keyPlace(centre: P2, below: P2[], above: P2[], g: KeySizes, cube = 30): Key | null {
  // A square of half-width h round c stays clear of an outline by `room` if every side of the outline keeps at least
  // h + room from c in the "square" (largest of x and y) sense: so the biggest key at c comes straight from that.
  const squareRoom = (c: P2, outline: P2[]) => {
    let best = Infinity;
    for (let i = 0; i < outline.length; i++) {
      const [a, b] = [outline[i], outline[(i + 1) % outline.length]];
      const [ax, ay, dx, dy] = [a[0] - c[0], a[1] - c[1], b[0] - a[0], b[1] - a[1]];
      // max(|x|, |y|) along the side is smallest at an end or where |x| = |y|.
      const ts = [0, 1];
      if (Math.abs(dx - dy) > 1e-12) ts.push((ay - ax) / (dx - dy));
      if (Math.abs(dx + dy) > 1e-12) ts.push(-(ax + ay) / (dx + dy));
      for (const t of ts) if (t >= 0 && t <= 1) best = Math.min(best, Math.max(Math.abs(ax + t * dx), Math.abs(ay + t * dy)));
    }
    return best;
  };
  const biggest = (c: P2) => (inside(c, below) && inside(c, above) ? Math.min(squareRoom(c, below) - WALL, squareRoom(c, above) - WALL - g.fit, g.most) : -Infinity);
  // In the middle if it fits there; else nudged towards whichever corner leaves room for a bigger key.
  let best: Key | null = null;
  const consider = (c: P2) => {
    const half = Math.floor(biggest(c) * 10) / 10;
    if (half >= g.least && (!best || half > best.half + 0.5)) best = { c, half, cut: -1 };
  };
  consider(centre);
  for (const d of [0.04, 0.08, 0.12, 0.16])
    for (const [sx, sy] of [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ])
      consider([centre[0] + sx * d * cube, centre[1] + sy * d * cube]);
  return best;
}

/** Each join's shape in a layer: `across[r][c]` between rows r and r + 1, `down[c][r]` between columns c and c + 1. */
interface LayerJoins {
  across: DoveShape[][];
  down: DoveShape[][];
}

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

function layerJoins(cols: number, rows: number, rnd: () => number): LayerJoins {
  const pick = () => DOVE_SHAPES[Math.floor(rnd() * DOVE_SHAPES.length)];
  return {
    across: Array.from({ length: Math.max(0, rows - 1) }, () => Array.from({ length: cols }, pick)),
    down: Array.from({ length: Math.max(0, cols - 1) }, () => Array.from({ length: rows }, pick)),
  };
}

/** A dovetail from a to b in `shape`: its head to the left of a→b (sign +1) or right (−1), corners rounded. */
export function dovetail(a: P2, b: P2, shape: DoveShape): P2[] {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const u: P2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  const n: P2 = [-u[1] * shape.sign, u[0] * shape.sign];
  const at = (t: number, d: number): P2 => [a[0] + u[0] * t * L + n[0] * d * L, a[1] + u[1] * t * L + n[1] * d * L];
  const hh = DOVE_HEADS[shape.head] / 2;
  const nh = hh - DOVE_LOCK;
  const depth = DOVE_DEPTHS[shape.depth];
  const mid = 0.5 + DOVE_OFFSETS[shape.offset];
  const corners: [number, number][] = [
    [mid - nh, 0],
    [mid - hh, depth],
    [mid + hh, depth],
    [mid + nh, 0],
  ];
  const pts: P2[] = [a];
  const path: [number, number][] = [[0, 0], ...corners, [1, 0]];
  for (let i = 1; i <= corners.length; i++) {
    // Round each corner: a curve from a little before it to a little after, pulled towards the corner.
    const [p, c, q] = [path[i - 1], path[i], path[i + 1]];
    const lead = (from: [number, number]) => {
      const d = Math.hypot(from[0] - c[0], from[1] - c[1]);
      const k = Math.min(DOVE_ROUND, d / 2) / d;
      return [c[0] + (from[0] - c[0]) * k, c[1] + (from[1] - c[1]) * k] as [number, number];
    };
    const [s0, s1] = [lead(p), lead(q)];
    for (let j = 0; j <= ROUND_STEPS; j++) {
      const t = j / ROUND_STEPS;
      const x = (1 - t) ** 2 * s0[0] + 2 * (1 - t) * t * c[0] + t * t * s1[0];
      const y = (1 - t) ** 2 * s0[1] + 2 * (1 - t) * t * c[1] + t * t * s1[1];
      pts.push(at(x, y));
    }
  }
  pts.push(b);
  return pts;
}

/**
 * A side as its own piece sees it, walking round anticlockwise: "flat", or out/in + head + depth + offset (offsets
 * flipped on the top and left sides, which the piece walks the other way). Two pieces with the same four sides in the
 * same turn could swap places.
 */
function sideCode(shape: DoveShape | null, side: number): string {
  if (!shape) return "flat";
  const reversed = side >= 2;
  const out = reversed ? shape.sign > 0 : shape.sign < 0;
  const offset = reversed ? DOVE_OFFSETS.length - 1 - shape.offset : shape.offset;
  return `${out ? "tab" : "hole"}${shape.head}${shape.depth}${offset}`;
}

/**
 * Change joins until no two pieces of the same height have the same four sides, however either is turned (so a piece
 * only fits properly in its own place). `blocks` gives each piece's joins (null = a flat side); returns how many
 * pieces still match another — only ones with fewer than two tabs (a cube with a single neighbour at its level has
 * just one tab, and only 16 shapes to choose from); their keys still tell them apart.
 */
function uniqueBlocks(blocks: { height: number; sides: () => (DoveShape | null)[]; reroll: (rnd: () => number) => void }[], rnd: () => number): number {
  const signature = (b: (typeof blocks)[number]) => b.sides().map(sideCode);
  let left = 0;
  for (let pass = 0; pass < 200; pass++) {
    const seen = new Map<string, number>();
    const clashing = new Set<number>();
    blocks.forEach((b, i) => {
      const sig = signature(b);
      // Every turn of this piece: the same shape turned is the same piece.
      const turns = [0, 1, 2, 3].map((k) => `${b.height.toFixed(3)}|${[...sig.slice(k), ...sig.slice(0, k)].join(",")}`);
      const key = [...turns].sort()[0];
      const other = seen.get(key);
      if (other !== undefined) {
        clashing.add(i);
        clashing.add(other);
      } else seen.set(key, i);
      // A piece that looks the same turned can go in turned: that's fine (it's the same place), so nothing to do.
    });
    left = clashing.size;
    if (!left) return 0;
    // Pieces with two or more tabs can always be made different; change one of their joins at random.
    const fixable = [...clashing].filter((i) => blocks[i].sides().filter(Boolean).length >= 2);
    if (!fixable.length && pass > 40) break;
    for (const i of clashing) if (rnd() < 0.5) blocks[i].reroll(rnd);
  }
  return left;
}

/** A layer piece's outline with tabs only on the sides `tabbed` allows (bottom, right, top, left), anticlockwise. */
function blockOutline(j: LayerJoins, cols: number, rows: number, cube: number, r: number, c: number, tabbed: (side: number) => boolean): P2[] {
  const [x0, y0, x1, y1] = [c * cube, r * cube, (c + 1) * cube, (r + 1) * cube];
  const bottom = r > 0 && tabbed(0) ? dovetail([x0, y0], [x1, y0], j.across[r - 1][c]) : ([[x0, y0], [x1, y0]] as P2[]);
  const right = c < cols - 1 && tabbed(1) ? dovetail([x1, y0], [x1, y1], j.down[c][r]) : ([[x1, y0], [x1, y1]] as P2[]);
  const top = r < rows - 1 && tabbed(2) ? dovetail([x0, y1], [x1, y1], j.across[r][c]) : ([[x0, y1], [x1, y1]] as P2[]);
  const left = c > 0 && tabbed(3) ? dovetail([x0, y0], [x0, y1], j.down[c - 1][r]) : ([[x0, y0], [x0, y1]] as P2[]);
  return [...bottom.slice(0, -1), ...right.slice(0, -1), ...[...top].reverse().slice(0, -1), ...[...left].reverse().slice(0, -1)];
}

interface BlockShape {
  outline: P2[];
  z0: number;
  z1: number;
  /** The pocket in its underside (for the key of the piece below) and the key on its top. */
  pocket: Key | null;
  key: Key | null;
  sizes: KeySizes;
}

/** The key's outline at height `up` above its foot (its sides slope in). */
function keyAt(k: Key, g: KeySizes, up: number): P2[] {
  const inset = (g.slope * up) / g.h;
  return keyLoop(k.c, k.half - inset, Math.max(0.5, 2 - inset), k.cut);
}

/** The pocket's outline at height `up` above its mouth: the key's shape, the fit gap bigger all round. */
function pocketAt(k: Key, g: KeySizes, up: number): P2[] {
  const inset = (g.slope * up) / g.h;
  return keyLoop(k.c, k.half + g.fit - inset, Math.max(0.5, 2 + g.fit - inset), k.cut);
}

/** The part of a layer piece between heights lo and hi (both within it), as one closed mesh. */
function blockBody(s: BlockShape, lo: number, hi: number, part: "rock" | "snow"): Body | null {
  const m = new Mesh();
  const { outline: O, z0, z1, sizes: g } = s;
  const pd = z0 + g.depth;
  const a = Math.max(lo, z0);
  const b = Math.min(hi, z1);
  if (b > a + 1e-9) {
    m.wall(O, a, b);
    const pocketHere = !!s.pocket && a < pd;
    // Underside: less the pocket's mouth if it starts here.
    m.face(O, pocketHere ? [pocketAt(s.pocket!, g, a - z0)] : [], a, false);
    if (pocketHere) {
      const top = Math.min(b, pd);
      m.wall(pocketAt(s.pocket!, g, a - z0), a, top, false, pocketAt(s.pocket!, g, top - z0));
      // The very same sum as the walls' tops (pd − z0, not g.depth), so they meet exactly.
      if (pd < b) m.face(pocketAt(s.pocket!, g, pd - z0), [], pd, false);
    }
    const throughTop = pocketHere && b <= pd;
    const keyHere = b >= z1 - 1e-9 && hi > z1 + 1e-9 && !!s.key;
    m.face(O, [...(throughTop ? [pocketAt(s.pocket!, g, b - z0)] : []), ...(keyHere ? [keyAt(s.key!, g, 0)] : [])], b, true);
  }
  // The key: its sides slope in to a flat top.
  const ka = Math.max(lo, z1);
  const kb = Math.min(hi, z1 + g.h);
  if (s.key && kb > ka + 1e-9) {
    m.wall(keyAt(s.key, g, ka - z1), ka, kb, true, keyAt(s.key, g, kb - z1));
    if (ka > z1 + 1e-9) m.face(keyAt(s.key, g, ka - z1), [], ka, false);
    m.face(keyAt(s.key, g, kb - z1), [], kb, true);
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
  pocket: Key | null,
  g: KeySizes,
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
  if (pocket) {
    rock.face(loop, [pocketAt(pocket, g, 0)], z0, false);
    rock.wall(pocketAt(pocket, g, 0), z0, z0 + g.depth, false, pocketAt(pocket, g, g.depth));
    rock.face(pocketAt(pocket, g, g.depth), [], z0 + g.depth, false);
  } else rock.face(loop, [], z0, false);
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

/**
 * A dovetailed top piece: the ground over any outline (anticlockwise), split at `zs` into rock and snow, as `topBodies`
 * does for a square. The ground is drawn by marching squares over the outline, sampled every `step` mm (each square's
 * part inside the outline is convex); the outline itself is where the squares' sides cross it (exactly), so the walls,
 * the underside (less the pocket) and the snow's sides all use exactly those points.
 */
function outlineTopBodies(outline: P2[], step: number, Z: (x: number, y: number) => number, z0: number, zs: number, pocket: Key | null, g: KeySizes): Body[] {
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  const [x0, y0] = [Math.min(...xs) - step, Math.min(...ys) - step];
  const mi = Math.ceil((Math.max(...xs) + step - x0) / step);
  const mj = Math.ceil((Math.max(...ys) + step - y0) / step);
  const X = (i: number) => x0 + i * step;
  const Y = (j: number) => y0 + j * step;
  // Which nodes are inside the outline (1) or not (−1).
  const f = new Float64Array((mi + 1) * (mj + 1));
  for (let j = 0; j <= mj; j++) for (let i = 0; i <= mi; i++) f[j * (mi + 1) + i] = inside([X(i), Y(j)], outline) ? 1 : -1;
  const val = (i: number, j: number) => (i < 0 || j < 0 || i > mi || j > mj ? -1 : f[j * (mi + 1) + i]);
  interface V {
    key: string;
    x: number;
    y: number;
    h: number;
    cross: boolean;
  }
  const verts = new Map<string, V>();
  const vertex = (key: string, x: number, y: number, cross: boolean): V => {
    let v = verts.get(key);
    if (!v) {
      v = { key, x, y, h: Z(x, y), cross };
      verts.set(key, v);
    }
    return v;
  };
  const corner = (i: number, j: number) => vertex(`n${i},${j}`, X(i), Y(j), false);
  // Where the outline crosses a square's side — exactly, the crossing nearest the side's inside end (kept a hair off
  // the ends) — worked out once per side.
  const sideCross = (a: [number, number], b: [number, number]) => {
    const [p, q] = a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) ? [a, b] : [b, a];
    const key = p[0] === q[0] ? `v${p[0]},${p[1]}` : `h${p[0]},${p[1]}`;
    const known = verts.get(key);
    if (known) return known;
    const [P, Q]: P2[] = [
      [X(p[0]), Y(p[1])],
      [X(q[0]), Y(q[1])],
    ];
    const fromP = val(p[0], p[1]) > 0;
    let best = fromP ? Infinity : -Infinity;
    const [ex, ey] = [Q[0] - P[0], Q[1] - P[1]];
    for (let k = 0; k < outline.length; k++) {
      const [A, B] = [outline[k], outline[(k + 1) % outline.length]];
      const [dx, dy] = [B[0] - A[0], B[1] - A[1]];
      const den = ex * dy - ey * dx;
      if (Math.abs(den) < 1e-15) continue;
      const t = ((A[0] - P[0]) * dy - (A[1] - P[1]) * dx) / den;
      const u = ((A[0] - P[0]) * ey - (A[1] - P[1]) * ex) / den;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      best = fromP ? Math.min(best, t) : Math.max(best, t);
    }
    // (None found only by rounding at a vertex: halfway is as good as any.)
    const t = Math.max(0.02, Math.min(0.98, Number.isFinite(best) ? best : 0.5));
    return vertex(key, P[0] + ex * t, P[1] + ey * t, true);
  };
  const polys: V[][] = [];
  for (let j = -1; j <= mj; j++)
    for (let i = -1; i <= mi; i++) {
      const cs: [number, number][] = [
        [i, j],
        [i + 1, j],
        [i + 1, j + 1],
        [i, j + 1],
      ];
      const fv = cs.map(([a, b]) => val(a, b));
      const ins = fv.map((x) => x > 0);
      if (!ins.some(Boolean)) continue;
      const saddle = ins[0] === ins[2] && ins[1] === ins[3] && ins[0] !== ins[1];
      if (saddle && (fv[0] + fv[1] + fv[2] + fv[3]) / 4 <= 0) {
        for (const k of ins[0] ? [0, 2] : [1, 3]) polys.push([corner(...cs[k]), sideCross(cs[k], cs[(k + 1) % 4]), sideCross(cs[(k + 3) % 4], cs[k])]);
      } else {
        const p: V[] = [];
        for (let k = 0; k < 4; k++) {
          if (ins[k]) p.push(corner(...cs[k]));
          if (ins[k] !== ins[(k + 1) % 4]) p.push(sideCross(cs[k], cs[(k + 1) % 4]));
        }
        polys.push(p);
      }
    }
  const below = (v: V) => v.h <= zs;
  const crossings = new Map<string, V>();
  const crossing = (a: V, b: V): V => {
    const [p, q] = a.key < b.key ? [a, b] : [b, a];
    const key = `${p.key}|${q.key}`;
    let v = crossings.get(key);
    if (!v) {
      const t = (zs - p.h) / (q.h - p.h);
      v = { key: `s${key}`, x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, h: zs, cross: false };
      crossings.set(key, v);
    }
    return v;
  };
  const rock = new Mesh();
  const snow = new Mesh();
  const fan = (m: Mesh, poly: V[], z: (v: V) => number, up: boolean) => {
    if (poly.length < 3) return;
    const ids = poly.map((v) => m.point(v.x, v.y, z(v)));
    for (let k = 1; k + 1 < ids.length; k++) up ? m.tri(ids[0], ids[k], ids[k + 1]) : m.tri(ids[0], ids[k + 1], ids[k]);
  };
  // The ground, square by square, cut at the snow line; and the outline's pieces (between two crossings), in order.
  const next = new Map<string, V>();
  for (const poly of polys) {
    for (let k = 0; k < poly.length; k++) {
      const [p, q] = [poly[k], poly[(k + 1) % poly.length]];
      if (p.cross && q.cross) next.set(p.key, q);
    }
    // Triangle by triangle (a triangle crosses the snow line at most twice), as topBodies does.
    for (let k = 1; k + 1 < poly.length; k++) {
      const tri = [poly[0], poly[k], poly[k + 1]];
      const lowPart: V[] = [];
      const highPart: V[] = [];
      for (let m = 0; m < 3; m++) {
        const [p, q] = [tri[m], tri[(m + 1) % 3]];
        (below(p) ? lowPart : highPart).push(p);
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
  const start = next.values().next().value as V;
  const ring: V[] = [start];
  for (let v = next.get(start.key)!; v !== start && ring.length <= next.size; v = next.get(v.key)!) ring.push(v);
  if (ring.length !== next.size) throw new Error("A top piece's outline came out in more than one loop.");
  const edge: V[] = [];
  ring.forEach((v, k) => {
    const w = ring[(k + 1) % ring.length];
    edge.push(v);
    if (below(v) !== below(w)) edge.push(crossing(v, w));
  });
  const loop = edge.map((v) => [v.x, v.y] as P2);
  rock.wall(
    loop,
    z0,
    edge.map((v) => Math.min(v.h, zs)),
  );
  if (pocket) {
    rock.face(loop, [pocketAt(pocket, g, 0)], z0, false);
    rock.wall(pocketAt(pocket, g, 0), z0, z0 + g.depth, false, pocketAt(pocket, g, g.depth));
    rock.face(pocketAt(pocket, g, g.depth), [], z0 + g.depth, false);
  } else rock.face(loop, [], z0, false);
  const snowIds = edge.map((v) => [snow.point(v.x, v.y, zs), snow.point(v.x, v.y, Math.max(v.h, zs))]);
  for (let k = 0; k < edge.length; k++) {
    const l = (k + 1) % edge.length;
    if (edge[k].h < zs - 1e-12 || edge[l].h < zs - 1e-12) continue;
    snow.tri(snowIds[k][0], snowIds[l][0], snowIds[l][1]);
    snow.tri(snowIds[k][0], snowIds[l][1], snowIds[k][1]);
  }
  const out: Body[] = [rock.body("rock")];
  if (snow.t.length && [...verts.values()].some((v) => v.h > zs)) out.push(snow.body("snow"));
  return out;
}

/** Would key `a` (at its place in its own cube) go into pocket `b` (at its place in its own cube)? */
export function keyGoesIn(a: Key, aCell: P2, b: Key, bCell: P2, g: KeySizes): boolean {
  const moved = keyLoop([a.c[0] - aCell[0] + bCell[0], a.c[1] - aCell[1] + bCell[1]], a.half, 2, a.cut);
  return insideGap(moved, keyLoop(b.c, b.half + g.fit, 2 + g.fit, b.cut)) > 0;
}

/**
 * Give every key its own code — moved a step off its spot one way or another, and one of its four corners cut off — so
 * that no key goes into the pocket of any piece next to, above or below its own, nor theirs into its: a piece put in
 * the wrong place sits up on the key there and rocks, and the cut corner stops it going on turned round. Keys keep
 * within the room they had (a step smaller when they're moved). Returns how many neighbouring pairs it couldn't keep
 * apart (none, in practice).
 */
export function codeKeys(columns: { joins: (Key | null)[] }[], cols: number, rows: number, cube: number, g: KeySizes, seed: number): number {
  let a = (Math.floor(seed) * 2654435761) >>> 0 || 1;
  const rand = () => ((a = (Math.imul(a ^ (a >>> 15), 2246822519) + 0x6d2b79f5) >>> 0) / 4294967296);
  // One size for every key, so a key can only go into a pocket of its own position and corner: the size nearly every
  // join has room for once moved a step (the few with less keep what they have, and are checked like the rest).
  const rooms = columns.flatMap((col) => col.joins.filter((k): k is Key => !!k).map((k) => k.half)).sort((x, y) => x - y);
  const size = rooms.length ? Math.max(g.least, Math.floor((rooms[Math.floor(rooms.length * 0.05)] - CODE_STEP) * 10) / 10) : g.least;
  const done = new Map<string, Key>();
  let clashes = 0;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      columns[r * cols + c].joins.forEach((k, L) => {
        if (!k) return;
        const cell: P2 = [c * cube, r * cube];
        const near: { key: Key; cell: P2 }[] = [];
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++)
            for (let dl = -1; dl <= 1; dl++) {
              const other = done.get(`${c + dc},${r + dr},${L + dl}`);
              if (other) near.push({ key: other, cell: [(c + dc) * cube, (r + dr) * cube] });
            }
        // Every code this key could take, in a shuffled order: all the same size (where there's room), moved only if the
        // room allows.
        const half = Math.min(size, k.half);
        const options = KEY_CODES.filter(({ dx, dy }) => !(dx || dy) || k.half >= size + CODE_STEP - 1e-9)
          .map(({ dx, dy, cut }) => ({ key: { c: [k.c[0] + dx * CODE_STEP, k.c[1] + dy * CODE_STEP], half, cut } as Key, order: rand() }))
          .sort((x, y) => x.order - y.order);
        let best: Key | null = null;
        let fewest = Infinity;
        for (const { key } of options) {
          let fits = 0;
          for (const n of near) {
            if (keyGoesIn(key, cell, n.key, n.cell, g)) fits++;
            if (keyGoesIn(n.key, n.cell, key, cell, g)) fits++;
            if (fits >= fewest) break;
          }
          if (fits < fewest) [best, fewest] = [key, fits];
          if (!fits) break;
        }
        clashes += fewest === Infinity ? 0 : fewest;
        const chosen = best ?? { ...k, cut: 0 };
        done.set(`${c},${r},${L}`, chosen);
        columns[r * cols + c].joins[L] = chosen;
      });
  return clashes;
}

const columnName = (c: number): string => (c < 26 ? String.fromCharCode(65 + c) : columnName(Math.floor(c / 26) - 1) + String.fromCharCode(65 + (c % 26)));

/** The whole puzzle from the heights of an area `areaWidth` × `areaHeight` m. Throws if `mountainChecks` has problems. */
export function makeMountainPuzzle(grid: HeightGrid, areaWidth: number, areaHeight: number, spec: MountainSpec, features: MapFeatures = NO_FEATURES): MountainPuzzle {
  const layout = layoutFor(grid, areaWidth, areaHeight, spec);
  const checks = mountainChecks(spec, layout);
  if (checks.problems.length) throw new Error(checks.problems[0]);
  const { cols, rows, k } = layout;
  const cube = spec.cube;
  const fit = spec.fit;
  const g = keySizes(spec);
  const base = baseFor(spec);
  const zOf = (h: number) => base + (h - layout.low) * k * spec.exaggeration;
  const plain = (x: number, y: number) => zOf(heightAt(grid, layout.e0 + x / k, layout.n0 + y / k));
  // Paths, rivers, lochs and buildings from a map, pressed into the ground.
  const marks = groundMarks(features, layout.e0, layout.n0, k, cols * cube, rows * cube, plain);
  const Z = marks.empty ? plain : (x: number, y: number) => marks.apply(x, y, plain(x, y));
  const snowZ = spec.snowline === null ? Infinity : zOf(spec.snowline);
  // Samples along each side of a top piece: about one per height-data point (finer for map marks), 8 to 48 (64).
  const n = marks.empty ? Math.min(48, Math.max(8, Math.ceil(cube / Math.max(0.6, grid.spacing * k)))) : Math.min(64, Math.max(16, Math.ceil(cube / 0.45)));
  const thinnest = g.depth + 2;
  // Layer 0 is the thin plate, the rest full cubes.
  const plate = plateFor(spec);
  const bottomOf = (L: number) => (L === 0 ? 0 : plate + (L - 1) * cube);

  // How many whole cubes each column has under its top piece.
  const full: number[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      let low = Infinity;
      for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) low = Math.min(low, Z(c * cube + (cube * i) / n, r * cube + (cube * j) / n));
      // Always the plate, then as many whole cubes as leave the top piece its thickness.
      const room = low - 0.5 - thinnest;
      full.push(room < plate ? 1 : 1 + Math.floor((room - plate) / cube));
    }
  const fullAt = (c: number, r: number) => (c < 0 || r < 0 || c >= cols || r >= rows ? 0 : full[r * cols + c]);
  const layers = Math.max(...full) + 1;

  // Each layer's jigsaw, and its pieces' outlines (tabs only between two whole cubes).
  const rnd = seeded(spec.seed * 7919 + 1);
  const puzzles: LayerJoins[] = [];
  for (let L = 0; L < layers - 1; L++) puzzles.push(layerJoins(cols, rows, rnd));
  // Top pieces side by side at the same level are dovetailed too; the top layer's joins come from their own seed, so
  // everything below is exactly as it was.
  const topLayerJoins = layerJoins(cols, rows, seeded(spec.seed * 7919 + 5));
  const joinsAt = (L: number) => (L < layers - 1 ? puzzles[L] : topLayerJoins);
  // Every piece with tabs, so no two can swap places.
  const blocks: Parameters<typeof uniqueBlocks>[0] = [];
  const pick = (r: () => number) => DOVE_SHAPES[Math.floor(r() * DOVE_SHAPES.length)];
  for (let L = 0; L < layers - 1; L++) {
    const j = puzzles[L];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        if (fullAt(c, r) <= L) continue;
        const has = [r > 0 && fullAt(c, r - 1) > L, c < cols - 1 && fullAt(c + 1, r) > L, r < rows - 1 && fullAt(c, r + 1) > L, c > 0 && fullAt(c - 1, r) > L];
        blocks.push({
          height: bottomOf(L + 1) - bottomOf(L),
          sides: () => [has[0] ? j.across[r - 1][c] : null, has[1] ? j.down[c][r] : null, has[2] ? j.across[r][c] : null, has[3] ? j.down[c - 1][r] : null],
          reroll: (g) => {
            const side = Math.floor(g() * 4);
            if (side === 0 && has[0]) j.across[r - 1][c] = pick(g);
            else if (side === 1 && has[1]) j.down[c][r] = pick(g);
            else if (side === 2 && has[2]) j.across[r][c] = pick(g);
            else if (side === 3 && has[3]) j.down[c - 1][r] = pick(g);
          },
        });
      }
  }
  const lookAlikes = uniqueBlocks(blocks, rnd);
  let neck = Infinity;
  const outlineOf = (L: number, c: number, r: number): P2[] => {
    const neighbours = [
      [c, r - 1],
      [c + 1, r],
      [c, r + 1],
      [c - 1, r],
    ];
    const inBounds = (side: number) => (side === 0 ? r > 0 : side === 1 ? c < cols - 1 : side === 2 ? r < rows - 1 : c > 0);
    if (L >= fullAt(c, r)) {
      // A top piece: dovetailed to neighbouring top pieces that start at the same level, else a plain square.
      const besideTop = (side: number) => inBounds(side) && fullAt(neighbours[side][0], neighbours[side][1]) === L;
      if ([0, 1, 2, 3].some(besideTop)) {
        neck = Math.min(neck, neckFor(cube, fit));
        return offsetPolygon(blockOutline(joinsAt(L), cols, rows, cube, r, c, besideTop), -fit);
      }
      const s: P2[] = [
        [c * cube + fit, r * cube + fit],
        [(c + 1) * cube - fit, r * cube + fit],
        [(c + 1) * cube - fit, (r + 1) * cube - fit],
        [c * cube + fit, (r + 1) * cube - fit],
      ];
      return s;
    }
    const tabbed = (side: number) => fullAt(neighbours[side][0], neighbours[side][1]) > L;
    if ([0, 1, 2, 3].some((side) => tabbed(side) && inBounds(side))) neck = Math.min(neck, neckFor(cube, fit));
    return offsetPolygon(blockOutline(puzzles[L], cols, rows, cube, r, c, tabbed), -fit);
  };

  // Every column's outlines and the spot for each key between its pieces.
  const columns: { outlines: P2[][]; joins: (Key | null)[] }[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const f = fullAt(c, r);
      const outlines = Array.from({ length: f + 1 }, (_, L) => outlineOf(L, c, r));
      const centre: P2 = [(c + 0.5) * cube, (r + 0.5) * cube];
      columns.push({ outlines, joins: Array.from({ length: f }, (_, L) => keyPlace(centre, outlines[L], outlines[L + 1], g, cube)) });
    }
  const clashes = codeKeys(columns, cols, rows, cube, g, spec.seed);

  const pieces: PuzzlePiece[] = [];
  const keyless: string[] = [];
  // Pieces beside each piece at its own level: whole cubes beside whole cubes, top pieces beside top pieces starting at
  // the same height. Each of those sides has a dovetail.
  const besideAtLevel = (c: number, r: number, L: number) => {
    const own = fullAt(c, r);
    let n = 0;
    for (const [a, b] of [[c, r - 1], [c + 1, r], [c, r + 1], [c - 1, r]]) {
      if (a < 0 || b < 0 || a >= cols || b >= rows) continue;
      const f = fullAt(a, b);
      if (L < own ? f > L : f === L) n++;
    }
    return n;
  };
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const f = fullAt(c, r);
      const { outlines, joins } = columns[r * cols + c];
      for (let L = 0; L <= f; L++) {
        const name = `${columnName(c)}${r + 1}-${L + 1}`;
        const pocket = L > 0 ? joins[L - 1] : null;
        if (L > 0 && !pocket) keyless.push(name);
        const z0 = bottomOf(L);
        const z1 = bottomOf(L + 1);
        if (L < f) {
          const shape: BlockShape = { outline: outlines[L], z0, z1, pocket, key: joins[L], sizes: g };
          // The snow line, moved clear of the pocket and the very top.
          let cut = snowZ;
          if (cut <= z0 + (pocket ? g.depth + 1 : 1)) cut = -Infinity;
          else if (cut >= z1 - 1) cut = Infinity;
          const top = z1 + (joins[L] ? g.h : 0);
          const bodies =
            cut === -Infinity
              ? [blockBody(shape, z0, top, "snow")]
              : cut === Infinity
                ? [blockBody(shape, z0, top, "rock")]
                : [blockBody(shape, z0, cut, "rock"), blockBody(shape, cut, top, "snow")];
          const beside = besideAtLevel(c, r, L);
          pieces.push({ name, col: c, row: r, layer: L, top: false, z0, height: top - z0, outline: outlines[L], key: joins[L], pocket, bodies: bodies.filter((b): b is Body => !!b), joints: beside, neighbours: beside });
        } else {
          const sq: [number, number, number, number] = [c * cube + fit, r * cube + fit, (c + 1) * cube - fit, (r + 1) * cube - fit];
          const zs = Math.max(snowZ, z0 + (pocket ? g.depth + 1 : 1));
          const bodies = outlines[L].length === 4 ? topBodies(sq, n, Z, z0, zs, pocket, g) : outlineTopBodies(outlines[L], cube / n / 2, Z, z0, zs, pocket, g);
          let peak = z0;
          for (const b of bodies) for (let i = 2; i < b.vertices.length; i += 3) peak = Math.max(peak, b.vertices[i]);
          const beside = besideAtLevel(c, r, L);
          pieces.push({ name, col: c, row: r, layer: L, top: true, z0, height: peak - z0, outline: outlines[L], key: null, pocket, bodies, joints: beside, neighbours: beside });
        }
      }
    }
  const warnings = [...checks.warnings];
  if (lookAlikes)
    warnings.push(
      `${lookAlikes} pieces stand where only one cube or none sits beside them, so their tabs alone can't make them all different: their coded keys tell them apart.`,
    );
  if (clashes) warnings.push(`${clashes} ${clashes === 1 ? "pair" : "pairs"} of neighbouring keys could still go into each other's pockets: take care with those pieces.`);
  if (keyless.length) warnings.push(`No room for a key under ${keyless.length === 1 ? "piece" : "pieces"} ${keyless.slice(0, 6).join(", ")}${keyless.length > 6 ? "…" : ""}: ${keyless.length === 1 ? "it rests" : "they rest"} on the piece below with nothing to hold ${keyless.length === 1 ? "it" : "them"} in place.`);
  const tallest = Math.max(...pieces.map((p) => p.height));
  if (tallest > spec.bed[2]) warnings.push(`The tallest piece is ${Math.round(tallest)} mm — taller than the printer (${spec.bed[2]} mm). Lower the height stretch.`);
  return { spec, layout, keys: g, snowZ, layers, pieces, warnings, neck: Number.isFinite(neck) ? neck : neckFor(cube, fit) };
}
