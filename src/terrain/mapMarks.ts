/**
 * Which of the map's lines go on a puzzle (pure), so the marks stay tidy: lochs and reservoirs but no rivers or
 * streams, only motorways and trunk roads, and only the main walking routes up the hills — not every path through a
 * park or along a street. Each can be switched back to everything (the old way) in the puzzle windows.
 *
 * Hill routes: paths, bridleways and tracks (never footways, pavements, steps or cycleways) that don't run mostly through
 * towns' streets, parks or golf courses are joined end to end into routes — through each junction the two pieces that
 * carry on straightest — and a route is kept when it's a signed walking route or graded mountain path, or when it climbs
 * at least `HILL_CLIMB` m, or at least `HIGH_CLIMB` m up onto the area's higher ground (the top `HIGH_GROUND` share of
 * its height range). Routes shorter than `LEAST_ROUTE` mm on the printed puzzle are left off.
 */
import { heightAt, type HeightGrid } from "./elevation";
import type { OsmLineKind } from "./osm";

type XY = [number, number];

/** What goes on: "standing" water = lochs, lakes and reservoirs only; "hills" = main hill routes only; "trunk" = motorways and trunk roads only. */
export interface MarkChoice {
  water: "standing" | "all";
  paths: "hills" | "all";
  roads: "trunk" | "all";
}

/** The tidy choice, used unless asked otherwise. */
export const TIDY_MARKS: MarkChoice = { water: "standing", paths: "hills", roads: "trunk" };
/** Everything from the map, as before. */
export const ALL_MARKS: MarkChoice = { water: "all", paths: "all", roads: "all" };

/** The choices in words, for the puzzle windows. */
export const WATER_CHOICES: [MarkChoice["water"], string][] = [
  ["standing", "Lochs and reservoirs only"],
  ["all", "With rivers and streams too"],
];
export const PATH_CHOICES: [MarkChoice["paths"], string][] = [
  ["hills", "Main hill routes only"],
  ["all", "All paths and tracks"],
];
export const ROAD_CHOICES: [MarkChoice["roads"], string][] = [
  ["trunk", "Main trunk roads only"],
  ["all", "All roads"],
];

/** The rule in plain words, for the windows. */
export const HILL_RULE =
  "Hill routes are the signed walking routes and mountain paths, and other paths and tracks that climb at least 150 m (or 50 m up onto the highest ground) — not pavements, steps, cycle paths, or paths through towns, parks and golf courses.";

/** A route climbing this much (m) is a hill route. */
export const HILL_CLIMB = 150;
/** Or climbing this much (m) up into the top `HIGH_GROUND` share of the area's height range. */
export const HIGH_CLIMB = 50;
export const HIGH_GROUND = 0.3;
/** Hill routes shorter than this on the printed puzzle (mm) are left off. */
export const LEAST_ROUTE = 10;
/** A path with at least this share of its length in a town's streets or a park isn't a hill path. */
export const BUILT_UP_SHARE = 0.5;
/** Kinds of `highway` that are never hill routes. */
export const NOT_HILL = new Set(["footway", "pedestrian", "steps", "cycleway", "corridor", "living_street", "sidewalk", "crossing"]);
/** Roads kept as main trunk roads (their slip roads are left out). */
export const TRUNK_ROADS = new Set(["motorway", "trunk"]);

export interface MarkLine {
  kind: OsmLineKind;
  pts: XY[];
  highway?: string;
  hike?: true;
}

/** The lines (OS grid metres) the choice keeps. `builtUp`: outlines of towns and parks; `grid`: heights for climbs. */
export function tidyMarks(lines: MarkLine[], builtUp: XY[][], choice: MarkChoice, grid?: HeightGrid): { kind: OsmLineKind; pts: XY[]; least?: number }[] {
  const out: { kind: OsmLineKind; pts: XY[]; least?: number }[] = [];
  const paths: MarkLine[] = [];
  for (const l of lines) {
    if (l.kind === "river" || l.kind === "stream") {
      if (choice.water === "all") out.push({ kind: l.kind, pts: l.pts });
    } else if (l.kind === "road") {
      if (choice.roads === "all" || TRUNK_ROADS.has(l.highway ?? "")) out.push({ kind: l.kind, pts: l.pts });
    } else if (choice.paths === "all") out.push({ kind: l.kind, pts: l.pts });
    else paths.push(l);
  }
  if (paths.length) out.push(...hillRoutes(paths, builtUp, grid));
  return out;
}

/** The main hill routes among paths and tracks (see the file's note), each joined into one line. */
export function hillRoutes(lines: MarkLine[], builtUp: XY[][], grid?: HeightGrid): { kind: OsmLineKind; pts: XY[]; least: number }[] {
  const inTown = townTest(builtUp);
  const pieces = lines.filter((l) => l.pts.length >= 2 && !NOT_HILL.has(l.highway ?? "") && !mostlyIn(l.pts, inTown));
  const routes = joinRoutes(pieces);
  let low = Infinity;
  let high = -Infinity;
  if (grid) for (const v of grid.h) [low, high] = [Math.min(low, v), Math.max(high, v)];
  const highGround = high - HIGH_GROUND * (high - low);
  const out: { kind: OsmLineKind; pts: XY[]; least: number }[] = [];
  for (const r of routes) {
    let keep = r.hike;
    if (!keep && grid) {
      const [bottom, top] = heightsAlong(r.pts, grid);
      const climb = top - bottom;
      keep = climb >= HILL_CLIMB || (climb >= HIGH_CLIMB && top >= highGround);
    }
    if (keep) out.push({ kind: r.kind, pts: r.pts, least: LEAST_ROUTE });
  }
  return out;
}

/** The lowest and highest ground along a line, sampled about once per height-grid spacing. */
export function heightsAlong(pts: XY[], grid: HeightGrid): [number, number] {
  let [lo, hi] = [Infinity, -Infinity];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / grid.spacing));
    for (let t = 0; t <= n; t++) {
      const z = heightAt(grid, a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n);
      [lo, hi] = [Math.min(lo, z), Math.max(hi, z)];
    }
  }
  return [lo, hi];
}

/**
 * Pieces joined end to end into routes where they meet (the same point): at each meeting point the two ends that carry
 * on straightest are joined, then the next two, never turning back by more than a right angle.
 */
export function joinRoutes(pieces: MarkLine[]): { kind: OsmLineKind; pts: XY[]; hike: boolean }[] {
  const key = (p: XY) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;
  const at = new Map<string, { piece: number; end: 0 | 1 }[]>();
  pieces.forEach((l, i) => {
    for (const end of [0, 1] as const) {
      const k = key(end ? l.pts[l.pts.length - 1] : l.pts[0]);
      const list = at.get(k) ?? [];
      list.push({ piece: i, end });
      at.set(k, list);
    }
  });
  // Direction leaving the meeting point into the piece.
  const away = (i: number, end: 0 | 1): XY => {
    const p = pieces[i].pts;
    const [a, b] = end ? [p[p.length - 1], p[p.length - 2]] : [p[0], p[1]];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  const link: ({ piece: number; end: 0 | 1 } | null)[][] = pieces.map(() => [null, null]);
  for (const list of at.values()) {
    if (list.length < 2) continue;
    const pairs: [number, number, number][] = [];
    for (let a = 0; a < list.length; a++)
      for (let b = a + 1; b < list.length; b++) {
        if (list[a].piece === list[b].piece) continue;
        const [u, v] = [away(list[a].piece, list[a].end), away(list[b].piece, list[b].end)];
        const dot = u[0] * v[0] + u[1] * v[1];
        if (dot < 0) pairs.push([dot, a, b]);
      }
    pairs.sort((p, q) => p[0] - q[0]);
    const used = new Set<number>();
    for (const [, a, b] of pairs) {
      if (used.has(a) || used.has(b)) continue;
      used.add(a).add(b);
      link[list[a].piece][list[a].end] = list[b];
      link[list[b].piece][list[b].end] = list[a];
    }
  }
  const seen = new Uint8Array(pieces.length);
  const routes: { kind: OsmLineKind; pts: XY[]; hike: boolean }[] = [];
  for (let p = 0; p < pieces.length; p++) {
    if (seen[p]) continue;
    // Back to the route's free end (or round a loop to p).
    let [cur, out]: [number, 0 | 1] = [p, 0];
    for (let guard = 0; guard <= pieces.length; guard++) {
      const l: { piece: number; end: 0 | 1 } | null = link[cur][out];
      if (!l || l.piece === p) break;
      [cur, out] = [l.piece, (1 - l.end) as 0 | 1];
    }
    // Forward from there: entering `cur` at its end `out`.
    let enter = out;
    const pts: XY[] = [];
    let path = false;
    let hike = false;
    while (!seen[cur]) {
      seen[cur] = 1;
      const piece = pieces[cur];
      const along = enter === 0 ? piece.pts : [...piece.pts].reverse();
      pts.push(...(pts.length ? along.slice(1) : along));
      path ||= piece.kind === "path";
      hike ||= !!piece.hike;
      const next = link[cur][(1 - enter) as 0 | 1];
      if (!next) break;
      [cur, enter] = [next.piece, next.end];
    }
    routes.push({ kind: path ? "path" : "track", pts, hike });
  }
  return routes;
}

/** Is a point inside any of the outlines? Looked up through a grid of their boxes. */
function townTest(rings: XY[][]): (p: XY) => boolean {
  if (!rings.length) return () => false;
  const boxes = rings.map((r) => {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of r) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    return [x0, y0, x1, y1];
  });
  const S = 500;
  const cells = new Map<string, number[]>();
  boxes.forEach(([x0, y0, x1, y1], i) => {
    for (let gx = Math.floor(x0 / S); gx <= Math.floor(x1 / S); gx++)
      for (let gy = Math.floor(y0 / S); gy <= Math.floor(y1 / S); gy++) {
        const k = `${gx},${gy}`;
        const list = cells.get(k) ?? [];
        list.push(i);
        cells.set(k, list);
      }
  });
  return (p) => {
    for (const i of cells.get(`${Math.floor(p[0] / S)},${Math.floor(p[1] / S)}`) ?? []) {
      const [x0, y0, x1, y1] = boxes[i];
      if (p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1 && inside(p, rings[i])) return true;
    }
    return false;
  };
}

function mostlyIn(pts: XY[], test: (p: XY) => boolean): boolean {
  let [all, inTown] = [0, 0];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    all += len;
    if (test([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])) inTown += len;
  }
  return all > 0 && inTown >= BUILT_UP_SHARE * all;
}

function inside(p: XY, ring: XY[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [a, b] = [ring[i], ring[j]];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
