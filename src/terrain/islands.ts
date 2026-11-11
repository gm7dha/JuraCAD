/**
 * Islands to choose from for the Island puzzle (pure): each a box on the OS grid round it, with sea all round, so
 * land running off the box's edge (the mainland) can be left out. Boxes are given by their middle (degrees) and size.
 * Also the query that fetches boundaries round an area from OpenStreetMap.
 */
import { gridToLatLon, latLonToGrid, type GridPoint } from "./osGrid";

export interface IslandPlace {
  id: string;
  name: string;
  /** South-west corner and size (m) on the OS grid. */
  sw: GridPoint;
  width: number;
  height: number;
}

const around = (id: string, name: string, lat: number, lon: number, kmWide: number, kmTall: number): IslandPlace => {
  const c = latLonToGrid({ lat, lon });
  const width = kmWide * 1000;
  const height = kmTall * 1000;
  return { id, name, sw: { e: Math.round(c.e - width / 2), n: Math.round(c.n - height / 2) }, width, height };
};

export const ISLANDS: IslandPlace[] = [
  // The whole grid's land: Ireland and France run off its edges, so they're left out.
  { id: "great-britain", name: "Great Britain", sw: { e: 0, n: 0 }, width: 665000, height: 1230000 },
  around("arran", "Isle of Arran", 55.58, -5.22, 32, 40),
  around("wight", "Isle of Wight", 50.67, -1.33, 46, 28),
  around("man", "Isle of Man", 54.23, -4.55, 42, 60),
  around("anglesey", "Anglesey", 53.28, -4.37, 52, 42),
  around("mull", "Isle of Mull", 56.45, -6.05, 60, 50),
  around("islay", "Islay", 55.76, -6.27, 46, 44),
  around("skye", "Isle of Skye", 57.33, -6.22, 90, 92),
  around("lewis-harris", "Lewis and Harris", 58.1, -6.65, 70, 105),
  around("orkney", "Orkney", 59.06, -2.9, 72, 82),
  around("shetland", "Shetland", 60.36, -1.35, 90, 125),
];

/** Overpass API (OpenStreetMap's query service, which lets any web page ask): free, no key, CORS allowed. */
export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

/** The query for one level of boundaries round an area, with their lines and label points, as an .osm file. */
export function boundaryQuery(sw: GridPoint, width: number, height: number, level: number): string {
  const corners = [
    gridToLatLon(sw),
    gridToLatLon({ e: sw.e + width, n: sw.n }),
    gridToLatLon({ e: sw.e, n: sw.n + height }),
    gridToLatLon({ e: sw.e + width, n: sw.n + height }),
  ];
  const r = (x: number) => x.toFixed(4);
  const box = [Math.min(...corners.map((c) => c.lat)), Math.min(...corners.map((c) => c.lon)), Math.max(...corners.map((c) => c.lat)), Math.max(...corners.map((c) => c.lon))].map(r).join(",");
  return `[out:xml][timeout:120];relation["boundary"="administrative"]["admin_level"="${Math.round(level)}"](${box});(._;>;);out body;`;
}

/** Boundary levels offered, in words, coarsest first (OpenStreetMap's admin_level in Great Britain). */
export const BOUNDARY_LEVELS: [number, string][] = [
  [4, "Countries (England, Scotland, Wales)"],
  [6, "Counties and council areas"],
  [8, "Districts"],
  [10, "Parishes and communities"],
];

/** The widest area (m, the longer side) whose paths, rivers and lochs are fetched from OpenStreetMap; bigger needs a map file. */
export const MARKS_MOST = 130_000;

/**
 * The query for what "From the map" puts on an island, round an area, as an .osm file: footpaths, tracks, rivers,
 * streams and lochs ("water"), and main roads too ("all"). Buildings aren't fetched (a town is tens of thousands, and at an
 * island's scale almost all are too small to print): they come only from a map file. Null when the area is too big.
 */
export function marksQuery(sw: GridPoint, width: number, height: number, detail: "water" | "all"): string | null {
  if (Math.max(width, height) > MARKS_MOST) return null;
  const corners = [
    gridToLatLon(sw),
    gridToLatLon({ e: sw.e + width, n: sw.n }),
    gridToLatLon({ e: sw.e, n: sw.n + height }),
    gridToLatLon({ e: sw.e + width, n: sw.n + height }),
  ];
  const r = (x: number) => x.toFixed(4);
  const box = [Math.min(...corners.map((c) => c.lat)), Math.min(...corners.map((c) => c.lon)), Math.max(...corners.map((c) => c.lat)), Math.max(...corners.map((c) => c.lon))].map(r).join(",");
  const parts = [
    `way["highway"~"^(path|footway|bridleway|steps|track)$"](${box});`,
    `way["waterway"~"^(river|canal|stream|burn)$"](${box});`,
    `way["natural"="water"](${box});`,
    `relation["type"="multipolygon"]["natural"="water"](${box});`,
  ];
  if (detail === "all") parts.push(`way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified)$"](${box});`);
  // One request, at most 120 s and 60 MB of answer — the same as the biggest map file read.
  return `[out:xml][timeout:120][maxsize:62914560];(${parts.join("")});(._;>;);out qt;`;
}
