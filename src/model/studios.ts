/**
 * Part Studios. The first tab's features are the document's `features` (so
 * older files still open); any more are in `partStudios`, in tab order. Feature
 * ids are unique across the whole document, so a part (named by the feature
 * that made it) can be found in whichever Part Studio it came from.
 *
 * Every Part Studio keeps its id for good, wherever its tab is: the first
 * tab's id is `studioId` ("main" when missing, as in every file saved before
 * tabs could be moved), so moving or deleting tabs never changes what an
 * assembly, drawing or Derived feature points at. Moving a studio into the
 * first place (`withStudios`) puts its features, name, hidden planes and id in
 * the document's own fields; the one it replaces becomes an ordinary entry of
 * `partStudios` (which may then be called "main").
 */
import type { Feature, JuraCADDocument, PartStudio } from "./types";

/** Id of the first Part Studio of a document that never had its tabs moved. */
export const MAIN_STUDIO = "main";
export const MAIN_STUDIO_NAME = "Part Studio 1";

/** Id of the Part Studio in the first tab (whose features are `doc.features`). */
export function firstStudioId(doc: Pick<JuraCADDocument, "studioId">): string {
  return doc.studioId ?? MAIN_STUDIO;
}

/** Every Part Studio, in tab order (the first is built fresh each call: don't use it as a selector result). */
export function studiosOf(doc: JuraCADDocument): PartStudio[] {
  const first: PartStudio = { id: firstStudioId(doc), name: doc.studioName ?? MAIN_STUDIO_NAME, features: doc.features, ...(doc.hiddenDatums?.length ? { hiddenDatums: doc.hiddenDatums } : {}) };
  return [first, ...(doc.partStudios ?? [])];
}

/** A Part Studio's features (the same array each time, so it's safe in selectors). */
export function studioFeatures(doc: JuraCADDocument, id: string): Feature[] {
  if (id === firstStudioId(doc)) return doc.features;
  return doc.partStudios?.find((s) => s.id === id)?.features ?? EMPTY;
}
const EMPTY: Feature[] = [];

export function studioExists(doc: JuraCADDocument, id: string): boolean {
  return id === firstStudioId(doc) || !!doc.partStudios?.some((s) => s.id === id);
}

export function studioName(doc: JuraCADDocument, id: string): string {
  return id === firstStudioId(doc) ? doc.studioName ?? MAIN_STUDIO_NAME : doc.partStudios?.find((s) => s.id === id)?.name ?? "Part Studio";
}

/**
 * Apply a change written for one Part Studio (`doc.features`) to the Part
 * Studio `id`: `fn` sees the document with that studio's features in `features`.
 */
export function inStudio(doc: JuraCADDocument, id: string, fn: (view: JuraCADDocument) => JuraCADDocument): JuraCADDocument {
  if (id === firstStudioId(doc)) return fn(doc);
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
  return id === firstStudioId(doc) ? doc : { ...doc, features: studioFeatures(doc, id) };
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
  if (id === firstStudioId(doc)) {
    const { studioName: _old, ...rest } = doc;
    return trimmed === MAIN_STUDIO_NAME ? rest : { ...rest, studioName: trimmed };
  }
  if (!doc.partStudios?.some((s) => s.id === id)) return doc;
  return { ...doc, partStudios: doc.partStudios.map((s) => (s.id === id ? { ...s, name: trimmed } : s)) };
}

/**
 * The document with these Part Studios, in this tab order: the first one's
 * features, name, hidden planes and id go in the document's own fields
 * (`features`, `studioName`, `hiddenDatums`, `studioId`, each left out when it's
 * the usual), the rest in `partStudios`. Given `studiosOf(doc)` it gives back
 * an equal document, so a document whose tabs were moved back saves as before.
 */
export function withStudios(doc: JuraCADDocument, list: PartStudio[]): JuraCADDocument {
  const [first, ...rest] = list;
  if (!first) return doc;
  const { studioId: _id, studioName: _name, hiddenDatums: _hidden, partStudios: _studios, ...base } = doc;
  const tidy = (s: PartStudio): PartStudio => {
    const { hiddenDatums, ...plain } = s;
    return hiddenDatums?.length ? { ...plain, hiddenDatums } : plain;
  };
  return {
    ...base,
    features: first.features,
    ...(first.id !== MAIN_STUDIO ? { studioId: first.id } : {}),
    ...(first.name !== MAIN_STUDIO_NAME ? { studioName: first.name } : {}),
    ...(first.hiddenDatums?.length ? { hiddenDatums: first.hiddenDatums } : {}),
    ...(rest.length ? { partStudios: rest.map(tidy) } : {}),
  };
}

/** Where a Part Studio's tab is (0 = first), or -1. */
export function studioIndex(doc: JuraCADDocument, id: string): number {
  return studiosOf(doc).findIndex((s) => s.id === id);
}

/** Move a Part Studio's tab so it ends up at `to` (0 = first; clamped). The same document when it doesn't move. */
export function moveStudio(doc: JuraCADDocument, id: string, to: number): JuraCADDocument {
  const list = studiosOf(doc);
  const from = list.findIndex((s) => s.id === id);
  const at = Math.max(0, Math.min(list.length - 1, Math.round(to)));
  if (from < 0 || from === at) return doc;
  const [moved] = list.splice(from, 1);
  list.splice(at, 0, moved);
  return withStudios(doc, list);
}

/**
 * Remove a Part Studio — any of them, the first too, as long as another is
 * left (the next one then becomes the first). Library designs whose features
 * were all in it are forgotten, and configurations stop listing its features.
 * Assembly copies of its parts are removed by `deleteStudio` (studioUse.ts),
 * which is what the app uses; here they're left (showing as missing).
 */
export function removeStudio(doc: JuraCADDocument, id: string): JuraCADDocument {
  const list = studiosOf(doc);
  const gone = list.find((s) => s.id === id);
  if (!gone || list.length < 2) return doc;
  let out = withStudios(doc, list.filter((s) => s !== gone));
  const ids = new Set(gone.features.map((f) => f.id));
  if (doc.libraryInserts?.some((i) => i.features.some((f) => ids.has(f)))) {
    const inserts = doc.libraryInserts.map((i) => ({ ...i, features: i.features.filter((f) => !ids.has(f)) })).filter((i) => i.features.length);
    const { libraryInserts: _old, ...rest } = out;
    out = inserts.length ? { ...rest, libraryInserts: inserts } : rest;
  }
  if (doc.configurations?.some((c) => c.suppressed.some((f) => ids.has(f)))) {
    out = { ...out, configurations: doc.configurations.map((c) => (c.suppressed.some((f) => ids.has(f)) ? { ...c, suppressed: c.suppressed.filter((f) => !ids.has(f)) } : c)) };
  }
  return out;
}

/** Which Part Studio a feature (and so the part it made) is in. */
export function studioOfFeature(doc: JuraCADDocument, featureId: string): string | null {
  if (doc.features.some((f) => f.id === featureId)) return firstStudioId(doc);
  return doc.partStudios?.find((s) => s.features.some((f) => f.id === featureId))?.id ?? null;
}
