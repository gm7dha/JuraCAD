/**
 * Builds a Mountain puzzle off the page's own thread, for "As many pieces as will print well" (which builds several
 * sizes one after another), so the window doesn't freeze while it looks. The maths is src/terrain/mountainPuzzle.ts,
 * unchanged, and the verdict src/terrain/mostPieces.ts.
 */
import type { HeightGrid } from "../terrain/elevation";
import { makeMountainPuzzle, type MountainPuzzle, type MountainSpec } from "../terrain/mountainPuzzle";
import { mountainPrintsWell, type Verdict } from "../terrain/mostPieces";
import type { MapFeatures } from "../terrain/osm";

export interface MountainJob {
  id: number;
  grid: HeightGrid;
  width: number;
  height: number;
  spec: MountainSpec;
  features: MapFeatures;
}

export type MountainReply = { id: number; puzzle: MountainPuzzle; verdict: Verdict } | { id: number; error: string };

const ctx = self as unknown as {
  postMessage(message: MountainReply): void;
  onmessage: ((e: MessageEvent<MountainJob>) => void) | null;
};

ctx.onmessage = (e) => {
  const { id, grid, width, height, spec, features } = e.data;
  try {
    const puzzle = makeMountainPuzzle(grid, width, height, spec, features);
    ctx.postMessage({ id, puzzle, verdict: mountainPrintsWell(puzzle) });
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
