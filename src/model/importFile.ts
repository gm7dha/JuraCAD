/**
 * Bringing STEP and STL files from other programs into a design. The file is
 * kept inside the design (so it saves, undoes and reopens like everything
 * else); the geometry engine turns it into a part on each rebuild.
 */
import type { ImportedFile } from "./types";

/** Bigger files make the design slow to save and rebuild. */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
/** STL triangles become faces of a solid; past this it gets too slow to work with. */
export const MAX_STL_TRIANGLES = 50_000;

export const IMPORT_ACCEPT = ".step,.stp,.stl";

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
  return fileName.replace(/\.(step|stp|stl)$/i, "").trim() || "Imported part";
}

export type ImportReadResult = { ok: true; file: ImportedFile } | { ok: false; error: string };

/** Check a file's bytes and package them for the design, or explain in plain words why not. */
export function readImport(fileName: string, bytes: Uint8Array): ImportReadResult {
  if (bytes.length === 0) return { ok: false, error: `${fileName} is empty.` };
  if (bytes.length > MAX_IMPORT_BYTES) {
    return { ok: false, error: `${fileName} is ${(bytes.length / 1024 / 1024).toFixed(0)} MB — JuraCAD can import files up to ${MAX_IMPORT_BYTES / 1024 / 1024} MB.` };
  }
  const format = detectFormat(fileName, bytes);
  if (!format) return { ok: false, error: `${fileName} isn't a STEP or STL file, so it can't be imported.` };
  if (format === "step") {
    return { ok: true, file: { fileName, format, data: new TextDecoder().decode(bytes), units: "mm" } };
  }
  const triangles = countStlTriangles(bytes);
  if (triangles === 0) return { ok: false, error: `${fileName} has no triangles in it.` };
  if (triangles > MAX_STL_TRIANGLES) {
    return {
      ok: false,
      error: `${fileName} has ${triangles.toLocaleString("en-GB")} triangles — too detailed to work with as a solid (the limit is ${MAX_STL_TRIANGLES.toLocaleString("en-GB")}). Try exporting it more coarsely, or as STEP.`,
    };
  }
  return { ok: true, file: { fileName, format, data: toBase64(bytes), units: "mm" } };
}

/** Roughly how big the imported file is, for the dialog. */
export function importedSize(file: ImportedFile): string {
  const bytes = file.format === "stl" ? Math.floor((file.data.length * 3) / 4) : file.data.length;
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
