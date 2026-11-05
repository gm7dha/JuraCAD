/**
 * Island puzzle: pick an island (or all of Great Britain, or any area by grid reference), fetch its heights, cut its land
 * into interlocking pieces — of about a chosen size, or along county / parish boundaries fetched from OpenStreetMap — and
 * download the pieces as print plates (3MF). Nothing goes into the design. The maths is in src/terrain/islandPuzzle.ts.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CUSTOM_PRINTER, PRINTERS } from "../model/printBed";
import { areaProblem, readHeights, zoomFor, type HeightGrid } from "../terrain/elevation";
import { ISLAND_DEFAULTS, islandChecks, makeIslandPuzzle, type IslandCuts, type IslandLand, type IslandPuzzle, type IslandSpec } from "../terrain/islandPuzzle";
import { BOUNDARY_LEVELS, boundaryQuery, ISLANDS, OVERPASS_URL } from "../terrain/islands";
import { formatGridRef, parseGridRef, type GridPoint } from "../terrain/osGrid";
import { boundariesOnGrid, boundaryLevels, levelName, OsmError, readOsm, type OsmData } from "../terrain/osm";
import { allPlatesZip, plate3mf, platesFor } from "../terrain/puzzle3mf";
import { downloadFile, safeFileName } from "./download";
import { Modal } from "./Modal";
import { Mountain3D } from "./MountainPuzzleDialog";
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

  const [loaded, setLoaded] = useState<{ area: Area; grid: HeightGrid } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [puzzle, setPuzzle] = useState<IslandPuzzle | null>(null);
  const [working, setWorking] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [explode, setExplode] = useState(0);

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
      let res: Response;
      try {
        res = await fetch(OVERPASS_URL, { method: "POST", body: new URLSearchParams({ data: boundaryQuery(sw, width, height, level) }) });
      } catch {
        throw new Error("Couldn't reach OpenStreetMap's boundary service — check you're online, or use a map file.");
      }
      if (res.status === 429 || res.status === 504) throw new Error("OpenStreetMap's boundary service is busy — try again in a minute.");
      if (!res.ok) throw new Error(`OpenStreetMap's boundary service said ${res.status}.`);
      setMap({ name: `${levelName(level)} from OpenStreetMap`, data: readOsm(await res.text()) });
    } catch (e) {
      setMap(null);
      setMapError(e instanceof Error ? e.message : String(e));
    } finally {
      setMapBusy(false);
    }
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

  const fullSpec: IslandSpec = { ...spec, bed };
  const problems = islandChecks(fullSpec);
  const specKey = JSON.stringify(fullSpec);
  useEffect(() => {
    if (!loaded || problems.length) {
      setPuzzle(null);
      return;
    }
    setWorking(true);
    const timer = setTimeout(() => {
      try {
        setPuzzle(makeIslandPuzzle(loaded.grid, loaded.area.sw, loaded.area.width, loaded.area.height, fullSpec, cuts));
        setBuildError(null);
      } catch (e) {
        setPuzzle(null);
        setBuildError(e instanceof Error ? e.message : String(e));
      } finally {
        setWorking(false);
      }
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, specKey, cuts]);

  const plates = useMemo(() => (puzzle ? platesFor(puzzle.pieces, bed) : []), [puzzle, bed[0], bed[1], bed[2]]);
  const fileName = safeFileName(`${loaded?.area.name ?? "Island"} puzzle`, "Island puzzle");
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

          <h3 className="library-heading">3. Size</h3>
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
          <div className="mountain-row">
            <span>Scale</span>
            <span>
              {numberBox(Math.round(spec.scale * 100), (v) => set("scale", v / 100), 10, 20, 1000, "%")}
              <span className="muted small"> 100% = the finished puzzle covers the bed ({bed[0]} × {bed[1]} mm)</span>
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
            {numberBox(spec.fit, (v) => set("fit", v), 0.05, 0, 0.5, "mm each side")}
          </div>
          <div className="mountain-row">
            <span>Pattern</span>
            <span>
              {numberBox(spec.seed, (v) => set("seed", Math.round(v)), 1, 1, 999999, "")}
              <span className="muted small"> where the pieces and tabs go</span>
            </span>
          </div>
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
                <Mountain3D puzzle={puzzle} explode={explode} />
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
                    {Math.round(puzzle.width)} × {Math.round(puzzle.height)} mm, {spec.base} mm thick at the coast and {Math.round(spec.base + spec.relief)} mm
                    on the highest ground ({Math.round(puzzle.high)} m). 1 mm is {formatDistance(1 / puzzle.k)} across.
                  </p>
                  <p className="muted">
                    {puzzle.joins} dovetails hold the pieces together.
                  </p>
                  {puzzle.warnings.map((w) => (
                    <p key={w} className="mountain-warn">
                      {w}
                    </p>
                  ))}
                </div>
              )}
              {puzzle && plates.length > 0 && (
                <div className="mountain-downloads">
                  <span className="small">
                    {plates.length} {plates.length === 1 ? "plate" : "plates"} for Bambu Studio:
                  </span>
                  {plates.map((p, i) => (
                    <button
                      key={i}
                      className="text-button"
                      onClick={() => downloadFile(blobOf(plate3mf(p, `${fileName} - plate ${i + 1}`), "model/3mf"), `${fileName} - plate ${i + 1} of ${plates.length}.3mf`)}
                      title={p.pieces.map((x) => x.piece.name).join(", ")}
                    >
                      Plate {i + 1} ({p.pieces.length})
                    </button>
                  ))}
                  <button className="primary-button" onClick={() => downloadFile(blobOf(allPlatesZip(plates, fileName), "application/zip"), `${fileName}.zip`)}>
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

/** "120 m", "2.5 km". */
const formatDistance = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);

/** From above, north up: each piece in its own colour with its number. */
function IslandTopView({ puzzle }: { puzzle: IslandPuzzle | null }) {
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
    ctx.fillStyle = "#4f7fae";
    ctx.fillRect(0, 0, w, h);
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
      const [[x0, y0], , [x1, y1]] = p.outline;
      if ((x1 - x0) * s > 14 && (y1 - y0) * s > 10) {
        ctx.fillStyle = "rgba(20,30,40,0.9)";
        ctx.fillText(p.name.split(" ")[0], ((x0 + x1) / 2) * s, h - ((y0 + y1) / 2) * s + 3);
      }
    });
  }, [puzzle]);
  return (
    <figure className="mountain-figure">
      <canvas ref={ref} className="mountain-top" />
      <figcaption className="muted small">From above, north up: each piece numbered.</figcaption>
    </figure>
  );
}
