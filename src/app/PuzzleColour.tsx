/**
 * The "Colour" part of the Island and Mountain puzzle windows: Plain (as before), Colour bands (a filament per band, for
 * an AMS) or Full colour (full-colour printers and services), the bands' colours and heights, and the downloads for the
 * banded and full-colour files. The maths and the files are in src/terrain/colour.ts and colourFiles.ts.
 */
import { useEffect, useState } from "react";
import {
  colourProblems,
  filaments,
  LEAST_BANDS,
  MOST_BANDS,
  previewOfBands,
  previewOfFull,
  SPARE_COLOURS,
  type ColourBand,
  type ColourMode,
  type ColourSpec,
  type HeightScale,
  type MapRaster,
  type PreviewMesh,
  type ColouredMesh,
} from "../terrain/colour";
import { allItems, bandPlateFile, bandPuzzle, colour3mfFiles, colourObjFiles, colourPuzzle, colourWrl, plateItems, plateSwaps, zipDeflated, type BandedPuzzle } from "../terrain/colourFiles";
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

/**
 * The pieces coloured for the choices — worked out a moment after the last change (it takes a second or two on big
 * puzzles) — or null while there's nothing to colour.
 */
export function useColoured(pieces: PuzzlePiece[] | null, spec: ColourSpec, scale: HeightScale | null, map: MapRaster): { coloured: Coloured | null; working: boolean; error: string | null } {
  const [coloured, setColoured] = useState<Coloured | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify([spec, scale]);
  const ok = !!pieces && !!scale && spec.mode !== "plain" && !colourProblems(spec, map.water).length;
  useEffect(() => {
    if (!ok || !pieces || !scale) {
      setColoured(null);
      setWorking(false);
      return;
    }
    setWorking(true);
    const timer = setTimeout(() => {
      try {
        if (spec.mode === "bands") {
          const ctx = { spec, scale, map };
          const banded = bandPuzzle(pieces, ctx);
          const fs = filaments(spec, map.water);
          setColoured({ pieces, key, banded, preview: pieces.map((p) => previewOfBands(banded.parts.get(p) ?? [], fs)) });
        } else {
          const full = colourPuzzle(pieces, { spec, scale, map });
          setColoured({ pieces, key, full, preview: pieces.map((p) => previewOfFull(full.get(p)!)) });
        }
        setError(null);
      } catch (e) {
        setColoured(null);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setWorking(false);
      }
    }, 300);
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
  if (spec.mode === "bands" && coloured.banded) {
    const banded = coloured.banded;
    const ctx = { spec, scale, map };
    const swaps = plateSwaps(plates, banded, spec.layer);
    const file = (i: number) => bandPlateFile(plates[i], `${fileName} - plate ${i + 1}`, banded, ctx);
    return (
      <>
        <div className="mountain-downloads">
          <span className="small">
            {plates.length} {plates.length === 1 ? "plate" : "plates"} in colour bands for Bambu Studio:
          </span>
          {plates.map((p, i) => (
            <button key={i} className="text-button" onClick={() => downloadFile(blobOf(file(i), "model/3mf"), `${plateName(i)}.3mf`)} title={p.pieces.map((x) => x.piece.name).join(", ")}>
              Plate {i + 1} ({p.pieces.length})
            </button>
          ))}
          <button
            className="primary-button"
            onClick={() => downloadFile(blobOf(zipStored(plates.map((_, i) => ({ name: `${plateName(i)}.3mf`, data: file(i) }))), "application/zip"), `${fileName} - colour bands.zip`)}
          >
            All plates (.zip)
          </button>
        </div>
        <p className="muted small">
          Filament changes, roughly (colour changes up the height of each plate): {swaps.map((s, i) => `plate ${i + 1} about ${s}`).join(", ")}.
          {banded.uncut ? ` ${banded.uncut} ${banded.uncut === 1 ? "piece" : "pieces"} couldn't be split and stay one colour.` : ""}
        </p>
      </>
    );
  }
  if (spec.mode === "full" && coloured.full) {
    const full = coloured.full;
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
