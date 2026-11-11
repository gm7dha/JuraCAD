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

/** Pieces from owners of the contested cubes (−1 = a gap); the rest of each stick is its own. */
export function piecesFrom(owners: number[]): Piece[] {
  const c = contested();
  const drop = new Set<string>();
  c.forEach(({ at, by }, k) => by.forEach((i) => i !== owners[k] && drop.add(`${i}:${key(at)}`)));
  return [0, 1, 2, 3, 4, 5].map((i) => fullStick(i).filter((v) => !drop.has(`${i}:${key(v)}`)));
}

/** Are a piece's cubes all joined face to face? */
export function connected(p: Piece): boolean {
  if (!p.length) return false;
  const set = new Set(p.map(key));
  const seen = new Set([key(p[0])]);
  const stack = [p[0]];
  while (stack.length) {
    const [x, y, z] = stack.pop()!;
    for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const k = key([x + d[0], y + d[1], z + d[2]]);
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
  const memo = new Map<string, boolean>();
  const level = solve(pieces, pieces.map(() => [0, 0, 0] as V3), limit, memo, true);
  return level;
}

function solve(pieces: Piece[], start: V3[], limit: number, memo: Map<string, boolean>, top: boolean): number | null {
  const n = pieces.length;
  if (n <= 1) return 0;
  const norm = (off: V3[]) => off.map((o) => [o[0] - off[0][0], o[1] - off[0][1], o[2] - off[0][2]] as V3);
  const id = (off: V3[]) => norm(off).map(key).join("|");
  const memoKey = (off: V3[]) => pieces.map((p) => p.map(key).join(";")).join("/") + "@" + id(off);
  if (!top) {
    const m = memo.get(memoKey(start));
    if (m !== undefined) return m ? 0 : null;
  }
  const seen = new Map<string, number>([[id(start), 0]]);
  let frontier: V3[][] = [start];
  for (let depth = 0; frontier.length && seen.size < limit; depth++) {
    const next: V3[][] = [];
    for (const off of frontier) {
      const occ = new Map<string, number>();
      pieces.forEach((p, i) => p.forEach(([x, y, z]) => occ.set(key([x + off[i][0], y + off[i][1], z + off[i][2]]), i)));
      // Any group (not all, and — as moving a group is the same as moving the rest the other way — always without piece 0).
      for (let mask = 1; mask < 1 << n; mask++) {
        if (mask & 1) continue;
        for (const d of DIRS) {
          const blocked = (steps: number) => {
            for (let i = 0; i < n; i++) {
              if (!(mask & (1 << i))) continue;
              for (const [x, y, z] of pieces[i]) {
                const o = occ.get(key([x + off[i][0] + d[0] * steps, y + off[i][1] + d[1] * steps, z + off[i][2] + d[2] * steps]));
                if (o !== undefined && !(mask & (1 << o))) return true;
              }
            }
            return false;
          };
          if (blocked(1)) continue;
          // Free for good? Then both groups must come apart in turn.
          let free = true;
          for (let s = 2; s <= 2 * LENGTH + 2; s++) if (blocked(s)) (free = false);
          if (free) {
            const a = [...Array(n).keys()].filter((i) => mask & (1 << i));
            const b = [...Array(n).keys()].filter((i) => !(mask & (1 << i)));
            const ok = [a, b].every((g) => g.length < 2 || solve(g.map((i) => pieces[i]), g.map((i) => off[i]), limit, memo, false) !== null);
            if (ok) {
              if (!top) memo.set(memoKey(start), true);
              return depth + 1;
            }
            continue;
          }
          // Slide it on, one cube at a time, as far as it goes.
          for (let s = 1; s <= LENGTH && !blocked(s); s++) {
            const moved = off.map((o, i) => (mask & (1 << i) ? ([o[0] + d[0] * s, o[1] + d[1] * s, o[2] + d[2] * s] as V3) : o));
            const k = id(moved);
            if (!seen.has(k)) {
              seen.set(k, depth + 1);
              next.push(moved);
            }
          }
        }
      }
    }
    frontier = next;
  }
  if (!top) memo.set(memoKey(start), false);
  return null;
}

/**
 * Owners changed so every piece is in one piece: while a piece is split, give it back a contested cube that touches its
 * biggest part and another of its parts (taking it from whoever had it), then check the others again. Null if it can't.
 */
export function repaired(owners: number[], rnd: () => number): number[] | null {
  const c = contested();
  const out = [...owners];
  for (let round = 0; round < 60; round++) {
    const pieces = piecesFrom(out);
    const broken = pieces.findIndex((p) => !connected(p));
    if (broken < 0) return out;
    // The parts of the broken piece.
    const p = pieces[broken];
    const part = new Map<string, number>();
    let parts = 0;
    for (const v of p) {
      if (part.has(key(v))) continue;
      const stack = [v];
      part.set(key(v), parts);
      while (stack.length) {
        const [x, y, z] = stack.pop()!;
        for (const d of DIRS) {
          const w: V3 = [x + d[0], y + d[1], z + d[2]];
          if (!part.has(key(w)) && p.some((u) => key(u) === key(w))) (part.set(key(w), parts), stack.push(w));
        }
      }
      parts++;
    }
    // Contested cubes this piece could have that touch two different parts.
    const joins = c
      .map((x, k) => ({ ...x, k }))
      .filter(({ by, k }) => by.includes(broken) && out[k] !== broken)
      .filter(({ at }) => new Set(DIRS.map((d) => part.get(key([at[0] + d[0], at[1] + d[1], at[2] + d[2]]))).filter((n) => n !== undefined)).size >= 2);
    // Or, failing that, any it could have next to it (two steps to join).
    const near = joins.length ? joins : c.map((x, k) => ({ ...x, k })).filter(({ at, by, k }) => by.includes(broken) && out[k] !== broken && DIRS.some((d) => part.has(key([at[0] + d[0], at[1] + d[1], at[2] + d[2]]))));
    if (!near.length) return null;
    out[near[Math.floor(rnd() * near.length)].k] = broken;
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
  const c = contested();
  const [gap, mixed] = want.max <= 1 ? [0, 0] : [0.35, 0.3];
  const score = (l: number) => (l < want.min ? l - want.min : l > want.max ? want.max - l : 0);
  let best = null as { owners: number[]; level: number } | null;
  const consider = (owners: number[]) => {
    const level = disassembly(piecesFrom(owners), 8000);
    if (level === null) return;
    if (!best || score(level) > score(best.level) || (score(level) === score(best.level) && level > best.level && level <= want.max)) best = { owners, level };
  };
  for (let t = 0; t < 400 && !(best && score(best.level) === 0); t++) {
    const order = [0, 1, 2, 3, 4, 5].sort(() => rnd() - 0.5);
    const rank = (i: number) => order.indexOf(i);
    const first = (by: number[]) => by.reduce((a, b) => (rank(a) < rank(b) ? a : b));
    const owners = repaired(
      c.map(({ by }) => (rnd() < gap ? -1 : rnd() < mixed ? by[Math.floor(rnd() * by.length)] : first(by))),
      rnd,
    );
    if (owners) consider(owners);
  }
  for (let t = 0; t < 1500 && best && score(best.level) < 0; t++) {
    const m = [...best.owners];
    for (let n = 1 + Math.floor(rnd() * 3); n > 0; n--) {
      const i = Math.floor(rnd() * c.length);
      m[i] = rnd() < 0.3 ? -1 : c[i].by[Math.floor(rnd() * c[i].by.length)];
    }
    const owners = repaired(m, rnd);
    if (!owners) continue;
    const level = disassembly(piecesFrom(owners), 8000);
    if (level !== null && level >= best.level) best = { owners, level };
  }
  // The search always finds something (taking every cube for the piece that leaves first comes apart in one move).
  const found = best ?? { owners: c.map(({ by }) => by[0]), level: 1 };
  const out: Burr = { pieces: piecesFrom(found.owners), level: found.level, gaps: found.owners.filter((o) => o < 0).length };
  made.set(k, out);
  return out;
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
