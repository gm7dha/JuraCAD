/**
 * Islands to choose from for the Island puzzle (pure): each a box on the OS grid round it, with sea all round, so
 * land running off the box's edge (the mainland) can be left out. Boxes are given by their middle (degrees) and size.
 * Also the query that fetches boundaries round an area from OpenStreetMap.
 */
import { ROAD_RANK, TIDY_MARKS, type MarkChoice } from "./mapMarks";
import type { IslandOnly } from "./islandPuzzle";
import { gridToLatLon, latLonToGrid, type GridPoint } from "./osGrid";

export interface IslandPlace {
  id: string;
  name: string;
  /** South-west corner and size (m) on the OS grid. */
  sw: GridPoint;
  width: number;
  height: number;
  /** Just this island: points on it (and on land it may be joined to in the height data), on the OS grid. */
  only?: IslandOnly;
}

type LatLon = [number, number];

const around = (id: string, name: string, lat: number, lon: number, kmWide: number, kmTall: number, keep?: LatLon[], apart?: LatLon[]): IslandPlace => {
  const c = latLonToGrid({ lat, lon });
  const width = kmWide * 1000;
  const height = kmTall * 1000;
  const place: IslandPlace = { id, name, sw: { e: Math.round(c.e - width / 2), n: Math.round(c.n - height / 2) }, width, height };
  const grid = ([la, lo]: LatLon) => {
    const g = latLonToGrid({ lat: la, lon: lo });
    return { e: Math.round(g.e), n: Math.round(g.n) };
  };
  if (keep) place.only = { keep: keep.map(grid), ...(apart ? { apart: apart.map(grid) } : {}) };
  return place;
};

export const ISLANDS: IslandPlace[] = [
  // The whole grid's land: Ireland and France run off its edges, so they're left out.
  { id: "great-britain", name: "Great Britain", sw: { e: 0, n: 0 }, width: 665000, height: 1230000 },
  around("arran", "Isle of Arran", 55.58, -5.22, 32, 40),
  // Tiny (about 1.2 × 0.9 km, 338 m high), so a small area: it's then printed about 10 cm long.
  around("ailsa-craig", "Ailsa Craig", 55.2525, -5.1158, 3, 3, [[55.2525, -5.1158]]),
  around("wight", "Isle of Wight", 50.67, -1.33, 46, 28),
  around("man", "Isle of Man", 54.23, -4.55, 42, 60),
  around("anglesey", "Anglesey", 53.28, -4.37, 52, 42),
  around("mull", "Isle of Mull", 56.45, -6.05, 60, 50),
  // Islay without Jura (across the Sound of Islay): points in its east, on the Rinns and on the Oa.
  around("islay", "Islay", 55.76, -6.27, 46, 44, [[55.82, -6.17], [55.76, -6.42], [55.62, -6.25]]),
  // Jura without Islay, Scarba or Knapdale: points north and south of Loch Tarbert, where it's narrowest.
  around("jura", "Jura", 55.98, -5.89, 40, 48, [[55.89, -5.97], [56.05, -5.83]]),
  // Skye without the mainland, which the height data joins to it at the Skye Bridge (Kyle Akin) and Kylerhea, or the
  // Small Isles: points in the Cuillin, Trotternish, Duirinish and Sleat; others on Lochalsh, Glenelg, Applecross and Knoydart.
  around(
    "skye",
    "Isle of Skye",
    57.33,
    -6.22,
    90,
    92,
    [[57.23, -6.2], [57.507, -6.183], [57.4, -6.65], [57.1, -5.94]],
    [[57.31, -5.6], [57.2, -5.58], [57.45, -5.7], [57.07, -5.6]],
  ),
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

/** The widest area (m, the longer side) whose paths, lochs and roads are fetched from OpenStreetMap; bigger needs a map file. */
export const MARKS_MOST = 130_000;

/**
 * The query for what "From the map" puts on an island, round an area, as an .osm file. With `choice` tidy (the usual):
 * paths, footways, steps, bridleways and tracks with the walking routes they're on and the towns, parks and woods they're
 * judged against,
 * lochs, lakes and reservoirs ("water"), and motorways, trunk roads and A roads too ("all"; only the first two for "trunk"). With everything chosen: also
 * rivers and streams, and every main road. Buildings aren't fetched (a town is tens of thousands, and
 * at an island's scale almost all are too small to print): they come only from a map file. Null when the area is too big.
 */
export function marksQuery(sw: GridPoint, width: number, height: number, detail: "water" | "all", choice: MarkChoice = TIDY_MARKS): string | null {
  if (Math.max(width, height) > MARKS_MOST) return null;
  const corners = [
    gridToLatLon(sw),
    gridToLatLon({ e: sw.e + width, n: sw.n }),
    gridToLatLon({ e: sw.e, n: sw.n + height }),
    gridToLatLon({ e: sw.e + width, n: sw.n + height }),
  ];
  const r = (x: number) => x.toFixed(4);
  const box = [Math.min(...corners.map((c) => c.lat)), Math.min(...corners.map((c) => c.lon)), Math.max(...corners.map((c) => c.lat)), Math.max(...corners.map((c) => c.lon))].map(r).join(",");
  const paths = choice.paths !== "none";
  const parts = [
    ...(paths
      ? [
          // Footways too: England's public footpaths often are, and so are some hill paths (pavements are told apart later).
          `way["highway"~"^(path|footway|bridleway|steps|track)$"](${box});`,
          // Towns, parks and woods, which hill routes are judged against.
          `way["landuse"~"^(residential|commercial|retail|industrial)$"](${box});`,
          `way["leisure"~"^(park|garden|golf_course|recreation_ground)$"](${box});`,
        ]
      : []),
    `way["natural"="water"](${box});`,
    `relation["type"="multipolygon"]["natural"="water"](${box});`,
    `way["landuse"="reservoir"](${box});`,
    `relation["type"="multipolygon"]["landuse"="reservoir"](${box});`,
  ];
  if (choice.paths === "hills") parts.push(`way["natural"="wood"](${box});`, `way["landuse"="forest"](${box});`);
  if (choice.water === "all") parts.push(`way["waterway"~"^(river|canal|stream|burn)$"](${box});`);
  if (detail === "all" && choice.roads !== "none")
    parts.push(
      choice.roads === "all"
        ? `way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified)$"](${box});`
        : choice.roads === "main"
          ? `way["highway"~"^(motorway|trunk|primary)$"](${box});`
          : `way["highway"~"^(motorway|trunk)$"](${box});`,
    );
  // One request, at most 120 s and 60 MB of answer — the same as the biggest map file read. Walking routes come as
  // relations only (which ways they hold), not every member far outside the area.
  if (!paths) return `[out:xml][timeout:120][maxsize:62914560];(${parts.join("")});(._;>;);out qt;`;
  return `[out:xml][timeout:120][maxsize:62914560];relation["route"~"^(hiking|foot|walking)$"](${box})->.hr;(${parts.join("")});(._;>;);(._;.hr;);out qt;`;
}

/** What one fetch of marks asked for. */
export interface MarksFetched {
  detail: "water" | "all";
  choice: MarkChoice;
}

/** Does a fetch hold everything `detail` and `choice` need (everything fetched covers the tidy choices too)? */
export function fetchCovers(fetched: MarksFetched, detail: "water" | "all", choice: MarkChoice): boolean {
  if (detail === "all" && fetched.detail !== "all") return false;
  if (choice.water === "all" && fetched.choice.water !== "all") return false;
  if (choice.paths === "hills" && fetched.choice.paths !== "hills") return false;
  if (choice.paths === "all" && fetched.choice.paths === "none") return false;
  if (detail === "all" && ROAD_RANK[fetched.choice.roads] < ROAD_RANK[choice.roads]) return false;
  return true;
}
