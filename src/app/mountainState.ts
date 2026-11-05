/** Whether the Mountain puzzle window is open (session only; the puzzle never goes into the design). */
import { create } from "zustand";

export const useMountain = create<{ open: boolean }>(() => ({ open: false }));

export const openMountain = (open = true) => useMountain.setState({ open });
