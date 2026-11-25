/**
 * "As many pieces as will print well" (the owner's wish), for the Island and Mountain puzzles: the smallest piece size
 * (island) or cube size (mountain) whose puzzle still prints well, found by building it at a few sizes.
 *
 * Pure: `islandPrintsWell` / `mountainPrintsWell` judge a built puzzle by its own counts, and `smallestThatPrints`
 * searches sizes with any builder (the windows give it their worker or the page; tests give it a fake one).
 */
import type { IslandBuilt } from "./islandPuzzle";
import { LEAST_NECK, MIN_JOINTS } from "./islandPuzzle";
import { baseFor, GOOD_NECK, MAX_COLUMNS, mountainChecks, neckFor, smallestCube, type MountainLayout, type MountainPuzzle, type MountainSpec } from "./mountainPuzzle";

/** Whether a puzzle prints well, and if not, why (plain words, finishing "smaller … would …"). */
export interface Verdict {
  ok: boolean;
  why?: string;
}

/** The smallest island piece size the window makes (mm): islandChecks' own lower limit. */
export const ISLAND_FLOOR = 15;
/** Island piece sizes are tried in steps of this (mm). */
export const ISLAND_STEP = 0.5;
/** Mountain cubes are whole millimetres. */
export const CUBE_STEP = 1;
/** At most this many sizes are built in one search: past it, the best size found so far is used. */
export const MOST_TRIES = 10;

/**
 * An island puzzle prints well when no dovetail was left out as too thin to hold, every dovetail's neck is at least
 * `LEAST_NECK`, and every piece with a neighbour has at least `MIN_JOINTS` dovetails (loose islets have nothing to
 * join to, so they don't count). The puzzle's own building already makes every dovetail it keeps catch, and gives
 * away crumbs and slivers; this only reads what it reports.
 */
export function islandPrintsWell(p: Pick<IslandBuilt, "pieces" | "tabs" | "droppedTabs">): Verdict {
  if (!p.pieces.length) return { ok: false, why: "there's no land to cut into pieces" };
  if (p.droppedTabs) return { ok: false, why: "smaller pieces would make some dovetails too thin to hold" };
  if (p.tabs.some((t) => t.neck < LEAST_NECK - 1e-9)) return { ok: false, why: "smaller pieces would make some dovetails too thin to hold" };
  if (p.pieces.some((q) => q.neighbours > 0 && q.joints < MIN_JOINTS)) return { ok: false, why: "smaller pieces would leave some pieces with fewer than two dovetails" };
  return { ok: true };
}

/**
 * A mountain puzzle prints well when its tabs' necks are sturdy (`GOOD_NECK`), every piece above the plate has its
 * key, no two neighbouring keys go into each other's pockets, and no piece is taller than the printer. Pieces with
 * fewer than two dovetails don't count against it: on a peak or a steep face no more are possible at any size.
 */
export function mountainPrintsWell(p: Pick<MountainPuzzle, "spec" | "pieces" | "keyClashes">): Verdict {
  if (neckFor(p.spec.cube, p.spec.fit) < GOOD_NECK - 1e-9) return { ok: false, why: "smaller cubes would make the tabs' necks too thin to be sturdy" };
  if (p.pieces.some((q) => q.layer > 0 && !q.pocket)) return { ok: false, why: "smaller cubes would leave some pieces with no room for a key" };
  if (p.keyClashes) return { ok: false, why: "smaller cubes would let some keys go into the wrong pockets" };
  if (p.pieces.some((q) => q.height > p.spec.bed[2])) return { ok: false, why: "smaller cubes would make pieces taller than the printer" };
  return { ok: true };
}

/**
 * What the layout alone says about a cube size (no building): null when it's within the window's limits, else why a
 * smaller cube won't do. Cheap, so the search asks it before building.
 */
export function mountainLayoutVerdict(spec: MountainSpec, layout: MountainLayout): Verdict | null {
  const { problems } = mountainChecks(spec, layout);
  if (!problems.length) return null;
  if (layout.cols * layout.rows > MAX_COLUMNS) return { ok: false, why: `smaller cubes would make more than ${MAX_COLUMNS} cubes in each layer` };
  if (baseFor(spec) + (layout.high - layout.low) * layout.k * spec.exaggeration > spec.cube * 40) return { ok: false, why: "smaller cubes would make the mountain more than 40 layers tall" };
  if (neckFor(spec.cube, spec.fit) < GOOD_NECK - 1e-9) return { ok: false, why: "smaller cubes would make the tabs' necks too thin to be sturdy" };
  return { ok: false, why: `smaller cubes won't do: ${problems[0].charAt(0).toLowerCase()}${problems[0].slice(1).replace(/\.$/, "")}` };
}

/** The smallest cube worth trying: the first with sturdy necks. */
export const mountainFloor = (fit: number) => smallestCube(fit, GOOD_NECK);

export interface SearchStep {
  size: number;
  ok: boolean;
  why?: string;
}

export interface SearchResult {
  /** The smallest size found that prints well (null: none up to `top`). */
  size: number | null;
  /** Every size built, in the order tried. */
  steps: SearchStep[];
  /** Why the size a step smaller doesn't do (missing when `size` is the floor). */
  why?: string;
  /** The floor itself prints well: smaller isn't offered. */
  atFloor: boolean;
  /** Stopped after `most` tries with the best found so far. */
  capped: boolean;
}

export interface SearchOptions {
  /** Where to start looking from (the size typed): assumed to print well, checked. */
  from: number;
  /** The smallest size allowed. */
  floor: number;
  /** The biggest size allowed. */
  top: number;
  step: number;
  /** Builds and judges a puzzle at a size. */
  test: (size: number) => Promise<Verdict>;
  /** Told after every size tried (for a progress note). */
  onStep?: (steps: SearchStep[]) => void;
  /** At most this many sizes built (default `MOST_TRIES`). */
  most?: number;
  /** Stop as soon as this is true (the settings changed): the search then throws `SearchStopped`. */
  stopped?: () => boolean;
}

export class SearchStopped extends Error {
  constructor() {
    super("stopped");
  }
}

/**
 * The smallest size from `floor` up that prints well, assuming smaller sizes are never better than bigger ones (they
 * nearly always aren't): the floor first (often fine, and then that's it), then from `from` upwards until one prints
 * well, then halving the gap between the biggest that doesn't and the smallest that does down to one step — so the
 * size picked has been built and prints well, and one step smaller has been built and doesn't. Each size is built at
 * most once.
 */
export async function smallestThatPrints(o: SearchOptions): Promise<SearchResult> {
  const most = o.most ?? MOST_TRIES;
  const snap = (v: number) => Math.min(o.top, Math.max(o.floor, o.floor + Math.round((v - o.floor) / o.step) * o.step));
  const tried = new Map<number, Verdict>();
  const steps: SearchStep[] = [];
  let capped = false;
  const test = async (size: number): Promise<Verdict> => {
    const key = Math.round(size * 1000);
    const known = tried.get(key);
    if (known) return known;
    if (o.stopped?.()) throw new SearchStopped();
    const v = await o.test(size);
    if (o.stopped?.()) throw new SearchStopped();
    tried.set(key, v);
    steps.push({ size, ok: v.ok, ...(v.why ? { why: v.why } : {}) });
    o.onStep?.(steps.slice());
    return v;
  };
  const full = () => {
    if (steps.length < most) return false;
    capped = true;
    return true;
  };
  const floor = snap(o.floor);
  const atFloor = await test(floor);
  if (atFloor.ok) return { size: floor, steps, atFloor: true, capped };
  let lo = floor;
  let why = atFloor.why;
  let hi = snap(Math.max(o.from, floor + o.step));
  // Up from where it started until a size prints well.
  for (;;) {
    if (full()) return { size: null, steps, ...(why ? { why } : {}), atFloor: false, capped };
    const v = await test(hi);
    if (v.ok) break;
    lo = hi;
    why = v.why;
    if (hi >= o.top) return { size: null, steps, ...(why ? { why } : {}), atFloor: false, capped };
    hi = snap(Math.max(hi + o.step, hi * 1.5));
  }
  // Halve the gap down to one step.
  while (hi - lo > o.step * 1.001) {
    if (full()) break;
    const mid = snap((lo + hi) / 2);
    if (mid <= lo || mid >= hi) break;
    const v = await test(mid);
    if (v.ok) hi = mid;
    else {
      lo = mid;
      why = v.why;
    }
  }
  return { size: hi, steps, ...(why ? { why } : {}), atFloor: false, capped };
}

/** "15 mm ✗  35 mm ✓  25 mm ✓" — the sizes tried so far, for the window's progress note. */
export function stepsText(steps: SearchStep[]): string {
  return steps.map((s) => `${+s.size.toFixed(1)} mm ${s.ok ? "✓" : "✗"}`).join("  ");
}

/** The note under a found size: why it can't be smaller. */
export function resultText(r: SearchResult, floorWords: string): string {
  if (r.size === null) return `No size up to the biggest prints well${r.why ? ` — ${r.why.replace(/^smaller \w+ would/, "it would")}` : ""}.`;
  if (r.atFloor) return `${floorWords}, and it prints well.`;
  return `${r.capped ? "Stopped looking after " + r.steps.length + " tries: " : ""}${r.why ? r.why.charAt(0).toUpperCase() + r.why.slice(1) : "Smaller doesn't print as well"}.`;
}
