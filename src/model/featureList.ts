/**
 * The feature list's everyday keys and checks (Onshape's): the arrow keys walk the
 * selection up and down the list, the error count at the top of the list cycles through
 * the features that failed, a newly failed feature is scrolled into view, and the rollback
 * bar can be dragged between rows. Pure: lists of ids in, ids out.
 */
import type { Feature } from "./types";

/**
 * Each id once, where it's first listed. "Group by part" lists a sketch under every part it helped make, so rows can
 * repeat; walking a list with repeats would go round in circles.
 */
export function uniqueIds(order: readonly string[]): string[] {
  return [...new Set(order)];
}

/** The row `dir` steps from `current` in `order` (stopping at the ends); nothing picked = the first (or last) row. */
export function stepRow(rows: readonly string[], current: string | null, dir: 1 | -1): string | null {
  const order = uniqueIds(rows);
  if (!order.length) return null;
  const at = current ? order.indexOf(current) : -1;
  if (at < 0) return dir > 0 ? order[0] : order[order.length - 1];
  return order[Math.max(0, Math.min(order.length - 1, at + dir))];
}

/**
 * ↑ / ↓ in the feature list: the selection moves one row (Shift: grows or shrinks from where it started, as Shift +
 * click does). Returns the rows picked, the one the next Shift step works from (`anchor`) and the one moved to.
 */
export function stepSelection(
  rows: readonly string[],
  anchor: string | null,
  current: string | null,
  dir: 1 | -1,
  extend: boolean,
): { selected: string[]; anchor: string | null; current: string | null } {
  const order = uniqueIds(rows);
  const next = stepRow(order, current, dir);
  if (!next) return { selected: [], anchor: null, current: null };
  if (!extend || !anchor || !order.includes(anchor)) return { selected: [next], anchor: next, current: next };
  const a = order.indexOf(anchor);
  const b = order.indexOf(next);
  return { selected: order.slice(Math.min(a, b), Math.max(a, b) + 1), anchor, current: next };
}

/** The features that failed to build (suppressed ones don't count), in list order. */
export function failingFeatures(features: readonly Feature[], failed: (f: Feature) => boolean): string[] {
  return features.filter((f) => !f.suppressed && failed(f)).map((f) => f.id);
}

/**
 * The next of `ids` after `current` in list order, going round to the first again (`dir` -1: the one before).
 * `current` needn't be one of them: the next one below (or above) it in the list is taken.
 */
export function nextOf(order: readonly string[], ids: readonly string[], current: string | null, dir: 1 | -1 = 1): string | null {
  const listed = order.filter((id) => ids.includes(id));
  if (!listed.length) return null;
  const at = current ? order.indexOf(current) : -1;
  if (at < 0) return dir > 0 ? listed[0] : listed[listed.length - 1];
  if (dir > 0) return listed.find((id) => order.indexOf(id) > at) ?? listed[0];
  return [...listed].reverse().find((id) => order.indexOf(id) < at) ?? listed[listed.length - 1];
}

/** The first of `now` (in its order) that wasn't in `before`: a feature that has just started failing. */
export function firstNew(before: readonly string[], now: readonly string[]): string | null {
  const was = new Set(before);
  return now.find((id) => !was.has(id)) ?? null;
}

/**
 * Where the rollback bar goes when it's dropped just above the row `aboveId` (null: at the end of the list, i.e. no
 * rollback). The bar sits after a feature, so it can't go above the very first one.
 */
export function rollbackDrop(features: readonly Feature[], aboveId: string | null): { to: string | null } | { refused: string } {
  if (aboveId === null) return { to: null };
  const at = features.findIndex((f) => f.id === aboveId);
  if (at < 0) return { to: null };
  if (at === 0) return { refused: "The rollback bar can't go above the first feature." };
  return { to: features[at - 1].id };
}
