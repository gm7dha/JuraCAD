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
import { contextInputs } from "../assembly/featureParse";

/** One feature without the parts the engine doesn't need (the same object when there are none). */
export function featureForEngine<T extends Feature | null>(f: T): T {
  if (!f || (f.folder === undefined && f.visible === undefined && !f.sketch?.data.images && f.loft?.picking === undefined && f.boundary?.picking === undefined && f.blend?.picking === undefined && f.trimFrame?.picking === undefined)) return f;
  const { folder: _f, visible: _v, ...rest } = f;
  // What a click in the view chooses while the Loft dialog is open isn't geometry.
  if (rest.loft?.picking !== undefined) {
    const { picking: _p, ...loft } = rest.loft;
    if (Object.keys(loft).length) rest.loft = loft;
    else delete rest.loft;
  }
  // Nor which side / direction a Face blend's or Boundary surface's click goes to.
  if (rest.boundary?.picking !== undefined) {
    const { picking: _p, ...boundary } = rest.boundary;
    rest.boundary = boundary;
  }
  if (rest.blend?.picking !== undefined) {
    const { picking: _p, ...blend } = rest.blend;
    rest.blend = blend;
  }
  // Trim frame's "what a click picks" isn't geometry either.
  if (rest.trimFrame?.picking !== undefined) {
    const { picking: _t, ...trim } = rest.trimFrame;
    rest.trimFrame = trim;
  }
  if (!rest.sketch?.data.images) return rest as T;
  const { images: _i, ...data } = rest.sketch.data;
  return { ...rest, sketch: { ...rest.sketch, data } } as T;
}

const cache = new WeakMap<Feature[], Feature[]>();
/** A Part Studio's features for the engine (the same array each time for the same list). */
export function featuresForEngine(list: Feature[]): Feature[] {
  if (!list.some((f) => f.folder !== undefined || f.visible !== undefined || f.sketch?.data.images || f.loft?.picking !== undefined || f.boundary?.picking !== undefined || f.blend?.picking !== undefined || f.trimFrame?.picking !== undefined)) return list;
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

/** What's added to an old version's Part Studio ids and part ids while it's compared ("<studio>@version:<id>"). */
export const versionSuffix = (versionId: string) => `@version:${versionId}`;

/**
 * An old version's Part Studios, to build beside the design while comparing
 * (the parts carry `configuration: "version:<id>"`, so no Part Studio,
 * assembly or parts list shows them as the design's own). Each is built with
 * the version's own variable values.
 */
export function compareStudioInputs(versionId: string, doc: JuraCADDocument): StudioInput[] {
  const variables = resolveVariables(doc.variables).values;
  const suffix = versionSuffix(versionId);
  const studios = studiosOf(doc);
  const ids = new Set(studios.map((st) => st.id));
  // Parts brought in from another Part Studio (Derived) come from the version's own copy of it.
  const own = (f: Feature): Feature =>
    f.type === "derived" && f.derived && ids.has(f.derived.studioId) ? { ...f, derived: { studioId: f.derived.studioId + suffix, partId: f.derived.partId + suffix } } : f;
  return studios.map((st) => ({
    id: st.id + suffix,
    features: featuresForEngine(st.features).map(own),
    variables,
    partSuffix: suffix,
    // The parts are named as the version named them.
    partNames: doc.partNames ?? {},
  }));
}

/** Everything in a document to build: every Part Studio, and those shown in other configurations. */
export function documentStudioInputs(doc: JuraCADDocument): StudioInput[] {
  return [...studiosOf(doc).map((st) => withContexts(doc, { id: st.id, features: featuresForEngine(st.features) })), ...configuredStudioInputs(doc)];
}

/** A Part Studio's input with its Edit in context parts, if it has any (else the same object, so nothing changes). */
export function withContexts(doc: Pick<JuraCADDocument, "contexts">, input: StudioInput): StudioInput {
  const contexts = doc.contexts?.length ? contextInputs(doc, input.id) : undefined;
  return contexts ? { ...input, contexts } : input;
}
