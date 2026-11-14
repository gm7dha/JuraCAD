/**
 * Whether the library's Map puzzles are unlocked in this browser (`library/puzzleLock.ts` does the checking). Kept in a
 * small store so the library window and the puzzle windows' opener agree; read from the browser's storage at start, and
 * still unlocked for the session when the browser keeps nothing.
 */
import { create } from "zustand";

import { forgetUnlock, passwordHash, puzzlesUnlocked, rememberUnlock } from "../library/puzzleLock";

export const usePuzzleLock = create<{ unlocked: boolean }>(() => ({ unlocked: puzzlesUnlocked() }));

/** Unlocked by typing the password in this tab (kept even when the browser can't store it). */
let typedHere = false;

/** Read the browser's storage again (each time the library opens), so a lock or unlock kept since is seen. */
export function syncPuzzleLock(): void {
  const unlocked = puzzlesUnlocked() || typedHere;
  if (unlocked !== usePuzzleLock.getState().unlocked) usePuzzleLock.setState({ unlocked });
}

/** Whether the Map puzzles may be opened now. */
export const mapPuzzlesUnlocked = () => usePuzzleLock.getState().unlocked;

/** Try a password: true (and unlocked, remembered in this browser) when it's right. */
export async function unlockMapPuzzles(typed: string): Promise<boolean> {
  const hash = await passwordHash(typed);
  if (!hash) return false;
  rememberUnlock(hash);
  typedHere = true;
  usePuzzleLock.setState({ unlocked: true });
  return true;
}

/** Lock them again in this browser. */
export function lockMapPuzzles(): void {
  forgetUnlock();
  typedHere = false;
  usePuzzleLock.setState({ unlocked: false });
}
