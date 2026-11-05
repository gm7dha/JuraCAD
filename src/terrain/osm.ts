/**
 * OpenStreetMap files (pure): read an `.osm` file (the XML that openstreetmap.org's Export button saves) into the area
 * it covers and the things on the map — paths, tracks, roads, rivers and streams, lochs, buildings and names — then
 * move them onto the OS grid (metres east/north), keeping only as much as asked for. OSM has no heights: those still
 * come from the height tiles. Shared, unchanged, by JuraCAD's and JuraCUT's Mountain puzzles.
 */
import { latLonToGrid, type GridPoint, type LatLon } from "./osGrid";

type XY = [number, number];

/** How much of the map goes onto the puzzle. */
export type OsmDetail = "area" | "water" | "all";

export type OsmLineKind = "path" | "track" | "road" | "river" | "stream";
export type OsmShapeKind = "water" | "building";
export type OsmNameKind = "peak" | "hut" | "water" | "place";

export interface OsmData {
  /** The box it was exported from (degrees), or null when the file doesn't say. */
  bounds: { south: number; west: number; north: number; east: number } | null;
  lines: { kind: OsmLineKind; name?: string; pts: LatLon[] }[];
  /** Closed shapes: the first ring is the outline, any more are islands in it. */
  shapes: { kind: OsmShapeKind; name?: string; rings: LatLon[][] }[];
  names: { kind: OsmNameKind; text: string; at: LatLon }[];
  /** Nodes in the file (for "nothing here" messages). */
  nodes: number;
}

/** The map's things on the OS grid (metres). */
export interface MapFeatures {
  lines: { kind: OsmLineKind; pts: XY[] }[];
  shapes: { kind: OsmShapeKind; rings: XY[][] }[];
  names: { kind: OsmNameKind; text: string; at: XY }[];
}

export const NO_FEATURES: MapFeatures = { lines: [], shapes: [], names: [] };

/** A plain-English problem with the file. */
export class OsmError extends Error {}

/** At most this much text is read (an Export of a few kilometres is a few MB). */
export const MAX_OSM_BYTES = 60_000_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.includes("&")
    ? s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
        e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e] ?? m,
      )
    : s;

function attributes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out[m[1]] = decode(m[2] ?? m[3] ?? "");
  return out;
}

type Tags = Record<string, string>;

const PATHS = new Set(["path", "footway", "bridleway", "steps", "cycleway"]);
const NOT_ROADS = new Set(["proposed", "construction", "platform", "bus_stop", "elevator", "corridor", "raceway", "abandoned", "disused", "razed"]);
const RIVERS = new Set(["river", "canal"]);
const STREAMS = new Set(["stream", "brook", "ditch", "drain", "burn"]);

function lineKind(t: Tags): OsmLineKind | null {
  const h = t.highway;
  if (h && t.area !== "yes") {
    if (PATHS.has(h)) return "path";
    if (h === "track") return "track";
    if (!NOT_ROADS.has(h)) return "road";
  }
  const w = t.waterway;
  if (w && RIVERS.has(w)) return "river";
  if (w && STREAMS.has(w)) return "stream";
  return null;
}

function shapeKind(t: Tags): OsmShapeKind | null {
  if (t.natural === "water" || t.landuse === "reservoir" || t.landuse === "basin" || t.waterway === "riverbank" || t.water) return "water";
  if (t.building && t.building !== "no") return "building";
  return null;
}

function nameKind(t: Tags): OsmNameKind | null {
  if (t.natural === "peak" || t.natural === "hill" || t.natural === "volcano") return "peak";
  if (t.tourism === "alpine_hut" || t.tourism === "wilderness_hut" || t.amenity === "shelter") return "hut";
  if (["hamlet", "village", "town", "city", "locality", "isolated_dwelling", "farm"].includes(t.place ?? "")) return "place";
  return null;
}

/** A peak's name with its height, "Ben Nevis 1345 m", when the map gives one. */
function peakText(t: Tags): string {
  const ele = Number.parseFloat(t.ele ?? "");
  return Number.isFinite(ele) && ele > 0 && ele < 9000 ? `${t.name} ${Math.round(ele)} m` : t.name;
}

/** Ways joined end to end into closed rings (a relation's outline comes in pieces); unclosed leftovers are dropped. */
function joinRings(ways: string[][]): string[][] {
  const rings: string[][] = [];
  const left = ways.filter((w) => w.length >= 2).map((w) => [...w]);
  while (left.length) {
    let ring = left.pop()!;
    let grew = true;
    while (ring[0] !== ring[ring.length - 1] && grew) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const w = left[i];
        const end = ring[ring.length - 1];
        if (w[0] === end) ring = [...ring, ...w.slice(1)];
        else if (w[w.length - 1] === end) ring = [...ring, ...[...w].reverse().slice(1)];
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring.length >= 4 && ring[0] === ring[ring.length - 1]) rings.push(ring);
  }
  return rings;
}

/** Read an `.osm` file. Throws an OsmError (plain English) when it isn't one. */
export function readOsm(text: string): OsmData {
  if (text.length > MAX_OSM_BYTES) throw new OsmError("That map file is too big — export a smaller area (a few kilometres across).");
  if (!/<osm[\s>]/.test(text)) throw new OsmError("That doesn't look like an OpenStreetMap file. On openstreetmap.org, press Export and save the .osm file it gives you.");
  const nodes = new Map<string, LatLon>();
  const ways = new Map<string, { refs: string[]; tags: Tags }>();
  const relations: { members: { type: string; ref: string; role: string }[]; tags: Tags }[] = [];
  const nodeTags: { at: LatLon; tags: Tags }[] = [];
  let bounds: OsmData["bounds"] = null;

  let open: { kind: "node"; at: LatLon | null; tags: Tags } | { kind: "way"; id: string; refs: string[]; tags: Tags } | { kind: "relation"; members: { type: string; ref: string; role: string }[]; tags: Tags } | null = null;
  const re = /<(\/?)(node|way|relation|nd|tag|member|bounds)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [, closing, name, attrText, selfClosing] = m;
    if (closing) {
      if (open && open.kind === name) {
        if (open.kind === "node" && open.at && Object.keys(open.tags).length) nodeTags.push({ at: open.at, tags: open.tags });
        if (open.kind === "way") ways.set(open.id, { refs: open.refs, tags: open.tags });
        if (open.kind === "relation") relations.push({ members: open.members, tags: open.tags });
        open = null;
      }
      continue;
    }
    const a = attributes(attrText);
    if (name === "bounds") {
      const [s, w, n, e] = [a.minlat, a.minlon, a.maxlat, a.maxlon].map(Number);
      if ([s, w, n, e].every(Number.isFinite) && n > s && e > w) bounds = { south: s, west: w, north: n, east: e };
    } else if (name === "node") {
      const lat = Number(a.lat);
      const lon = Number(a.lon);
      const at = Number.isFinite(lat) && Number.isFinite(lon) && a.id ? { lat, lon } : null;
      if (at) nodes.set(a.id, at);
      if (!selfClosing) open = { kind: "node", at, tags: {} };
    } else if (name === "way") {
      if (!selfClosing && a.id) open = { kind: "way", id: a.id, refs: [], tags: {} };
    } else if (name === "relation") {
      if (!selfClosing) open = { kind: "relation", members: [], tags: {} };
    } else if (name === "nd") {
      if (open?.kind === "way" && a.ref) open.refs.push(a.ref);
    } else if (name === "member") {
      if (open?.kind === "relation" && a.ref) open.members.push({ type: a.type ?? "", ref: a.ref, role: a.role ?? "" });
    } else if (name === "tag") {
      if (open && a.k) open.tags[a.k] = a.v ?? "";
    }
  }
  if (!nodes.size) throw new OsmError("That map file has nothing in it. Export an area with the mountain in it from openstreetmap.org.");

  const pointsOf = (refs: string[]) => refs.map((r) => nodes.get(r)).filter((p): p is LatLon => !!p);
  const data: OsmData = { bounds, lines: [], shapes: [], names: [], nodes: nodes.size };
  for (const { refs, tags } of ways.values()) {
    const kind = lineKind(tags);
    if (kind) {
      const pts = pointsOf(refs);
      if (pts.length >= 2) data.lines.push({ kind, name: tags.name, pts });
      continue;
    }
    const shape = shapeKind(tags);
    if (shape && refs.length >= 4 && refs[0] === refs[refs.length - 1]) {
      const ring = pointsOf(refs);
      if (ring.length === refs.length) data.shapes.push({ kind: shape, name: tags.name, rings: [ring] });
    }
  }
  for (const { members, tags } of relations) {
    const shape = tags.type === "multipolygon" ? shapeKind(tags) : null;
    if (!shape) continue;
    const ringsOf = (role: (r: string) => boolean) =>
      joinRings(members.filter((x) => x.type === "way" && role(x.role)).map((x) => ways.get(x.ref)?.refs ?? []))
        .map(pointsOf)
        .filter((r) => r.length >= 4);
    const outers = ringsOf((r) => r !== "inner");
    const inners = ringsOf((r) => r === "inner");
    // Each outline with the islands that lie in it.
    for (const outer of outers) {
      const holes = inners.filter((h) => insideLatLon(h[0], outer));
      data.shapes.push({ kind: shape, name: tags.name, rings: [outer, ...holes] });
    }
  }
  for (const { at, tags } of nodeTags) {
    const kind = tags.name ? nameKind(tags) : null;
    if (kind) data.names.push({ kind, text: kind === "peak" ? peakText(tags) : tags.name, at });
  }
  return data;
}

function insideLatLon(p: LatLon, ring: LatLon[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [a, b] = [ring[i], ring[j]];
    if (a.lat > p.lat !== b.lat > p.lat && p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon) c = !c;
  }
  return c;
}

export function insideRing(p: XY, ring: XY[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [a, b] = [ring[i], ring[j]];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

const onGrid = (p: LatLon): XY => {
  const g = latLonToGrid(p);
  return [g.e, g.n];
};
const offGrid = (g: GridPoint) => !(g.e >= 0 && g.e <= 700000 && g.n >= 0 && g.n <= 1300000);

/**
 * The area the file covers, on the OS grid: the biggest grid-square-aligned box inside its export box (the grid is
 * turned a little from north–south lines of longitude), or the box round everything in it if it doesn't say. A
 * plain-English reason when it's outside Great Britain.
 */
export function osmArea(data: OsmData): { sw: GridPoint; width: number; height: number } | string {
  let b = data.bounds;
  if (!b) {
    const all = [...data.lines.flatMap((l) => l.pts), ...data.shapes.flatMap((s) => s.rings.flat()), ...data.names.map((n) => n.at)];
    if (!all.length) return "That map file doesn't say which area it covers. Export it again from openstreetmap.org.";
    b = { south: Math.min(...all.map((p) => p.lat)), north: Math.max(...all.map((p) => p.lat)), west: Math.min(...all.map((p) => p.lon)), east: Math.max(...all.map((p) => p.lon)) };
  }
  const [sw, se, ne, nw] = [
    { lat: b.south, lon: b.west },
    { lat: b.south, lon: b.east },
    { lat: b.north, lon: b.east },
    { lat: b.north, lon: b.west },
  ].map(latLonToGrid);
  if ([sw, se, ne, nw].some(offGrid) || b.south < 49 || b.north > 61.5 || b.west < -9 || b.east > 2.5)
    return "That map is outside Great Britain — the Mountain puzzle works on the Ordnance Survey's grid, which only covers Great Britain.";
  const e0 = Math.ceil(Math.max(sw.e, nw.e));
  const e1 = Math.floor(Math.min(se.e, ne.e));
  const n0 = Math.ceil(Math.max(sw.n, se.n));
  const n1 = Math.floor(Math.min(nw.n, ne.n));
  return { sw: { e: e0, n: n0 }, width: e1 - e0, height: n1 - n0 };
}

/** A point well inside a ring for its name: the middle of the longest stretch across it through its middle. */
function namePoint(ring: XY[]): XY {
  let [cx, cy, a] = [0, 0, 0];
  for (let i = 0; i < ring.length; i++) {
    const [p, q] = [ring[i], ring[(i + 1) % ring.length]];
    const c = p[0] * q[1] - q[0] * p[1];
    a += c;
    cx += (p[0] + q[0]) * c;
    cy += (p[1] + q[1]) * c;
  }
  const centre: XY = Math.abs(a) > 1e-9 ? [cx / (3 * a), cy / (3 * a)] : ring[0];
  if (insideRing(centre, ring)) return centre;
  const xs: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const [p, q] = [ring[i], ring[(i + 1) % ring.length]];
    if (p[1] > centre[1] !== q[1] > centre[1]) xs.push(p[0] + ((q[0] - p[0]) * (centre[1] - p[1])) / (q[1] - p[1]));
  }
  xs.sort((u, v) => u - v);
  let best: XY = ring[0];
  let widest = -1;
  for (let i = 0; i + 1 < xs.length; i += 2)
    if (xs[i + 1] - xs[i] > widest) {
      widest = xs[i + 1] - xs[i];
      best = [(xs[i] + xs[i + 1]) / 2, centre[1]];
    }
  return best;
}

/** What `detail` asks for, on the OS grid: "area" nothing; "water" paths, tracks, rivers, streams and lochs; "all" roads, buildings and names too. */
export function featuresOnGrid(data: OsmData, detail: OsmDetail): MapFeatures {
  if (detail === "area") return NO_FEATURES;
  const all = detail === "all";
  const lines = data.lines.filter((l) => all || l.kind !== "road").map((l) => ({ kind: l.kind, pts: l.pts.map(onGrid) }));
  const kept = data.shapes.filter((s) => all || s.kind === "water");
  const shapes = kept.map((s) => ({ kind: s.kind, rings: s.rings.map((r) => r.map(onGrid)) }));
  const names: MapFeatures["names"] = [];
  if (all) {
    for (const n of data.names) names.push({ kind: n.kind, text: n.text, at: onGrid(n.at) });
    kept.forEach((s, i) => {
      if (s.kind === "water" && s.name) names.push({ kind: "water", text: s.name, at: namePoint(shapes[i].rings[0]) });
    });
  }
  return { lines, shapes, names };
}

/** Counts for a short summary: "12 paths, 4 rivers or streams, 3 lochs". */
export function featureSummary(f: MapFeatures): string {
  const count = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : "");
  const parts = [
    count(f.lines.filter((l) => l.kind === "path" || l.kind === "track").length, "path or track", "paths and tracks"),
    count(f.lines.filter((l) => l.kind === "river" || l.kind === "stream").length, "river or stream", "rivers and streams"),
    count(f.shapes.filter((s) => s.kind === "water").length, "loch", "lochs"),
    count(f.lines.filter((l) => l.kind === "road").length, "road", "roads"),
    count(f.shapes.filter((s) => s.kind === "building").length, "building", "buildings"),
    count(f.names.length, "name", "names"),
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "nothing from the map in this area";
}
