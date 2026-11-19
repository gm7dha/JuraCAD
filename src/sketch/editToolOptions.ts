/**
 * Settings of the newer sketch editing tools (Chamfer, Slot on a curve), kept
 * apart from the sketch session so they're remembered between sketches, as
 * Onshape remembers them. Session only, never in the file.
 */
import { create } from "zustand";

import type { ChamferMode } from "./sketchChamfer";

export interface EditToolOptions {
  chamferMode: ChamferMode;
  chamferDistance: string;
  chamferDistance2: string;
  chamferAngle: string;
  slotWidth: string;
  /** Linear sketch pattern: a second direction (rows × columns), how many along it, how far apart, its angle. */
  pattern2: boolean;
  pattern2Count: number;
  pattern2Spacing: string;
  pattern2Angle: string;
  set: (patch: Partial<Omit<EditToolOptions, "set">>) => void;
}

export const useEditToolOptions = create<EditToolOptions>((set) => ({
  chamferMode: "equal",
  chamferDistance: "2",
  chamferDistance2: "2",
  chamferAngle: "45",
  slotWidth: "5",
  pattern2: false,
  pattern2Count: 2,
  pattern2Spacing: "10",
  pattern2Angle: "90",
  set: (patch) => set(patch),
}));
