/**
 * What the open sketch shows (Show constraints / dimensions / expressions — kept in this browser, as Onshape remembers
 * them — and construction hidden by Shift+P, for this session), plus the ids lit up while a relation badge or a
 * dimension is under the pointer. A tiny store of its own, like massState, so the overlay, the panel and the 3D view
 * share it without touching the main store.
 */
import { useSyncExternalStore } from "react";

import { readSketchView, writeSketchView, type SketchViewSettings } from "../sketch/sketchView";

export interface SketchViewState extends SketchViewSettings {
  /** Construction geometry hidden (Shift+P). */
  hideConstruction: boolean;
  /** Points and curves tied by the badge or dimension under the pointer. */
  lit: readonly string[];
}

const NONE: readonly string[] = [];

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

let current: SketchViewState = { ...readSketchView(storage()), hideConstruction: false, lit: NONE };
const listeners = new Set<() => void>();

function set(next: SketchViewState): void {
  current = next;
  for (const l of listeners) l();
}

/** Change what's shown; the three Show settings are kept in this browser. */
export function setSketchView(change: Partial<SketchViewSettings & { hideConstruction: boolean }>): void {
  const next = { ...current, ...change };
  if ("constraints" in change || "dimensions" in change || "expressions" in change) writeSketchView(storage(), next);
  set(next);
}

/** Light up these ids (a badge or dimension under the pointer), or none. */
export function setSketchLit(ids: readonly string[] | null): void {
  const lit = ids && ids.length ? ids : NONE;
  if (lit === current.lit || (lit.length === current.lit.length && lit.every((x, i) => x === current.lit[i]))) return;
  set({ ...current, lit });
}

export function sketchViewNow(): SketchViewState {
  return current;
}

export function useSketchView(): SketchViewState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
}
