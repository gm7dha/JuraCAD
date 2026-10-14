import { useEffect, useMemo, useRef } from "react";

import { indexOfRef, type TopoPick } from "../geometry/topoRef";
import { isPatternFeature, isPickFeature, isSketchSolid } from "../model/features";
import { activeAssembly, activeFeatures, pickFor, studioParts, useStore, type SelectionItem } from "../model/store";
import { compose, placementMatrix, rotate, type Placement } from "../assembly/math";
import { findPick, frameOnParts, framePlacement } from "../assembly/connectors";
import { explodeAssembly, useSolvedAssembly } from "../app/assemblySolve";
import type { MateConnector } from "../model/types";
import type { Assembly } from "../model/types";
import type { PartMesh } from "../kernel/protocol";
import type { Feature } from "../model/types";
import { SketchController } from "../sketch/controller";
import { planeFrame, planeOnFace, type SketchPlane } from "../sketch/planes";
import { framesOf, planeAsSketchPlane, planeFeatureFrame } from "../sketch/planeFeature";
import { resolveParams } from "../model/features";
import { copyEdge } from "../sketch/tools";
import { analyzeSketch, solveSketch, type SketchAnalysis } from "../sketch/solver";
import type { SketchData } from "../sketch/types";
import { setSketchTheme } from "./SketchLayer";
import { partsOfFeature } from "../model/partLinks";
import { SceneManager, type PickTarget, type ScreenRay } from "./SceneManager";
import { planDrag, type DragPlan } from "../assembly/drag";
import { solveWithParts } from "../assembly/mates";
import { sectionPlane } from "./section";

/** Shared empty colour list (a selector must not make a new object each time). */
const NO_COLOURS: Record<string, string> = {};
const NO_PLACEMENTS: Record<string, number[]> = {};

/** Each instance shown as a copy of its part's mesh (moved into place with setPlacements). */
function instanceMeshes(parts: PartMesh[], assembly: Assembly): PartMesh[] {
  const out: PartMesh[] = [];
  for (const i of assembly.instances) {
    const part = parts.find((p) => p.id === i.partId);
    if (part) out.push({ ...part, id: i.id, name: i.name, featureIds: [] });
  }
  return out;
}

/** The faces or edges picked for a mate, as shown now. */
function connectorItems(parts: PartMesh[], assembly: Assembly, connectors: (MateConnector | undefined)[]): SelectionItem[] {
  const items: SelectionItem[] = [];
  for (const c of connectors) {
    if (!c) continue;
    const instance = assembly.instances.find((i) => i.id === c.instanceId);
    const part = instance && parts.find((p) => p.id === instance.partId);
    const index = part ? findPick(part, c.pick) : -1;
    if (instance && index >= 0) items.push({ partId: instance.id, kind: c.pick.ref.kind, index });
  }
  return items;
}

/** Selected instances, as every face of each (so the whole part lights up). */
function instanceSelection(display: PartMesh[], ids: string[]): SelectionItem[] {
  const items: SelectionItem[] = [];
  for (const p of display) if (ids.includes(p.id)) p.faceGroups.forEach((_, index) => items.push({ partId: p.id, kind: "face", index }));
  return items;
}

/** A click in an assembly selects whole instances (or, while making a mate, a face or edge for it). */
function handleAssemblyPick(target: PickTarget | null, additive: boolean) {
  const s = useStore.getState();
  if (s.mateDraft) {
    if (target?.kind !== "part") return;
    const asm = activeAssembly(s);
    const instance = asm?.instances.find((i) => i.id === target.item.partId);
    const part = instance && s.parts.find((p) => p.id === instance.partId);
    if (!instance || !part) return;
    const ref = target.item.kind === "edge" ? part.edgeRefs?.[target.item.index] : part.faceRefs?.[target.item.index];
    if (!ref || (ref.kind === "edge" ? ref.curve : ref.surface) === "UNKNOWN") return;
    s.pickMateConnector({ instanceId: instance.id, pick: { partId: part.id, ref } });
    return;
  }
  const id = target?.kind === "part" ? target.item.partId : null;
  if (!id) {
    if (!additive) s.setAsmSelection([]);
    return;
  }
  const current = s.asmSelection;
  if (additive) s.setAsmSelection(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  else s.setAsmSelection(current.length === 1 && current[0] === id ? [] : [id]);
}

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

/** A Plane feature clicked in the 3D view, as somewhere to sketch (or put text, or base a plane on). */
function customPlaneAt(id: string): SketchPlane | null {
  const features = activeFeatures(useStore.getState());
  const f = features.find((x) => x.id === id);
  const frame = framesOf(features).get(id);
  return f && frame ? planeAsSketchPlane(f, frame) : null;
}

/** Apply a click in the viewport to the selection, like Onshape. */
function handlePick(target: PickTarget | null, additive: boolean) {
  const s = useStore.getState();
  if (activeAssembly(s)) return handleAssemblyPick(target, additive);
  // A Plane feature: use it wherever a plane is wanted, otherwise select it in the list.
  if (target?.kind === "customPlane") {
    const plane = customPlaneAt(target.id);
    const d = s.editing?.draft;
    if (!plane) return;
    if (s.sketch && d?.sketch && !d.sketch.plane) s.setSketchPlane(plane);
    else if (d?.type === "text" && d.text) s.setDraftField({ text: { ...d.text, plane } });
    else if (d?.type === "mirror") s.setDraftMirrorPlane(plane);
    else if (d?.type === "plane" && d.planeDef && d.id !== target.id) s.setDraftField({ planeDef: { ...d.planeDef, ref: plane } });
    else if (!s.editing) s.selectFeature(target.id);
    return;
  }
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
  // Copying part edges into the open sketch ("Use").
  if (s.sketch?.tool === "useEdge" && s.editing?.draft.sketch?.plane) {
    if (target?.kind !== "part") return;
    if (target.item.kind !== "edge") {
      s.setSketchMessage("Click an edge (not a face) to copy it into the sketch.", "info");
      return;
    }
    const ref = s.parts.find((p) => p.id === target.item.partId)?.edgeRefs?.[target.item.index];
    if (!ref) return;
    const r = copyEdge(s.editing.draft.sketch.data, planeFrame(s.editing.draft.sketch.plane), ref);
    if (r.error) s.setSketchMessage(r.error, "error");
    else {
      s.updateSketch(r.sketch, { selection: r.curveIds });
      s.setSketchMessage(null);
    }
    return;
  }
  // Choosing the face an extrude goes up to.
  if (s.editing?.draft.type === "extrude" && s.editing.draft.extrude?.end === "upToFace") {
    if (target?.kind !== "part" || target.item.kind !== "face") return;
    const pick = pickFor(s.parts, target.item);
    if (pick) s.setDraftField({ extrude: { ...s.editing.draft.extrude, upTo: pick } });
    return;
  }
  // Choosing the part to move.
  if (s.editing?.draft.type === "transform" && s.editing.draft.transform) {
    if (target?.kind === "part" && target.item.partId !== s.editing.draft.id) {
      s.setDraftField({ transform: { ...s.editing.draft.transform, partId: target.item.partId } });
    }
    return;
  }
  // Choosing where text goes.
  if (s.editing?.draft.type === "text" && s.editing.draft.text) {
    const t = s.editing.draft.text;
    if (target?.kind === "plane") s.setDraftField({ text: { ...t, plane: { kind: "default", name: target.plane } } });
    else if (target?.kind === "part" && target.item.kind === "face") {
      const plane = planeForFace(target.item);
      if (plane) s.setDraftField({ text: { ...t, plane } });
      else s.showToast("That face is curved. Pick a flat face or one of the planes for the text.");
    }
    return;
  }
  // Picking parts for a Boolean.
  if (s.editing?.draft.type === "boolean") {
    if (target?.kind === "part") s.toggleBooleanPart(target.item.partId);
    return;
  }
  // Choosing what a Plane feature is based on (for "halfway", the first face then the second).
  if (s.editing?.draft.type === "plane" && s.editing.draft.planeDef) {
    const pd = s.editing.draft.planeDef;
    let picked: SketchPlane | null = null;
    if (target?.kind === "plane") picked = { kind: "default", name: target.plane };
    else if (target?.kind === "part" && target.item.kind === "face") {
      picked = planeForFace(target.item);
      if (!picked) s.showToast("That face is curved. Pick a flat face or one of the planes.");
    }
    if (!picked) return;
    if (pd.mode === "midplane" && pd.ref.kind === "face" && !pd.ref.planeRef && !pd.ref2) s.setDraftField({ planeDef: { ...pd, ref2: picked } });
    else s.setDraftField({ planeDef: { ...pd, ref: picked, ...(pd.mode === "midplane" ? { ref2: undefined } : {}) } });
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

/** The drag in progress in an assembly. */
let activeDrag: DragPlan | null = null;

function dragStart(target: PickTarget & { kind: "part" }, ray: ScreenRay, shift: boolean): boolean {
  const s = useStore.getState();
  const asm = activeAssembly(s);
  if (!asm || s.mateDraft || !target.point) return false;
  const solved = solveWithParts(asm, s.parts);
  const r = planDrag(asm, solved, (m, side) => frameOnParts(s.parts, m[side].pick), target.item.partId, target.point, ray.dir, shift);
  if ("refuse" in r) {
    if (r.refuse) s.showToast(r.refuse);
    return false;
  }
  activeDrag = r.plan;
  s.setAsmSelection([target.item.partId]);
  return true;
}

function dragMove(ray: ScreenRay) {
  const change = activeDrag?.update(ray);
  if (change) useStore.getState().setDragPreview(change);
}

function dragEnd() {
  activeDrag = null;
  useStore.getState().commitDrag();
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
  /** The parts of the Part Studio on show. */
  const shownParts = useStore(studioParts);
  const selection = useStore((s) => s.selection);
  const picks = useStore((s) =>
    s.editing && isPickFeature(s.editing.draft.type)
      ? s.editing.draft.picks ?? null
      : s.editing?.draft.extrude?.end === "upToFace" && s.editing.draft.extrude.upTo
        ? s.editing.draft.extrude.upTo
        : null,
  );
  const pickList = useMemo(() => (picks ? (Array.isArray(picks) ? picks : [picks]) : null), [picks]);
  const hiddenParts = useStore((s) => s.hiddenParts);
  const selectedPlane = useStore((s) => s.selectedPlane);
  const listHoverPlane = useStore((s) => s.listHoverPlane);
  const hiddenDatums = useStore((s) => s.hiddenDatums);
  const features = useStore(activeFeatures);
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
      manager = new SceneManager(container, { onPick: handlePick, onDragStart: dragStart, onDragMove: dragMove, onDragEnd: dragEnd });
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
    manager.setParts(studioParts(s));
    manager.setPartColours(s.history.present.appearance ?? {});
    manager.setSelection(s.selection);
    manager.setDatums({ selected: s.selectedPlane, listHover: s.listHoverPlane, hidden: s.hiddenDatums });
    return () => {
      viewportApi.current = null;
      manager.dispose();
    };
  }, []);

  const assembly = useStore(activeAssembly);
  const asmSelection = useStore((s) => s.asmSelection);
  const hiddenInstances = useStore((s) => s.hiddenInstances);
  // In an assembly the meshes only change when parts are rebuilt or instances added/removed, not when they move.
  const instanceKey = assembly ? assembly.id + "|" + assembly.instances.map((i) => `${i.id}:${i.partId}`).join(",") : null;
  const display = useMemo(
    () => (assembly ? instanceMeshes(parts, assembly) : shownParts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [parts, shownParts, instanceKey],
  );
  const { solved } = useSolvedAssembly();
  const mateDraft = useStore((s) => s.mateDraft?.mate ?? null);
  // Exploded view: shown spread apart, except while a mate is being made.
  const explodePreview = useStore((s) => s.explodePreview);
  const explode = mateDraft ? 0 : (explodePreview ?? assembly?.explode ?? 0);
  const placements = useMemo(() => {
    if (!assembly) return NO_PLACEMENTS;
    const solvedPlaces = Object.fromEntries(assembly.instances.map((i) => [i.id, solved?.placements[i.id] ?? i.placement]));
    const shown = explodeAssembly(assembly, parts, solvedPlaces, explode);
    return Object.fromEntries(assembly.instances.map((i) => [i.id, placementMatrix(shown[i.id])]));
  }, [assembly, solved, parts, explode]);

  useEffect(() => viewportApi.current?.setDragEnabled(!!assembly && !mateDraft && !(explode > 0)), [assembly, mateDraft, explode]);

  // Arrows showing the mate connectors picked so far.
  useEffect(() => {
    const manager = viewportApi.current;
    if (!manager) return;
    if (!assembly || !mateDraft) {
      manager.setMarkers([]);
      return;
    }
    const markers: { origin: [number, number, number]; x: [number, number, number]; z: [number, number, number] }[] = [];
    for (const c of [mateDraft.a, mateDraft.b]) {
      if (!c) continue;
      const instance = assembly.instances.find((i) => i.id === c.instanceId);
      const f = frameOnParts(parts, c.pick);
      if (!instance || !f) continue;
      const where: Placement = solved?.placements[instance.id] ?? instance.placement;
      const world = compose(where, framePlacement(f));
      markers.push({ origin: world.position, x: rotate(world.rotation, [1, 0, 0]), z: rotate(world.rotation, [0, 0, 1]) });
    }
    manager.setMarkers(markers);
  }, [assembly, mateDraft, parts, solved]);

  useEffect(() => viewportApi.current?.setHidden(assembly ? hiddenInstances : hiddenParts), [hiddenParts, hiddenInstances, assembly]);
  // Plane features (and the one being made), drawn as squares you can click to sketch on.
  const planeDraft = useStore((s) => (s.editing?.draft.type === "plane" ? s.editing.draft : null));
  const listFeatures = useStore(activeFeatures);
  const pickedFeatureForPlanes = useStore((s) => s.selectedFeatureId);
  useEffect(() => {
    const manager = viewportApi.current;
    if (!manager) return;
    if (assembly) {
      manager.setCustomPlanes([]);
      return;
    }
    const frames = framesOf(listFeatures);
    const list = listFeatures
      .filter((f) => f.type === "plane" && frames.has(f.id) && f.id !== planeDraft?.id)
      .map((f) => ({ id: f.id, ...frames.get(f.id)!, label: f.name, highlight: f.id === pickedFeatureForPlanes }));
    if (planeDraft?.planeDef) {
      const { values, errors } = resolveParams(planeDraft);
      const frame = Object.keys(errors).length ? null : planeFeatureFrame(planeDraft.planeDef, values);
      if (frame && typeof frame !== "string") list.push({ id: planeDraft.id, ...frame, label: planeDraft.name, highlight: true });
    }
    manager.setCustomPlanes(list.map((p) => ({ id: p.id, origin: p.origin, u: p.u, v: p.v, label: p.label, highlight: p.highlight })));
  }, [listFeatures, planeDraft, assembly, pickedFeatureForPlanes]);
  const selectedParts = useStore((s) => s.selectedParts);
  const pickedFeature = useStore((s) => s.selectedFeatureId);
  const studioFeatures = useStore(activeFeatures);
  // Picked parts, or the parts a picked feature made (or a Boolean being set up uses), light up.
  const booleanDef = useStore((s) => (s.editing?.draft.type === "boolean" ? s.editing.draft.booleanDef ?? null : null));
  useEffect(() => {
    const lit = assembly
      ? []
      : booleanDef
        ? [...booleanDef.targets, ...booleanDef.tools]
        : selectedParts.length
          ? selectedParts
          : pickedFeature
            ? partsOfFeature(parts, pickedFeature, studioFeatures)
            : [];
    viewportApi.current?.setSelectedParts(lit);
  }, [selectedParts, assembly, pickedFeature, parts, studioFeatures, booleanDef]);
  const section = useStore((s) => s.section);
  const appearance = useStore((s) => s.history.present.appearance ?? NO_COLOURS);
  const colours = useMemo(() => {
    if (!assembly) return appearance;
    const out: Record<string, string> = {};
    for (const i of assembly.instances) if (appearance[i.partId]) out[i.id] = appearance[i.partId];
    return out;
  }, [appearance, assembly]);
  useEffect(() => viewportApi.current?.setPartColours(colours), [colours]);
  useEffect(() => viewportApi.current?.setSection(section ? sectionPlane(section) : null), [section]);
  useEffect(() => {
    // Placements first, so the parts arrive already in position.
    viewportApi.current?.setPlacements(placements);
    viewportApi.current?.setParts(display);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display]);
  useEffect(() => viewportApi.current?.setPlacements(placements), [placements]);
  useEffect(
    () =>
      viewportApi.current?.setSelection(
        assembly
          ? mateDraft
            ? connectorItems(parts, assembly, [mateDraft.a, mateDraft.b])
            : instanceSelection(display, asmSelection)
          : picks
            ? itemsForPicks(parts, pickList ?? [])
            : selection,
      ),
    [selection, picks, parts, assembly, display, asmSelection, mateDraft],
  );
  useEffect(
    () => viewportApi.current?.setDatums({ selected: selectedPlane, listHover: listHoverPlane, hidden: hiddenDatums }),
    [selectedPlane, listHoverPlane, hiddenDatums],
  );

  const usingEdges = useStore((s) => s.sketch?.tool === "useEdge");
  useEffect(() => viewportApi.current?.setSketchPicksParts(usingEdges), [usingEdges]);

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

  const inAssembly = assembly !== null;
  const theme = useStore((s) => s.theme);
  useEffect(() => setSketchTheme(theme === "dark"), [theme]);
  const others = useMemo(
    () => (inAssembly ? [] : visibleSketches(features, draft?.id ?? null, selectedFeatureId)),
    [features, draft?.id, selectedFeatureId, inAssembly],
  );
  useEffect(() => {
    const manager = viewportApi.current;
    if (!manager) return;
    if (!plane || !sketchData) {
      manager.setSketchScene(others, null);
      return;
    }
    const { analysis, failing } = sketchStatus(sketchData);
    manager.setSketchScene(others, { plane, data: sketchData, analysis, failing, selection: new Set(sketchSelection ?? []) });
    // The theme changes the sketch colours, so redraw when it changes.
  }, [others, plane, sketchData, sketchSelection, theme]);

  return (
    <>
      <div ref={containerRef} className="viewport" data-testid="viewport" />
      <button
        type="button"
        className="iso-button"
        onClick={() => viewportApi.current?.setView("iso")}
        title="Isometric view (Shift+7)"
      >
        Isometric
      </button>
    </>
  );
}
