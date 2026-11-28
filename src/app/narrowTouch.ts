/**
 * Whether the page is on a touch screen at most 1400 px wide (an iPad: 1180 sideways, 820 upright; an iPad Pro 12.9": 1366 sideways), where the toolbars
 * show just their icons and the Part Studio's joins its rarer groups (STUDIO_TOUCH_TOOLBAR). Follows the window.
 */
import { useSyncExternalStore } from "react";

export const NARROW_TOUCH = "(pointer: coarse) and (max-width: 1400px)";

const query = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(NARROW_TOUCH) : null);

function subscribe(changed: () => void): () => void {
  const q = query();
  if (!q) return () => undefined;
  q.addEventListener?.("change", changed);
  return () => q.removeEventListener?.("change", changed);
}

export function useNarrowTouch(): boolean {
  return useSyncExternalStore(subscribe, () => !!query()?.matches, () => false);
}
