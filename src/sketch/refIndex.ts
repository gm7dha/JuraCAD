/**
 * Finding reference geometry near the pointer quickly. A busy design offers a
 * sketch thousands of edges and points from other sketches and parts; looking
 * at all of them on every pointer move would be slow, so they're put in a grid
 * once (per list, kept while the list is the same) and each move only looks at
 * the few in the cells around the pointer.
 *
 * Results are the references' positions in the list, so their stand-in ids
 * ("ref:<n>") stay the same however few are looked at.
 */
import type { RefEdge } from "./links";

type Box = [number, number, number, number];

/** The box round everything a reference can be snapped to or hovered (its ends, middle, centre, rim and path). */
export function refBox(e: RefEdge): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: [number, number] | undefined, r = 0) => {
    if (!p) return;
    x0 = Math.min(x0, p[0] - r);
    y0 = Math.min(y0, p[1] - r);
    x1 = Math.max(x1, p[0] + r);
    y1 = Math.max(y1, p[1] + r);
  };
  add(e.a);
  add(e.b);
  add(e.mid);
  add(e.centre, e.kind === "circle" || e.kind === "arc" ? e.radius ?? 0 : 0);
  for (const p of e.path ?? []) add(p);
  return [x0, y0, x1, y1];
}

export interface RefIndex {
  /** Positions (in the list) of the references within `r` of (x, y), in list order. */
  near(x: number, y: number, r: number): number[];
}

/** Cells along each side at most. */
const SIDE = 128;
/** A reference spanning more cells than this is kept aside and always checked (big circles, long edges). */
const MAX_CELLS = 64;

const cache = new WeakMap<RefEdge[], RefIndex>();

/** The grid for a list of references (built once per list). */
export function refIndex(refs: RefEdge[]): RefIndex {
  const known = cache.get(refs);
  if (known) return known;
  const boxes = refs.map(refBox);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    if (!b.every(Number.isFinite)) continue;
    x0 = Math.min(x0, b[0]);
    y0 = Math.min(y0, b[1]);
    x1 = Math.max(x1, b[2]);
    y1 = Math.max(y1, b[3]);
  }
  const cell = Math.max((x1 - x0) / SIDE, (y1 - y0) / SIDE, 1e-6);
  const cols = Number.isFinite(x0) ? Math.floor((x1 - x0) / cell) + 1 : 0;
  const rows = Number.isFinite(y0) ? Math.floor((y1 - y0) / cell) + 1 : 0;
  const cells = new Map<number, number[]>();
  const big: number[] = [];
  const col = (x: number) => Math.min(cols - 1, Math.max(0, Math.floor((x - x0) / cell)));
  const row = (y: number) => Math.min(rows - 1, Math.max(0, Math.floor((y - y0) / cell)));
  boxes.forEach((b, i) => {
    if (!b.every(Number.isFinite)) return;
    const [c0, c1, r0, r1] = [col(b[0]), col(b[2]), row(b[1]), row(b[3])];
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_CELLS) {
      big.push(i);
      return;
    }
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const k = r * cols + c;
        const list = cells.get(k);
        if (list) list.push(i);
        else cells.set(k, [i]);
      }
  });
  const stamp = new Uint32Array(refs.length);
  let round = 0;
  const index: RefIndex = {
    near(x, y, r) {
      if (!cols || !rows) return [];
      round++;
      const out: number[] = [];
      const take = (i: number) => {
        if (stamp[i] === round) return;
        stamp[i] = round;
        const b = boxes[i];
        if (x + r >= b[0] && x - r <= b[2] && y + r >= b[1] && y - r <= b[3]) out.push(i);
      };
      big.forEach(take);
      if (x + r >= x0 && x - r <= x1 && y + r >= y0 && y - r <= y1) {
        const [c0, c1, r0, r1] = [col(x - r), col(x + r), row(y - r), row(y + r)];
        for (let rr = r0; rr <= r1; rr++)
          for (let c = c0; c <= c1; c++) {
            const list = cells.get(rr * cols + c);
            if (list) for (const i of list) take(i);
          }
      }
      return out.sort((a, b) => a - b);
    },
  };
  cache.set(refs, index);
  return index;
}
