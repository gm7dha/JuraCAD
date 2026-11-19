/**
 * Drag-trim (Onshape's: drag across curves in Trim to trim several at once):
 * every place the pointer's path crosses a curve is trimmed as if clicked
 * there, in the order the path met them. One edit, so one undo step.
 */
import { curveParam, crossings, type CurveParam } from "./curves";
import { distToCurve } from "./hit";
import type { EditResult } from "./ops";
import { trimAt } from "./tools";
import type { SketchData } from "./types";

type P2 = [number, number];

/** The pointer's path as a curve (straight pieces between the places it passed). */
export function pathParam(path: P2[]): CurveParam {
  const n = path.length - 1;
  const piece = (u: number) => Math.max(0, Math.min(n - 1, Math.floor(u)));
  return {
    lo: 0,
    hi: n,
    closed: false,
    at: (u) => {
      const i = piece(u);
      const t = u - i;
      return [path[i][0] + (path[i + 1][0] - path[i][0]) * t, path[i][1] + (path[i + 1][1] - path[i][1]) * t];
    },
    d1: (u) => {
      const i = piece(u);
      return [path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]];
    },
    d2: () => [0, 0],
    samples: path.map((_, i) => i),
  };
}

/** Where the path crosses each curve of the sketch (construction and references too), in the order the path meets them. */
export function strokeCrossings(s: SketchData, path: P2[]): { curveId: string; at: P2; along: number }[] {
  if (path.length < 2) return [];
  const p = pathParam(path);
  const out: { curveId: string; at: P2; along: number }[] = [];
  for (const c of s.curves) {
    for (const x of crossings(curveParam(s, c), p)) out.push({ curveId: c.id, at: x.p, along: x.ub });
  }
  return out.sort((a, b) => a.along - b.along);
}

/**
 * Trim every piece the path crosses. The pieces are found again after each
 * trim (a trimmed curve's id may now be one of two), and places on a piece
 * already cut away are skipped. Nothing crossed = an error to show.
 */
export function trimAlong(s: SketchData, path: P2[]): EditResult & { trimmed: number } {
  const hits = strokeCrossings(s, path);
  if (!hits.length) return { sketch: s, trimmed: 0, error: "Drag across the lines and curves you want to trim away." };
  let d = s;
  let trimmed = 0;
  let problem: string | undefined;
  for (const h of hits) {
    // The curve now lying under that place (on the original, or the piece it became).
    let best: { id: string; gap: number } | null = null;
    for (const c of d.curves) {
      const gap = distToCurve(d, c, h.at[0], h.at[1]);
      if (gap < 1e-5 && (!best || gap < best.gap || c.id === h.curveId)) best = { id: c.id, gap };
      if (best?.id === h.curveId) break;
    }
    if (!best) continue;
    const r = trimAt(d, best.id, { x: h.at[0], y: h.at[1] });
    if (r.error) {
      problem ??= r.error;
      continue;
    }
    d = r.sketch;
    trimmed++;
  }
  if (!trimmed) return { sketch: s, trimmed: 0, error: problem ?? "Nothing there could be trimmed." };
  return { sketch: d, trimmed };
}
