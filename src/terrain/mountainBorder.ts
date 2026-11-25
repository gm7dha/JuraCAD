/**
 * A frame round a finished Mountain puzzle (pure, mm; the puzzle's own coordinates — x east, y north, z up, the puzzle
 * covering 0…cols × cube by 0…rows × cube): four low walls standing on the bed, hiding the puzzle's steep cut sides.
 * The wall's top follows the land along the puzzle's edge loosely — the edge's ground height plus `RISE`, its bumps
 * smoothed over about a cube's width and never steeper than `MAX_SLOPE` — one smooth line all the way round, the same
 * at every join and corner, so nothing steps. The walls are separate pieces that fit the printer's bed — an L-shaped piece
 * at each corner and straight pieces between — joined by dovetail lugs that run the full height of the wall, so the
 * frame drops together from above like the puzzle and locks along its length. Every piece is drawn on its shared join
 * lines and then shrunk by the puzzle's fit gap, exactly as the puzzle's own pieces are, so joins and the puzzle
 * inside have 2 × fit of room.
 *
 * The front (south) wall can carry words — the mountain's name, its height, grid reference and scale — raised
 * `RELIEF` mm off its outside face, as a part of their own (a second filament, so they print in another colour). The
 * words sit on one "name plate" piece in the middle of the front, so no join runs through them. Raised letters on an
 * upright face print without supports: only their undersides overhang, by less than a millimetre.
 */
import { insidePolygon, offsetPolygon, outlineGap } from "../library/outlines";
import { FONTS, type FontName } from "../geometry/fonts";
import { nestContours, polygonArea, textOutlines } from "../geometry/text";
import { BED_MARGIN } from "./puzzle3mf";
import type { Body, MountainPuzzle, PuzzlePiece } from "./mountainPuzzle";
import { triangulate, type P2 } from "./triangulate";

/** The wall's thickness as drawn (mm); each piece is then shrunk by the fit gap on every side. */
export const BORDER_WALL = 10;
/**
 * The lugs (mm, as drawn): a neck `LUG_NECK` wide and `LUG_NECK_LENGTH` long, then a head `LUG_HEAD` wide reaching
 * `LUG_DEPTH` in all. The head's shoulders face straight back, so pulled apart along the wall a piece moves only the
 * fit gap before it catches (a slanted dovetail this shallow would slide well over a millimetre first).
 */
export const LUG_NECK = 3.6;
export const LUG_HEAD = 5.6;
export const LUG_NECK_LENGTH = 2;
export const LUG_DEPTH = 5;
/** How far each corner piece's arms reach along the puzzle's sides past the inside corner (mm). */
export const CORNER_ARM = 20;
/** Pieces left beside the name plate are never shorter than this (mm). */
export const MIN_PIECE = 15;
/** No straight piece may be shorter than its lug plus the fit gaps and this much (mm): a shorter one would overlap its neighbours. */
export const PIECE_MARGIN = 3;
/** The wall's top stands at least this much (mm) above the puzzle's ground everywhere along its edge. */
export const RISE = 1;
/** The top's height is worked out every `TOP_STEP` mm along each side (about; a whole number of steps a cube). */
export const TOP_STEP = 1;
/** How loosely the top follows the land: bumps are covered `ENVELOPE` cubes either way, then averaged over `SMOOTH` cubes either way. */
export const ENVELOPE = 0.75;
export const SMOOTH = 0.5;
/** The top never rises or falls more steeply than this along the wall (mm per mm). */
export const MAX_SLOPE = 0.5;
/** How far the words stand off the front (mm). */
export const RELIEF = 0.8;
/** Capital letters' heights (mm): the first line, and the others; never smaller than `MIN_CAPS` (shrunk to fit). */
export const NAME_CAPS = 7;
export const INFO_CAPS = 4.5;
export const MIN_CAPS = 3;
/** Room (mm) above and below the words on the wall, and at the ends of the name plate. */
export const TEXT_MARGIN = 2;
export const TEXT_END = 6;
const FONT: FontName = "bold";

export type BorderSide = "S" | "E" | "N" | "W";

export interface BorderPiece extends PuzzlePiece {
  /** Which side it's on ("SW" etc. for a corner). */
  side: BorderSide | "SW" | "SE" | "NE" | "NW";
  /** The raised words on it (filament 2), or null. */
  words: Body | null;
}

/** A join: the piece before it along the side (whose lug reaches into the other), the one after, and that direction. */
export interface BorderJoint {
  side: BorderSide;
  lower: number;
  upper: number;
  dir: P2;
}

export interface MountainBorder {
  pieces: BorderPiece[];
  joints: BorderJoint[];
  /** Each side's tallest and lowest wall height (mm, corners included) and the puzzle's highest point along it. */
  heights: Record<BorderSide, number>;
  lows: Record<BorderSide, number>;
  peaks: Record<BorderSide, number>;
  /** The top's height (mm) over a point of the frame (puzzle coordinates): the same function every piece is built from. */
  topAt: (x: number, y: number) => number;
  /** Where the words are (the front's outside face, y) and their capital heights (mm), when there are any. */
  face: number;
  caps: number[];
  problems: string[];
  warnings: string[];
}

/** The usual words: the name, then the height, grid reference and scale. */
export function borderWords(name: string, height: number | null, ref: string | null, scale: number | null): string {
  const info = [height !== null ? `${Math.round(height)} m` : "", ref ?? "", scale ? `1:${Math.round(scale).toLocaleString("en-GB")}` : ""].filter(Boolean).join(" · ");
  return [name.trim(), info].filter(Boolean).join("\n");
}

/** How tall a capital H is, as a share of the font size. */
function capShare(font: FontName): number {
  const ys = textOutlines(FONTS[font], "H", 100, 2).contours.flat().map((p) => p[1]);
  const h = ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
  return h > 1 ? h / 100 : 0.7;
}

/** The highest point of the puzzle along each outside edge (mm): every corner within half a mm of that edge's face. */
export function edgePeaks(puzzle: MountainPuzzle): Record<BorderSide, number> {
  const W = puzzle.layout.cols * puzzle.spec.cube;
  const H = puzzle.layout.rows * puzzle.spec.cube;
  const near = puzzle.spec.fit + 0.5;
  const peaks: Record<BorderSide, number> = { S: 0, E: 0, N: 0, W: 0 };
  for (const p of puzzle.pieces)
    for (const b of p.bodies)
      for (let i = 0; i < b.vertices.length; i += 3) {
        const [x, y, z] = [b.vertices[i], b.vertices[i + 1], b.vertices[i + 2]];
        if (y <= near) peaks.S = Math.max(peaks.S, z);
        if (y >= H - near) peaks.N = Math.max(peaks.N, z);
        if (x <= near) peaks.W = Math.max(peaks.W, z);
        if (x >= W - near) peaks.E = Math.max(peaks.E, z);
      }
  return peaks;
}

/** A closed prism (vertices, triangles) over an outline with holes, from `lo` to `hi`, mapped by `to`. */
function prism(outer: P2[], holes: P2[][], lo: number, hi: number, to: (a: number, b: number, c: number) => [number, number, number]): { v: number[]; t: number[] } {
  const v: number[] = [];
  const t: number[] = [];
  const point = (a: number, b: number, c: number) => {
    v.push(...to(a, b, c));
    return v.length / 3 - 1;
  };
  const ccw = (p: P2[]) => (polygonArea(p) > 0 ? p : [...p].reverse());
  const O = ccw(outer);
  const Hs = holes.map(ccw);
  const tris = triangulate(O, Hs);
  const all = [O, ...Hs].flat();
  const bottom = all.map(([a, b]) => point(a, b, lo));
  const top = all.map(([a, b]) => point(a, b, hi));
  for (const [a, b, c] of tris) {
    t.push(bottom[a], bottom[c], bottom[b]);
    t.push(top[a], top[b], top[c]);
  }
  const wall = (loop: P2[], out: boolean) => {
    const L = loop.map(([a, b]) => point(a, b, lo));
    const U = loop.map(([a, b]) => point(a, b, hi));
    for (let i = 0; i < loop.length; i++) {
      const j = (i + 1) % loop.length;
      if (out) t.push(L[i], L[j], U[j], L[i], U[j], U[i]);
      else t.push(L[i], U[j], L[j], L[i], U[i], U[j]);
    }
  };
  wall(O, true);
  for (const h of Hs) wall(h, false);
  return { v, t };
}

/**
 * The frame's top all the way round (pure): a ring of heights `step` mm apart along the puzzle's edge, starting at the
 * south-west corner and going east along the front, north up the east side, west along the back and south down the
 * west side. Each is the ground just inside the edge (the highest corner of the puzzle within `fit` + ½ mm of the face,
 * a straight line between) plus `RISE`, raised to `floor` where asked; bumps are covered `ENVELOPE` cubes either way,
 * then averaged over `SMOOTH` cubes either way — which can't dip below the land, as every height averaged already
 * covers it — and finally lifted wherever it would rise or fall more steeply than `MAX_SLOPE`.
 */
export interface TopRing {
  step: number;
  /** Ring indices where the sides start: S, E, N, W (S at 0), and the ring's length. */
  starts: Record<BorderSide, number>;
  count: number;
  heights: number[];
  /** The ground plus `RISE` the heights must stay above. */
  least: number[];
}

/** Where a point of the frame sits on the ring (a fractional index). */
function ringPlace(ring: TopRing, W: number, H: number, x: number, y: number): number {
  const { step, starts } = ring;
  if (y < 0) return x <= 0 ? 0 : x >= W ? starts.E : x / step;
  if (y > H) return x >= W ? starts.N : x <= 0 ? starts.W : starts.N + (W - x) / step;
  if (x >= W) return starts.E + y / step;
  if (x <= 0) return starts.W + (H - y) / step;
  return 0;
}

function ringAt(ring: TopRing, u: number): number {
  const n = ring.count;
  const v = ((u % n) + n) % n;
  const k = Math.floor(v);
  const f = v - k;
  const a = ring.heights[k % n];
  const b = ring.heights[(k + 1) % n];
  return f < 1e-12 ? a : a + (b - a) * f;
}

export function topRing(puzzle: MountainPuzzle, floors: { side: BorderSide; from: number; to: number; least: number }[] = []): TopRing {
  const cube = puzzle.spec.cube;
  const { cols, rows } = puzzle.layout;
  const W = cols * cube;
  const H = rows * cube;
  const per = Math.max(1, Math.round(cube / TOP_STEP));
  const step = cube / per;
  const nx = cols * per;
  const ny = rows * per;
  const starts: Record<BorderSide, number> = { S: 0, E: nx, N: nx + ny, W: 2 * nx + ny };
  const count = 2 * (nx + ny);
  // The ground along each side, sample by sample.
  const sides: Record<BorderSide, number[]> = { S: new Array(nx + 1).fill(-Infinity), N: new Array(nx + 1).fill(-Infinity), W: new Array(ny + 1).fill(-Infinity), E: new Array(ny + 1).fill(-Infinity) };
  const near = puzzle.spec.fit + 0.5;
  const put = (side: BorderSide, s: number, z: number) => {
    const a = sides[side];
    const i = Math.min(a.length - 1, Math.max(0, Math.round(s / step)));
    if (z > a[i]) a[i] = z;
  };
  for (const p of puzzle.pieces)
    for (const b of p.bodies)
      for (let i = 0; i < b.vertices.length; i += 3) {
        const [x, y, z] = [b.vertices[i], b.vertices[i + 1], b.vertices[i + 2]];
        if (y <= near) put("S", x, z);
        if (y >= H - near) put("N", x, z);
        if (x <= near) put("W", y, z);
        if (x >= W - near) put("E", y, z);
      }
  // Samples no corner fell on: a straight line between the ones either side (the mesh's own edges run straight there).
  for (const a of Object.values(sides)) {
    const known = a.map((z, i) => (Number.isFinite(z) ? i : -1)).filter((i) => i >= 0);
    if (!known.length) {
      a.fill(0);
      continue;
    }
    for (let i = 0; i < a.length; i++) {
      if (Number.isFinite(a[i])) continue;
      let j = known.findIndex((k) => k > i);
      if (j < 0) a[i] = a[known[known.length - 1]];
      else if (j === 0) a[i] = a[known[0]];
      else {
        const [l, r] = [known[j - 1], known[j]];
        a[i] = a[l] + ((a[r] - a[l]) * (i - l)) / (r - l);
      }
    }
  }
  const least = new Array<number>(count).fill(-Infinity);
  const place = (side: BorderSide, i: number) => {
    const n = side === "S" || side === "N" ? nx : ny;
    const k = side === "S" ? i : side === "E" ? starts.E + i : side === "N" ? starts.N + (n - i) : starts.W + (n - i);
    return k % count;
  };
  for (const side of ["S", "E", "N", "W"] as BorderSide[])
    sides[side].forEach((z, i) => {
      const k = place(side, i);
      least[k] = Math.max(least[k], z + RISE);
    });
  const target = [...least];
  for (const f of floors)
    for (let i = Math.max(0, Math.floor(f.from / step)); i <= Math.min(sides[f.side].length - 1, Math.ceil(f.to / step)); i++) {
      const k = place(f.side, i);
      target[k] = Math.max(target[k], f.least);
    }
  // Bumps covered…
  const R = Math.max(1, Math.round((ENVELOPE * cube) / step));
  const A = Math.max(0, Math.min(R - 1, Math.round((SMOOTH * cube) / step)));
  const cover = target.map((_, k) => {
    let m = -Infinity;
    for (let j = -R; j <= R; j++) m = Math.max(m, target[(k + j + count * 2) % count]);
    return m;
  });
  // …then averaged…
  const sums = [0];
  for (let k = 0; k < 3 * count; k++) sums.push(sums[k] + cover[k % count]);
  const heights = cover.map((_, k) => (sums[count + k + A + 1] - sums[count + k - A]) / (2 * A + 1));
  // …and never steeper than MAX_SLOPE: lifted, going both ways round from the highest point.
  const rise = MAX_SLOPE * step;
  let top = 0;
  for (let k = 1; k < count; k++) if (heights[k] > heights[top]) top = k;
  for (let j = 1; j < count; j++) {
    const k = (top + j) % count;
    heights[k] = Math.max(heights[k], heights[(k - 1 + count) % count] - rise);
  }
  for (let j = 1; j < count; j++) {
    const k = (top - j + count) % count;
    heights[k] = Math.max(heights[k], heights[(k + 1) % count] - rise);
  }
  return { step, starts, count, heights, least };
}

/**
 * A closed solid standing on z 0 over an outline whose sides all run along x or y, its top at `top(x, y)`: the outline
 * cut into a grid by its own corners' x and y and by the lines in `xs`/`ys`, each grid square inside it a column (two
 * triangles on top, two underneath), with walls round the outside of the squares. Every square shares its corners with
 * its neighbours and the walls, so the solid is watertight; with lines every step along the wall the top follows `top`.
 */
function columns(outline: P2[], xs: number[], ys: number[], top: (x: number, y: number) => number): { v: number[]; t: number[] } {
  const box = [Math.min(...outline.map((p) => p[0])), Math.min(...outline.map((p) => p[1])), Math.max(...outline.map((p) => p[0])), Math.max(...outline.map((p) => p[1]))];
  const lines = (own: number[], extra: number[], lo: number, hi: number) => {
    const all = [...own, ...extra.filter((a) => a > lo + 1e-6 && a < hi - 1e-6)].sort((a, b) => a - b);
    return all.filter((a, i) => i === 0 || a - all[i - 1] > 1e-6);
  };
  const X = lines(outline.map((p) => p[0]), xs, box[0], box[2]);
  const Y = lines(outline.map((p) => p[1]), ys, box[1], box[3]);
  const nx = X.length - 1;
  const ny = Y.length - 1;
  const inside: boolean[] = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) inside.push(insidePolygon([(X[i] + X[i + 1]) / 2, (Y[j] + Y[j + 1]) / 2], outline));
  const isIn = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && inside[i * ny + j];
  const v: number[] = [];
  const t: number[] = [];
  const ids = new Map<number, number>();
  const node = (i: number, j: number, up: boolean) => {
    const key = (i * (ny + 1) + j) * 2 + (up ? 1 : 0);
    let id = ids.get(key);
    if (id === undefined) {
      id = v.length / 3;
      v.push(X[i], Y[j], up ? top(X[i], Y[j]) : 0);
      ids.set(key, id);
    }
    return id;
  };
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) {
      if (!isIn(i, j)) continue;
      const c: [number, number][] = [
        [i, j],
        [i + 1, j],
        [i + 1, j + 1],
        [i, j + 1],
      ];
      const T = c.map(([a, b]) => node(a, b, true));
      const B = c.map(([a, b]) => node(a, b, false));
      t.push(T[0], T[1], T[2], T[0], T[2], T[3]);
      t.push(B[0], B[2], B[1], B[0], B[3], B[2]);
      // Walls where the next square is outside: going round the square anticlockwise, the inside on the left.
      const next: [number, number][] = [
        [i, j - 1],
        [i + 1, j],
        [i, j + 1],
        [i - 1, j],
      ];
      for (let e = 0; e < 4; e++) {
        if (isIn(...next[e])) continue;
        const [p, q] = [e, (e + 1) % 4];
        t.push(B[p], B[q], T[q], B[p], T[q], T[p]);
      }
    }
  return { v, t };
}

/**
 * The frame for a finished puzzle. `words` (lines split by "\n"; empty for none) go on the front. `bed` is the printer's
 * build volume: every piece is kept small enough to lie on it.
 */
export function makeBorder(puzzle: MountainPuzzle, words: string, bed: [number, number, number] = puzzle.spec.bed): MountainBorder {
  const fit = puzzle.spec.fit;
  const W = puzzle.layout.cols * puzzle.spec.cube;
  const H = puzzle.layout.rows * puzzle.spec.cube;
  const T = BORDER_WALL;
  const d = LUG_DEPTH;
  const problems: string[] = [];
  const warnings: string[] = [];
  const peaks = edgePeaks(puzzle);

  // Each side's own frame: s along it, t out from the puzzle's edge (0) to the wall's outside (T).
  const frames: Record<BorderSide, (s: number, t: number) => P2> = {
    S: (s, t) => [s, -t],
    N: (s, t) => [s, H + t],
    W: (s, t) => [-t, s],
    E: (s, t) => [W + t, s],
  };
  const dirs: Record<BorderSide, P2> = { S: [1, 0], N: [1, 0], W: [0, 1], E: [0, 1] };
  const length: Record<BorderSide, number> = { S: W, N: W, W: H, E: H };
  // A join line across the wall at s, from the inside to the outside, with its lug reaching on along the side.
  const lug = (side: BorderSide, s: number): P2[] => {
    const f = frames[side];
    const [n, h] = [LUG_NECK / 2, LUG_HEAD / 2];
    const a = LUG_NECK_LENGTH;
    return [f(s, 0), f(s, T / 2 - n), f(s + a, T / 2 - n), f(s + a, T / 2 - h), f(s + d, T / 2 - h), f(s + d, T / 2 + h), f(s + a, T / 2 + h), f(s + a, T / 2 + n), f(s, T / 2 + n), f(s, T)];
  };
  // The longest a straight piece's s-range may be, so it lies on the bed (its lug sticks out d further).
  const most: Record<BorderSide, number> = {
    S: bed[0] - 2 * BED_MARGIN - d - 1,
    N: bed[0] - 2 * BED_MARGIN - d - 1,
    W: bed[1] - 2 * BED_MARGIN - d - 1,
    E: bed[1] - 2 * BED_MARGIN - d - 1,
  };
  // Where each side's corner arms end: [start, end]; a short side gets one join in its middle.
  const arms: Record<BorderSide, [number, number]> = { S: [0, 0], N: [0, 0], W: [0, 0], E: [0, 0] };
  for (const s of ["S", "E", "N", "W"] as BorderSide[]) {
    const L = length[s];
    arms[s] = L - 2 * CORNER_ARM >= MIN_PIECE ? [CORNER_ARM, L - CORNER_ARM] : [L / 2, L / 2];
  }
  const even = (a: number, b: number, side: BorderSide): number[] => {
    if (b - a < 1e-9) return [];
    const k = Math.max(1, Math.ceil((b - a) / most[side] - 1e-9));
    return Array.from({ length: k - 1 }, (_, i) => a + ((b - a) * (i + 1)) / k);
  };

  // The words: measured, shrunk to fit the front's middle if need be.
  const lines = words
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const share = capShare(FONT);
  let block: { contours: P2[][]; box: [number, number, number, number]; caps: number[] } | null = null;
  const [f0, f1] = arms.S;
  if (lines.length) {
    // The name plate is the whole middle when that fits the bed; else it leaves at least MIN_PIECE beside it.
    const M = f1 - f0;
    const room = (M <= most.S ? M : Math.min(most.S, M - MIN_PIECE)) - 2 * TEXT_END;
    const lay = (k: number) => {
      const caps = lines.map((_, i) => (i === 0 ? NAME_CAPS : INFO_CAPS) * k);
      const contours: P2[][] = [];
      let y = 0;
      let box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
      lines.forEach((line, i) => {
        const out = textOutlines(FONTS[FONT], line, caps[i] / share, 6);
        const ys = out.contours.flat().map((p) => p[1]);
        if (!ys.length) return;
        const top = Math.max(...ys);
        const bottom = Math.min(...ys);
        // Each line hangs below the one before, a little apart.
        const shift = y - top - (i ? 0.45 * Math.max(caps[i], caps[i - 1]) : 0);
        const cx = out.width / 2;
        for (const c of out.contours) {
          const moved = c.map(([a, b]) => [a - cx, b + shift] as P2);
          contours.push(moved);
          for (const [a, b] of moved) box = [Math.min(box[0], a), Math.min(box[1], b), Math.max(box[2], a), Math.max(box[3], b)];
        }
        y = bottom + shift;
      });
      return { contours, box, caps };
    };
    let b = lay(1);
    if (!Number.isFinite(b.box[0])) b = { ...b, contours: [] };
    else {
      const width = b.box[2] - b.box[0];
      if (width > room) b = lay(Math.max(0, room) / width);
    }
    if (f1 - f0 < MIN_PIECE + 2 * TEXT_END) problems.push("The puzzle is too narrow for words on its front: leave them out, or make the puzzle bigger.");
    else if (Math.min(...b.caps) < MIN_CAPS - 1e-9)
      problems.push(`The words are too long for the front: their letters would be under ${MIN_CAPS} mm tall. Shorten them, or put them on more lines.`);
    else if (b.contours.length) block = b;
  }

  // The front's joins: the name plate in the middle (holding the words), the rest shared out evenly.
  const tidy = (xs: number[]) => [...xs].sort((a, b) => a - b).filter((x, i, a) => i === 0 || x - a[i - 1] > 1e-9);
  const cuts: Record<BorderSide, number[]> = { S: [], E: [], N: [], W: [] };
  for (const s of ["E", "N", "W"] as BorderSide[]) cuts[s] = tidy([arms[s][0], ...even(arms[s][0], arms[s][1], s), arms[s][1]]);
  let plate: [number, number] | null = null;
  if (block) {
    // What's left beside the plate is nothing or at least MIN_PIECE: shared out both sides when each half is long
    // enough, else all on one side (the plate grown as far as the bed lets it); the words go in the plate's middle.
    const M = f1 - f0;
    const need = block.box[2] - block.box[0] + 2 * TEXT_END;
    let [l0, l1] = [f0, f1];
    if (M > most.S) {
      let P = Math.min(most.S, Math.max(need, 0));
      if ((M - P) / 2 >= MIN_PIECE) [l0, l1] = [f0 + (M - P) / 2, f1 - (M - P) / 2];
      else {
        P = Math.min(most.S, M - MIN_PIECE);
        [l0, l1] = [f0, f0 + P];
      }
    }
    plate = [l0, l1];
    cuts.S = tidy([f0, ...even(f0, l0, "S"), l0, l1, ...even(l1, f1, "S"), f1]);
  } else cuts.S = tidy([f0, ...even(f0, f1, "S"), f1]);

  // A safety net: every straight piece long enough for the lug reaching into it.
  for (const side of ["S", "E", "N", "W"] as BorderSide[])
    for (let i = 0; i + 1 < cuts[side].length; i++)
      if (cuts[side][i + 1] - cuts[side][i] < d + 2 * fit + PIECE_MARGIN) {
        problems.push("The border's pieces would come out too short to join here: try another scale or fewer words.");
        break;
      }

  // The top all the way round, the front tall enough for the words where they are (blending in and out).
  const blockH = block ? block.box[3] - block.box[1] : 0;
  const span: [number, number] | null = block && plate ? [(plate[0] + plate[1]) / 2 - (block.box[2] - block.box[0]) / 2 - TEXT_END, (plate[0] + plate[1]) / 2 + (block.box[2] - block.box[0]) / 2 + TEXT_END] : null;
  const ring = topRing(puzzle, span ? [{ side: "S", from: span[0], to: span[1], least: blockH + 2 * TEXT_MARGIN }] : []);
  const topAt = (x: number, y: number) => ringAt(ring, ringPlace(ring, W, H, x, y));
  const face = -(T - fit);
  // The grid lines every piece's top is drawn on: every step along each side.
  const along = (n: number) => Array.from({ length: Math.round(n / ring.step) + 1 }, (_, i) => i * ring.step);
  const gridX = along(W);
  const gridY = along(H);

  const pieces: BorderPiece[] = [];
  const joints: BorderJoint[] = [];
  const add = (name: string, side: BorderPiece["side"], drawn: P2[], place: [number, number], words: Body | null = null) => {
    const outline = offsetPolygon(drawn, -fit) as P2[];
    const m = columns(outline, gridX, gridY, topAt);
    let height = 0;
    for (let i = 2; i < m.v.length; i += 3) height = Math.max(height, m.v[i]);
    pieces.push({
      name,
      side,
      col: place[0],
      row: place[1],
      layer: 0,
      top: false,
      z0: 0,
      height,
      outline,
      key: null,
      pocket: null,
      bodies: [{ part: "rock", vertices: m.v, triangles: m.t }],
      words,
    });
    return pieces.length - 1;
  };
  const { cols, rows } = puzzle.layout;
  // Corners: an L of both arms, its top carrying on from both sides.
  const corner = (name: BorderPiece["side"], outer: P2, inner: P2, a: BorderSide, sa: number, b: BorderSide, sb: number, place: [number, number]) =>
    add(`Border ${name} corner`, name, [outer, ...lug(a, sa).reverse(), inner, ...lug(b, sb)], place);
  const sw = corner("SW", [-T, -T], [0, 0], "S", cuts.S[0], "W", cuts.W[0], [-1, -1]);
  const se = corner("SE", [W + T, -T], [W, 0], "E", cuts.E[0], "S", cuts.S[cuts.S.length - 1], [cols, -1]);
  const ne = corner("NE", [W + T, H + T], [W, H], "N", cuts.N[cuts.N.length - 1], "E", cuts.E[cuts.E.length - 1], [cols, rows]);
  const nw = corner("NW", [-T, H + T], [0, H], "N", cuts.N[0], "W", cuts.W[cuts.W.length - 1], [-1, rows]);
  const ends: Record<BorderSide, [number, number]> = { S: [sw, se], N: [nw, ne], W: [sw, nw], E: [se, ne] };

  for (const side of ["S", "E", "N", "W"] as BorderSide[]) {
    const cs = cuts[side];
    let before = ends[side][0];
    for (let i = 0; i + 1 < cs.length; i++) {
      const [s0, s1] = [cs[i], cs[i + 1]];
      const drawn = [...lug(side, s0), ...lug(side, s1).reverse()];
      const mid = (s0 + s1) / 2;
      const place: [number, number] = side === "S" ? [Math.floor(mid / puzzle.spec.cube), -1] : side === "N" ? [Math.floor(mid / puzzle.spec.cube), rows] : side === "W" ? [-1, Math.floor(mid / puzzle.spec.cube)] : [cols, Math.floor(mid / puzzle.spec.cube)];
      let text: Body | null = null;
      if (side === "S" && block && plate && Math.abs(s0 - plate[0]) < 1e-9 && Math.abs(s1 - plate[1]) < 1e-9) {
        // Raised off the outside face: (u, v) on the face as read from the front, w out of it.
        const [cx, cy] = [(block.box[0] + block.box[2]) / 2 - (plate[0] + plate[1]) / 2, (block.box[1] + block.box[3]) / 2];
        // Half way up the wall where it's lowest under the words.
        let low = Infinity;
        for (const x of [span![0], span![1], ...gridX.filter((g) => g > span![0] && g < span![1])]) low = Math.min(low, topAt(x, face));
        const zc = low / 2;
        const v: number[] = [];
        const t: number[] = [];
        for (const shape of nestContours(block.contours)) {
          const m = prism(shape.outer, shape.holes, 0, RELIEF, (a, b, c) => [a - cx, face - c, zc + b - cy]);
          const base = v.length / 3;
          v.push(...m.v);
          for (const k of m.t) t.push(k + base);
        }
        text = { part: "snow", vertices: v, triangles: t };
      }
      const k = add(`Border ${side}${i + 1}${text ? " (name plate)" : ""}`, side, drawn, place, text);
      joints.push({ side, lower: before, upper: k, dir: dirs[side] });
      before = k;
    }
    joints.push({ side, lower: before, upper: ends[side][1], dir: dirs[side] });
  }

  // Every piece must lie on the bed and be short enough to print.
  for (const p of pieces) {
    const xs = p.outline.map((q) => q[0]);
    const ys = p.outline.map((q) => q[1]);
    const [w, dd] = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
    if (w > bed[0] - 2 * BED_MARGIN + 1e-6 || dd > bed[1] - 2 * BED_MARGIN + 1e-6) {
      problems.push(`${p.name} is too big for the printer's bed.`);
      break;
    }
  }
  const tallest = Math.max(...pieces.map((p) => p.height));
  if (tallest > bed[2]) warnings.push(`The frame's tallest piece is ${Math.ceil(tallest)} mm — taller than the printer (${bed[2]} mm).`);
  // Each side's tallest and lowest (whole mm, for the summary).
  const heights: Record<BorderSide, number> = { S: 0, E: 0, N: 0, W: 0 };
  const lows: Record<BorderSide, number> = { S: 0, E: 0, N: 0, W: 0 };
  const stops: Record<BorderSide, number> = { S: ring.starts.E, E: ring.starts.N, N: ring.starts.W, W: ring.count };
  for (const side of ["S", "E", "N", "W"] as BorderSide[]) {
    const hs = ring.heights.slice(ring.starts[side], stops[side]).concat(ring.heights[stops[side] % ring.count]);
    heights[side] = Math.max(...hs);
    lows[side] = Math.min(...hs);
  }
  // Never touching the puzzle (a sanity check on the drawing above).
  const edge = puzzle.pieces.filter((q) => q.layer === 0 && (q.col === 0 || q.row === 0 || q.col === cols - 1 || q.row === rows - 1));
  for (const p of pieces)
    for (const q of edge)
      if (outlineGap(p.outline, q.outline, fit) < fit - 1e-6) {
        problems.push("The frame would touch the puzzle.");
        break;
      }
  return { pieces, joints, heights, lows, peaks, topAt, face, caps: block?.caps ?? [], problems: [...new Set(problems)], warnings };
}
