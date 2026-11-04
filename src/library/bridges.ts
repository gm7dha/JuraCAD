/**
 * Stencil bridges. Cut letters out of a sheet and the middles of O, A, B, D,
 * P, R, 4, 6, 8, 9, 0… (the "islands") would fall out. A stencil keeps them
 * with bridges: thin strips of sheet left uncut, joining each island across
 * the letter's stroke to the sheet round it (or to another island that is
 * itself held).
 *
 * Done by geometry, for any font: the letters are closed outlines (holes
 * included); an outline inside an odd number of others is an island. For each
 * island, strips of the bridge's width are tried going up, down, left and
 * right from it, at many places across it; a strip is good when, all the way
 * across its width, it starts inside the island, crosses exactly one stroke of
 * letter and ends in solid sheet (or another island) — so it never crosses
 * into any other letter. Upright strips are preferred (as on most stencils),
 * then the shortest. Pure: no sketch or engine.
 */

export type Pt = [number, number];

export interface Bridge {
  /** The strip, as an upright box [x0, y0, x1, y1] (mm). */
  box: [number, number, number, number];
  /** Which outline (index into the contours) it holds. */
  island: number;
  /** What it joins the island to: the sheet, or another island's outline. */
  to: "sheet" | number;
  /** Which way it goes from the island. */
  dir: Direction;
}

export type Direction = "up" | "down" | "left" | "right";

export interface BridgePlan {
  bridges: Bridge[];
  /** The outlines that are islands. */
  islands: number[];
  /** Islands no bridge could hold (they'd fall out). */
  unheld: number[];
}

export interface BridgeOptions {
  /** How wide each bridge is (mm). */
  width: number;
  /** Bridges per island: 1, or 2 (on opposite sides, steadier for big letters). */
  perIsland?: 1 | 2;
}

/** How many lines across a strip's width are checked. */
const LINES = 9;
/** How many places across an island are tried, per direction. */
const PLACES = 25;

// Each direction as a turn that makes it "up" (+y), and back.
const TURN: Record<Direction, { to: (p: Pt) => Pt; back: (p: Pt) => Pt }> = {
  up: { to: (p) => p, back: (p) => p },
  down: { to: ([x, y]) => [-x, -y], back: ([x, y]) => [-x, -y] },
  left: { to: ([x, y]) => [y, -x], back: ([x, y]) => [-y, x] },
  right: { to: ([x, y]) => [-y, x], back: ([x, y]) => [y, -x] },
};
const OPPOSITE: Record<Direction, Direction> = { up: "down", down: "up", left: "right", right: "left" };

export function insidePolygon(p: Pt, poly: Pt[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** How many other outlines each outline is inside (even = a letter's outside, odd = an island). */
export function depths(contours: Pt[][]): number[] {
  return contours.map((c, i) => contours.filter((d, j) => j !== i && insidePolygon(c[0], d)).length);
}

/**
 * What's at a point of the stencil: null in a hole (cut away), else "sheet" or the island (outline index) it's on.
 */
export function stencilAt(contours: Pt[][], depth: number[], p: Pt): "sheet" | number | null {
  let count = 0;
  let deepest = -1;
  contours.forEach((c, i) => {
    if (!insidePolygon(p, c)) return;
    count++;
    if (deepest < 0 || depth[i] > depth[deepest]) deepest = i;
  });
  if (count % 2 === 1) return null;
  return count === 0 ? "sheet" : deepest;
}

interface Crossing {
  y: number;
  c: number;
}

/** Where the upright line x = X crosses the outlines (only those listed in `only`), bottom to top. */
function crossings(contours: Pt[][], X: number, only: number[]): Crossing[] {
  const out: Crossing[] = [];
  only.forEach((c) => {
    const poly = contours[c];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (a[0] > X === b[0] > X) continue;
      out.push({ y: a[1] + ((X - a[0]) * (b[1] - a[1])) / (b[0] - a[0]), c });
    }
  });
  return out.sort((p, q) => p.y - q.y);
}

/** Does the segment a–b touch the inside of the box? (Liang–Barsky clipping.) */
function segmentInBox(a: Pt, b: Pt, [x0, y0, x1, y1]: [number, number, number, number]): boolean {
  let t0 = 0;
  let t1 = 1;
  const d: Pt = [b[0] - a[0], b[1] - a[1]];
  const edges: [number, number][] = [
    [-d[0], a[0] - x0],
    [d[0], x1 - a[0]],
    [-d[1], a[1] - y0],
    [d[1], y1 - a[1]],
  ];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-15) {
      if (q <= 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 >= t1) return false;
  }
  return true;
}

interface Candidate extends Bridge {
  score: number;
}

/** The strips going up from island `k` (in a turned copy of the outlines), best first. */
function stripsUp(turned: Pt[][], depth: number[], k: number, width: number): Omit<Candidate, "dir">[] {
  const island = turned[k];
  const xs = island.map((p) => p[0]);
  const [lo, hi] = [Math.min(...xs), Math.max(...xs)];
  const room = hi - lo - width;
  if (!(room > width * 0.05)) return [];
  const half = width / 2;
  const mid = (lo + hi) / 2;
  // Only outlines reaching across the island's width can cross a strip from it.
  const near = turned.map((_, i) => i).filter((i) => turned[i].some((p) => p[0] >= lo - width) && turned[i].some((p) => p[0] <= hi + width));
  const out: Omit<Candidate, "dir">[] = [];
  for (let j = 0; j < PLACES; j++) {
    const x = lo + half + width * 0.025 + ((room - width * 0.05) * j) / (PLACES - 1);
    let top = Infinity; // lowest top of the island across the strip
    let bottom = -Infinity; // highest bottom of the island's top stretch
    let reachLo = -Infinity; // highest point where the stroke ends
    let reachHi = Infinity; // lowest next crossing beyond it
    let target: number | null = null;
    let stroke = 0;
    let ok = true;
    const lines: { xs: number; list: Crossing[]; at: number }[] = [];
    for (let l = 0; l < LINES && ok; l++) {
      const X = x - half + (width * l) / (LINES - 1) + (l === 0 ? 1e-7 : l === LINES - 1 ? -1e-7 : 0);
      const list = crossings(turned, X, near);
      // The island's topmost stretch on this line.
      const own = list.map((c, i) => ({ ...c, i })).filter((c) => c.c === k);
      if (own.length < 2) {
        ok = false;
        break;
      }
      const end = own[own.length - 1];
      const start = own[own.length - 2];
      const next = list[end.i + 1];
      if (!next) {
        ok = false;
        break;
      }
      if (target === null) target = next.c;
      else if (target !== next.c) ok = false;
      const after = list[end.i + 2];
      top = Math.min(top, end.y);
      bottom = Math.max(bottom, start.y);
      reachLo = Math.max(reachLo, next.y);
      reachHi = Math.min(reachHi, after ? after.y : Infinity);
      stroke += next.y - end.y;
      lines.push({ xs: X, list, at: end.i });
    }
    if (!ok || target === null || !(top - bottom > 1e-6) || !(reachHi - reachLo > 1e-6) || !(top < reachLo)) continue;
    const ya = top - Math.min(width, (top - bottom) / 2);
    const yb = reachLo + Math.min(width, Number.isFinite(reachHi) ? (reachHi - reachLo) / 2 : width);
    // Exactly two crossings (out of the island, out of the stroke) on every line across the strip.
    if (!lines.every((ln) => ln.list.filter((c) => c.y > ya && c.y < yb).length === 2)) continue;
    // What's at the far end must be the sheet, or the island the strip reaches.
    const there = stencilAt(turned, depth, [x, yb]);
    if (there === null) continue;
    const to: "sheet" | number = there;
    if (to === k) continue;
    const box: [number, number, number, number] = [x - half, ya, x + half, yb];
    // No other outline may come into the strip (between the lines checked).
    const crossed = new Set([k, target]);
    const clear = near.every((c) => crossed.has(c) || turned[c].every((p, i, poly) => !segmentInBox(p, poly[(i + 1) % poly.length], box)));
    if (!clear) continue;
    out.push({ box, island: k, to, score: stroke / LINES + (Math.abs(x - mid) / Math.max(1e-9, hi - lo)) * 0.1 + (to === "sheet" ? 0 : 100) });
  }
  return out.sort((a, b) => a.score - b.score);
}

/** Every good strip for an island, in every direction, best first (upright before sideways). */
function candidates(contours: Pt[][], depth: number[], k: number, width: number): Candidate[] {
  const out: Candidate[] = [];
  for (const dir of ["up", "down", "left", "right"] as Direction[]) {
    const t = TURN[dir];
    const turned = contours.map((c) => c.map(t.to));
    for (const s of stripsUp(turned, depth, k, width)) {
      const corners = [
        [s.box[0], s.box[1]],
        [s.box[2], s.box[3]],
      ].map((p) => t.back(p as Pt));
      const box: [number, number, number, number] = [
        Math.min(corners[0][0], corners[1][0]),
        Math.min(corners[0][1], corners[1][1]),
        Math.max(corners[0][0], corners[1][0]),
        Math.max(corners[0][1], corners[1][1]),
      ];
      out.push({ ...s, box, dir, score: s.score + (dir === "left" || dir === "right" ? 1000 : 0) });
    }
  }
  return out.sort((a, b) => a.score - b.score);
}

/** Bridges for a stencil of these letter outlines (closed polygons, holes included). */
export function planBridges(contours: Pt[][], opts: BridgeOptions): BridgePlan {
  const depth = depths(contours);
  const islands = contours.map((_, i) => i).filter((i) => depth[i] % 2 === 1);
  const bridges: Bridge[] = [];
  for (const k of islands) {
    const all = candidates(contours, depth, k, opts.width);
    const best = all[0];
    if (!best) continue;
    bridges.push(strip(best));
    if (opts.perIsland === 2) {
      // The second on the other side, and not touching the first.
      const other = all.find((c) => c.dir === OPPOSITE[best.dir] && !overlaps(c.box, best.box)) ?? all.find((c) => c.dir !== best.dir && !overlaps(c.box, best.box));
      if (other) bridges.push(strip(other));
    }
  }
  return { bridges, islands, unheld: unheldIslands(islands, bridges) };
}

const strip = (c: Candidate): Bridge => ({ box: c.box.map((v) => Math.round(v * 1e6) / 1e6) as Bridge["box"], island: c.island, to: c.to, dir: c.dir });

const overlaps = (a: Bridge["box"], b: Bridge["box"]) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/** Islands not joined to the sheet, directly or through other islands. */
export function unheldIslands(islands: number[], bridges: Bridge[]): number[] {
  const held = new Set<number>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of bridges) {
      if (held.has(b.island)) {
        if (typeof b.to === "number" && !held.has(b.to)) {
          held.add(b.to);
          grew = true;
        }
        continue;
      }
      if (b.to === "sheet" || held.has(b.to)) {
        held.add(b.island);
        grew = true;
      }
    }
  }
  return islands.filter((k) => !held.has(k));
}
