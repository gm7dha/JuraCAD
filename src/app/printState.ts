/**
 * The 3D print panel's own state: whether it's open, which way each part
 * lies on the bed, and whether the next face clicked sets that. Which way a
 * part prints is a print setting, not part of the design, so it isn't saved
 * in the file or undone — it lasts while the page is open.
 */
import { create } from "zustand";

import type { Vec3 } from "../model/printCheck";

export interface PrintPanelState {
  open: boolean;
  /** Per part: the direction (model coordinates) that faces the bed. Missing = as modelled (-Z). */
  downs: Record<string, Vec3>;
  /** The next face clicked becomes the bed side of its part. */
  picking: boolean;
}

export const usePrintPanel = create<PrintPanelState>(() => ({ open: false, downs: {}, picking: false }));

export function togglePrintPanel(): void {
  usePrintPanel.setState((s) => ({ open: !s.open, picking: false }));
}

/** Lay a part on the face with this outward direction (or back as modelled with null). */
export function setPartDown(partId: string, down: Vec3 | null): void {
  usePrintPanel.setState((s) => {
    const downs = { ...s.downs };
    if (down) downs[partId] = down;
    else delete downs[partId];
    return { downs, picking: false };
  });
}
