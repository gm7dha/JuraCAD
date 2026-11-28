/**
 * A body's underside (its triangles lying flat on z = 0) as outline loops, for drawing puzzles from above: drawing
 * every triangle as its own sub-path made one canvas path of hundreds of thousands of pieces for a one-piece island,
 * which the browser took over a minute to fill. The loops are its edges used by only one underside triangle, walked
 * the way the triangles go round, so outsides and holes run opposite ways and a "nonzero" fill shows the holes.
 */
import type { Body } from "./mountainPuzzle";

const loopsOf = new WeakMap<Body, Float64Array[]>();

/** Loops of x, y pairs (mm); cached per body. */
export function undersideLoops(b: Body): Float64Array[] {
  const kept = loopsOf.get(b);
  if (kept) return kept;
  const v = b.vertices;
  const t = b.triangles;
  // Corners at the same place are one corner, whatever their numbers (meshes needn't share them).
  // (Places to 0.1 µm, within ±5 m: one number each.)
  const idOf = new Map<number, number>();
  const known = new Int32Array(v.length / 3).fill(-1);
  const xy: number[] = [];
  const corner = (i: number) => {
    if (known[i] >= 0) return known[i];
    const key = (Math.round(v[i * 3] * 1e4) + 5e7) * 1e8 + (Math.round(v[i * 3 + 1] * 1e4) + 5e7);
    let id = idOf.get(key);
    if (id === undefined) {
      id = xy.length / 2;
      idOf.set(key, id);
      xy.push(v[i * 3], v[i * 3 + 1]);
    }
    known[i] = id;
    return id;
  };
  const edges: number[] = [];
  for (let k = 0; k < t.length; k += 3) {
    const [i, j, l] = [t[k], t[k + 1], t[k + 2]];
    if (v[i * 3 + 2] !== 0 || v[j * 3 + 2] !== 0 || v[l * 3 + 2] !== 0) continue;
    const [a, c, d] = [corner(i), corner(j), corner(l)];
    if (a === c || c === d || d === a) continue;
    edges.push(a, c, c, d, d, a);
  }
  const n = xy.length / 2;
  // Each way along each edge, counted: an edge two triangles share runs once each way and cancels out.
  const count = new Map<number, number>();
  for (let k = 0; k < edges.length; k += 2) {
    const key = edges[k] * n + edges[k + 1];
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  const next = new Map<number, number[]>();
  for (const [key, c] of count) {
    const [a, d] = [Math.floor(key / n), key % n];
    const extra = c - (count.get(d * n + a) ?? 0);
    for (let m = 0; m < extra; m++) {
      const list = next.get(a);
      if (list) list.push(d);
      else next.set(a, [d]);
    }
  }
  const loops: Float64Array[] = [];
  for (const start of [...next.keys()]) {
    for (;;) {
      const first = next.get(start);
      if (!first?.length) break;
      const loop: number[] = [];
      let at = start;
      for (;;) {
        const out = next.get(at);
        if (!out?.length) break;
        const to = out.pop()!;
        loop.push(xy[at * 2], xy[at * 2 + 1]);
        at = to;
        if (at === start) break;
      }
      if (loop.length >= 6) loops.push(Float64Array.from(loop));
    }
  }
  loopsOf.set(b, loops);
  return loops;
}
