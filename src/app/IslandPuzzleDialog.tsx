/**
 * Island puzzle: pick an island (or all of Great Britain, any area by grid reference, or an OpenStreetMap file's area), trim
 * its edges if wanted, fetch its heights, cut its land
 * into interlocking pieces — of about a chosen size, or along county / parish boundaries fetched from OpenStreetMap — and
 * download the pieces as print plates (3MF). "From the map" presses hill paths and lochs (and trunk roads and buildings) from
 * OpenStreetMap into the ground, fetched for the island or read from a map file. Nothing goes into the design. The maths is
 * in src/terrain/islandPuzzle.ts.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CUSTOM_PRINTER, printerOf, PRINTERS } from "../model/printBed";
import { areaProblem, readHeights, zoomFor, type HeightGrid } from "../terrain/elevation";
import { featuresForIsland, IN_PLACE_FIT, ISLAND_DEFAULTS, islandChecks, type Coast, type IslandBuilt, type IslandCuts, type IslandLand, type IslandOnly, type IslandSpec } from "../terrain/islandPuzzle";
import { BOUNDARY_LEVELS, boundaryQuery, fetchCovers, ISLANDS, MARKS_MOST, marksQuery, OVERPASS_URL, type MarksFetched } from "../terrain/islands";
import { TIDY_MARKS, type MarkChoice } from "../terrain/mapMarks";
import { formatGridRef, parseGridRef, type GridPoint } from "../terrain/osGrid";
import { boundariesOnGrid, boundaryLevels, featuresOnGrid, featureSummary, levelName, MAX_OSM_BYTES, NO_FEATURES, OsmError, readOsm, type MapFeatures, type OsmData, type OsmDetail } from "../terrain/osm";
import { allPlatesZip, IN_PLACE_SETTINGS, plate3mf, platesByLevel, platesFor, platesInPlace, TOWER_ROOM, towerWhere, type BedRect } from "../terrain/puzzle3mf";
import { GROUND_BROWN, islandBands, mapOnPuzzle, mapRaster, NO_MAP, SEA_BLUE, type HeightScale } from "../terrain/colour";
import { ColourDownloads, ColourPanel, useBandsFollow, useColoured, useUsualColour } from "./PuzzleColour";
import { downloadFile, safeFileName } from "./download";
import type { IslandJob, IslandReply } from "./islandPuzzle.worker";
import { Modal } from "./Modal";
import { DETAILS, MarkChoices, markStroke, Mountain3D, TrimSliders } from "./MountainPuzzleDialog";
import { areaInside, ISLAND_MOST, osmIslandArea, trimmedIsland, type IslandArea } from "../terrain/islandArea";
import { NO_TRIM, noTrim, type Trim } from "../terrain/mountainCrop";
import { PickableView, type TopViewPick } from "./PathPicker";
import { idsOf, isDropped, islandViewBox, landIdsAfter, NONE_DROPPED, pickableLines, withoutDropped } from "../terrain/pickMarks";
import { openMountain } from "./mountainState";
import { coastOnGrid, coastQuery } from "../terrain/coastline";
import { loadTerrainTile } from "./mountainTiles";
import { amsSlotsOf, loadPrinter, printerBed, savePrinter } from "./printerSetting";

/** The widest area (m): all of Great Britain. */
const MOST = ISLAND_MOST;

type Source = "island" | "ref" | "osm";

interface Area {
  sw: GridPoint;
  width: number;
  height: number;
  name: string;
  /** A list island's own land only. */
  only?: IslandOnly;
  /** The OpenStreetMap file the area came from: its paths, lochs and boundaries are the map. */
  osm?: OsmData;
}

const blobOf = (bytes: Uint8Array, type: string) => new Blob([new Uint8Array(bytes)], { type });

function areaFrom(source: Source, islandId: string, ref: string, km: [number, number], osm: { name: string; data: OsmData } | null): Area | string {
  if (source === "osm") {
    if (!osm) return "Choose an OpenStreetMap file (.osm): on openstreetmap.org, zoom to the island, press Export and save the file.";
    const a = osmIslandArea(osm.data, osm.name);
    return typeof a === "string" ? a : { ...a, osm: osm.data };
  }
  if (source === "island") {
    const isl = ISLANDS.find((i) => i.id === islandId) ?? ISLANDS[0];
    return areaProblem(isl.sw, isl.width, isl.height, MOST, zoomFor(isl.sw, isl.width, isl.height)) ?? { ...isl };
  }
  const centre = parseGridRef(ref);
  const [width, height] = [km[0] * 1000, km[1] * 1000];
  if (!centre) return areaProblem(null, width, height)!;
  const sw = { e: Math.round(centre.e - width / 2), n: Math.round(centre.n - height / 2) };
  return areaProblem(sw, width, height, MOST, zoomFor(sw, width, height)) ?? { sw, width, height, name: `Island at ${formatGridRef(centre, 6) ?? ref}` };
}

/**
 * What OpenStreetMap's query service sent, as a map — or a plain reason. It answers 200 even when a query ran out of
 * time or memory, with a <remark> saying so instead of the map.
 */
async function overpassMap(res: Response, what: string): Promise<OsmData> {
  if (res.status === 429 || res.status === 504) throw new Error(`OpenStreetMap's map service is busy — try again in a minute, or use a map file.`);
  if (res.status === 400) throw new Error(`OpenStreetMap's map service couldn't make sense of the request for ${what}. Please use a map file instead.`);
  if (!res.ok) throw new Error(`OpenStreetMap's map service didn't answer properly (error ${res.status}). Try again later, or use a map file.`);
  const text = await res.text();
  const remark = /<remark>([\s\S]*?)<\/remark>/.exec(text)?.[1] ?? "";
  if (/timed out|timeout|out of memory|memory/i.test(remark))
    throw new Error(`There's too much ${what} in this area for OpenStreetMap's map service to send at once. Use a map file instead (on openstreetmap.org, Export a smaller area).`);
  if (remark && !/<node\b/.test(text)) throw new Error(`OpenStreetMap's map service couldn't send the ${what} (${remark.trim().slice(0, 120)}). Try again later, or use a map file.`);
  if (!/<node\b/.test(text)) return { bounds: null, lines: [], shapes: [], names: [], boundaries: [], regionNames: [], nodes: 0 };
  return readOsm(text);
}

/** How long (ms) the puzzle waits for the coastline before it's made from the heights alone. */
const COAST_WAIT_MS = 60_000;

/** Coastlines fetched this session, by area: fetched once, used again when the same island is loaded again. */
const coastCache = new Map<string, Coast>();

/** What's known about the coastline of the area loaded: being fetched, fetched (null lines = none there), or not to be had. */
type CoastState = { key: string; status: "fetching" } | { key: string; status: "ready"; lines: Coast | null; from: "fetched" | "file" } | { key: string; status: "failed"; message: string };

const areaKey = (a: Area) => `${a.sw.e},${a.sw.n},${a.width},${a.height}`;

const sameArea = (a: Area | null, b: Area | null) => !!a && !!b && a.sw.e === b.sw.e && a.sw.n === b.sw.n && a.width === b.width && a.height === b.height;

export function IslandPuzzleDialog() {
  const close = () => openMountain(false);
  const [source, setSource] = useState<Source>("island");
  // "An OpenStreetMap file": the area it covers, and its paths, lochs and boundaries.
  const [osmFile, setOsmFile] = useState<{ name: string; data: OsmData } | null>(null);
  const [osmError, setOsmError] = useState<string | null>(null);
  // How much of the area is trimmed off each side before the island is made (as the Mountain puzzle's).
  const [trim, setTrim] = useState<Trim>(NO_TRIM);
  const [islandId, setIslandId] = useState(ISLANDS[1].id);
  const [ref, setRef] = useState("NR 95 36");
  const [km, setKm] = useState<[number, number]>([30, 40]);

  const [printer, setPrinter] = useState(() => loadPrinter());
  const bed = printerBed(printer);
  const [spec, setSpec] = useState<Omit<IslandSpec, "bed">>(() => ({ ...ISLAND_DEFAULTS }));
  const [cutBy, setCutBy] = useState<"pieces" | "boundaries">("pieces");
  const [level, setLevel] = useState(6);
  const [map, setMap] = useState<{ name: string; data: OsmData; covers?: IslandArea } | null>(null);
  const [mapBusy, setMapBusy] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  // "From the map": what to press into the ground, and the map it comes from (fetched, or a file).
  const [detail, setDetail] = useState<OsmDetail>("area");
  const [marks, setMarks] = useState<MarkChoice>(TIDY_MARKS);
  const [marksMap, setMarksMap] = useState<{ name: string; data: OsmData; fetched: MarksFetched | null; covers?: IslandArea } | null>(null);
  const [marksBusy, setMarksBusy] = useState(false);
  const [marksError, setMarksError] = useState<string | null>(null);

  const [loaded, setLoaded] = useState<{ area: Area; grid: HeightGrid } | null>(null);
  // OpenStreetMap's coastline round the area loaded: it, not the heights, says where the sea is (the heights read narrow
  // sea passages and the mouths of sea lochs as low land, so lochs got closed off and filled in).
  const [coastState, setCoastState] = useState<CoastState | null>(null);
  const coastKey = loaded ? areaKey(loaded.area) : null;
  const coast: Coast | undefined = coastState && coastState.key === coastKey && coastState.status === "ready" ? coastState.lines ?? undefined : undefined;
  const coastPending = !!loaded && (!coastState || coastState.key !== coastKey || coastState.status === "fetching");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [puzzle, setPuzzle] = useState<IslandBuilt | null>(null);
  // What the island is made from: the area loaded, less what's trimmed off each side (the same grid when nothing is).
  // Which land is kept ("every island", a list island's own land) is decided on the whole area, so a trim through the
  // island doesn't make its cut edge "the area's edge" and drop it.
  const used = useMemo(
    () => (loaded ? trimmedIsland(loaded.area, loaded.grid, trim, { sea: spec.sea, land: spec.land, only: loaded.area.only, ...(coast ? { coast } : {}) }) : null),
    [loaded, trim, spec.sea, spec.land, coast],
  );
  // The map file the heights came from, if they did: it is the map for marks (and boundaries, if it has them).
  const fileMap = loaded?.area.osm ? { name: loaded.area.name, data: loaded.area.osm, fetched: null } : null;
  // The area whose heights are loaded now: an answer from OpenStreetMap for another one is ignored.
  const loadedKey = useRef<string | null>(null);
  loadedKey.current = loaded ? areaKey(loaded.area) : null;
  const [working, setWorking] = useState(false);
  const builder = useRef(new IslandBuilder());
  const [buildError, setBuildError] = useState<string | null>(null);
  const [explode, setExplode] = useState(0);
  // Colour bands with the usual colours to start with (the owner's wish); the bands follow the ground until changed.
  // The last island's highest ground, so the bands don't jump while a new puzzle is being made.
  const lastHigh = useRef(500);
  if (puzzle) lastHigh.current = puzzle.high;
  const usualBands = islandBands(lastHigh.current);
  const [colour, setColour, autoBands] = useUsualColour(usualBands, SEA_BLUE);
  useBandsFollow(colour, setColour, autoBands, usualBands);
  // Put together in colour: the prime tower will be turned off in Bambu Studio, so no room is kept for it.
  const [towerOff, setTowerOff] = useState(false);
  const colourOn = colour.mode !== "plain";

  const area = areaFrom(source, islandId, ref, km, osmFile);
  const areaReady = typeof area !== "string";
  const fresh = areaReady && sameArea(loaded?.area ?? null, area);

  const getHeights = async () => {
    if (typeof area === "string") return;
    setLoading(true);
    setError(null);
    try {
      const z = zoomFor(area.sw, area.width, area.height);
      // About a thousand samples across the longer side: narrow straits stay sea.
      const spacing = Math.max(15, Math.max(area.width, area.height) / 1000);
      const grid = await readHeights(loadTerrainTile, area.sw, area.width, area.height, spacing, z);
      // Another area: its trims start again (shares of the old area's sides would mean something else on this one).
      if (!sameArea(loaded?.area ?? null, area)) setTrim(NO_TRIM);
      setLoaded({ area, grid });
      setMap(null);
      setMarksMap(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // The coastline: from the heights' own map file when that has one, else fetched from OpenStreetMap (once per area).
  useEffect(() => {
    if (!loaded) return;
    const key = areaKey(loaded.area);
    const { osm, sw, width, height } = loaded.area;
    if (osm) {
      const lines = osm.coastline?.length ? coastOnGrid(osm.coastline) : null;
      setCoastState({ key, status: "ready", lines, from: "file" });
      return;
    }
    const cached = coastCache.get(key);
    if (cached) {
      setCoastState({ key, status: "ready", lines: cached.length ? cached : null, from: "fetched" });
      return;
    }
    const query = coastQuery(sw, width, height);
    if (!query) {
      setCoastState({ key, status: "ready", lines: null, from: "fetched" });
      return;
    }
    setCoastState({ key, status: "fetching" });
    let gone = false;
    // The puzzle waits for the coastline, so never for long: past COAST_WAIT_MS it's made from the heights.
    const stop = new AbortController();
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      stop.abort();
    }, COAST_WAIT_MS);
    (async () => {
      try {
        let res: Response;
        try {
          res = await fetch(OVERPASS_URL, { method: "POST", body: new URLSearchParams({ data: query }), signal: stop.signal });
        } catch {
          throw new Error(late ? "OpenStreetMap's map service took too long to send the coastline" : "Couldn't reach OpenStreetMap's map service for the coastline");
        }
        const data = await overpassMap(res, "coastline").catch((e: unknown) => {
          throw late ? new Error("OpenStreetMap's map service took too long to send the coastline") : e;
        });
        const lines = data.coastline?.length ? coastOnGrid(data.coastline) : [];
        coastCache.set(key, lines);
        if (!gone) setCoastState({ key, status: "ready", lines: lines.length ? lines : null, from: "fetched" });
      } catch (e) {
        if (!gone) setCoastState({ key, status: "failed", message: e instanceof Error ? e.message.replace(/\.$/, "") : String(e) });
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => {
      gone = true;
      clearTimeout(timer);
      stop.abort();
    };
  }, [loaded]);

  const getBoundaries = async () => {
    if (!loaded) return;
    setMapBusy(true);
    setMapError(null);
    try {
      // Just the part being made (the area less its trims).
      const covers = used ?? loaded.area;
      const { sw, width, height } = covers;
      const asked = areaKey(loaded.area);
      let res: Response;
      try {
        res = await fetch(OVERPASS_URL, { method: "POST", body: new URLSearchParams({ data: boundaryQuery(sw, width, height, level) }) });
      } catch {
        throw new Error("Couldn't reach OpenStreetMap's map service — check you're online, or use a map file.");
      }
      const data = await overpassMap(res, "boundaries");
      if (loadedKey.current !== asked) return;
      setMap({ name: `${levelName(level)} from OpenStreetMap`, data, covers: { sw: covers.sw, width: covers.width, height: covers.height } });
    } catch (e) {
      setMap(null);
      setMapError(e instanceof Error ? e.message : String(e));
    } finally {
      setMapBusy(false);
    }
  };

  /** One request to OpenStreetMap's query service for the island's paths, rivers and lochs (and roads), on a click. */
  const getMarks = async () => {
    if (!loaded || detail === "area") return;
    const covers = used ?? loaded.area;
    const { sw, width, height } = covers;
    const query = marksQuery(sw, width, height, detail, marks);
    if (!query) return;
    setMarksBusy(true);
    setMarksError(null);
    const asked = areaKey(loaded.area);
    try {
      let res: Response;
      try {
        res = await fetch(OVERPASS_URL, { method: "POST", body: new URLSearchParams({ data: query }) });
      } catch {
        throw new Error("Couldn't reach OpenStreetMap's map service — check you're online, or use a map file.");
      }
      const data = await overpassMap(res, "paths, lochs and roads");
      // Heights for another area were fetched meanwhile: this map is for the old one.
      if (loadedKey.current !== asked) return;
      setMarksMap({ name: "OpenStreetMap", data, fetched: { detail, choice: marks }, covers: { sw: covers.sw, width: covers.width, height: covers.height } });
    } catch (e) {
      setMarksError(e instanceof OsmError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setMarksBusy(false);
    }
  };

  const chooseOsmFile = (file: File | undefined) => {
    if (!file) return;
    setOsmError(null);
    if (file.size > MAX_OSM_BYTES) {
      setOsmFile(null);
      setOsmError("That map file is too big — export a smaller area (a few kilometres across).");
      return;
    }
    file
      .text()
      .then((text) => {
        setOsmFile({ name: file.name.replace(/\.(osm|xml)$/i, "").replace(/^map$/i, "My map") || "My map", data: readOsm(text) });
        // A map file is for its marks: start with its paths and lochs pressed in.
        setDetail((d) => (d === "area" ? "water" : d));
      })
      .catch((e) => {
        setOsmFile(null);
        setOsmError(e instanceof OsmError ? e.message : "That file couldn't be read as an OpenStreetMap file.");
      });
  };

  const chooseMarksFile = (file: File | undefined) => {
    if (!file) return;
    setMarksError(null);
    file
      .text()
      .then((text) => setMarksMap({ name: file.name, data: readOsm(text), fetched: null }))
      .catch((e) => {
        setMarksMap(null);
        setMarksError(e instanceof OsmError ? e.message : "That file couldn't be read as an OpenStreetMap file.");
      });
  };

  const chooseFile = (file: File | undefined) => {
    if (!file) return;
    setMapError(null);
    file
      .text()
      .then((text) => setMap({ name: file.name, data: readOsm(text) }))
      .catch((e) => {
        setMap(null);
        setMapError(e instanceof OsmError ? e.message : "That file couldn't be read as an OpenStreetMap file.");
      });
  };

  // Boundaries fetched or read win; else the heights' own map file, when it has any.
  const fileBoundaries = useMemo(() => (fileMap && boundaryLevels(fileMap.data).length ? fileMap : null), [loaded]);
  const boundaryMap = map ?? fileBoundaries;
  const levels = useMemo(() => (boundaryMap ? boundaryLevels(boundaryMap.data) : []), [boundaryMap]);
  // The level asked for if the map has it, else its finest.
  const usedLevel = levels.some(([l]) => l === level) ? level : levels.length ? levels[levels.length - 1][0] : level;
  const cuts: IslandCuts | undefined = useMemo(() => (cutBy === "boundaries" && boundaryMap ? boundariesOnGrid(boundaryMap.data, usedLevel) : undefined), [cutBy, boundaryMap, usedLevel]);
  // Fetched for a smaller area than is being made now (a trim was taken back): fetch again to cover it all.
  const shortOf = (m: { covers?: IslandArea } | null) => !!m?.covers && !!used && !areaInside(used, m.covers);

  // The heights' own map file, else what was fetched or read for the marks.
  const marksSource = fileMap ?? marksMap;
  // What the usual rules keep from the map, then less the paths and roads clicked off on the top view.
  const mapFeatures: MapFeatures = useMemo(
    () => (detail !== "area" && marksSource ? featuresOnGrid(marksSource.data, detail, marks, loaded?.grid) : NO_FEATURES),
    [detail, marksSource, marks, loaded],
  );
  const [dropped, setDropped] = useState<ReadonlySet<string>>(NONE_DROPPED);
  // A new area starts with everything kept (kept by the map's own way ids, so fetching the same area again keeps the choice).
  const droppedArea = loaded ? areaKey(loaded.area) : "";
  // The map's ways whose lines are on the land, as the latest puzzle knows (see landIdsAfter): only those are offered.
  const landIds = useRef<ReadonlySet<string>>(new Set<string>());
  useEffect(() => {
    setDropped(NONE_DROPPED);
    landIds.current = new Set<string>();
  }, [droppedArea]);
  const features: MapFeatures = useMemo(() => withoutDropped(mapFeatures, dropped), [mapFeatures, dropped]);
  // Fetched for less than is asked for now ("Everything" needs the roads, rivers and every path need fetching too).
  const fetchedTooLittle = !fileMap && detail !== "area" && !!marksMap?.fetched && (!fetchCovers(marksMap.fetched, detail, marks) || shortOf(marksMap));
  const needsFetch = detail !== "area" && (!marksMap || fetchedTooLittle);
  const canFetch = !!used && fresh && Math.max(used.width, used.height) <= MARKS_MOST;

  // Put together, the island is sized on Bambu Studio's own bed (it centres the file there) and keeps out of the printer's
  // no-print corner (and, on the H2D, of what only the other nozzle reaches); in several filaments it leaves a spot for the
  // prime tower.
  const printerInfo = printerOf(printer.printer);
  const placeBed: [number, number, number] = spec.inPlace ? (printerInfo?.slicerBed ?? bed) : bed;
  const keepOut: BedRect[] = [...(printerInfo?.bedExclude ?? []), ...(printerInfo?.oneNozzleOnly ?? [])];
  const only = loaded?.area.only;
  const fullSpec: IslandSpec = {
    ...(spec.inPlace ? { ...spec, bed: placeBed, keepOut, tower: colourOn && !towerOff } : { ...spec, bed }),
    // Trimmed: the land was already chosen on the whole area (trimmedIsland), so build all that's left.
    ...(used?.decided ? { land: "all" as const } : only ? { only } : {}),
  };
  const problems = islandChecks(fullSpec);
  const specKey = JSON.stringify(fullSpec);
  useEffect(() => {
    if (!loaded || problems.length || coastPending) {
      // A build still running for the old settings mustn't show its puzzle beside the problem.
      builder.current.stop();
      setPuzzle(null);
      setWorking(coastPending && !problems.length);
      return;
    }
    setWorking(true);
    const askedDropped = dropped;
    const timer = setTimeout(() => {
      if (!used) return;
      builder.current.build({ grid: used.grid, sw: used.sw, width: used.width, height: used.height, spec: fullSpec, cuts, features, ...(coast ? { coast } : {}) }, (reply) => {
        if ("error" in reply) {
          setPuzzle(null);
          setBuildError(reply.error);
        } else {
          landIds.current = landIdsAfter(landIds.current, idsOf(reply.puzzle.marks.lines), askedDropped);
          setPuzzle(reply.puzzle);
          setBuildError(null);
        }
        setWorking(false);
      });
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, used, specKey, cuts, features, coast, coastPending]);

  // Stop the builder when the window closes.
  useEffect(() => () => builder.current.stop(), []);

  // Colour bands: pieces at different heights get plates of their own, so a plate changes colour on the same layers.
  const byLevel = colourOn && colour.mode === "bands";
  const inPlace = !!spec.inPlace;
  // Put together: one plate, every piece where it sits in the finished puzzle (it must fit the bed less its margins).
  const placed = useMemo(() => (puzzle && inPlace ? platesInPlace(puzzle.pieces, placeBed, puzzle.room) : null), [puzzle, placeBed[0], placeBed[1], placeBed[2], inPlace]);
  const plates = useMemo(
    () => (!puzzle ? [] : placed ? (placed.fits ? placed.plates : []) : (byLevel ? platesByLevel : platesFor)(puzzle.pieces, bed)),
    [puzzle, placed, bed[0], bed[1], bed[2], byLevel],
  );
  const settings = inPlace ? IN_PLACE_SETTINGS : undefined;
  // Where the prime tower goes, in plain words (Bambu Studio's tower can be dragged, not typed in).
  const towerAt = puzzle?.tower?.at ?? null;
  const where = towerAt ? towerWhere(towerAt, placeBed) : null;
  const towerText = towerOff
    ? " Turn the prime tower off in Bambu Studio (Others › Prime tower) before slicing."
    : !where
      ? ""
      : where.usual
        ? " For several filaments Bambu Studio adds a prime tower. It should already sit in the free space at the back left; if it lands on the island, drag it into that free space."
        : ` For several filaments Bambu Studio adds a prime tower at the back left, which is on the island here: drag it to the free space ${where.words} of the bed.`;
  // Offered when room for the tower would cost the island size (or there's no room at all).
  const offerTowerOff = inPlace && colourOn && (towerOff || !!puzzle?.tower?.shrunk || (!!puzzle?.tower && !puzzle.tower.at));
  const chooseInPlace = (on: boolean) => {
    setSpec((s) => ({ ...s, inPlace: on, scale: on ? Math.min(s.scale, 1) : s.scale }));
    if (on) setExplode(0);
  };
  const fileName = safeFileName(`${loaded?.area.name ?? "Island"} puzzle`, "Island puzzle");
  // How ground heights sit in the puzzle (base + height × relief / highest), and the map over it, for colouring.
  const scaleKey = puzzle ? [spec.base, spec.relief, puzzle.high].join(",") : "";
  const scale: HeightScale | null = useMemo(() => (puzzle ? { z0: spec.base, h0: 0, mmPerM: spec.relief / Math.max(puzzle.high, 1) } : null), [scaleKey]);
  const puzzleMap = useMemo(() => (puzzle && loaded ? mapOnPuzzle(featuresForIsland(features, puzzle.k).features, (puzzle.origin ?? used?.sw ?? loaded.area.sw).e, (puzzle.origin ?? used?.sw ?? loaded.area.sw).n, puzzle.k) : NO_MAP), [puzzle, features]);
  const mapSize: [number, number] = puzzle ? [puzzle.width, puzzle.height] : [1, 1];
  const paintMap = useMemo(() => mapRaster(puzzleMap, mapSize[0], mapSize[1]), [puzzleMap]);
  const { coloured, working: colouring, error: colourError } = useColoured(colourOn ? puzzle?.pieces ?? null : null, colour, scale, puzzleMap, mapSize, paintMap);
  const set = <K extends keyof typeof spec>(key: K, value: (typeof spec)[K]) => setSpec((s) => ({ ...s, [key]: value }));
  const numberBox = (value: number, onChange: (v: number) => void, step: number, min: number, max: number, unit: string) => (
    <span className="mountain-number">
      <input type="number" value={value} step={step} min={min} max={max} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && onChange(e.target.valueAsNumber)} />
      <span className="muted">{unit}</span>
    </span>
  );
  const named = puzzle?.pieces.filter((p) => p.region).length ?? 0;

  return (
    <Modal title="Island puzzle" onClose={close} width={1280}>
      <div className="mountain-layout">
        <div className="mountain-side">
          <h3 className="library-heading">1. The island</h3>
          <div className="mountain-choices" role="radiogroup" aria-label="Which island">
            <label>
              <input type="radio" name="island-source" checked={source === "island"} onChange={() => setSource("island")} /> An island from the list
            </label>
            <label>
              <input type="radio" name="island-source" checked={source === "ref"} onChange={() => setSource("ref")} /> Round a grid reference
            </label>
            <label>
              <input type="radio" name="island-source" checked={source === "osm"} onChange={() => setSource("osm")} /> An OpenStreetMap file
            </label>
          </div>
          {source === "osm" ? (
            <>
              <label className="mountain-row">
                <span>Map file</span>
                <input type="file" accept=".osm,.xml,application/xml,text/xml" onChange={(e) => chooseOsmFile(e.target.files?.[0])} />
              </label>
              <p className="muted small">
                On openstreetmap.org, zoom to the island, press <strong>Export</strong> and save the .osm file. The puzzle covers the area the file
                covers; the heights still come from the height data, and the map's paths, lochs and roads (and any boundaries in it) are used from the
                file. Trim the edges below once the heights are in. A map of part of the mainland? Choose “All the land in the area”.
              </p>
              {osmError && <p className="error-text small">{osmError}</p>}
            </>
          ) : source === "island" ? (
            <label className="mountain-row">
              <span>Island</span>
              <select value={islandId} onChange={(e) => setIslandId(e.target.value)}>
                {ISLANDS.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label className="mountain-row">
                <span>Middle at</span>
                <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="NR 95 36" />
              </label>
              <div className="mountain-row">
                <span>Area</span>
                <span>
                  {numberBox(km[0], (v) => setKm([v, km[1]]), 1, 0.2, 1300, "km west to east")} {numberBox(km[1], (v) => setKm([km[0], v]), 1, 0.2, 1300, "km south to north")}
                </span>
              </div>
              <p className="muted small">Leave sea all round the island; land running off the edge (the mainland) can be left out.</p>
            </>
          )}
          {typeof area !== "string" && area.only ? (
            <p className="muted small">Only {area.name} itself is used. Other land in the area is left out, and any land the height data wrongly joins on (at a bridge or narrow strait) is cut away.</p>
          ) : (
          <div className="mountain-row">
            <span>Land</span>
            <select value={spec.land} onChange={(e) => set("land", e.target.value as IslandLand)}>
              <option value="islands">Every island (not the mainland)</option>
              <option value="biggest">Just the biggest island</option>
              <option value="all">All the land in the area</option>
            </select>
          </div>
          )}
          {typeof area === "string" ? (
            <p className="error-text small">{area}</p>
          ) : (
            <button className="primary-button mountain-fetch" onClick={getHeights} disabled={loading || fresh}>
              {loading ? "Getting heights…" : fresh ? "Heights ready" : "Get the heights"}
            </button>
          )}
          {error && <p className="error-text small">{error}</p>}
          {loaded && !fresh && areaReady && <p className="muted small">The area has changed — get the heights again to use it.</p>}
          {loaded && (
            <>
              <TrimSliders trim={trim} setTrim={setTrim} size={[loaded.area.width, loaded.area.height]} unit={(v) => formatDistance(v)} />
              <AreaView grid={loaded.grid} area={loaded.area} used={used} sea={spec.sea} trimmed={!noTrim(trim)} />
              <p className="muted small">
                {coastPending
                  ? "Getting the coastline from OpenStreetMap…"
                  : coastState?.status === "failed"
                    ? `${coastState.message}, so the heights decide where the sea is (narrow sea lochs may come out filled in).`
                    : coast && puzzle?.coastline
                      ? `Coastline from OpenStreetMap${coastState?.status === "ready" && coastState.from === "file" ? " (your map file)" : ""}: it decides where the sea is, so sea lochs and narrow straits stay open.`
                      : coast
                        ? puzzle
                          ? ""
                          : "Coastline from OpenStreetMap."
                        : "No coastline here on OpenStreetMap, so the heights decide where the sea is."}
              </p>
            </>
          )}

          <h3 className="library-heading">2. Pieces</h3>
          <div className="mountain-choices" role="radiogroup" aria-label="How it's cut">
            <label>
              <input type="radio" name="island-cut" checked={cutBy === "pieces"} onChange={() => setCutBy("pieces")} /> Into pieces of about{" "}
              {numberBox(spec.piece, (v) => set("piece", v), 5, 15, 150, "mm")}
            </label>
            <label>
              <input type="radio" name="island-cut" checked={cutBy === "boundaries"} onChange={() => setCutBy("boundaries")} /> Along real boundaries
            </label>
          </div>
          {cutBy === "boundaries" && (
            <>
              <label className="mountain-row">
                <span>Boundaries</span>
                <select value={level} onChange={(e) => setLevel(Number(e.target.value))}>
                  {BOUNDARY_LEVELS.map(([l, label]) => (
                    <option key={l} value={l}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button className="text-button mountain-fetch" onClick={getBoundaries} disabled={!loaded || !fresh || mapBusy}>
                {mapBusy ? "Getting boundaries…" : "Get the boundaries from OpenStreetMap"}
              </button>
              <label className="mountain-row">
                <span>Or a map file</span>
                <input type="file" accept=".osm,.xml,application/xml,text/xml" onChange={(e) => chooseFile(e.target.files?.[0])} />
              </label>
              {!loaded && <p className="muted small">Get the heights first.</p>}
              {mapError && <p className="error-text small">{mapError}</p>}
              {boundaryMap && (
                <p className="muted small">
                  {levels.length
                    ? `${boundaryMap.name}: ${levels.map(([l, n]) => `${levelName(l).toLowerCase()} (${n} lines)`).join(", ")}.${usedLevel !== level ? ` Using ${levelName(usedLevel).toLowerCase()}.` : ""}`
                    : `${boundaryMap.name} has no boundaries in it — try another level.`}
                  {shortOf(map) ? " They were fetched for a smaller area than you're making now — get them again to cover it all." : ""}
                </p>
              )}
            </>
          )}

          <h3 className="library-heading">3. From the map</h3>
          <label className="mountain-row">
            <span>From the map</span>
            <select value={detail} onChange={(e) => setDetail(e.target.value as OsmDetail)}>
              {DETAILS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {detail !== "area" && fileMap && (
            <>
              <MarkChoices choice={marks} onChange={setMarks} roads={detail === "all"} />
              <p className="muted small">
                From your map file, {fileMap.name}: {featureSummary(features)}.{puzzle?.marks.tooSmall ? ` ${puzzle.marks.tooSmall} too small to show at this scale are left off.` : ""} Paths
                {detail === "all" ? " and roads" : ""} become thin, shallow grooves in the ground, lochs flat water{detail === "all" ? ", buildings small blocks" : ""}. Marks stop at
                the coast and at the trimmed edges.
              </p>
            </>
          )}
          {detail !== "area" && !fileMap && (
            <>
              <MarkChoices choice={marks} onChange={setMarks} roads={detail === "all"} />
              {canFetch || !loaded ? (
                <button className="text-button mountain-fetch" onClick={getMarks} disabled={!loaded || !fresh || marksBusy}>
                  {marksBusy ? "Getting the map…" : needsFetch ? "Get them from OpenStreetMap" : "Get them again from OpenStreetMap"}
                </button>
              ) : (
                <p className="muted small">This area is too big to fetch from OpenStreetMap — use a map file (an Export from openstreetmap.org) instead.</p>
              )}
              <label className="mountain-row">
                <span>Or a map file</span>
                <input type="file" accept=".osm,.xml,application/xml,text/xml" onChange={(e) => chooseMarksFile(e.target.files?.[0])} />
              </label>
              {!loaded && <p className="muted small">Get the heights first.</p>}
              {marksError && <p className="error-text small">{marksError}</p>}
              <p className="muted small">
                Paths{detail === "all" ? " and roads" : ""} become thin, shallow grooves in the ground, lochs flat water{detail === "all" ? ", buildings small blocks (buildings only from a map file — fetched, a town would be too much)" : ""}. Marks stop at the coast; grooves are kept shallow on the dovetails and narrow strips so nothing gets weak.
              </p>
              {marksMap && (
                <p className="muted small">
                  {marksMap.name}: {featureSummary(features)}.{puzzle?.marks.tooSmall ? ` ${puzzle.marks.tooSmall} too small to show at this scale are left off.` : ""}
                  {fetchedTooLittle ? (shortOf(marksMap) ? " They were fetched for a smaller area than you're making now — get them again to cover it all." : " Get them again for what you've added.") : ""}
                </p>
              )}
            </>
          )}

          <h3 className="library-heading">4. Size</h3>
          <label className="mountain-row">
            <span>Printer</span>
            <select value={printer.printer} onChange={(e) => setPrinter(savePrinter({ printer: e.target.value }))} title="Also changes the printer in the 3D print panel">
              {PRINTERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              {printer.printer === CUSTOM_PRINTER && <option value={CUSTOM_PRINTER}>My own size</option>}
            </select>
          </label>
          <label className="mountain-row">
            <span>Print</span>
            <span>
              <input type="checkbox" checked={inPlace} onChange={(e) => chooseInPlace(e.target.checked)} /> Print it put together (in place)
            </span>
          </label>
          <p className="muted small">
            {inPlace
              ? `The whole island prints on one plate with every piece where it sits in the finished puzzle, so it can be as big as the bed. The gap between pieces is what keeps them apart — nothing is printed there. At a fit gap of ${IN_PLACE_FIT} mm the narrowest gap between pieces comes out about 0.3 mm, the room print-in-place parts need with a 0.4 mm nozzle. Print a small test first.`
              : "Pieces are laid out apart on as many plates as they need. Tick this to print the island put together on one plate instead."}
          </p>
          <div className="mountain-row">
            <span>Scale</span>
            <span>
              {numberBox(Math.round(spec.scale * 100), (v) => set("scale", v / 100), 10, 20, inPlace ? 100 : 1000, "%")}
              <span className="muted small">
                {inPlace
                  ? ` 100% = the island fills the bed (${placeBed[0]} × ${placeBed[1]} mm, less 5 mm round the edge${keepOut.length ? " and the parts kept free" : ""}), in the middle, where Bambu Studio puts it; it can't be bigger`
                  : ` 100% = the finished puzzle covers the bed (${bed[0]} × ${bed[1]} mm)`}
              </span>
            </span>
          </div>
          <div className="mountain-row">
            <span>Base</span>
            <span>
              {numberBox(spec.base, (v) => set("base", v), 0.5, 1.5, 30, "mm")}
              <span className="muted small"> thick at the coast</span>
            </span>
          </div>
          <div className="mountain-row">
            <span>Hills</span>
            <span>
              {numberBox(spec.relief, (v) => set("relief", v), 1, 0, 150, "mm")}
              <span className="muted small"> the highest ground stands above the base</span>
            </span>
          </div>
          <div className="mountain-row">
            <span>Fit gap</span>
            <span>
              {numberBox(spec.fit, (v) => set("fit", v), 0.01, 0, 0.5, "mm each side")}
              <span className="muted small">
                {inPlace
                  ? " Printed put together: pieces that come off stuck together need a wider gap (0.15 makes about 0.4 mm between them); keep it at 0.1 or more."
                  : " Too loose? Lower it by 0.02–0.05 mm. Too tight? Raise it."}
              </span>
            </span>
          </div>
          <div className="mountain-row">
            <span>Pattern</span>
            <span>
              {numberBox(spec.seed, (v) => set("seed", Math.round(v)), 1, 1, 999999, "")}
              <span className="muted small"> where the pieces and tabs go</span>
            </span>
          </div>

          <h3 className="library-heading">5. Colour</h3>
          <ColourPanel
            spec={colour}
            setSpec={setColour}
            usual={() => islandBands(lastHigh.current)}
            slots={amsSlotsOf(printer)}
            setSlots={(n) => setPrinter(savePrinter({ amsSlots: n }))}
            usualBase={GROUND_BROWN}
            usualWater={SEA_BLUE}
            has={paintMap}
            roadsAsked={detail === "all"}
            ground={puzzle ? [0, puzzle.high] : null}
          />
        </div>

        <div className="mountain-main">
          {!loaded ? (
            <div className="mountain-empty muted">
              <p>
                Choose an island and press <strong>Get the heights</strong>.
              </p>
              <p className="small">Heights come free from Amazon's open Terrain Tiles; boundaries from OpenStreetMap.</p>
            </div>
          ) : (
            <>
              <div className="mountain-previews">
                <IslandTopView
                  puzzle={puzzle}
                  pick={puzzle && loaded ? { lines: pickableLines(featuresForIsland(mapFeatures, puzzle.k).features.lines, dropped, landIds.current), dropped, onChange: setDropped, pending: working } : null}
                  origin={puzzle ? (puzzle.origin ?? used?.sw ?? loaded?.area.sw ?? null) : null}
                />
                <Mountain3D puzzle={puzzle} explode={explode} paint={colourOn ? (coloured?.preview ?? null) : null} />
              </div>
              <label className="mountain-explode small">
                Pull apart <input type="range" min={0} max={20} value={explode} onChange={(e) => setExplode(Number(e.target.value))} />
              </label>
              {problems.map((p) => (
                <p key={p} className="error-text small">
                  {p}
                </p>
              ))}
              {buildError && <p className="error-text small">{buildError}</p>}
              {working && <p className="muted small">Working…</p>}
              {puzzle && (
                <div className="mountain-summary small">
                  <p>
                    <strong>{puzzle.pieces.length} pieces</strong>
                    {puzzle.alongBoundaries ? ` cut along ${levelName(usedLevel).toLowerCase()}${named ? ` (${named} named)` : ""}` : ""} — finished{" "}
                    {placed ? `${Math.round(placed.size[0])} × ${Math.round(placed.size[1])}` : `${Math.round(puzzle.width)} × ${Math.round(puzzle.height)}`} mm, {spec.base} mm thick at the coast and {Math.round(spec.base + spec.relief)} mm
                    on the highest ground ({Math.round(puzzle.high)} m). 1 mm is {formatDistance(1 / puzzle.k)} across.
                  </p>
                  <p className="muted">
                    {puzzle.joins} dovetails hold the pieces together
                    {puzzle.warnings.some((w) => w.includes("fewer than two")) ? "" : ` — at least two on every piece${puzzle.loose ? " that has a neighbour" : ""}`}.
                    {puzzle.marks.shown ? ` ${puzzle.marks.shown} things from the map are pressed into the ground.` : ""}
                  </p>
                  {[...(used?.notes ?? []).filter((w) => !puzzle.warnings.includes(w)), ...puzzle.warnings].map((w) => (
                    <p key={w} className="mountain-warn">
                      {w}
                    </p>
                  ))}
                </div>
              )}
              {placed && !placed.fits && (
                <p className="error-text small">
                  Put together, the island is {Math.round(placed.size[0])} × {Math.round(placed.size[1])} mm — too big for the free part of the bed. Lower the scale,
                  or untick “Print it put together”.
                </p>
              )}
              {placed?.fits && (
                <p className="muted small">
                  One plate, the pieces put together as above. In Bambu Studio don't use Arrange (it would spread the pieces out); each piece comes in with
                  no brim and elephant-foot compensation on, so the first layer doesn't join them.
                  {" "}Bambu Studio puts the island in the middle of the bed when it opens the file; it's sized to fit there.
                  {printerInfo?.bedExclude?.length ? " It keeps clear of the front-left corner, where this printer wipes its nozzle." : ""}
                  {printerInfo?.oneNozzleOnly?.length ? " It stays within what one nozzle reaches." : ""}
                  {colourOn ? towerText : ""}
                  {colourOn && puzzle?.tower?.shrunk
                    ? ` The island is a little smaller than the bed allows, so the back-left corner (${TOWER_ROOM} × ${TOWER_ROOM} mm) stays free for the prime tower.`
                    : ""}
                  {colourOn && puzzle?.tower && !puzzle.tower.at ? " There's no free spot for the prime tower: lower the scale to make room for it." : ""}
                  {colour.mode === "full" ? " The full-colour files can't carry those settings: turn the brim off and elephant-foot compensation on yourself." : ""}
                </p>
              )}
              {offerTowerOff && (
                <div className="small">
                  <label>
                    <input type="checkbox" checked={towerOff} onChange={(e) => setTowerOff(e.target.checked)} /> I'll turn the prime tower off in Bambu Studio — keep the
                    island full size
                  </label>
                  <p className="muted">
                    The prime tower can be turned off in Bambu Studio (Others › Prime tower). Colour changes then flush only into the chute at the back, which can
                    leave a little more colour bleed where colours change.
                  </p>
                </div>
              )}
              {colourOn && colouring && <p className="muted small">Colouring the pieces…</p>}
              {colourOn && colourError && <p className="error-text small">{colourError}</p>}
              {colourOn && puzzle && coloured && scale && plates.length > 0 && (
                <ColourDownloads spec={colour} coloured={coloured} plates={plates} scale={scale} map={paintMap} fileName={fileName} bedWidth={bed[0]} settings={settings} inPlace={inPlace} />
              )}
              {!colourOn && puzzle && plates.length > 0 && (
                <div className="mountain-downloads">
                  <span className="small">
                    {plates.length} {plates.length === 1 ? "plate" : "plates"} for Bambu Studio:
                  </span>
                  {plates.map((p, i) => (
                    <button
                      key={i}
                      className="text-button"
                      onClick={() => downloadFile(blobOf(plate3mf(p, `${fileName} - plate ${i + 1}`, settings), "model/3mf"), `${fileName} - plate ${i + 1} of ${plates.length}.3mf`)}
                      title={p.pieces.map((x) => x.piece.name).join(", ")}
                    >
                      Plate {i + 1} ({p.pieces.length})
                    </button>
                  ))}
                  <button className="primary-button" onClick={() => downloadFile(blobOf(allPlatesZip(plates, fileName, settings), "application/zip"), `${fileName}.zip`)}>
                    All plates (.zip)
                  </button>
                </div>
              )}
              {puzzle && <p className="muted small">Pieces are numbered from the north-west, as on the map above.</p>}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** The longest a puzzle is given before the work is taken as lost (a worker can die without saying so). */
const BUILD_LIMIT_MS = 120_000;

/**
 * Builds puzzles in a worker, one at a time: a new build stops one still running (the worker is started afresh), so
 * only the latest settings' answer arrives. Stopping drops the answer that was waited for.
 */
class IslandBuilder {
  private worker: Worker | null = null;
  private busy = false;
  private next = 1;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  build(job: Omit<IslandJob, "id">, done: (reply: IslandReply) => void) {
    if (this.busy) this.stop();
    if (!this.worker) this.worker = new Worker(new URL("./islandPuzzle.worker.ts", import.meta.url), { type: "module", name: "juracad-island" });
    const id = this.next++;
    this.busy = true;
    const finish = (reply: IslandReply) => {
      this.clearWatchdog();
      this.busy = false;
      done(reply);
    };
    this.worker.onmessage = (e: MessageEvent<IslandReply>) => {
      if (e.data.id === id) finish(e.data);
    };
    this.worker.onerror = (e) => {
      e.preventDefault();
      this.stop();
      finish({ id, error: "The puzzle couldn't be made — the browser stopped the work part-way. Try smaller pieces or a smaller area." });
    };
    this.watchdog = setTimeout(() => {
      this.stop();
      finish({ id, error: "Making the puzzle took too long and was stopped. Try bigger pieces, a smaller area or a lower scale." });
    }, BUILD_LIMIT_MS);
    this.worker.postMessage({ ...job, id } satisfies IslandJob);
  }
  stop() {
    this.clearWatchdog();
    this.worker?.terminate();
    this.worker = null;
    this.busy = false;
  }
  private clearWatchdog() {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }
}

/** "120 m", "2.5 km". */
const formatDistance = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);

/**
 * The whole area loaded, from above, north up: land green (lighter higher up), sea blue, and what the trims cut off
 * dimmed — so the trims can be set before the island is made.
 */
function AreaView({ grid, area, used, sea, trimmed }: { grid: HeightGrid; area: IslandArea; used: IslandArea | null; sea: number; trimmed: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // The picture of the heights only changes with the heights (and the sea level).
  const picture = useMemo(() => {
    const most = 300;
    const s = Math.min(most / area.width, most / area.height);
    const [w, h] = [Math.max(1, Math.round(area.width * s)), Math.max(1, Math.round(area.height * s))];
    let high = 1;
    for (const v of grid.h) high = Math.max(high, v);
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        // Row 0 is the north edge.
        const i = Math.min(grid.nx - 1, Math.round(((x + 0.5) / s) / grid.spacing));
        const j = Math.min(grid.ny - 1, Math.round(((h - y - 0.5) / s) / grid.spacing));
        const v = grid.h[j * grid.nx + i];
        const k = (y * w + x) * 4;
        if (v > sea) {
          const t = Math.min(1, v / high);
          [px[k], px[k + 1], px[k + 2]] = [90 + 120 * t, 140 + 70 * t, 80 + 110 * t];
        } else [px[k], px[k + 1], px[k + 2]] = [79, 127, 174];
        px[k + 3] = 255;
      }
    return { w, h, s, px };
  }, [grid, area.width, area.height, sea]);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { w, h, s, px } = picture;
    canvas.width = w;
    canvas.height = h;
    ctx.putImageData(new ImageData(px, w, h), 0, 0);
    if (!used || !trimmed) return;
    // Dim everything but the part kept, then outline it.
    const x0 = (used.sw.e - area.sw.e) * s;
    const x1 = x0 + used.width * s;
    const y0 = h - (used.sw.n - area.sw.n + used.height) * s;
    const y1 = h - (used.sw.n - area.sw.n) * s;
    ctx.fillStyle = "rgba(10,15,25,0.55)";
    ctx.fillRect(0, 0, w, y0);
    ctx.fillRect(0, y1, w, h - y1);
    ctx.fillRect(0, y0, x0, y1 - y0);
    ctx.fillRect(x1, y0, w - x1, y1 - y0);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
  }, [picture, used, trimmed, area.sw.e, area.sw.n]);
  return (
    <figure className="mountain-figure">
      <canvas ref={ref} className="mountain-top" />
      <figcaption className="muted small">The whole area, north up{trimmed ? "; what's trimmed off is dimmed" : ""}.</figcaption>
    </figure>
  );
}

/** From above, north up: each piece in its own colour with its number. */
function IslandTopView({ puzzle, pick, origin }: { puzzle: IslandBuilt | null; pick: TopViewPick | null; origin: { e: number; n: number } | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    if (!puzzle) {
      canvas.width = 380;
      canvas.height = 260;
      ctx.clearRect(0, 0, 380, 260);
      return;
    }
    const size = 380;
    const s = Math.min(size / puzzle.width, size / puzzle.height);
    const [w, h] = [Math.round(puzzle.width * s), Math.round(puzzle.height * s)];
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "center";
    puzzle.pieces.forEach((p, n) => {
      const b = p.bodies[0];
      ctx.fillStyle = `hsl(${(n * 137) % 360} 45% 62%)`;
      ctx.beginPath();
      for (let t = 0; t < b.triangles.length; t += 3) {
        const ids = [b.triangles[t], b.triangles[t + 1], b.triangles[t + 2]];
        if (ids.some((i) => b.vertices[i * 3 + 2] !== 0)) continue;
        ids.forEach((i, k) => (k ? ctx.lineTo(b.vertices[i * 3] * s, h - b.vertices[i * 3 + 1] * s) : ctx.moveTo(b.vertices[i * 3] * s, h - b.vertices[i * 3 + 1] * s)));
        ctx.closePath();
      }
      ctx.fill();
    });
    // The map's marks, only where there's land (drawn onto the pieces just painted).
    ctx.save();
    ctx.globalCompositeOperation = "source-atop";
    const px = ([x, y]: [number, number]): [number, number] => [x * s, h - y * s];
    for (const shape of puzzle.marks.shapes) {
      ctx.beginPath();
      for (const ring of shape.rings) ring.forEach((p, i) => (i ? ctx.lineTo(...px(p)) : ctx.moveTo(...px(p))));
      ctx.fillStyle = shape.kind === "water" ? "rgba(60,120,200,0.85)" : "rgba(60,50,40,0.9)";
      ctx.fill("evenodd");
    }
    for (const line of puzzle.marks.lines) {
      // Left off since this puzzle was made: not drawn now, so the view says what the files will have.
      if (pick && isDropped(line, pick.dropped)) continue;
      ctx.beginPath();
      line.pts.forEach((p, i) => (i ? ctx.lineTo(...px(p)) : ctx.moveTo(...px(p))));
      const stroke = markStroke(line.kind, line.thin);
      ctx.strokeStyle = stroke.colour;
      ctx.lineWidth = stroke.width;
      ctx.setLineDash(stroke.dash);
      ctx.stroke();
    }
    ctx.restore();
    ctx.setLineDash([]);
    // The sea under it all, then the numbers.
    ctx.save();
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "#4f7fae";
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    ctx.fillStyle = "rgba(20,30,40,0.9)";
    puzzle.pieces.forEach((p) => {
      const [[x0, y0], , [x1, y1]] = p.outline;
      if ((x1 - x0) * s > 14 && (y1 - y0) * s > 10) ctx.fillText(p.name.split(" ")[0], ((x0 + x1) / 2) * s, h - ((y0 + y1) / 2) * s + 3);
    });
  }, [puzzle, pick?.dropped]);
  return (
    <figure className="mountain-figure">
      <PickableView pick={pick} box={puzzle && origin ? islandViewBox(puzzle, origin) : null}>
        <canvas ref={ref} className="mountain-top" />
      </PickableView>
      <figcaption className="muted small">From above, north up: each piece numbered, with the map's paths, rivers and lochs.</figcaption>
    </figure>
  );
}
