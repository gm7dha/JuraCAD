/**
 * Part Studios. The first one's features are the document's `features` (so
 * older files still open); any more are in `partStudios`. Feature ids are
 * unique across the whole document, so a part (named by the feature that
 * made it) can be found in whichever Part Studio it came from.
 */
import type { Feature, JuraCADDocument, PartStudio } from "./types";

/** Id of the first Part Studio. */
export const MAIN_STUDIO = "main";
export const MAIN_STUDIO_NAME = "Part Studio 1";

/** Every Part Studio, in tab order (the first is built fresh each call: don't use it as a selector result). */
export function studiosOf(doc: JuraCADDocument): PartStudio[] {
  return [{ id: MAIN_STUDIO, name: doc.studioName ?? MAIN_STUDIO_NAME, features: doc.features }, ...(doc.partStudios ?? [])];
}

/** A Part Studio's features (the same array each time, so it's safe in selectors). */
export function studioFeatures(doc: JuraCADDocument, id: string): Feature[] {
  if (id === MAIN_STUDIO) return doc.features;
  return doc.partStudios?.find((s) => s.id === id)?.features ?? EMPTY;
}
const EMPTY: Feature[] = [];

export function studioExists(doc: JuraCADDocument, id: string): boolean {
  return id === MAIN_STUDIO || !!doc.partStudios?.some((s) => s.id === id);
}

export function studioName(doc: JuraCADDocument, id: string): string {
  return id === MAIN_STUDIO ? doc.studioName ?? MAIN_STUDIO_NAME : doc.partStudios?.find((s) => s.id === id)?.name ?? "Part Studio";
}

/**
 * Apply a change written for one Part Studio (`doc.features`) to the Part
 * Studio `id`: `fn` sees the document with that studio's features in `features`.
 */
export function inStudio(doc: JuraCADDocument, id: string, fn: (view: JuraCADDocument) => JuraCADDocument): JuraCADDocument {
  if (id === MAIN_STUDIO) return fn(doc);
  if (!doc.partStudios?.some((s) => s.id === id)) return doc;
  const view = { ...doc, features: studioFeatures(doc, id) };
  const out = fn(view);
  if (out === view) return doc;
  return {
    ...out,
    features: doc.features,
    partStudios: (out.partStudios ?? doc.partStudios ?? []).map((s) => (s.id === id ? { ...s, features: out.features } : s)),
  };
}

/** The document as one Part Studio's view (its features in `features`), for code that reads features. */
export function studioView(doc: JuraCADDocument, id: string): JuraCADDocument {
  return id === MAIN_STUDIO ? doc : { ...doc, features: studioFeatures(doc, id) };
}

/** Change every feature in every Part Studio. */
export function mapAllFeatures(doc: JuraCADDocument, fn: (f: Feature) => Feature): JuraCADDocument {
  const features = doc.features.map(fn);
  const studios = doc.partStudios?.map((s) => ({ ...s, features: s.features.map(fn) }));
  return { ...doc, features, ...(studios ? { partStudios: studios } : {}) };
}

/** Every feature in the document. */
export function allFeatures(doc: JuraCADDocument): Feature[] {
  return [...doc.features, ...(doc.partStudios ?? []).flatMap((s) => s.features)];
}

/** "Part Studio 2", "Part Studio 3"… */
export function nextStudioName(doc: JuraCADDocument): string {
  const used = new Set(studiosOf(doc).map((s) => s.name));
  let n = 1;
  while (used.has(`Part Studio ${n}`)) n++;
  return `Part Studio ${n}`;
}

export function addStudio(doc: JuraCADDocument, id: string): JuraCADDocument {
  return { ...doc, partStudios: [...(doc.partStudios ?? []), { id, name: nextStudioName(doc), features: [] }] };
}

export function renameStudio(doc: JuraCADDocument, id: string, name: string): JuraCADDocument {
  const trimmed = name.trim();
  if (!trimmed) return doc;
  if (id === MAIN_STUDIO) {
    const { studioName: _old, ...rest } = doc;
    return trimmed === MAIN_STUDIO_NAME ? rest : { ...rest, studioName: trimmed };
  }
  if (!doc.partStudios?.some((s) => s.id === id)) return doc;
  return { ...doc, partStudios: doc.partStudios.map((s) => (s.id === id ? { ...s, name: trimmed } : s)) };
}

/** Remove a Part Studio (not the first). Assembly copies of its parts show as missing until undone. */
export function removeStudio(doc: JuraCADDocument, id: string): JuraCADDocument {
  if (id === MAIN_STUDIO || !doc.partStudios) return doc;
  const { partStudios, ...rest } = doc;
  const left = partStudios.filter((s) => s.id !== id);
  return left.length ? { ...rest, partStudios: left } : rest;
}

/** Which Part Studio a feature (and so the part it made) is in. */
export function studioOfFeature(doc: JuraCADDocument, featureId: string): string | null {
  if (doc.features.some((f) => f.id === featureId)) return MAIN_STUDIO;
  return doc.partStudios?.find((s) => s.features.some((f) => f.id === featureId))?.id ?? null;
}
