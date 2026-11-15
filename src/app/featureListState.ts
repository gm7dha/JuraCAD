/**
 * The feature list's own bits of state, shared by its rows and the keyboard shortcuts without touching the main
 * store: which row is being renamed in place (F2), the rows as listed now (folders shut and searches leave some out),
 * and where the next Shift + click or Shift + arrow selection starts from. Session only.
 */
import { useSyncExternalStore } from "react";

import { stepSelection, uniqueIds } from "../model/featureList";
import { clickRow } from "../model/listSelection";
import { pickedFeatures, useStore } from "../model/store";

let renaming: string | null = null;
let shownOrder: string[] = [];
let anchor: string | null = null;
const listeners = new Set<() => void>();

/** Rename this feature's row in place (null: stop). */
export function setRenaming(id: string | null): void {
  if (renaming === id) return;
  renaming = id;
  for (const l of listeners) l();
}

export function useRenaming(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => renaming,
  );
}

/** The feature rows as the list shows them now, top to bottom (set by the list each time it draws). */
export function setShownOrder(order: string[]): void {
  shownOrder = uniqueIds(order);
}

export function shownFeatureOrder(): string[] {
  return shownOrder;
}

/** A click on a feature's row: one row, Ctrl/⌘ + click adds or takes off one, Shift + click a run (listSelection.ts). */
export function clickFeatureRow(id: string, keys: { add: boolean; range: boolean }): void {
  const s = useStore.getState();
  const r = clickRow(shownOrder, pickedFeatures(s), anchor, id, keys);
  anchor = r.anchor;
  // The one clicked stays the main one (unless Ctrl + click just took it off).
  s.selectFeatures(r.selected, r.selected.includes(id) ? id : (r.selected[r.selected.length - 1] ?? null));
}

/** ↑ / ↓ (Shift: grow the selection). True if the key was used. */
export function stepFeatureSelection(dir: 1 | -1, extend: boolean): boolean {
  const s = useStore.getState();
  if (!shownOrder.length) return false;
  const current = s.selectedFeatureId;
  if (!extend || !anchor || !pickedFeatures(s).includes(anchor)) anchor = current;
  const r = stepSelection(shownOrder, anchor, current, dir, extend);
  if (!r.current) return false;
  anchor = r.anchor;
  s.selectFeatures(r.selected, r.current);
  document.querySelector(`.feature-list [data-feature-id="${CSS.escape(r.current)}"]`)?.scrollIntoView({ block: "nearest" });
  return true;
}
