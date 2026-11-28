/**
 * Mountain puzzle: pick a mountain (a famous one, a grid reference, or your own OS map picture with its corners'
 * grid references), fetch its heights, size it to the printer's bed, see it in 2D and 3D, and download the pieces as
 * print plates (3MF, snow as a second filament). Nothing goes into the design. The maths is in src/terrain/.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CUSTOM_PRINTER, PRINTERS, printerOf } from "../model/printBed";
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
import { BORDER_WALL, borderWords, makeBorder, type BorderPiece } from "../terrain/mountainBorder";
import { cropGrid, cropPixels, MOST_TRIM, NO_TRIM, noTrim, type Trim } from "../terrain/mountainCrop";
import { formatGridRef, parseGridRef, type GridPoint } from "../terrain/osGrid";
import { HILL_RULE, PATH_CHOICES, ROAD_CHOICES, TIDY_MARKS, WATER_CHOICES, WATER_ONLY, waterOnly, type MarkChoice } from "../terrain/mapMarks";
import { featuresAtScale, featuresOnGrid, featureSummary, NO_FEATURES, osmArea, OsmError, readOsm, type MapFeatures, type OsmData, type OsmDetail, type OsmLineKind } from "../terrain/osm";
import { PEAKS } from "../terrain/peaks";
import { blurred, greyFromRgba, photoGrid, photoReadSize, type PhotoPixels } from "../terrain/photoRelief";
import { allPlatesZip, bandPlate3mf, bestRoom, centredRooms, FILAMENT, IN_PLACE_SETTINGS, plate3mf, platesByLevel, platesFor, towerCorner, type BandPartFile, type BedRect } from "../terrain/puzzle3mf";
import { breakawaySwaps, LAYER_HEIGHTS, layerPlates, stackWithBreakaway, togetherPlate, type PrintWay } from "../terrain/mountainInPlace";
import { weld, zipStored } from "../geometry/threeMf";
import { GROUND_BROWN, mapOnPuzzle, mapRaster, mountainBands, NO_MAP, WATER_BLUE, type HeightScale, type PreviewMesh } from "../terrain/colour";
import { ColourDownloads, ColourPanel, useBandsFollow, useColoured, useUsualColour } from "./PuzzleColour";
import { lochLayers } from "../terrain/groundMarks";
import { downloadFile, safeFileName } from "./download";
import { Modal } from "./Modal";
import { openMountain, useMountain } from "./mountainState";
import { loadTerrainTile } from "./mountainTiles";
import { PickableView, type TopViewPick } from "./PathPicker";
import { mountainViewBox, NONE_DROPPED, pickableLines, withoutDropped } from "../terrain/pickMarks";
import { amsSlotsOf, loadPrinter, printerBed, savePrinter } from "./printerSetting";
import { fitDistance } from "../viewport/fitView";
import { CUBE_STEP, mountainFloor, mountainLayoutVerdict, smallestThatPrints, type SearchResult, type SearchStep, type Verdict } from "../terrain/mostPieces";
import { mostPiecesTicked, setMostPiecesTicked } from "./mostPiecesState";
import { MostPiecesNote } from "./MostPiecesNote";
import { MountainBuilder } from "./mountainBuilder";

type Source = "peak" | "ref" | "picture" | "osm";

/** What the three map choices put on a printed puzzle. */
export const DETAILS: [OsmDetail, string][] = [
  ["area", "Just the area"],
  ["water", "Paths and lochs"],
  ["all", "Everything: roads and buildings too"],
];

/** How a map line is drawn in the windows' top views: tidy (thin) paths red and roads near-black; everything else as before. */
export function markStroke(kind: OsmLineKind, thin?: boolean): { colour: string; width: number; dash: number[] } {
  if (thin) return { colour: kind === "road" ? "rgba(31,31,31,0.9)" : "rgba(210,42,30,0.95)", width: 1, dash: [] };
  return {
    colour: kind === "river" || kind === "stream" ? "rgba(40,100,200,0.9)" : kind === "road" ? "rgba(200,60,40,0.9)" : "rgba(120,60,20,0.9)",
    width: kind === "river" || kind === "road" ? 1.6 : 1,
    dash: kind === "path" ? [3, 2] : [],
  };
}

/** The three "which marks" choices (lochs, paths, roads) and the hill-route rule in words. */
export function MarkChoices({ choice, onChange, roads }: { choice: MarkChoice; onChange: (c: MarkChoice) => void; roads: boolean }) {
  const row = <K extends keyof MarkChoice>(key: K, label: string, options: [MarkChoice[K], string][]) => (
    <label className="mountain-row">
      <span>{label}</span>
      <select value={choice[key]} onChange={(e) => onChange({ ...choice, [key]: e.target.value as MarkChoice[K] })}>
        {options.map(([id, text]) => (
          <option key={id} value={id}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
  const justWater = waterOnly(choice);
  return (
    <>
      <label className="mountain-row">
        <span>Marks</span>
        <span>
          <input type="checkbox" checked={justWater} onChange={(e) => onChange(e.target.checked ? WATER_ONLY : TIDY_MARKS)} /> Lochs, lakes and reservoirs only — no
          paths, tracks, roads or buildings
        </span>
      </label>
      {!justWater && row("water", "Water", WATER_CHOICES)}
      {!justWater && row("paths", "Paths", PATH_CHOICES)}
      {!justWater && roads && row("roads", "Roads", ROAD_CHOICES)}
      <p className="muted small">
        {justWater ? "Just the lochs, lakes and reservoirs big enough to see, filled with water a little below their shore — and, in colour, no red or black filament is needed. " : ""}
        {choice.paths === "hills" ? `${HILL_RULE} ` : ""}
        {!justWater && choice.water === "standing" ? "Only lochs, lakes and reservoirs big enough to see are shown — no rivers or streams. " : ""}
        {roads && choice.roads === "trunk" ? "Only motorways and trunk roads are shown. " : ""}
        {roads && choice.roads === "main" ? "Only motorways, trunk roads and A roads are shown. " : ""}
        {choice.paths === "hills" || (roads && (choice.roads === "trunk" || choice.roads === "main")) ? "These are thin lines (0.6 mm wide, 0.4 mm deep), so they print neatly." : ""}
      </p>
    </>
  );
}

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
/** The frame round the puzzle and its words, in the 3D view. */
const FRAME = "#6f7f95";
const WORDS = "#c8a02a";

/** A wall's height from its lowest to its tallest, in whole mm ("12–30 mm", or "18 mm" when it hardly changes). */
const heightRange = (low: number, high: number): string => (Math.round(high) - Math.round(low) < 1 ? `${Math.round(high)} mm` : `${Math.round(low)}–${Math.round(high)} mm`);

/** A border piece's parts for its 3MF: the frame on filament 1, the words on filament 2. */
const borderParts = (p: { name: string }): BandPartFile[] => {
  const b = p as BorderPiece;
  return [
    { filament: 1, label: "frame", ...weld(b.bodies[0].vertices, b.bodies[0].triangles) },
    ...(b.words ? [{ filament: 2, label: "words", ...weld(b.words.vertices, b.words.triangles) }] : []),
  ];
};

/** The four "trim from" sliders: how much of the area to cut off each side before it's sized to the bed. */
export function TrimSliders({ trim, setTrim, size, unit }: { trim: Trim; setTrim: (t: Trim) => void; size: [number, number]; unit: (v: number) => string }) {
  const row = (key: keyof Trim, label: string, across: number) => (
    <label className="mountain-row" key={key}>
      <span>{label}</span>
      <span>
        <input
          type="range"
          min={0}
          max={Math.round(MOST_TRIM * 100)}
          step={1}
          value={Math.round(trim[key] * 100)}
          onChange={(e) => setTrim({ ...trim, [key]: Number(e.target.value) / 100 })}
        />{" "}
        <span className="muted small">{trim[key] ? `${Math.round(trim[key] * 100)}% (${unit(trim[key] * across)})` : "none"}</span>
      </span>
    </label>
  );
  return (
    <>
      {row("n", "Trim from the north", size[1])}
      {row("e", "Trim from the east", size[0])}
      {row("s", "Trim from the south", size[1])}
      {row("w", "Trim from the west", size[0])}
      <p className="muted small">
        Cuts the area in from each side before it's sized to the bed, so what's left is printed bigger.
        {!noTrim(trim) && (
          <>
            {" "}
            <button type="button" className="text-button" onClick={() => setTrim(NO_TRIM)}>
              Trim nothing
            </button>
          </>
        )}
      </p>
    </>
  );
}

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
  const [marks, setMarks] = useState<MarkChoice>(TIDY_MARKS);

  const [printer, setPrinter] = useState(() => loadPrinter());
  const bed = printerBed(printer);
  const [spec, setSpec] = useState<Omit<MountainSpec, "bed" | "snowline">>(() => ({ ...MOUNTAIN_DEFAULTS }));
  // How it's printed: pieces laid out (the usual), each layer put together, or all in one go with breakaway layers.
  const [printWay, setPrintWay] = useState<PrintWay>("apart");
  const [layerHeight, setLayerHeight] = useState(0.2);
  const [breakSlot, setBreakSlot] = useState(3);
  const [towerOff, setTowerOff] = useState(false);
  const [snowOn, setSnowOn] = useState(true);
  const [snowline, setSnowline] = useState<number | null>(null);
  // Colour bands with the usual colours to start with (the owner's wish); the bands follow the ground until changed.
  const [colour, setColour, autoBands] = useUsualColour(mountainBands(0, 1000), WATER_BLUE);
  // Colour bands and full colour bring their own snow; the photo puzzle is always plain.
  const colourOn = !photoMode && colour.mode !== "plain";
  // The breakaway way is for one colour (or snow caps); colour bands and full colour print a layer at a time instead.
  // In one piece (a solid model, not a puzzle) there's nothing to put together: it's laid on a plate as it is.
  const onePiece = !!spec.onePiece;
  const way: PrintWay = onePiece ? "apart" : printWay === "together" && colourOn ? "layers" : printWay;
  // One piece is sized and placed like a puzzle printed put together: centred on Bambu Studio's bed, clear of its
  // no-print corner and (in several filaments) the prime tower's corner, on one plate.
  const together = way !== "apart" || onePiece;

  const [mapLoaded, setLoaded] = useState<{ area: Area; grid: HeightGrid } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [puzzle, setPuzzle] = useState<MountainPuzzle | null>(null);
  const [working, setWorking] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [explode, setExplode] = useState(0);
  const [trim, setTrim] = useState<Trim>(NO_TRIM);
  const [borderOn, setBorderOn] = useState(false);
  // The words on the border's front: null = the usual ones for this mountain.
  const [borderText, setBorderText] = useState<string | null>(null);

  // Printed put together, the puzzle is sized on Bambu Studio's own bed (it centres the file there), keeps out of the
  // printer's no-print corner and, in several filaments, leaves the back-left corner for the prime tower (unless the user
  // turns the tower off). The layout then fills that room as it fills the bed otherwise.
  const printerInfo = printerOf(printer.printer);
  const placeBed: [number, number, number] = together ? (printerInfo?.slicerBed ?? bed) : bed;
  const multi = way === "together" || colourOn || (!photoMode && snowOn);
  const keepOut: BedRect[] = together ? [...(printerInfo?.bedExclude ?? []), ...(printerInfo?.oneNozzleOnly ?? []), ...(multi && !towerOff ? [towerCorner(placeBed)] : [])] : [];
  const aspect: [number, number] = photoMode && photo ? [photo.pixels.width, photo.pixels.height] : mapLoaded ? [mapLoaded.area.width, mapLoaded.area.height] : [1, 1];
  const rooms = together ? centredRooms(placeBed, keepOut) : [];
  const room: BedRect = rooms.length ? bestRoom(rooms, aspect[0], aspect[1]) : [0, 0, placeBed[0], placeBed[1]];
  const layoutBed: [number, number, number] = together ? [room[2] - room[0], room[3] - room[1], bed[2]] : bed;

  // A photo's heights depend on the puzzle's size (its relief is set in mm), so they're worked out again as that changes.
  const photoFor = (cube: number) => {
    if (!photoMode || !photo) return null;
    const { width: w, height: h } = photo.pixels;
    // Trimmed first, so the relief is the asked-for height on what's left; the grid keeps its place in the picture.
    const cut = cropPixels(blurred(photo.pixels, smooth), trim);
    const made = photoGrid(cut.pixels, { ...spec, cube, bed: layoutBed, snowline: null }, relief, invert);
    const grid = cut.west || cut.south ? { ...made, e0: cut.west, n0: cut.south } : made;
    return { area: { sw: { e: 0, n: 0 }, width: w - 1, height: h - 1, name: photo.name }, grid, used: { grid, width: cut.pixels.width - 1, height: cut.pixels.height - 1 } };
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const photoLoaded = useMemo(() => photoFor(spec.cube), [photoMode, photo, smooth, relief, invert, spec.cube, spec.scale, layoutBed[0], layoutBed[1], trim]);
  const loaded = photoMode ? photoLoaded : mapLoaded;
  // The heights the puzzle is made from: the area as loaded, less what's trimmed off each side.
  const mapUsed = useMemo(() => (mapLoaded ? cropGrid(mapLoaded.grid, mapLoaded.area.width, mapLoaded.area.height, trim) : null), [mapLoaded, trim]);
  const used = photoMode ? photoLoaded?.used ?? null : mapUsed;
  const area = areaFrom(source, peakId, ref, km, corners, osm);
  // What the usual rules keep from the map, then less the paths and roads clicked off on the top view.
  const mapFeatures: MapFeatures = useMemo(
    () => (source === "osm" && osm ? featuresOnGrid(osm.data, detail, marks, mapLoaded?.grid) : NO_FEATURES),
    [source, osm, detail, marks, mapLoaded],
  );
  const [dropped, setDropped] = useState<ReadonlySet<string>>(NONE_DROPPED);
  // A new area starts with everything kept (the map's own way ids, so reading the same file again keeps the choice).
  const droppedArea = mapLoaded ? `${mapLoaded.area.sw.e},${mapLoaded.area.sw.n},${mapLoaded.area.width},${mapLoaded.area.height}` : "";
  useEffect(() => setDropped(NONE_DROPPED), [droppedArea]);
  const features: MapFeatures = useMemo(() => withoutDropped(mapFeatures, dropped), [mapFeatures, dropped]);
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

  const fullSpec: MountainSpec = photoMode
    ? { ...spec, bed: layoutBed, exaggeration: 1, snowline: null }
    : { ...spec, bed: layoutBed, snowline: snowOn && !colourOn ? snowline : null, ...lochLayers(colourOn, colour, features) };
  const layout = useMemo(() => (used ? layoutFor(used.grid, used.width, used.height, { ...spec, bed: layoutBed, snowline: null }) : null), [used, spec, layoutBed[0], layoutBed[1], layoutBed[2]]);
  const checks = mountainChecks(fullSpec, layout ?? undefined);

  // Make the puzzle a moment after the last change (it takes a second or two for big ones).
  const specKey = JSON.stringify(fullSpec);
  // "As many pieces as will print well": the cube size is found by building a few sizes (a moment apart, so the window
  // keeps drawing), and the puzzle at the size found is kept so it isn't built again.
  const [mostTicked, setMostShown] = useState(() => mostPiecesTicked("mountain"));
  const most = mostTicked && !onePiece;
  const setMost = (on: boolean) => {
    setMostPiecesTicked("mountain", on);
    setMostShown(on);
  };
  const [search, setSearch] = useState<{ key: string; steps: SearchStep[]; result: SearchResult | null } | null>(null);
  const searchBuilder = useRef(new MountainBuilder());
  useEffect(() => () => searchBuilder.current.stop(), []);
  const found = useRef<{ specKey: string; inputs: unknown[]; puzzle: MountainPuzzle } | null>(null);
  const cubeNow = useRef(spec.cube);
  cubeNow.current = spec.cube;
  const { cube: _cube, ...specButCube } = fullSpec;
  void _cube;
  const searchKey = JSON.stringify(specButCube);
  // What the puzzle is made from besides the sizes (the photo's grid depends on the cube size, so it's its settings).
  const buildInputs: unknown[] = photoMode ? [photo, smooth, relief, invert, trim, features] : [mapUsed, features];
  useEffect(() => {
    if (!most || !loaded || !used) {
      searchBuilder.current.stop();
      setSearch(null);
      return;
    }
    let stopped = false;
    const inputs = buildInputs;
    // Only the smallest cube size that printed well so far is kept (not every size tried: each is a full set of meshes).
    let kept: { size: number; puzzle: MountainPuzzle } | null = null;
    const from = cubeNow.current;
    setSearch({ key: searchKey, steps: [], result: null });
    const timer = setTimeout(() => {
      smallestThatPrints({
        from,
        floor: mountainFloor(fullSpec.fit),
        top: 100,
        step: CUBE_STEP,
        stopped: () => stopped,
        onStep: (steps) => !stopped && setSearch({ key: searchKey, steps, result: null }),
        test: async (cube): Promise<Verdict> => {
          // A moment between sizes, so the window draws the progress; the building itself is in a worker.
          await new Promise((r) => setTimeout(r, 30));
          if (stopped) return { ok: false };
          const u = photoMode ? photoFor(cube)?.used : mapUsed;
          if (!u) return { ok: false };
          const s: MountainSpec = { ...fullSpec, cube };
          const early = mountainLayoutVerdict(s, layoutFor(u.grid, u.width, u.height, { ...s, snowline: null }));
          if (early) return early;
          return new Promise<Verdict>((resolve) => {
            searchBuilder.current.build({ grid: u.grid, width: u.width, height: u.height, spec: s, features }, (reply) => {
              if ("error" in reply) resolve({ ok: false, why: "smaller cubes couldn't be made" });
              else {
                if (reply.verdict.ok && (!kept || cube < kept.size)) kept = { size: cube, puzzle: reply.puzzle };
                resolve(reply.verdict);
              }
            });
          });
        },
      })
        .then((result) => {
          if (stopped) return;
          searchBuilder.current.stop();
          if (result.size !== null) {
            const best: { size: number; puzzle: MountainPuzzle } | null = kept;
            if (best && best.size === result.size) found.current = { specKey: JSON.stringify({ ...fullSpec, cube: result.size }), inputs, puzzle: best.puzzle };
            set("cube", result.size);
          }
          kept = null;
          setSearch({ key: searchKey, steps: result.steps, result });
        })
        .catch(() => undefined);
    }, 350);
    return () => {
      stopped = true;
      clearTimeout(timer);
      searchBuilder.current.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [most, !!loaded, searchKey, photoMode, photo, smooth, relief, invert, trim, mapUsed, features]);
  useEffect(() => {
    if (most && loaded && used && !checks.problems.length) {
      // Ticked: the puzzle shown is the one the search found; until then, nothing.
      const f = found.current;
      if (f && f.specKey === specKey && f.inputs.length === buildInputs.length && f.inputs.every((x, i) => x === buildInputs[i])) {
        setPuzzle(f.puzzle);
        setBuildError(null);
        setWorking(false);
        return;
      }
      if (!search || search.key !== searchKey || !search.result || search.result.size === null) {
        setPuzzle(null);
        setWorking(!search?.result);
        return;
      }
    }
    if (!loaded || !used || checks.problems.length) {
      setPuzzle(null);
      return;
    }
    setWorking(true);
    const timer = setTimeout(() => {
      try {
        setPuzzle(makeMountainPuzzle(used.grid, used.width, used.height, fullSpec, features));
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
  }, [loaded, used, specKey, features, most, search]);

  // Colour bands: pieces at different heights get plates of their own, so a plate changes colour on the same layers.
  const byLevel = colourOn && colour.mode === "bands";
  // Put together: a plate per layer, or everything on one plate with the breakaway layers (must fit the bed less margins).
  const stacked = useMemo(() => (puzzle && way === "together" ? stackWithBreakaway(puzzle, layerHeight) : null), [puzzle, way, layerHeight]);
  const placed = useMemo(
    () => (!puzzle || !together ? null : stacked ? togetherPlate(stacked, placeBed, room) : layerPlates(puzzle.pieces, placeBed, room)),
    [puzzle, stacked, together, placeBed[0], placeBed[1], placeBed[2], room.join(",")],
  );
  const plates = useMemo(
    () => (!puzzle ? [] : placed ? (placed.fits ? placed.plates : []) : (byLevel ? platesByLevel : platesFor)(puzzle.pieces, bed)),
    [puzzle, placed, bed[0], bed[1], bed[2], byLevel],
  );
  const settings = together ? IN_PLACE_SETTINGS : undefined;
  const filaments = { ...FILAMENT, breakaway: breakSlot };
  const slotClash = way === "together" && (breakSlot === FILAMENT.rock || (snowOn && !photoMode && breakSlot === FILAMENT.snow));
  const chooseWay = (w: PrintWay) => {
    setPrintWay(w);
    if (w !== "apart") setSpec((s) => ({ ...s, scale: Math.min(s.scale, 1) }));
  };
  // How ground heights sit in the puzzle, and the map drawn over it, for colouring.
  const scaleKey = puzzle ? [baseFor(puzzle.spec), puzzle.layout.low, puzzle.layout.k * puzzle.spec.exaggeration].join(",") : "";
  const scale: HeightScale | null = useMemo(() => (puzzle ? { z0: baseFor(puzzle.spec), h0: puzzle.layout.low, mmPerM: puzzle.layout.k * puzzle.spec.exaggeration } : null), [scaleKey]);
  const puzzleMap = useMemo(() => (puzzle ? mapOnPuzzle(featuresAtScale(features, puzzle.layout.k).features, puzzle.layout.e0, puzzle.layout.n0, puzzle.layout.k) : NO_MAP), [puzzle, features]);
  const mapSize: [number, number] = puzzle ? [puzzle.layout.cols * puzzle.spec.cube, puzzle.layout.rows * puzzle.spec.cube] : [1, 1];
  const paintMap = useMemo(() => mapRaster(puzzleMap, mapSize[0], mapSize[1]), [puzzleMap]);
  const { coloured, working: colouring, error: colourError } = useColoured(colourOn ? puzzle?.pieces ?? null : null, colour, scale, puzzleMap, mapSize, paintMap);
  // From the layout (worked out before the puzzle is made, and kept while it's remade), so the bands don't jump.
  const usualBands = () => (layout ? mountainBands(layout.low, layout.high, snowline) : mountainBands(0, 1000, snowline));
  useBandsFollow(colour, setColour, autoBands, usualBands());
  const fileName = safeFileName(`${loaded?.area.name ?? "Mountain"} puzzle`, "Mountain puzzle");
  // The frame round the finished puzzle: its words are the mountain's name, height, grid reference and scale unless typed.
  const usualWords = useMemo(() => {
    if (!puzzle || !loaded) return "";
    if (photoMode) return loaded.area.name;
    const L = puzzle.layout;
    const peak = source === "peak" ? PEAKS.find((p) => p.id === peakId) : undefined;
    const summit = peak ? parseGridRef(peak.ref) : null;
    // The famous summit only while it's on the puzzle (a trim may cut it off); else the highest point that is.
    const onPuzzle = !!summit && summit.e >= L.e0 && summit.e <= L.e0 + L.width && summit.n >= L.n0 && summit.n <= L.n0 + L.height;
    let top = { e: L.e0 + L.width / 2, n: L.n0 + L.height / 2 };
    if (!onPuzzle && used) {
      let best = -Infinity;
      for (let j = 0; j <= 60; j++)
        for (let i = 0; i <= 60; i++) {
          const at = { e: L.e0 + (L.width * i) / 60, n: L.n0 + (L.height * j) / 60 };
          const h = heightAt(used.grid, at.e, at.n);
          if (h > best) [best, top] = [h, at];
        }
    }
    const ref = formatGridRef(onPuzzle && summit ? summit : top, 6);
    return borderWords(loaded.area.name, onPuzzle && peak ? peak.height : L.high, ref, 1000 / L.k);
  }, [puzzle, loaded, used, photoMode, source, peakId]);
  const words = borderText ?? usualWords;
  // Remade a moment after typing stops, like the puzzle.
  const [settledWords, setSettledWords] = useState(words);
  useEffect(() => {
    const timer = setTimeout(() => setSettledWords(words), 350);
    return () => clearTimeout(timer);
  }, [words]);
  const border = useMemo(() => (borderOn && puzzle ? makeBorder(puzzle, settledWords, bed) : null), [borderOn, puzzle, settledWords, bed[0], bed[1], bed[2]]);
  const borderPlates = useMemo(() => (border && !border.problems.length ? platesFor(border.pieces, bed) : []), [border, bed[0], bed[1], bed[2]]);
  const saveBorder = async () => {
    const files = await Promise.all(borderPlates.map((p, i) => bandPlate3mf(p, `${fileName} - border ${i + 1}`, borderParts, () => "")));
    if (files.length === 1) downloadFile(blobOf(files[0], "model/3mf"), `${fileName} - border.3mf`);
    else downloadFile(blobOf(zipStored(files.map((f, i) => ({ name: `${fileName} - border plate ${i + 1} of ${files.length}.3mf`, data: f }))), "application/zip"), `${fileName} - border.zip`);
  };
  const set = <K extends keyof typeof spec>(key: K, value: (typeof spec)[K]) => setSpec((s) => ({ ...s, [key]: value }));
  const numberBox = (value: number, onChange: (v: number) => void, step: number, min: number, max: number, unit: string, disabled = false) => (
    <span className="mountain-number">
      <input type="number" value={value} step={step} min={min} max={max} disabled={disabled} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && onChange(e.target.valueAsNumber)} />
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
    <Modal title={photoMode ? "Photo relief puzzle" : "Mountain puzzle"} onClose={close} width={1280}>
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
              {detail !== "area" && <MarkChoices choice={marks} onChange={setMarks} roads={detail === "all"} />}
              {osm && (
                <p className="muted small">
                  {detail === "area"
                    ? "Just the area the map covers."
                    : `${featureSummary(features)[0].toUpperCase()}${featureSummary(features).slice(1)}: paths${detail === "all" ? " and roads" : ""} become thin, shallow grooves in the ground, lochs flat water${detail === "all" ? ", buildings small blocks" : ""}.`}
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
          <div className="mountain-choices" role="radiogroup" aria-label="What it makes">
            <label>
              <input type="radio" name="mountain-make" checked={!onePiece} onChange={() => set("onePiece", undefined)} /> A puzzle of interlocking cubes
            </label>
            <label>
              <input type="radio" name="mountain-make" checked={onePiece} onChange={() => {
                  setSpec((s) => ({ ...s, onePiece: true, scale: Math.min(s.scale, 1) }));
                  setExplode(0);
                }} /> In one piece (a solid model, not a puzzle)
            </label>
          </div>
          {onePiece && (
            <>
              <p className="muted small">
                {photoMode ? "The picture" : "The mountain"} prints as one solid model, in the middle of one plate: the ground on top, flat sides and a flat bottom. No cubes, keys or tabs.
              </p>
              {multi && (
                <label className="mountain-check">
                  <input type="checkbox" checked={towerOff} onChange={(e) => setTowerOff(e.target.checked)} /> I'll turn the prime tower off in Bambu Studio (the model can then be bigger)
                </label>
              )}
            </>
          )}
          {!onePiece && (
            <>
          <div className="mountain-choices" role="radiogroup" aria-label="How it's printed">
            <label>
              <input type="radio" name="mountain-print" checked={printWay === "apart"} onChange={() => chooseWay("apart")} /> Pieces laid out on plates
            </label>
            <label>
              <input type="radio" name="mountain-print" checked={printWay === "layers"} onChange={() => chooseWay("layers")} /> Each layer put together (a plate per layer)
            </label>
            <label title={colourOn ? "With colour bands or full colour, each layer is printed put together instead." : undefined}>
              <input type="radio" name="mountain-print" checked={printWay === "together"} disabled={colourOn} onChange={() => chooseWay("together")} /> All in one go, with
              breakaway layers between
            </label>
          </div>
          <p className="muted small">
            {way === "apart"
              ? "Pieces are laid out apart on as many plates as they need."
              : way === "layers"
                ? "Each layer prints on its own plate with every piece where it sits, so it comes off the bed as a ready-made jigsaw: print them in order and stack them. Only the side gaps keep the pieces apart, so print a small test first; if pieces come off stuck together, raise the fit gap."
                : "The whole mountain prints in one go, put together. Between each layer the printer lays a thin layer of breakaway support filament (Bambu's Support for PLA) that doesn't stick to PLA, and fills each key's pocket with it, so the layers lift apart afterwards. Print a small test first."}
            {printWay === "together" && colourOn && " With colour bands or full colour, each layer is printed put together instead."}
          </p>
          {way === "together" && (
            <>
              <label className="mountain-row">
                <span>Layer height</span>
                <span>
                  <select value={layerHeight} onChange={(e) => setLayerHeight(Number(e.target.value))}>
                    {LAYER_HEIGHTS.map((h) => (
                      <option key={h} value={h}>
                        {h.toFixed(2)} mm
                      </option>
                    ))}
                  </select>
                  <span className="muted small"> slice with this, so the breakaway layers line up with the print's own</span>
                </span>
              </label>
              <label className="mountain-row">
                <span>Breakaway filament</span>
                <span>
                  <select value={breakSlot} onChange={(e) => setBreakSlot(Number(e.target.value))}>
                    {Array.from({ length: Math.max(4, amsSlotsOf(printer)) }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        Filament {n}
                      </option>
                    ))}
                  </select>
                  <span className="muted small"> load Support for PLA here</span>
                </span>
              </label>
              {slotClash && <p className="error-text small">That filament is already the puzzle's {breakSlot === FILAMENT.rock ? "rock" : "snow"} — choose another for the breakaway layers.</p>}
            </>
          )}
          {together && multi && (
            <label className="mountain-check">
              <input type="checkbox" checked={towerOff} onChange={(e) => setTowerOff(e.target.checked)} /> I'll turn the prime tower off in Bambu Studio (the puzzle can then be bigger)
            </label>
          )}
            </>
          )}
          <div className="mountain-row">
            <span>Scale</span>
            <span>
              {numberBox(Math.round(spec.scale * 100), (v) => set("scale", v / 100), 10, 20, together ? 100 : 1000, "%")}
              <span className="muted small">
                {together
                  ? ` 100% = the finished puzzle fills the bed (${placeBed[0]} × ${placeBed[1]} mm, less 5 mm round the edge${keepOut.length ? ", the parts kept free" : ""}${multi && !towerOff ? " and the back-left corner for the prime tower" : ""}), in the middle, where Bambu Studio puts it; it can't be bigger`
                  : ` 100% = the finished puzzle covers the bed (${bed[0]} × ${bed[1]} mm)`}
              </span>
            </span>
          </div>
          {loaded && (
            <TrimSliders
              trim={trim}
              setTrim={setTrim}
              size={[loaded.area.width, loaded.area.height]}
              unit={(v) => (photoMode ? `${Math.round(v)} px` : `${(v / 1000).toFixed(2)} km`)}
            />
          )}
          {!onePiece && (
            <>
          <div className="mountain-row">
            <span>Cube size</span>
            <span>
              {numberBox(spec.cube, (v) => set("cube", v), 1, 10, 100, "mm", most)}
              <span className={`small ${neck < MIN_NECK ? "error-text" : neck < GOOD_NECK ? "mountain-warn" : "muted"}`}>
                {" "}
                smallest {smallestCube(spec.fit)} mm, sturdy from {smallestCube(spec.fit, GOOD_NECK)} mm
              </span>
            </span>
          </div>
          <label className="mountain-check">
            <input type="checkbox" checked={mostTicked} onChange={(e) => setMost(e.target.checked)} /> As many pieces as will print well
          </label>
          {most && <MostPiecesNote search={search} noun="Cubes" pieces={puzzle?.pieces.length ?? null} floorWords={`${mountainFloor(spec.fit)} mm is the smallest cube with sturdy tabs`} looking="Finding the smallest cubes that print well…" foundWords="smallest that prints well" />}
            </>
          )}
          <div className="mountain-row">
            <span>Side under the ground</span>
            <span>
              {numberBox(spec.base, (v) => set("base", v), 1, baseFor({ ...spec, base: 0 }), 60, "mm")}
              <span className="muted small">{onePiece ? " plain side below the lowest ground" : " plain side below the lowest ground; the bottom layer is a thin jigsaw plate"}</span>
            </span>
          </div>
          {!photoMode && (
            <div className="mountain-row">
              <span>Height stretch</span>
              {numberBox(spec.exaggeration, (v) => set("exaggeration", v), 0.25, 0.25, 5, "×")}
            </div>
          )}
          {!onePiece && (
            <>
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
            </>
          )}

          {!photoMode && (
            <>
          <h3 className="library-heading">3. Colour</h3>
          <ColourPanel
            spec={colour}
            setSpec={setColour}
            usual={usualBands}
            slots={amsSlotsOf(printer)}
            setSlots={(n) => setPrinter(savePrinter({ amsSlots: n }))}
            usualBase={GROUND_BROWN}
            usualWater={WATER_BLUE}
            has={paintMap}
            roadsAsked={detail === "all"}
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

          <h3 className="library-heading">{photoMode ? "3. Border" : colourOn ? "4. Border" : "5. Border"}</h3>
          <label className="mountain-check">
            <input type="checkbox" checked={borderOn} onChange={(e) => setBorderOn(e.target.checked)} /> Border (frame round the puzzle)
          </label>
          {borderOn && (
            <>
              {onePiece && (
                <div className="mountain-row">
                  <span>Fit gap</span>
                  <span>
                    {numberBox(spec.fit, (v) => set("fit", v), 0.05, 0, 0.5, "mm")}
                    <span className="muted small"> between the model and its border</span>
                  </span>
                </div>
              )}
              <p className="muted small">
                A low wall round the finished puzzle that hides its steep cut sides: each side as tall as the puzzle's highest point
                along it, in pieces that fit the bed and lock together with lugs. It's a file of its own.
              </p>
              <label className="mountain-row">
                <span>Words on the front</span>
                <textarea rows={2} value={words} onChange={(e) => setBorderText(e.target.value)} placeholder="Leave empty for no words" />
              </label>
              <p className="muted small">
                Raised on the front's outside face as a part of their own, set to filament 2 — load a colour that stands out there.
                {borderText !== null && (
                  <>
                    {" "}
                    <button type="button" className="text-button" onClick={() => setBorderText(null)}>
                      Usual words
                    </button>
                  </>
                )}
              </p>
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
                <TopView
                  grid={loaded.grid}
                  area={loaded.area}
                  puzzle={puzzle}
                  picture={photoMode ? photo?.url ?? null : source === "picture" ? picture : null}
                  features={photoMode ? NO_FEATURES : features}
                  pick={
                    photoMode
                      ? null
                      : {
                          // Only lines on the puzzle itself (not on the dimmed, trimmed-off edge) are offered and counted.
                          lines: pickableLines(
                            (puzzle ? featuresAtScale(mapFeatures, puzzle.layout.k).features : mapFeatures).lines,
                            dropped,
                            null,
                            puzzle ? { e0: puzzle.layout.e0, n0: puzzle.layout.n0, width: puzzle.layout.width, height: puzzle.layout.height } : null,
                          ),
                          dropped,
                          onChange: setDropped,
                          pending: working,
                        }
                  }
                />
                <Mountain3D puzzle={puzzle} explode={onePiece ? 0 : explode} paint={colourOn ? (coloured?.preview ?? null) : null} border={border && !border.problems.length ? border.pieces : null} />
              </div>
              {!onePiece && (
                <label className="mountain-explode small">
                  Pull apart <input type="range" min={0} max={20} value={explode} onChange={(e) => setExplode(Number(e.target.value))} />
                </label>
              )}
              {checks.problems.map((p) => (
                <p key={p} className="error-text small">
                  {p}
                </p>
              ))}
              {buildError && <p className="error-text small">{buildError}</p>}
              {working && <p className="muted small">Working…</p>}
              {puzzle && puzzle.spec.onePiece && (
                <div className="mountain-summary small">
                  <p>
                    <strong>Printed as one piece</strong> — finished {puzzle.layout.cols * puzzle.spec.cube} × {puzzle.layout.rows * puzzle.spec.cube} mm and{" "}
                    {Math.round(Math.max(...puzzle.pieces.map((p) => p.z0 + p.height)))} mm tall;{" "}
                    {photoMode
                      ? `${relief} mm of relief over the picture`
                      : `1 mm is ${Math.round(1 / puzzle.layout.k)} m of ground (1 : ${Math.round(1000 / puzzle.layout.k).toLocaleString("en-GB")}). Ground from ${Math.round(puzzle.layout.low)} m to ${Math.round(puzzle.layout.high)} m`}
                    , with {Math.round(baseFor(puzzle.spec))} mm of plain side under the lowest.
                    {!colourOn && snowOn && snowline !== null && (snowParts ? " Its snow is a part of its own: filament 2." : " Nothing reaches the snow line.")}
                  </p>
                  {puzzle.warnings.map((w) => (
                    <p key={w} className="mountain-warn">
                      {w}
                    </p>
                  ))}
                </div>
              )}
              {puzzle && !puzzle.spec.onePiece && (
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
              {placed && !placed.fits && (
                <p className="error-text small">
                  Put together it's {Math.round(placed.size[0])} × {Math.round(placed.size[1])} mm, which doesn't fit the bed in one piece. Lower the scale.
                </p>
              )}
              {puzzle && placed?.fits && (
                <p className="muted small">
                  {onePiece
                    ? "One plate, the model in the middle, where Bambu Studio puts it."
                    : way === "layers"
                    ? `${plates.length} plates, one per layer: plate 1 is the bottom layer. Print them in order and stack each on the one before.`
                    : `One plate, ${Math.round(stacked!.height)} mm tall. Slice with ${layerHeight.toFixed(2)} mm layers (the first layer 0.20 mm) and supports off — the breakaway layers are already in the file, on filament ${breakSlot}. About ${breakawaySwaps(stacked!, layerHeight, puzzle.keys)} filament changes for them.`}{" "}
                  {onePiece
                    ? "It comes in with no brim and elephant-foot compensation on, so the bottom edge stays crisp."
                    : "Each piece has no brim and elephant-foot compensation on, so the first layer doesn't close the gaps; don't press Arrange in Bambu Studio."}
                  {multi && !towerOff && " For several filaments Bambu Studio adds a prime tower at the back left, which is kept free for it."}
                  {multi && towerOff && " Turn the prime tower off in Bambu Studio (Others › Prime tower) before slicing."}
                </p>
              )}
              {colourOn && puzzle && coloured && scale && plates.length > 0 && (
                <ColourDownloads spec={colour} coloured={coloured} plates={plates} scale={scale} map={paintMap} fileName={fileName} bedWidth={bed[0]} settings={settings} onePiece={onePiece} />
              )}
              {!colourOn && puzzle && plates.length > 0 && !slotClash && (
                <div className="mountain-downloads">
                  <span className="small">
                    {plates.length === 1 ? "One plate" : `${plates.length} plates`} for Bambu Studio:
                  </span>
                  {plates.map((p, i) => (
                    <button
                      key={i}
                      className="text-button"
                      onClick={() => downloadFile(blobOf(plate3mf(p, `${fileName} - plate ${i + 1}`, settings, filaments), "model/3mf"), `${fileName} - plate ${i + 1} of ${plates.length}.3mf`)}
                      title={p.pieces.map((x) => x.piece.name).join(", ")}
                    >
                      {plates.length === 1
                        ? onePiece
                          ? "The model (.3mf)"
                          : `All ${p.pieces.filter((x) => x.piece.col >= 0).length} pieces (.3mf)`
                        : `${way === "layers" ? `Layer ${i + 1}` : `Plate ${i + 1}`} (${p.pieces.filter((x) => x.piece.col >= 0).length})`}
                    </button>
                  ))}
                  {plates.length > 1 && (
                    <button className="primary-button" onClick={() => downloadFile(blobOf(allPlatesZip(plates, fileName, settings, filaments), "application/zip"), `${fileName}.zip`)}>
                      All plates (.zip)
                    </button>
                  )}
                </div>
              )}
              {border && (
                <div className="mountain-summary small">
                  {border.problems.map((p) => (
                    <p key={p} className="error-text">
                      {p}
                    </p>
                  ))}
                  {!border.problems.length && (
                    <p>
                      <strong>Border: {border.pieces.length} pieces</strong> — its top follows the land round the edge in one smooth line, a little
                      above it: {heightRange(border.lows.S, border.heights.S)} tall at the front, {heightRange(border.lows.E, border.heights.E)} on the
                      east, {heightRange(border.lows.N, border.heights.N)} at the back and {heightRange(border.lows.W, border.heights.W)} on the west,{" "}
                      {(BORDER_WALL - 2 * puzzle!.spec.fit).toFixed(1)} mm thick.
                      {border.caps.length > 0 && ` Words ${border.caps.map((c) => c.toFixed(1)).join(" and ")} mm tall.`}
                    </p>
                  )}
                  {border.warnings.map((w) => (
                    <p key={w} className="mountain-warn">
                      {w}
                    </p>
                  ))}
                  {borderPlates.length > 0 && (
                    <div className="mountain-downloads">
                      <button className="primary-button" onClick={() => void saveBorder()}>
                        Border ({borderPlates.length === 1 ? "1 plate, .3mf" : `${borderPlates.length} plates, .zip`})
                      </button>
                    </div>
                  )}
                </div>
              )}
              {puzzle && !puzzle.spec.onePiece && (
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
function TopView({ grid, area, puzzle, picture, features, pick }: { grid: HeightGrid; area: Area; puzzle: MountainPuzzle | null; picture: string | null; features: MapFeatures; pick: TopViewPick | null }) {
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
    // The map's lochs, buildings and lines on top (once the puzzle's made, only those big enough to print).
    const shown = puzzle ? featuresAtScale(features, puzzle.layout.k).features : features;
    for (const shape of shown.shapes) {
      ctx.beginPath();
      for (const ring of shape.rings) ring.forEach(([e, n], i) => (i ? ctx.lineTo(...toPx(e, n)) : ctx.moveTo(...toPx(e, n))));
      ctx.fillStyle = shape.kind === "water" ? "rgba(60,120,200,0.8)" : "rgba(60,50,40,0.9)";
      ctx.fill("evenodd");
    }
    for (const line of shown.lines) {
      ctx.beginPath();
      line.pts.forEach(([e, n], i) => (i ? ctx.lineTo(...toPx(e, n)) : ctx.moveTo(...toPx(e, n))));
      const stroke = markStroke(line.kind, line.thin);
      ctx.strokeStyle = stroke.colour;
      ctx.lineWidth = stroke.width;
      ctx.setLineDash(stroke.dash);
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
    if (puzzle.spec.onePiece) {
      // One piece: just its outline.
      ctx.strokeRect(ax, ay, bx - ax, by - ay);
      return;
    }
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
      <PickableView pick={pick} box={mountainViewBox(area)}>
        <canvas ref={ref} className="mountain-top" />
      </PickableView>
      <figcaption className="muted small">{puzzle?.spec.onePiece ? "From above, north up: the outline is the model." : "From above, north up: each square is a column of cubes (name × pieces in it)."}</figcaption>
    </figure>
  );
}

/** How much further back than just touching the edges the 3D preview stands (a little room round the model). */
const FIT_ROOM = 1.08;

/** The puzzle in 3D, to turn round; pulled apart by `explode` mm per step. */
export function Mountain3D({ puzzle, explode, paint, border }: { puzzle: { pieces: PuzzlePiece[] } | null; explode: number; paint?: PreviewMesh[] | null; border?: BorderPiece[] | null }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; group: THREE.Group; framed: boolean; fit: () => void; moved: () => boolean } | null>(null);

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
    // Turned or zoomed by hand: a resize (Enlarge) no longer frames it afresh.
    let moved = false;
    controls.addEventListener("start", () => (moved = true));
    // The whole model in view with a little room round it, whatever the view's shape.
    const fit = () => {
      if (!group.children.length) return;
      const box = new THREE.Box3().setFromObject(group);
      const centre = box.getCenter(new THREE.Vector3());
      const dir = new THREE.Vector3(0.9, -1.9, 1.4).normalize();
      const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z].map((v, i) => v - centre.getComponent(i)) as [number, number, number]);
      const distance = fitDistance(corners, [dir.x, dir.y, dir.z], camera.fov, camera.aspect) * FIT_ROOM;
      controls.target.copy(centre);
      camera.position.copy(centre).addScaledVector(dir, distance);
      camera.near = distance / 100;
      camera.far = distance * 10;
      camera.updateProjectionMatrix();
      controls.update();
      moved = false;
    };
    const resize = () => {
      const w = el.clientWidth || 380;
      const h = el.clientHeight || 300;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (view.current?.framed && !moved) fit();
      draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    view.current = { renderer, scene, camera, controls, group, framed: false, fit, moved: () => moved };
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

  // Seen whole again when the border is switched on or off.
  const hadBorder = useRef(false);
  const shownPuzzle = useRef<{ pieces: PuzzlePiece[] } | null>(null);
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    if (!!border?.length !== hadBorder.current) {
      hadBorder.current = !!border?.length;
      v.framed = false;
    }
    for (const child of [...v.group.children]) {
      (child as THREE.Mesh).geometry?.dispose();
      ((child as THREE.Mesh).material as THREE.Material | undefined)?.dispose?.();
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
    // The border, its frame and its words, moved out with the puzzle's edge as it's pulled apart.
    if (border?.length)
      for (const words of [false, true]) {
        const pos: number[] = [];
        for (const p of border) {
          const b = words ? p.words : p.bodies[0];
          if (!b) continue;
          const [dx, dy] = [Math.max(-1, p.col) * explode, Math.max(-1, p.row) * explode];
          for (const t of b.triangles) pos.push(b.vertices[t * 3] + dx, b.vertices[t * 3 + 1] + dy, b.vertices[t * 3 + 2]);
        }
        if (!pos.length) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        geo.computeVertexNormals();
        v.group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: words ? WORDS : FRAME, roughness: 0.85, flatShading: true })));
      }
    // Framed when first shown, and again for each new puzzle (its size can change a lot) unless turned by hand since.
    if (!v.framed || (puzzle !== shownPuzzle.current && !v.moved())) {
      v.fit();
      v.framed = true;
    }
    shownPuzzle.current = puzzle;
    v.renderer.render(v.scene, v.camera);
  }, [puzzle, explode, paint, border]);

  // Enlarged to (nearly) the whole window; Esc or the button puts it back (the window's own Esc is held off meanwhile).
  const [big, setBig] = useState(false);
  useEffect(() => {
    if (!big) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setBig(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [big]);

  return (
    <div className={big ? "mountain-3d-wrap big" : "mountain-3d-wrap"} data-keeps-escape={big ? "" : undefined}>
      <div ref={host} className="mountain-3d" aria-label="The puzzle in 3D: drag to turn it" />
      <button type="button" className="mountain-3d-size" onClick={() => setBig(!big)} title={big ? "Back to the usual size (Esc)" : "Make the 3D view fill the window"}>
        {big ? "✕ Close big view" : "⤢ Enlarge"}
      </button>
    </div>
  );
}
