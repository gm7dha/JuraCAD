/**
 * Choosing several rows in a list, as in most programs: click picks one,
 * Ctrl (⌘ on a Mac) + click adds or removes one, Shift + click picks
 * everything from the last row clicked, and dragging down (or up) the list
 * picks the rows passed over.
 */

/** The rows from `from` to `to` (either way round), in list order. */
export function rowsBetween(order: string[], from: string, to: string): string[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0) return b >= 0 ? [to] : [];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** The selection after a click on `id`; also returns where the next Shift + click or drag starts from. */
export function clickRow(
  order: string[],
  selected: string[],
  anchor: string | null,
  id: string,
  keys: { add: boolean; range: boolean },
): { selected: string[]; anchor: string } {
  if (keys.range && anchor && order.includes(anchor)) {
    const range = rowsBetween(order, anchor, id);
    // With Ctrl too, the range is added to what's already picked.
    const merged = keys.add ? [...selected, ...range.filter((x) => !selected.includes(x))] : range;
    return { selected: order.filter((x) => merged.includes(x)), anchor };
  }
  if (keys.add) {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    return { selected: order.filter((x) => next.includes(x)), anchor: id };
  }
  return { selected: [id], anchor: id };
}

/** The selection while dragging from `anchor` to `id` (`base` is what was picked before, kept when Ctrl is held). */
export function dragRows(order: string[], base: string[], anchor: string, id: string): string[] {
  const range = rowsBetween(order, anchor, id);
  return order.filter((x) => base.includes(x) || range.includes(x));
}
