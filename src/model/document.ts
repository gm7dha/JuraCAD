import { FEATURE_DEFS, defaultParams } from "./features";
import type { Feature, FeatureType, Operation, PartSmithDocument } from "./types";

/**
 * Pure functions for changing a document. They never modify their input;
 * they return a new document, which makes undo/redo trivial.
 */

export function emptyDocument(name = "Untitled part"): PartSmithDocument {
  return { format: "partsmith", version: 1, name, features: [] };
}

let idCounter = 0;
/** A short, unique, permanent ID. */
export function newId(prefix = "f"): string {
  idCounter = (idCounter + 1) % 1_000_000;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rand}`;
}

/** Next free automatic name, e.g. "Box 3" when "Box 1" and "Box 2" exist. */
export function nextFeatureName(doc: PartSmithDocument, type: FeatureType): string {
  const prefix = FEATURE_DEFS[type].namePrefix;
  const used = new Set(doc.features.map((f) => f.name));
  let n = 1;
  while (used.has(`${prefix} ${n}`)) n++;
  return `${prefix} ${n}`;
}

export function createFeature(doc: PartSmithDocument, type: FeatureType, operation?: Operation): Feature {
  return {
    id: newId(),
    name: nextFeatureName(doc, type),
    type,
    // The first solid has nothing to add to, so it must be a new part.
    operation: operation ?? "new",
    suppressed: false,
    params: defaultParams(type),
  };
}

export function addFeature(doc: PartSmithDocument, feature: Feature): PartSmithDocument {
  return { ...doc, features: [...doc.features, feature] };
}

export function replaceFeature(doc: PartSmithDocument, feature: Feature): PartSmithDocument {
  if (!doc.features.some((f) => f.id === feature.id)) return doc;
  return { ...doc, features: doc.features.map((f) => (f.id === feature.id ? feature : f)) };
}

export function removeFeature(doc: PartSmithDocument, id: string): PartSmithDocument {
  return { ...doc, features: doc.features.filter((f) => f.id !== id) };
}

export function renameFeature(doc: PartSmithDocument, id: string, name: string): PartSmithDocument {
  const trimmed = name.trim();
  const f = doc.features.find((x) => x.id === id);
  if (!f || !trimmed) return doc;
  return replaceFeature(doc, { ...f, name: trimmed });
}

export function setSuppressed(doc: PartSmithDocument, id: string, suppressed: boolean): PartSmithDocument {
  const f = doc.features.find((x) => x.id === id);
  if (!f) return doc;
  return replaceFeature(doc, { ...f, suppressed });
}

/** The feature list with an unsaved draft swapped in (or appended), for live preview. */
export function featuresWithDraft(features: Feature[], draft: Feature | null): Feature[] {
  if (!draft) return features;
  return features.some((f) => f.id === draft.id)
    ? features.map((f) => (f.id === draft.id ? draft : f))
    : [...features, draft];
}

// ---------------------------------------------------------------------------
// Undo / redo history

export interface History {
  past: PartSmithDocument[];
  present: PartSmithDocument;
  future: PartSmithDocument[];
}

const HISTORY_LIMIT = 200;

export function historyOf(doc: PartSmithDocument): History {
  return { past: [], present: doc, future: [] };
}

/** Record a change. No-op when nothing actually changed (e.g. a dialog accepted without edits). */
export function commit(h: History, next: PartSmithDocument): History {
  if (next === h.present || JSON.stringify(next) === JSON.stringify(h.present)) return h;
  const past = [...h.past, h.present].slice(-HISTORY_LIMIT);
  return { past, present: next, future: [] };
}

export function undo(h: History): History {
  if (h.past.length === 0) return h;
  const previous = h.past[h.past.length - 1];
  return { past: h.past.slice(0, -1), present: previous, future: [h.present, ...h.future] };
}

export function redo(h: History): History {
  if (h.future.length === 0) return h;
  const [next, ...rest] = h.future;
  return { past: [...h.past, h.present], present: next, future: rest };
}

// ---------------------------------------------------------------------------
// Loading saved documents safely

const FEATURE_TYPES = new Set<string>(Object.keys(FEATURE_DEFS));
const OPERATIONS = new Set<string>(["new", "add", "remove"]);

/** Check untrusted JSON (e.g. from browser storage) and return a clean document, or null. */
export function parseDocument(data: unknown): PartSmithDocument | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.format !== "partsmith" || d.version !== 1 || !Array.isArray(d.features)) return null;
  const features: Feature[] = [];
  const seen = new Set<string>();
  for (const raw of d.features) {
    if (!raw || typeof raw !== "object") return null;
    const f = raw as Record<string, unknown>;
    if (typeof f.id !== "string" || seen.has(f.id)) return null;
    if (typeof f.name !== "string" || typeof f.type !== "string" || !FEATURE_TYPES.has(f.type)) return null;
    if (typeof f.operation !== "string" || !OPERATIONS.has(f.operation)) return null;
    if (!f.params || typeof f.params !== "object") return null;
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(f.params as Record<string, unknown>)) {
      if (typeof v === "string") params[k] = v;
      else if (typeof v === "number") params[k] = String(v);
    }
    seen.add(f.id);
    features.push({
      id: f.id,
      name: f.name,
      type: f.type as FeatureType,
      operation: f.operation as Operation,
      suppressed: f.suppressed === true,
      params: { ...defaultParams(f.type as FeatureType), ...params },
    });
  }
  return {
    format: "partsmith",
    version: 1,
    name: typeof d.name === "string" && d.name.trim() ? d.name : "Untitled part",
    features,
  };
}
