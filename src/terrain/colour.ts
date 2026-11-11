/**
 * Colour for the Island and Mountain puzzles (pure, mm, z up).
 *
 * Three choices: "plain" (one filament, plus the mountain's snow part — exactly as before), "bands" (an AMS: each piece
 * cut by level planes into a part per colour, every band edge on a whole print layer of the piece as printed standing on
 * its underside; water painted onto the ground's triangles with Bambu's `paint_color`) and "full" (full-colour printers
 * and services: a colour for every triangle corner — a smooth height tint, gentle hill shading lit from the north-west,
 * snow on gentle slopes above the snow line, the map's water, paths, roads and woods; the sides tinted by height).
 *
 * `sliceMesh` does the cutting: each triangle is clipped to each slab between the planes, with the new corners on the
 * mesh's own edges (shared by both triangles of an edge, so nothing opens up), and each slab is closed by flat caps whose
 * outlines are those same corners (`triangulateFast`, holes and all) — every part is watertight and the parts add up to the
 * piece. Without caps it just divides the triangles where they cross the planes (full colour, so the sides can change
 * colour at a band's height).
 */
import { weld } from "../geometry/threeMf";
import { GROOVES } from "./groundMarks";
import type { Body } from "./mountainPuzzle";
import type { MapFeatures, OsmLineKind } from "./osm";
import type { P2 } from "./triangulate";
import { triangulateFast } from "./triangulateFast";

type XY = [number, number];

export type ColourMode = "plain" | "bands" | "full";

export interface ColourBand {
  name: string;
  /** "#rrggbb". */
  colour: string;
  /** The ground height (m) where it starts; the first band's is where the ground starts (ignored). */
  from: number;
  /** The snow: in full colour it lies only on gentle slopes above `from`, instead of being a band of the tint. */
  snow?: boolean;
}

export interface ColourSpec {
  mode: ColourMode;
  /** 2–8 bands, lowest first. */
  bands: ColourBand[];
  /** The plain side under the ground in its own colour (null: the first band's). */
  base: string | null;
  /** Lochs and rivers from the map in this colour (null: not coloured). */
  water: string | null;
  /** Footpaths and tracks from the map in this colour (null or missing: not coloured). */
  paths?: string | null;
  /** Roads from the map in this colour (null or missing: not coloured). */
  roads?: string | null;
  /** Print layer height (mm): band edges are moved onto whole layers. */
  layer: number;
  /** The first layer's height (mm), when it isn't `layer` (Bambu Studio's "Initial layer height"). */
  firstLayer?: number;
}

/** How ground heights map to the puzzle: z = z0 + (h − h0) × mmPerM. */
export interface HeightScale {
  z0: number;
  h0: number;
  mmPerM: number;
}

export const zOfHeight = (s: HeightScale, h: number) => s.z0 + (h - s.h0) * s.mmPerM;
export const heightOfZ = (s: HeightScale, z: number) => s.h0 + (z - s.z0) / Math.max(s.mmPerM, 1e-12);

export const LAYER_DEFAULT = 0.2;
export const MOST_BANDS = 8;
export const LEAST_BANDS = 2;
/** At most this many filaments in all (bands, base and water). */
export const MOST_FILAMENTS = 8;

export const SEA_BLUE = "#2f6ea5";
/** Footpaths and tracks: red, as on OS maps' footpaths (the owner's wish). */
export const PATH_RED = "#d22a1e";

/** Roads: black (the owner's wish). */
export const ROAD_BLACK = "#1f1f1f";

/** What the map has to colour: water (lochs, rivers, streams), paths (footpaths, tracks) and roads. `true`/`false` = all/none. */
export type MapHas = boolean | { water: boolean; paths?: boolean; roads?: boolean };
const hasOf = (h: MapHas) => (typeof h === "boolean" ? { water: h, paths: h, roads: h } : { water: h.water, paths: !!h.paths, roads: !!h.roads });
export const WATER_BLUE = "#3a7bc0";

/**
 * The usual island colours: sand at the coast, green, brown, grey on the tops — with the sea-blue base and water, five
 * filaments (olive is first among the spare colours, for a sixth).
 */
export const ISLAND_COLOURS: [string, string, number][] = [
  ["Sand", "#e2d199", 0],
  ["Green", "#5d9a45", 0.06],
  ["Brown", "#8b6745", 0.45],
  ["Grey", "#9d9d9b", 0.75],
];

/** The usual mountain colours: green low down, brown, grey rock, white snow. */
export const MOUNTAIN_COLOURS: [string, string, number][] = [
  ["Green", "#55913f", 0],
  ["Brown", "#8b6a47", 0.3],
  ["Grey rock", "#8e8e8c", 0.6],
  ["Snow", "#f4f6f8", 0.8],
];

/** More colours offered when bands are added: the next unused one. */
export const SPARE_COLOURS = ["#8c8a3f", "#c9b27c", "#3f6f36", "#b08d5a", "#6b6b6b", "#d8d0c0", "#a04f3a", "#e8e8e8", "#556b2f"];

const nice = (m: number) => (Math.abs(m) < 50 ? Math.round(m) : Math.round(m / 10) * 10);

/** An island's bands for ground up to `high` m. */
export function islandBands(high: number): ColourBand[] {
  return ISLAND_COLOURS.map(([name, colour, f]) => ({ name, colour, from: nice(f * Math.max(high, 10)) }));
}

/** A mountain's bands from `low` to `high` m, the snow starting at `snowline` when given. */
export function mountainBands(low: number, high: number, snowline: number | null = null): ColourBand[] {
  const r = Math.max(high - low, 10);
  return MOUNTAIN_COLOURS.map(([name, colour, f], i) => ({
    name,
    colour,
    from: i === MOUNTAIN_COLOURS.length - 1 && snowline !== null ? snowline : nice(low + f * r),
    ...(name === "Snow" ? { snow: true } : {}),
  }));
}

export const PLAIN_COLOUR: ColourSpec = { mode: "plain", bands: [], base: null, water: null, layer: LAYER_DEFAULT };

/** Filaments one AMS holds. */
export const AMS_SLOTS = 4;

/** Things worth knowing about the colour choices that don't stop them (plain English). */
export function colourWarnings(spec: ColourSpec, has: MapHas = true, ground: [number, number] | null = null): string[] {
  if (spec.mode === "plain") return [];
  const out: string[] = [];
  const n = filaments(spec, has).length;
  if (spec.mode === "bands" && n > AMS_SLOTS)
    out.push(`That's ${n} filaments, and one AMS holds ${AMS_SLOTS}: use a second AMS or the spool holder for the rest, or fewer bands (or the same colour for two of them).`);
  if (ground && spec.bands.length > 1) {
    const [lo, hi] = ground;
    const inside = spec.bands.slice(1).filter((b) => !b.snow || spec.mode === "bands").some((b) => b.from > lo && b.from < hi);
    if (!inside) out.push(`No band starts between ${Math.round(lo)} m and ${Math.round(hi)} m, the ground here — so it's all one colour. Press "Usual colours and heights" for heights to suit it.`);
  }
  return out;
}

/** What's wrong with the colour choices (plain English). */
export function colourProblems(spec: ColourSpec, has: MapHas = true): string[] {
  if (spec.mode === "plain") return [];
  const out: string[] = [];
  if (spec.bands.length < LEAST_BANDS || spec.bands.length > MOST_BANDS) out.push(`Use between ${LEAST_BANDS} and ${MOST_BANDS} colour bands.`);
  if (spec.paths && !/^#[0-9a-f]{6}$/i.test(spec.paths)) out.push("The paths' colour isn't a colour.");
  if (spec.roads && !/^#[0-9a-f]{6}$/i.test(spec.roads)) out.push("The roads' colour isn't a colour.");
  if (!(spec.layer >= 0.04 && spec.layer <= 1)) out.push("The layer height should be between 0.04 and 1 mm (0.2 mm is usual).");
  if (spec.firstLayer !== undefined && !(spec.firstLayer >= 0.04 && spec.firstLayer <= 1)) out.push("The first layer's height should be between 0.04 and 1 mm.");
  for (let i = 1; i < spec.bands.length; i++)
    if (!(spec.bands[i].from > spec.bands[i - 1].from) && i > 1) out.push(`${spec.bands[i].name} should start higher than ${spec.bands[i - 1].name}.`);
  for (const b of spec.bands) if (!/^#[0-9a-f]{6}$/i.test(b.colour)) out.push(`${b.name}'s colour isn't a colour.`);
  if (spec.mode === "bands" && filaments(spec, has).length > MOST_FILAMENTS)
    out.push(`That's ${filaments(spec, has).length} filaments — at most ${MOST_FILAMENTS}. Use fewer bands, or the same colour for the base, water, paths or roads as a band.`);
  return out;
}

export interface Filament {
  /** 1-based, as Bambu Studio numbers them. */
  n: number;
  colour: string;
  /** What it's used for: "Base", "Sand", "Water", "Paths", "Roads". */
  uses: string[];
}

/** The filaments the bands need: one per different colour, in the order they're first used (base, bands, water, paths, roads). */
export function filaments(spec: ColourSpec, has: MapHas = true): Filament[] {
  const map = hasOf(has);
  const out: Filament[] = [];
  const add = (colour: string, use: string) => {
    const c = colour.toLowerCase();
    const f = out.find((x) => x.colour === c);
    if (f) f.uses.push(use);
    else out.push({ n: out.length + 1, colour: c, uses: [use] });
  };
  if (spec.base) add(spec.base, "Base");
  for (const b of spec.bands) add(b.colour, b.name);
  if (spec.water && map.water) add(spec.water, "Water");
  if (spec.paths && map.paths) add(spec.paths, "Paths");
  if (spec.roads && map.roads) add(spec.roads, "Roads");
  return out;
}

const filamentOf = (fs: Filament[], colour: string) => fs.find((f) => f.colour === colour.toLowerCase())?.n ?? 1;

/** The level planes (puzzle z, not yet on layers) and the filament above each; `below` is the filament under the first. */
export function bandLevels(spec: ColourSpec, scale: HeightScale, fs: Filament[]): { below: number; levels: { z: number; filament: number }[] } {
  const levels: { z: number; filament: number }[] = [];
  let below = filamentOf(fs, spec.bands[0].colour);
  if (spec.base) {
    below = filamentOf(fs, spec.base);
    levels.push({ z: scale.z0, filament: filamentOf(fs, spec.bands[0].colour) });
  }
  // With a base colour no band starts below the ground's lowest (it would be under the base's top).
  for (let i = 1; i < spec.bands.length; i++) {
    const z = zOfHeight(scale, spec.bands[i].from);
    levels.push({ z: spec.base ? Math.max(scale.z0, z) : z, filament: filamentOf(fs, spec.bands[i].colour) });
  }
  // Lowest first (stable: of bands starting at the same height, the later one wins in snappedCuts).
  return { below, levels: levels.map((l, i) => ({ l, i })).sort((a, b) => a.l.z - b.l.z || a.i - b.i).map((x) => x.l) };
}

/**
 * A piece's band edges on whole layers: heights above its underside `z0` (as printed) rounded to the layer boundaries
 * (`firstLayer`, then every `layer` — default: all `layer`); edges at or
 * below the bed are dropped (the band above starts on the bed), and of edges on the same layer the higher band wins.
 */
export function snappedCuts(
  levels: { z: number; filament: number }[],
  below: number,
  z0: number,
  layer: number,
  firstLayer = layer,
): { below: number; cuts: { z: number; filament: number }[] } {
  const cuts: { z: number; filament: number }[] = [];
  let first = below;
  // Lowest first, stable (the caller's order decides between equal heights).
  const sorted = levels.map((l, i) => ({ l, i })).sort((a, b) => a.l.z - b.l.z || a.i - b.i).map((x) => x.l);
  for (const l of sorted) {
    const h = l.z - z0;
    // Layer boundaries as printed: firstLayer, firstLayer + layer, …
    const print = h < firstLayer / 2 ? 0 : firstLayer + Math.max(0, Math.round((h - firstLayer) / layer)) * layer;
    if (print <= 1e-9) {
      first = l.filament;
      continue;
    }
    const z = z0 + print;
    if (cuts.length && Math.abs(cuts[cuts.length - 1].z - z) < 1e-9) cuts[cuts.length - 1].filament = l.filament;
    else cuts.push({ z, filament: l.filament });
  }
  // Two edges in a row with the same filament: the second changes nothing.
  const kept: { z: number; filament: number }[] = [];
  let current = first;
  for (const c of cuts) if (c.filament !== current) kept.push(c), (current = c.filament);
  return { below: first, cuts: kept };
}

// ---------------------------------------------------------------------------------------------------------------
// Cutting meshes by level planes

export interface MeshData {
  vertices: number[];
  triangles: number[];
}

/** Planes never pass this close to a corner (mm): they're moved up a little instead, which no print can see. */
export const PLANE_CLEAR = 1e-4;

/** `cuts` moved off the mesh's corners: to the nearest height at least PLANE_CLEAR from every corner. */
function clearCuts(zs: Float64Array, cuts: number[]): number[] {
  const sorted = Float64Array.from(zs).sort();
  const first = (c: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < c) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const clear = (z: number) => {
    const i = first(z - PLANE_CLEAR);
    return i >= sorted.length || sorted[i] > z + PLANE_CLEAR;
  };
  const n = sorted.length;
  return cuts.map((c) => {
    if (clear(c)) return c;
    // The nearest free height: in a gap between neighbouring corner heights wider than 2 × PLANE_CLEAR (or past the
    // lowest or highest corner), looking outward from c both ways.
    const i = first(c);
    let best = Infinity;
    const consider = (lo: number, hi: number) => {
      if (hi - lo < 0) return;
      const z = Math.min(hi, Math.max(lo, c));
      if (Math.abs(z - c) < Math.abs(best - c)) best = z;
    };
    for (let j = i; j <= n; j++) {
      const lo = j === 0 ? -Infinity : sorted[j - 1] + PLANE_CLEAR * 1.01;
      if (lo - c > Math.abs(best - c)) break;
      consider(lo, j === n ? Infinity : sorted[j] - PLANE_CLEAR * 1.01);
    }
    for (let j = i - 1; j >= 0; j--) {
      const hi = sorted[j] - PLANE_CLEAR * 1.01;
      if (c - hi > Math.abs(best - c)) break;
      consider(j === 0 ? -Infinity : sorted[j - 1] + PLANE_CLEAR * 1.01, hi);
    }
    return best;
  });
}

export class SliceError extends Error {}

/**
 * The mesh cut by level planes at `cuts` (ascending, mm) into `cuts.length + 1` slabs, lowest first (empty ones have no
 * triangles). With `caps` each slab is closed by flat faces on its planes; without, the slabs are simply the triangles
 * divided where they cross the planes (their corners shared, so all of them together are still the closed mesh).
 */
export function sliceMesh(vertices: ArrayLike<number>, triangles: ArrayLike<number>, cuts: number[], caps = true): MeshData[] {
  const m = weld(vertices, triangles);
  const V = m.vertices;
  const nv = V.length / 3;
  const zs = new Float64Array(nv);
  for (let i = 0; i < nv; i++) zs[i] = V[i * 3 + 2];
  const planes = clearCuts(zs, [...cuts].sort((a, b) => a - b));
  const S = planes.length + 1;
  // A point is an original corner (id < nv) or a crossing of edge (a, b), a < b, with plane p.
  const crossKey = (a: number, b: number, p: number) => (a < b ? `${a},${b},${p}` : `${b},${a},${p}`);
  const crossings = new Map<string, number>();
  const extra: number[] = [];
  const crossing = (a: number, b: number, p: number): number => {
    const key = crossKey(a, b, p);
    let id = crossings.get(key);
    if (id === undefined) {
      const [u, w] = a < b ? [a, b] : [b, a];
      const t = (planes[p] - zs[u]) / (zs[w] - zs[u]);
      extra.push(V[u * 3] + t * (V[w * 3] - V[u * 3]), V[u * 3 + 1] + t * (V[w * 3 + 1] - V[u * 3 + 1]), planes[p]);
      id = nv + extra.length / 3 - 1;
      crossings.set(key, id);
    }
    return id;
  };
  const pos = (id: number): [number, number, number] => (id < nv ? [V[id * 3], V[id * 3 + 1], V[id * 3 + 2]] : [extra[(id - nv) * 3], extra[(id - nv) * 3 + 1], extra[(id - nv) * 3 + 2]]);
  const slabOf = (z: number) => {
    let s = 0;
    while (s < planes.length && z > planes[s]) s++;
    return s;
  };
  const tris: number[][] = Array.from({ length: S }, () => []);
  // Cap edges per slab and plane: [slab][plane] → from → to (the cap's own direction).
  const capEdges: Map<number, number>[][] = Array.from({ length: S }, () => planes.map(() => new Map()));
  const T = m.triangles;
  for (let t = 0; t < T.length; t += 3) {
    const ids = [T[t], T[t + 1], T[t + 2]];
    const z = ids.map((i) => zs[i]);
    const s0 = slabOf(Math.min(...z));
    const s1 = slabOf(Math.max(...z));
    if (s0 === s1) {
      tris[s0].push(...ids);
      continue;
    }
    for (let s = s0; s <= s1; s++) {
      const lo = s > 0 ? s - 1 : -1;
      const hi = s < planes.length ? s : -1;
      const loZ = lo >= 0 ? planes[lo] : -Infinity;
      const hiZ = hi >= 0 ? planes[hi] : Infinity;
      // The triangle within the slab: walk its edges, keeping corners inside and adding where an edge crosses a plane.
      const poly: { id: number; plane: number }[] = [];
      for (let k = 0; k < 3; k++) {
        const [a, b] = [ids[k], ids[(k + 1) % 3]];
        const [za, zb] = [zs[a], zs[b]];
        if (za > loZ && za < hiZ) poly.push({ id: a, plane: -1 });
        // Crossings along a → b in travel order.
        const hits: { tt: number; plane: number }[] = [];
        for (const p of [lo, hi]) {
          if (p < 0) continue;
          const c = planes[p];
          if ((za - c) * (zb - c) < 0) hits.push({ tt: (c - za) / (zb - za), plane: p });
        }
        hits.sort((x, y) => x.tt - y.tt);
        for (const h of hits) poly.push({ id: crossing(a, b, h.plane), plane: h.plane });
      }
      if (poly.length < 3) continue;
      for (let k = 1; k + 1 < poly.length; k++) tris[s].push(poly[0].id, poly[k].id, poly[k + 1].id);
      if (!caps) continue;
      // Polygon edges along a plane: the cap there runs the other way.
      for (let k = 0; k < poly.length; k++) {
        const [p, q] = [poly[k], poly[(k + 1) % poly.length]];
        if (p.plane >= 0 && p.plane === q.plane) capEdges[s][p.plane].set(q.id, p.id);
      }
    }
  }
  if (caps)
    for (let s = 0; s < S; s++)
      for (let p = 0; p < planes.length; p++) {
        const edges = capEdges[s][p];
        if (!edges.size) continue;
        const top = p === s; // the plane above slab s
        for (const tri of capTriangles(edges, pos, top)) tris[s].push(...tri);
      }
  // Each slab as its own compact mesh.
  return tris.map((list) => {
    const remap = new Map<number, number>();
    const vertices: number[] = [];
    const triangles: number[] = [];
    for (const id of list) {
      let j = remap.get(id);
      if (j === undefined) {
        j = vertices.length / 3;
        remap.set(id, j);
        vertices.push(...pos(id));
      }
      triangles.push(j);
    }
    return { vertices, triangles };
  });
}

/** Triangles closing a slab on one plane, from its cap edges (from → to), facing up (`top`) or down. */
function capTriangles(edges: Map<number, number>, pos: (id: number) => [number, number, number], top: boolean): number[][] {
  const loops: number[][] = [];
  const left = new Map(edges);
  for (const start of edges.keys()) {
    if (!left.has(start)) continue;
    const loop: number[] = [];
    let at = start;
    while (left.has(at)) {
      loop.push(at);
      const next = left.get(at)!;
      left.delete(at);
      at = next;
    }
    if (at !== start) throw new SliceError("The piece's mesh isn't closed, so it couldn't be cut into colours.");
    if (loop.length >= 3) loops.push(loop);
  }
  const xy = (id: number): P2 => {
    const p = pos(id);
    return [p[0], p[1]];
  };
  const area = (loop: number[]) => {
    let a = 0;
    for (let i = 0; i < loop.length; i++) {
      const [p, q] = [xy(loop[i]), xy(loop[(i + 1) % loop.length])];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  };
  const sign = top ? 1 : -1;
  const outers = loops.filter((l) => area(l) * sign > 0).map((l) => ({ loop: l, area: Math.abs(area(l)), holes: [] as number[][] }));
  const holes = loops.filter((l) => area(l) * sign <= 0);
  const inside = (p: P2, loop: number[]) => {
    let c = false;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const [a, b] = [xy(loop[i]), xy(loop[j])];
      if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  };
  for (const h of holes) {
    const p = xy(h[0]);
    let best: (typeof outers)[number] | null = null;
    for (const o of outers) if ((!best || o.area < best.area) && inside(p, o.loop)) best = o;
    best?.holes.push(h);
  }
  const out: number[][] = [];
  for (const o of outers) {
    const ids = [...o.loop, ...o.holes.flat()];
    for (const [a, b, c] of triangulateFast(o.loop.map(xy), o.holes.map((h) => h.map(xy)))) out.push(top ? [ids[a], ids[b], ids[c]] : [ids[a], ids[c], ids[b]]);
  }
  return out;
}

/** Volume and open edges of a mesh (open = directed edges without their reverse), for checks. */
export function meshCheck(vertices: ArrayLike<number>, triangles: ArrayLike<number>): { volume: number; open: number } {
  const m = weld(vertices, triangles);
  const edges = new Map<string, number>();
  let volume = 0;
  const V = m.vertices;
  for (let t = 0; t < m.triangles.length; t += 3) {
    const [a, b, c] = [m.triangles[t], m.triangles[t + 1], m.triangles[t + 2]];
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const back = `${q}>${p}`;
      if (edges.get(back)) edges.set(back, edges.get(back)! - 1);
      else edges.set(`${p}>${q}`, (edges.get(`${p}>${q}`) ?? 0) + 1);
    }
    const [A, B, C] = [a, b, c].map((i) => [V[i * 3], V[i * 3 + 1], V[i * 3 + 2]]);
    volume += (A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6;
  }
  let open = 0;
  for (const n of edges.values()) open += n;
  return { volume, open };
}

// ---------------------------------------------------------------------------------------------------------------
// The map on the puzzle

/** What the map has at a point: nothing, water, a path, a track, a road, a building or a wood. */
export const MapKind = { None: 0, Water: 1, Path: 2, Track: 3, Road: 4, Building: 5, Wood: 6 } as const;
export type MapKind = (typeof MapKind)[keyof typeof MapKind];

/** The map's things in puzzle mm (x east, y north from the puzzle's south-west corner). */
export interface PuzzleMap {
  lines: { kind: OsmLineKind; pts: XY[] }[];
  shapes: { kind: "water" | "building"; rings: XY[][] }[];
  woods: XY[][][];
}

export const NO_MAP: PuzzleMap = { lines: [], shapes: [], woods: [] };

/** Map features (OS grid metres) onto a puzzle whose (0, 0) is grid point (e0, n0), at k mm per metre. */
export function mapOnPuzzle(f: MapFeatures, e0: number, n0: number, k: number): PuzzleMap {
  const at = ([e, n]: XY): XY => [(e - e0) * k, (n - n0) * k];
  return {
    lines: f.lines.map((l) => ({ kind: l.kind, pts: l.pts.map(at) })),
    shapes: f.shapes.map((s) => ({ kind: s.kind, rings: s.rings.map((r) => r.map(at)) })),
    woods: (f.woods ?? []).map((w) => w.map((r) => r.map(at))),
  };
}

export interface MapRaster {
  kindAt(x: number, y: number): MapKind;
  /** Anything to colour at all. */
  empty: boolean;
  /** Any water on it. */
  water: boolean;
  /** Any footpaths or tracks on it. */
  paths: boolean;
  /** Any roads on it. */
  roads: boolean;
}

const EMPTY_RASTER: MapRaster = { kindAt: () => MapKind.None, empty: true, water: false, paths: false, roads: false };

/** The map drawn on a grid over the puzzle (`width` × `height` mm), so a point's kind is one lookup. */
export function mapRaster(map: PuzzleMap, width: number, height: number): MapRaster {
  if (!map.lines.length && !map.shapes.length && !map.woods.length) return EMPTY_RASTER;
  const cell = Math.max(0.2, Math.sqrt((width * height) / 4e6));
  const nx = Math.ceil(width / cell) + 1;
  const ny = Math.ceil(height / cell) + 1;
  const g = new Uint8Array(nx * ny);
  // Higher numbers win where things overlap: water over roads over paths over buildings over woods.
  const rank = [0, 6, 3, 2, 4, 1.5, 1];
  const put = (i: number, kind: MapKind) => {
    if (rank[kind] > rank[g[i]]) g[i] = kind;
  };
  const fill = (rings: XY[][], kind: MapKind) => {
    let [y0, y1] = [Infinity, -Infinity];
    for (const r of rings) for (const p of r) [y0, y1] = [Math.min(y0, p[1]), Math.max(y1, p[1])];
    const j0 = Math.max(0, Math.floor(y0 / cell));
    const j1 = Math.min(ny - 1, Math.ceil(y1 / cell));
    for (let j = j0; j <= j1; j++) {
      const y = j * cell;
      const xs: number[] = [];
      for (const r of rings)
        for (let i = 0; i < r.length; i++) {
          const [a, b] = [r[i], r[(i + 1) % r.length]];
          if (a[1] > y !== b[1] > y) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
        }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil(xs[k] / cell));
        const i1 = Math.min(nx - 1, Math.floor(xs[k + 1] / cell));
        for (let i = i0; i <= i1; i++) put(j * nx + i, kind);
      }
    }
  };
  for (const w of map.woods) fill(w, MapKind.Wood);
  for (const s of map.shapes) fill(s.rings, s.kind === "water" ? MapKind.Water : MapKind.Building);
  const lineKind: Record<OsmLineKind, MapKind> = { path: MapKind.Path, track: MapKind.Track, road: MapKind.Road, river: MapKind.Water, stream: MapKind.Water };
  for (const line of map.lines) {
    const hw = GROOVES[line.kind].width / 2;
    const kind = lineKind[line.kind];
    for (let s = 0; s + 1 < line.pts.length; s++) {
      const [a, b] = [line.pts[s], line.pts[s + 1]];
      const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - hw) / cell));
      const i1 = Math.min(nx - 1, Math.ceil((Math.max(a[0], b[0]) + hw) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - hw) / cell));
      const j1 = Math.min(ny - 1, Math.ceil((Math.max(a[1], b[1]) + hw) / cell));
      if (i0 > i1 || j0 > j1) continue;
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const L2 = dx * dx + dy * dy || 1e-12;
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const [x, y] = [i * cell, j * cell];
          const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
          if (Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy) <= hw) put(j * nx + i, kind);
        }
    }
  }
  let water = false;
  let paths = false;
  let roads = false;
  for (let i = 0; i < g.length && !(water && paths && roads); i++) {
    water ||= g[i] === MapKind.Water;
    paths ||= g[i] === MapKind.Path || g[i] === MapKind.Track;
    roads ||= g[i] === MapKind.Road;
  }
  return {
    empty: false,
    water,
    paths,
    roads,
    kindAt: (x, y) => {
      const i = Math.round(x / cell);
      const j = Math.round(y / cell);
      return i < 0 || j < 0 || i >= nx || j >= ny ? MapKind.None : (g[j * nx + i] as MapKind);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Colour bands

export interface BandPart {
  filament: number;
  vertices: number[];
  triangles: number[];
  /** Per triangle: a filament painted on it (Bambu's paint_color), or 0. Missing when nothing is painted. */
  paint?: Uint8Array;
  /** Where paint is, per painted filament: height ranges as printed (mm above the piece's underside), merged. */
  paintRanges?: { filament: number; low: number; high: number }[];
  /** Its height range as printed (mm above the piece's underside). */
  low: number;
  high: number;
}

export interface BandContext {
  spec: ColourSpec;
  scale: HeightScale;
  map: MapRaster;
}

/** Is a triangle part of the ground on top (facing up)? */
const facesUp = (nz: number) => nz > 0.5;

function normalOf(V: ArrayLike<number>, a: number, b: number, c: number): [number, number, number] {
  const [ux, uy, uz] = [V[b * 3] - V[a * 3], V[b * 3 + 1] - V[a * 3 + 1], V[b * 3 + 2] - V[a * 3 + 2]];
  const [vx, vy, vz] = [V[c * 3] - V[a * 3], V[c * 3 + 1] - V[a * 3 + 1], V[c * 3 + 2] - V[a * 3 + 2]];
  const n: [number, number, number] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const l = Math.hypot(...n) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

/**
 * A piece's bodies as one part per colour band (lowest first), with the map's water, paths and roads painted on: an
 * upward triangle whose middle the map says is water (or a footpath or track, or a road) is painted that filament — the
 * grooves' floors and sides, as the map's lines are drawn exactly as wide as their grooves.
 */
export function bandParts(bodies: Body[], z0: number, ctx: BandContext): BandPart[] {
  const fs = filaments(ctx.spec, ctx.map);
  const { below, levels } = bandLevels(ctx.spec, ctx.scale, fs);
  const { below: first, cuts } = snappedCuts(levels, below, z0, ctx.spec.layer, ctx.spec.firstLayer ?? ctx.spec.layer);
  const waterN = ctx.spec.water && ctx.map.water ? filamentOf(fs, ctx.spec.water) : 0;
  const pathN = ctx.spec.paths && ctx.map.paths ? filamentOf(fs, ctx.spec.paths) : 0;
  const roadN = ctx.spec.roads && ctx.map.roads ? filamentOf(fs, ctx.spec.roads) : 0;
  const paintOf = (kind: MapKind) => (kind === MapKind.Water ? waterN : kind === MapKind.Path || kind === MapKind.Track ? pathN : kind === MapKind.Road ? roadN : 0);
  const parts: BandPart[] = [];
  for (const body of bodies) {
    const slabs = sliceMesh(body.vertices, body.triangles, cuts.map((c) => c.z));
    slabs.forEach((slab, s) => {
      if (!slab.triangles.length) return;
      const filament = s === 0 ? first : cuts[s - 1].filament;
      let low = Infinity;
      let high = -Infinity;
      for (let i = 2; i < slab.vertices.length; i += 3) [low, high] = [Math.min(low, slab.vertices[i]), Math.max(high, slab.vertices[i])];
      const part: BandPart = { filament, vertices: slab.vertices, triangles: slab.triangles, low: low - z0, high: high - z0 };
      if ([waterN, pathN, roadN].some((f) => f && f !== filament)) {
        const paint = new Uint8Array(slab.triangles.length / 3);
        let any = false;
        const V = slab.vertices;
        const ranges = new Map<number, [number, number][]>();
        for (let t = 0; t < slab.triangles.length; t += 3) {
          const [a, b, c] = [slab.triangles[t], slab.triangles[t + 1], slab.triangles[t + 2]];
          if (!facesUp(normalOf(V, a, b, c)[2])) continue;
          const x = (V[a * 3] + V[b * 3] + V[c * 3]) / 3;
          const y = (V[a * 3 + 1] + V[b * 3 + 1] + V[c * 3 + 1]) / 3;
          const f = paintOf(ctx.map.kindAt(x, y));
          if (f && f !== filament) {
            paint[t / 3] = f;
            any = true;
            const zs = [V[a * 3 + 2], V[b * 3 + 2], V[c * 3 + 2]];
            const list = ranges.get(f) ?? [];
            list.push([Math.min(...zs) - z0, Math.max(...zs) - z0]);
            ranges.set(f, list);
          }
        }
        if (any) {
          part.paint = paint;
          part.paintRanges = [...ranges.entries()].flatMap(([f, list]) => mergeRanges(list, ctx.spec.layer).map(([lo, hi]) => ({ filament: f, low: lo, high: hi })));
        }
      }
      parts.push(part);
    });
  }
  return parts;
}

/** Height ranges joined where they overlap or come within `gap`. */
function mergeRanges(list: [number, number][], gap: number): [number, number][] {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + gap) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

/**
 * Bambu Studio's `paint_color` for a whole (unsplit) triangle painted with filament `n` — TriangleSelector's bits
 * (2 bits of split sides = 0, then the state: 2 bits, or 0b11 and 4-bit nibbles of n − 3) as hex digits, last first:
 * 1 → "4", 2 → "8", 3 → "0C", 4 → "1C", … 17 → "EC", 18 → "0FC", 19 → "1FC" (BambuStudio src/libslic3r/TriangleSelector.cpp serialize,
 * Model.cpp FacetsAnnotation::get_triangle_as_string).
 */
export function paintCode(n: number): string {
  if (n <= 0) return "";
  const bits: number[] = [0, 0];
  if (n < 3) bits.push(n & 1, (n >> 1) & 1);
  else {
    bits.push(1, 1);
    let r = n - 3;
    while (r >= 15) bits.push(1, 1, 1, 1), (r -= 15);
    for (let b = 0; b < 4; b++) bits.push((r >> b) & 1);
  }
  while (bits.length % 4) bits.push(0);
  let out = "";
  for (let i = 0; i < bits.length; i += 4) out = (bits[i] | (bits[i + 1] << 1) | (bits[i + 2] << 2) | (bits[i + 3] << 3)).toString(16).toUpperCase() + out;
  return out;
}

/**
 * Roughly how many filament changes printing these parts together takes (all standing on the bed, heights as printed):
 * layer by layer, the slicer starts with the filament it ended the last layer on if it's needed, then changes once per
 * other filament needed there.
 */
export function filamentSwaps(
  parts: { filament: number; low: number; high: number; paint?: Uint8Array; paintRanges?: { filament: number; low: number; high: number }[] }[],
  layer: number,
): number {
  let top = 0;
  for (const p of parts) top = Math.max(top, p.high);
  const n = Math.ceil(top / layer);
  const sets: Set<number>[] = Array.from({ length: n }, () => new Set());
  for (const p of parts) {
    const a = Math.max(0, Math.floor(p.low / layer + 1e-6));
    const b = Math.min(n, Math.ceil(p.high / layer - 1e-6));
    // Without ranges (older parts), painted triangles are taken to lie on the part's top few layers.
    const painted = !p.paintRanges && p.paint ? [...new Set(p.paint)].filter((f) => f > 0) : [];
    for (let l = a; l < b; l++) {
      sets[l].add(p.filament);
      if (painted.length && l >= b - 3) for (const f of painted) sets[l].add(f);
    }
    // Paint is on the layers its triangles span — a path climbing a hill paints a little on many layers — and Bambu
    // Studio paints a layer or so into the part below them, so one layer more is counted under each range.
    for (const r of p.paintRanges ?? []) {
      const ra = Math.max(0, Math.floor(r.low / layer + 1e-6) - 1);
      const rb = Math.min(n, Math.ceil(r.high / layer - 1e-6));
      for (let l = ra; l < Math.max(rb, ra + 1) && l < n; l++) sets[l].add(r.filament);
    }
  }
  let swaps = 0;
  let last = -1;
  for (const s of sets) {
    if (!s.size) continue;
    if (last >= 0) swaps += s.has(last) ? s.size - 1 : s.size;
    else swaps += s.size - 1;
    // Ends on some filament other than the one it started with, when there are several.
    last = s.size === 1 || !s.has(last) ? [...s][s.size - 1] : [...s].find((f) => f !== last)!;
  }
  return swaps;
}

// ---------------------------------------------------------------------------------------------------------------
// Full colour

export interface FullContext {
  spec: ColourSpec;
  scale: HeightScale;
  map: MapRaster;
}

/** A piece's mesh with a colour for every triangle corner (r, g, b, 0–255, three corners per triangle). */
export interface ColouredMesh {
  vertices: number[];
  triangles: number[];
  rgb: Uint8Array;
}

type RGB = [number, number, number];
export const hexRgb = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** The light: from the north-west, 45° up. */
const LIGHT: [number, number, number] = [-0.5, 0.5, Math.SQRT1_2];
/** Hill shading strength and limits (gentle: flat ground is unchanged). */
export const SHADE = { strength: 0.5, least: 0.72, most: 1.15 };
/** Snow lies where the ground slopes less than about 40° (normal's z ≥ this), fading in over the next 0.15. */
export const SNOW_SLOPE = 0.72;
/** Sides of the pieces are a little darker than the ground's tint at their height. */
export const SIDE_SHADE = 0.88;

/**
 * The map's colours on full-colour prints when paths or roads aren't given a colour of their own (`ColourSpec.paths` /
 * `roads` null); otherwise footpaths and tracks take the paths colour (red) and roads the roads colour (black), solid.
 * Buildings stay a dark brick brown.
 */
const MAP_COLOURS: Partial<Record<number, { colour: RGB; amount: number }>> = {
  [MapKind.Path]: { colour: [122, 78, 42], amount: 0.85 },
  [MapKind.Track]: { colour: [150, 110, 70], amount: 0.75 },
  [MapKind.Road]: { colour: [84, 82, 80], amount: 0.9 },
  [MapKind.Building]: { colour: [110, 60, 50], amount: 0.9 },
  [MapKind.Wood]: { colour: [38, 82, 36], amount: 0.55 },
};

/** The smooth height tint (m → colour): band colours at their start heights, blended between; the snow left out. */
export function tintAt(bands: ColourBand[], h: number): RGB {
  const stops = bands.filter((b) => !b.snow).sort((a, b) => a.from - b.from);
  if (!stops.length) return [160, 160, 160];
  if (h <= stops[0].from || stops.length === 1) return hexRgb(stops[0].colour);
  for (let i = 1; i < stops.length; i++)
    if (h < stops[i].from) {
      const t = (h - stops[i - 1].from) / Math.max(1e-9, stops[i].from - stops[i - 1].from);
      return mix(hexRgb(stops[i - 1].colour), hexRgb(stops[i].colour), t);
    }
  return hexRgb(stops[stops.length - 1].colour);
}

/** Every triangle corner of a piece coloured for a full-colour print. */
export function fullColours(bodies: Body[], ctx: FullContext): ColouredMesh {
  const { spec, scale } = ctx;
  const snow = spec.bands.find((b) => b.snow);
  const snowRange = Math.max(5, (spec.bands[spec.bands.length - 1].from - spec.bands[0].from) * 0.03);
  // Divide the triangles at the tint's stops (and the base's top) so the sides change colour at the right heights.
  const stops = spec.bands.filter((b) => !b.snow).map((b) => zOfHeight(scale, b.from));
  const baseTop = spec.base ? scale.z0 : -Infinity;
  const cuts = [...new Set([...(spec.base ? [baseTop] : []), ...stops])].sort((a, b) => a - b);
  const vertices: number[] = [];
  const triangles: number[] = [];
  const rgbs: number[] = [];
  const baseRgb = spec.base ? hexRgb(spec.base) : null;
  const water = spec.water ? hexRgb(spec.water) : hexRgb(WATER_BLUE);
  const snowRgb = snow ? hexRgb(snow.colour) : null;
  for (const body of bodies) {
    const slabs = sliceMesh(body.vertices, body.triangles, cuts, false);
    // One mesh again (slabs share their corners), keeping each triangle's slab for its colour.
    const parts = slabs.map((s) => s);
    const all = weld(
      parts.flatMap((p) => p.vertices),
      (() => {
        const out: number[] = [];
        let off = 0;
        for (const p of parts) {
          for (const i of p.triangles) out.push(i + off);
          off += p.vertices.length / 3;
        }
        return out;
      })(),
    );
    const V = all.vertices;
    const T = all.triangles;
    const nv = V.length / 3;
    // Smooth normals of the ground (upward faces only), for the shading.
    const vn = new Float64Array(nv * 3);
    const tn: [number, number, number][] = [];
    for (let t = 0; t < T.length; t += 3) {
      const [a, b, c] = [T[t], T[t + 1], T[t + 2]];
      const n = normalOf(V, a, b, c);
      tn.push(n);
      if (n[2] <= 0.2) continue;
      const [ux, uy, uz] = [V[b * 3] - V[a * 3], V[b * 3 + 1] - V[a * 3 + 1], V[b * 3 + 2] - V[a * 3 + 2]];
      const [wx, wy, wz] = [V[c * 3] - V[a * 3], V[c * 3 + 1] - V[a * 3 + 1], V[c * 3 + 2] - V[a * 3 + 2]];
      const area = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
      for (const i of [a, b, c]) for (let d = 0; d < 3; d++) vn[i * 3 + d] += n[d] * area;
    }
    const off = vertices.length / 3;
    vertices.push(...V);
    for (let t = 0; t < T.length; t += 3) {
      const n = tn[t / 3];
      const cz = (V[T[t] * 3 + 2] + V[T[t + 1] * 3 + 2] + V[T[t + 2] * 3 + 2]) / 3;
      const ground = n[2] > 0.2;
      // The base's own colour is for its sides; ground pressed below the base's top (a groove at the coast) stays ground.
      const inBase = baseRgb && cz < baseTop && !(ground && cz > baseTop - 2);
      for (let k = 0; k < 3; k++) {
        const i = T[t + k];
        triangles.push(i + off);
        const [x, y, z] = [V[i * 3], V[i * 3 + 1], V[i * 3 + 2]];
        let c: RGB;
        if (inBase) c = [...baseRgb] as RGB;
        else c = tintAt(spec.bands, heightOfZ(scale, z));
        if (!ground || inBase) {
          const shade = inBase ? 1 : SIDE_SHADE;
          rgbs.push(c[0] * shade, c[1] * shade, c[2] * shade);
          continue;
        }
        const l = Math.hypot(vn[i * 3], vn[i * 3 + 1], vn[i * 3 + 2]);
        const nn: [number, number, number] = l > 0 ? [vn[i * 3] / l, vn[i * 3 + 1] / l, vn[i * 3 + 2] / l] : n;
        const kind = ctx.map.empty ? MapKind.None : ctx.map.kindAt(x, y);
        if (kind === MapKind.Water) {
          // Water is flat colour: no hill shading on it.
          rgbs.push(water[0], water[1], water[2]);
          continue;
        } else {
          const own = kind === MapKind.Path || kind === MapKind.Track ? spec.paths : kind === MapKind.Road ? spec.roads : null;
          const f = MAP_COLOURS[kind];
          if (own) c = hexRgb(own);
          else if (f) c = mix(c, f.colour, f.amount);
          if (snowRgb && snow) {
            const above = Math.max(0, Math.min(1, (heightOfZ(scale, z) - snow.from) / snowRange + 0.5));
            const gentle = Math.max(0, Math.min(1, (Math.min(nn[2], n[2]) - SNOW_SLOPE) / 0.15));
            if (above * gentle > 0 && !own && kind !== MapKind.Road && kind !== MapKind.Building) c = mix(c, snowRgb, above * gentle);
          }
        }
        const lit = nn[0] * LIGHT[0] + nn[1] * LIGHT[1] + nn[2] * LIGHT[2];
        const shade = Math.max(SHADE.least, Math.min(SHADE.most, 1 + SHADE.strength * (lit - LIGHT[2])));
        rgbs.push(c[0] * shade, c[1] * shade, c[2] * shade);
      }
    }
  }
  const rgb = new Uint8Array(rgbs.length);
  for (let i = 0; i < rgbs.length; i++) rgb[i] = Math.max(0, Math.min(255, Math.round(rgbs[i])));
  return { vertices, triangles, rgb };
}

/** Colours rounded to `step` levels (fewer distinct colours = smaller files), as one palette and an index per corner. */
export function palette(rgb: Uint8Array, step = 4): { colours: string[]; index: Uint32Array } {
  const map = new Map<number, number>();
  const colours: string[] = [];
  const index = new Uint32Array(rgb.length / 3);
  const q = (v: number) => Math.min(255, Math.round(v / step) * step);
  for (let i = 0; i < index.length; i++) {
    const [r, g, b] = [q(rgb[i * 3]), q(rgb[i * 3 + 1]), q(rgb[i * 3 + 2])];
    const key = (r << 16) | (g << 8) | b;
    let j = map.get(key);
    if (j === undefined) {
      j = colours.length;
      map.set(key, j);
      colours.push(`#${key.toString(16).padStart(6, "0").toUpperCase()}`);
    }
    index[i] = j;
  }
  return { colours, index };
}

// ---------------------------------------------------------------------------------------------------------------
// The preview

/** Triangles as drawn (three corners each, puzzle mm) with a colour per corner (0–1), for the 3D view. */
export interface PreviewMesh {
  pos: Float32Array;
  col: Float32Array;
}

export function previewOfBands(parts: BandPart[], fs: Filament[]): PreviewMesh {
  let n = 0;
  for (const p of parts) n += p.triangles.length;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let at = 0;
  for (const p of parts) {
    const base = hexRgb(fs.find((f) => f.n === p.filament)?.colour ?? "#a0a0a0");
    for (let t = 0; t < p.triangles.length; t += 3) {
      const paint = p.paint?.[t / 3];
      const c = paint ? hexRgb(fs.find((f) => f.n === paint)?.colour ?? "#3a7bc0") : base;
      for (let k = 0; k < 3; k++) {
        const i = p.triangles[t + k];
        pos.set([p.vertices[i * 3], p.vertices[i * 3 + 1], p.vertices[i * 3 + 2]], at * 3);
        col.set([c[0] / 255, c[1] / 255, c[2] / 255], at * 3);
        at++;
      }
    }
  }
  return { pos, col };
}

export function previewOfFull(m: ColouredMesh): PreviewMesh {
  const n = m.triangles.length;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  for (let c = 0; c < n; c++) {
    const i = m.triangles[c];
    pos[c * 3] = m.vertices[i * 3];
    pos[c * 3 + 1] = m.vertices[i * 3 + 1];
    pos[c * 3 + 2] = m.vertices[i * 3 + 2];
    col[c * 3] = m.rgb[c * 3] / 255;
    col[c * 3 + 1] = m.rgb[c * 3 + 1] / 255;
    col[c * 3 + 2] = m.rgb[c * 3 + 2] / 255;
  }
  return { pos, col };
}
