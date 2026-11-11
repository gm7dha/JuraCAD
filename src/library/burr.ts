/**
 * Six-piece burrs (pure): the classic interlocking puzzle of six square sticks crossing in three pairs. Pieces are made
 * of unit cubes — 2 × 2 × 8 sticks with some cubes cut away where they cross — and a solver checks that a set really
 * comes apart (and so goes together), counting the moves before the first piece comes free (its "level"), as
 * BurrTools does.
 *
 * Assembled, piece 0 and 1 lie along x (side by side in z), 2 and 3 along y (side by side in x), 4 and 5 along z (side
 * by side in y); each is 2 across and 8 long, centred on the origin, so they all meet in the middle 4 × 4 × 4. A cube there
 * covered by two or three pieces can belong to only one (or none: a gap). `makeBurr` picks owners at random (seeded)
 * until the set comes apart at the wanted level.
 */
import { seeded } from "./puzzle";

export type V3 = [number, number, number];
/** A piece: the cubes it has, as the min corners of unit cubes in the assembled puzzle. */
export type Piece = V3[];

export const LENGTH = 8;
const HALF = LENGTH / 2;

/** Which axis each piece lies along (0 x, 1 y, 2 z). */
export const AXIS = [0, 0, 1, 1, 2, 2];

/** Which piece of the pair along `axis` covers a cube, or −1 when that pair doesn't reach it. */
function coverer(axis: number, [x, y, z]: V3): number {
  if (axis === 0) return y === -1 || y === 0 ? (z < 0 ? 0 : 1) : -1;
  if (axis === 1) return z === -1 || z === 0 ? (x < 0 ? 2 : 3) : -1;
  return x === -1 || x === 0 ? (y < 0 ? 4 : 5) : -1;
}

/** Every cube a full (uncut) stick has. */
export function fullStick(i: number): Piece {
  const out: Piece = [];
  const ax = AXIS[i];
  for (let a = -HALF; a < HALF; a++)
    for (let p = -2; p < 2; p++)
      for (let q = -2; q < 2; q++) {
        const v: V3 = ax === 0 ? [a, p, q] : ax === 1 ? [q, a, p] : [p, q, a];
        if (coverer(ax, v) === i) out.push(v);
      }
  return out;
}

const key = (v: V3) => `${v[0]},${v[1]},${v[2]}`;

/** The cubes in the middle that more than one stick covers, with who covers them. */
export function contested(): { at: V3; by: number[] }[] {
  const out: { at: V3; by: number[] }[] = [];
  for (let x = -2; x < 2; x++)
    for (let y = -2; y < 2; y++)
      for (let z = -2; z < 2; z++) {
        const by = [0, 1, 2].map((ax) => coverer(ax, [x, y, z])).filter((i) => i >= 0);
        if (by.length > 1) out.push({ at: [x, y, z], by });
      }
  return out;
}

// The same for every burr, so worked out once: the full sticks, the contested cubes, and per stick which contested cube
// (if any) each of its cubes is.
const STICKS = [0, 1, 2, 3, 4, 5].map(fullStick);
const CONTESTED = contested();
const CONTESTED_AT = STICKS.map((stick) => {
  const at = new Map(CONTESTED.map(({ at }, k) => [key(at), k]));
  return stick.map((v) => at.get(key(v)) ?? -1);
});

/** Pieces from owners of the contested cubes (−1 = a gap); the rest of each stick is its own. */
export function piecesFrom(owners: number[]): Piece[] {
  return STICKS.map((stick, i) => stick.filter((_, j) => CONTESTED_AT[i][j] < 0 || owners[CONTESTED_AT[i][j]] === i).map((v): V3 => [v[0], v[1], v[2]]));
}

/** A cube as one number (any cube within ±500 of the middle). */
const cell = (x: number, y: number, z: number) => ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);

/** Are a piece's cubes all joined face to face? */
export function connected(p: Piece): boolean {
  if (!p.length) return false;
  const set = new Set(p.map((v) => cell(v[0], v[1], v[2])));
  const seen = new Set([cell(p[0][0], p[0][1], p[0][2])]);
  const stack = [p[0]];
  while (stack.length) {
    const [x, y, z] = stack.pop()!;
    for (const d of DIRS) {
      const k = cell(x + d[0], y + d[1], z + d[2]);
      if (set.has(k) && !seen.has(k)) (seen.add(k), stack.push([x + d[0], y + d[1], z + d[2]]));
    }
  }
  return seen.size === p.length;
}

const DIRS: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/**
 * Do these pieces (each moved by its offset) come apart completely? The number of moves before the first group comes
 * free ("level"; a move slides any group of pieces one or more cubes one way), or null if they can't. Each group that
 * comes free must come apart too. Searches at most `limit` positions.
 */
export function disassembly(pieces: Piece[], limit = 20000): number | null {
  const cubes = pieces.map((p) => Int32Array.from(p.flat()));
  if (shapeIds.size > MOST_SHAPES || pairCache.size > MOST_PAIRS || cachedHits > MOST_HITS) (shapeIds.clear(), pairCache.clear(), (cachedHits = 0));
  const shapes = cubes.map((c) => {
    const k = String.fromCharCode.apply(null, Array.from(c, (x) => x + 0x4000));
    let n = shapeIds.get(k);
    if (n === undefined) shapeIds.set(k, (n = shapeIds.size));
    return n;
  });
  // How far each piece's cubes reach from the middle, any way.
  const reach = cubes.map((c) => c.reduce((m, x) => Math.max(m, Math.abs(x), Math.abs(x + 1)), 0));
  return solveFast(cubes, pieces.map((_, i) => i), new Int32Array(3 * pieces.length), limit, new Map(), null, shapes, reach);
}

// Pieces' shapes seen so far, numbered, and how far each pair of shapes slides before meeting at each relative position
// (`pairHits`): the hill-climb in `makeBurr` changes only a few cubes at a time, so most pairs come up again and again.
const shapeIds = new Map<string, number>();
const pairCache = new Map<number, Map<number, Uint8Array>>();
// Both are forgotten together (only as a search starts, so answers never change) once they hold more than MOST_HITS
// results in all, MOST_PAIRS pairs or MOST_SHAPES shapes — or a long-lived tab making burr after burr would keep growing
// (a few hundred bytes per result). Shape numbers stay below SHAPE_SPAN, so a pair of them is one small number.
let cachedHits = 0;
export const MOST_HITS = 300_000;
export const MOST_PAIRS = 100_000;
const MOST_SHAPES = 20000;
const SHAPE_SPAN = 32768;

/** How much the shared cache holds now (for tests: it must stay bounded). */
export function burrCacheSize(): { shapes: number; pairs: number; hits: number } {
  return { shapes: shapeIds.size, pairs: pairCache.size, hits: cachedHits };
}

/** Positions the burr solver has looked at so far (all searches added up): a measure of its work that doesn't depend on the machine. */
let positionsSearched = 0;
/** How many more positions the search under way may look at (`searchWithin`) before it gives up. */
let room = Infinity;
const OUT_OF_ROOM = new Error("The burr search ran out of room");

/**
 * `disassembly`, but giving up ("too long") after looking at `most` positions — a count, not a clock, so the same
 * pieces always give the same answer on any machine. Also says how many positions it looked at.
 */
export function searchWithin(pieces: Piece[], limit: number, most: number): { level: number | null | "too long"; positions: number } {
  const before = positionsSearched;
  room = most;
  try {
    return { level: disassembly(pieces, limit), positions: positionsSearched - before };
  } catch (e) {
    if (e !== OUT_OF_ROOM) throw e;
    return { level: "too long", positions: positionsSearched - before };
  } finally {
    room = Infinity;
  }
}

const FREE_STEPS = 2 * LENGTH + 2;
const NO_HIT = FREE_STEPS + 1;
const NEVER = new Uint8Array(6).fill(NO_HIT);

/**
 * `disassembly`'s search, with the same moves, the same order and the same limit, so it gives exactly the same answers,
 * only faster. Whether a group can slide one way, and how far, depends only on how far each piece in it is from the first
 * piece outside it that it would run into, and that depends only on where the two pieces are relative to each other — so
 * it's worked out once per pair of shapes and relative position (`pairHits`) and reused.
 */
function solveFast(cubes: Int32Array[], ids: number[], start: Int32Array, limit: number, memo: Map<string, boolean>, memoKey: string | null, shapes: number[], reach: number[]): number | null {
  const n = ids.length;
  if (n <= 1) return 0;
  // A position's name: each piece's place relative to the first, one character per number.
  const buf: number[] = new Array(3 * n).fill(0);
  const id = (off: Int32Array) => {
    for (let k = 0; k < 3 * n; k++) buf[k] = off[k] - off[k % 3] + 0x4000;
    return String.fromCharCode.apply(null, buf);
  };
  // The same for `off` with the group in `mask` moved (dx, dy, dz).
  const movedId = (off: Int32Array, mask: number, dx: number, dy: number, dz: number) => {
    for (let k = 0; k < n; k++) {
      const m = k > 0 && mask & (1 << k) ? 1 : 0;
      buf[3 * k] = off[3 * k] - off[0] + m * dx + 0x4000;
      buf[3 * k + 1] = off[3 * k + 1] - off[1] + m * dy + 0x4000;
      buf[3 * k + 2] = off[3 * k + 2] - off[2] + m * dz + 0x4000;
    }
    return String.fromCharCode.apply(null, buf);
  };
  // first[(k * n + j) * 6 + d]: how many cubes piece k slides along DIRS[d] before it first runs into piece j (NO_HIT: not
  // within FREE_STEPS).
  const first = new Uint8Array(n * n * 6);
  // The cache for each pair of pieces here (k < j only: the other way round is the same answer, mirrored).
  const caches: Map<number, Uint8Array>[] = new Array(n * n);
  for (let k = 0; k < n; k++)
    for (let j = k + 1; j < n; j++) {
      const pair = shapes[ids[k]] * SHAPE_SPAN + shapes[ids[j]];
      let cache = pairCache.get(pair);
      if (!cache) pairCache.set(pair, (cache = new Map()));
      caches[k * n + j] = cache;
    }
  const seen = new Set<string>([id(start)]);
  let frontier: Int32Array[] = [start];
  for (let depth = 0; frontier.length && seen.size < limit; depth++) {
    const next: Int32Array[] = [];
    for (const off of frontier) {
      if (room <= 0) throw OUT_OF_ROOM;
      room--;
      positionsSearched++;
      for (let k = 0; k < n; k++)
        for (let j = k + 1; j < n; j++) {
          const h = pairHits(cubes, reach, ids[k], ids[j], off[3 * j] - off[3 * k], off[3 * j + 1] - off[3 * k + 1], off[3 * j + 2] - off[3 * k + 2], caches[k * n + j]);
          for (let d = 0; d < 6; d++) {
            first[(k * n + j) * 6 + d] = h[d];
            first[(j * n + k) * 6 + (d ^ 1)] = h[d];
          }
        }
      for (let mask = 1; mask < 1 << n; mask++) {
        if (mask & 1) continue;
        for (let d = 0; d < 6; d++) {
          // The first step at which the group runs into a piece outside it.
          let stop = NO_HIT;
          for (let k = 0; k < n && stop > 1; k++) {
            if (!(mask & (1 << k))) continue;
            for (let j = 0; j < n; j++) if (!(mask & (1 << j)) && first[(k * n + j) * 6 + d] < stop) stop = first[(k * n + j) * 6 + d];
          }
          if (stop === 1) continue;
          if (stop === NO_HIT) {
            // Free for good: then both groups must come apart in turn.
            const groups: [number[], number[]] = [[], []];
            const offs: [number[], number[]] = [[], []];
            for (let k = 0; k < n; k++) {
              const g = mask & (1 << k) ? 0 : 1;
              groups[g].push(ids[k]);
              offs[g].push(off[3 * k], off[3 * k + 1], off[3 * k + 2]);
            }
            let ok = true;
            for (let g = 0; g < 2 && ok; g++) {
              if (groups[g].length < 2) continue;
              // Each group's answer is kept (`memo`), by which pieces and where they are relative to each other.
              const key = groupKey(groups[g], offs[g]);
              const known = memo.get(key);
              ok = known ?? solveFast(cubes, groups[g], Int32Array.from(offs[g]), limit, memo, key, shapes, reach) !== null;
            }
            if (ok) {
              if (memoKey !== null) memo.set(memoKey, true);
              return depth + 1;
            }
            continue;
          }
          // Slide it on, one cube at a time, as far as it goes.
          const [dx, dy, dz] = DIRS[d];
          for (let s = 1; s <= LENGTH && s < stop; s++) {
            const key = movedId(off, mask, dx * s, dy * s, dz * s);
            if (!seen.has(key)) {
              seen.add(key);
              const moved = off.slice();
              for (let k = 0; k < n; k++)
                if (mask & (1 << k)) (moved[3 * k] += dx * s, moved[3 * k + 1] += dy * s, moved[3 * k + 2] += dz * s);
              next.push(moved);
            }
          }
        }
      }
    }
    frontier = next;
  }
  if (memoKey !== null) memo.set(memoKey, false);
  return null;
}

/** A group's name for `memo`: which pieces (always in order, so a bit each says it), then where each is relative to the first. */
function groupKey(ids: number[], offs: number[]): string {
  let which = 0;
  for (const i of ids) which |= 1 << i;
  const c = [which];
  for (let k = 0; k < offs.length; k++) c.push(offs[k] - offs[k % 3] + 0x4000);
  return String.fromCharCode.apply(null, c);
}

/**
 * How far piece a slides along each of DIRS before it first runs into piece b, with b moved (rx, ry, rz) relative to a
 * (NO_HIT: not within FREE_STEPS). Cached by pieces and relative position.
 */
function pairHits(cubes: Int32Array[], reach: number[], a: number, b: number, rx: number, ry: number, rz: number, cache: Map<number, Uint8Array>): Uint8Array {
  // So far apart along some axis that no cube can meet another within FREE_STEPS, whichever way it slides.
  const apart = reach[a] + reach[b] + FREE_STEPS;
  if (rx > apart || rx < -apart || ry > apart || ry < -apart || rz > apart || rz < -apart) return NEVER;
  const key = ((rx & 255) * 256 + (ry & 255)) * 256 + (rz & 255);
  const far = Math.abs(rx) > 127 || Math.abs(ry) > 127 || Math.abs(rz) > 127;
  if (!far) {
    const known = cache.get(key);
    if (known) return known;
  }
  const out = new Uint8Array(6).fill(NO_HIT);
  const ca = cubes[a];
  const cb = cubes[b];
  for (let i = 0; i < ca.length; i += 3)
    for (let j = 0; j < cb.length; j += 3) {
      // Piece a's cube meets piece b's when moved by (u, v, w).
      const u = cb[j] + rx - ca[i];
      const v = cb[j + 1] + ry - ca[i + 1];
      const w = cb[j + 2] + rz - ca[i + 2];
      let d = -1;
      let s = 0;
      if (v === 0 && w === 0 && u !== 0) (d = u > 0 ? 0 : 1), (s = Math.abs(u));
      else if (u === 0 && w === 0 && v !== 0) (d = v > 0 ? 2 : 3), (s = Math.abs(v));
      else if (u === 0 && v === 0 && w !== 0) (d = w > 0 ? 4 : 5), (s = Math.abs(w));
      if (d >= 0 && s < out[d]) out[d] = s;
    }
  if (!far) (cache.set(key, out), cachedHits++);
  return out;
}

/**
 * Owners changed so every piece is in one piece: while a piece is split, give it back a contested cube that touches its
 * biggest part and another of its parts (taking it from whoever had it), then check the others again. Null if it can't.
 */
export function repaired(owners: number[], rnd: () => number): number[] | null {
  const c = CONTESTED;
  const out = [...owners];
  for (let round = 0; round < 60; round++) {
    const pieces = piecesFrom(out);
    const broken = pieces.findIndex((p) => !connected(p));
    if (broken < 0) return out;
    // The parts of the broken piece.
    const p = pieces[broken];
    const has = new Set(p.map((v) => cell(v[0], v[1], v[2])));
    const part = new Map<number, number>();
    let parts = 0;
    for (const v of p) {
      if (part.has(cell(v[0], v[1], v[2]))) continue;
      const stack = [v];
      part.set(cell(v[0], v[1], v[2]), parts);
      while (stack.length) {
        const [x, y, z] = stack.pop()!;
        for (const d of DIRS) {
          const w = cell(x + d[0], y + d[1], z + d[2]);
          if (!part.has(w) && has.has(w)) (part.set(w, parts), stack.push([x + d[0], y + d[1], z + d[2]]));
        }
      }
      parts++;
    }
    // Contested cubes this piece could have that touch two different parts; or, failing that, any it could have next to
    // it (two steps to join).
    const joins: number[] = [];
    const nextTo: number[] = [];
    c.forEach(({ at, by }, k) => {
      if (!by.includes(broken) || out[k] === broken) return;
      let a = -1;
      let two = false;
      for (const d of DIRS) {
        const n = part.get(cell(at[0] + d[0], at[1] + d[1], at[2] + d[2]));
        if (n === undefined) continue;
        if (a < 0) a = n;
        else if (n !== a) two = true;
      }
      if (two) joins.push(k);
      if (a >= 0) nextTo.push(k);
    });
    const near = joins.length ? joins : nextTo;
    if (!near.length) return null;
    out[near[Math.floor(rnd() * near.length)]] = broken;
  }
  return null;
}

export const DIFFICULTIES: Record<string, { label: string; min: number; max: number }> = {
  easy: { label: "Easy (one piece slides out)", min: 1, max: 1 },
  medium: { label: "Medium (2–3 moves)", min: 2, max: 3 },
  hard: { label: "Hard (4 or more moves)", min: 4, max: 99 },
};

export interface Burr {
  pieces: Piece[];
  /** Moves before the first piece comes free. */
  level: number;
  /** Cubes left empty inside (a "holey" burr has some, to let pieces shuffle). */
  gaps: number;
}

const made = new Map<string, Burr>();
const work = new Map<string, BurrWork>();

/** How much searching making a burr took, counted in positions looked at (see `searchWithin`). */
export interface BurrWork {
  /** Positions looked at, all searches added up. */
  positions: number;
  /** The most any one search looked at. */
  biggest: number;
  /** Searches that gave up (too long). */
  gaveUp: number;
}

/**
 * The searching `makeBurr` may do: each look at whether a set comes apart gives up after `SEARCH_MOST` positions (as if it
 * didn't come apart), and the whole hunt stops at `WORK_MOST`, keeping the best found so far. Seeds 1–100 at every
 * difficulty never needed more than 17,000 positions in one search or 33,000 in all, except hard 39 and 42, which each
 * have one set that takes over ten million to rule out (minutes) — it doesn't come apart, so giving up on it makes the
 * same puzzle. So no seed people may have saved comes out differently; only a seed that needs more could.
 */
export const SEARCH_MOST = 30_000;
export const WORK_MOST = 80_000;

/**
 * A burr from the pattern number (the same number always gives the same burr), at a level in the difficulty's range
 * if one turns up within the search's budget, else the nearest found. Patterns are made by picking an order the pieces
 * come out in and mostly giving each contested cube to the one that leaves first (which always comes apart), some at
 * random and some left empty (`GAP` / `MIXED` — what makes higher levels possible), then making every piece whole
 * (`repaired`); for more than one move it then climbs: change a few cubes, keep the change if the level doesn't drop.
 */
export function makeBurr(seed: number, difficulty: string): Burr {
  const want = DIFFICULTIES[difficulty] ?? DIFFICULTIES.medium;
  const k = `${seed}:${difficulty}`;
  const known = made.get(k);
  if (known) return known;
  const rnd = seeded(seed * 104729 + 7);
  const c = CONTESTED;
  const [gap, mixed] = want.max <= 1 ? [0, 0] : [0.35, 0.3];
  const score = (l: number) => (l < want.min ? l - want.min : l > want.max ? want.max - l : 0);
  const spent: BurrWork = { positions: 0, biggest: 0, gaveUp: 0 };
  const level = (owners: number[]) => {
    const r = searchWithin(piecesFrom(owners), 8000, Math.min(SEARCH_MOST, WORK_MOST - spent.positions));
    spent.positions += r.positions;
    spent.biggest = Math.max(spent.biggest, r.positions);
    if (r.level === "too long") spent.gaveUp++;
    return r.level === "too long" ? null : r.level;
  };
  const working = () => spent.positions < WORK_MOST;
  let best = null as { owners: number[]; level: number } | null;
  const consider = (owners: number[]) => {
    const l = level(owners);
    if (l === null) return;
    if (!best || score(l) > score(best.level) || (score(l) === score(best.level) && l > best.level && l <= want.max)) best = { owners, level: l };
  };
  for (let t = 0; t < 400 && !(best && score(best.level) === 0) && working(); t++) {
    const order = [0, 1, 2, 3, 4, 5].sort(() => rnd() - 0.5);
    const rank = (i: number) => order.indexOf(i);
    const first = (by: number[]) => by.reduce((a, b) => (rank(a) < rank(b) ? a : b));
    const owners = repaired(
      c.map(({ by }) => (rnd() < gap ? -1 : rnd() < mixed ? by[Math.floor(rnd() * by.length)] : first(by))),
      rnd,
    );
    if (owners) consider(owners);
  }
  for (let t = 0; t < 1500 && best && score(best.level) < 0 && working(); t++) {
    const m = [...best.owners];
    for (let n = 1 + Math.floor(rnd() * 3); n > 0; n--) {
      const i = Math.floor(rnd() * c.length);
      m[i] = rnd() < 0.3 ? -1 : c[i].by[Math.floor(rnd() * c[i].by.length)];
    }
    const owners = repaired(m, rnd);
    if (!owners) continue;
    const l = level(owners);
    if (l !== null && l >= best.level) best = { owners, level: l };
  }
  // The search always finds something (taking every cube for the piece that leaves first comes apart in one move).
  const found = best ?? { owners: c.map(({ by }) => by[0]), level: 1 };
  const out: Burr = { pieces: piecesFrom(found.owners), level: found.level, gaps: found.owners.filter((o) => o < 0).length };
  made.set(k, out);
  work.set(k, spent);
  return out;
}

/** How much searching `makeBurr(seed, difficulty)` took (making it first if need be). */
export function burrWork(seed: number, difficulty: string): BurrWork {
  makeBurr(seed, difficulty);
  return work.get(`${seed}:${difficulty}`)!;
}

/** A piece's cross-section axes (across, up) before it's turned: x → (y, z), y → (z, x), z → (x, y). */
export const CROSS: [number, number][] = [
  [1, 2],
  [2, 0],
  [0, 1],
];

/**
 * A piece laid on the bed: its cubes as (along, across, up) in 0…8 × 0…2 × 0…2, turned about its length to whichever of
 * the four ways leaves the fewest cubes hanging over a gap (each a short bridge when printed).
 */
export function laidFlat(p: Piece, axis: number): { cells: V3[]; overhangs: number; turn: number; min: [number, number] } {
  const local = p.map((v): V3 => {
    const a = v[axis] + HALF;
    const [u, w] = [v[CROSS[axis][0]], v[CROSS[axis][1]]];
    return [a, u, w];
  });
  const min1 = Math.min(...local.map((v) => v[1]));
  const min2 = Math.min(...local.map((v) => v[2]));
  const base = local.map(([a, u, w]): V3 => [a, u - min1, w - min2]);
  let best: { cells: V3[]; overhangs: number; turn: number; min: [number, number] } | null = null;
  for (let turn = 0; turn < 4; turn++) {
    const cells = base.map(([a, u, w]): V3 => {
      let [x, y] = [u, w];
      for (let k = 0; k < turn; k++) [x, y] = [1 - y, x];
      return [a, x, y];
    });
    const has = new Set(cells.map(key));
    const overhangs = cells.filter(([a, u, w]) => w === 1 && !has.has(key([a, u, 0]))).length;
    if (!best || overhangs < best.overhangs) best = { cells, overhangs, turn, min: [min1, min2] };
  }
  return best!;
}

/** A move of a group of pieces (indices) `steps` cubes along d; `OUT` steps = taken away for good. */
export type Move = { group: number[]; d: V3; steps: number };
export const OUT = 3 * LENGTH;

/**
 * A complete way apart, as `disassembly` searches (breadth first, so the fewest moves to each split; the same order of
 * groups and directions): the moves of groups, `OUT` steps = taken away for good. Null if it can't (or the search runs
 * out of room).
 */
export function pathApart(pieces: Piece[], ids = pieces.map((_, i) => i), start: V3[] = pieces.map(() => [0, 0, 0])): Move[] | null {
  const n = ids.length;
  if (n < 2) return [];
  const id = (off: V3[]) => off.map((o) => o.join(",")).join("|");
  const parent = new Map<string, { from: string; move: Move } | null>([[id(start), null]]);
  let frontier = [start];
  while (frontier.length && parent.size < 50000) {
    const next: V3[][] = [];
    for (const off of frontier) {
      const occ = new Map<string, number>();
      ids.forEach((g, k) => pieces[g].forEach((v) => occ.set(key([v[0] + off[k][0], v[1] + off[k][1], v[2] + off[k][2]]), k)));
      for (let mask = 2; mask < 1 << n; mask += 2)
        for (const d of DIRS) {
          const blocked = (s: number) => ids.some((g, k) => mask & (1 << k) && pieces[g].some((v) => {
            const o = occ.get(key([v[0] + off[k][0] + d[0] * s, v[1] + off[k][1] + d[1] * s, v[2] + off[k][2] + d[2] * s]));
            return o !== undefined && !(mask & (1 << o));
          }));
          if (blocked(1)) continue;
          const group = ids.filter((_, k) => mask & (1 << k));
          let free = true;
          for (let s = 2; s <= OUT; s++) if (blocked(s)) free = false;
          if (free) {
            const moves: Move[] = [];
            for (let k = id(off); parent.get(k); k = parent.get(k)!.from) moves.unshift(parent.get(k)!.move);
            const inA = ids.map((_, k) => !!(mask & (1 << k)));
            const a = pathApart(pieces, ids.filter((_, k) => inA[k]), off.filter((_, k) => inA[k]));
            const b = pathApart(pieces, ids.filter((_, k) => !inA[k]), off.filter((_, k) => !inA[k]));
            if (a && b) return [...moves, { group, d, steps: OUT }, ...a, ...b];
            continue;
          }
          for (let s = 1; s <= LENGTH && !blocked(s); s++) {
            const moved = off.map((o, k) => (mask & (1 << k) ? ([o[0] + d[0] * s, o[1] + d[1] * s, o[2] + d[2] * s] as V3) : o));
            const k = id(moved);
            if (parent.has(k)) continue;
            parent.set(k, { from: id(off), move: { group, d, steps: s } });
            next.push(moved);
          }
        }
    }
    frontier = next;
  }
  return null;
}

/** Play the moves one cube at a time: does any piece moving hit one it hasn't been taken apart from? */
export function replay(pieces: Piece[], moves: Move[]): boolean {
  const off: V3[] = pieces.map(() => [0, 0, 0]);
  // Which pieces are still together (a group taken away is a world of its own).
  const world = pieces.map(() => 0);
  let worlds = 1;
  for (const m of moves) {
    const w = world[m.group[0]];
    const others = pieces.map((_, i) => i).filter((i) => world[i] === w && !m.group.includes(i));
    const steps = m.steps === OUT ? 2 * LENGTH + 2 : m.steps;
    for (let s = 1; s <= steps; s++) {
      for (const g of m.group) off[g] = [off[g][0] + m.d[0], off[g][1] + m.d[1], off[g][2] + m.d[2]];
      const taken = new Set(others.flatMap((i) => pieces[i].map((v) => key([v[0] + off[i][0], v[1] + off[i][1], v[2] + off[i][2]]))));
      if (m.group.some((g) => pieces[g].some((v) => taken.has(key([v[0] + off[g][0], v[1] + off[g][1], v[2] + off[g][2]]))))) return false;
    }
    if (m.steps === OUT) {
      const fresh = worlds++;
      for (const g of m.group) world[g] = fresh;
    }
  }
  return true;
}
