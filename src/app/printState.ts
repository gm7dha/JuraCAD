/**
 * The 3D print panel's own state: whether it's open, which way each part
 * lies on the bed, and whether the next face clicked sets that. Which way a
 * part prints is a print setting, not part of the design, so it isn't saved
 * in the file or undone — it lasts while the page is open.
 */
import { create } from "zustand";

import type { Vec3 } from "../model/printCheck";
import { useStore } from "../model/store";

export interface PrintPanelState {
  open: boolean;
  /** Per part: the direction (model coordinates) that faces the bed. Missing = as modelled (-Z). */
  downs: Record<string, Vec3>;
  /** The next face clicked becomes the bed side of its part. */
  picking: boolean;
}

export const usePrintPanel = create<PrintPanelState>(() => ({ open: false, downs: {}, picking: false }));

/**
 * Open or close the panel. It sits where the Section panel does (top right), so opening one closes the other;
 * the Print bed panel (bottom right) can stay open — this one makes room for it.
 */
export function togglePrintPanel(): void {
  const open = !usePrintPanel.getState().open;
  if (open && useStore.getState().section) useStore.getState().setSection(null);
  usePrintPanel.setState({ open, picking: false });
}

// A section view opening closes the panel.
useStore.subscribe((s, prev) => {
  if (s.section && !prev.section && usePrintPanel.getState().open) usePrintPanel.setState({ open: false, picking: false });
});

/** Lay a part on the face with this outward direction (or back as modelled with null). */
export function setPartDown(partId: string, down: Vec3 | null): void {
  usePrintPanel.setState((s) => {
    const downs = { ...s.downs };
    if (down) downs[partId] = down;
    else delete downs[partId];
    return { downs, picking: false };
  });
}
