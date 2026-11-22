/**
 * Paths and roads picked off by hand (pure): after the usual rules (mapMarks.ts) have chosen the map's lines, the
 * puzzle windows let each path, track or road be clicked to leave it off the puzzle, or clicked again to put it back.
 *
 * What's left off is kept as the map's way ids (OpenStreetMap's own numbers), not as places in a list, so fetching the
 * same area again — or switching between "main hill routes" (several ways joined into one route) and "all paths"
 * (each way on its own) — leaves the same lines off. A line counts as left off when at least half of its ways are.
 * Nothing left off = the very same features object, so everything made from it is exactly as before.
 */
import { lineLength, type MapFeatures, type OsmLineKind } from "./osm";

type XY = [number, number];
type Line = MapFeatures["lines"][number];

/** The kinds of line that can be picked off: paths, tracks and roads (not rivers or streams). */
export const PICKABLE: ReadonlySet<OsmLineKind> = new Set<OsmLineKind>(["path", "track", "road"]);

/** Nothing left off. */
export const NONE_DROPPED: ReadonlySet<string> = new Set<string>();

/** Can this line be picked off? */
export const canPick = (l: Line) => PICKABLE.has(l.kind) && !!l.ids?.length;

/** Is this line left off? At least half of its ways are. */
export function isDropped(l: Line, dropped: ReadonlySet<string>): boolean {
  if (!dropped.size || !l.ids?.length || !PICKABLE.has(l.kind)) return false;
  let n = 0;
  for (const id of l.ids) if (dropped.has(id)) n++;
  return n * 2 >= l.ids.length;
}

/** The features without the lines left off (the same object when none are). */
export function withoutDropped(f: MapFeatures, dropped: ReadonlySet<string>): MapFeatures {
  if (!dropped.size) return f;
  const lines = f.lines.filter((l) => !isDropped(l, dropped));
  return lines.length === f.lines.length ? f : { ...f, lines };
}

/** Leave a line off, or put it back if it's off. */
export function toggleDropped(dropped: ReadonlySet<string>, l: Line): ReadonlySet<string> {
  if (!canPick(l)) return dropped;
  const next = new Set(dropped);
  if (isDropped(l, dropped)) for (const id of l.ids!) next.delete(id);
  else for (const id of l.ids!) next.add(id);
  return next;
}

/** Every pickable line of `f` left off (kept with what was already off). */
export function dropAll(f: MapFeatures, dropped: ReadonlySet<string> = NONE_DROPPED): ReadonlySet<string> {
  const next = new Set(dropped);
  for (const l of f.lines) if (canPick(l)) for (const id of l.ids!) next.add(id);
  return next;
}

/** How many of the pickable lines are kept, of how many. */
export function keptCount(f: MapFeatures, dropped: ReadonlySet<string>): { kept: number; total: number; paths: number; roads: number } {
  let [kept, total, paths, roads] = [0, 0, 0, 0];
  for (const l of f.lines) {
    if (!canPick(l)) continue;
    total++;
    if (l.kind === "road") roads++;
    else paths++;
    if (!isDropped(l, dropped)) kept++;
  }
  return { kept, total, paths, roads };
}

/** Distance from p to the segment a–b. */
function segmentDistance(p: XY, a: XY, b: XY): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Distance from p to a line. */
export function distanceToLine(p: XY, pts: XY[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, segmentDistance(p, pts[i], pts[i + 1]));
  if (pts.length === 1) best = Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]);
  return best;
}

/** The pickable line nearest p (same units as the lines), within `reach`; -1 when none is that near. */
export function nearestLine(lines: Line[], p: XY, reach: number): number {
  let [best, at] = [reach, -1];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!canPick(l)) continue;
    // A quick box test first: most lines are nowhere near.
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of l.pts) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    if (p[0] < x0 - best || p[0] > x1 + best || p[1] < y0 - best || p[1] > y1 + best) continue;
    const d = distanceToLine(p, l.pts);
    if (d <= best) [best, at] = [d, i];
  }
  return at;
}

/** "Ben Nevis Pony Track — path, 6.2 km", "A82 — road, 3.1 km", "A track, 800 m" (lengths in metres on the ground). */
export function lineLabel(l: Line): string {
  const m = lineLength(l.pts);
  const length = m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
  const what = l.kind === "road" ? "road" : l.kind === "track" ? "track" : "path";
  return l.name ? `${l.name} — ${what}, ${length}` : `${what === "road" ? "A road" : what === "track" ? "A track" : "A path"} with no name, ${length}`;
}

/** The OS grid metres a top view covers: its south-west corner and size (the canvas is drawn from these). */
export interface ViewBox {
  e0: number;
  n0: number;
  width: number;
  height: number;
}

/**
 * Where a grid point is drawn on a top view `w` × `h` (any units: canvas pixels, the overlay's own box), y down — the
 * same mapping both puzzle windows' canvases use ((e − e0)·s, h − (n − n0)·s), so the overlay sits exactly on them.
 */
export function onView(box: ViewBox, w: number, h: number, [e, n]: XY): XY {
  return [((e - box.e0) * w) / box.width, h - ((n - box.n0) * h) / box.height];
}

/** The grid point under a place on a top view shown `w` × `h` (screen pixels from its top-left): onView backwards. */
export function fromView(box: ViewBox, w: number, h: number, [x, y]: XY): XY {
  return [box.e0 + (x * box.width) / w, box.n0 + ((h - y) * box.height) / h];
}

/** The ids of the map's ways a set of drawn lines came from (an island's marks on its land). */
export function idsOf(lines: { ids?: string[] }[]): Set<string> {
  const out = new Set<string>();
  for (const l of lines) for (const id of l.ids ?? []) out.add(id);
  return out;
}

/** Does a line come within a box anywhere (its points, or a segment crossing it)? */
function touchesBox(pts: XY[], b: ViewBox): boolean {
  const [x0, y0, x1, y1] = [b.e0, b.n0, b.e0 + b.width, b.n0 + b.height];
  const inside = ([x, y]: XY) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  for (let i = 0; i < pts.length; i++) {
    if (inside(pts[i])) return true;
    if (i === 0) continue;
    // A segment passing through with both ends outside: clip it to the box (Liang–Barsky).
    const [a, c] = [pts[i - 1], pts[i]];
    const [dx, dy] = [c[0] - a[0], c[1] - a[1]];
    let [t0, t1] = [0, 1];
    const edge = (p: number, q: number) => {
      if (p === 0) return q >= 0;
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      return t0 <= t1;
    };
    if (edge(-dx, a[0] - x0) && edge(dx, x1 - a[0]) && edge(-dy, a[1] - y0) && edge(dy, y1 - a[1])) return true;
  }
  return false;
}

/**
 * The lines a top view offers to pick: paths and roads that are on what's printed — on the land (`shown`: the ids of
 * the lines drawn there) and/or within the puzzle (`within`) — plus any already left off, so they can be put back.
 * Lines only on the sea or the trimmed-off edge aren't offered or counted.
 */
export function pickableLines(lines: Line[], dropped: ReadonlySet<string>, shown?: ReadonlySet<string> | null, within?: ViewBox | null): Line[] {
  return lines.filter((l) => {
    if (!canPick(l)) return false;
    if (isDropped(l, dropped)) return true;
    if (shown && !l.ids!.some((id) => shown.has(id))) return false;
    if (within && !touchesBox(l.pts, within)) return false;
    return true;
  });
}

/** What an island's top view covers: the puzzle (mm, from `origin`) in grid metres — as its canvas draws (x·s, h − y·s). */
export function islandViewBox(p: { width: number; height: number; k: number }, origin: { e: number; n: number }): ViewBox {
  return { e0: origin.e, n0: origin.n, width: p.width / p.k, height: p.height / p.k };
}

/** What a mountain's top view covers: the whole area loaded (trims are drawn dimmed on it, not cut off). */
export function mountainViewBox(area: { sw: { e: number; n: number }; width: number; height: number }): ViewBox {
  return { e0: area.sw.e, n0: area.sw.n, width: area.width, height: area.height };
}

/**
 * The ways known to be on an island's land once a new puzzle arrives: those its marks show, plus — for lines that were
 * left off when it was made, so it couldn't tell — what was known before. So a line put back stays offered while the
 * puzzle is remade.
 */
export function landIdsAfter(before: ReadonlySet<string>, shown: ReadonlySet<string>, droppedWhenMade: ReadonlySet<string>): ReadonlySet<string> {
  const out = new Set(shown);
  for (const id of before) if (droppedWhenMade.has(id)) out.add(id);
  return out;
}
