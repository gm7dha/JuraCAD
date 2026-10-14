/** A little surprise in the Help screen: click the Windows / Mac buttons 10 times within 5 seconds. */
export const EGG_CLICKS = 10;
export const EGG_WINDOW_MS = 5000;

/** Add a click (at `now`, ms) to the recent ones; says whether that makes 10 within 5 seconds. */
export function eggClick(recent: number[], now: number): { recent: number[]; found: boolean } {
  const kept = [...recent.filter((t) => now - t < EGG_WINDOW_MS), now];
  return kept.length >= EGG_CLICKS ? { recent: [], found: true } : { recent: kept, found: false };
}
