/** Whether the Mountain puzzle window is open, and as which puzzle (session only; the puzzle never goes into the design). */
import { create } from "zustand";

/** "mountain": a real mountain's heights; "photo": a picture's brightness as heights. */
export type PuzzleKind = "mountain" | "photo";

export const useMountain = create<{ open: boolean; kind: PuzzleKind }>(() => ({ open: false, kind: "mountain" }));

export const openMountain = (open = true, kind: PuzzleKind = "mountain") => useMountain.setState(open ? { open, kind } : { open });
