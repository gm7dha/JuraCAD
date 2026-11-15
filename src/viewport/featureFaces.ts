/**
 * Faces and the features that made them, in the 3D view (Onshape's): hovering a feature's row lights up the faces
 * it made (or its parts), double-clicking a face opens the feature that made it, and Select other offers "Edit …"
 * for the face under the pointer. The hovered row lives in a tiny store of its own (session only).
 */
import { useSyncExternalStore } from "react";

import { featureOfFace } from "../model/featureSearch";
import { activeAssembly, activeDrawing, activeFeatures, studioParts, useStore } from "../model/store";
import type { PickTarget } from "./SceneManager";

let hovered: string | null = null;
const listeners = new Set<() => void>();

/** The feature row under the pointer in the feature list (null = none). */
export function setHoveredFeature(id: string | null): void {
  if (hovered === id) return;
  hovered = id;
  for (const l of listeners) l();
}

export function useHoveredFeature(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => hovered,
    () => null,
  );
}

/** The feature that made a face of a part on show in the Part Studio (null when it can't be told, or not now). */
export function featureForFace(partId: string, index: number): { id: string; name: string } | null {
  const s = useStore.getState();
  if (s.editing || s.sketch || s.versionView || activeAssembly(s) || activeDrawing(s)) return null;
  const part = studioParts(s).find((p) => p.id === partId);
  if (!part) return null;
  const features = activeFeatures(s);
  const id = featureOfFace(part, index, features);
  const f = id ? features.find((x) => x.id === id) : undefined;
  return f ? { id: f.id, name: f.name } : null;
}

/** A double-click in the view: on a face, open the feature that made it for editing. */
export function editFeatureAt(target: PickTarget | null): void {
  if (!target || target.kind !== "part" || target.item.kind !== "face" || target.whole) return;
  const found = featureForFace(target.item.partId, target.item.index);
  if (!found) return;
  useStore.getState().startEdit(found.id);
}
