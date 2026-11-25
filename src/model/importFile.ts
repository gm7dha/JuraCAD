/**
 * Bringing STEP and STL files from other programs into a design. The file is
 * kept inside the design (so it saves, undoes and reopens like everything
 * else); the geometry engine turns it into a part on each rebuild.
 */
import { decimate, weldCorners } from "../geometry/decimate";
import { readStlCorners, writeBinaryStl } from "../geometry/stl";
import type { ImportedFile } from "./types";

/** Bigger files make the design slow to save and rebuild. */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
/**
 * STL triangles become faces of a solid; past this it gets too slow to work with (and OpenCascade runs out of room:
 * 50,000 take ~40 s and ~3.5 GB, 100,000 don't fit at all). More detailed files are reduced to this or fewer first.
 */
export const SOLID_STL_TRIANGLES = 50_000;
/** The most triangles an STL may have at all (it's reduced first; a million take about 20 s). */
export const MAX_STL_TRIANGLES = 2_000_000;
/** The biggest STL that can be read to be reduced (it isn't kept in the design: only the reduced one is). */
export const MAX_STL_BYTES = 250 * 1024 * 1024;
/** How many triangles a big STL may be reduced to: less detail (quicker) … the most a solid can have. */
export const REDUCE_CHOICES = [10_000, 25_000, SOLID_STL_TRIANGLES] as const;
/** The usual choice: detailed enough for most models, and quick to work with. */
export const USUAL_REDUCE = 25_000;

export const IMPORT_ACCEPT = ".step,.stp,.stl,.3mf,.obj";

/** Bytes → base64, in chunks so large files don't overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let text = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) text += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(text);
}

export function fromBase64(b64: string): Uint8Array {
  const text = atob(b64);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** What kind of model file this is, from its contents (falling back to the name). */
export function detectFormat(fileName: string, bytes: Uint8Array): "step" | "stl" | null {
  const head = new TextDecoder().decode(bytes.subarray(0, 200)).trimStart();
  if (/^ISO-10303-21/.test(head)) return "step";
  if (/\.(step|stp)$/i.test(fileName)) return "step";
  if (/^solid\s/i.test(head) || /\.stl$/i.test(fileName)) return "stl";
  // Binary STL: an 80-byte header, then a triangle count that matches the size.
  if (bytes.length >= 84 && stlTriangleCount(bytes) !== null) return "stl";
  return null;
}

/** Triangle count of a binary STL whose size matches exactly, else null. */
function stlTriangleCount(bytes: Uint8Array): number | null {
  if (bytes.length < 84) return null;
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
  return bytes.length === 84 + n * 50 ? n : null;
}

/** How many triangles an STL holds (binary or text). */
export function countStlTriangles(bytes: Uint8Array): number {
  const binary = stlTriangleCount(bytes);
  if (binary !== null) return binary;
  const text = new TextDecoder().decode(bytes);
  return (text.match(/\bfacet\b/gi) ?? []).length;
}

/** "Bracket v2.step" → "Bracket v2". */
export function importName(fileName: string): string {
  return fileName.replace(/\.(step|stp|stl|3mf|obj)$/i, "").trim() || "Imported part";
}

export type ImportReadResult =
  | { ok: true; file: ImportedFile }
  | { ok: false; error: string }
  /** An STL with more triangles than a solid can have: it's reduced (see `reduceStl`) before it's brought in. */
  | { ok: "reduce"; fileName: string; triangles: number };

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
const count = (n: number) => n.toLocaleString("en-GB");

/**
 * Check a file's bytes and package them for the design, or explain in plain words why not. `from`: the bytes are a
 * 3MF/OBJ file's triangles already turned into a binary STL (model/meshImport.ts), kept with the original's name.
 */
export function readImport(fileName: string, bytes: Uint8Array, from?: "3mf" | "obj"): ImportReadResult {
  if (bytes.length === 0) return { ok: false, error: `${fileName} is empty.` };
  const format = from ? "stl" : detectFormat(fileName, bytes);
  // STL files too big to keep may still be reduced (only the reduced one is kept), so they're allowed bigger.
  if (bytes.length > (format === "stl" ? MAX_STL_BYTES : MAX_IMPORT_BYTES)) {
    const most = format === "stl" ? MAX_STL_BYTES : MAX_IMPORT_BYTES;
    return { ok: false, error: `${fileName} is ${mb(bytes.length)} — JuraCAD can import ${format === "stl" ? "STL files" : "files"} up to ${mb(most)}.` };
  }
  if (!format) return { ok: false, error: `${fileName} isn't a STEP, STL, 3MF or OBJ file, so it can't be imported.` };
  if (format === "step") {
    return { ok: true, file: { fileName, format, data: new TextDecoder().decode(bytes), units: "mm" } };
  }
  const triangles = countStlTriangles(bytes);
  if (triangles === 0) return { ok: false, error: `${fileName} has no triangles in it.` };
  if (triangles > MAX_STL_TRIANGLES) {
    return {
      ok: false,
      error: `${fileName} has ${count(triangles)} triangles — too detailed even to reduce (the limit is ${count(MAX_STL_TRIANGLES)}). Try exporting it more coarsely, or as STEP.`,
    };
  }
  if (triangles > SOLID_STL_TRIANGLES || bytes.length > MAX_IMPORT_BYTES) return { ok: "reduce", fileName, triangles };
  return { ok: true, file: { fileName, format, data: toBase64(bytes), units: "mm", ...(from ? { from } : {}) } };
}

/**
 * A detailed STL reduced to about `target` triangles (flat areas lose triangles first; sharp edges and corners stay
 * put — see geometry/decimate.ts), packaged for the design as a binary STL. Only the reduced triangles are kept, and
 * `reducedFrom` says how many the file had. Throws a plain message when nothing usable is left.
 */
export function reduceStl(fileName: string, bytes: Uint8Array, target: number): ImportedFile {
  const welded = weldCorners(readStlCorners(bytes));
  const before = welded.triangles.length / 3;
  if (before === 0) throw new Error(`${fileName} has no usable triangles in it.`);
  const reduced = decimate(welded.vertices, welded.triangles, Math.min(target, SOLID_STL_TRIANGLES));
  if (reduced.triangles.length === 0) throw new Error(`${fileName} couldn't be reduced: nothing usable was left.`);
  const data = toBase64(new Uint8Array(writeBinaryStl([reduced], `JuraCAD: ${fileName} reduced`.slice(0, 80))));
  return { fileName, format: "stl", data, units: "mm", reducedFrom: countStlTriangles(bytes) };
}

/** The triangles a reduced STL kept (from its stored bytes). */
export function storedTriangles(file: ImportedFile): number {
  if (file.format !== "stl") return 0;
  if (lastCounted?.data !== file.data) lastCounted = { data: file.data, n: countStlTriangles(fromBase64(file.data)) };
  return lastCounted.n;
}
let lastCounted: { data: string; n: number } | undefined;

/** What the Import dialog says about a reduced STL. */
/** What the Import dialog calls the file's kind. */
export function importKind(file: ImportedFile): string {
  if (file.from === "3mf") return "3MF";
  if (file.from === "obj") return "OBJ";
  return file.format === "step" ? "STEP" : "STL";
}

export function reducedNote(file: ImportedFile): string | undefined {
  if (!file.reducedFrom) return undefined;
  return `Reduced from ${count(file.reducedFrom)} triangles to ${count(storedTriangles(file))}, so it can be worked with as a solid. Only the reduced shape is kept in your design.`;
}

/** Roughly how big the imported file is, for the dialog. */
export function importedSize(file: ImportedFile): string {
  const bytes = file.format === "stl" ? Math.floor((file.data.length * 3) / 4) : file.data.length;
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
