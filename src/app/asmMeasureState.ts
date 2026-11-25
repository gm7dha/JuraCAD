/**
 * Faces, edges and corners clicked on copies in an assembly, for Measure (Onshape measures what's selected): the
 * last click, or two with Shift/Ctrl. Session only, never in the file; a tiny store of its own like massState. Each
 * item's `partId` is the copy's key ("top/inner/part"), its `index` into the copy as shown (cut copies their own).
 * Picks only count while their copy is still selected (see `livePicks`), and the list is let go on a tab change.
 */
import { useSyncExternalStore } from "react";

import { keyWithin } from "../assembly/asmMeasure";
import type { PickTarget } from "../viewport/SceneManager";
import { useStore, type SelectionItem } from "../model/store";

const NONE: SelectionItem[] = [];
let current: SelectionItem[] = NONE;
const listeners = new Set<() => void>();

function set(next: SelectionItem[]): void {
  if (next === current) return;
  current = next.length ? next : NONE;
  for (const l of listeners) l();
}

const same = (a: SelectionItem, b: SelectionItem) => a.partId === b.partId && a.kind === b.kind && a.index === b.index;

/**
 * A click in an assembly (not making a mate or a cut): the face, edge or corner joins the picks (Shift/Ctrl) or
 * replaces them. Returns whether it was already picked — then the click is the old "select / unselect the copy" one.
 */
export function asmMeasureClick(target: PickTarget | null, additive: boolean): boolean {
  if (target?.kind !== "part" || target.whole) {
    if (!additive) set(NONE);
    return false;
  }
  const item = target.item;
  const had = current.some((x) => same(x, item));
  if (additive) set(had ? current.filter((x) => !same(x, item)) : [...current, item].slice(-2));
  else set(had && current.length === 1 ? NONE : [item]);
  return had;
}

export function clearAsmPicks(): void {
  set(NONE);
}

export function asmPicksNow(): SelectionItem[] {
  return current;
}

/** The picks whose copy is still selected (a copy let go from the list takes its picks with it). */
export function livePicks(picks: readonly SelectionItem[], selected: readonly string[]): SelectionItem[] {
  const out = picks.filter((p) => selected.some((id) => keyWithin(p.partId, id)));
  return out.length === picks.length ? (picks as SelectionItem[]) : out;
}

export function useAsmPicks(): SelectionItem[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
}

// A tab change (another assembly, a Part Studio) lets them go.
let lastTab = useStore.getState().activeTab;
useStore.subscribe((s) => {
  if (s.activeTab === lastTab) return;
  lastTab = s.activeTab;
  set(NONE);
});
