/**
 * The Export for laser panel's own state: whether it's open, what it cuts, and
 * its settings. A laser setting, not part of the design: not saved in the file
 * or undone, it lasts while the page is open.
 */
import { create } from "zustand";

import { DEFAULT_GAP, DEFAULT_SHEET_WIDTH } from "../laser/laser";
import { activeFeatures, useStore } from "../model/store";
import { usePrintPanel } from "./printState";

/** "selection" (faces clicked / parts picked), "all" (every part shown), "sketch:<id>" or "flat:<part id>". */
export type LaserChoice = string;

export interface LaserPanelState {
  open: boolean;
  source: LaserChoice;
  gap: number;
  width: number;
  mirror: boolean;
  /** Flat patterns: bend lines as green scores. */
  bends: boolean;
  /** Sketches: what to do with text, closed shapes and lines that don't close. */
  text: "cut" | "engrave";
  shapes: "cut" | "engrave";
  open_: "cut" | "score";
}

export const useLaserPanel = create<LaserPanelState>(() => ({
  open: false,
  source: "selection",
  gap: DEFAULT_GAP,
  width: DEFAULT_SHEET_WIDTH,
  mirror: false,
  bends: true,
  text: "engrave",
  shapes: "cut",
  open_: "cut",
}));

/** The first choice when the panel opens: a sketch highlighted in the list, else what's selected, else every part. */
export function startingSource(s: ReturnType<typeof useStore.getState>, sketchIds: string[]): LaserChoice {
  if (s.selectedFeatureId && sketchIds.includes(s.selectedFeatureId)) return `sketch:${s.selectedFeatureId}`;
  if (s.selection.some((i) => i.kind === "face") || s.selectedParts.length) return "selection";
  return "all";
}

/** Open or close the panel. It sits where the Section and 3D print panels do, so it closes them. */
export function openLaserPanel(open = !useLaserPanel.getState().open, source?: LaserChoice): void {
  if (open) {
    if (useStore.getState().section) useStore.getState().setSection(null);
    if (usePrintPanel.getState().open) usePrintPanel.setState({ open: false, picking: false });
  }
  useLaserPanel.setState(source ? { open, source } : { open });
}

// A section view or the 3D print panel opening closes this panel; so does leaving the Part Studio.
useStore.subscribe((s, prev) => {
  if (!useLaserPanel.getState().open) return;
  if ((s.section && !prev.section) || s.activeTab !== prev.activeTab) useLaserPanel.setState({ open: false });
});
usePrintPanel.subscribe((s, prev) => {
  if (s.open && !prev.open && useLaserPanel.getState().open) useLaserPanel.setState({ open: false });
});

/** Open the laser panel on a sketch highlighted in the list, else what's selected, else every part; or close it. */
export function toggleLaser(): void {
  if (useLaserPanel.getState().open) return openLaserPanel(false);
  openLaser();
}

/** Open the laser panel (kept as it is when it's open already). */
export function openLaser(): void {
  if (useLaserPanel.getState().open) return;
  const s = useStore.getState();
  openLaserPanel(true, startingSource(s, activeFeatures(s).filter((f) => f.type === "sketch").map((f) => f.id)));
}
