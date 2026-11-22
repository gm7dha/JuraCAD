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
