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

/** How far (screen pixels) the pointer may move between right-button down and up for it to count as a click. */
export const RIGHT_CLICK_SLOP = 4;

/**
 * Right-clicking a dimension's number flips its arrows; right-dragging pans.
 * Decided when the button comes up (macOS sends its context-menu event as the
 * button goes down, before anyone knows whether it's a drag): `down` is where
 * the right button went down on a dimension's number (null if it wasn't),
 * `up` the button that came up and where. The dimension to flip, or null.
 */
export function rightClickFlip(down: { dimId: string; x: number; y: number } | null, up: { button: number; x: number; y: number }): string | null {
  if (!down || up.button !== 2) return null;
  return Math.hypot(up.x - down.x, up.y - down.y) <= RIGHT_CLICK_SLOP ? down.dimId : null;
}
