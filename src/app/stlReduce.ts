/**
 * Reducing detailed STL files when they're imported (see model/importFile.ts `reduceStl`), in a worker of its own,
 * and the original files kept in memory for this session only, so the Import dialog can reduce one again to another
 * level of detail without asking for the file. (They're never kept in the design: they're too big.)
 */
import { reduceStl } from "../model/importFile";
import type { ImportedFile } from "../model/types";
import type { ReduceJob, ReduceReply } from "./stlReduce.worker";

/** The originals of the last few reduced files, by file name + triangle count. */
const originals = new Map<string, Uint8Array>();
const KEEP = 2;
const keyOf = (fileName: string, triangles: number) => `${fileName}|${triangles}`;

/** The original bytes of a reduced file, while this session still has them. */
export function originalOf(file: ImportedFile): Uint8Array | undefined {
  return file.reducedFrom ? originals.get(keyOf(file.fileName, file.reducedFrom)) : undefined;
}

function remember(file: ImportedFile, bytes: Uint8Array) {
  if (!file.reducedFrom) return;
  const key = keyOf(file.fileName, file.reducedFrom);
  originals.delete(key);
  originals.set(key, bytes);
  while (originals.size > KEEP) originals.delete(originals.keys().next().value as string);
}

/** The file reduced to about `target` triangles (throws a plain message if it can't be). */
export async function reduceStlFile(fileName: string, bytes: Uint8Array, target: number): Promise<ImportedFile> {
  let file: ImportedFile;
  if (typeof Worker === "undefined") file = reduceStl(fileName, bytes, target);
  else {
    const worker = new Worker(new URL("./stlReduce.worker.ts", import.meta.url), { type: "module", name: "juracad-stl-reduce" });
    try {
      const reply = await new Promise<ReduceReply>((resolve) => {
        worker.onmessage = (e: MessageEvent<ReduceReply>) => resolve(e.data);
        worker.onerror = (e) => resolve({ ok: false, error: `The file couldn't be reduced (${e.message || "the reducer stopped"}).` });
        const job: ReduceJob = { fileName, bytes, target };
        worker.postMessage(job);
      });
      if (!reply.ok) throw new Error(reply.error);
      file = reply.file;
    } finally {
      worker.terminate();
    }
  }
  remember(file, bytes);
  return file;
}
