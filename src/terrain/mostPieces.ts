/**
 * "As many pieces as will print well" (the owner's wish), for the Island and Mountain puzzles: the smallest piece size
 * (island) or cube size (mountain) whose puzzle still prints well, found by building it at a few sizes.
 *
 * Pure: `islandPrintsWell` / `mountainPrintsWell` judge a built puzzle by its own counts, and `smallestThatPrints`
 * searches sizes with any builder (the windows give it their worker or the page; tests give it a fake one).
 */
import type { IslandBuilt } from "./islandPuzzle";
import { LEAST_NECK, LEAST_PIECE_SIZE, MIN_JOINTS } from "./islandPuzzle";
import { baseFor, GOOD_NECK, MAX_COLUMNS, mountainChecks, neckFor, smallestCube, type MountainLayout, type MountainPuzzle, type MountainSpec } from "./mountainPuzzle";

/** Whether a puzzle prints well, and if not, why (plain words, finishing "smaller … would …"). */
export interface Verdict {
  ok: boolean;
  why?: string;
  /** No other size will do better (the area has no land, say): the search stops here and says `why` as it is. */
  final?: true;
}

/**
 * The smallest island piece size looked at (mm): islandChecks' own lower limit. A dovetail's knob is ~6 mm across
 * whatever the piece size (LEAST_NECK 3.5 + 2 × LEAST_UNDERCUT) and needs ~9.5 mm of border, so below about 12 mm more
 * and more pieces are too small to hold two and join a neighbour: there are FEWER pieces, not more (measured on four
 * coasts and two patterns: the most at 12 mm, ~1.35 × as many as at 15; at 10 mm fewer than at 12, at 8 fewer than at 15).
 */
export const ISLAND_FLOOR = LEAST_PIECE_SIZE;
/** Where the island search starts: the size that gives the most pieces on every coast measured. */
export const ISLAND_START = 12;
/** The island search's first steps (mm), before the last half-millimetre ones. */
export const ISLAND_COARSE = 1;
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
  if (p.pieces.some((q) => q.bodies.some((b) => undersideParts(b) > 1))) return { ok: false, why: "smaller pieces would leave some pieces in bits (a thin strip that wouldn't print)" };
  if (p.droppedTabs) return { ok: false, why: "smaller pieces would make some dovetails too thin to hold" };
  if (p.tabs.some((t) => t.neck < LEAST_NECK - 1e-9)) return { ok: false, why: "smaller pieces would make some dovetails too thin to hold" };
  if (p.pieces.some((q) => q.neighbours > 0 && q.joints < MIN_JOINTS)) return { ok: false, why: "smaller pieces would leave some pieces with fewer than two dovetails" };
  return { ok: true };
}

/**
 * How many separate bits a printed piece's flat underside (its triangles at z = 0) is in, joined only where triangles
 * share an edge: a piece whose mesh came out in two would print as two (or as two joined by a point).
 */
export function undersideParts(b: { vertices: ArrayLike<number>; triangles: ArrayLike<number> }): number {
  const v = b.vertices;
  const t = b.triangles;
  const tris: number[] = [];
  for (let k = 0; k < t.length; k += 3) if (Math.abs(v[t[k] * 3 + 2]) < 1e-9 && Math.abs(v[t[k + 1] * 3 + 2]) < 1e-9 && Math.abs(v[t[k + 2] * 3 + 2]) < 1e-9) tris.push(k);
  const up = tris.map((_, i) => i);
  const find = (a: number): number => {
    while (up[a] !== a) a = up[a] = up[up[a]];
    return a;
  };
  const at = (i: number) => `${v[i * 3].toFixed(6)},${v[i * 3 + 1].toFixed(6)}`;
  const edges = new Map<string, number>();
  tris.forEach((k, n) => {
    for (let e = 0; e < 3; e++) {
      const [p, q] = [at(t[k + e]), at(t[k + ((e + 1) % 3)])];
      const key = p < q ? `${p}|${q}` : `${q}|${p}`;
      const m = edges.get(key);
      if (m === undefined) edges.set(key, n);
      else up[find(m)] = find(n);
    }
  });
  let parts = 0;
  for (let i = 0; i < up.length; i++) if (find(i) === i) parts++;
  return parts;
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
  /** How many pieces it made (the island search, which goes by the count). */
  pieces?: number;
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
  /** Stopped by a problem no size gets round: `why` is said as it is. */
  final?: true;
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
  /**
   * Sizes below the one found that are built too, in case a smaller one prints well after all (a failure isn't always
   * a sign that everything smaller fails): the smallest that does is taken and the look below repeated (default 2).
   */
  lookBelow?: number;
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
  // A couple of sizes further down, in case smaller prints well after all: the smallest that does is taken, and the
  // look below repeated from there.
  const below = o.lookBelow ?? 2;
  const keyOf = (v: number) => Math.round(v * 1000);
  for (let moved = true; moved && hi > floor; ) {
    moved = false;
    for (let k = 1; k <= below + 1; k++) {
      const s = snap(hi - k * o.step);
      if (s >= hi) break;
      const known = tried.get(keyOf(s));
      if (!known && full()) break;
      const v = known ?? (await test(s));
      if (v.ok) {
        hi = s;
        moved = true;
        break;
      }
      if (s <= floor) break;
    }
  }
  if (hi <= floor) return { size: floor, steps, atFloor: true, capped };
  const under = tried.get(keyOf(snap(hi - o.step)));
  if (under && !under.ok && under.why) why = under.why;
  return { size: hi, steps, ...(why ? { why } : {}), atFloor: false, capped };
}

/** A built puzzle's verdict and how many pieces it has. */
export interface CountedVerdict extends Verdict {
  pieces: number;
}

export interface MostOptions {
  /** The size tried first (the usual best). */
  start: number;
  floor: number;
  top: number;
  /** Steps while climbing, then one round of `step` either side of the best. */
  coarse: number;
  step: number;
  test: (size: number) => Promise<CountedVerdict>;
  onStep?: (steps: SearchStep[]) => void;
  most?: number;
  stopped?: () => boolean;
}

/** Why smaller pieces don't give more (the island's result note). */
export const SMALLER_JOIN_UP = "smaller pieces are too small to hold two dovetails each, so more of them join a neighbour and there'd be fewer in all";

/**
 * The island's search: the size that gives the MOST pieces among sizes that print well. Smaller isn't always more —
 * below about 12 mm pieces join their neighbours (see ISLAND_FLOOR) — so it climbs from `start` in `coarse` steps
 * towards more pieces (both ways from where it is, never stopping at a size that doesn't print well while there's
 * room to look), then tries one `step` either side of the best. Ties go to the bigger size (the same pieces, sturdier).
 */
export async function mostPiecesSize(o: MostOptions): Promise<SearchResult> {
  const most = o.most ?? MOST_TRIES;
  const snap = (v: number) => Math.min(o.top, Math.max(o.floor, o.floor + Math.round((v - o.floor) / o.step) * o.step));
  const keyOf = (v: number) => Math.round(v * 1000);
  const tried = new Map<number, CountedVerdict>();
  const steps: SearchStep[] = [];
  let capped = false;
  // Set by `test` (a cast, so the checks after its awaits aren't narrowed to null).
  let final = null as CountedVerdict | null;
  const test = async (raw: number): Promise<CountedVerdict | null> => {
    const size = snap(raw);
    const known = tried.get(keyOf(size));
    if (known) return known;
    if (steps.length >= most) {
      capped = true;
      return null;
    }
    if (o.stopped?.()) throw new SearchStopped();
    const v = await o.test(size);
    if (o.stopped?.()) throw new SearchStopped();
    tried.set(keyOf(size), v);
    steps.push({ size, ok: v.ok, ...(v.why ? { why: v.why } : {}), pieces: v.pieces });
    o.onStep?.(steps.slice());
    if (v.final) final = v;
    return v;
  };
  const best = (): number | null => {
    let b: number | null = null;
    for (const [k, v] of tried) {
      if (!v.ok) continue;
      if (b === null || v.pieces > tried.get(b)!.pieces || (v.pieces === tried.get(b)!.pieces && k > b)) b = k;
    }
    return b === null ? null : b / 1000;
  };
  let centre = snap(o.start);
  for (;;) {
    for (const s of [centre, centre - o.coarse, centre + o.coarse]) if (!final && s >= o.floor - 1e-9 && s <= o.top + 1e-9) await test(s);
    if (final) {
      const f = final;
      return { size: null, steps, ...(f.why ? { why: f.why } : {}), atFloor: false, capped, final: true };
    }
    if (capped) break;
    const b = best();
    if (b === null) {
      // Nothing prints well yet: further up.
      if (centre >= o.top) break;
      centre = snap(centre + 2 * o.coarse);
      continue;
    }
    if (b === centre) break;
    centre = b;
  }
  const b = best();
  if (b !== null && !capped) for (const s of [b - o.step, b + o.step]) if (s >= o.floor - 1e-9 && s <= o.top + 1e-9) await test(s);
  const size = best();
  if (size === null) {
    const last = steps[steps.length - 1];
    return { size: null, steps, ...(last?.why ? { why: last.why } : {}), atFloor: false, capped };
  }
  // Why not smaller: the nearest smaller size tried.
  const smaller = [...tried.entries()].filter(([k]) => k < keyOf(size)).sort((a, z) => z[0] - a[0])[0]?.[1];
  const why = smaller ? (smaller.ok ? SMALLER_JOIN_UP : smaller.why) : undefined;
  const atFloor = size <= o.floor + 1e-9;
  return { size, steps, ...(why && !atFloor ? { why } : {}), atFloor, capped };
}

/** "15 mm ✗  35 mm ✓  25 mm ✓" (with pieces: "12 mm ✓ 129") — the sizes tried so far, for the window's progress note. */
export function stepsText(steps: SearchStep[]): string {
  return steps.map((s) => `${+s.size.toFixed(1)} mm ${s.ok ? "✓" : "✗"}${s.pieces !== undefined && s.ok ? ` ${s.pieces}` : ""}`).join("  ");
}

/** The note under a found size: why it can't be smaller. */
export function resultText(r: SearchResult, floorWords: string): string {
  if (r.final) return r.why ?? "";
  if (r.size === null) return `No size up to the biggest prints well${r.why ? ` — ${r.why.replace(/^smaller \w+ would/, "it would")}` : ""}.`;
  if (r.atFloor) return `${floorWords}, and it prints well.`;
  return `${r.capped ? "Stopped looking after " + r.steps.length + " tries: " : ""}${r.why ? r.why.charAt(0).toUpperCase() + r.why.slice(1) : "Smaller doesn't print as well"}.`;
}
