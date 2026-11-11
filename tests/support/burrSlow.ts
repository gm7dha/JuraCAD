/**
 * The six-piece burr solver as it was first written (src/library/burr.ts before it was made faster), kept so tests can
 * check that today's `disassembly` gives exactly the same answers. Slow: it looks every cube up by name.
 */
import { LENGTH, type Piece, type V3 } from "../../src/library/burr";

const key = (v: V3) => `${v[0]},${v[1]},${v[2]}`;
const DIRS: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export function disassemblySlow(pieces: Piece[], limit = 20000): number | null {
  return solve(pieces, pieces.map(() => [0, 0, 0] as V3), limit, new Map(), true);
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

