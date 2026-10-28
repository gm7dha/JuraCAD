/**
 * The .juracad file: the document as readable JSON (so it can be kept in
 * version control or inspected), plus a little information about when and
 * with what it was saved.
 *
 * The app used to be called PartSmith and saved ".partsmith" files. Those are
 * the same format and still open; inside both, "format" stays "partsmith" so
 * files saved now also open in older versions.
 */
import { parseDocument } from "./document";
import type { JuraCADDocument } from "./types";

/** New saves use this extension. */
export const FILE_EXTENSION = ".juracad";
export const FILE_MIME = "application/x-juracad+json";
/** The old name's extension and file type: still opened, never written. */
export const OLD_FILE_EXTENSION = ".partsmith";
export const OLD_FILE_MIME = "application/x-partsmith+json";
/** Every extension that opens as a design (not imported as a model). */
export const DESIGN_EXTENSIONS = [FILE_EXTENSION, OLD_FILE_EXTENSION];

/** True for "Bracket.juracad" and (older saves) "Bracket.partsmith". */
export function isDesignFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return DESIGN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** The file's text. */
export function serializeDocument(doc: JuraCADDocument, savedAt = new Date()): string {
  const file = {
    format: doc.format,
    version: doc.version,
    name: doc.name,
    savedWith: "JuraCAD (https://gm7dha.github.io/JuraCAD/)",
    savedAt: savedAt.toISOString(),
    ...(doc.variables?.length ? { variables: doc.variables } : {}),
    ...(doc.appearance && Object.keys(doc.appearance).length ? { appearance: doc.appearance } : {}),
    ...(doc.materials && Object.keys(doc.materials).length ? { materials: doc.materials } : {}),
    ...(doc.units === "in" ? { units: "in" } : {}),
    ...(doc.partNames && Object.keys(doc.partNames).length ? { partNames: doc.partNames } : {}),
    ...(doc.studioName ? { studioName: doc.studioName } : {}),
    ...(doc.hiddenDatums?.length ? { hiddenDatums: doc.hiddenDatums } : {}),
    features: doc.features,
    ...(doc.partStudios?.length ? { partStudios: doc.partStudios } : {}),
    ...(doc.assemblies?.length ? { assemblies: doc.assemblies } : {}),
    ...(doc.drawings?.length ? { drawings: doc.drawings } : {}),
  };
  return JSON.stringify(file, null, 1) + "\n";
}

export type ReadResult = { ok: true; doc: JuraCADDocument } | { ok: false; error: string };

/** Read a file's text, explaining in plain words if it can't be used. */
export function readDocumentFile(text: string, fileName = "That file"): ReadResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    if (/^ISO-10303-21/.test(text.trimStart())) {
      return { ok: false, error: `${fileName} is a STEP file. Use Import in the toolbar to bring it into your design.` };
    }
    if (/^solid\s/i.test(text.trimStart()) || /\0/.test(text.slice(0, 200))) {
      return { ok: false, error: `${fileName} looks like an STL or other model file. Use Import in the toolbar to bring an STL or STEP file into your design.` };
    }
    return { ok: false, error: `${fileName} isn't a JuraCAD design file (it couldn't be read).` };
  }
  const d = data as Record<string, unknown> | null;
  // "partsmith" is the format id from the app's old name, kept in every saved file.
  if (!d || typeof d !== "object" || d.format !== "partsmith") {
    return { ok: false, error: `${fileName} isn't a JuraCAD design file.` };
  }
  if (typeof d.version === "number" && d.version > 1) {
    return { ok: false, error: `${fileName} was saved by a newer version of JuraCAD. Refresh the page to get the latest version, then try again.` };
  }
  const doc = parseDocument(data);
  if (!doc) return { ok: false, error: `${fileName} is damaged — some of its contents don't make sense, so it can't be opened.` };
  return { ok: true, doc };
}

/** "Bracket v2.juracad" (or the older "Bracket v2.partsmith") → "Bracket v2". */
export function nameFromFileName(fileName: string): string {
  return fileName.replace(/\.(juracad|partsmith)$/i, "").replace(/\.json$/i, "").trim();
}
