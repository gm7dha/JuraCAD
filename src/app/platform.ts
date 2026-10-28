/**
 * Which kind of computer JuraCAD is running on, so shortcuts can be shown
 * the way that computer's keyboard labels them (⌘ Cmd on a Mac, Ctrl on Windows).
 */
export type Platform = "mac" | "windows";

interface NavigatorLike {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}

/** Mac (including iPad) or Windows-style (Windows, Linux, ChromeOS…). */
export function detectPlatform(nav: NavigatorLike | undefined = globalThis.navigator as NavigatorLike | undefined): Platform {
  if (!nav) return "windows";
  const hint = nav.userAgentData?.platform || nav.platform || nav.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(hint) ? "mac" : "windows";
}

export interface KeyNames {
  /** The main shortcut key: "⌘ Cmd" or "Ctrl". */
  mod: string;
  shift: string;
  /** The key that deletes things. */
  del: string;
}

export function keyNames(p: Platform): KeyNames {
  return p === "mac" ? { mod: "⌘ Cmd", shift: "⇧ Shift", del: "Delete ⌫" } : { mod: "Ctrl", shift: "Shift", del: "Delete" };
}

/** Short label for tooltips, e.g. "⌘Z" or "Ctrl+Z". */
export function shortcut(p: Platform, key: string, opts: { shift?: boolean } = {}): string {
  if (p === "mac") return `${opts.shift ? "⇧" : ""}⌘${key}`;
  return `Ctrl+${opts.shift ? "Shift+" : ""}${key}`;
}

/** Mouse and keyboard help rows for the Help dialog, worded for this kind of computer. */
export function helpRows(p: Platform) {
  const k = keyNames(p);
  const mac = p === "mac";
  const mouse: [string, string][] = [
    ["Orbit", mac ? "Right-drag (trackpad: click with two fingers and drag)" : "Right-drag"],
    ["Pan", `Middle-drag, or ${k.mod} + right-drag`],
    ["Zoom (towards the pointer)", mac ? "Scroll wheel, or two-finger swipe on a trackpad" : "Scroll wheel"],
    ["Select a face, edge or plane", "Click"],
    ["Add to selection", `${k.shift}-click or ${k.mod}-click`],
    ["Jump to a standard view", "Click a face of the view cube"],
    ["Look straight at a plane", "Double-click Top, Front or Right in the feature list"],
  ];
  const keys: [string, string][] = [
    ["F", "Zoom to fit"],
    ["N", "View normal to the selected face or plane"],
    ["P", "Show or hide all planes (Top, Front, Right and your own planes)"],
    [`${k.shift} + 1 / 2`, "Front / back view"],
    [`${k.shift} + 3 / 4`, "Left / right view"],
    [`${k.shift} + 5 / 6`, "Top / bottom view"],
    [`${k.shift} + 7`, "Isometric view"],
    [`${k.mod} + Z`, "Undo"],
    [mac ? `${k.mod} + ${k.shift} + Z  or  ${k.mod} + Y` : `${k.mod} + Y  or  ${k.mod} + ${k.shift} + Z`, "Redo"],
    [mac ? "Return" : "Enter", "Accept the open feature dialog"],
    ["Esc", "Cancel the feature dialog / clear the selection"],
    [k.del, "Delete the highlighted feature"],
    [`${k.mod} + S`, "Save to a .juracad file"],
    [`${k.mod} + ${k.shift} + S`, "Save a copy under a new name"],
    [`${k.mod} + O`, "Open a .juracad file (or drag one onto the window)"],
    [`${k.mod} + D`, "Duplicate the selected parts"],
    ["?", "Show this help"],
    [`${k.shift} + S`, "Start a sketch on the selected plane or flat face"],
    [`${k.shift} + E`, "Extrude a sketch"],
    [`${k.shift} + F`, "Fillet (round) the selected edges"],
  ];
  const sketch: [string, string][] = [
    ["L", "Line (keep clicking to chain lines)"],
    ["R", "Rectangle"],
    ["C", "Circle"],
    ["A", "Arc through three points"],
    ["S", "Slot (two end centres, then the width)"],
    ["G", "Polygon (centre, then a corner)"],
    ["T", "Trim: click a piece of a line or curve to cut it away"],
    ["P", "Point"],
    ["D", "Dimension: click a line or circle (or two things), then where the number goes"],
    ["Q", "Construction: dashed helper lines that aren't part of the solid"],
    ["H / V", "Make the selected lines horizontal / vertical"],
    ["Esc", "Stop the current tool, then clear the selection"],
    [k.del, "Delete the selected sketch items"],
    [`${k.mod} + Z / ${k.mod} + ${mac ? `${k.shift} + Z` : "Y"}`, "Undo / redo inside the sketch"],
    ["Double-click a dimension", "Change its value"],
  ];
  return { mouse, keys, sketch };
}
