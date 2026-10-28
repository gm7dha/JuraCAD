import { parsePick } from "../geometry/topoRef";
import { parseLineRef } from "./patternRefs";
import { FASTENER_KINDS, FASTENER_SIZES, type FastenerKind } from "./fasteners";
import { parsePlane, parseSketchData } from "../sketch/validate";
import { defaultAxis } from "../sketch/axis";
import { emptySketch } from "../sketch/types";
import { FEATURE_DEFS, defaultParams, isSolidFeature } from "./features";
import { parseConfigurations } from "./configurations";
import { parseVariables } from "./variables";
import { parseAppearance } from "./colours";
import { parseMaterials } from "./materials";
import { parsePartProperties } from "../assembly/properties";
import { parseAssemblies } from "../assembly/assembly";
import { parseDrawings } from "../drawing/drawing";
import type { Feature, FeatureType, ImportedFile, Operation, JuraCADDocument, PartStudio } from "./types";
import { MAIN_STUDIO } from "./studios";
import { parseHiddenDatums } from "./visibility";
import type { AreaPick } from "../sketch/areas";

/**
 * Pure functions for changing a document. They never modify their input;
 * they return a new document, which makes undo/redo trivial.
 */

export function emptyDocument(name = "Untitled part"): JuraCADDocument {
  // "partsmith" is the saved-file format id from the app's old name; it stays so files open in every version.
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
export function nextFeatureName(doc: JuraCADDocument, type: FeatureType): string {
  const prefix = FEATURE_DEFS[type].namePrefix;
  const used = new Set(doc.features.map((f) => f.name));
  let n = 1;
  while (used.has(`${prefix} ${n}`)) n++;
  return `${prefix} ${n}`;
}

export function createFeature(doc: JuraCADDocument, type: FeatureType, operation?: Operation): Feature {
  const feature: Feature = {
    id: newId(),
    name: nextFeatureName(doc, type),
    type,
    // The first solid has nothing to add to, so it must be a new part.
    operation: operation ?? "new",
    suppressed: false,
    params: defaultParams(type, doc.units === "in" ? "in" : "mm"),
  };
  if (type === "sketch") feature.sketch = { plane: null, data: emptySketch() };
  if (type === "extrude" || type === "revolve") {
    const sketches = doc.features.filter((f) => f.type === "sketch" && !f.suppressed);
    const sketch = sketches[sketches.length - 1];
    feature.sketchRef = sketch?.id;
    if (type === "extrude") feature.extrude = { end: "blind", flip: false };
    else feature.revolve = { axis: sketch?.sketch ? defaultAxis(sketch.sketch.data) : "vertical", flip: false };
    // Like Onshape: the first solid is a new part, later extrudes add to it.
    const hasSolid = doc.features.some((f) => f.type !== "sketch" && !f.suppressed);
    feature.operation = operation ?? (hasSolid ? "add" : "new");
    // Pieces that don't touch become separate parts (as in Onshape).
    feature.apart = true;
  }
  if (type === "sweep" || type === "loft") {
    const sketches = doc.features.filter((f) => f.type === "sketch" && !f.suppressed);
    const hasSolid = doc.features.some((f) => f.type !== "sketch" && !f.suppressed);
    feature.operation = operation ?? (hasSolid ? "add" : "new");
    if (type === "sweep") {
      feature.apart = true;
      feature.sketchRef = sketches[sketches.length - 1]?.id;
      feature.pathRef = sketches[sketches.length - 2]?.id;
    } else feature.sections = sketches.slice(-2).map((f) => f.id);
  }
  if (type === "text") {
    const hasSolid = doc.features.some((f) => f.type !== "sketch" && !f.suppressed);
    feature.operation = operation ?? (hasSolid ? "add" : "new");
    feature.text = { value: "JuraCAD", plane: { kind: "default", name: "Top" }, bold: false, flip: false };
  }
  if (type === "split") feature.splitDef = { plane: { kind: "default", name: "Right" }, keep: "both", picking: "part" };
  if (type === "sheetMetal") {
    const sketches = doc.features.filter((f) => f.type === "sketch" && !f.suppressed);
    feature.sketchRef = sketches[sketches.length - 1]?.id;
    feature.operation = "new";
  }
  if (type === "flange" || type === "hem" || type === "cornerBreak") feature.picks = [];
  if (type === "bend" || type === "jog") {
    const sketches = doc.features.filter((f) => f.type === "sketch" && !f.suppressed);
    feature.sketchRef = sketches[sketches.length - 1]?.id;
    feature.operation = "add";
  }
  if (type === "tab") {
    const sketches = doc.features.filter((f) => f.type === "sketch" && !f.suppressed);
    feature.sketchRef = sketches[sketches.length - 1]?.id;
    feature.operation = "add";
  }
  if (type === "rib") {
    const sketches = doc.features.filter((f) => f.type === "sketch" && !f.suppressed);
    feature.sketchRef = sketches[sketches.length - 1]?.id;
    feature.operation = "add";
  }
  if (type === "thicken" || type === "moveFace" || type === "deleteFace" || type === "thread" || type === "fullRound" || type === "wrap" || type === "fill" || type === "enclose" || type === "offsetSurface") feature.picks = [];
  if (type === "extendSurface") feature.picks = [];
  if (type === "ruled") {
    feature.picks = [];
    feature.neutral = { kind: "default", name: "Top" };
  }
  if (type === "fill" || type === "enclose" || type === "offsetSurface" || type === "extendSurface" || type === "ruled") feature.operation = "new";
  if (type === "wrap") {
    const sketches = doc.features.filter((f) => f.type === "sketch" && !f.suppressed);
    feature.sketchRef = sketches[sketches.length - 1]?.id;
    feature.operation = "add";
  }
  if (type === "replaceFace") {
    feature.picks = [];
    feature.replaceDef = { target: null, picking: "faces" };
  }
  if (type === "draft") {
    feature.picks = [];
    feature.neutral = { kind: "default", name: "Top" };
  }
  if (type === "deletePart") feature.deleteParts = [];
  if (type === "fastener") feature.fastener = { kind: "bolt", size: "M6", threaded: false };
  if (type === "boolean") feature.booleanDef = { op: "union", targets: [], tools: [], keepTools: false, picking: "targets" };
  if (type === "plane") feature.planeDef = { mode: "offset", ref: { kind: "default", name: "Top" }, axis: "u" };
  if (type === "transform") {
    feature.operation = "add";
    feature.transform = { axis: "z", about: "centre", copy: false };
  }
  if (type === "hole") {
    const sketches = doc.features.filter((f) => f.type === "sketch" && !f.suppressed);
    feature.operation = "remove";
    feature.hole = { sketchRef: sketches[sketches.length - 1]?.id, kind: "simple", standard: "M3", fit: "clearance", end: "throughAll", flip: false };
    // Drills every part it reaches (as in Onshape), not just the latest.
    feature.apart = true;
  }
  if (type === "mirror" || type === "linearPattern" || type === "circularPattern" || type === "curvePattern") {
    feature.operation = "add";
    const solids = doc.features.filter((f) => isSolidFeature(f.type) && !f.suppressed);
    const sources = solids.length ? [solids[solids.length - 1].id] : [];
    if (type === "mirror") feature.mirror = { sources, plane: { kind: "default", name: "Right" } };
    else feature.pattern = { sources, axis: type === "circularPattern" ? "z" : "x", flip: false };
    if (type === "curvePattern") {
      const sketches = doc.features.filter((f) => f.type === "sketch" && !f.suppressed);
      feature.pathRef = sketches[sketches.length - 1]?.id;
    }
  }
  if (type === "fillet" || type === "chamfer" || type === "shell") {
    feature.operation = "add";
    feature.picks = [];
  }
  return feature;
}

export function addFeature(doc: JuraCADDocument, feature: Feature): JuraCADDocument {
  return { ...doc, features: [...doc.features, feature] };
}

export function replaceFeature(doc: JuraCADDocument, feature: Feature): JuraCADDocument {
  if (!doc.features.some((f) => f.id === feature.id)) return doc;
  return { ...doc, features: doc.features.map((f) => (f.id === feature.id ? feature : f)) };
}

export function removeFeature(doc: JuraCADDocument, id: string): JuraCADDocument {
  return { ...doc, features: doc.features.filter((f) => f.id !== id) };
}

export function renameFeature(doc: JuraCADDocument, id: string, name: string): JuraCADDocument {
  const trimmed = name.trim();
  const f = doc.features.find((x) => x.id === id);
  if (!f || !trimmed) return doc;
  return replaceFeature(doc, { ...f, name: trimmed });
}

/** Put features in a folder of the feature list (or, with null, take them out). */
export function setFolder(doc: JuraCADDocument, ids: string[], folder: string | null): JuraCADDocument {
  const name = folder?.trim().slice(0, 60) || null;
  const set = new Set(ids);
  return {
    ...doc,
    features: doc.features.map((f) => {
      if (!set.has(f.id)) return f;
      const { folder: _old, ...rest } = f;
      return name ? { ...rest, folder: name } : rest;
    }),
  };
}

/** Rename a folder (every feature in it). */
export function renameFolder(doc: JuraCADDocument, from: string, to: string): JuraCADDocument {
  const name = to.trim().slice(0, 60);
  if (!name || name === from) return doc;
  return { ...doc, features: doc.features.map((f) => (f.folder === from ? { ...f, folder: name } : f)) };
}

/** A free folder name: "Folder 1", "Folder 2"… */
export function nextFolderName(features: readonly Feature[]): string {
  const used = new Set(features.map((f) => f.folder).filter(Boolean));
  let n = 1;
  while (used.has(`Folder ${n}`)) n++;
  return `Folder ${n}`;
}

export function setSuppressed(doc: JuraCADDocument, id: string, suppressed: boolean): JuraCADDocument {
  const f = doc.features.find((x) => x.id === id);
  if (!f) return doc;
  return replaceFeature(doc, { ...f, suppressed });
}

/** The feature list with an unsaved draft swapped in (or appended), for live preview. */
/**
 * What to build for a Part Studio rolled back to `rollbackTo` (Onshape's
 * rollback bar): the features up to and including it, plus a new feature being
 * made (it goes in at the rollback point). Null = everything.
 */
export function featuresToBuild(features: Feature[], draft: Feature | null, rollbackTo: string | null): Feature[] {
  const all = featuresWithDraft(features, draft);
  const at = rollbackTo ? features.findIndex((f) => f.id === rollbackTo) : -1;
  if (at < 0) return all;
  const kept = all.slice(0, at + 1);
  if (draft && !kept.some((f) => f.id === draft.id) && !features.some((f) => f.id === draft.id)) kept.push(draft);
  return kept;
}

/** Add a feature just after another (at the end if that one isn't there). */
export function insertFeatureAfter(doc: JuraCADDocument, feature: Feature, afterId: string | null): JuraCADDocument {
  const at = afterId ? doc.features.findIndex((f) => f.id === afterId) : -1;
  if (at < 0) return addFeature(doc, feature);
  return { ...doc, features: [...doc.features.slice(0, at + 1), feature, ...doc.features.slice(at + 1)] };
}

/**
 * A feature being edited, as previewed: a hole's modelled thread takes seconds
 * to cut, so the preview shows the plain hole and the thread is cut on Accept.
 */
export function previewOf(draft: Feature | null): Feature | null {
  if (!draft?.hole?.modelThread) return draft;
  const { modelThread: _m, ...hole } = draft.hole;
  return { ...draft, hole };
}

/** While a feature is being edited: every hole previewed without its modelled thread (so a drag doesn't re-cut them all). */
export function previewFeatures(features: Feature[]): Feature[] {
  return features.some((f) => f.hole?.modelThread) ? features.map((f) => previewOf(f)!) : features;
}

export function featuresWithDraft(features: Feature[], draft: Feature | null): Feature[] {
  if (!draft) return features;
  return features.some((f) => f.id === draft.id)
    ? features.map((f) => (f.id === draft.id ? draft : f))
    : [...features, draft];
}

// ---------------------------------------------------------------------------
// Undo / redo history

export interface History {
  past: JuraCADDocument[];
  present: JuraCADDocument;
  future: JuraCADDocument[];
}

const HISTORY_LIMIT = 200;

export function historyOf(doc: JuraCADDocument): History {
  return { past: [], present: doc, future: [] };
}

/** Record a change. No-op when nothing actually changed (e.g. a dialog accepted without edits). */
export function commit(h: History, next: JuraCADDocument): History {
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

/**
 * Give a part a name (an empty name goes back to "Part N"). Copies of it in
 * assemblies that still carry the old name ("Part 1 <2>") follow the new one.
 */
export function renamePart(doc: JuraCADDocument, partId: string, oldName: string, newName: string): JuraCADDocument {
  const name = newName.trim().slice(0, 80);
  const names = { ...(doc.partNames ?? {}) };
  if (name) names[partId] = name;
  else delete names[partId];
  const { partNames: _old, ...rest } = doc;
  const shown = name || oldName;
  const assemblies = doc.assemblies?.map((a) => ({
    ...a,
    instances: a.instances.map((i) => {
      if (i.partId !== partId) return i;
      const m = /^(.*) <(\d+)>$/.exec(i.name);
      return m && m[1] === oldName ? { ...i, name: `${shown} <${m[2]}>` } : i;
    }),
  }));
  return { ...rest, ...(Object.keys(names).length ? { partNames: names } : {}), ...(assemblies ? { assemblies } : {}) };
}

function parsePartNames(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string" && v.trim()) out[id] = v.trim().slice(0, 80);
  return out;
}

// ---------------------------------------------------------------------------
// Loading saved documents safely

function parseImportedFile(raw: unknown): ImportedFile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.format !== "step" && r.format !== "stl") return null;
  if (typeof r.data !== "string" || !r.data) return null;
  return {
    fileName: typeof r.fileName === "string" ? r.fileName : r.format === "step" ? "model.step" : "model.stl",
    format: r.format,
    data: r.data,
    units: r.units === "in" ? "in" : "mm",
  };
}

/** A pattern's skipped copies: whole numbers from 2 up (1 is the original), each once, in order. */
function skipList(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((x): x is number => typeof x === "number" && Number.isInteger(x) && x >= 2 && x <= 10000))].sort((a, b) => a - b);
}

const FEATURE_TYPES = new Set<string>(Object.keys(FEATURE_DEFS));
const OPERATIONS = new Set<string>(["new", "add", "remove", "intersect"]);

/** Check one Part Studio's features from untrusted JSON (ids must be unique across the document: `seen`). */
function parseFeatures(list: unknown[], seen: Set<string>): Feature[] | null {
  const features: Feature[] = [];
  for (const raw of list) {
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
    const feature: Feature = {
      id: f.id,
      name: f.name,
      type: f.type as FeatureType,
      operation: f.operation === "add" || f.operation === "remove" || f.operation === "intersect" ? f.operation : "new",
      suppressed: f.suppressed === true,
      params: { ...defaultParams(f.type as FeatureType), ...params },
      ...(typeof f.folder === "string" && f.folder.trim() ? { folder: f.folder.trim().slice(0, 60) } : {}),
      // Shown or hidden with the eye (sketches and planes only; missing = automatic).
      ...((f.type === "sketch" || f.type === "plane") && typeof f.visible === "boolean" ? { visible: f.visible } : {}),
    };
    if (feature.type === "sketch") {
      const sk = f.sketch as Record<string, unknown> | undefined;
      const data = parseSketchData(sk?.data);
      if (!data) return null;
      feature.sketch = { plane: sk?.plane === null ? null : parsePlane(sk?.plane), data };
    }
    if (feature.type === "extrude") {
      if (typeof f.sketchRef === "string") feature.sketchRef = f.sketchRef;
      const ex = f.extrude as Record<string, unknown> | undefined;
      const upTo = parsePick(ex?.upTo);
      const ends = ["symmetric", "throughAll", "upToFace", "upToNext", "upToVertex", "upToPart"] as const;
      feature.extrude = {
        end: ends.find((e) => e === ex?.end) ?? "blind",
        flip: ex?.flip === true,
        ...(upTo ? { upTo } : {}),
        ...(ex?.upToEnd === "a" || ex?.upToEnd === "b" ? { upToEnd: ex.upToEnd } : {}),
        ...(ex?.second === true ? { second: true } : {}),
      };
    }
    const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    if (feature.type === "linearPattern" || feature.type === "circularPattern" || feature.type === "curvePattern") {
      const pt = f.pattern as Record<string, unknown> | undefined;
      const axis = pt?.axis === "y" || pt?.axis === "z" ? pt.axis : pt?.axis === "x" ? "x" : feature.type === "circularPattern" ? "z" : "x";
      const axis2 = pt?.axis2 === "x" || pt?.axis2 === "y" || pt?.axis2 === "z" ? pt.axis2 : undefined;
      feature.pattern = {
        sources: ids(pt?.sources),
        axis,
        flip: pt?.flip === true,
        ...(pt?.follow === true ? { follow: true } : {}),
        ...(feature.type === "linearPattern" && axis2 ? { axis2 } : {}),
        ...(feature.type === "linearPattern" && pt?.flip2 === true ? { flip2: true } : {}),
        ...(feature.type !== "curvePattern" && parsePick(pt?.along) ? { along: parsePick(pt?.along)! } : {}),
        ...(feature.type === "linearPattern" && parsePick(pt?.along2) ? { along2: parsePick(pt?.along2)! } : {}),
        ...(feature.type !== "curvePattern" && parseLineRef(pt?.line) ? { line: parseLineRef(pt?.line)! } : {}),
        ...(feature.type === "linearPattern" && parseLineRef(pt?.line2) ? { line2: parseLineRef(pt?.line2)! } : {}),
        ...(feature.type !== "curvePattern" && pt?.unset === true ? { unset: true } : {}),
        ...(skipList(pt?.skip).length ? { skip: skipList(pt?.skip) } : {}),
      };
      if (feature.type === "curvePattern" && typeof f.pathRef === "string") feature.pathRef = f.pathRef;
    }
    if (feature.type === "mirror") {
      const mr = f.mirror as Record<string, unknown> | undefined;
      feature.mirror = {
        sources: ids(mr?.sources),
        plane: parsePlane(mr?.plane) ?? { kind: "default", name: "Right" },
        ...(parsePick(mr?.planePick) ? { planePick: parsePick(mr?.planePick)! } : {}),
        ...(parseLineRef(mr?.line) ? { line: parseLineRef(mr?.line)! } : {}),
        ...(mr?.unset === true ? { unset: true } : {}),
        ...(typeof mr?.part === "string" ? { part: mr.part } : {}),
        ...(mr?.join === true ? { join: true } : {}),
      };
    }
    if (feature.type === "transform") {
      const t = (f.transform ?? {}) as Record<string, unknown>;
      feature.transform = {
        ...(typeof t.partId === "string" ? { partId: t.partId } : {}),
        axis: t.axis === "x" || t.axis === "y" ? t.axis : "z",
        about: t.about === "origin" ? "origin" : "centre",
        copy: t.copy === true,
      };
      // Older designs turned about one chosen axis: that angle becomes the turn about that axis.
      if (typeof params.angle === "string" && params.rx === undefined && params.ry === undefined && params.rz === undefined) {
        feature.params[`r${feature.transform.axis}`] = params.angle;
      }
      delete feature.params.angle;
    }
    if (feature.type === "hole") {
      const h = (f.hole ?? {}) as Record<string, unknown>;
      feature.operation = "remove";
      feature.hole = {
        ...(typeof h.sketchRef === "string" ? { sketchRef: h.sketchRef } : {}),
        kind: h.kind === "counterbore" || h.kind === "countersink" ? h.kind : "simple",
        standard: typeof h.standard === "string" ? h.standard : "Custom",
        fit: h.fit === "tapped" ? "tapped" : "clearance",
        end: h.end === "blind" || h.end === "upToNext" ? h.end : "throughAll",
        flip: h.flip === true,
        ...(h.modelThread === true ? { modelThread: true } : {}),
        ...(h.bothWays === true ? { bothWays: true } : {}),
      };
    }
    if (feature.type === "sweep") {
      if (typeof f.sketchRef === "string") feature.sketchRef = f.sketchRef;
      if (typeof f.pathRef === "string") feature.pathRef = f.pathRef;
      const c = f.sweepControl as Record<string, unknown> | undefined;
      if (c && typeof c === "object" && c.lockOrientation === true) feature.sweepControl = { lockOrientation: true };
    }
    if (feature.type === "text") {
      const t = (f.text ?? {}) as Record<string, unknown>;
      feature.text = {
        value: typeof t.value === "string" ? t.value.slice(0, 500) : "",
        plane: t.plane === null ? null : parsePlane(t.plane) ?? { kind: "default", name: "Top" },
        bold: t.bold === true,
        flip: t.flip === true,
      };
      const face = parsePick(t.face);
      if (face && face.ref.kind === "face") feature.text.face = face;
    }
    if (feature.type === "split") {
      const sp = (f.splitDef ?? {}) as Record<string, unknown>;
      feature.splitDef = {
        ...(typeof sp.partId === "string" ? { partId: sp.partId } : {}),
        plane: parsePlane(sp.plane) ?? { kind: "default", name: "Right" },
        ...(typeof sp.toolPartId === "string" ? { toolPartId: sp.toolPartId } : {}),
        keep: sp.keep === "front" || sp.keep === "back" ? sp.keep : "both",
        picking: sp.picking === "plane" ? "plane" : "part",
      };
    }
    if (feature.type === "replaceFace") {
      const rd = (f.replaceDef ?? {}) as Record<string, unknown>;
      feature.replaceDef = { target: rd.target ? parsePlane(rd.target) ?? null : null, picking: rd.picking === "target" ? "target" : "faces" };
    }
    if ((feature.type === "rib" || feature.type === "sheetMetal" || feature.type === "tab" || feature.type === "wrap" || feature.type === "bend" || feature.type === "jog") && typeof f.sketchRef === "string") feature.sketchRef = f.sketchRef;
    if ((feature.type === "sheetMetal" || feature.type === "flange" || feature.type === "hem" || feature.type === "bend" || feature.type === "jog") && f.flipSide === true) feature.flipSide = true;
    if ((feature.type === "bend" || feature.type === "jog") && f.keepOtherSide === true) feature.keepOtherSide = true;
    if ((feature.type === "flange" || feature.type === "hem") && f.mitreCorners === true) feature.mitreCorners = true;
    if (feature.type === "flange" && f.closeCorners === true) feature.closeCorners = true;
    if (feature.type === "flange" && (f.reliefShape === "round" || f.reliefShape === "tear")) feature.reliefShape = f.reliefShape;
    if (feature.type === "flange" && (f.cornerRelief === "round" || f.cornerRelief === "square")) feature.cornerRelief = f.cornerRelief;
    if (feature.type === "flange" && (f.flangePosition === "outside" || f.flangePosition === "inside")) feature.flangePosition = f.flangePosition;
    if ((feature.type === "rib" || feature.type === "thicken") && f.flipSide === true) feature.flipSide = true;
    if (feature.type === "thicken" && f.bothSides === true) feature.bothSides = true;
    if (feature.type === "cornerBreak" && f.breakStyle === "chamfer") feature.breakStyle = "chamfer";
    if (feature.type === "deleteFace" && f.leaveOpen === true) feature.leaveOpen = true;
    if (feature.type === "fill" && f.continuity === "tangent") feature.continuity = "tangent";
    if (feature.type === "extendSurface" && f.extendTo && typeof f.extendTo === "object") {
      const et = f.extendTo as Record<string, unknown>;
      const target = parsePick(et.target);
      if (et.mode === "face" || et.mode === "part") feature.extendTo = { mode: et.mode, ...(target ? { target } : {}) };
    }
    if (feature.type === "derived") {
      const dv = (f.derived ?? {}) as Record<string, unknown>;
      if (typeof dv.studioId === "string" && typeof dv.partId === "string") feature.derived = { studioId: dv.studioId, partId: dv.partId };
    }
    if (feature.type === "fastener") {
      const fa = (f.fastener ?? {}) as Record<string, unknown>;
      feature.fastener = {
        kind: FASTENER_KINDS.includes(fa.kind as FastenerKind) ? (fa.kind as FastenerKind) : "bolt",
        size: typeof fa.size === "string" && FASTENER_SIZES.some((s) => s.name === fa.size) ? fa.size : "M6",
        threaded: fa.threaded === true,
      };
    }
    if (feature.type === "deletePart") {
      feature.deleteParts = Array.isArray(f.deleteParts) ? (f.deleteParts as unknown[]).filter((x): x is string => typeof x === "string") : [];
    }
    if (feature.type === "boolean") {
      const b = (f.booleanDef ?? {}) as Record<string, unknown>;
      feature.booleanDef = {
        op: b.op === "subtract" || b.op === "intersect" ? b.op : "union",
        targets: ids(b.targets),
        tools: ids(b.tools),
        keepTools: b.keepTools === true,
        picking: b.picking === "tools" ? "tools" : "targets",
      };
    }
    if (feature.type === "plane") {
      const pd = (f.planeDef ?? {}) as Record<string, unknown>;
      const ref2 = parsePlane(pd.ref2);
      feature.planeDef = {
        mode: pd.mode === "angle" || pd.mode === "midplane" ? pd.mode : "offset",
        ref: parsePlane(pd.ref) ?? { kind: "default", name: "Top" },
        ...(ref2 ? { ref2 } : {}),
        axis: pd.axis === "v" ? "v" : "u",
      };
    }
    if (feature.type === "loft") feature.sections = Array.isArray(f.sections) ? f.sections.filter((x): x is string => typeof x === "string") : [];
    if (feature.type === "revolve") {
      if (typeof f.sketchRef === "string") feature.sketchRef = f.sketchRef;
      const rv = f.revolve as Record<string, unknown> | undefined;
      feature.revolve = { axis: typeof rv?.axis === "string" ? rv.axis : "vertical", flip: rv?.flip === true, ...(rv?.symmetric === true ? { symmetric: true } : {}) };
    }
    if (feature.type === "import") {
      const im = parseImportedFile(f.import);
      if (!im) return null;
      feature.import = im;
    }
    if (feature.type === "draft" || feature.type === "ruled") feature.neutral = parsePlane(f.neutral) ?? { kind: "default", name: "Top" };
    if ((feature.type === "draft" || feature.type === "ruled") && f.flipSide === true) feature.flipSide = true;
    if (feature.type === "coil" && f.flipSide === true) feature.flipSide = true;
    if (feature.type === "shell" && f.hollow === true) feature.hollow = true;
    if ((feature.type === "shell" || feature.type === "chamfer") && f.flipSide === true) feature.flipSide = true;
    if (feature.type === "chamfer" && (f.chamferType === "twoDistances" || f.chamferType === "distanceAngle")) feature.chamferType = f.chamferType;
    if ((feature.type === "extrude" || feature.type === "revolve" || feature.type === "sweep" || feature.type === "loft") && f.surface === true) feature.surface = true;
    if (feature.type === "extrude" || feature.type === "revolve" || feature.type === "sweep") {
      // Picked sketch areas: a point inside each, and (newer files) its size. Anything else is dropped, leaving every closed shape.
      const areas = Array.isArray(f.areas)
        ? f.areas
            .filter(
              (p): p is (number | string)[] =>
                Array.isArray(p) &&
                p.length >= 2 &&
                p.length <= 100_000 &&
                [p[0], p[1], ...(p.length >= 3 ? [p[2]] : [])].every((x) => typeof x === "number" && Number.isFinite(x)) &&
                p.slice(3).every((x) => typeof x === "string" && /^.{1,200}[+-]$/.test(x)),
            )
            .map((p): AreaPick => {
              const [x, y, size] = p as number[];
              // The size (and signature) only count with a real size; otherwise just the point, as older files had.
              return p.length >= 3 && size > 0 ? [x, y, size, ...(p.slice(3) as string[])] : [x, y];
            })
        : [];
      if (areas.length) feature.areas = areas;
    }
    if ((feature.type === "extrude" || feature.type === "revolve" || feature.type === "sweep" || feature.type === "hole") && f.apart === true) feature.apart = true;
    if (["fillet", "chamfer", "shell", "thicken", "draft", "moveFace", "replaceFace", "deleteFace", "thread", "flange", "hem", "fullRound", "wrap", "fill", "enclose", "offsetSurface", "extendSurface", "ruled", "cornerBreak"].includes(feature.type)) {
      feature.picks = Array.isArray(f.picks) ? f.picks.map(parsePick).filter((p): p is NonNullable<typeof p> => p !== null) : [];
    }
    features.push(feature);
  }
  return features;
}

/** Check untrusted JSON (e.g. from browser storage) and return a clean document, or null. */
/** Saved configurations, and which is on show. */
function configurationsOf(d: Record<string, unknown>): Pick<JuraCADDocument, "configurations" | "activeConfiguration"> {
  const configurations = parseConfigurations(d.configurations);
  if (!configurations.length) return {};
  const active = configurations.find((c) => c.id === d.activeConfiguration)?.id ?? configurations[0].id;
  return { configurations, activeConfiguration: active };
}

export function parseDocument(data: unknown): JuraCADDocument | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  // The format id stays "partsmith" (the app's old name), so old and new files both open.
  if (d.format !== "partsmith" || d.version !== 1 || !Array.isArray(d.features)) return null;
  const seen = new Set<string>();
  const features = parseFeatures(d.features, seen);
  if (!features) return null;
  const partStudios: PartStudio[] = [];
  for (const raw of Array.isArray(d.partStudios) ? d.partStudios : []) {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id === MAIN_STUDIO || partStudios.some((x) => x.id === r.id) || !Array.isArray(r.features)) continue;
    const list = parseFeatures(r.features, seen);
    if (!list) return null;
    const hidden = parseHiddenDatums(r.hiddenDatums);
    partStudios.push({ id: r.id, name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : "Part Studio", features: list, ...(hidden ? { hiddenDatums: hidden } : {}) });
  }
  return {
    format: "partsmith",
    version: 1,
    name: typeof d.name === "string" && d.name.trim() ? d.name : "Untitled part",
    features,
    ...(Array.isArray(d.variables) && d.variables.length ? { variables: parseVariables(d.variables) } : {}),
    ...(Object.keys(parseAppearance(d.appearance)).length ? { appearance: parseAppearance(d.appearance) } : {}),
    ...(Object.keys(parseMaterials(d.materials)).length ? { materials: parseMaterials(d.materials) } : {}),
    ...(d.units === "in" ? { units: "in" as const } : {}),
    ...(typeof d.studioName === "string" && d.studioName.trim() && d.studioName.trim() !== "Part Studio 1" ? { studioName: d.studioName.trim() } : {}),
    ...(parseHiddenDatums(d.hiddenDatums) ? { hiddenDatums: parseHiddenDatums(d.hiddenDatums) } : {}),
    ...(partStudios.length ? { partStudios } : {}),
    ...(Object.keys(parsePartNames(d.partNames)).length ? { partNames: parsePartNames(d.partNames) } : {}),
    ...(Object.keys(parsePartProperties(d.partProperties)).length ? { partProperties: parsePartProperties(d.partProperties) } : {}),
    ...(parseAssemblies(d.assemblies).length ? { assemblies: parseAssemblies(d.assemblies) } : {}),
    ...(parseDrawings(d.drawings).length ? { drawings: parseDrawings(d.drawings) } : {}),
    ...configurationsOf(d),
  };
}
