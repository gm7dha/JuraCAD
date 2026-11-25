/**
 * The part a new drawing shows when none is picked (pure): the main part of the Part Studio on show — the biggest
 * solid (by volume; the first of equals, so an original beats its pattern copies), not simply the last one made.
 */
export function mainPart(parts: readonly { id: string; volume?: number; surface?: boolean }[]): string | undefined {
  const solids = parts.filter((p) => !p.surface);
  const pool = solids.length ? solids : parts;
  let best: (typeof parts)[number] | undefined;
  for (const p of pool) if (!best || (p.volume ?? 0) > (best.volume ?? 0) * (1 + 1e-9)) best = p;
  return best?.id;
}
