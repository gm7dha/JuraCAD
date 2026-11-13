/**
 * The Select other list on show (session only): where it opened and what's in it. A tiny store of its own, so the
 * 3D view can open it and the app can draw it without either knowing the other.
 */
import { useSyncExternalStore } from "react";

import type { OtherChoice } from "./selectOther";

export interface SelectOtherOpen {
  /** Window position (CSS px) it opens at. */
  at: { x: number; y: number };
  choices: OtherChoice[];
  /** Each row's words (same order). */
  labels: string[];
}

let current: SelectOtherOpen | null = null;
const listeners = new Set<() => void>();

export function setSelectOther(next: SelectOtherOpen | null): void {
  current = next;
  for (const l of listeners) l();
}

export function selectOtherNow(): SelectOtherOpen | null {
  return current;
}

export function useSelectOther(): SelectOtherOpen | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}
