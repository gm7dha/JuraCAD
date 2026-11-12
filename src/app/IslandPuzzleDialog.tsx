/**
 * Island puzzle: pick an island (or all of Great Britain, or any area by grid reference), fetch its heights, cut its land
 * into interlocking pieces — of about a chosen size, or along county / parish boundaries fetched from OpenStreetMap — and
 * download the pieces as print plates (3MF). "From the map" presses paths, rivers and lochs (and roads and buildings) from
 * OpenStreetMap into the ground, fetched for the island or read from a map file. Nothing goes into the design. The maths is
 * in src/terrain/islandPuzzle.ts.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CUSTOM_PRINTER, printerOf, PRINTERS } from "../model/printBed";
import { areaProblem, readHeights, zoomFor, type HeightGrid } from "../terrain/elevation";
import { IN_PLACE_FIT, ISLAND_DEFAULTS, islandChecks, type IslandBuilt, type IslandCuts, type IslandLand, type IslandSpec } from "../terrain/islandPuzzle";
import { BOUNDARY_LEVELS, boundaryQuery, ISLANDS, MARKS_MOST, marksQuery, OVERPASS_URL } from "../terrain/islands";
import { formatGridRef, parseGridRef, type GridPoint } from "../terrain/osGrid";
import { boundariesOnGrid, boundaryLevels, featuresOnGrid, featureSummary, levelName, NO_FEATURES, OsmError, readOsm, type MapFeatures, type OsmData, type OsmDetail } from "../terrain/osm";
import { allPlatesZip, freeRooms, IN_PLACE_SETTINGS, plate3mf, platesByLevel, platesFor, platesInPlace, towerCorner, TOWER_ROOM, type BedRect } from "../terrain/puzzle3mf";
import { islandBands, mapOnPuzzle, mapRaster, NO_MAP, PLAIN_COLOUR, SEA_BLUE, type ColourSpec, type HeightScale } from "../terrain/colour";
import { ColourDownloads, ColourPanel, useColoured } from "./PuzzleColour";
import { downloadFile, safeFileName } from "./download";
import type { IslandJob, IslandReply } from "./islandPuzzle.worker";
import { Modal } from "./Modal";
import { DETAILS, Mountain3D } from "./MountainPuzzleDialog";
import { openMountain } from "./mountainState";
import { loadTerrainTile } from "./mountainTiles";
import { loadPrinter, printerBed, savePrinter } from "./printerSetting";

/** The widest area (m): all of Great Britain. */
const MOST = 1_300_000;

interface Area {
  sw: GridPoint;
  width: number;
  height: number;
  name: string;
}

const blobOf = (bytes: Uint8Array, type: string) => new Blob([new Uint8Array(bytes)], { type });

function areaFrom(source: "island" | "ref", islandId: string, ref: string, km: [number, number]): Area | string {
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

const areaKey = (a: Area) => `${a.sw.e},${a.sw.n},${a.width},${a.height}`;

const sameArea = (a: Area | null, b: Area | null) => !!a && !!b && a.sw.e === b.sw.e && a.sw.n === b.sw.n && a.width === b.width && a.height === b.height;

export function IslandPuzzleDialog() {
  const close = () => openMountain(false);
  const [source, setSource] = useState<"island" | "ref">("island");
  const [islandId, setIslandId] = useState(ISLANDS[1].id);
  const [ref, setRef] = useState("NR 95 36");
  const [km, setKm] = useState<[number, number]>([30, 40]);

  const [printer, setPrinter] = useState(() => loadPrinter());
  const bed = printerBed(printer);
  const [spec, setSpec] = useState<Omit<IslandSpec, "bed">>(() => ({ ...ISLAND_DEFAULTS }));
  const [cutBy, setCutBy] = useState<"pieces" | "boundaries">("pieces");
  const [level, setLevel] = useState(6);
  const [map, setMap] = useState<{ name: string; data: OsmData } | null>(null);
  const [mapBusy, setMapBusy] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  // "From the map": what to press into the ground, and the map it comes from (fetched, or a file).
  const [detail, setDetail] = useState<OsmDetail>("area");
  const [marksMap, setMarksMap] = useState<{ name: string; data: OsmData; fetched: OsmDetail | null } | null>(null);
  const [marksBusy, setMarksBusy] = useState(false);
  const [marksError, setMarksError] = useState<string | null>(null);

  const [loaded, setLoaded] = useState<{ area: Area; grid: HeightGrid } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [puzzle, setPuzzle] = useState<IslandBuilt | null>(null);
  // The area whose heights are loaded now: an answer from OpenStreetMap for another one is ignored.
  const loadedKey = useRef<string | null>(null);
  loadedKey.current = loaded ? areaKey(loaded.area) : null;
  const [working, setWorking] = useState(false);
  const builder = useRef(new IslandBuilder());
  const [buildError, setBuildError] = useState<string | null>(null);
  const [explode, setExplode] = useState(0);
  const [colour, setColour] = useState<ColourSpec>(PLAIN_COLOUR);
  const colourOn = colour.mode !== "plain";

  const area = areaFrom(source, islandId, ref, km);
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
      setLoaded({ area, grid: await readHeights(loadTerrainTile, area.sw, area.width, area.height, spacing, z) });
      setMap(null);
      setMarksMap(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const getBoundaries = async () => {
    if (!loaded) return;
    setMapBusy(true);
    setMapError(null);
    try {
      const { sw, width, height } = loaded.area;
      const asked = areaKey(loaded.area);
      let res: Response;
      try {
        res = await fetch(OVERPASS_URL, { method: "POST", body: new URLSearchParams({ data: boundaryQuery(sw, width, height, level) }) });
      } catch {
        throw new Error("Couldn't reach OpenStreetMap's map service — check you're online, or use a map file.");
      }
      const data = await overpassMap(res, "boundaries");
      if (loadedKey.current !== asked) return;
      setMap({ name: `${levelName(level)} from OpenStreetMap`, data });
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
    const { sw, width, height } = loaded.area;
    const query = marksQuery(sw, width, height, detail);
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
      const data = await overpassMap(res, "paths, rivers and lochs");
      // Heights for another area were fetched meanwhile: this map is for the old one.
      if (loadedKey.current !== asked) return;
      setMarksMap({ name: "OpenStreetMap", data, fetched: detail });
    } catch (e) {
      setMarksError(e instanceof OsmError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setMarksBusy(false);
    }
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

  const levels = useMemo(() => (map ? boundaryLevels(map.data) : []), [map]);
  // The level asked for if the map has it, else its finest.
  const usedLevel = levels.some(([l]) => l === level) ? level : levels.length ? levels[levels.length - 1][0] : level;
  const cuts: IslandCuts | undefined = useMemo(() => (cutBy === "boundaries" && map ? boundariesOnGrid(map.data, usedLevel) : undefined), [cutBy, map, usedLevel]);

  const features: MapFeatures = useMemo(() => (detail !== "area" && marksMap ? featuresOnGrid(marksMap.data, detail) : NO_FEATURES), [detail, marksMap]);
  // Fetched for "Paths, rivers and lochs" only: "Everything" needs the roads too.
  const needsFetch = detail !== "area" && (!marksMap || (marksMap.fetched === "water" && detail === "all"));
  const canFetch = !!loaded && fresh && Math.max(loaded.area.width, loaded.area.height) <= MARKS_MOST;

  // Put together, the island keeps out of the printer's no-print corner, and — in several filaments — out of the prime
  // tower's corner and the strip only one nozzle reaches.
  const printerInfo = printerOf(printer.printer);
  const keepOut: BedRect[] = [
    ...(printerInfo?.bedExclude ?? []),
    ...(colourOn ? [towerCorner(bed)] : []),
    ...(colourOn && printerInfo?.secondNozzleFrom ? [[0, 0, printerInfo.secondNozzleFrom, bed[1]] as BedRect] : []),
  ];
  const fullSpec: IslandSpec = spec.inPlace ? { ...spec, bed, rooms: freeRooms(bed, keepOut) } : { ...spec, bed };
  const problems = islandChecks(fullSpec);
  const specKey = JSON.stringify(fullSpec);
  useEffect(() => {
    if (!loaded || problems.length) {
      // A build still running for the old settings mustn't show its puzzle beside the problem.
      builder.current.stop();
      setPuzzle(null);
      setWorking(false);
      return;
    }
    setWorking(true);
    const timer = setTimeout(() => {
      builder.current.build({ grid: loaded.grid, sw: loaded.area.sw, width: loaded.area.width, height: loaded.area.height, spec: fullSpec, cuts, features }, (reply) => {
        if ("error" in reply) {
          setPuzzle(null);
          setBuildError(reply.error);
        } else {
          setPuzzle(reply.puzzle);
          setBuildError(null);
        }
        setWorking(false);
      });
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, specKey, cuts, features]);

  // Stop the builder when the window closes.
  useEffect(() => () => builder.current.stop(), []);

  // Colour bands: pieces at different heights get plates of their own, so a plate changes colour on the same layers.
  const byLevel = colourOn && colour.mode === "bands";
  const inPlace = !!spec.inPlace;
  // Put together: one plate, every piece where it sits in the finished puzzle (it must fit the bed less its margins).
  const placed = useMemo(() => (puzzle && inPlace ? platesInPlace(puzzle.pieces, bed, puzzle.room) : null), [puzzle, bed[0], bed[1], bed[2], inPlace]);
  const plates = useMemo(
    () => (!puzzle ? [] : placed ? (placed.fits ? placed.plates : []) : (byLevel ? platesByLevel : platesFor)(puzzle.pieces, bed)),
    [puzzle, placed, bed[0], bed[1], bed[2], byLevel],
  );
  const settings = inPlace ? IN_PLACE_SETTINGS : undefined;
  const chooseInPlace = (on: boolean) => {
    setSpec((s) => ({ ...s, inPlace: on, scale: on ? Math.min(s.scale, 1) : s.scale }));
    if (on) setExplode(0);
  };
  const fileName = safeFileName(`${loaded?.area.name ?? "Island"} puzzle`, "Island puzzle");
  // How ground heights sit in the puzzle (base + height × relief / highest), and the map over it, for colouring.
  const scaleKey = puzzle ? [spec.base, spec.relief, puzzle.high].join(",") : "";
  const scale: HeightScale | null = useMemo(() => (puzzle ? { z0: spec.base, h0: 0, mmPerM: spec.relief / Math.max(puzzle.high, 1) } : null), [scaleKey]);
  const puzzleMap = useMemo(() => (puzzle && loaded ? mapOnPuzzle(features, (puzzle.origin ?? loaded.area.sw).e, (puzzle.origin ?? loaded.area.sw).n, puzzle.k) : NO_MAP), [puzzle, features]);
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
    <Modal title="Island puzzle" onClose={close} width={980}>
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
          </div>
          {source === "island" ? (
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
          <div className="mountain-row">
            <span>Land</span>
            <select value={spec.land} onChange={(e) => set("land", e.target.value as IslandLand)}>
              <option value="islands">Every island (not the mainland)</option>
              <option value="biggest">Just the biggest island</option>
              <option value="all">All the land in the area</option>
            </select>
          </div>
          {typeof area === "string" ? (
            <p className="error-text small">{area}</p>
          ) : (
            <button className="primary-button mountain-fetch" onClick={getHeights} disabled={loading || fresh}>
              {loading ? "Getting heights…" : fresh ? "Heights ready" : "Get the heights"}
            </button>
          )}
          {error && <p className="error-text small">{error}</p>}
          {loaded && !fresh && areaReady && <p className="muted small">The area has changed — get the heights again to use it.</p>}

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
              {map && (
                <p className="muted small">
                  {levels.length
                    ? `${map.name}: ${levels.map(([l, n]) => `${levelName(l).toLowerCase()} (${n} lines)`).join(", ")}.${usedLevel !== level ? ` Using ${levelName(usedLevel).toLowerCase()}.` : ""}`
                    : `${map.name} has no boundaries in it — try another level.`}
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
          {detail !== "area" && (
            <>
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
                Paths and rivers become shallow grooves in the ground, lochs flat water{detail === "all" ? ", roads wider grooves and buildings small blocks (buildings only from a map file — fetched, a town would be too much)" : ""}. Rivers stop at the coast; grooves are kept shallow on the dovetails and narrow strips so nothing gets weak.
              </p>
              {marksMap && (
                <p className="muted small">
                  {marksMap.name}: {featureSummary(features)}.{puzzle?.marks.tooSmall ? ` ${puzzle.marks.tooSmall} too small to show at this scale are left off.` : ""}
                  {marksMap.fetched === "water" && detail === "all" ? " Get them again for the roads." : ""}
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
                  ? ` 100% = the island fills the bed (${bed[0]} × ${bed[1]} mm, less 5 mm round the edge${keepOut.length ? " and the corners kept free" : ""}); it can't be bigger`
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
            usual={() => islandBands(puzzle?.high ?? 500)}
            usualBase={SEA_BLUE}
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
                <IslandTopView puzzle={puzzle} />
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
                  {puzzle.warnings.map((w) => (
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
                  {printerInfo?.bedExclude?.length ? " The front-left corner, where this printer wipes its nozzle, is left free." : ""}
                  {colourOn
                    ? ` The back-left corner (${TOWER_ROOM} × ${TOWER_ROOM} mm) is left free for the prime tower Bambu Studio adds for several filaments: if it shows up on the island, drag it into that corner.`
                    : ""}
                  {colourOn && printerInfo?.secondNozzleFrom ? ` The ${printerInfo.secondNozzleFrom} mm strip down the left, which only one nozzle reaches, is left free too.` : ""}
                  {colour.mode === "full" ? " The full-colour files can't carry those settings: turn the brim off and elephant-foot compensation on yourself." : ""}
                </p>
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

/** From above, north up: each piece in its own colour with its number. */
function IslandTopView({ puzzle }: { puzzle: IslandBuilt | null }) {
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
      ctx.beginPath();
      line.pts.forEach((p, i) => (i ? ctx.lineTo(...px(p)) : ctx.moveTo(...px(p))));
      ctx.strokeStyle = line.kind === "river" || line.kind === "stream" ? "rgba(40,100,200,0.9)" : line.kind === "road" ? "rgba(200,60,40,0.9)" : "rgba(120,60,20,0.9)";
      ctx.lineWidth = line.kind === "river" || line.kind === "road" ? 1.6 : 1;
      ctx.setLineDash(line.kind === "path" ? [3, 2] : []);
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
  }, [puzzle]);
  return (
    <figure className="mountain-figure">
      <canvas ref={ref} className="mountain-top" />
      <figcaption className="muted small">From above, north up: each piece numbered, with the map's paths, rivers and lochs.</figcaption>
    </figure>
  );
}
