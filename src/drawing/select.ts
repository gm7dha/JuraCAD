/**
 * Picking dimensions and notes on a drawing sheet with a box, like Onshape:
 * dragged left to right, only what's wholly inside; right to left, anything
 * the box touches. Sheet mm, y up.
 */
import type { SheetLayout } from "./sheet";

export function itemsInBox(layout: Pick<SheetLayout, "dims" | "notes">, from: [number, number], to: [number, number]): string[] {
  const x0 = Math.min(from[0], to[0]);
  const x1 = Math.max(from[0], to[0]);
  const y0 = Math.min(from[1], to[1]);
  const y1 = Math.max(from[1], to[1]);
  const crossing = to[0] < from[0];
  const inside = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  const ids: string[] = [];
  for (const d of layout.dims) if (inside(d.label[0], d.label[1])) ids.push(d.id);
  for (const n of layout.notes) {
    const [a, b, c, e] = n.box;
    const hit = crossing ? a <= x1 && c >= x0 && b <= y1 && e >= y0 : inside(a, b) && inside(c, e);
    if (hit) ids.push(n.id);
  }
  return ids;
}

/** A selection with `id` added, or taken out if it was already in it. */
export function toggled(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}
