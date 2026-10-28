/**
 * What the geometry engine is given for a Part Studio's features: only what
 * changes the shapes. Folders (the feature list's tidying), pictures in
 * sketches (only for tracing over) and the eye (`visible`: shown or hidden in
 * the 3D view) are left out, so the engine's cache key — the features as JSON —
 * stays the same when they change, and nothing is rebuilt. Pure (no store).
 */
import type { Feature, JuraCADDocument } from "../model/types";
import type { StudioInput } from "./protocol";
import { configurationsInUse } from "../assembly/configured";
import { switchConfiguration } from "../model/configurations";
import { resolveVariables } from "../model/variables";
import { setCurrentScope } from "../model/expr";
import { studiosOf } from "../model/studios";

/** One feature without the parts the engine doesn't need (the same object when there are none). */
export function featureForEngine<T extends Feature | null>(f: T): T {
  if (!f || (f.folder === undefined && f.visible === undefined && !f.sketch?.data.images)) return f;
  const { folder: _f, visible: _v, ...rest } = f;
  if (!rest.sketch?.data.images) return rest as T;
  const { images: _i, ...data } = rest.sketch.data;
  return { ...rest, sketch: { ...rest.sketch, data } } as T;
}

const cache = new WeakMap<Feature[], Feature[]>();
/** A Part Studio's features for the engine (the same array each time for the same list). */
export function featuresForEngine(list: Feature[]): Feature[] {
  if (!list.some((f) => f.folder !== undefined || f.visible !== undefined || f.sketch?.data.images)) return list;
  let out = cache.get(list);
  if (!out) {
    out = list.map(featureForEngine);
    cache.set(list, out);
  }
  return out;
}

/**
 * Part Studios that assemblies show in another configuration, to be built
 * again in it ("<studio>@<configuration>", their parts' ids ending
 * "@<configuration>"). Working them out changes the values boxes use, so the
 * document's own values are put back afterwards.
 */
export function configuredStudioInputs(doc: JuraCADDocument): StudioInput[] {
  const list: StudioInput[] = [];
  for (const { studioId, configurationId } of configurationsInUse(doc)) {
    const shown = switchConfiguration(doc, configurationId);
    const studio = studiosOf(shown).find((x) => x.id === studioId);
    if (!studio) continue;
    list.push({ id: `${studioId}@${configurationId}`, features: featuresForEngine(studio.features), variables: resolveVariables(shown.variables).values, partSuffix: `@${configurationId}` });
  }
  if (list.length) setCurrentScope(resolveVariables(doc.variables).values);
  return list;
}

/** Everything in a document to build: every Part Studio, and those shown in other configurations. */
export function documentStudioInputs(doc: JuraCADDocument): StudioInput[] {
  return [...studiosOf(doc).map((st) => ({ id: st.id, features: featuresForEngine(st.features) })), ...configuredStudioInputs(doc)];
}
