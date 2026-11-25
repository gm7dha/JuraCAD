/**
 * 3MF and OBJ imports (Onshape takes both): the file's triangles are read (geometry/meshFiles.ts) and kept in the
 * design as a binary STL, so everything after — caching, Simplify, reducing detailed files, File units and Scale —
 * is the STL path, unchanged. The ImportedFile keeps the original name and `from` ("3mf" / "obj") for the dialog.
 * 3MF numbers are turned into millimetres from the file's own unit; OBJ numbers are taken as millimetres.
 */
import { MeshFileError, read3mf, readObj, type MeshSoup } from "../geometry/meshFiles";
import { writeBinaryStl } from "../geometry/stl";
import { MAX_STL_TRIANGLES } from "./importFile";
import type { ImportedFile } from "./types";

export type MeshFormat = "3mf" | "obj";

/** A 3MF or OBJ file, by its name. */
export function meshFormatOf(fileName: string): MeshFormat | null {
  if (/\.3mf$/i.test(fileName)) return "3mf";
  if (/\.obj$/i.test(fileName)) return "obj";
  return null;
}

export type MeshReadResult =
  | { ok: true; stl: Uint8Array; from: MeshFormat; objects: number; unitMm?: number; skipped?: number }
  | { ok: false; error: string };

const count = (n: number) => n.toLocaleString("en-GB");

/** What a 3MF/OBJ file's ImportedFile keeps besides the STL path's own fields. */
export function meshExtras(mesh: { from: MeshFormat; unitMm?: number }): Pick<ImportedFile, "from" | "unitMm"> {
  return { from: mesh.from, ...(mesh.from === "3mf" && mesh.unitMm && mesh.unitMm !== 1 ? { unitMm: mesh.unitMm } : {}) };
}

/** A 3MF/OBJ file's triangles as binary STL bytes, or why it can't be read (in plain words). */
export async function meshFileToStl(fileName: string, bytes: Uint8Array, from: MeshFormat): Promise<MeshReadResult> {
  const kind = from === "3mf" ? "3MF" : "OBJ";
  if (bytes.length === 0) return { ok: false, error: `${fileName} is empty.` };
  let soup: MeshSoup;
  try {
    soup = from === "3mf" ? await read3mf(bytes) : readObj(new TextDecoder().decode(bytes));
  } catch (e) {
    if (e instanceof MeshFileError) return { ok: false, error: `${fileName} can't be imported: ${e.message}.` };
    return { ok: false, error: `${fileName} can't be imported: it doesn't look like a proper ${kind} file.` };
  }
  const triangles = soup.corners.length / 9;
  if (triangles === 0) return { ok: false, error: `${fileName} has no triangles in it.` };
  if (triangles > MAX_STL_TRIANGLES) {
    return {
      ok: false,
      error: `${fileName} has ${count(triangles)} triangles — too detailed even to reduce (the limit is ${count(MAX_STL_TRIANGLES)}). Try exporting it more coarsely, or as STEP.`,
    };
  }
  if (!soup.corners.every(Number.isFinite)) return { ok: false, error: `${fileName} can't be imported: some of its corners aren't proper numbers.` };
  const order = Uint32Array.from({ length: triangles * 3 }, (_, i) => i);
  const stl = new Uint8Array(writeBinaryStl([{ vertices: soup.corners, triangles: order }], `JuraCAD: ${fileName} (${kind})`.slice(0, 80)));
  return { ok: true, stl, from, objects: soup.objects, ...(soup.unitMm ? { unitMm: soup.unitMm } : {}), ...(soup.skipped ? { skipped: soup.skipped } : {}) };
}
