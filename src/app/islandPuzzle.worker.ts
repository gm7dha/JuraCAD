/**
 * Builds the Island puzzle off the page's own thread, so the window doesn't freeze for the few seconds a big island
 * takes. The maths is src/terrain/islandPuzzle.ts, unchanged; `groundAt` (a function) stays behind.
 */
import type { HeightGrid } from "../terrain/elevation";
import { makeIslandPuzzle, type IslandBuilt, type IslandCuts, type IslandSpec } from "../terrain/islandPuzzle";
import type { MapFeatures } from "../terrain/osm";

export interface IslandJob {
  id: number;
  grid: HeightGrid;
  sw: { e: number; n: number };
  width: number;
  height: number;
  spec: IslandSpec;
  cuts?: IslandCuts;
  features: MapFeatures;
}

export type IslandReply = { id: number; puzzle: IslandBuilt } | { id: number; error: string };

const ctx = self as unknown as {
  postMessage(message: IslandReply): void;
  onmessage: ((e: MessageEvent<IslandJob>) => void) | null;
};

ctx.onmessage = (e) => {
  const { id, grid, sw, width, height, spec, cuts, features } = e.data;
  try {
    // Everything but the function, which can't be sent back.
    const { groundAt: _ground, ...puzzle } = makeIslandPuzzle(grid, sw, width, height, spec, cuts, features);
    void _ground;
    ctx.postMessage({ id, puzzle });
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
