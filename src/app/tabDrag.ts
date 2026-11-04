/** Dragging a Part Studio tab along the tab bar (pure). */

/** How far the pointer must move before a press on a tab becomes a drag (px). */
export const DRAG_START = 6;

/**
 * Where a dragged tab goes (0 = first): after every other tab whose middle
 * the pointer has passed. `middles` are the other tabs' middles, in order.
 */
export function dropIndex(middles: readonly number[], x: number): number {
  return middles.filter((m) => m < x).length;
}
