/**
 * Decorated sticks for the six-piece burr (pure): the casting moulds' surface patterns (designs/mouldSurface.ts — the
 * same list and names) engraved into the faces of each stick that show from outside when the puzzle is put together,
 * and a choice for the square ends (plain, the pattern, the piece's number, or a raised badge with the number).
 *
 * The sticks slide against each other, so nothing is ever raised on a long face, and only faces that show from outside
 * are touched: a face of a piece's cube is "outside" when the cube beyond it is in none of the six full sticks — no
 * piece can be there when the puzzle is together (`outsideFaces`). Faces next to a notch, a gap or another stick are
 * left alone. Patterns are kept `margin` clear of every edge of the outside part of a face.
 *
 * Printing: the face lying on the bed is left plain — its first layers are squashed flat (and spread a little), which
 * fills a shallow groove, and the groove's roof would be printed in mid-air. The long sides stand upright, where a
 * shallow groove's roof is only as wide as the groove is deep (≤ 1.5 mm), which prints without supports. The badge
 * is a diamond whose lower sides slope at 45°, so it prints on an upright end without supports too.
 */
import { AXIS, CROSS, LENGTH, disassembly, fullStick, type Piece, type V3 } from "./burr";
import { seeded } from "./puzzle";
import { SURFACE_PATTERNS, type SurfacePattern } from "./designs/mouldSurface";
import { areaOf, clipToBox, type P2 } from "./designs/printShapes";
import type { DesignInput, DesignValues } from "./types";

export type EndStyle = "plain" | "pattern" | "number" | "badge";

export const END_STYLES: readonly { value: EndStyle; label: string }[] = [
  { value: "plain", label: "Plain" },
  { value: "pattern", label: "The same pattern, engraved" },
  { value: "number", label: "The piece's number, engraved" },
  { value: "badge", label: "A raised badge with the piece's number" },
];

/** The moulds' patterns, named for a stick lying along its length. */
export const BURR_PATTERNS: readonly { value: SurfacePattern; label: string }[] = SURFACE_PATTERNS.map((p) => ({
  value: p.value,
  label: p.value === "ribs" ? "Ribs along the sticks" : p.value === "rings" ? "Rings round the sticks" : p.value === "spiral" ? "Spiral ribs (slanting)" : p.value === "none" ? "None (smooth)" : p.label,
}));

/** Deepest engraving, and the most as a share of a cube's size (a cube is half a stick across), so sticks stay strong. */
export const MOST_DEPTH = 1.5;
export const DEPTH_SHARE = 0.15;
/** Engravings stay this far plus their depth (plus the fit) from every edge of a face's outside part. */
export const EDGE_MARGIN = 1;
/** The smallest repeat (mm), and the most engraved shapes on one piece (so a build stays quick). */
export const LEAST_CELL = 3;
export const MOST_SHAPES = 120;
/** The sketch for an engraving sits this far out from its face, so the cut doesn't start exactly on it. */
export const CUT_START = 0.5;
/** The badge's sketch starts this far inside the end, so it joins solidly. */
export const BADGE_ROOT = 0.3;
/** Numbers on a badge go this far into the end as well. */
export const BADGE_NUMBER_EXTRA = 0.3;

export interface BurrSurface {
  pattern: SurfacePattern;
  /** How deep the engraving is (mm), already capped for the stick's size. */
  depth: number;
  /** How deep it was asked to be. */
  asked: number;
  /** How many times the pattern repeats across a stick's face. */
  repeats: number;
  seed: number;
  ends: EndStyle;
}

export function surfaceInputs(): DesignInput[] {
  return [
    { key: "surface", label: "Surface pattern", kind: "choice", default: "none", choices: BURR_PATTERNS.map((c) => ({ ...c })), help: "Engraved into the faces that show when the puzzle is together, so it never gets in the way of the sliding." },
    { key: "surfaceDepth", label: "Pattern depth", kind: "length", default: 0.6, min: 0.3, max: MOST_DEPTH, help: "How deep the pattern is cut in. Thin sticks get no more than 15% of half their thickness." },
    { key: "surfaceRepeats", label: "Pattern repeats across", kind: "count", default: 3, min: 1, max: 6, help: "How many times the pattern repeats across a stick's face." },
    { key: "surfaceSeed", label: "Facets pattern number", kind: "count", default: 1, min: 1, max: 9999, help: "Geometric facets: each number gives a different random pattern." },
    { key: "ends", label: "Stick ends", kind: "choice", default: "plain", choices: END_STYLES.map((c) => ({ ...c })), help: "The numbers (1–6) make the solution easy to follow." },
  ];
}

const pick = <T extends string>(v: unknown, list: readonly { value: T }[], fallback: T): T => (list.some((c) => c.value === v) ? (v as T) : fallback);
const numberOr = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : fallback);

/** The surface settings, with anything missing (an insert saved before there were patterns) as plain sticks. */
export function surfaceOf(v: DesignValues, unit: number): BurrSurface {
  const asked = Math.max(0.1, numberOr(v.surfaceDepth, 0.6));
  return {
    pattern: pick(v.surface, BURR_PATTERNS, "none"),
    asked,
    depth: Math.round(Math.min(asked, MOST_DEPTH, DEPTH_SHARE * unit) * 1e6) / 1e6,
    repeats: Math.max(1, Math.round(numberOr(v.surfaceRepeats, 3))),
    seed: Math.max(1, Math.round(numberOr(v.surfaceSeed, 1))),
    ends: pick(v.ends, END_STYLES, "plain"),
  };
}

/** Plain sticks: exactly the burr as it was before patterns. */
export const isPlain = (s: BurrSurface) => s.pattern === "none" && s.ends === "plain";

// ---------------------------------------------------------------------------------------------------------------
// Which faces show from outside

/** A face direction on the bed: x along the stick, y across the bed, z up. "bed" (−z) is never decorated. */
export type FaceName = "top" | "bed" | "front" | "back" | "left" | "right";
export const FACE_NORMAL: Record<FaceName, V3> = { top: [0, 0, 1], bed: [0, 0, -1], front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0] };
const nameOf = (d: V3): FaceName => (Object.keys(FACE_NORMAL) as FaceName[]).find((k) => FACE_NORMAL[k].every((c, i) => c === d[i]))!;

/** What `laidFlat` does to a cube (min corner, assembled) — the same turn — giving the cube as laid (along, across, up). */
export function cubeOnBed(v: V3, axis: number, turn: number, min: [number, number]): V3 {
  let [u, w] = [v[CROSS[axis][0]] - min[0], v[CROSS[axis][1]] - min[1]];
  for (let k = 0; k < turn; k++) [u, w] = [1 - w, u];
  return [v[axis] + LENGTH / 2, u, w];
}

const key = (v: V3) => `${v[0]},${v[1]},${v[2]}`;
let envelope: Set<string> | null = null;
/** Every cube any full stick has: where pieces can be when the puzzle is together. */
function inEnvelope(v: V3): boolean {
  envelope ??= new Set([0, 1, 2, 3, 4, 5].flatMap((i) => fullStick(i).map(key)));
  return envelope.has(key(v));
}

const DIRS: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** A piece's cube faces that show from outside, as cubes laid on the bed (along, across, up) by the face they're on. */
export function outsideCells(piece: Piece, axis: number, turn: number, min: [number, number]): Record<FaceName, V3[]> {
  const out: Record<FaceName, V3[]> = { top: [], bed: [], front: [], back: [], left: [], right: [] };
  for (const v of piece)
    for (const d of DIRS) {
      const n: V3 = [v[0] + d[0], v[1] + d[1], v[2] + d[2]];
      if (inEnvelope(n)) continue;
      const [a, b] = [cubeOnBed(v, axis, turn, min), cubeOnBed(n, axis, turn, min)];
      out[nameOf([b[0] - a[0], b[1] - a[1], b[2] - a[2]])].push(a);
    }
  return out;
}

/** A rectangle on a face in bed mm: along its first and second directions (see `faceAxes`). */
export type Rect = [number, number, number, number];

/** Which bed axes a face's cells run along: (x, y) on top/bed, (x, z) on the sides, (y, z) on the ends. */
const faceAxes = (f: FaceName): [number, number] => (f === "top" || f === "bed" ? [0, 1] : f === "front" || f === "back" ? [0, 2] : [1, 2]);

/**
 * The outside parts of a face as rectangles of whole cubes (bed mm, before any margin): runs of cubes along the
 * face's first direction with the same cubes across. `y0` = where the piece lies across the bed; cubes are drawn `fit`
 * lower (the piece stands on the bed).
 */
export function outsideRects(cells: V3[], face: FaceName, unit: number, y0: number, fit: number): Rect[] {
  const [p, q] = faceAxes(face);
  const at = (axis: number, c: number) => (axis === 0 ? c * unit : axis === 1 ? y0 + c * unit : c * unit - fit);
  const across = new Map<number, Set<number>>();
  for (const c of cells) across.set(c[p], (across.get(c[p]) ?? new Set()).add(c[q]));
  const firsts = [...across.keys()].sort((a, b) => a - b);
  const sig = (a: number) => [...across.get(a)!].sort().join(",");
  const rects: Rect[] = [];
  for (let k = 0; k < firsts.length; ) {
    let m = k;
    while (m + 1 < firsts.length && firsts[m + 1] === firsts[m] + 1 && sig(firsts[m + 1]) === sig(firsts[k])) m++;
    // The cubes across in runs too (0 and 1 together, or one alone).
    const qs = [...across.get(firsts[k])!].sort((a, b) => a - b);
    for (let j = 0; j < qs.length; ) {
      let n = j;
      while (n + 1 < qs.length && qs[n + 1] === qs[n] + 1) n++;
      rects.push([at(p, firsts[k]), at(q, qs[j]), at(p, firsts[m] + 1), at(q, qs[n] + 1)]);
      j = n + 1;
    }
    k = m + 1;
  }
  return rects;
}

/** How far from every edge of a rectangle the engraving stays. */
export const marginFor = (depth: number, fit: number) => EDGE_MARGIN + depth + fit;

/** A rectangle shrunk by d all round, or null when nothing is left. */
export function inset(r: Rect, d: number): Rect | null {
  const out: Rect = [r[0] + d, r[1] + d, r[2] - d, r[3] - d];
  return out[2] - out[0] > 1e-6 && out[3] - out[1] > 1e-6 ? out : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Pattern shapes on a flat rectangle

/** An engraved shape: a polygon, or a circle (centre, diameter). */
export type Mark = { pts: P2[] } | { c: P2; d: number };

export const markArea = (m: Mark) => ("pts" in m ? areaOf(m.pts) : (Math.PI * m.d * m.d) / 4);
/** Every corner of a mark (a circle's box), for checks. */
export const markPoints = (m: Mark): P2[] => ("pts" in m ? m.pts : [[m.c[0] - m.d / 2, m.c[1] - m.d / 2], [m.c[0] + m.d / 2, m.c[1] + m.d / 2]]);

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const tidy = (pts: P2[]): P2[] => pts.map(([x, y]) => [r6(x), r6(y)] as P2);

/** The groove width for a repeat of `cell` mm. */
export const grooveWidth = (cell: number) => Math.min(3, Math.max(1, 0.3 * cell));

/** Keep the part of a convex shape inside the rectangle, if at least `share` of it is there and it isn't a sliver. */
function clipped(pts: P2[], r: Rect, least: number, share = 0.3): P2[] | null {
  const full = areaOf(pts);
  const c = clipToBox(pts, r[0], r[1], r[2], r[3]);
  if (c.length < 3) return null;
  const a = areaOf(c);
  if (a < share * full || a < least) return null;
  // Thinner than a groove anywhere it was cut? A sliver along an edge isn't worth printing.
  const xs = c.map((p) => p[0]);
  const ys = c.map((p) => p[1]);
  if (Math.max(...xs) - Math.min(...xs) < 0.8 || Math.max(...ys) - Math.min(...ys) < 0.8) return null;
  return tidy(c);
}

/** Starts of a row of `n` repeats `pitch` apart centred in lo…hi. */
const centred = (lo: number, hi: number, pitch: number) => {
  const n = Math.max(1, Math.floor((hi - lo) / pitch + 1e-9));
  const start = (lo + hi) / 2 - (n * pitch) / 2;
  return { n, start };
};

/**
 * The pattern's shapes inside rectangle r (sketch mm: s along the stick, t across), each repeat `cell` mm; `seed` for
 * the random facets. Shapes never overlap and never leave the rectangle.
 */
export function patternMarks(pattern: SurfacePattern, r: Rect, cell: number, seed: number): Mark[] {
  const [s0, t0, s1, t1] = r;
  const [w, h] = [s1 - s0, t1 - t0];
  if (pattern === "none" || w < 1 || h < 1) return [];
  const g = Math.min(grooveWidth(cell), 0.45 * cell);
  const least = 0.5 * g * g;
  const out: Mark[] = [];
  const poly = (pts: P2[], share = 0.3) => {
    const c = clipped(pts, r, least, share);
    if (c) out.push({ pts: c });
  };
  /** Grooves along s, one per repeat across (or a strip of polygons per groove for wavy ones). */
  const rows = () => {
    const n = Math.max(1, Math.round(h / cell));
    const p = h / n;
    return { p, centres: Array.from({ length: n }, (_, k) => t0 + (k + 0.5) * p), gw: Math.min(g, 0.5 * p) };
  };
  switch (pattern) {
    case "ribs": {
      const { centres, gw } = rows();
      for (const c of centres) poly([[s0, c - gw / 2], [s1, c - gw / 2], [s1, c + gw / 2], [s0, c + gw / 2]], 0);
      break;
    }
    case "rings": {
      const n = Math.max(1, Math.round(w / cell));
      const p = w / n;
      const gw = Math.min(g, 0.5 * p);
      for (let k = 0; k < n; k++) {
        const c = s0 + (k + 0.5) * p;
        poly([[c - gw / 2, t0], [c + gw / 2, t0], [c + gw / 2, t1], [c - gw / 2, t1]], 0);
      }
      break;
    }
    case "spiral": {
      // Grooves slanting at 45°, `cell` apart square to them.
      const step = cell * Math.SQRT2;
      const gw = g * Math.SQRT2;
      const lo = s0 - t1;
      const hi = s1 - t0;
      for (let k = Math.floor(lo / step) - 1; k * step <= hi + step; k++) {
        const a = k * step;
        // The band a ≤ s − t ≤ a + gw, as a parallelogram big enough to cover the rectangle.
        poly([[t0 - h + a, t0 - h], [t0 - h + a + gw, t0 - h], [t1 + h + a + gw, t1 + h], [t1 + h + a, t1 + h]], 0);
      }
      break;
    }
    case "lattice": {
      // Diamonds on a square grid turned 45°, `g` of ridge between them.
      const R = (cell - g * Math.SQRT2) / 2;
      const half = cell / 2;
      const cs = centred(s0, s1, cell);
      const ct = centred(t0, t1, cell);
      for (let i = -1; i <= cs.n + 1; i++)
        for (let j = -1; j <= ct.n + 1; j++)
          for (const off of [0, half]) {
            const [x, y] = [cs.start + half + i * cell + off, ct.start + half + j * cell + off];
            poly([[x + R, y], [x, y + R], [x - R, y], [x, y - R]]);
          }
      break;
    }
    case "honeycomb":
    case "dots": {
      // Rows `cell` · √3/2 apart, every other one moved half a repeat along.
      const rowStep = (cell * Math.sqrt(3)) / 2;
      const cs = centred(s0, s1, cell);
      const ct = centred(t0, t1, rowStep);
      for (let j = -1; j <= ct.n + 1; j++)
        for (let i = -1; i <= cs.n + 1; i++) {
          const x = cs.start + cell / 2 + i * cell + (((j % 2) + 2) % 2 ? cell / 2 : 0);
          const y = ct.start + rowStep / 2 + j * rowStep;
          if (pattern === "dots") {
            const d = 0.72 * cell;
            if (x - d / 2 >= s0 - 1e-9 && x + d / 2 <= s1 + 1e-9 && y - d / 2 >= t0 - 1e-9 && y + d / 2 <= t1 + 1e-9) out.push({ c: [r6(x), r6(y)], d: r6(d) });
          } else {
            // Hexagons standing on a corner (across s), `g` of wall between them.
            const flats = cell - g;
            const rr = flats / Math.sqrt(3);
            poly(Array.from({ length: 6 }, (_, k): P2 => [x + rr * Math.cos(Math.PI / 2 + (Math.PI / 3) * k), y + rr * Math.sin(Math.PI / 2 + (Math.PI / 3) * k)]));
          }
        }
      break;
    }
    case "waves":
    case "chevron": {
      // A groove along s per repeat across, wandering up and down: a sine wave or a zigzag, a repeat and a half long.
      const { p, centres, gw } = rows();
      const amp = Math.max(0, Math.min(0.3 * cell, p / 2 - gw / 2 - 0.4));
      const len = 1.5 * cell;
      const per = pattern === "waves" ? 12 : 2;
      const k0 = Math.floor((s0 - len) / len);
      const k1 = Math.ceil((s1 + len) / len);
      const xs: number[] = [];
      // A zigzag needs corners only at its peaks (a quarter of the way along each half).
      const shift = pattern === "waves" ? 0 : len / 4;
      for (let k = k0 * per; k <= k1 * per; k++) xs.push((k * len) / per + shift);
      const frac = (x: number) => x - Math.floor(x);
      const off = (x: number) => (pattern === "waves" ? amp * Math.sin((2 * Math.PI * x) / len) : amp * (1 - 4 * Math.abs(frac(x / len + 0.25) - 0.5)));
      for (const c of centres) {
        // Cut into straight-ish pieces a quarter of a repeat long, so each is convex enough to clip exactly in s.
        const lower = xs.map((x): P2 => [x, c + off(x) - gw / 2]);
        const upper = xs.map((x): P2 => [x, c + off(x) + gw / 2]);
        const band = clipBandS([...lower, ...upper.reverse()], s0, s1);
        if (band && areaOf(band) >= least) out.push({ pts: tidy(band) });
      }
      break;
    }
    case "basket": {
      // A checkerboard of squares, each with two short grooves, along s and across in turn.
      const cs = centred(s0, s1, cell);
      const ct = centred(t0, t1, cell);
      const gw = Math.min(g, cell / 4);
      for (let i = 0; i < cs.n; i++)
        for (let j = 0; j < ct.n; j++) {
          const [x, y] = [cs.start + i * cell, ct.start + j * cell];
          for (const q of [0.25, 0.75]) {
            const m = gw / 2;
            if ((i + j) % 2 === 0) poly([[x + m, y + q * cell - gw / 2], [x + cell - m, y + q * cell - gw / 2], [x + cell - m, y + q * cell + gw / 2], [x + m, y + q * cell + gw / 2]], 0.6);
            else poly([[x + q * cell - gw / 2, y + m], [x + q * cell + gw / 2, y + m], [x + q * cell + gw / 2, y + cell - m], [x + q * cell - gw / 2, y + cell - m]], 0.6);
          }
        }
      break;
    }
    case "lowpoly": {
      // A grid of points over the rectangle, the inside ones nudged at random; each square split into two triangles
      // one way or the other, and about half of them engraved, shrunk by half a groove.
      const nx = Math.max(1, Math.round(w / cell));
      const ny = Math.max(1, Math.round(h / cell));
      const rnd = seeded(seed * 7919 + nx * 31 + ny);
      const pts: P2[][] = [];
      for (let j = 0; j <= ny; j++) {
        const row: P2[] = [];
        for (let i = 0; i <= nx; i++) {
          const [jx, jy] = [rnd() - 0.5, rnd() - 0.5];
          const x = s0 + (i / nx) * w + (i > 0 && i < nx ? 0.5 * jx * (w / nx) : 0);
          const y = t0 + (j / ny) * h + (j > 0 && j < ny ? 0.5 * jy * (h / ny) : 0);
          row.push([x, y]);
        }
        pts.push(row);
      }
      const shrink = (tri: P2[]): P2[] | null => {
        const [A, B, C] = tri;
        const [a, b, c] = [Math.hypot(B[0] - C[0], B[1] - C[1]), Math.hypot(A[0] - C[0], A[1] - C[1]), Math.hypot(A[0] - B[0], A[1] - B[1])];
        const per = a + b + c;
        const I: P2 = [(a * A[0] + b * B[0] + c * C[0]) / per, (a * A[1] + b * B[1] + c * C[1]) / per];
        const rIn = (2 * areaOf(tri)) / per;
        const k = (rIn - g / 2) / rIn;
        if (rIn - g / 2 < 0.5) return null;
        return tri.map(([x, y]): P2 => [I[0] + (x - I[0]) * k, I[1] + (y - I[1]) * k]);
      };
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const [p00, p10, p01, p11] = [pts[j][i], pts[j][i + 1], pts[j + 1][i], pts[j + 1][i + 1]];
          const tris: P2[][] = rnd() < 0.5 ? [[p00, p10, p11], [p00, p11, p01]] : [[p00, p10, p01], [p10, p11, p01]];
          for (const t of tris) {
            const on = rnd() < 0.5;
            const s = shrink(t);
            if (on && s) poly(s, 0);
          }
        }
      break;
    }
  }
  return out;
}

/** A band running along s (its lower edge then its upper edge back), cut square at s = s0 and s = s1. */
function clipBandS(band: P2[], s0: number, s1: number): P2[] | null {
  const n = band.length / 2;
  const lower = band.slice(0, n);
  const upper = band.slice(n).reverse();
  const cut = (line: P2[]): P2[] => {
    const at = (x: number) => {
      for (let i = 0; i + 1 < line.length; i++)
        if (line[i][0] <= x && line[i + 1][0] >= x) {
          const t = (x - line[i][0]) / (line[i + 1][0] - line[i][0] || 1);
          return [x, line[i][1] + t * (line[i + 1][1] - line[i][1])] as P2;
        }
      return null;
    };
    const a = at(s0);
    const b = at(s1);
    if (!a || !b) return [];
    return [a, ...line.filter((p) => p[0] > s0 + 1e-9 && p[0] < s1 - 1e-9), b];
  };
  const lo = cut(lower);
  const up = cut(upper);
  if (lo.length < 2 || up.length < 2) return null;
  return [...lo, ...up.reverse()];
}

// ---------------------------------------------------------------------------------------------------------------
// A piece's decorations

/** One face's engraving (or the badge): a sketch plane in bed mm and the shapes on it in that plane's (s, t). */
export interface FaceWork {
  face: FaceName;
  /** "engrave" cuts in `depth` from the face; "badge" stands out `depth`; "number" cuts the number into the end. */
  kind: "engrave" | "badge" | "number";
  /** Where the face is (bed mm along its normal), its sketch directions (u × v = the outward normal). */
  at: number;
  origin: V3;
  u: V3;
  v: V3;
  marks: Mark[];
  /** The number's middle and capital height (on ends with numbers). */
  number?: { centre: P2; cap: number; text: string };
  depth: number;
}

/** A face's sketch directions, read from outside (so numbers aren't mirrored): u right, v up, u × v outward. */
export const FACE_UV: Record<FaceName, [V3, V3]> = {
  top: [[1, 0, 0], [0, 1, 0]],
  bed: [[1, 0, 0], [0, -1, 0]],
  front: [[1, 0, 0], [0, 0, 1]],
  back: [[-1, 0, 0], [0, 0, 1]],
  right: [[0, 1, 0], [0, 0, 1]],
  left: [[0, -1, 0], [0, 0, 1]],
};

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The face's place along its outward normal (bed mm) for piece i: the piece is x f…8U−f, y y0+f…y0+2U−f, z 0…2U−2f. */
export function facePlace(face: FaceName, unit: number, y0: number, fit: number): number {
  const U = unit;
  switch (face) {
    case "top":
      return 2 * U - 2 * fit;
    case "bed":
      return 0;
    case "front":
      return -(y0 + fit);
    case "back":
      return y0 + 2 * U - fit;
    case "left":
      return -fit;
    case "right":
      return LENGTH * U - fit;
  }
}

/** A rectangle in bed mm on a face (along its two axes) as a rectangle in the face's sketch (s, t). */
export function rectInSketch(face: FaceName, r: Rect): Rect {
  const [p, q] = faceAxes(face);
  const [u, v] = FACE_UV[face];
  const corner = (a: number, b: number): P2 => {
    const P: V3 = [0, 0, 0];
    P[p] = a;
    P[q] = b;
    return [dot(P, u), dot(P, v)];
  };
  const [c0, c1] = [corner(r[0], r[1]), corner(r[2], r[3])];
  return [Math.min(c0[0], c1[0]), Math.min(c0[1], c1[1]), Math.max(c0[0], c1[0]), Math.max(c0[1], c1[1])];
}

export interface PieceLaid {
  piece: Piece;
  axis: number;
  turn: number;
  min: [number, number];
  y0: number;
}

/** The badge: a diamond (its lower sides at 45°, so it prints standing up) on the end's middle, half-diagonal R. */
export function badgeDiamond(centre: P2, R: number): P2[] {
  const [x, y] = centre;
  return tidy([[x, y - R], [x + R, y], [x, y + R], [x - R, y]]);
}

/** Everything engraved on (or added to) piece i, face by face. */
export function pieceWork(s: BurrSurface, p: PieceLaid, index: number, unit: number, fit: number): FaceWork[] {
  if (isPlain(s)) return [];
  const U = unit;
  const cell = Math.max(LEAST_CELL, (2 * U) / s.repeats);
  const margin = marginFor(s.depth, fit);
  const cells = outsideCells(p.piece, p.axis, p.turn, p.min);
  const out: FaceWork[] = [];
  const order: FaceName[] = ["top", "front", "back", "left", "right"];
  order.forEach((face, fi) => {
    const isEnd = face === "left" || face === "right";
    const style = isEnd ? s.ends : s.pattern === "none" ? "plain" : "pattern";
    if (style === "plain" || (style === "pattern" && s.pattern === "none")) return;
    const at = facePlace(face, U, p.y0, fit);
    const [u, v] = FACE_UV[face];
    const n = FACE_NORMAL[face];
    const plane = (shift: number) => ({ origin: n.map((c) => r6(c * (at + shift))) as V3, u, v });
    const rects = outsideRects(cells[face], face, U, p.y0, fit).map((r) => rectInSketch(face, r));
    if (style === "pattern") {
      const marks = rects.flatMap((r, k) => {
        const inner = inset(r, margin);
        return inner ? patternMarks(s.pattern, inner, cell, s.seed * 131 + index * 17 + fi * 5 + k) : [];
      });
      if (marks.length) out.push({ face, kind: "engrave", at, ...plane(CUT_START), marks, depth: s.depth });
      return;
    }
    // Ends: the piece's number, cut in or on a raised badge.
    const end = rects[0];
    if (!end) return;
    const inner = inset(end, margin);
    if (!inner) return;
    const centre: P2 = [r6((inner[0] + inner[2]) / 2), r6((inner[1] + inner[3]) / 2)];
    const room = Math.min(inner[2] - inner[0], inner[3] - inner[1]);
    const text = String(index + 1);
    if (style === "number") {
      out.push({ face, kind: "number", at, ...plane(CUT_START), marks: [], number: { centre, cap: r6(0.6 * room), text }, depth: s.depth });
      return;
    }
    // The badge reaches the end's inset corners' middle lines; the number fits in the square inside the diamond.
    const R = r6(room / 2);
    out.push({ face, kind: "badge", at, ...plane(-BADGE_ROOT), marks: [{ pts: badgeDiamond(centre, R) }], depth: s.depth });
    out.push({ face, kind: "number", at, ...plane(s.depth + CUT_START), marks: [], number: { centre, cap: r6(0.55 * R), text }, depth: s.depth + BADGE_NUMBER_EXTRA });
  });
  return out;
}

/** How many shapes a piece's engraving has (the number counts as one). */
export const shapeCount = (work: FaceWork[]) => work.reduce((n, w) => n + w.marks.length + (w.number ? 1 : 0), 0);

/** The volume engraved by a face's marks (mm³); text isn't counted here (see textKit's inkArea). */
export const markedVolume = (w: FaceWork) => w.marks.reduce((a, m) => a + markArea(m), 0) * w.depth;

// ---------------------------------------------------------------------------------------------------------------
// Raised badges and the puzzle's moves

/** The pieces with a cube added beyond each end: a raised badge can't be anywhere a cube there couldn't. */
export function withEndCubes(pieces: Piece[]): Piece[] {
  return pieces.map((p, i) => {
    const ax = AXIS[i];
    const extra = p.filter((v) => v[ax] === -LENGTH / 2 || v[ax] === LENGTH / 2 - 1).map((v) => {
      const w = [...v] as V3;
      w[ax] += v[ax] < 0 ? -1 : 1;
      return w;
    });
    return [...p, ...extra];
  });
}

const badgeLevels = new Map<string, number | null>();

/**
 * Does the puzzle still come apart in the same number of moves with something on every end (a whole cube's worth —
 * far more than a badge)? Then badges can never get in the way.
 */
export function badgesFree(pieces: Piece[], level: number, cacheKey: string): boolean {
  let l = badgeLevels.get(cacheKey);
  if (l === undefined) {
    l = disassembly(withEndCubes(pieces));
    badgeLevels.set(cacheKey, l);
  }
  return l === level;
}
