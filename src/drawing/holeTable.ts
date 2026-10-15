/**
 * Hole table: each hole seen as a circle on one view gets a tag (A1, A2… one
 * letter per size), and a table on the sheet lists its position from the
 * view's bottom-left corner and its size — handy for drilling by hand or CNC.
 */
import type { ViewProjection } from "../kernel/protocol";
import type { Drawing } from "../model/types";
import { outlinePoints } from "./autoDimension";
import type { Projections } from "./sheet";

type P2 = [number, number];

export interface HoleRow {
  tag: string;
  /** Centre in the view (mm) and from the corner. */
  at: P2;
  x: number;
  y: number;
  diameter: number;
}

const ORDER = ["top", "front", "right", "left", "back", "bottom"];

/** The view the table describes: the first standard view (top first) showing holes as circles. */
export function holeTableView(drawing: Pick<Drawing, "views">, projections: Projections): string | null {
  const shown = new Set(drawing.views.map((v) => v.kind as string));
  return ORDER.find((k) => shown.has(k) && (projections[k]?.circles ?? []).some((c) => c.full && !c.hidden)) ?? null;
}

/** The holes on a view, tagged and measured from its bottom-left corner. */
export function holeRows(p: ViewProjection): HoleRow[] {
  const holes: { at: P2; d: number }[] = [];
  for (const c of p.circles) {
    if (!c.full || c.hidden) continue;
    // Each hole once (a counterbore's two circles share a centre: keep the smaller, the hole itself).
    const same = holes.find((h) => Math.hypot(h.at[0] - c.cx, h.at[1] - c.cy) < 1e-4);
    if (same) same.d = Math.min(same.d, 2 * c.r);
    else holes.push({ at: [c.cx, c.cy], d: 2 * c.r });
  }
  if (!holes.length) return [];
  const pts = outlinePoints(p);
  const [bx, by] = p.bounds ?? [0, 0];
  const corner: P2 = pts.length ? [...pts].sort((a, b) => a[0] + a[1] - (b[0] + b[1]))[0] : [bx, by];
  const sizes = [...new Set(holes.map((h) => Math.round(h.d * 1e4) / 1e4))].sort((a, b) => b - a);
  const rows = holes
    .map((h) => ({ ...h, size: sizes.indexOf(Math.round(h.d * 1e4) / 1e4) }))
    .sort((a, b) => a.size - b.size || a.at[0] - b.at[0] || a.at[1] - b.at[1]);
  const count = new Map<number, number>();
  return rows.map((h) => {
    const n = (count.get(h.size) ?? 0) + 1;
    count.set(h.size, n);
    const letter = String.fromCharCode(65 + (h.size % 26));
    return { tag: `${letter}${n}`, at: h.at, x: h.at[0] - corner[0], y: h.at[1] - corner[1], diameter: h.d };
  });
}
