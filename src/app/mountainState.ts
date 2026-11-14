/** Whether the Mountain puzzle window is open, and as which puzzle (session only; the puzzle never goes into the design). */
import { create } from "zustand";

import { mapPuzzlesUnlocked } from "./puzzleLockState";

/** "mountain": a real mountain's heights; "photo": a picture's brightness as heights. */
export type PuzzleKind = "mountain" | "photo" | "island";

export const useMountain = create<{ open: boolean; kind: PuzzleKind }>(() => ({ open: false, kind: "mountain" }));

/** Opens (or closes) a puzzle window. They're in the library's locked Map puzzles tab, so nothing opens while it's locked. */
export const openMountain = (open = true, kind: PuzzleKind = "mountain") => {
  if (open && !mapPuzzlesUnlocked()) return;
  useMountain.setState(open ? { open, kind } : { open });
};
