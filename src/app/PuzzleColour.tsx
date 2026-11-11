/**
 * The "Colour" part of the Island and Mountain puzzle windows: Plain (as before), Colour bands (a filament per band, for
 * an AMS) or Full colour (full-colour printers and services), the bands' colours and heights, and the downloads for the
 * banded and full-colour files. The maths and the files are in src/terrain/colour.ts and colourFiles.ts.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  colourProblems,
  colourWarnings,
  filaments,
  LEAST_BANDS,
  MOST_BANDS,
  SPARE_COLOURS,
  type ColourBand,
  type ColourMode,
  type ColourSpec,
  type HeightScale,
  type MapRaster,
  type PreviewMesh,
  type PuzzleMap,
  type ColouredMesh,
} from "../terrain/colour";
import type { ColourJob, ColourReply } from "../terrain/colourJob";
import { allItems, bandPlateFile, colour3mfFiles, colourObjFiles, colourWrl, plateItems, plateSwaps, zipDeflated, type BandedPuzzle } from "../terrain/colourFiles";
import type { PuzzlePiece } from "../terrain/mountainPuzzle";
import { zipStored } from "../geometry/threeMf";
import type { Plate } from "../terrain/puzzle3mf";
import { downloadFile } from "./download";

const blobOf = (bytes: Uint8Array, type: string) => new Blob([new Uint8Array(bytes)], { type });

export const COLOUR_MODES: [ColourMode, string][] = [
  ["plain", "Plain (one filament)"],
  ["bands", "Colour bands (AMS, 2–8 filaments)"],
  ["full", "Full colour (full-colour printers and services)"],
];

/** The colour choices: mode, bands, base and water colours, layer height. */
export function ColourPanel({
  spec,
  setSpec,
  usual,
  usualBase,
  usualWater,
  hasMap,
  ground,
}: {
  spec: ColourSpec;
  setSpec: (s: ColourSpec) => void;
  /** The usual bands for the ground loaded now. */
  usual: () => ColourBand[];
  usualBase: string | null;
  usualWater: string;
  /** Lochs and rivers from the map are loaded. */
  hasMap: boolean;
  /** The ground's lowest and highest (m), for the hint. */
  ground: [number, number] | null;
}) {
  const choose = (mode: ColourMode) => {
    if (mode === "plain" || spec.bands.length) return setSpec({ ...spec, mode });
    setSpec({ ...spec, mode, bands: usual(), base: usualBase, water: usualWater });
  };
  const band = (i: number, change: Partial<ColourBand>) => setSpec({ ...spec, bands: spec.bands.map((b, k) => (k === i ? { ...b, ...change } : b)) });
  const add = () => {
    const last = spec.bands[spec.bands.length - 1];
    const used = new Set(spec.bands.map((b) => b.colour.toLowerCase()));
    const colour = SPARE_COLOURS.find((c) => !used.has(c)) ?? "#808080";
    const top = ground ? ground[1] : last.from + 100;
    const from = Math.round((last.from + Math.max(top, last.from + 20)) / 2);
    // A new band goes under the snow, if there is one.
    const at = last.snow ? spec.bands.length - 1 : spec.bands.length;
    const nb: ColourBand = { name: `Band ${spec.bands.length + 1}`, colour, from: last.snow ? Math.round((spec.bands[at - 1].from + last.from) / 2) : from };
    setSpec({ ...spec, bands: [...spec.bands.slice(0, at), nb, ...spec.bands.slice(at)] });
  };
  const remove = (i: number) => setSpec({ ...spec, bands: spec.bands.filter((_, k) => k !== i) });
  const fs = filaments(spec, hasMap);
  const problems = colourProblems(spec, hasMap);
  return (
    <>
      <label className="mountain-row">
        <span>Colour</span>
        <select value={spec.mode} onChange={(e) => choose(e.target.value as ColourMode)} aria-label="Colour">
          {COLOUR_MODES.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {spec.mode === "bands" && (
        <p className="muted small">
          Each piece is split into a part per colour band, each set to its own filament, so Bambu Studio opens it ready to print
          with an AMS. Band edges are moved onto whole layers, so colours change from one layer to the next.
        </p>
      )}
      {spec.mode === "full" && (
        <p className="muted small">
          Full-colour files are for full-colour printers (like the Bambu Lab H3C) or print services (JLC3DP, 3D Alchemy and
          others): a smooth height tint with gentle hill shading lit from the north-west{spec.bands.some((b) => b.snow) ? ", snow on the gentler slopes above the snow line" : ""}
          {hasMap ? ", and the map's water, paths, roads and woods" : ""}. An ordinary printer can't print them in colour.
        </p>
      )}
      {spec.mode !== "plain" && (
        <div className="colour-bands">
          {spec.bands.map((b, i) => (
            <div key={i} className="colour-band">
              <input type="color" value={b.colour} onChange={(e) => band(i, { colour: e.target.value })} aria-label={`${b.name} colour`} title="Pick the colour" />
              <input className="colour-band-name" value={b.name} onChange={(e) => band(i, { name: e.target.value })} aria-label={`Band ${i + 1} name`} />
              {i === 0 ? (
                <span className="muted small">from the lowest ground</span>
              ) : (
                <span className="mountain-number">
                  <span className="muted small">from</span>
                  <input type="number" value={b.from} step={10} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && band(i, { from: e.target.valueAsNumber })} aria-label={`${b.name} starts at (m)`} />
                  <span className="muted">m</span>
                </span>
              )}
              {spec.bands.length > LEAST_BANDS && (
                <button className="text-button" onClick={() => remove(i)} title="Remove this band" aria-label={`Remove ${b.name}`}>
                  ✕
                </button>
              )}
            </div>
          ))}
          <div className="colour-band-actions">
            {spec.bands.length < MOST_BANDS && (
              <button className="text-button" onClick={add}>
                + Add a band
              </button>
            )}
            <button className="text-button" onClick={() => setSpec({ ...spec, bands: usual() })}>
              Usual colours and heights
            </button>
          </div>
          {ground && <p className="muted small">The ground here goes from {Math.round(ground[0])} m to {Math.round(ground[1])} m.</p>}
          <label className="mountain-check">
            <input type="checkbox" checked={spec.base !== null} onChange={(e) => setSpec({ ...spec, base: e.target.checked ? usualBase ?? "#5a4a3a" : null })} /> The base (below the
            ground) in its own colour
            {spec.base !== null && <input type="color" value={spec.base} onChange={(e) => setSpec({ ...spec, base: e.target.value })} aria-label="Base colour" />}
          </label>
          <label className="mountain-check">
            <input type="checkbox" checked={spec.water !== null} onChange={(e) => setSpec({ ...spec, water: e.target.checked ? usualWater : null })} /> Lochs and rivers from
            the map in blue
            {spec.water !== null && <input type="color" value={spec.water} onChange={(e) => setSpec({ ...spec, water: e.target.value })} aria-label="Water colour" />}
          </label>
          {spec.water !== null && !hasMap && <p className="muted small">Load the map's paths, rivers and lochs (From the map) to colour the water.</p>}
          {spec.mode === "bands" && (
            <>
              <div className="mountain-row">
                <span>Layer height</span>
                <span className="mountain-number">
                  <input type="number" value={spec.layer} step={0.04} min={0.04} max={1} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && setSpec({ ...spec, layer: e.target.valueAsNumber })} />
                  <span className="muted">mm — the same as in Bambu Studio</span>
                </span>
              </div>
              <div className="mountain-row">
                <span>First layer</span>
                <span className="mountain-number">
                  <input
                    type="number"
                    value={spec.firstLayer ?? spec.layer}
                    step={0.04}
                    min={0.04}
                    max={1}
                    onChange={(e) => Number.isFinite(e.target.valueAsNumber) && setSpec({ ...spec, firstLayer: e.target.valueAsNumber })}
                  />
                  <span className="muted">mm — Bambu Studio's "Initial layer height" (0.2 mm on its usual profiles)</span>
                </span>
              </div>
              <p className="small">
                Load:{" "}
                {fs.map((f) => (
                  <span key={f.n} className="colour-filament">
                    <span className="colour-swatch" style={{ background: f.colour }} /> {f.n} {f.uses.join(", ")}
                  </span>
                ))}
              </p>
            </>
          )}
          {problems.map((p) => (
            <p key={p} className="error-text small">
              {p}
            </p>
          ))}
          {!problems.length &&
            colourWarnings(spec, hasMap, ground).map((w) => (
              <p key={w} className="mountain-warn small">
                {w}
              </p>
            ))}
        </div>
      )}
    </>
  );
}

export interface Coloured {
  /** What it was made for (pieces + choices), so an old one isn't used for new pieces. */
  pieces: PuzzlePiece[];
  key: string;
  banded?: BandedPuzzle;
  full?: Map<PuzzlePiece, ColouredMesh>;
  /** For the 3D view, piece by piece. */
  preview: PreviewMesh[];
}

/** The longest colouring is given before the work is taken as lost. */
const COLOUR_LIMIT_MS = 120_000;

/**
 * Colours puzzles in a worker, one job at a time: a new job while one is running starts the worker afresh (so only the
 * latest choices' answer comes back); the pieces are sent only when they're new to the worker.
 */
class ColourRunner {
  private worker: Worker | null = null;
  private sent: PuzzlePiece[] | null = null;
  private busy = false;
  private next = 1;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  run(job: Omit<ColourJob, "id" | "pieces">, pieces: PuzzlePiece[], done: (reply: ColourReply) => void) {
    if (this.busy) this.stop();
    if (!this.worker) {
      this.worker = new Worker(new URL("./puzzleColour.worker.ts", import.meta.url), { type: "module", name: "juracad-colour" });
      this.sent = null;
    }
    const id = this.next++;
    this.busy = true;
    const finish = (reply: ColourReply) => {
      if (this.watchdog !== null) clearTimeout(this.watchdog);
      this.watchdog = null;
      this.busy = false;
      done(reply);
    };
    this.worker.onmessage = (e: MessageEvent<ColourReply>) => {
      if (e.data.id === id) finish(e.data);
    };
    this.worker.onerror = (e) => {
      e.preventDefault();
      this.stop();
      finish({ id, error: "The colours couldn't be worked out — the browser stopped the work part-way. Try fewer or bigger pieces." });
    };
    this.watchdog = setTimeout(() => {
      this.stop();
      finish({ id, error: "Colouring the puzzle took too long and was stopped. Try bigger pieces or a lower scale." });
    }, COLOUR_LIMIT_MS);
    const fresh = this.sent !== pieces;
    this.sent = pieces;
    this.worker.postMessage({ ...job, id, ...(fresh ? { pieces: pieces.map((p) => ({ bodies: p.bodies, z0: p.z0, height: p.height })) } : {}) } satisfies ColourJob);
  }
  stop() {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.worker?.terminate();
    this.worker = null;
    this.sent = null;
    this.busy = false;
  }
}

let mapIds = 0;
const mapIdOf = new WeakMap<PuzzleMap, number>();

/**
 * The pieces coloured for the choices, worked out in a worker a moment after the last change — or null while there's
 * nothing to colour. `map` is the map on the puzzle (`mapSize` mm); keep it the same object while it doesn't change.
 */
export function useColoured(
  pieces: PuzzlePiece[] | null,
  spec: ColourSpec,
  scale: HeightScale | null,
  map: PuzzleMap,
  mapSize: [number, number],
  hasWater: boolean,
): { coloured: Coloured | null; working: boolean; error: string | null } {
  const [coloured, setColoured] = useState<Coloured | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runner = useRef<ColourRunner | null>(null);
  const key = JSON.stringify([spec, scale]);
  const ok = !!pieces && !!scale && spec.mode !== "plain" && !colourProblems(spec, hasWater).length;
  useEffect(() => () => runner.current?.stop(), []);
  useEffect(() => {
    if (!ok || !pieces || !scale) {
      runner.current?.stop();
      setColoured(null);
      setWorking(false);
      return;
    }
    setWorking(true);
    const timer = setTimeout(() => {
      let mapId = mapIdOf.get(map);
      if (mapId === undefined) mapIdOf.set(map, (mapId = ++mapIds));
      runner.current ??= new ColourRunner();
      runner.current.run({ spec, scale, map, mapSize, mapId }, pieces, (reply) => {
        setWorking(false);
        if ("error" in reply) {
          setColoured(null);
          setError(reply.error);
          return;
        }
        setError(null);
        if (reply.mode === "bands")
          setColoured({ pieces, key, banded: { parts: new Map(pieces.map((p, i) => [p, reply.parts[i]])), uncut: reply.uncut }, preview: reply.preview });
        else setColoured({ pieces, key, full: new Map(pieces.map((p, i) => [p, reply.full[i]])), preview: reply.preview });
      });
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pieces, key, map, ok]);
  const current = coloured && coloured.pieces === pieces && coloured.key === key ? coloured : null;
  return { coloured: current, working, error };
}

/** The downloads for colour bands or full colour, and the filament changes per plate. */
export function ColourDownloads({
  spec,
  coloured,
  plates,
  scale,
  map,
  fileName,
  bedWidth,
}: {
  spec: ColourSpec;
  coloured: Coloured;
  plates: Plate[];
  scale: HeightScale;
  map: MapRaster;
  fileName: string;
  bedWidth: number;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const plateName = (i: number) => `${fileName} - plate ${i + 1} of ${plates.length}`;
  const banded = spec.mode === "bands" ? coloured.banded ?? null : null;
  const swaps = useMemo(() => (banded ? plateSwaps(plates, banded, spec.layer) : []), [banded, plates, spec.layer]);
  const save = async (what: string, make: () => Promise<[Uint8Array, string, string]>) => {
    setBusy(what);
    try {
      // Let the window show "Making…" first: big files take a moment.
      await new Promise((r) => setTimeout(r, 30));
      const [bytes, type, name] = await make();
      downloadFile(blobOf(bytes, type), name);
    } finally {
      setBusy(null);
    }
  };
  if (banded) {
    const ctx = { spec, scale, map };
    const file = (i: number) => bandPlateFile(plates[i], `${fileName} - plate ${i + 1}`, banded, ctx);
    return (
      <>
        <div className="mountain-downloads">
          <span className="small">
            {plates.length} {plates.length === 1 ? "plate" : "plates"} in colour bands for Bambu Studio:
          </span>
          {plates.map((p, i) => (
            <button
              key={i}
              className="text-button"
              disabled={!!busy}
              onClick={() => save(`p${i}`, async () => [await file(i), "model/3mf", `${plateName(i)}.3mf`])}
              title={`${p.pieces.map((x) => x.piece.name).join(", ")} — about ${swaps[i]} filament changes`}
            >
              Plate {i + 1} ({p.pieces.length})
            </button>
          ))}
          <button
            className="primary-button"
            disabled={!!busy}
            onClick={() =>
              save("all", async () => {
                const files: { name: string; data: Uint8Array }[] = [];
                for (let i = 0; i < plates.length; i++) files.push({ name: `${plateName(i)}.3mf`, data: await file(i) });
                return [zipStored(files), "application/zip", `${fileName} - colour bands.zip`];
              })
            }
          >
            All plates (.zip)
          </button>
          {busy && <span className="muted small">Making the file…</span>}
        </div>
        <p className="muted small">
          Filament changes, roughly: {swaps.map((n, i) => `plate ${i + 1} about ${n}`).join(", ")}. Pieces standing at different heights in the
          puzzle are on plates of their own, so every piece on a plate changes colour on the same layers.
          {banded.uncut ? ` ${banded.uncut} ${banded.uncut === 1 ? "piece" : "pieces"} couldn't be split and stay one colour.` : ""}
        </p>
      </>
    );
  }
  if (spec.mode === "full" && coloured.full) {
    const full = coloured.full;
    const plate3mf = async (i: number) => zipDeflated(colour3mfFiles(plateItems(plates[i], full), `${fileName} - plate ${i + 1}`));
    return (
      <>
        <div className="mountain-downloads">
          <span className="small">Full colour, 3MF:</span>
          {plates.map((p, i) => (
            <button key={i} className="text-button" disabled={!!busy} onClick={() => save(`p${i}`, async () => [await plate3mf(i), "model/3mf", `${plateName(i)} - full colour.3mf`])} title={p.pieces.map((x) => x.piece.name).join(", ")}>
              Plate {i + 1} ({p.pieces.length})
            </button>
          ))}
          <button
            className="text-button"
            disabled={!!busy}
            onClick={() =>
              save("all", async () => {
                const files: { name: string; data: Uint8Array }[] = [];
                for (let i = 0; i < plates.length; i++) files.push({ name: `${plateName(i)} - full colour.3mf`, data: await plate3mf(i) });
                return [zipStored(files), "application/zip", `${fileName} - full colour 3MF.zip`];
              })
            }
          >
            All plates (.zip)
          </button>
        </div>
        <div className="mountain-downloads">
          <span className="small">For print services, every piece in one file:</span>
          <button
            className="text-button"
            disabled={!!busy}
            onClick={() =>
              save("obj", async () => {
                const base = fileName;
                const { obj, mtl, png } = colourObjFiles(allItems(plates, full, bedWidth), base);
                return [await zipDeflated([{ name: `${base}.obj`, data: obj }, { name: `${base}.mtl`, data: mtl }, { name: `${base}.png`, data: png }]), "application/zip", `${fileName} - OBJ with texture.zip`];
              })
            }
          >
            OBJ + texture (.zip)
          </button>
          <button
            className="text-button"
            disabled={!!busy}
            onClick={() =>
              save("wrl", async () => [await zipDeflated([{ name: `${fileName}.wrl`, data: colourWrl(allItems(plates, full, bedWidth), fileName) }]), "application/zip", `${fileName} - VRML.zip`])
            }
          >
            VRML (.wrl, zipped)
          </button>
          <button
            className="text-button"
            disabled={!!busy}
            onClick={() => save("one3mf", async () => [await zipDeflated(colour3mfFiles(allItems(plates, full, bedWidth), fileName)), "model/3mf", `${fileName} - full colour.3mf`])}
          >
            3MF (every piece)
          </button>
          {busy && <span className="muted small">Making the file…</span>}
        </div>
        <p className="muted small">
          Sizes are in millimetres (tell the service so for OBJ and VRML). The 3MF has a colour for every corner of every triangle; the OBJ's
          texture gives each tiny triangle one colour; VRML has a colour for every corner.
        </p>
      </>
    );
  }
  return null;
}
