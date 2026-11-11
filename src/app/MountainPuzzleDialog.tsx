/**
 * Mountain puzzle: pick a mountain (a famous one, a grid reference, or your own OS map picture with its corners'
 * grid references), fetch its heights, size it to the printer's bed, see it in 2D and 3D, and download the pieces as
 * print plates (3MF, snow as a second filament). Nothing goes into the design. The maths is in src/terrain/.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CUSTOM_PRINTER, PRINTERS } from "../model/printBed";
import { areaProblem, heightAt, readHeights, type HeightGrid } from "../terrain/elevation";
import {
  baseFor,
  plateFor,
  layoutFor,
  makeMountainPuzzle,
  mountainChecks,
  MOUNTAIN_DEFAULTS,
  neckFor,
  smallestCube,
  GOOD_NECK,
  MIN_NECK,
  type MountainPuzzle,
  type MountainSpec,
  type PuzzlePiece,
} from "../terrain/mountainPuzzle";
import { formatGridRef, parseGridRef, type GridPoint } from "../terrain/osGrid";
import { featuresOnGrid, featureSummary, NO_FEATURES, osmArea, OsmError, readOsm, type MapFeatures, type OsmData, type OsmDetail } from "../terrain/osm";
import { PEAKS } from "../terrain/peaks";
import { blurred, greyFromRgba, photoGrid, photoReadSize, type PhotoPixels } from "../terrain/photoRelief";
import { allPlatesZip, plate3mf, platesByLevel, platesFor } from "../terrain/puzzle3mf";
import { mapOnPuzzle, mapRaster, mountainBands, NO_MAP, PLAIN_COLOUR, WATER_BLUE, type ColourSpec, type HeightScale, type PreviewMesh } from "../terrain/colour";
import { ColourDownloads, ColourPanel, useColoured } from "./PuzzleColour";
import { downloadFile, safeFileName } from "./download";
import { Modal } from "./Modal";
import { openMountain, useMountain } from "./mountainState";
import { loadTerrainTile } from "./mountainTiles";
import { loadPrinter, printerBed, savePrinter } from "./printerSetting";

type Source = "peak" | "ref" | "picture" | "osm";

/** What the three map choices put on a printed puzzle. */
export const DETAILS: [OsmDetail, string][] = [
  ["area", "Just the area"],
  ["water", "Paths, rivers and lochs"],
  ["all", "Everything: roads and buildings too"],
];

interface Area {
  sw: GridPoint;
  width: number;
  height: number;
  name: string;
}

const ROCK = "#9b8f7c";
/** Bytes as a Blob (copied, so it's a plain ArrayBuffer whatever TypeScript's lib says). */
const blobOf = (bytes: Uint8Array, type: string) => new Blob([new Uint8Array(bytes)], { type });
const SNOW = "#f3f5f9";

/** The area the choices describe, or a plain-English reason why not. */
function areaFrom(source: Source, peakId: string, ref: string, km: [number, number], corners: [string, string], osm: { name: string; data: OsmData } | null): Area | string {
  if (source === "osm") {
    if (!osm) return "Choose an OpenStreetMap file (.osm): on openstreetmap.org, zoom to the mountain, press Export and save the file.";
    const a = osmArea(osm.data);
    if (typeof a === "string") return a;
    return areaProblem(a.sw, a.width, a.height) ?? { ...a, name: osm.name };
  }
  if (source === "picture") {
    const a = parseGridRef(corners[0]);
    const b = parseGridRef(corners[1]);
    if (!a || !b) return "Type the grid references of your picture's bottom-left and top-right corners (like NN 14 69).";
    const sw = { e: Math.min(a.e, b.e), n: Math.min(a.n, b.n) };
    const width = Math.abs(b.e - a.e);
    const height = Math.abs(b.n - a.n);
    return areaProblem(sw, width, height) ?? { sw, width, height, name: "My map" };
  }
  const peak = PEAKS.find((p) => p.id === peakId);
  const centre = parseGridRef(source === "peak" ? peak?.ref ?? "" : ref);
  const width = km[0] * 1000;
  const height = km[1] * 1000;
  if (!centre) return areaProblem(null, width, height)!;
  const sw = { e: centre.e - width / 2, n: centre.n - height / 2 };
  return areaProblem(sw, width, height) ?? { sw, width, height, name: source === "peak" && peak ? peak.name : `Mountain at ${formatGridRef(centre, 6) ?? ref}` };
}

const sameArea = (a: Area | null, b: Area | null) => !!a && !!b && a.sw.e === b.sw.e && a.sw.n === b.sw.n && a.width === b.width && a.height === b.height;

/** Read a picture file into brightness, at most PHOTO_MAX_SIDE pixels a side. */
async function readPhoto(file: File): Promise<{ url: string; pixels: PhotoPixels }> {
  const url = await new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => (typeof r.result === "string" ? ok(r.result) : fail(new Error("unreadable")));
    r.onerror = () => fail(new Error("unreadable"));
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((ok, fail) => {
    const i = new Image();
    i.onload = () => ok(i);
    i.onerror = () => fail(new Error("That file isn't a picture the browser can open. Try a JPEG or PNG."));
    i.src = url;
  });
  const [w, h] = photoReadSize(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser couldn't read the picture.");
  ctx.drawImage(img, 0, 0, w, h);
  return { url, pixels: greyFromRgba(ctx.getImageData(0, 0, w, h).data, w, h) };
}

export function MountainPuzzleDialog() {
  const close = () => openMountain(false);
  const kind = useMountain((s) => s.kind);
  const photoMode = kind === "photo";
  const [photo, setPhoto] = useState<{ name: string; url: string; pixels: PhotoPixels } | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [relief, setRelief] = useState(20);
  const [invert, setInvert] = useState(false);
  const [smooth, setSmooth] = useState(1);
  const [source, setSource] = useState<Source>("peak");
  const [peakId, setPeakId] = useState(PEAKS[0].id);
  const [ref, setRef] = useState("NN 166 712");
  const [km, setKm] = useState<[number, number]>([5, 4]);
  const [picture, setPicture] = useState<string | null>(null);
  const [corners, setCorners] = useState<[string, string]>(["", ""]);
  const [osm, setOsm] = useState<{ name: string; data: OsmData } | null>(null);
  const [osmError, setOsmError] = useState<string | null>(null);
  const [detail, setDetail] = useState<OsmDetail>("water");

  const [printer, setPrinter] = useState(() => loadPrinter());
  const bed = printerBed(printer);
  const [spec, setSpec] = useState<Omit<MountainSpec, "bed" | "snowline">>(() => ({ ...MOUNTAIN_DEFAULTS }));
  const [snowOn, setSnowOn] = useState(true);
  const [snowline, setSnowline] = useState<number | null>(null);
  const [colour, setColour] = useState<ColourSpec>(PLAIN_COLOUR);
  // Colour bands and full colour bring their own snow; the photo puzzle is always plain.
  const colourOn = !photoMode && colour.mode !== "plain";

  const [mapLoaded, setLoaded] = useState<{ area: Area; grid: HeightGrid } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [puzzle, setPuzzle] = useState<MountainPuzzle | null>(null);
  const [working, setWorking] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [explode, setExplode] = useState(0);

  // A photo's heights depend on the puzzle's size (its relief is set in mm), so they're worked out again as that changes.
  const photoLoaded = useMemo(() => {
    if (!photoMode || !photo) return null;
    const { width: w, height: h } = photo.pixels;
    const grid = photoGrid(blurred(photo.pixels, smooth), { ...spec, bed, snowline: null }, relief, invert);
    return { area: { sw: { e: 0, n: 0 }, width: w - 1, height: h - 1, name: photo.name }, grid };
  }, [photoMode, photo, smooth, relief, invert, spec.cube, spec.scale, bed[0], bed[1]]);
  const loaded = photoMode ? photoLoaded : mapLoaded;
  const area = areaFrom(source, peakId, ref, km, corners, osm);
  const features: MapFeatures = useMemo(() => (source === "osm" && osm ? featuresOnGrid(osm.data, detail) : NO_FEATURES), [source, osm, detail]);
  const areaReady = typeof area !== "string";
  const fresh = areaReady && sameArea(loaded?.area ?? null, area);

  const getHeights = async () => {
    if (typeof area === "string") return;
    setLoading(true);
    setError(null);
    try {
      const grid = await readHeights(loadTerrainTile, area.sw, area.width, area.height);
      setLoaded({ area, grid });
      // Snow on the top fifth to start with, to the nearest 50 m.
      let [lo, hi] = [Infinity, -Infinity];
      for (const v of grid.h) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
      setSnowline(Math.round((hi - (hi - lo) * 0.2) / 50) * 50);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const fullSpec: MountainSpec = photoMode ? { ...spec, bed, exaggeration: 1, snowline: null } : { ...spec, bed, snowline: snowOn && !colourOn ? snowline : null };
  const layout = useMemo(() => (loaded ? layoutFor(loaded.grid, loaded.area.width, loaded.area.height, { ...spec, bed, snowline: null }) : null), [loaded, spec, bed[0], bed[1], bed[2]]);
  const checks = mountainChecks(fullSpec, layout ?? undefined);

  // Make the puzzle a moment after the last change (it takes a second or two for big ones).
  const specKey = JSON.stringify(fullSpec);
  useEffect(() => {
    if (!loaded || checks.problems.length) {
      setPuzzle(null);
      return;
    }
    setWorking(true);
    const timer = setTimeout(() => {
      try {
        setPuzzle(makeMountainPuzzle(loaded.grid, loaded.area.width, loaded.area.height, fullSpec, features));
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
  }, [loaded, specKey, features]);

  // Colour bands: pieces at different heights get plates of their own, so a plate changes colour on the same layers.
  const byLevel = colourOn && colour.mode === "bands";
  const plates = useMemo(() => (puzzle ? (byLevel ? platesByLevel : platesFor)(puzzle.pieces, bed) : []), [puzzle, bed[0], bed[1], bed[2], byLevel]);
  // How ground heights sit in the puzzle, and the map drawn over it, for colouring.
  const scaleKey = puzzle ? [baseFor(puzzle.spec), puzzle.layout.low, puzzle.layout.k * puzzle.spec.exaggeration].join(",") : "";
  const scale: HeightScale | null = useMemo(() => (puzzle ? { z0: baseFor(puzzle.spec), h0: puzzle.layout.low, mmPerM: puzzle.layout.k * puzzle.spec.exaggeration } : null), [scaleKey]);
  const puzzleMap = useMemo(() => (puzzle ? mapOnPuzzle(features, puzzle.layout.e0, puzzle.layout.n0, puzzle.layout.k) : NO_MAP), [puzzle, features]);
  const mapSize: [number, number] = puzzle ? [puzzle.layout.cols * puzzle.spec.cube, puzzle.layout.rows * puzzle.spec.cube] : [1, 1];
  const paintMap = useMemo(() => mapRaster(puzzleMap, mapSize[0], mapSize[1]), [puzzleMap]);
  const { coloured, working: colouring, error: colourError } = useColoured(colourOn ? puzzle?.pieces ?? null : null, colour, scale, puzzleMap, mapSize, paintMap);
  const usualBands = () => (puzzle ? mountainBands(puzzle.layout.low, puzzle.layout.high, snowline) : mountainBands(0, 1000, snowline));
  const fileName = safeFileName(`${loaded?.area.name ?? "Mountain"} puzzle`, "Mountain puzzle");
  const set = <K extends keyof typeof spec>(key: K, value: (typeof spec)[K]) => setSpec((s) => ({ ...s, [key]: value }));
  const numberBox = (value: number, onChange: (v: number) => void, step: number, min: number, max: number, unit: string) => (
    <span className="mountain-number">
      <input type="number" value={value} step={step} min={min} max={max} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && onChange(e.target.valueAsNumber)} />
      <span className="muted">{unit}</span>
    </span>
  );

  const chooseOsm = (file: File | undefined) => {
    if (!file) return;
    setOsmError(null);
    file
      .text()
      .then((text) => setOsm({ name: file.name.replace(/\.osm$/i, "").replace(/^map$/i, "My map") || "My map", data: readOsm(text) }))
      .catch((e) => {
        setOsm(null);
        setOsmError(e instanceof OsmError ? e.message : "That file couldn't be read as an OpenStreetMap file.");
      });
  };

  const choosePicture = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" && setPicture(reader.result);
    reader.readAsDataURL(file);
  };

  const neck = neckFor(spec.cube, spec.fit);
  const total = puzzle?.pieces.length ?? 0;
  const snowParts = puzzle?.pieces.filter((p) => p.bodies.some((b) => b.part === "snow")).length ?? 0;

  return (
    <Modal title={photoMode ? "Photo relief puzzle" : "Mountain puzzle"} onClose={close} width={980}>
      <div className="mountain-layout">
        <div className="mountain-side">
          {photoMode ? (
            <>
          <h3 className="library-heading">1. The picture</h3>
          <label className="mountain-row">
            <span>Picture</span>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setPhotoError(null);
                readPhoto(file)
                  .then(({ url, pixels }) => setPhoto({ name: file.name.replace(/\.[^.]+$/, "") || "Photo", url, pixels }))
                  .catch((err) => setPhotoError(err instanceof Error ? err.message : String(err)));
              }}
            />
          </label>
          <p className="muted small">
            Light parts stand high and dark parts low, like a lithophane. Faces, pets and bold logos work well; crop the picture to
            what you want first.
          </p>
          {photoError && <p className="error-text small">{photoError}</p>}
          <div className="mountain-row">
            <span>Relief</span>
            <span>
              {numberBox(relief, setRelief, 1, 2, 150, "mm")}
              <span className="muted small"> from the darkest part to the lightest</span>
            </span>
          </div>
          <div className="mountain-row">
            <span>Smoothing</span>
            <select value={smooth} onChange={(e) => setSmooth(Number(e.target.value))}>
              <option value={0}>None (sharpest)</option>
              <option value={1}>A little</option>
              <option value={2}>More</option>
              <option value={4}>Lots</option>
            </select>
          </div>
          <label className="mountain-check">
            <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} /> Dark parts high instead
          </label>
            </>
          ) : (
            <>
          <h3 className="library-heading">1. The mountain</h3>
          <div className="mountain-choices" role="radiogroup" aria-label="Where the mountain comes from">
            {(
              [
                ["peak", "A famous mountain"],
                ["ref", "A grid reference"],
                ["picture", "My OS map picture"],
                ["osm", "An OpenStreetMap file"],
              ] as [Source, string][]
            ).map(([id, label]) => (
              <label key={id}>
                <input type="radio" name="mountain-source" checked={source === id} onChange={() => setSource(id)} /> {label}
              </label>
            ))}
          </div>
          {source === "peak" && (
            <label className="mountain-row">
              <span>Mountain</span>
              <select value={peakId} onChange={(e) => setPeakId(e.target.value)}>
                {PEAKS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.height} m)
                  </option>
                ))}
              </select>
            </label>
          )}
          {source === "ref" && (
            <label className="mountain-row">
              <span>Middle at</span>
              <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="NN 166 712" />
            </label>
          )}
          {source === "osm" && (
            <>
              <label className="mountain-row">
                <span>Map file</span>
                <input type="file" accept=".osm,.xml,application/xml,text/xml" onChange={(e) => chooseOsm(e.target.files?.[0])} />
              </label>
              <p className="muted small">
                On openstreetmap.org, zoom to the mountain, press <strong>Export</strong> and save the .osm file (up to about 5 km
                across). The heights still come from the height data; the map adds what's on the ground.
              </p>
              {osmError && <p className="error-text small">{osmError}</p>}
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
              {osm && (
                <p className="muted small">
                  {detail === "area"
                    ? "Just the area the map covers."
                    : `${featureSummary(features)[0].toUpperCase()}${featureSummary(features).slice(1)}: paths and rivers become shallow grooves in the ground, lochs flat water${detail === "all" ? ", buildings small blocks" : ""}.`}
                  {detail === "all" && " Names are too small to print on the ground, so they're left off (the laser version in JuraCUT engraves them)."}
                </p>
              )}
            </>
          )}
          {(source === "peak" || source === "ref") && (
            <div className="mountain-row">
              <span>Area</span>
              <span>
                {numberBox(km[0], (v) => setKm([v, km[1]]), 0.5, 0.2, 40, "km west to east")} {numberBox(km[1], (v) => setKm([km[0], v]), 0.5, 0.2, 40, "km south to north")}
              </span>
            </div>
          )}
          {source === "picture" && (
            <>
              <label className="mountain-row">
                <span>Picture</span>
                <input type="file" accept="image/*" onChange={(e) => choosePicture(e.target.files?.[0])} />
              </label>
              <p className="muted small">
                Crop the picture to the area you want, then type the grid references of its corners — read them off the blue
                grid lines on the map.
              </p>
              <label className="mountain-row">
                <span>Bottom left</span>
                <input value={corners[0]} onChange={(e) => setCorners([e.target.value, corners[1]])} placeholder="NN 14 69" />
              </label>
              <label className="mountain-row">
                <span>Top right</span>
                <input value={corners[1]} onChange={(e) => setCorners([corners[0], e.target.value])} placeholder="NN 19 73" />
              </label>
            </>
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
            </>
          )}

          <h3 className="library-heading">2. Size</h3>
          <label className="mountain-row">
            <span>Printer</span>
            <select
              value={printer.printer}
              onChange={(e) => setPrinter(savePrinter({ printer: e.target.value }))}
              title="Also changes the printer in the 3D print panel"
            >
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
            <span>Cube size</span>
            <span>
              {numberBox(spec.cube, (v) => set("cube", v), 1, 10, 100, "mm")}
              <span className={`small ${neck < MIN_NECK ? "error-text" : neck < GOOD_NECK ? "mountain-warn" : "muted"}`}>
                {" "}
                smallest {smallestCube(spec.fit)} mm, sturdy from {smallestCube(spec.fit, GOOD_NECK)} mm
              </span>
            </span>
          </div>
          <div className="mountain-row">
            <span>Side under the ground</span>
            <span>
              {numberBox(spec.base, (v) => set("base", v), 1, baseFor({ ...spec, base: 0 }), 60, "mm")}
              <span className="muted small"> plain side below the lowest ground; the bottom layer is a thin jigsaw plate</span>
            </span>
          </div>
          {!photoMode && (
            <div className="mountain-row">
              <span>Height stretch</span>
              {numberBox(spec.exaggeration, (v) => set("exaggeration", v), 0.25, 0.25, 5, "×")}
            </div>
          )}
          <div className="mountain-row">
            <span>Fit gap</span>
            <span>
              {numberBox(spec.fit, (v) => set("fit", v), 0.05, 0, 0.5, "mm each side")}
            </span>
          </div>
          <div className="mountain-row">
            <span>Pattern</span>
            <span>
              {numberBox(spec.seed, (v) => set("seed", Math.round(v)), 1, 1, 999999, "")}
              <span className="muted small"> which way the tabs point</span>
            </span>
          </div>

          {!photoMode && (
            <>
          <h3 className="library-heading">3. Colour</h3>
          <ColourPanel
            spec={colour}
            setSpec={setColour}
            usual={usualBands}
            usualBase={null}
            usualWater={WATER_BLUE}
            has={paintMap}
            ground={puzzle ? [puzzle.layout.low, puzzle.layout.high] : null}
          />
            </>
          )}

          {!photoMode && !colourOn && (
            <>
          <h3 className="library-heading">4. Snow</h3>
          <div className="mountain-row">
            <span>Snow caps</span>
            <span>
              <label>
                <input type="checkbox" checked={snowOn} onChange={(e) => setSnowOn(e.target.checked)} /> a second filament (AMS) above
              </label>
              {snowOn && <> {numberBox(snowline ?? 900, setSnowline, 25, 0, 1400, "m")}</>}
            </span>
          </div>
          {snowOn && (
            <p className="muted small">
              Each piece's snow is its own part, set to filament 2 — load white there. Pieces wholly below the line are one
              colour.
            </p>
          )}
            </>
          )}
        </div>

        <div className="mountain-main">
          {!loaded ? (
            <div className="mountain-empty muted">
              {photoMode ? (
                <p>Choose a picture to make into a puzzle.</p>
              ) : (
                <>
                  <p>Choose a mountain and press <strong>Get the heights</strong>.</p>
                  <p className="small">
                    Heights come free from Amazon's open Terrain Tiles (built on OS Terrain 50 and NASA data), about 20–30 m apart.
                  </p>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="mountain-previews">
                <TopView grid={loaded.grid} area={loaded.area} puzzle={puzzle} picture={photoMode ? photo?.url ?? null : source === "picture" ? picture : null} features={photoMode ? NO_FEATURES : features} />
                <Mountain3D puzzle={puzzle} explode={explode} paint={colourOn ? (coloured?.preview ?? null) : null} />
              </div>
              <label className="mountain-explode small">
                Pull apart <input type="range" min={0} max={20} value={explode} onChange={(e) => setExplode(Number(e.target.value))} />
              </label>
              {checks.problems.map((p) => (
                <p key={p} className="error-text small">
                  {p}
                </p>
              ))}
              {buildError && <p className="error-text small">{buildError}</p>}
              {working && <p className="muted small">Working…</p>}
              {puzzle && (
                <div className="mountain-summary small">
                  <p>
                    <strong>
                      {puzzle.layout.cols} × {puzzle.layout.rows} cubes, {puzzle.layers} {puzzle.layers === 1 ? "layer" : "layers"}, {total} pieces
                    </strong>{" "}
                    — finished {puzzle.layout.cols * spec.cube} × {puzzle.layout.rows * spec.cube} mm and{" "}
                    {Math.round(Math.max(...puzzle.pieces.map((p) => p.z0 + p.height)))} mm tall;{" "}
                    {photoMode
                      ? `${relief} mm of relief over the picture`
                      : `1 mm is ${Math.round(1 / puzzle.layout.k)} m of ground (1 : ${Math.round(1000 / puzzle.layout.k).toLocaleString("en-GB")}). Ground from ${Math.round(puzzle.layout.low)} m to ${Math.round(puzzle.layout.high)} m`}
                    , with {Math.round(baseFor(fullSpec))} mm of plain side under the lowest, on a {plateFor(fullSpec).toFixed(1)} mm jigsaw plate.
                  </p>
                  <p className="muted">
                    Tabs' necks {puzzle.neck.toFixed(1)} mm; each piece sits on a square key about{" "}
                    {Math.round(Math.min(...puzzle.pieces.filter((p) => p.key).map((p) => p.key!.half * 2)))}–
                    {Math.round(Math.max(...puzzle.pieces.filter((p) => p.key).map((p) => p.key!.half * 2)))} mm across and {puzzle.keys.h.toFixed(1)} mm tall.
                    {!colourOn && snowOn && snowline !== null && (snowParts ? ` ${snowParts} pieces have snow: filament 2.` : " Nothing reaches the snow line.")}
                  </p>
                  {puzzle.warnings.map((w) => (
                    <p key={w} className="mountain-warn">
                      {w}
                    </p>
                  ))}
                </div>
              )}
              {colourOn && colouring && <p className="muted small">Colouring the pieces…</p>}
              {colourOn && colourError && <p className="error-text small">{colourError}</p>}
              {colourOn && puzzle && coloured && scale && plates.length > 0 && (
                <ColourDownloads spec={colour} coloured={coloured} plates={plates} scale={scale} map={paintMap} fileName={fileName} bedWidth={bed[0]} />
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
              {puzzle && (
                <p className="muted small">
                  Pieces are named column-row-layer (C4-2: column C, row 4 from the south, layer 2 from the bottom), as on the map
                  above. Build layer 1 first, then drop each piece in from above.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Top-down: the heights shaded (or your map picture), the piece grid, column letters and row numbers. */
function TopView({ grid, area, puzzle, picture, features }: { grid: HeightGrid; area: Area; puzzle: MountainPuzzle | null; picture: string | null; features: MapFeatures }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!picture) return setImg(null);
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = picture;
  }, [picture]);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const size = 380;
    const s = Math.min(size / area.width, size / area.height);
    const [w, h] = [Math.round(area.width * s), Math.round(area.height * s)];
    canvas.width = w;
    canvas.height = h;
    const toPx = (e: number, n: number): [number, number] => [(e - area.sw.e) * s, h - (n - area.sw.n) * s];
    if (img) ctx.drawImage(img, 0, 0, w, h);
    else {
      // Hill shading lit from the north-west, coloured low green to high grey.
      const pix = ctx.createImageData(w, h);
      let [lo, hi] = [Infinity, -Infinity];
      for (const v of grid.h) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
      const d = 1 / s;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const e = area.sw.e + (x + 0.5) / s;
          const n = area.sw.n + (h - y - 0.5) / s;
          const z = heightAt(grid, e, n);
          const dx = (heightAt(grid, e + d, n) - heightAt(grid, e - d, n)) / (2 * d);
          const dy = (heightAt(grid, e, n + d) - heightAt(grid, e, n - d)) / (2 * d);
          const shade = Math.max(0.35, Math.min(1.25, 0.85 + (dx - dy) * 0.6));
          const t = (z - lo) / Math.max(1, hi - lo);
          const base = [110 + 120 * t, 140 + 90 * t, 95 + 135 * t];
          const k = (y * w + x) * 4;
          pix.data[k] = base[0] * shade;
          pix.data[k + 1] = base[1] * shade;
          pix.data[k + 2] = base[2] * shade;
          pix.data[k + 3] = 255;
        }
      ctx.putImageData(pix, 0, 0);
    }
    // The map's lochs, buildings and lines on top.
    for (const shape of features.shapes) {
      ctx.beginPath();
      for (const ring of shape.rings) ring.forEach(([e, n], i) => (i ? ctx.lineTo(...toPx(e, n)) : ctx.moveTo(...toPx(e, n))));
      ctx.fillStyle = shape.kind === "water" ? "rgba(60,120,200,0.8)" : "rgba(60,50,40,0.9)";
      ctx.fill("evenodd");
    }
    for (const line of features.lines) {
      ctx.beginPath();
      line.pts.forEach(([e, n], i) => (i ? ctx.lineTo(...toPx(e, n)) : ctx.moveTo(...toPx(e, n))));
      ctx.strokeStyle = line.kind === "river" || line.kind === "stream" ? "rgba(40,100,200,0.9)" : line.kind === "road" ? "rgba(200,60,40,0.9)" : "rgba(120,60,20,0.9)";
      ctx.lineWidth = line.kind === "river" || line.kind === "road" ? 1.6 : 1;
      ctx.setLineDash(line.kind === "path" ? [3, 2] : []);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (!puzzle) return;
    const L = puzzle.layout;
    // Dim what's trimmed off, draw the cubes.
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    const [ax, ay] = toPx(L.e0, L.n0 + L.height);
    const [bx, by] = toPx(L.e0 + L.width, L.n0);
    ctx.fillRect(0, 0, w, ay);
    ctx.fillRect(0, by, w, h - by);
    ctx.fillRect(0, ay, ax, by - ay);
    ctx.fillRect(bx, ay, w - bx, by - ay);
    ctx.strokeStyle = "rgba(20,30,40,0.75)";
    ctx.lineWidth = 1;
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillStyle = "rgba(20,30,40,0.9)";
    const cw = (bx - ax) / L.cols;
    const ch = (by - ay) / L.rows;
    for (let c = 0; c <= L.cols; c++) {
      ctx.beginPath();
      ctx.moveTo(ax + c * cw, ay);
      ctx.lineTo(ax + c * cw, by);
      ctx.stroke();
    }
    for (let r = 0; r <= L.rows; r++) {
      ctx.beginPath();
      ctx.moveTo(ax, by - r * ch);
      ctx.lineTo(bx, by - r * ch);
      ctx.stroke();
    }
    const layers = new Map<string, number>();
    for (const p of puzzle.pieces) layers.set(`${p.col},${p.row}`, Math.max(layers.get(`${p.col},${p.row}`) ?? 0, p.layer + 1));
    if (cw > 18 && ch > 14)
      for (let r = 0; r < L.rows; r++)
        for (let c = 0; c < L.cols; c++) {
          const name = puzzle.pieces.find((p) => p.col === c && p.row === r)?.name.split("-")[0] ?? "";
          ctx.fillText(`${name}×${layers.get(`${c},${r}`) ?? 0}`, ax + c * cw + 3, by - r * ch - 4);
        }
  }, [grid, area, puzzle, img, features]);
  return (
    <figure className="mountain-figure">
      <canvas ref={ref} className="mountain-top" />
      <figcaption className="muted small">From above, north up: each square is a column of cubes (name × pieces in it).</figcaption>
    </figure>
  );
}

/** The puzzle in 3D, to turn round; pulled apart by `explode` mm per step. */
export function Mountain3D({ puzzle, explode, paint }: { puzzle: { pieces: PuzzlePiece[] } | null; explode: number; paint?: PreviewMesh[] | null }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; group: THREE.Group; framed: boolean } | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      el.textContent = "This browser can't show 3D here.";
      return;
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(-1, 1.5, 2);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(35, 1, 1, 10000);
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    const group = new THREE.Group();
    scene.add(group);
    const draw = () => renderer.render(scene, camera);
    controls.addEventListener("change", draw);
    const resize = () => {
      const w = el.clientWidth || 380;
      const h = el.clientHeight || 300;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    view.current = { renderer, scene, camera, controls, group, framed: false };
    resize();
    return () => {
      ro.disconnect();
      controls.dispose();
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      renderer.dispose();
      renderer.domElement.remove();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    for (const child of [...v.group.children]) {
      (child as THREE.Mesh).geometry?.dispose();
      v.group.remove(child);
    }
    if (!puzzle) return void v.renderer.render(v.scene, v.camera);
    // Coloured (bands or full colour): one mesh with a colour per corner.
    if (paint && paint.length === puzzle.pieces.length) {
      let n = 0;
      for (const m of paint) n += m.pos.length;
      const pos = new Float32Array(n);
      const col = new Float32Array(n);
      let at = 0;
      puzzle.pieces.forEach((p, i) => {
        const m = paint[i];
        const [dx, dy, dz] = [p.col * explode, p.row * explode, p.layer * explode * 1.5];
        for (let k = 0; k < m.pos.length; k += 3) {
          pos[at + k] = m.pos[k] + dx;
          pos[at + k + 1] = m.pos[k + 1] + dy;
          pos[at + k + 2] = m.pos[k + 2] + dz;
        }
        // The colours are sRGB; three.js wants vertex colours linear.
        for (let k = 0; k < m.col.length; k++) {
          const c = m.col[k];
          col[at + k] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        }
        at += m.pos.length;
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      geo.computeVertexNormals();
      v.group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true })));
    } else for (const part of ["rock", "snow"] as const) {
      const pos: number[] = [];
      for (const p of puzzle.pieces)
        for (const b of p.bodies) {
          if (b.part !== part) continue;
          const [dx, dy, dz] = [p.col * explode, p.row * explode, p.layer * explode * 1.5];
          for (const t of b.triangles) pos.push(b.vertices[t * 3] + dx, b.vertices[t * 3 + 1] + dy, b.vertices[t * 3 + 2] + dz);
        }
      if (!pos.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      v.group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: part === "rock" ? ROCK : SNOW, roughness: 0.85, flatShading: true })));
    }
    if (!v.framed) {
      const box = new THREE.Box3().setFromObject(v.group);
      const centre = box.getCenter(new THREE.Vector3());
      const r = box.getSize(new THREE.Vector3()).length() / 2;
      v.controls.target.copy(centre);
      v.camera.position.set(centre.x + r * 0.9, centre.y - r * 1.9, centre.z + r * 1.4);
      v.camera.near = r / 50;
      v.camera.far = r * 20;
      v.camera.updateProjectionMatrix();
      v.controls.update();
      v.framed = true;
    }
    v.renderer.render(v.scene, v.camera);
  }, [puzzle, explode, paint]);

  return <div ref={host} className="mountain-3d" aria-label="The puzzle in 3D: drag to turn it" />;
}
