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
} from "../terrain/mountainPuzzle";
import { formatGridRef, parseGridRef, type GridPoint } from "../terrain/osGrid";
import { PEAKS } from "../terrain/peaks";
import { allPlatesZip, plate3mf, platesFor } from "../terrain/puzzle3mf";
import { downloadFile, safeFileName } from "./download";
import { Modal } from "./Modal";
import { openMountain } from "./mountainState";
import { loadTerrainTile } from "./mountainTiles";
import { loadPrinter, printerBed, savePrinter } from "./printerSetting";

type Source = "peak" | "ref" | "picture";

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
function areaFrom(source: Source, peakId: string, ref: string, km: [number, number], corners: [string, string]): Area | string {
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

export function MountainPuzzleDialog() {
  const close = () => openMountain(false);
  const [source, setSource] = useState<Source>("peak");
  const [peakId, setPeakId] = useState(PEAKS[0].id);
  const [ref, setRef] = useState("NN 166 712");
  const [km, setKm] = useState<[number, number]>([5, 4]);
  const [picture, setPicture] = useState<string | null>(null);
  const [corners, setCorners] = useState<[string, string]>(["", ""]);

  const [printer, setPrinter] = useState(() => loadPrinter());
  const bed = printerBed(printer);
  const [spec, setSpec] = useState<Omit<MountainSpec, "bed" | "snowline">>(() => ({ ...MOUNTAIN_DEFAULTS }));
  const [snowOn, setSnowOn] = useState(true);
  const [snowline, setSnowline] = useState<number | null>(null);

  const [loaded, setLoaded] = useState<{ area: Area; grid: HeightGrid } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [puzzle, setPuzzle] = useState<MountainPuzzle | null>(null);
  const [working, setWorking] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [explode, setExplode] = useState(0);

  const area = areaFrom(source, peakId, ref, km, corners);
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

  const fullSpec: MountainSpec = { ...spec, bed, snowline: snowOn ? snowline : null };
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
        setPuzzle(makeMountainPuzzle(loaded.grid, loaded.area.width, loaded.area.height, fullSpec));
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
  }, [loaded, specKey]);

  const plates = useMemo(() => (puzzle ? platesFor(puzzle.pieces, bed) : []), [puzzle, bed[0], bed[1], bed[2]]);
  const fileName = safeFileName(`${loaded?.area.name ?? "Mountain"} puzzle`, "Mountain puzzle");
  const set = <K extends keyof typeof spec>(key: K, value: (typeof spec)[K]) => setSpec((s) => ({ ...s, [key]: value }));
  const numberBox = (value: number, onChange: (v: number) => void, step: number, min: number, max: number, unit: string) => (
    <span className="mountain-number">
      <input type="number" value={value} step={step} min={min} max={max} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && onChange(e.target.valueAsNumber)} />
      <span className="muted">{unit}</span>
    </span>
  );

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
    <Modal title="Mountain puzzle" onClose={close} width={980}>
      <div className="mountain-layout">
        <div className="mountain-side">
          <h3 className="library-heading">1. The mountain</h3>
          <div className="mountain-choices" role="radiogroup" aria-label="Where the mountain comes from">
            {(
              [
                ["peak", "A famous mountain"],
                ["ref", "A grid reference"],
                ["picture", "My OS map picture"],
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
          {source !== "picture" && (
            <div className="mountain-row">
              <span>Area</span>
              <span>
                {numberBox(km[0], (v) => setKm([v, km[1]]), 0.5, 0.2, 40, "km wide")} {numberBox(km[1], (v) => setKm([km[0], v]), 0.5, 0.2, 40, "km tall")}
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
            <span>Height stretch</span>
            {numberBox(spec.exaggeration, (v) => set("exaggeration", v), 0.25, 0.25, 5, "×")}
          </div>
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

          <h3 className="library-heading">3. Snow</h3>
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
        </div>

        <div className="mountain-main">
          {!loaded ? (
            <div className="mountain-empty muted">
              <p>Choose a mountain and press <strong>Get the heights</strong>.</p>
              <p className="small">
                Heights come free from Amazon's open Terrain Tiles (built on OS Terrain 50 and NASA data), about 20–30 m apart.
              </p>
            </div>
          ) : (
            <>
              <div className="mountain-previews">
                <TopView grid={loaded.grid} area={loaded.area} puzzle={puzzle} picture={source === "picture" ? picture : null} />
                <Mountain3D puzzle={puzzle} explode={explode} />
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
                    {Math.round(Math.max(...puzzle.pieces.map((p) => p.z0 + p.height)))} mm tall; 1 mm is {Math.round(1 / puzzle.layout.k)} m of ground
                    (1 : {Math.round(1000 / puzzle.layout.k).toLocaleString("en-GB")}). Ground from {Math.round(puzzle.layout.low)} m to{" "}
                    {Math.round(puzzle.layout.high)} m, with {Math.round(baseFor(fullSpec))} mm of base under the lowest.
                  </p>
                  <p className="muted">
                    Tabs' necks {puzzle.neck.toFixed(1)} mm; each piece sits on a square key about{" "}
                    {Math.round(Math.min(...puzzle.pieces.filter((p) => p.key).map((p) => p.key!.half * 2)))}–
                    {Math.round(Math.max(...puzzle.pieces.filter((p) => p.key).map((p) => p.key!.half * 2)))} mm across and {puzzle.keys.h.toFixed(1)} mm tall.
                    {snowOn && snowline !== null && (snowParts ? ` ${snowParts} pieces have snow: filament 2.` : " Nothing reaches the snow line.")}
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
function TopView({ grid, area, puzzle, picture }: { grid: HeightGrid; area: Area; puzzle: MountainPuzzle | null; picture: string | null }) {
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
  }, [grid, area, puzzle, img]);
  return (
    <figure className="mountain-figure">
      <canvas ref={ref} className="mountain-top" />
      <figcaption className="muted small">From above, north up: each square is a column of cubes (name × pieces in it).</figcaption>
    </figure>
  );
}

/** The puzzle in 3D, to turn round; pulled apart by `explode` mm per step. */
function Mountain3D({ puzzle, explode }: { puzzle: MountainPuzzle | null; explode: number }) {
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
    for (const part of ["rock", "snow"] as const) {
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
  }, [puzzle, explode]);

  return <div ref={host} className="mountain-3d" aria-label="The puzzle in 3D: drag to turn it" />;
}
