/**
 * What's shown in the 3D view besides parts: sketches, Plane features, and the
 * Origin with the Top/Front/Right planes. Saved in the file (all optional, so
 * older files open as they always looked, give or take used sketches — see
 * `sketchVisible`).
 *
 * Like Onshape: a sketch hides by itself once a feature uses it (an extrude,
 * a sweep's profile or path, a loft, a hole's points…); the eye in the feature
 * list shows or hides it for good. Planes are shown until hidden.
 */
import { inStudio, MAIN_STUDIO, studioFeatures } from "./studios";
import type { DatumName, Feature, JuraCADDocument } from "./types";

export const DATUM_NAMES: readonly DatumName[] = ["Origin", "Top", "Front", "Right"];
const NO_DATUMS: DatumName[] = [];

const usedCache = new WeakMap<Feature[], Set<string>>();

/** The sketches that some (unsuppressed) feature uses (worked out once per list of features). */
export function usedSketches(features: Feature[]): Set<string> {
  const known = usedCache.get(features);
  if (known) return known;
  const used = new Set<string>();
  usedCache.set(features, used);
  for (const f of features) {
    if (f.suppressed || f.type === "sketch") continue;
    if (f.sketchRef) used.add(f.sketchRef);
    if (f.pathRef) used.add(f.pathRef);
    if (f.hole?.sketchRef) used.add(f.hole.sketchRef);
    for (const id of f.sections ?? []) used.add(id);
  }
  return used;
}

/** Whether a sketch is drawn in the 3D view: as the eye says, or (not set) only while nothing uses it. */
export function sketchVisible(feature: Feature, used: Set<string>): boolean {
  return feature.visible ?? !used.has(feature.id);
}

/** Whether a Plane feature is drawn (and can be clicked) in the 3D view. */
export function planeVisible(feature: Feature): boolean {
  return feature.visible !== false;
}

/** Whether the eye shows a feature (sketch or plane) as visible. */
export function featureVisible(feature: Feature, features: Feature[]): boolean {
  if (feature.type === "sketch") return sketchVisible(feature, usedSketches(features));
  return planeVisible(feature);
}

/** Features with an eye in the feature list. */
export function hasEye(feature: Pick<Feature, "type">): boolean {
  return feature.type === "sketch" || feature.type === "plane";
}

/** Show or hide some sketches/planes of the features given (other features are left alone). */
export function setFeaturesVisible(doc: JuraCADDocument, ids: string[], visible: boolean): JuraCADDocument {
  const pick = new Set(ids);
  let changed = false;
  const features = doc.features.map((f) => {
    if (!pick.has(f.id) || !hasEye(f) || f.visible === visible) return f;
    changed = true;
    return { ...f, visible };
  });
  return changed ? { ...doc, features } : doc;
}

/**
 * A feature being edited, with the eye as it is in the document now (it may
 * have been clicked, or "Show all sketches" used, while the edit was open).
 */
export function keepVisibility(doc: JuraCADDocument, draft: Feature): Feature {
  const live = doc.features.find((f) => f.id === draft.id);
  if (!live || !hasEye(live) || live.visible === draft.visible) return draft;
  const { visible: _, ...rest } = draft;
  return live.visible === undefined ? rest : { ...rest, visible: live.visible };
}

/** "Show all sketches" / "Hide all sketches" (in the Part Studio whose features are `doc.features`). */
export function setAllSketchesVisible(doc: JuraCADDocument, visible: boolean): JuraCADDocument {
  return setFeaturesVisible(
    doc,
    doc.features.filter((f) => f.type === "sketch").map((f) => f.id),
    visible,
  );
}

/** Of the Origin and default planes, the ones hidden in a Part Studio (the same array each time: safe in selectors). */
export function hiddenDatumsOf(doc: JuraCADDocument, studioId: string): DatumName[] {
  if (studioId === MAIN_STUDIO) return doc.hiddenDatums ?? NO_DATUMS;
  return doc.partStudios?.find((s) => s.id === studioId)?.hiddenDatums ?? NO_DATUMS;
}

/** Show or hide the Origin or a default plane in a Part Studio. */
export function setDatumHidden(doc: JuraCADDocument, studioId: string, datum: DatumName, hidden: boolean): JuraCADDocument {
  const now = hiddenDatumsOf(doc, studioId);
  if (now.includes(datum) === hidden) return doc;
  // Kept in the usual order, and left out of the file when nothing is hidden.
  const next = DATUM_NAMES.filter((d) => (d === datum ? hidden : now.includes(d)));
  if (studioId === MAIN_STUDIO) {
    const { hiddenDatums: _, ...rest } = doc;
    return next.length ? { ...rest, hiddenDatums: next } : rest;
  }
  return {
    ...doc,
    partStudios: (doc.partStudios ?? []).map((s) => {
      if (s.id !== studioId) return s;
      const { hiddenDatums: _, ...rest } = s;
      return next.length ? { ...rest, hiddenDatums: next } : rest;
    }),
  };
}

/** The default planes (the Origin isn't a plane: P leaves it alone, as in Onshape). */
export const DEFAULT_PLANES: readonly DatumName[] = ["Top", "Front", "Right"];

/**
 * Whether any plane of a Part Studio is shown: Top, Front, Right or a Plane
 * feature (suppressed ones aren't drawn, so they don't count).
 */
export function anyPlaneShown(doc: JuraCADDocument, studioId: string): boolean {
  const hidden = hiddenDatumsOf(doc, studioId);
  if (DEFAULT_PLANES.some((d) => !hidden.includes(d))) return true;
  return studioFeatures(doc, studioId).some((f) => f.type === "plane" && !f.suppressed && planeVisible(f));
}

/** "Show all planes" / "Hide all planes": Top, Front, Right and every Plane feature of a Part Studio. */
export function setAllPlanesVisible(doc: JuraCADDocument, studioId: string, visible: boolean): JuraCADDocument {
  let out = DEFAULT_PLANES.reduce((d, name) => setDatumHidden(d, studioId, name, !visible), doc);
  out = inStudio(out, studioId, (view) =>
    setFeaturesVisible(
      view,
      view.features.filter((f) => f.type === "plane").map((f) => f.id),
      visible,
    ),
  );
  return out;
}

/** The P key (as in Onshape): if any plane is shown, hide them all; otherwise show them all. */
export function toggleAllPlanes(doc: JuraCADDocument, studioId: string): { doc: JuraCADDocument; visible: boolean } {
  const visible = !anyPlaneShown(doc, studioId);
  return { doc: setAllPlanesVisible(doc, studioId, visible), visible };
}

/** A saved list of hidden datums, cleaned up (unknown names and repeats dropped); undefined when there's nothing. */
export function parseHiddenDatums(raw: unknown): DatumName[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = DATUM_NAMES.filter((d) => raw.includes(d));
  return out.length ? out : undefined;
}
