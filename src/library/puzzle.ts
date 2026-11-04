/**
 * The maths of a jigsaw puzzle (pure, no geometry engine): a grid of pieces whose edges between neighbours each carry
 * one classic round tab, made of three arcs that meet smoothly (a shoulder, the head, a shoulder), so the cut is one
 * flowing curve the laser follows without corners.
 *
 * A tab on an edge `L` long, seen with the edge along u and the tab poking out towards +w:
 *  - the head is a circle of radius R centred at (c, h), h = HEAD_RISE × R above the edge;
 *  - each shoulder is a circle of radius s = SHOULDER × R sitting on the edge (centre (c ∓ d, s)), touching the head
 *    from outside, so d = √((R + s)² − (h − s)²);
 *  - the neck (narrowest part, at height s) is 2(d − s) wide and the head 2R: with these shares the neck is 0.618 of
 *    the head, so the tab locks — it can't be pulled out sideways in the plane.
 * The tab is h + R = TAB_RISE × R tall. Which way each tab points, where along its edge it sits and how big it is are
 * chosen by a small seeded random number maker, so the same seed always gives the same puzzle.
 */

export type P2 = [number, number];

/** The head's centre is this many head radii above the edge. */
export const HEAD_RISE = 1.5;
/** The shoulder circles' radius, as a share of the head's. */
export const SHOULDER = 0.5;
/** A tab's height as a share of its head's radius (h + R). */
export const TAB_RISE = HEAD_RISE + 1;
/** Half the tab's foot (d) as a share of the head's radius. */
export const FOOT = Math.sqrt((1 + SHOULDER) ** 2 - (HEAD_RISE - SHOULDER) ** 2);
/** Half the neck (d − s) as a share of the head's radius. */
export const NECK = FOOT - SHOULDER;
/** How far (as a share of the edge) a tab may wander either side of the edge's middle. */
export const WANDER = 0.06;
/** How much a tab's size may vary either way (a share of its size). */
export const SIZE_SPREAD = 0.1;
/** The most pieces a puzzle may have (each edge is five curves; more makes a slow sketch). */
export const MAX_PIECES = 400;

/** A small, fast random number maker (mulberry32): the same seed gives the same numbers, 0 ≤ n < 1. */
export function seeded(seed: number): () => number {
  let a = Math.floor(seed) >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One arc, as the sketch keeps them: anticlockwise from `start` to `end` round `centre`. */
export interface Arc {
  centre: P2;
  start: P2;
  end: P2;
  r: number;
}

/** One edge between two pieces: from one grid corner to the next, with its tab. */
export interface PuzzleEdge {
  from: P2;
  to: P2;
  /** Tab: +1 pokes out to the left of from → to, −1 to the right. */
  side: 1 | -1;
  /** Where the tab's middle is along the edge (mm from `from`). */
  at: number;
  /** The head's radius. */
  R: number;
  /** The curves, in order from `from` to `to`: a line, three arcs (shoulder, head, shoulder), a line. */
  start: P2;
  arcs: [Arc, Arc, Arc];
  /** Where each piece of the edge starts and ends, in order: from, shoulder, (two tangent points), shoulder end, to. */
  points: [P2, P2, P2, P2, P2, P2];
}

export interface PuzzleSpec {
  width: number;
  height: number;
  rows: number;
  columns: number;
  /** A tab's height as a share of the smaller piece side (0.25 = a quarter). */
  tab: number;
  seed: number;
}

export interface Puzzle {
  spec: PuzzleSpec;
  /** Piece size. */
  pw: number;
  ph: number;
  /** Edges between rows (running along x): [row 1…rows−1][column]. */
  across: PuzzleEdge[][];
  /** Edges between columns (running along y): [column 1…columns−1][row]. */
  down: PuzzleEdge[][];
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const r6 = (p: P2): P2 => [round6(p[0]), round6(p[1])];

/** A tab on an edge, in its own frame turned into place. */
export function tabEdge(from: P2, to: P2, side: 1 | -1, at: number, R: number): PuzzleEdge {
  const L = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const e: P2 = [(to[0] - from[0]) / L, (to[1] - from[1]) / L];
  const n: P2 = [-e[1], e[0]];
  const place = (u: number, w: number): P2 => r6([from[0] + u * e[0] + side * w * n[0], from[1] + u * e[1] + side * w * n[1]]);
  const [s, h, d] = [SHOULDER * R, HEAD_RISE * R, FOOT * R];
  // The tangent points: on the line between each shoulder's centre and the head's centre, s from the shoulder's.
  const k = s / (R + s);
  const t1: [number, number] = [at - d + k * d, s + k * (h - s)];
  const t2: [number, number] = [at + d - k * d, s + k * (h - s)];
  const foot1 = place(at - d, 0);
  const foot2 = place(at + d, 0);
  const T1 = place(...t1);
  const T2 = place(...t2);
  // Seen with the tab to the left (side +1), the left shoulder runs anticlockwise from its foot to T1, the head
  // anticlockwise from T2 over the top to T1, the right shoulder anticlockwise from T2 to its foot. Mirrored (side −1)
  // each runs the other way round, so its start and end swap.
  const arc = (c: P2, a: P2, b: P2, r: number): Arc => (side === 1 ? { centre: c, start: a, end: b, r } : { centre: c, start: b, end: a, r });
  return {
    from: r6(from),
    to: r6(to),
    side,
    at,
    R,
    start: r6(from),
    arcs: [arc(place(at - d, s), foot1, T1, s), arc(place(at, h), T2, T1, R), arc(place(at + d, s), T2, foot2, s)],
    points: [r6(from), foot1, T1, T2, foot2, r6(to)],
  };
}

/** The whole puzzle's edges, worked out from the seed. */
export function makePuzzle(spec: PuzzleSpec): Puzzle {
  const { width: W, height: H, rows, columns: cols } = spec;
  const pw = W / cols;
  const ph = H / rows;
  const P = Math.min(pw, ph);
  const rand = seeded(spec.seed);
  const one = (from: P2, to: P2, L: number): PuzzleEdge => {
    const side = rand() < 0.5 ? 1 : -1;
    const at = L * (0.5 + (rand() * 2 - 1) * WANDER);
    const R = ((spec.tab * P) / TAB_RISE) * (1 + (rand() * 2 - 1) * SIZE_SPREAD);
    return tabEdge(from, to, side, at, R);
  };
  const across: PuzzleEdge[][] = [];
  for (let r = 1; r < rows; r++) across.push(Array.from({ length: cols }, (_, c) => one([c * pw, r * ph], [(c + 1) * pw, r * ph], pw)));
  const down: PuzzleEdge[][] = [];
  for (let c = 1; c < cols; c++) down.push(Array.from({ length: rows }, (_, r) => one([c * pw, r * ph], [c * pw, (r + 1) * ph], ph)));
  return { spec, pw, ph, across, down };
}

/** Angle of a point round a centre, 0…2π. */
const angleOf = (c: P2, p: P2) => {
  const a = Math.atan2(p[1] - c[1], p[0] - c[0]);
  return a < 0 ? a + 2 * Math.PI : a;
};

/** Points along an arc (anticlockwise start → end), `n` pieces. */
export function arcPoints(a: Arc, n = 16): P2[] {
  const a0 = angleOf(a.centre, a.start);
  let a1 = angleOf(a.centre, a.end);
  if (a1 <= a0 + 1e-12) a1 += 2 * Math.PI;
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = a0 + ((a1 - a0) * i) / n;
    return [a.centre[0] + a.r * Math.cos(t), a.centre[1] + a.r * Math.sin(t)] as P2;
  });
}

/** An edge as a polyline from `from` to `to` (for previews and checks). */
export function edgePolyline(e: PuzzleEdge, n = 16): P2[] {
  const out: P2[] = [e.from, e.points[1]];
  for (const a of e.arcs) {
    const pts = arcPoints(a, n);
    // Each arc's points run anticlockwise; put them in the edge's order (they start where the last piece ended).
    const last = out[out.length - 1];
    const forward = Math.hypot(pts[0][0] - last[0], pts[0][1] - last[1]) < Math.hypot(pts[n][0] - last[0], pts[n][1] - last[1]);
    out.push(...(forward ? pts : pts.reverse()).slice(1));
  }
  out.push(e.to);
  return out;
}

/** Every edge between pieces. */
export const allEdges = (p: Puzzle): PuzzleEdge[] => [...p.across.flat(), ...p.down.flat()];

/** The four edges round a piece (row r from the bottom, column c from the left) as polylines, null on the border. */
export function pieceEdges(p: Puzzle, r: number, c: number, line: (e: PuzzleEdge) => P2[] = (e) => edgePolyline(e)): (P2[] | null)[] {
  const { rows, columns } = p.spec;
  return [
    r > 0 ? line(p.across[r - 1][c]) : null,
    c < columns - 1 ? line(p.down[c][r]) : null,
    r < rows - 1 ? line(p.across[r][c]) : null,
    c > 0 ? line(p.down[c - 1][r]) : null,
  ];
}

/** A piece's outline (anticlockwise, from its bottom-left corner), as a polygon. */
export function pieceOutline(p: Puzzle, r: number, c: number): P2[] {
  const [x0, y0, x1, y1] = [c * p.pw, r * p.ph, (c + 1) * p.pw, (r + 1) * p.ph];
  const [bottom, right, top, left] = pieceEdges(p, r, c);
  const out: P2[] = [];
  out.push(...(bottom ?? [[x0, y0], [x1, y0]] as P2[]).slice(0, -1));
  out.push(...(right ?? [[x1, y0], [x1, y1]] as P2[]).slice(0, -1));
  // The top and left edges run left → right and bottom → top: walk them backwards.
  out.push(...[...(top ?? [[x0, y1], [x1, y1]] as P2[])].reverse().slice(0, -1));
  out.push(...[...(left ?? [[x0, y0], [x0, y1]] as P2[])].reverse().slice(0, -1));
  return out;
}

function segmentsCross(a: P2, b: P2, c: P2, d: P2): boolean {
  const cross = (o: P2, p: P2, q: P2) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

type Box = [number, number, number, number];
const boxOf = (pts: P2[]): Box => pts.reduce<Box>((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
const boxGap = (a: Box, b: Box) => Math.max(0, a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3]);

/**
 * The smallest distance between two polylines, leaving out a stretch `skip` long round a corner they share. Pieces
 * farther apart than `enough` aren't measured (the answer is then at least `enough`).
 */
function closest(a: P2[], b: P2[], skip: number, enough: number): number {
  const shared = [a[0], a[a.length - 1]].find((p) => [b[0], b[b.length - 1]].some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6));
  const away = (p: P2) => !shared || Math.hypot(p[0] - shared[0], p[1] - shared[1]) > skip;
  const [ba, bb] = [boxOf(a), boxOf(b)];
  if (boxGap(ba, bb) >= enough) return enough;
  let best = enough;
  for (let i = 0; i + 1 < a.length; i++) {
    if (!(away(a[i]) && away(a[i + 1]))) continue;
    const sa = boxOf([a[i], a[i + 1]]);
    if (boxGap(sa, bb) >= best) continue;
    for (let j = 0; j + 1 < b.length; j++) {
      if (!(away(b[j]) && away(b[j + 1]))) continue;
      if (boxGap(sa, boxOf([b[j], b[j + 1]])) >= best) continue;
      if (segmentsCross(a[i], a[i + 1], b[j], b[j + 1])) return 0;
      for (const [p, q, r] of [[a[i], b[j], b[j + 1]], [a[i + 1], b[j], b[j + 1]], [b[j], a[i], a[i + 1]], [b[j + 1], a[i], a[i + 1]]] as [P2, P2, P2][]) best = Math.min(best, pointSegment(p, q, r));
    }
  }
  return best;
}

function pointSegment(p: P2, a: P2, b: P2): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** The narrowest gap the laser must leave between two cuts of a piece: below this a piece's corner snaps off. */
export const MIN_GAP = 1.5;

/**
 * The smallest gap between any two cuts round any piece (mm; 0 where they cross) — and between a tab and the
 * puzzle's border. Pieces never overlap while this is more than 0.
 */
export function narrowestGap(p: Puzzle, enough = Infinity): number {
  let best = enough;
  const { rows, columns } = p.spec;
  const [W, H] = [p.spec.width, p.spec.height];
  const lines = new Map<PuzzleEdge, P2[]>();
  const line = (e: PuzzleEdge) => lines.get(e) ?? (lines.set(e, edgePolyline(e)), lines.get(e)!);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < columns; c++) {
      const edges = pieceEdges(p, r, c, line);
      for (let i = 0; i < 4; i++)
        for (let j = i + 1; j < 4; j++) {
          const [a, b] = [edges[i], edges[j]];
          if (!a || !b) continue;
          // Edges meeting at a corner leave it at right angles: skip the first part of each, along the grid lines.
          best = Math.min(best, closest(a, b, Math.min(p.pw, p.ph) * 0.05, best));
        }
    }
  // Tabs next to the border: none may reach it.
  for (const e of allEdges(p))
    for (const [x, y] of line(e).slice(1, -1)) best = Math.min(best, x, y, W - x, H - y);
  return best;
}

/** The tab's widest (the head) and narrowest (the neck) widths, measured across the tab, mm. */
export function tabWidths(e: PuzzleEdge): { head: number; neck: number } {
  return { head: 2 * e.R, neck: 2 * NECK * e.R };
}

/** What's wrong with these puzzle sizes (plain English). */
export function puzzleProblems(spec: PuzzleSpec): string[] {
  const out: string[] = [];
  if (spec.rows * spec.columns > MAX_PIECES) out.push(`That's ${spec.rows * spec.columns} pieces: at most ${MAX_PIECES}.`);
  if (spec.rows * spec.columns < 2) out.push("A puzzle needs at least 2 pieces.");
  if (out.length) return out;
  const pw = spec.width / spec.columns;
  const ph = spec.height / spec.rows;
  if (Math.max(pw, ph) / Math.min(pw, ph) > 2.5) out.push(`The pieces would be ${Math.round(pw)} × ${Math.round(ph)} mm — very long and thin. Change the rows or columns so they're closer to square.`);
  if (Math.min(pw, ph) < 10) out.push(`The pieces would be only ${Math.round(Math.min(pw, ph) * 10) / 10} mm across: use fewer rows or columns (at least 10 mm a piece).`);
  if (out.length) return out;
  const gap = narrowestGap(makePuzzle(spec), MIN_GAP);
  if (gap < MIN_GAP) out.push(`Some tabs come too close to each other (${Math.round(gap * 10) / 10} mm): make the tabs smaller or try another pattern number.`);
  return out;
}
