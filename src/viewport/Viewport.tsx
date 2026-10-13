import { useEffect, useMemo, useRef } from "react";

import { indexOfRef, type TopoPick } from "../geometry/topoRef";
import { isPatternFeature, isPickFeature, isSketchSolid } from "../model/features";
import { pickFor, useStore, type SelectionItem } from "../model/store";
import type { PartMesh } from "../kernel/protocol";
import type { Feature } from "../model/types";
import { SketchController } from "../sketch/controller";
import { planeOnFace, type SketchPlane } from "../sketch/planes";
import { analyzeSketch, solveSketch, type SketchAnalysis } from "../sketch/solver";
import type { SketchData } from "../sketch/types";
import { SceneManager, type PickTarget } from "./SceneManager";

/** Lets keyboard shortcuts and toolbar buttons reach the 3D view. */
export const viewportApi: { current: SceneManager | null; sketch: SketchController | null } = { current: null, sketch: null };

// Analysing a sketch takes a few milliseconds; remember results per sketch version.
const analysisCache = new WeakMap<SketchData, { analysis: SketchAnalysis; failing: Set<string> }>();
export function sketchStatus(data: SketchData) {
  let r = analysisCache.get(data);
  if (!r) {
    const solved = solveSketch(data, { maxIterations: 0 });
    r = { analysis: analyzeSketch(data), failing: new Set(solved.failing) };
    analysisCache.set(data, r);
  }
  return r;
}

/** Sketch plane for a picked face, or null if it isn't flat. */
export function planeForFace(item: SelectionItem): SketchPlane | null {
  const s = useStore.getState();
  const flat = viewportApi.current?.flatFace(item);
  if (!flat) return null;
  const part = s.parts.find((p) => p.id === item.partId);
  return planeOnFace(flat.normal, flat.point, `Face of ${part?.name ?? "part"}`);
}

/** Apply a click in the viewport to the selection, like Onshape. */
function handlePick(target: PickTarget | null, additive: boolean) {
  const s = useStore.getState();
  // Choosing where a new sketch goes.
  if (s.sketch && s.editing?.draft.sketch && !s.editing.draft.sketch.plane) {
    if (target?.kind === "plane") s.setSketchPlane({ kind: "default", name: target.plane });
    else if (target?.kind === "part" && target.item.kind === "face") {
      const plane = planeForFace(target.item);
      if (plane) s.setSketchPlane(plane);
      else s.setSketchMessage("That face is curved. Pick a flat face or one of the planes.", "error");
    }
    return;
  }
  // Choosing the plane to mirror across.
  if (s.editing?.draft.type === "mirror") {
    if (target?.kind === "plane") s.setDraftMirrorPlane({ kind: "default", name: target.plane });
    else if (target?.kind === "part" && target.item.kind === "face") {
      const plane = planeForFace(target.item);
      if (plane) s.setDraftMirrorPlane(plane);
      else s.showToast("That face is curved. Pick a flat face or one of the planes to mirror across.");
    }
    return;
  }
  // Patterns pick their features in the list, not in the 3D view.
  if (s.editing && isPatternFeature(s.editing.draft.type)) return;
  // Picking edges and faces for a fillet, chamfer or shell.
  if (s.editing && isPickFeature(s.editing.draft.type)) {
    if (target?.kind !== "part") return;
    if (s.editing.draft.type === "shell" && target.item.kind !== "face") {
      s.showToast("Shell removes faces — click a face (such as the top) rather than an edge.");
      return;
    }
    const pick = pickFor(s.parts, target.item);
    if (pick) s.toggleDraftPick(pick);
    return;
  }
  const { selection: current, setSelection, selectPlane, selectedPlane } = s;
  if (!target) {
    if (!additive) {
      setSelection([]);
      selectPlane(null);
    }
    return;
  }
  if (target.kind === "plane") {
    // Clicking the selected plane again deselects it.
    selectPlane(selectedPlane === target.plane ? null : target.plane);
    return;
  }
  const item = target.item;
  const same = (x: SelectionItem) => x.partId === item.partId && x.kind === item.kind && x.index === item.index;
  if (additive) {
    setSelection(current.some(same) ? current.filter((x) => !same(x)) : [...current, item]);
  } else {
    setSelection(current.length === 1 && same(current[0]) ? [] : [item]);
  }
}

/** Where a fillet's picks are on the parts as shown now (for highlighting). */
function itemsForPicks(parts: PartMesh[], picks: TopoPick[]): SelectionItem[] {
  const items: SelectionItem[] = [];
  for (const pick of picks) {
    const part = parts.find((p) => p.id === pick.partId);
    if (!part) continue;
    const list = pick.ref.kind === "edge" ? part.edgeRefs : part.faceRefs;
    const index = indexOfRef(list ?? [], pick.ref);
    if (index >= 0) items.push({ partId: part.id, kind: pick.ref.kind, index });
  }
  return items;
}

/** Sketches to show faintly: finished ones that no extrude has used yet, or that are highlighted. */
function visibleSketches(features: Feature[], editingId: string | null, selectedId: string | null) {
  const used = new Set(features.filter((f) => isSketchSolid(f.type) && !f.suppressed && f.sketchRef).map((f) => f.sketchRef!));
  return features
    .filter((f) => f.type === "sketch" && !f.suppressed && f.sketch?.plane && f.id !== editingId && (!used.has(f.id) || f.id === selectedId))
    .map((f) => ({ plane: f.sketch!.plane!, data: f.sketch!.data }));
}

export function Viewport() {
  const containerRef = useRef<HTMLDivElement>(null);
  const parts = useStore((s) => s.parts);
  const selection = useStore((s) => s.selection);
  const picks = useStore((s) => (s.editing && isPickFeature(s.editing.draft.type) ? s.editing.draft.picks ?? null : null));
  const hiddenParts = useStore((s) => s.hiddenParts);
  const selectedPlane = useStore((s) => s.selectedPlane);
  const listHoverPlane = useStore((s) => s.listHoverPlane);
  const hiddenDatums = useStore((s) => s.hiddenDatums);
  const features = useStore((s) => s.history.present.features);
  const selectedFeatureId = useStore((s) => s.selectedFeatureId);
  const draft = useStore((s) => (s.editing?.draft.type === "sketch" ? s.editing.draft : null));
  const sketchSelection = useStore((s) => s.sketch?.selection);
  const plane = draft?.sketch?.plane ?? null;
  const sketchData = draft?.sketch?.data ?? null;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let manager: SceneManager;
    try {
      manager = new SceneManager(container, { onPick: handlePick });
    } catch (e) {
      useStore.getState().showToast(
        "Your browser couldn't start 3D graphics (WebGL). Try Chrome or Edge, and check hardware acceleration is on.",
        "error",
      );
      console.error(e);
      return;
    }
    viewportApi.current = manager;
    // Show whatever is already built (e.g. after a hot reload).
    const s = useStore.getState();
    manager.setHidden(s.hiddenParts);
    manager.setParts(s.parts);
    manager.setSelection(s.selection);
    manager.setDatums({ selected: s.selectedPlane, listHover: s.listHoverPlane, hidden: s.hiddenDatums });
    return () => {
      viewportApi.current = null;
      manager.dispose();
    };
  }, []);

  useEffect(() => viewportApi.current?.setHidden(hiddenParts), [hiddenParts]);
  useEffect(() => viewportApi.current?.setParts(parts), [parts]);
  useEffect(() => viewportApi.current?.setSelection(picks ? itemsForPicks(parts, picks) : selection), [selection, picks, parts]);
  useEffect(
    () => viewportApi.current?.setDatums({ selected: selectedPlane, listHover: listHoverPlane, hidden: hiddenDatums }),
    [selectedPlane, listHoverPlane, hiddenDatums],
  );

  // Sketch tools are active while a sketch with a plane is open.
  const sketching = !!draft && !!plane;
  useEffect(() => {
    const manager = viewportApi.current;
    if (!sketching || !manager) return;
    const controller = new SketchController();
    viewportApi.sketch = controller;
    manager.setSketchController(controller);
    const off = controller.onChange((t) => manager.setSketchTransient(t));
    return () => {
      off();
      manager.setSketchController(null);
      manager.setSketchTransient(null);
      viewportApi.sketch = null;
    };
  }, [sketching]);

  // Look straight at the sketch when it opens or its plane is chosen.
  const planeKey = plane ? JSON.stringify(plane) : null;
  useEffect(() => {
    if (plane) viewportApi.current?.viewNormalToSketch(plane);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id, planeKey]);

  const others = useMemo(() => visibleSketches(features, draft?.id ?? null, selectedFeatureId), [features, draft?.id, selectedFeatureId]);
  useEffect(() => {
    const manager = viewportApi.current;
    if (!manager) return;
    if (!plane || !sketchData) {
      manager.setSketchScene(others, null);
      return;
    }
    const { analysis, failing } = sketchStatus(sketchData);
    manager.setSketchScene(others, { plane, data: sketchData, analysis, failing, selection: new Set(sketchSelection ?? []) });
  }, [others, plane, sketchData, sketchSelection]);

  return <div ref={containerRef} className="viewport" data-testid="viewport" />;
}
