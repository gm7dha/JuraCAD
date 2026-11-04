/**
 * Versions, as in Onshape: named snapshots of the whole design, kept with it
 * (in the .juracad file and in the browser's saved design). Pure — no store,
 * no React.
 *
 * Each snapshot is the design as JSON without its own versions, compressed
 * with the browser's gzip (CompressionStream) and written as base64, so a
 * version usually takes a tenth of the design's size or less. Browsers
 * without CompressionStream keep the JSON as it is ("json:").
 */
import { fileVersionOf, parseDocument } from "./document";
import type { DesignVersion, JuraCADDocument } from "./types";

/**
 * Above this many characters kept in the browser — the design and its
 * versions together — the Versions panel suggests removing old versions
 * (browsers keep about 5 MB per website, and count some characters twice).
 */
export const STORAGE_LARGE = 2_500_000;

/** The design without its versions (what a version holds, and what Live with Claude is sent). */
export function designOf(doc: JuraCADDocument): JuraCADDocument {
  if (doc.versions === undefined) return doc;
  const { versions: _v, ...rest } = doc;
  return rest;
}

/** `target` with `source`'s versions (none if it has none): the same object when they're already the same. */
export function withVersionsOf(target: JuraCADDocument, source: JuraCADDocument): JuraCADDocument {
  const v = source.versions;
  if (target.versions === v) return target;
  if (!v?.length) return designOf(target);
  return { ...target, versions: v };
}

/** The design's versions, oldest first (the same empty list when there are none). */
export function versionsOf(doc: JuraCADDocument): DesignVersion[] {
  return doc.versions ?? NONE;
}
const NONE: DesignVersion[] = [];

/** Newest first, for the list. */
export function newestFirst(list: readonly DesignVersion[]): DesignVersion[] {
  return [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0) || list.indexOf(b) - list.indexOf(a));
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function through(bytes: Uint8Array, stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** Pack a design for keeping as a version (its own versions are left out). */
export async function packDesign(doc: JuraCADDocument, compress = typeof CompressionStream !== "undefined"): Promise<string> {
  // A design with moved Part Studio tabs is kept as format version 2 (see fileVersionOf), so older JuraCADs refuse it rather than drop a studio.
  const design = designOf(doc);
  const json = JSON.stringify(fileVersionOf(design) === 2 ? { ...design, version: 2 } : design);
  if (!compress) return `json:${json}`;
  const gz = await through(new TextEncoder().encode(json), new CompressionStream("gzip") as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> });
  return `gz:${toBase64(gz)}`;
}

export type UnpackResult = { ok: true; doc: JuraCADDocument } | { ok: false; error: string };

/** Read a version's design back. Plain-English error if it can't be. */
export async function unpackDesign(packed: string): Promise<UnpackResult> {
  const damaged = { ok: false as const, error: "This version is damaged and can't be opened. Your current design isn't affected." };
  let json: string;
  try {
    if (packed.startsWith("json:")) json = packed.slice(5);
    else if (packed.startsWith("gz:")) {
      if (typeof DecompressionStream === "undefined") {
        return { ok: false, error: "This browser is too old to open saved versions. Update it (or use Chrome, Edge, Firefox or a recent Safari) and try again." };
      }
      const bytes = await through(fromBase64(packed.slice(3)), new DecompressionStream("gzip") as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> });
      json = new TextDecoder().decode(bytes);
    } else return damaged;
    const doc = parseDocument(JSON.parse(json));
    return doc ? { ok: true, doc: designOf(doc) } : damaged;
  } catch {
    return damaged;
  }
}

/** "V1", "V2"… — the next name not used yet (as Onshape names versions). */
export function nextVersionName(doc: JuraCADDocument): string {
  const used = new Set(versionsOf(doc).map((v) => v.name.trim().toLowerCase()));
  let n = versionsOf(doc).filter((v) => !v.auto).length + 1;
  while (used.has(`v${n}`)) n++;
  return `V${n}`;
}

/** A name problem in plain words, or null. */
export function versionNameProblem(doc: JuraCADDocument, name: string, except?: string): string | null {
  const t = name.trim();
  if (!t) return "Give the version a name.";
  if (t.length > 80) return "That name is too long — keep it under 80 letters.";
  if (versionsOf(doc).some((v) => v.id !== except && v.name.trim().toLowerCase() === t.toLowerCase())) return `There's already a version called "${t}". Pick another name.`;
  return null;
}

/** Add a version (already packed) to the design. */
export function addVersion(doc: JuraCADDocument, v: DesignVersion): JuraCADDocument {
  const { note, ...rest } = v;
  const clean: DesignVersion = { ...rest, name: v.name.trim(), ...(note?.trim() ? { note: note.trim() } : {}) };
  return { ...doc, versions: [...versionsOf(doc), clean] };
}

/** Rename a version, or change its note. */
export function editVersion(doc: JuraCADDocument, id: string, patch: { name?: string; note?: string }): JuraCADDocument {
  const list = versionsOf(doc);
  if (!list.some((v) => v.id === id)) return doc;
  return {
    ...doc,
    versions: list.map((v) => {
      if (v.id !== id) return v;
      const next: DesignVersion = { ...v, ...(patch.name !== undefined && patch.name.trim() ? { name: patch.name.trim() } : {}) };
      if (patch.note !== undefined) {
        if (patch.note.trim()) next.note = patch.note.trim();
        else delete next.note;
      }
      return next;
    }),
  };
}

/** Remove versions. The field goes when the last one does, so the file is as it was before. */
export function removeVersions(doc: JuraCADDocument, ids: readonly string[]): JuraCADDocument {
  const list = versionsOf(doc).filter((v) => !ids.includes(v.id));
  if (list.length === versionsOf(doc).length) return doc;
  if (list.length) return { ...doc, versions: list };
  return designOf(doc);
}

/**
 * Restore: the design becomes a copy of the version's, keeping its own name
 * (the document's title) and every version — including any added just now.
 */
export function restoredDesign(current: JuraCADDocument, version: JuraCADDocument): JuraCADDocument {
  const kept = versionsOf(current);
  const copy: JuraCADDocument = { ...designOf(version), name: current.name };
  return kept.length ? { ...copy, versions: kept } : copy;
}

/** A new design started from a version: its design, no versions, named after both. */
export function designFromVersion(version: JuraCADDocument, versionName: string): JuraCADDocument {
  return { ...designOf(version), name: `${version.name} (from ${versionName})` };
}

/** How much the versions take, in characters (≈ bytes) of the saved design. */
export function versionsSize(doc: JuraCADDocument): number {
  return versionsOf(doc).reduce((n, v) => n + versionCost(v), 0);
}

/** "340 KB", "2.1 MB". */
export function sizeText(chars: number): string {
  if (chars < 1000) return `${Math.max(1, Math.round(chars / 100) / 10)} KB`;
  if (chars < 1_000_000) return `${Math.round(chars / 1000)} KB`;
  return `${(chars / 1_000_000).toFixed(1)} MB`;
}

/** How much the design itself takes when kept (characters), without its versions. */
export function designSize(doc: JuraCADDocument): number {
  return JSON.stringify(designOf(doc)).length;
}

/** What one version adds to the kept size. */
const versionCost = (v: DesignVersion) => v.packed.length + v.name.length + (v.note?.length ?? 0) + 120;

/**
 * Which versions to remove to bring the design and its versions together
 * under `limit`: automatic ones first, then the oldest; the newest `keep`
 * the user saved are never suggested. (`design` = designSize, if known.)
 */
export function versionsToTidy(doc: JuraCADDocument, limit = STORAGE_LARGE * 0.6, keep = 3, design = designSize(doc)): string[] {
  const list = versionsOf(doc);
  const own = list.filter((v) => !v.auto);
  const protectedIds = new Set(newestFirst(own).slice(0, keep).map((v) => v.id));
  const order = [...list.filter((v) => v.auto), ...own].filter((v) => !protectedIds.has(v.id));
  const out: string[] = [];
  let size = design + versionsSize(doc);
  for (const v of order) {
    if (size <= limit) break;
    out.push(v.id);
    size -= versionCost(v);
  }
  return out;
}

/** A note for the panel when the design and its versions are getting too big for the browser, or null. */
export function storageNote(doc: JuraCADDocument, design = designSize(doc)): string | null {
  const versions = versionsSize(doc);
  if (design + versions < STORAGE_LARGE) return null;
  return `The design takes ${sizeText(design)} and its versions ${sizeText(versions)}. Browsers keep only about 5 MB for each website, so this may soon be too big to keep in this browser (saving to a file always works). Removing old versions frees space.`;
}

/** Versions read from a saved file or the browser; anything that doesn't make sense is dropped. */
export function parseVersions(raw: unknown): DesignVersion[] {
  if (!Array.isArray(raw)) return [];
  const out: DesignVersion[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const v = (r ?? {}) as Record<string, unknown>;
    if (typeof v.id !== "string" || !v.id || seen.has(v.id)) continue;
    if (typeof v.name !== "string" || !v.name.trim() || typeof v.createdAt !== "string" || Number.isNaN(Date.parse(v.createdAt))) continue;
    if (typeof v.packed !== "string" || !/^(gz|json):/.test(v.packed)) continue;
    seen.add(v.id);
    out.push({
      id: v.id,
      name: v.name.trim().slice(0, 200),
      ...(typeof v.note === "string" && v.note.trim() ? { note: v.note.trim() } : {}),
      createdAt: v.createdAt,
      ...(v.auto === true ? { auto: true } : {}),
      packed: v.packed,
    });
  }
  return out;
}

/** "3 Oct 2026, 14:05" in the user's own way of writing dates. */
export function versionDate(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
