/**
 * What the geometry engine is given for a Part Studio's features: only what
 * changes the shapes. Folders (the feature list's tidying), pictures in
 * sketches (only for tracing over) and the eye (`visible`: shown or hidden in
 * the 3D view) are left out, so the engine's cache key — the features as JSON —
 * stays the same when they change, and nothing is rebuilt. Pure (no store).
 */
import type { Feature } from "../model/types";

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
