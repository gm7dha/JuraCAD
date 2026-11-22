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

/** Corners are found to this (mm) before they're rounded with arcs. */
const CORNER_TOLERANCE = 0.02;
/** Arcs put in a little wider than the least radius, so the bend check that follows passes them as they are. */
const ARC_ROOM = 1.01;
/** Arcs are drawn with chords this many radians apart. */
const ARC_CHORD = Math.PI / 36;

/**
 * Corners tighter than `radius` rounded with a true arc of that radius where the arc's ends fit on the pieces either
 * side (shared with the next corner's): a switchback's U-turn becomes two quarter circles and its legs keep their length
 * — easing points step by step instead (`roundBends`) shrinks a U barely wider than two radii back along its legs.
 * Corners whose arc doesn't fit are left for `roundBends`.
 */
export function filletCorners(pts: XY[], radius: number, step: number): XY[] {
  const p = simplifyLine(pts, CORNER_TOLERANCE);
  const n = p.length;
  if (n < 3) return pts.slice();
  const R = radius * ARC_ROOM;
  const turn = new Float64Array(n);
  const want = new Float64Array(n);
  for (let i = 1; i + 1 < n; i++) {
    const [ux, uy] = [p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]];
    const [vx, vy] = [p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]];
    const [lu, lv] = [Math.hypot(ux, uy), Math.hypot(vx, vy)];
    if (lu < 1e-12 || lv < 1e-12) continue;
    turn[i] = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const a = Math.abs(turn[i]);
    // Too sharp once the line is spread out `step` apart (as roundBends measures it), and not turning right back (a
    // hairpin's arc never fits).
    if (a > 1e-9 && Math.min(step, (lu + lv) / 2) / a < radius && a < Math.PI * 0.95) want[i] = R * Math.tan(a / 2);
  }
  // Greedy from the start: an arc goes in when its ends fit on both pieces beside it with the arcs already put in.
  const used = new Float64Array(n);
  for (let i = 1; i + 1 < n; i++) {
    if (!want[i]) continue;
    const before = dist(p[i - 1], p[i]) - used[i - 1];
    const after = dist(p[i], p[i + 1]);
    if (want[i] <= before + 1e-12 && want[i] <= after + 1e-12) used[i] = want[i];
  }
  // A later corner may have no room left beside an earlier one: check the pieces again from the far side.
  for (let i = n - 2; i >= 1; i--) if (used[i] && used[i] + used[i + 1] > dist(p[i], p[i + 1]) + 1e-12) used[i] = 0;
  const out: XY[] = [p[0]];
  for (let i = 1; i + 1 < n; i++) {
    if (!used[i]) {
      out.push(p[i]);
      continue;
    }
    const t = used[i];
    const u: XY = [(p[i][0] - p[i - 1][0]) / dist(p[i - 1], p[i]), (p[i][1] - p[i - 1][1]) / dist(p[i - 1], p[i])];
    const side = Math.sign(turn[i]);
    const start: XY = [p[i][0] - u[0] * t, p[i][1] - u[1] * t];
    // The centre: R to the inside of the incoming piece at the arc's start.
    const c: XY = [start[0] - side * u[1] * R, start[1] + side * u[0] * R];
    const a0 = Math.atan2(start[1] - c[1], start[0] - c[0]);
    const k = Math.max(1, Math.ceil(Math.abs(turn[i]) / ARC_CHORD));
    for (let q = 0; q <= k; q++) {
      const a = a0 + (turn[i] * q) / k;
      out.push([c[0] + R * Math.cos(a), c[1] + R * Math.sin(a)]);
    }
  }
  out.push(p[n - 1]);
  return out.filter((q, i) => i === 0 || dist(q, out[i - 1]) > 1e-9);
}

/** Is the bend at point i tighter than `radius` (as `roundBends` measures it)? */
function tightAt(p: XY[], i: number, radius: number): boolean {
  const [ux, uy] = [p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]];
  const [vx, vy] = [p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]];
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (lu < 1e-12 || lv < 1e-12) return false;
  const turn = Math.atan2(Math.abs(ux * vy - uy * vx), ux * vx + uy * vy);
  return turn > 1e-9 && (lu + lv) / 2 / turn < radius * 0.999;
}

/** Points either side of a tight bend eased with it (`roundBends` on just that stretch, its ends held). */
const ROUND_REACH = 40;

/**
 * `roundBends` on only the stretches round the bends still too tight (each ± `ROUND_REACH` points, ends held), so a long
 * line with a few sharp spots isn't walked over and over end to end. The same line back when nothing is too tight.
 */
function roundTight(p: XY[], radius: number, step: number): XY[] {
  const n = p.length;
  const spans: [number, number][] = [];
  for (let i = 1; i + 1 < n; i++)
    if (tightAt(p, i, radius)) {
      const [a, b] = [Math.max(0, i - ROUND_REACH), Math.min(n - 1, i + ROUND_REACH)];
      if (spans.length && a <= spans[spans.length - 1][1]) spans[spans.length - 1][1] = b;
      else spans.push([a, b]);
    }
  if (!spans.length) return p;
  const out: XY[] = [];
  let at = 0;
  for (const [a, b] of spans) {
    for (let i = at; i < a; i++) out.push(p[i]);
    const r = roundBends(p.slice(a, b + 1), radius, step);
    for (let i = 0; i + 1 < r.length; i++) out.push(r[i]);
    at = b;
  }
  for (let i = at; i < n; i++) out.push(p[i]);
  return out;
}

/** `roundTight` until nothing is too tight (a few rounds), else `roundBends` on the whole line. */
function roundAll(p: XY[], radius: number, step: number): XY[] {
  for (let round = 0; round < 3; round++) {
    const next = roundTight(p, radius, step);
    if (next === p) return p;
    p = next;
  }
  return roundBends(p, radius, step);
}

/** One line (puzzle mm) smoothed for a groove `width` mm wide. */
export function smoothLine(pts: XY[], width: number): XY[] {
  const clean = pts.filter((q, i) => i === 0 || dist(q, pts[i - 1]) > 1e-9);
  if (clean.length < 3) return clean;
  const step = width / 4;
  let p = simplifyLine(clean, NOISE);
  // A line that closes on itself (round a loch) isn't folded across its own closing: only stretches up to half way round.
  let total = 0;
  for (let i = 1; i < p.length; i++) total += dist(p[i - 1], p[i]);
  const closed = dist(clean[0], clean[clean.length - 1]) < FOLD * width;
  p = unfold(resampleLine(p, step), FOLD * width, closed ? Math.min(MOST_FOLD * width, total / 2) : MOST_FOLD * width);
  p = filletCorners(p, LEAST_RADIUS * width, step);
  p = roundAll(resampleLine(p, step), LEAST_RADIUS * width, step);
  p = simplifyLine(p, KEEP);
  // The ends exactly as they were.
  p[0] = clean[0];
  p[p.length - 1] = clean[clean.length - 1];
  return p;
}

const cache = new WeakMap<MapFeatures, Map<number, MapFeatures>>();
/** Smoothed copies kept per map: the latest scales. */
const MOST_SCALES = 4;

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
  // A few scales per map at most (the scale slider would otherwise keep one copy per position tried).
  if (byK.size >= MOST_SCALES) byK.delete(byK.keys().next().value!);
  byK.set(k, out);
  return out;
}
