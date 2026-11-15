/**
 * Mass properties open or not, and the density chosen in it (session only, never in the file). A tiny store of its
 * own, like selectOtherState, so the panel and its button share it without touching the main store.
 */
import { useSyncExternalStore } from "react";

export interface MassState {
  open: boolean;
  /** "own" = each part's own material; a material key = that for every part; "custom" = `density`. */
  choice: string;
  density: number;
}

let current: MassState = { open: false, choice: "own", density: 1 };
const listeners = new Set<() => void>();

export function setMassState(change: Partial<MassState>): void {
  current = { ...current, ...change };
  for (const l of listeners) l();
}

export function massStateNow(): MassState {
  return current;
}

export function useMassState(): MassState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
}
