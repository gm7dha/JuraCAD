/**
 * Sheet metal from an open outline: connected straight lines drawn as the
 * sheet's side view (an L, U or Z shape…), pushed out to a depth. The lines
 * are one face of the metal (the material is on their left, going from the
 * first line to the last; flip by going the other way), and every corner
 * becomes a bend of the sheet's radius.
 *
 * Built as a sheet (see sheet.ts): the first line is the base wall, each
 * later line a flange off the end of the one before, so flanges and the flat
 * pattern work just the same.
 */
import type { SketchData } from "../sketch/types";
import type { FlangeSpec, Frame3, P2, SheetSpec, V3 } from "./sheet";

const SAME = 1e-6;
const near = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < SAME;

/**
 * The sketch's (non-construction) lines joined end to end into one open
 * chain, as points in order; or a plain-English reason they can't be.
 */
export function openChain(data: SketchData): P2[] | string {
  const pos = (id: string): P2 => {
    if (id === "origin") return [0, 0];
    const p = data.points.find((q) => q.id === id);
    return p ? [p.x, p.y] : [NaN, NaN];
  };
  const solid = data.curves.filter((c) => !c.construction);
  if (solid.some((c) => c.type !== "line")) return "An open outline for sheet metal must be straight lines only — the corners between them become the bends.";
  const segs = solid.map((c) => (c.type === "line" ? [pos(c.p1), pos(c.p2)] : null)).filter((s): s is [P2, P2] => !!s && Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]) > SAME);
  if (segs.length === 0) return "Draw the sheet's side view as connected lines (or a closed shape for a flat sheet).";
  // Ends: points only one line touches. A single chain has exactly two.
  const count = (p: P2) => segs.reduce((n, s) => n + (near(s[0], p) ? 1 : 0) + (near(s[1], p) ? 1 : 0), 0);
  const ends = segs.flatMap((s) => s).filter((p) => count(p) === 1);
  if (segs.some((s) => count(s[0]) > 2 || count(s[1]) > 2)) return "The lines branch: an open outline must be one chain of lines, end to end.";
  if (ends.length !== 2) return "The lines must join end to end in one chain, without gaps.";
  const out: P2[] = [ends[0]];
  const left = [...segs];
  while (left.length) {
    const at = out[out.length - 1];
    const i = left.findIndex((s) => near(s[0], at) || near(s[1], at));
    if (i < 0) return "The lines must join end to end in one chain, without gaps.";
    const [s] = left.splice(i, 1);
    out.push(near(s[0], at) ? s[1] : s[0]);
  }
  // Straight-through joins (no turn) aren't bends: merge them.
  const merged: P2[] = [out[0]];
  for (let i = 1; i < out.length - 1; i++) {
    const a = merged[merged.length - 1];
    const b = out[i];
    const c = out[i + 1];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
    if (Math.abs(cross) > 1e-9 * Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1]) || dot < 0) merged.push(b);
  }
  merged.push(out[out.length - 1]);
  return merged;
}

/**
 * The sheet for an open outline (`points` in the sketch plane `frame`),
 * `depth` deep along the sketch's normal. `reverse` puts the material on the
 * other side of the lines.
 */
export function profileSheet(
  frame: Frame3,
  points: P2[],
  opts: { depth: number; thickness: number; radius: number; k: number; reverse?: boolean; idPrefix: string },
): SheetSpec | string {
  const pts = opts.reverse ? [...points].reverse() : points;
  const { thickness: T, radius: R } = opts;
  if (pts.length < 2) return "Draw at least one line.";
  const dirs = pts.slice(1).map((p, i) => {
    const d: P2 = [p[0] - pts[i][0], p[1] - pts[i][1]];
    const l = Math.hypot(d[0], d[1]);
    return { d: [d[0] / l, d[1] / l] as P2, len: l };
  });
  // The turn at each corner: its angle, and left (a bend up, the lines on its outside) or right (down, the lines inside).
  const turns = dirs.slice(1).map((b, i) => {
    const a = dirs[i].d;
    const cross = a[0] * b.d[1] - a[1] * b.d[0];
    const dot = a[0] * b.d[0] + a[1] * b.d[1];
    const angle = Math.atan2(Math.abs(cross), dot);
    const left = cross > 0;
    return { angle, left, setback: (left ? R + T : R) * Math.tan(angle / 2) };
  });
  if (turns.some((t) => t.angle > Math.PI - 1e-3)) return "A corner folds right back on itself (180°). Open it up a little.";
  // The flat length of each line, less the bends at its ends.
  const straight = dirs.map((d, i) => d.len - (i > 0 ? turns[i - 1].setback : 0) - (i < turns.length ? turns[i].setback : 0));
  if (straight.some((s) => s < 0.01)) return "A line in the outline is too short for the bends at its ends. Make it longer, or use a smaller bend radius.";

  // The base wall: the first line, pushed out along the sketch's normal. In its frame u runs along the depth,
  // v along the line, and n (its thickness) to the line's left.
  const [x0, y0] = pts[0];
  const t: V3 = add(mul(frame.u, dirs[0].d[0]), mul(frame.v, dirs[0].d[1]));
  const n = frame.n;
  const left: V3 = cross3(n, t);
  const origin = add(add(frame.origin, mul(frame.u, x0)), mul(frame.v, y0));
  const base: SheetSpec["base"] = {
    frame: { origin, u: n, v: t, n: left },
    outer: [
      { kind: "line", from: [0, 0], to: [opts.depth, 0] },
      { kind: "line", from: [opts.depth, 0], to: [opts.depth, straight[0]] },
      { kind: "line", from: [opts.depth, straight[0]], to: [0, straight[0]] },
      { kind: "line", from: [0, straight[0]], to: [0, 0] },
    ],
    holes: [],
  };
  // Each later line: a flange off the far end (edge 2) of the wall before.
  const flanges: FlangeSpec[] = turns.map((turn, i) => ({
    id: `${opts.idPrefix}:${i + 1}`,
    wall: i === 0 ? "base" : `${opts.idPrefix}:${i}`,
    edge: 2,
    length: 0,
    angle: (turn.angle * 180) / Math.PI,
    down: !turn.left,
    straight: straight[i + 1],
  }));
  return { thickness: T, radius: R, k: opts.k, base, flanges };
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
