/**
 * The buffers a worker reply hands over (instead of copying). Each may be
 * listed only once — the same buffer twice makes postMessage fail with a
 * DataCloneError — and empty or already-handed-over ones are left out.
 */
import type { PrintPartResult } from "../model/printCheck";

export function uniqueTransfers(list: readonly Transferable[]): Transferable[] {
  const seen = new Set<Transferable>();
  const out: Transferable[] = [];
  for (const t of list) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (t instanceof ArrayBuffer && t.byteLength === 0) continue;
    out.push(t);
  }
  return out;
}

/** The print check's highlight arrays, to hand over. */
export function printCheckTransfers(results: readonly PrintPartResult[]): Transferable[] {
  return uniqueTransfers(results.flatMap((r) => [r.marks.overhang.buffer, r.marks.bed.buffer, r.marks.thin.buffer, r.marks.small.buffer]));
}
