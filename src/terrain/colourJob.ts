/**
 * The work behind the puzzle windows' colours (pure; run in a worker by src/app/puzzleColour.worker.ts): colour every
 * piece for the choices and make the preview. Cutting the pieces into bands is kept, so a change of colour or name
 * alone (the same band heights and filament numbers) only repaints the preview.
 */
import { bandLevels, filaments, mapRaster, previewOfBands, previewOfFull, type BandPart, type ColouredMesh, type ColourSpec, type HeightScale, type MapRaster, type PreviewMesh, type PuzzleMap } from "./colour";
import { bandPuzzle, colourPuzzle } from "./colourFiles";
import type { Body, PuzzlePiece } from "./mountainPuzzle";

/** What a piece needs for colouring. */
export interface ColourPiece {
  bodies: Body[];
  z0: number;
  height: number;
  /** A column's top piece (the ground on top; only these take the map's colours). */
  top: boolean;
}

export interface ColourJob {
  id: number;
  /** Sent when the pieces are new to the worker. */
  pieces?: ColourPiece[];
  spec: ColourSpec;
  scale: HeightScale;
  map: PuzzleMap;
  mapSize: [number, number];
  /** Changes when the map does (so its grid is drawn once). */
  mapId: number;
}

export type ColourReply =
  | { id: number; mode: "bands"; parts: BandPart[][]; uncut: number; preview: PreviewMesh[] }
  | { id: number; mode: "full"; full: ColouredMesh[]; preview: PreviewMesh[] }
  | { id: number; error: string };

export class ColourCache {
  private pieces: ColourPiece[] = [];
  private map: { id: number; raster: MapRaster } | null = null;
  private bands: { key: string; parts: BandPart[][]; uncut: number } | null = null;
  /** How many times the pieces were cut into bands (for tests). */
  cuts = 0;

  run(job: ColourJob): ColourReply {
    try {
      if (job.pieces) {
        this.pieces = job.pieces;
        this.bands = null;
      }
      if (this.map?.id !== job.mapId) {
        this.map = { id: job.mapId, raster: mapRaster(job.map, job.mapSize[0], job.mapSize[1]) };
        this.bands = null;
      }
      const map = this.map.raster;
      const pieces = this.pieces as PuzzlePiece[];
      if (job.spec.mode === "bands") {
        const fs = filaments(job.spec, map);
        // What the cutting depends on: the levels and their filaments, the layers, and which filament the water is.
        const n = (c: string | null | undefined, on: boolean) => (c && on ? fs.find((f) => f.colour === c.toLowerCase())?.n ?? 0 : 0);
        // Filaments painted on: water, paths, roads.
        const water = [n(job.spec.water, map.water), n(job.spec.paths, map.paths), n(job.spec.roads, map.roads)];
        const key = JSON.stringify([bandLevels(job.spec, job.scale, fs), job.spec.layer, job.spec.firstLayer ?? null, water]);
        if (this.bands?.key !== key) {
          const banded = bandPuzzle(pieces, { spec: job.spec, scale: job.scale, map });
          this.cuts++;
          this.bands = { key, parts: pieces.map((p) => banded.parts.get(p) ?? []), uncut: banded.uncut };
        }
        const { parts, uncut } = this.bands;
        return { id: job.id, mode: "bands", parts, uncut, preview: parts.map((p) => previewOfBands(p, fs)) };
      }
      const full = colourPuzzle(pieces, { spec: job.spec, scale: job.scale, map });
      const meshes = pieces.map((p) => full.get(p)!);
      return { id: job.id, mode: "full", full: meshes, preview: meshes.map(previewOfFull) };
    } catch (e) {
      return { id: job.id, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** The buffers a reply can hand over without copying (the previews and colours, never the kept band parts). */
export function replyTransfers(r: ColourReply): ArrayBuffer[] {
  if ("error" in r) return [];
  const out = new Set<ArrayBuffer>();
  for (const m of r.preview) out.add(m.pos.buffer as ArrayBuffer).add(m.col.buffer as ArrayBuffer);
  if (r.mode === "full") for (const m of r.full) out.add(m.rgb.buffer as ArrayBuffer);
  return [...out];
}
