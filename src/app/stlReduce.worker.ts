/** Reduces a detailed STL off the page's own thread (a million triangles take ~20 s), so the window never freezes. */
import { reduceStl } from "../model/importFile";
import type { ImportedFile } from "../model/types";

export type ReduceJob = { fileName: string; bytes: Uint8Array; target: number };
export type ReduceReply = { ok: true; file: ImportedFile } | { ok: false; error: string };

const ctx = self as unknown as { postMessage(message: ReduceReply): void; onmessage: ((e: MessageEvent<ReduceJob>) => void) | null };

ctx.onmessage = (e) => {
  try {
    ctx.postMessage({ ok: true, file: reduceStl(e.data.fileName, e.data.bytes, e.data.target) });
  } catch (err) {
    ctx.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
