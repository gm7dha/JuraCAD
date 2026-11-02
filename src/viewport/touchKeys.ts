/**
 * On-screen stand-ins for the keys a tablet doesn't have: "Add to selection"
 * (what Ctrl/⌘ or Shift-click does) and "No snapping" (what holding Shift does
 * while drawing or dragging). They're switched on and off from the touch bar
 * (src/app/TouchBar.tsx) and stay on until switched off. Everything that reads
 * a modifier key from an event asks through `addHeld` / `shiftHeld` /
 * `additive`, so the buttons and the keys do exactly the same.
 */

export interface TouchKeys {
  /** Clicks add to (or take off) the selection, as with Ctrl/⌘ held. */
  add: boolean;
  /** As if Shift were held: no snapping while drawing; a drawing's dimension number lifts off its line. */
  free: boolean;
}

let keys: TouchKeys = { add: false, free: false };
const listeners = new Set<() => void>();

export function touchKeys(): TouchKeys {
  return keys;
}

export function setTouchKey(key: keyof TouchKeys, on: boolean): void {
  if (keys[key] === on) return;
  keys = { ...keys, [key]: on };
  for (const fn of listeners) fn();
}

export function subscribeTouchKeys(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

type Mods = { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean };

/** Ctrl/⌘ held, or "Add to selection" on. */
export function addHeld(e: Mods): boolean {
  return !!(e.ctrlKey || e.metaKey) || keys.add;
}

/** Shift held, or "No snapping" on. */
export function shiftHeld(e: Mods): boolean {
  return !!e.shiftKey || keys.free;
}

/** Shift, Ctrl or ⌘ held, or "Add to selection" on: a click adds to what's selected. */
export function additive(e: Mods): boolean {
  return !!(e.shiftKey || e.ctrlKey || e.metaKey) || keys.add;
}
