/**
 * The .partsmith file: the document as readable JSON (so it can be kept in
 * version control or inspected), plus a little information about when and
 * with what it was saved.
 */
import { parseDocument } from "./document";
import type { PartSmithDocument } from "./types";

export const FILE_EXTENSION = ".partsmith";
export const FILE_MIME = "application/x-partsmith+json";

/** The file's text. */
export function serializeDocument(doc: PartSmithDocument, savedAt = new Date()): string {
  const file = {
    format: doc.format,
    version: doc.version,
    name: doc.name,
    savedWith: "PartSmith (https://gm7dha.github.io/partsmith/)",
    savedAt: savedAt.toISOString(),
    ...(doc.variables?.length ? { variables: doc.variables } : {}),
    ...(doc.appearance && Object.keys(doc.appearance).length ? { appearance: doc.appearance } : {}),
    features: doc.features,
  };
  return JSON.stringify(file, null, 1) + "\n";
}

export type ReadResult = { ok: true; doc: PartSmithDocument } | { ok: false; error: string };

/** Read a file's text, explaining in plain words if it can't be used. */
export function readDocumentFile(text: string, fileName = "That file"): ReadResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    if (/^ISO-10303-21/.test(text.trimStart())) {
      return { ok: false, error: `${fileName} is a STEP file. PartSmith can't open STEP files yet — only .partsmith files.` };
    }
    if (/^solid\s/i.test(text.trimStart()) || /\0/.test(text.slice(0, 200))) {
      return { ok: false, error: `${fileName} looks like an STL or other model file. PartSmith can only open .partsmith files.` };
    }
    return { ok: false, error: `${fileName} isn't a PartSmith file (it couldn't be read).` };
  }
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d !== "object" || d.format !== "partsmith") {
    return { ok: false, error: `${fileName} isn't a PartSmith file.` };
  }
  if (typeof d.version === "number" && d.version > 1) {
    return { ok: false, error: `${fileName} was saved by a newer version of PartSmith. Refresh the page to get the latest version, then try again.` };
  }
  const doc = parseDocument(data);
  if (!doc) return { ok: false, error: `${fileName} is damaged — some of its contents don't make sense, so it can't be opened.` };
  return { ok: true, doc };
}

/** "Bracket v2.partsmith" → "Bracket v2". */
export function nameFromFileName(fileName: string): string {
  return fileName.replace(/\.partsmith$/i, "").replace(/\.json$/i, "").trim();
}
