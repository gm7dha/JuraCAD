/**
 * Paths, tracks and roads smoothed to what a printer can draw (pure), once, where the map's lines are put onto a
 * puzzle at its scale — so the grooves, the paint, the previews, the top view and the filament counts all use the very
 * same line.
 *
 * At a puzzle's scale (often 1 mm for 20–50 m) a map's line is full of detail far smaller than a 0.4 mm nozzle: GPS
 * jitter, steps where ways meet, zigzags up a slope and hairpin bends whose legs lie closer than a groove is wide. Pressed
 * and painted as they are they make ragged, blotchy marks. So each line is, in puzzle millimetres:
 *  1. simplified: wiggles under `NOISE` (0.1 mm, a quarter of the nozzle) are dropped;
 *  2. un-folded: where the line comes back within `FOLD` × its groove's width of where it was — the legs of a zigzag or a
 *     switchback, which would leave a ridge between them thinner than a groove (1.5 nozzle widths for a 0.6 mm line) or
 *     none at all — the stretch between is cut short, straight across, as long as it's at most `MOST_FOLD` × the width
 *     long (so real loops round a loch stay);
 *  3. rounded: no bend tighter than `LEAST_RADIUS` × the width (the groove's inside edge then never pinches to a point),
 *     by easing only the points that bend too sharply towards their neighbours, step by step;
 *  4. thinned out again (points closer than `KEEP` off a straight line between their neighbours are dropped).
 * Both ends stay exactly where they were (so lines meeting end to end still meet), and the overall course is kept.
 * Each line keeps its kind, way ids (so paths picked off stay off), name and other fields.
 */
import { grooveOf } from "./groundMarks";
import type { MapFeatures, OsmLineKind } from "./osm";

type XY = [number, number];
type Line = MapFeatures["lines"][number];

/** Wiggles smaller than this (mm on the puzzle) are dropped: a quarter of a 0.4 mm nozzle. */
export const NOISE = 0.1;
/** A line coming back within this many groove widths of itself is folded: the ridge left would be under a width. */
export const FOLD = 2;
/** …if the stretch that comes back is at most this many widths long (longer ones are real loops). */
export const MOST_FOLD = 12;
/** No bend tighter than this many groove widths in radius. */
export const LEAST_RADIUS = 1;
/** Points this close (mm) to the straight line between their neighbours are left out at the end. */
export const KEEP = 0.01;

/** The kinds smoothed: footpaths, tracks and roads (rivers and streams are water, left as they are). */
const SMOOTHED: ReadonlySet<OsmLineKind> = new Set<OsmLineKind>(["path", "track", "road"]);
export const isSmoothed = (l: { kind: OsmLineKind }) => SMOOTHED.has(l.kind);

const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Douglas–Peucker: the points needed to keep within `tol` of the line (ends always kept). */
export function simplifyLine(pts: XY[], tol: number): XY[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a];
    const [dx, dy] = [pts[b][0] - ax, pts[b][1] - ay];
    const L2 = dx * dx + dy * dy;
    let [far, at] = [-1, -1];
    for (let i = a + 1; i < b; i++) {
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / L2)) : 0;
      const d = Math.hypot(pts[i][0] - ax - t * dx, pts[i][1] - ay - t * dy);
      if (d > far) [far, at] = [d, i];
    }
    if (far > tol) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Points every `step` mm or so along the line (its own corners kept, ends exact). */
export function resampleLine(pts: XY[], step: number): XY[] {
  const out: XY[] = [pts[0]];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** Stretches that come back near where they were cut short (see the file's note); `pts` closely spaced. */
export function unfold(pts: XY[], near: number, longest: number): XY[] {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const along = new Float64Array(n);
  for (let i = 1; i < n; i++) along[i] = along[i - 1] + dist(pts[i - 1], pts[i]);
  const cell = near;
  const grid = new Map<string, number[]>();
  pts.forEach(([x, y], i) => {
    const key = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    const list = grid.get(key);
    if (list) list.push(i);
    else grid.set(key, [i]);
  });
  const out: XY[] = [pts[0]];
  let i = 0;
  while (i < n - 1) {
    const [x, y] = pts[i];
    const [ci, cj] = [Math.floor(x / cell), Math.floor(y / cell)];
    let best = -1;
    for (let a = ci - 1; a <= ci + 1; a++)
      for (let b = cj - 1; b <= cj + 1; b++)
        for (const j of grid.get(`${a},${b}`) ?? []) {
          if (j <= i || j <= best) continue;
          const arc = along[j] - along[i];
          // Came back: much further along the line than across to it, and not a real loop.
          if (arc > 2 * near && arc <= longest && dist(pts[i], pts[j]) < near) best = j;
        }
    i = best > 0 ? best : i + 1;
    out.push(pts[i]);
  }
  return out;
}

/**
 * Eases bends tighter than `radius` (mm), `pts` spaced about `step` apart: each pass moves every point that bends too
 * sharply, and its neighbours, half way towards the middle of the two beside it — the ends never move.
 */
export function roundBends(pts: XY[], radius: number, step: number, passes = 400): XY[] {
  let p = pts.map((q) => [q[0], q[1]] as XY);
  if (p.length < 3) return p;
  for (let pass = 0; pass < passes; pass++) {
    const n = p.length;
    const tight = new Uint8Array(n);
    let any = false;
    for (let i = 1; i + 1 < n; i++) {
      const [ux, uy] = [p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]];
      const [vx, vy] = [p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]];
      const lu = Math.hypot(ux, uy);
      const lv = Math.hypot(vx, vy);
      if (lu < 1e-12 || lv < 1e-12) continue;
      const turn = Math.atan2(Math.abs(ux * vy - uy * vx), ux * vx + uy * vy);
      // The radius of the bend here: half the two pieces' length over the turn.
      if (turn > 1e-9 && ((lu + lv) / 2) / turn < radius * 0.999) {
        any = true;
        for (let k = Math.max(1, i - 2); k <= Math.min(n - 2, i + 2); k++) tight[k] = 1;
      }
    }
    if (!any) break;
    const next = p.map((q) => [q[0], q[1]] as XY);
    for (let i = 1; i + 1 < n; i++)
      if (tight[i]) {
        next[i][0] = (p[i][0] + (p[i - 1][0] + p[i + 1][0]) / 2) / 2;
        next[i][1] = (p[i][1] + (p[i - 1][1] + p[i + 1][1]) / 2) / 2;
      }
    p = next;
    // Keep the points evenly spread as the line straightens (every few passes).
    if (pass % 8 === 7) p = resampleLine(simplifyLine(p, step / 50), step);
    if (p.length < 3) break;
  }
  return p;
}

/** One line (puzzle mm) smoothed for a groove `width` mm wide. */
export function smoothLine(pts: XY[], width: number): XY[] {
  const clean = pts.filter((q, i) => i === 0 || dist(q, pts[i - 1]) > 1e-9);
  if (clean.length < 3) return clean;
  const step = width / 4;
  let p = simplifyLine(clean, NOISE);
  p = unfold(resampleLine(p, step), FOLD * width, MOST_FOLD * width);
  p = roundBends(resampleLine(p, step), LEAST_RADIUS * width, step);
  p = simplifyLine(p, KEEP);
  // The ends exactly as they were.
  p[0] = clean[0];
  p[p.length - 1] = clean[clean.length - 1];
  return p;
}

const cache = new WeakMap<MapFeatures, Map<number, MapFeatures>>();

/**
 * The features with their paths, tracks and roads smoothed at `k` mm per metre (OS grid metres in and out). Nothing to
 * smooth = the same object; the same features and scale give the same object again (cached).
 */
export function smoothedFeatures(f: MapFeatures, k: number): MapFeatures {
  if (!f.lines.some(isSmoothed) || !(k > 0)) return f;
  let byK = cache.get(f);
  if (!byK) cache.set(f, (byK = new Map()));
  const hit = byK.get(k);
  if (hit) return hit;
  const lines = f.lines.map((l): Line => {
    if (!isSmoothed(l) || l.pts.length < 3) return l;
    const [e0, n0] = l.pts[0];
    const mm = l.pts.map(([e, n]): XY => [(e - e0) * k, (n - n0) * k]);
    const done = smoothLine(mm, grooveOf(l).width).map(([x, y]): XY => [e0 + x / k, n0 + y / k]);
    done[0] = l.pts[0];
    done[done.length - 1] = l.pts[l.pts.length - 1];
    return { ...l, pts: done };
  });
  const out = { ...f, lines };
  byK.set(k, out);
  return out;
}
