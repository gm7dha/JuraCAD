import { bedSize } from "../model/printBed";
import { useEffect, useMemo, useRef, useState } from "react";

import { findMesh, meshIdOf } from "../assembly/configured";
import { indexOfRef, type TopoPick } from "../geometry/topoRef";
import { isPatternFeature, isPickFeature, isSketchSolid } from "../model/features";
import { activeAssembly, activeFeatures, pickFor, studioParts, useStore, type SelectionItem } from "../model/store";
import { compose, IDENTITY, placementMatrix, rotate, type Placement } from "../assembly/math";
import { isOrigin } from "../assembly/origin";
import { clickedSpot, findPick, framePlacement } from "../assembly/connectors";
import { explodeAssembly, useAssemblyLeaves, useSolvedAssembly } from "../app/assemblySolve";
import { instanceAt, leafKey, topOfKey, type Leaf } from "../assembly/subassembly";
import type { MateConnector } from "../model/types";
import type { Assembly } from "../model/types";
import type { PartMesh } from "../kernel/protocol";
import { getKernel } from "../kernel/connect";
import type { Feature } from "../model/types";
import { SketchController } from "../sketch/controller";
import { planeFrame, planeOnFace, type PlaneFrame, type SketchPlane } from "../sketch/planes";
import { framesOf, planeAsSketchPlane, planeFeatureFrame } from "../sketch/planeFeature";
import { resolveParams } from "../model/features";
import { copyEdge } from "../sketch/tools";
import { projectEdge, linkEdge, type SketchLinkInfo } from "../sketch/links";
import { analyzeSketch, solveSketch, type SketchAnalysis } from "../sketch/solver";
import type { SketchData } from "../sketch/types";
import { setSketchTheme } from "./SketchLayer";
import { partsOfFeature } from "../model/partLinks";
import { SceneManager, type PickAreas, type PickTarget, type ScreenRay } from "./SceneManager";
import { areaClickMode, areaOutlines, areaShades, followedSketch } from "../sketch/areaClicks";
import { sketchAreas, toggleArea } from "../sketch/areas";
import { planDrag, type DragPlan } from "../assembly/drag";
import { connectorFrameFor, frameLookup, solveWithParts } from "../assembly/mates";
import { sectionPlane } from "./section";
import { linePlane, pickableSketchLines, referenceShape, setMirrorReference, setPatternDirection, sketchLine3D, type DirectionChoice, type PickableLine } from "../model/patternRefs";

/** Shared empty colour list (a selector must not make a new object each time). */
const NO_COLOURS: Record<string, string> = {};
const NO_PLACEMENTS: Record<string, number[]> = {};

/**
 * Each instance shown as a copy of its part's mesh (moved into place with setPlacements); suppressed ones aren't shown.
 * A sub-assembly shows a copy of each part inside it, named by its path ("top/inner/part").
 */
function instanceMeshes(parts: PartMesh[], leaves: Leaf[]): PartMesh[] {
  const out: PartMesh[] = [];
  for (const l of leaves) {
    const part = findMesh(parts, meshIdOf(l.instance));
    if (part) out.push({ ...part, id: l.key, name: l.name, featureIds: [] });
  }
  return out;
}

/** Hidden instances as the 3D view's meshes: a hidden sub-assembly hides every part inside it. */
function hiddenMeshes(hidden: string[], leaves: Leaf[]): string[] {
  if (!hidden.length) return hidden;
  return leaves.filter((l) => hidden.some((h) => l.key === h || l.key.startsWith(`${h}/`))).map((l) => l.key);
}

/** The faces or edges picked for a mate, as shown now. */
function connectorItems(parts: PartMesh[], assembly: Assembly, assemblies: readonly Assembly[], connectors: (MateConnector | undefined)[]): SelectionItem[] {
  const items: SelectionItem[] = [];
  for (const c of connectors) {
    if (!c) continue;
    // On a part inside a sub-assembly, the path leads to it.
    const key = leafKey(c.instanceId, c.path);
    const instance = instanceAt(assembly, assemblies, key)?.part;
    const part = instance && findMesh(parts, meshIdOf(instance));
    for (const pick of c.pick2 ? [c.pick, c.pick2] : [c.pick]) {
      const index = part ? findPick(part, pick) : -1;
      if (instance && index >= 0) items.push({ partId: key, kind: pick.ref.kind, index });
    }
  }
  return items;
}

/** Selected instances, as every face of each (so the whole part lights up; a sub-assembly, all its parts). */
function instanceSelection(display: PartMesh[], ids: string[]): SelectionItem[] {
  const items: SelectionItem[] = [];
  for (const p of display) if (ids.includes(topOfKey(p.id))) p.faceGroups.forEach((_, index) => items.push({ partId: p.id, kind: "face", index }));
  return items;
}

/** A click in an assembly selects whole instances (or, while making a mate, a face or edge for it). */
function handleAssemblyPick(target: PickTarget | null, additive: boolean) {
  const s = useStore.getState();
  if (s.mateDraft) {
    if (target?.kind !== "part") return;
    const asm = activeAssembly(s);
    // A part inside a sub-assembly: the connector is on the sub-assembly, with the path to the part.
    const found = asm ? instanceAt(asm, s.history.present.assemblies ?? [], target.item.partId) : null;
    const instance = found?.part;
    const part = instance && findMesh(s.parts, meshIdOf(instance));
    if (!found || !instance || !part) return;
    const ref = target.item.kind === "edge" ? part.edgeRefs?.[target.item.index] : part.faceRefs?.[target.item.index];
    if (!ref || (ref.kind === "edge" ? ref.curve : ref.surface) === "UNKNOWN") return;
    // Picks name the part itself, whichever configuration it's shown in. Where it was clicked is kept
    // (in the part's own coordinates), and a click near an edge's end puts the connector on that corner.
    const point = target.local?.map((v) => Math.round(v * 1e6) / 1e6) as [number, number, number] | undefined;
    const spot = point ? clickedSpot(part, { partId: part.id, ref }, point) : undefined;
    s.pickMateConnector({ instanceId: found.top.id, ...(found.path.length ? { path: found.path } : {}), pick: { partId: instance.partId, ref }, ...(spot ? { spot } : {}), ...(point ? { point } : {}) });
    return;
  }
  // A click on a part inside a sub-assembly selects the whole sub-assembly.
  const id = target?.kind === "part" ? topOfKey(target.item.partId) : null;
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
  // Remember the face, so its edges can be used in the sketch and the sketch moves with it.
  const pick = pickFor(s.parts, item);
  return planeOnFace(flat.normal, flat.point, `Face of ${part?.name ?? "part"}`, pick?.ref.kind === "face" ? pick : undefined);
}

/** A Plane feature clicked in the 3D view, as somewhere to sketch (or put text, or base a plane on). */
function customPlaneAt(id: string): SketchPlane | null {
  const features = activeFeatures(useStore.getState());
  const f = features.find((x) => x.id === id);
  const frame = framesOf(features).get(id);
  return f && frame ? planeAsSketchPlane(f, frame) : null;
}

/** Look straight at a Plane feature. False if it can't be placed. */
export function viewNormalToPlaneFeature(id: string): boolean {
  const plane = customPlaneAt(id);
  if (!plane) return false;
  viewportApi.current?.viewNormalToSketch(plane);
  return true;
}

const NO_IDS: string[] = [];
const NO_LINES: PickableLine[] = [];
const FACE_TOOLS = new Set(["thicken", "draft", "moveFace", "replaceFace", "deleteFace", "thread", "fullRound", "wrap", "enclose", "offsetSurface"]);

/** Apply a click in the viewport to the selection, like Onshape. */
function handlePick(target: PickTarget | null, additive: boolean) {
  const s = useStore.getState();
  if (activeAssembly(s)) return handleAssemblyPick(target, additive);
  // An area of the sketch an Extrude, Revolve or Sweep uses: pick it, or leave it out again (as the 2D map does).
  if (target?.kind === "sketchArea") {
    const d = s.editing?.draft;
    const data = d?.sketchRef ? followedSketch(activeFeatures(s).find((f) => f.id === d.sketchRef), s.sketchLinks)?.data : undefined;
    if (d && data && areaClickMode(d) !== "off") s.setDraftField({ areas: toggleArea(sketchAreas(data), d.areas, target.index) });
    return;
  }
  // Parts shown flat are just for looking at: their faces and edges aren't the real ones.
  if (s.showFlat && target?.kind === "part" && s.parts.find((p) => p.id === target.item.partId)?.flat) {
    s.showToast("This part is shown flat. Turn Unfold off (in the toolbar) to pick its faces and edges.");
    return;
  }
  // A Plane feature: use it wherever a plane is wanted, otherwise select it in the list.
  if (target?.kind === "customPlane") {
    const plane = customPlaneAt(target.id);
    const d = s.editing?.draft;
    if (!plane) return;
    if (s.sketch && d?.sketch && !d.sketch.plane) s.setSketchPlane(plane);
    else if (d?.type === "text" && d.text) s.setDraftField({ text: { ...d.text, plane } });
    else if (d?.type === "mirror") s.setDraftMirrorPlane(plane);
    else if (d?.type === "plane" && d.planeDef && d.id !== target.id) s.setDraftField({ planeDef: { ...d.planeDef, ref: plane } });
    else if (d?.type === "split" && d.splitDef) s.setDraftField({ splitDef: { ...d.splitDef, plane, toolPartId: undefined } });
    else if (d?.type === "draft" || d?.type === "ruled") s.setDraftField({ neutral: plane });
    else if (d?.type === "replaceFace") s.setDraftField({ replaceDef: { target: plane, picking: "faces" } });
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
    // Straight and round edges are copied in linked to the part (they follow it when it changes).
    const data = s.editing.draft.sketch.data;
    const seen = ref.curve === "UNKNOWN" ? null : projectEdge(planeFrame(s.editing.draft.sketch.plane), { partId: target.item.partId, ref });
    const r = seen && seen.kind !== "curve" ? (({ curveId, ...rest }) => ({ ...rest, curveIds: [curveId] }))(linkEdge(data, seen, false)) : copyEdge(data, planeFrame(s.editing.draft.sketch.plane), ref);
    if (r.error) s.setSketchMessage(r.error, "error");
    else {
      s.updateSketch(r.sketch, { selection: r.curveIds });
      s.setSketchMessage(null);
    }
    return;
  }
  // Choosing what an extrude goes up to: a face, a corner (near the end of an edge) or a part.
  const ex = s.editing?.draft.type === "extrude" ? s.editing.draft.extrude : undefined;
  if (ex && (ex.end === "upToFace" || ex.end === "upToVertex" || ex.end === "upToPart")) {
    if (target?.kind !== "part") return;
    if (ex.end === "upToFace" && target.item.kind !== "face") return s.showToast("Click a face (not an edge) to extrude up to.");
    if (ex.end === "upToVertex" && target.item.kind !== "edge") return s.showToast("Click near the end of an edge: the corner there is where the extrude stops.");
    if (target.item.partId === s.editing!.draft.id) return;
    const pick = pickFor(s.parts, target.item);
    if (!pick) return;
    if (ex.end === "upToVertex" && pick.ref.kind === "edge") {
      // The end of the edge nearest where it was clicked.
      const at = target.point ?? pick.ref.mid;
      const gap = (p: [number, number, number]) => Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]);
      s.setDraftField({ extrude: { ...ex, upTo: pick, upToEnd: gap(pick.ref.a) <= gap(pick.ref.b) ? "a" : "b" } });
    } else s.setDraftField({ extrude: { ...ex, upTo: target.point ? { ...pick, at: target.point } : pick } });
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
    const { face: _old, ...flat } = t;
    if (target?.kind === "plane") s.setDraftField({ text: { ...flat, plane: { kind: "default", name: target.plane } } });
    else if (target?.kind === "part" && target.item.kind === "face") {
      const plane = planeForFace(target.item);
      const pick = plane ? null : pickFor(s.parts, target.item);
      if (plane) s.setDraftField({ text: { ...flat, plane } });
      else if (pick?.ref.kind === "face" && pick.ref.surface === "CYLINDRE") s.setDraftField({ text: { ...flat, plane: null, face: pick } });
      else s.showToast("Text can go on a flat face, a round (cylinder) face, or one of the planes.");
    }
    return;
  }
  // Split: the part, then the plane (a default plane, a Plane feature, or a flat face).
  if (s.editing?.draft.type === "split" && s.editing.draft.splitDef) {
    const sp = s.editing.draft.splitDef;
    if (target?.kind === "plane") s.setDraftField({ splitDef: { ...sp, plane: { kind: "default", name: target.plane }, toolPartId: undefined } });
    else if (target?.kind === "part") {
      if (sp.picking !== "plane" || !sp.partId) s.setDraftField({ splitDef: { ...sp, partId: target.item.partId, picking: "plane" } });
      else if (target.item.kind === "face") {
        // A surface part splits with its whole (curved) self; anything else must be a flat face.
        const onPart = s.parts.find((p) => p.id === target.item.partId);
        if (onPart?.surface && onPart.id !== sp.partId) {
          s.setDraftField({ splitDef: { ...sp, toolPartId: onPart.id } });
          return;
        }
        const plane = planeForFace(target.item);
        if (plane) s.setDraftField({ splitDef: { ...sp, plane, toolPartId: undefined } });
        else s.showToast("That face is curved. Split along a flat face, a plane, or a surface.");
      }
    }
    return;
  }
  // Draft: a click on a plane sets the neutral plane.
  if ((s.editing?.draft.type === "draft" || s.editing?.draft.type === "ruled") && target?.kind === "plane") {
    s.setDraftField({ neutral: { kind: "default", name: target.plane } });
    return;
  }
  // Replace face: a plane, or (after "Move them onto") a flat face, is what the faces move onto.
  if (s.editing?.draft.type === "replaceFace") {
    const rd = s.editing.draft.replaceDef ?? { target: null };
    if (target?.kind === "plane") {
      s.setDraftField({ replaceDef: { target: { kind: "default", name: target.plane }, picking: "faces" } });
      return;
    }
    if (rd.picking === "target" && target?.kind === "part" && target.item.kind === "face") {
      const plane = planeForFace(target.item);
      if (plane) s.setDraftField({ replaceDef: { target: plane, picking: "faces" } });
      else s.showToast("That face is curved. Pick a flat face or one of the planes.");
      return;
    }
  }
  // Fill: the edges round an opening; Extend surface: the edges to push out.
  if (s.editing?.draft.type === "fill" || s.editing?.draft.type === "extendSurface" || s.editing?.draft.type === "ruled") {
    if (target?.kind !== "part") return;
    // Extend up to a face or part: a face clicked (on another part) is where it stops.
    const et = s.editing.draft.type === "extendSurface" ? s.editing.draft.extendTo : undefined;
    if (et && target.item.kind === "face") {
      const pick = pickFor(s.parts, target.item);
      if (pick) s.setDraftField({ extendTo: { ...et, target: pick } });
      return;
    }
    if (target.item.kind !== "edge") {
      s.showToast(s.editing.draft.type === "fill" ? "Click the edges round the opening (not a face)." : s.editing.draft.type === "ruled" ? "Click the edges to sweep strips from (not a face)." : "Click the edges of the surface to extend (not a face).");
      return;
    }
    const pick = pickFor(s.parts, target.item);
    if (pick) s.toggleDraftPick(pick);
    return;
  }
  // Corner break: the short edges through the sheet at its corners.
  if (s.editing?.draft.type === "cornerBreak") {
    if (target?.kind !== "part") return;
    if (target.item.kind !== "edge") {
      s.showToast("Click the short edge through the sheet at a corner (not a face).");
      return;
    }
    const pick = pickFor(s.parts, target.item);
    if (pick) s.toggleDraftPick(pick);
    return;
  }
  // Flange: straight edges of a sheet metal part.
  if (s.editing?.draft.type === "flange" || s.editing?.draft.type === "hem") {
    if (target?.kind !== "part") return;
    if (target.item.kind !== "edge") {
      s.showToast(s.editing.draft.type === "hem" ? "Click an edge of the sheet (not a face) to fold it over." : "Click an edge of the sheet (not a face) to bend a flange off it.");
      return;
    }
    const pick = pickFor(s.parts, target.item);
    if (pick?.ref.kind === "edge" && pick.ref.curve !== "LINE") {
      s.showToast(s.editing.draft.type === "hem" ? "Hems fold straight edges." : "Flanges bend off straight edges.");
      return;
    }
    if (pick) s.toggleDraftPick(pick);
    return;
  }
  // Thicken, Draft, Move face, Replace face, Delete face: faces.
  const faceFeature = s.editing?.draft.type;
  if (faceFeature === "thicken" || faceFeature === "draft" || faceFeature === "moveFace" || faceFeature === "replaceFace" || faceFeature === "deleteFace" || faceFeature === "fullRound" || faceFeature === "thread" || faceFeature === "wrap" || faceFeature === "enclose" || faceFeature === "offsetSurface") {
    if (target?.kind !== "part") return;
    if (target.item.kind !== "face") {
      s.showToast("Click a face rather than an edge.");
      return;
    }
    const pick = pickFor(s.parts, target.item);
    // Wrap goes round one face, Offset surface works on one surface: a new click replaces the last.
    if (pick && (faceFeature === "wrap" || faceFeature === "offsetSurface")) s.setDraftField({ picks: [pick] });
    else if (pick) s.toggleDraftPick(pick);
    return;
  }
  // Picking parts to delete (click again to keep one).
  if (s.editing?.draft.type === "deletePart") {
    if (target?.kind === "part") {
      const list = s.editing.draft.deleteParts ?? [];
      const id = target.item.partId;
      s.setDraftField({ deleteParts: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] });
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
  // Choosing the plane to mirror across: a default plane, a flat face (followed as the part changes) or a sketch line.
  if (s.editing?.draft.type === "mirror" && s.editing.draft.mirror) {
    const m = s.editing.draft.mirror;
    const setMirror = (mirror: typeof m) => s.setDraftField({ mirror });
    if (target?.kind === "plane") s.setDraftMirrorPlane({ kind: "default", name: target.plane });
    else if (target?.kind === "sketchLine") {
      const line = { sketch: target.id, line: target.line };
      const found = sketchLine3D(activeFeatures(s), line);
      if (typeof found === "string") s.showToast(found);
      else setMirror(setMirrorReference(m, { kind: "line", line, plane: linePlane(found) }));
    } else if (target?.kind === "part" && target.item.kind === "face") {
      const plane = planeForFace(target.item);
      const found = pickFor(s.parts, target.item);
      // Where it was clicked tells apart faces that look the same.
      const pick = found && target.point ? { ...found, at: target.point } : found;
      if (plane && pick) setMirror(setMirrorReference(m, { kind: "face", plane, pick }));
      else s.showToast("That face is curved. To mirror across, click a flat face, a plane or a sketch line.");
    } else if (target?.kind === "part") s.showToast("To mirror across, click a flat face, a plane or a sketch line (not a part's edge).");
    return;
  }
  // Patterns pick their features in the list; in the 3D view, a click sets the direction (an edge, a flat
  // face or a sketch line) of a linear pattern, or the axis (a round face or edge, a straight edge or a sketch line) of a circular one.
  if (s.editing && isPatternFeature(s.editing.draft.type)) {
    const d = s.editing.draft;
    if ((d.type !== "linearPattern" && d.type !== "circularPattern") || !d.pattern) return;
    const second = d.type === "linearPattern" && d.pattern.picking === "along2";
    const { picking: _p, ...pattern } = d.pattern;
    const choose = (choice: DirectionChoice) => s.setDraftField({ pattern: setPatternDirection(pattern, choice, second) });
    if (target?.kind === "sketchLine") return choose({ kind: "line", line: { sketch: target.id, line: target.line } });
    if (target?.kind !== "part") return;
    const pick = pickFor(s.parts, target.item);
    if (!pick) return;
    const ref = pick.ref;
    if (d.type === "linearPattern") {
      const ok = ref.kind === "edge" ? ref.curve === "LINE" : ref.surface === "PLANE";
      if (!ok) return s.showToast("Click a straight edge or a sketch line (the copies go along it), or a flat face (they go straight out of it).");
    } else {
      const ok = ref.kind === "edge" ? ref.curve === "LINE" || ref.curve === "CIRCLE" : ref.surface === "CYLINDRE";
      if (!ok) return s.showToast("For the axis, click a round face (a hole or boss), a round or straight edge, or a sketch line.");
    }
    // Where it was clicked tells apart round faces that share a centre (a bore in the middle of a disc).
    choose({ kind: "pick", pick: target.point ? { ...pick, at: target.point } : pick });
    return;
  }
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
  if (target.kind === "sketchLine") return;
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
  const assemblies = s.history.present.assemblies;
  const solved = solveWithParts(asm, s.parts, { assemblies });
  // Connectors on each part as its instance shows it (mirrored, or in another configuration, or inside a sub-assembly).
  // A part inside a sub-assembly drags the whole sub-assembly.
  const id = topOfKey(target.item.partId);
  const r = planDrag(asm, solved, frameLookup(asm, s.parts, assemblies), id, target.point, ray.dir, shift);
  if ("refuse" in r) {
    if (r.refuse) s.showToast(r.refuse);
    return false;
  }
  activeDrag = r.plan;
  s.setAsmSelection([id]);
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

/** A selection box in the Part Studio: select the parts it chose (Shift/Ctrl adds to the selection). */
function boxSelect(partIds: string[], additive: boolean) {
  const s = useStore.getState();
  s.setSelectedParts(additive ? [...new Set([...s.selectedParts, ...partIds])] : partIds);
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

/**
 * Sketches to show faintly: finished ones that no extrude has used yet, or that are highlighted.
 * While a mirror or pattern is open (`referenceFor`, its id), every sketch before it is shown, so its lines can be clicked.
 */
function visibleSketches(features: Feature[], editingId: string | null, selectedId: string | null, links: Record<string, SketchLinkInfo>, referenceFor: string | null = null) {
  const used = new Set(features.filter((f) => isSketchSolid(f.type) && !f.suppressed && f.sketchRef).map((f) => f.sketchRef!));
  const at = referenceFor ? features.findIndex((f) => f.id === referenceFor) : -1;
  const earlier = referenceFor ? new Set((at >= 0 ? features.slice(0, at) : features).map((f) => f.id)) : null;
  return features
    .filter((f) => f.type === "sketch" && !f.suppressed && f.sketch?.plane && f.id !== editingId && (!used.has(f.id) || f.id === selectedId || !!earlier?.has(f.id)))
    // A sketch that follows its part is shown where the part is now.
    .map((f) => links[f.id]?.sketch ?? { plane: f.sketch!.plane!, data: f.sketch!.data });
}

export function Viewport() {
  const containerRef = useRef<HTMLDivElement>(null);
  const parts = useStore((s) => s.parts);
  /** The parts of the Part Studio on show. */
  const shownParts = useStore(studioParts);
  const selection = useStore((s) => s.selection);
  // Whatever the open feature has picked (edges and faces) is shown highlighted.
  const picks = useStore((s) =>
    s.editing?.draft.picks
      ? s.editing.draft.picks
      : s.editing?.draft.extrude?.upTo && s.editing.draft.extrude.end.startsWith("upTo")
        ? s.editing.draft.extrude.upTo
        : // A mirror's clicked face, or a pattern's clicked direction (the rows' one while that's being picked).
          s.editing?.draft.mirror?.planePick ??
          (s.editing?.draft.pattern?.picking === "along2" ? s.editing.draft.pattern.along2 : s.editing?.draft.pattern?.along) ??
          null,
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
      manager = new SceneManager(container, { onPick: handlePick, onDragStart: dragStart, onDragMove: dragMove, onDragEnd: dragEnd, onBoxSelect: boxSelect });
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
  const leaves = useAssemblyLeaves();
  const allAssemblies = useStore((s) => s.history.present.assemblies);
  const instanceKey = assembly ? assembly.id + "|" + leaves.map((l) => `${l.key}:${meshIdOf(l.instance)}`).join(",") : null;
  const hadNothing = useRef(true);
  // Sheet metal shown flat: each sheet part's unfolded mesh, fetched when asked for or when the parts are rebuilt.
  const showFlat = useStore((s) => s.showFlat);
  const [flatMeshes, setFlatMeshes] = useState<{ for: PartMesh[]; meshes: Record<string, PartMesh> } | null>(null);
  useEffect(() => {
    if (!showFlat || assembly) return;
    const sheets = shownParts.filter((p) => p.flat);
    if (!sheets.length) return;
    let live = true;
    const kernel = getKernel();
    kernel
      .whenIdle()
      .then(() => Promise.all(sheets.map((p) => kernel.unfold(p.id).catch(() => null))))
      .then((list) => {
        if (!live) return;
        const meshes: Record<string, PartMesh> = {};
        list.forEach((m, i) => {
          if (m) meshes[sheets[i].id] = m;
        });
        setFlatMeshes({ for: shownParts, meshes });
      });
    return () => {
      live = false;
    };
  }, [showFlat, shownParts, assembly]);
  const display = useMemo(() => {
    if (assembly) return instanceMeshes(parts, leaves);
    if (!showFlat || !flatMeshes || flatMeshes.for !== shownParts) return shownParts;
    return shownParts.map((p) => flatMeshes.meshes[p.id] ?? p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parts, shownParts, instanceKey, showFlat, flatMeshes]);
  const { solved } = useSolvedAssembly();
  const mateDraft = useStore((s) => s.mateDraft?.mate ?? null);
  // Exploded view: shown spread apart, except while a mate is being made.
  const explodePreview = useStore((s) => s.explodePreview);
  // Null when not exploded (0 = exploded view steps only).
  const explode = mateDraft ? null : (explodePreview ?? assembly?.explode ?? null);
  const placements = useMemo(() => {
    if (!assembly) return NO_PLACEMENTS;
    const solvedPlaces = Object.fromEntries(assembly.instances.map((i) => [i.id, solved?.placements[i.id] ?? i.placement]));
    const shown = explodeAssembly(assembly, parts, solvedPlaces, explode, allAssemblies);
    return Object.fromEntries(
      leaves.map((l) => {
        // Parts inside a sub-assembly ride along with it.
        const m = placementMatrix(compose(shown[l.top] ?? IDENTITY, l.relative));
        // Mirrored copies: the part flipped across its own YZ plane first.
        if (l.instance.mirrored) for (const k of [0, 1, 2]) m[k] = -m[k];
        return [l.key, m];
      }),
    );
  }, [assembly, solved, parts, explode, leaves, allAssemblies]);

  useEffect(() => viewportApi.current?.setDragEnabled(!!assembly && !mateDraft && explode === null), [assembly, mateDraft, explode]);
  const editingAnything = useStore((s) => !!s.editing);
  // Tools that only take faces: clicking near an edge picks the face it's on.
  const facesOnly = useStore((s) => FACE_TOOLS.has(s.editing?.draft.type ?? ""));
  useEffect(() => viewportApi.current?.setFacesOnly(facesOnly), [facesOnly]);
  useEffect(() => viewportApi.current?.setBoxSelectEnabled(!assembly && !editingAnything), [assembly, editingAnything]);

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
      const f = connectorFrameFor(assembly, parts, c, allAssemblies);
      // The origin's connectors sit at the origin itself.
      if ((!instance && !isOrigin(c)) || !f) continue;
      const where: Placement = instance ? solved?.placements[instance.id] ?? instance.placement : IDENTITY;
      const world = compose(where, framePlacement(f));
      markers.push({ origin: world.position, x: rotate(world.rotation, [1, 0, 0]), z: rotate(world.rotation, [0, 0, 1]) });
    }
    manager.setMarkers(markers);
  }, [assembly, mateDraft, parts, solved, allAssemblies]);

  useEffect(() => viewportApi.current?.setHidden(assembly ? hiddenMeshes(hiddenInstances, leaves) : hiddenParts), [hiddenParts, hiddenInstances, assembly, leaves]);
  const transparentParts = useStore((s) => s.transparentParts);
  useEffect(() => viewportApi.current?.setTransparent(assembly ? NO_IDS : transparentParts), [transparentParts, assembly]);
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
  const deleting = useStore((s) => (s.editing?.draft.type === "deletePart" ? s.editing.draft.deleteParts ?? NO_IDS : null));
  useEffect(() => {
    const lit = assembly
      ? []
      : deleting
        ? deleting
        : booleanDef
        ? [...booleanDef.targets, ...booleanDef.tools]
        : selectedParts.length
          ? selectedParts
          : pickedFeature
            ? partsOfFeature(parts, pickedFeature, studioFeatures)
            : [];
    viewportApi.current?.setSelectedParts(lit);
  }, [selectedParts, assembly, pickedFeature, parts, studioFeatures, booleanDef, deleting]);
  const section = useStore((s) => s.section);
  const appearance = useStore((s) => s.history.present.appearance ?? NO_COLOURS);
  const colours = useMemo(() => {
    if (!assembly) return appearance;
    const out: Record<string, string> = {};
    for (const l of leaves) if (appearance[l.instance.partId]) out[l.key] = appearance[l.instance.partId];
    return out;
  }, [appearance, assembly, leaves]);
  useEffect(() => viewportApi.current?.setPartColours(colours), [colours]);
  useEffect(() => viewportApi.current?.setSection(section ? sectionPlane(section) : null), [section]);
  const printBed = useStore((s) => s.printBed);
  useEffect(() => viewportApi.current?.setPrintBed(printBed ? bedSize(printBed.printer, printBed.custom) : null), [printBed]);
  useEffect(() => {
    // Placements first, so the parts arrive already in position.
    viewportApi.current?.setPlacements(placements);
    viewportApi.current?.setParts(display);
    // The first part in an empty Part Studio: zoom to show it.
    if (hadNothing.current && display.length > 0 && !assembly && !useStore.getState().editing) viewportApi.current?.fit();
    hadNothing.current = display.length === 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display]);
  useEffect(() => viewportApi.current?.setPlacements(placements), [placements]);
  useEffect(
    () =>
      viewportApi.current?.setSelection(
        assembly
          ? mateDraft
            ? connectorItems(parts, assembly, allAssemblies ?? [], [mateDraft.a, mateDraft.b])
            : instanceSelection(display, asmSelection)
          : picks
            ? itemsForPicks(parts, pickList ?? [])
            : selection,
      ),
    [selection, picks, parts, assembly, display, asmSelection, mateDraft, allAssemblies],
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
    // Go back to how the model was being looked at when the sketch closes.
    const before = manager.saveView();
    const controller = new SketchController();
    viewportApi.sketch = controller;
    manager.setSketchController(controller);
    const off = controller.onChange((t) => manager.setSketchTransient(t));
    return () => {
      off();
      manager.setSketchController(null);
      manager.setSketchTransient(null);
      viewportApi.sketch = null;
      manager.restoreView(before);
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
  // A mirror or pattern open: its sketch lines can be clicked, and the plane or axis it uses is drawn.
  const refDraft = useStore((s) => {
    const d = s.editing?.draft;
    return d && (d.type === "mirror" || d.type === "linearPattern" || d.type === "circularPattern") ? d : null;
  });
  const pickLines = useMemo(() => (refDraft && !inAssembly ? pickableSketchLines(features, refDraft.id) : NO_LINES), [refDraft, features, inAssembly]);
  useEffect(() => viewportApi.current?.setPickLines(pickLines), [pickLines]);
  useEffect(() => {
    const shape = refDraft && !inAssembly ? referenceShape(refDraft, features, resolveParams(refDraft).values) : null;
    viewportApi.current?.setReference(shape);
  }, [refDraft, features, inAssembly]);
  const sketchLinks = useStore((s) => s.sketchLinks);
  // An Extrude, Revolve or Sweep open: its sketch's areas are drawn on the sketch plane and can be clicked.
  const areaDraft = useStore((s) => (s.editing && areaClickMode(s.editing.draft) !== "off" ? s.editing.draft : null));
  const areaMode = areaClickMode(areaDraft);
  const areaSketch = areaDraft && !inAssembly ? features.find((f) => f.id === areaDraft.sketchRef && f.type === "sketch") : undefined;
  // A sketch on a part's face is where the face is now (as the engine uses it).
  const followed = followedSketch(areaSketch, sketchLinks);
  const areaData = followed?.data;
  // Keyed on where the plane is, not the object (a rebuild hands over an equal new one).
  const planeValues = followed?.plane ? JSON.stringify(planeFrame(followed.plane)) : null;
  const areaFrame = useMemo(() => (planeValues ? (JSON.parse(planeValues) as PlaneFrame) : null), [planeValues]);
  const areaPicks = areaDraft?.areas;
  const areaMap = useMemo(() => (areaData && areaMode !== "off" ? sketchAreas(areaData) : null), [areaData, areaMode]);
  const areaShading = useMemo(() => (areaData && areaMap ? areaShades(areaData, areaPicks) : null), [areaData, areaMap, areaPicks]);
  const pickAreas = useMemo((): PickAreas | null => {
    if (!areaMap?.areas.length || !areaFrame || !areaShading) return null;
    return { frame: areaFrame, outlines: areaOutlines(areaMap), shades: areaShading, areaAt: (p) => areaMap.areaAt(p), first: areaMode === "first" };
  }, [areaMap, areaFrame, areaShading, areaMode]);
  useEffect(() => viewportApi.current?.setPickAreas(pickAreas), [pickAreas]);
  const others = useMemo(
    () => (inAssembly ? [] : visibleSketches(features, draft?.id ?? null, selectedFeatureId, sketchLinks, refDraft?.id ?? null)),
    [features, draft?.id, selectedFeatureId, inAssembly, refDraft?.id, sketchLinks],
  );
  const refEdges = draft ? sketchLinks[draft.id]?.edges : undefined;
  useEffect(() => {
    const manager = viewportApi.current;
    if (!manager) return;
    if (!plane || !sketchData) {
      manager.setSketchScene(others, null);
      return;
    }
    const { analysis, failing } = sketchStatus(sketchData);
    manager.setSketchScene(others, { plane, data: sketchData, analysis, failing, selection: new Set(sketchSelection ?? []), refs: refEdges });
    // The theme changes the sketch colours, so redraw when it changes.
  }, [others, plane, sketchData, sketchSelection, theme, refEdges]);

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
