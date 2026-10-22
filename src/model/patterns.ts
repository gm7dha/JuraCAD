/**
 * Pattern copies by number, so some can be left out ("skipped"), as in
 * Onshape. The original is copy 1; the rest count on along the direction, and
 * a grid counts row by row (the second row starts at `count` + 1).
 */

/** Which copy (1 = the original) is at step `i` along the row, in row `j`. */
export const copyNumber = (i: number, j: number, count: number) => j * count + i + 1;

/** How many copies a pattern makes in all (counting the original). */
export const totalCopies = (count: number, rows = 1) => Math.max(1, Math.round(count)) * Math.max(1, Math.round(rows));

/** The skipped copies written out for the box: "2, 5, 7–9". */
export function formatSkip(skip: number[] | undefined): string {
  if (!skip?.length) return "";
  const sorted = [...new Set(skip)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j - i >= 2 ? `${sorted[i]}–${sorted[j]}` : j > i ? `${sorted[i]}, ${sorted[j]}` : `${sorted[i]}`);
    i = j;
  }
  return parts.join(", ");
}

/**
 * Read what's typed in the Skip box: numbers and ranges separated by commas
 * or spaces ("2, 5", "3-6"). `total` is how many copies there are.
 */
export function parseSkip(text: string, total: number): { skip: number[] } | { error: string } {
  const out = new Set<number>();
  const pieces = text
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  for (const piece of pieces) {
    const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(piece);
    if (!m) return { error: `"${piece}" isn't a copy number. Type numbers like 2, 5 or a range like 3-6.` };
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    if (lo === 1 || lo === 0) return { error: "Copy 1 is the original, so it can't be skipped. Start from 2." };
    if (hi > total) return { error: `There are only ${total} copies (counting the original). Use numbers from 2 to ${total}.` };
    for (let k = lo; k <= hi; k++) out.add(k);
  }
  if (total > 1 && out.size >= total - 1) return { error: "That skips every copy, so the pattern would do nothing. Leave at least one out of the list." };
  return { skip: [...out].sort((x, y) => x - y) };
}

/** True when copy `n` is left out. */
export const isSkipped = (skip: number[] | undefined, n: number) => !!skip?.includes(n);
