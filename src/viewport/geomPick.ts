/**
 * Clicks in the 3D view for the newer Plane types and Part Studio mate
 * connectors: what was clicked, as the pure geomClicks.ts wants it, and what
 * it changes in the open dialog (or the design). Mate connector marks drawn
 * in the view are worked out here too.
 */
import { useStore, activeFeatures, pickFor } from "../model/store";
import { framesOf, planeAsSketchPlane } from "../sketch/planeFeature";
import { planeFrame, type PlaneFrame } from "../sketch/planes";
import { connectorFromClick, fractionAlong, planeClick, type GeomClick } from "../model/geomClicks";
import { curveClick, curvePoint, pathClick, type CurveClick } from "../model/curveClicks";
import { laterPathMessage, togglePathCurve } from "../model/frame";
import { isMorePlaneMode } from "../sketch/planeTypes";
import { loftClick } from "../model/loft";
import { boundaryClick } from "../model/surfaceClicks";
import { sketchLine3D } from "../model/patternRefs";
import type { Feature } from "../model/types";
import type { PartMesh } from "../kernel/protocol";
import type { ConnectorMark, PickTarget, SceneManager } from "./SceneManager";
import { planeVisible } from "../model/visibility";
import { transformDraft } from "./transformTriad";

type Vec3 = [number, number, number];

/** Where each Part Studio mate connector is: as the engine placed it (on its owner part), else from its own settings. */
export function connectorFrames(features: Feature[], parts: PartMesh[], built?: Readonly<Record<string, PlaneFrame>>): Map<string, { origin: Vec3; x: Vec3; z: Vec3 }> {
  const out = new Map<string, { origin: Vec3; x: Vec3; z: Vec3 }>();
  const planes = framesOf(features, undefined, built);
  for (const f of features) {
    if (f.type !== "mateConnector" || f.suppressed) continue;
    const fr = planes.get(f.id);
    if (fr) out.set(f.id, { origin: fr.origin, x: fr.u, z: fr.n });
  }
  for (const p of parts) for (const c of p.connectors ?? []) if (out.has(c.id)) out.set(c.id, { origin: c.origin, x: c.x, z: c.z });
  return out;
}

/** The Part Studio's mate connectors to draw: those shown with the eye, and the one being made or changed. */
export function studioConnectorMarks(features: Feature[], parts: PartMesh[], draft: Feature | null, picked: string | null, built?: Readonly<Record<string, PlaneFrame>>): ConnectorMark[] {
  const frames = connectorFrames(features, parts, built);
  const out: ConnectorMark[] = [];
  for (const f of features) {
    if (f.type !== "mateConnector" || f.suppressed || f.id === draft?.id || !planeVisible(f)) continue;
    const fr = frames.get(f.id);
    if (fr) out.push({ key: f.id, ...fr, lit: f.id === picked });
  }
  if (draft?.type === "mateConnector") {
    const fr = connectorFrames([draft], [], built).get(draft.id);
    if (fr) out.push({ key: draft.id, ...fr, lit: true });
  }
  return out;
}

/** A curve feature's drawn lines as one list of points. */
function curvePoints(lines: number[][] | undefined): Vec3[] {
  const out: Vec3[] = [];
  for (const line of lines ?? []) for (let i = 0; i + 2 < line.length; i += 3) out.push([line[i], line[i + 1], line[i + 2]]);
  return out;
}

/** A click as the newer planes and mate connectors take it (null: nothing they can use). */
export function geomClickOf(manager: SceneManager | null, target: PickTarget | null): GeomClick | null {
  const s = useStore.getState();
  const features = activeFeatures(s);
  if (!target) return null;
  if (target.kind === "plane") {
    const plane = { kind: "default", name: target.plane } as const;
    return { kind: "plane", plane, frame: planeFrame(plane) };
  }
  if (target.kind === "customPlane") {
    const f = features.find((x) => x.id === target.id);
    const frame = framesOf(features, undefined, s.builtFrames).get(target.id);
    return f && frame ? { kind: "plane", plane: planeAsSketchPlane(f, frame), frame } : null;
  }
  if (target.kind === "connector") {
    const fr = connectorFrames(features, s.parts, s.builtFrames).get(target.key);
    return fr ? { kind: "connector", id: target.key, ...fr } : null;
  }
  if (target.kind === "sketchLine") {
    const line = { sketch: target.id, line: target.line };
    const l = sketchLine3D(features, line);
    return typeof l === "string" ? null : { kind: "sketchLine", line, a: l.a, b: l.b };
  }
  if (target.kind !== "part") return null;
  const pick = pickFor(s.parts, target.item);
  if (!pick) return null;
  return { kind: "part", pick, ...(target.point ? { at: target.point } : {}), ...(target.item.kind === "edge" ? { points: manager?.edgePoints(target.item.partId, target.item.index) ?? [] } : {}) };
}

/**
 * A click while a newer Plane type or a Mate connector is open, or on a mate connector while Move / copy wants one,
 * or a sketch a plane. True when it was used.
 */
export function geomPick(manager: SceneManager | null, target: PickTarget | null): boolean {
  const s = useStore.getState();
  const d = s.editing?.draft;
  // Curve features (Helix, Fit spline…), and a Sweep's or Curve pattern's path.
  const curveTarget = (): CurveClick | null => {
    if (target?.kind !== "curve") return geomClickOf(manager, target);
    return { kind: "curve", id: target.id, at: target.point, points: curvePoints(s.builtCurves[target.id]) };
  };
  // A Boundary surface: a curve feature clicked is one of its curves.
  if (d?.type === "boundary" && d.boundary && target?.kind === "curve") {
    const next = boundaryClick(d.boundary, { kind: "curve", id: target.id });
    if (typeof next === "string") s.showToast(next);
    else s.setDraftField({ boundary: next });
    return true;
  }
  if (d?.type === "curve" && d.curve) {
    const c = curveTarget();
    if (!c) return true;
    const next = curveClick(d, c);
    if (typeof next === "string") s.showToast(next);
    else s.setDraftField(next);
    return true;
  }
  if ((d?.type === "sweep" || d?.type === "curvePattern") && (target?.kind === "curve" || d.pathEdges)) {
    const c = curveTarget();
    const next = c ? pathClick(d, c) : null;
    if (next) {
      if (next.pathRef && d.sketchRef === next.pathRef) return true;
      s.setDraftField(next);
      return true;
    }
  }
  // A Curve point plane on a curve feature: where along it was clicked.
  if (target?.kind === "curve" && d?.type === "plane" && d.planeDef?.mode === "curvePoint") {
    const pts = curvePoints(s.builtCurves[target.id]);
    s.setDraftField({ planeDef: { ...d.planeDef, points: [{ p: target.point, curve: target.id }], position: fractionAlong(pts, target.point) } });
    return true;
  }
  if (target?.kind === "curve" && d?.type === "plane" && d.planeDef && isMorePlaneMode(d.planeDef.mode)) {
    // Other plane types: an end or the middle of the curve as a point.
    const c = curveTarget();
    if (c?.kind === "curve") {
      const pt = curvePoint(c);
      const list = d.planeDef.points ?? [];
      const many = d.planeDef.mode === "threePoint" || d.planeDef.mode === "fit";
      s.setDraftField({ planeDef: { ...d.planeDef, points: many ? [...list, pt] : [pt] } });
    }
    return true;
  }
  // A Frame follows a curve clicked (or leaves it out again).
  if (target?.kind === "curve" && d?.type === "frame" && d.frame) {
    const later = laterPathMessage(activeFeatures(s), d.id, target.id);
    if (later) s.showToast(later);
    else if (target.id !== d.id) s.setDraftField({ frame: togglePathCurve(d.frame, target.id) });
    return true;
  }
  if (target?.kind === "curve") {
    // Nothing that takes a curve is open: select it in the list.
    if (!s.editing) s.selectFeature(target.id);
    return true;
  }
  if (d?.type === "plane" && d.planeDef && isMorePlaneMode(d.planeDef.mode)) {
    if (target?.kind === "customPlane" && target.id === d.id) return true;
    const c = geomClickOf(manager, target);
    if (!c) return true;
    const next = planeClick(d.planeDef, c);
    if (typeof next === "string") s.showToast(next);
    else s.setDraftField({ planeDef: next });
    return true;
  }
  // Loft: a flat face as a section, a corner as its start/end point, edges as the guide or path.
  if (d?.type === "loft" && target?.kind === "part") {
    const c = geomClickOf(manager, target);
    if (!c) return true;
    const next = loftClick(d, c);
    if (typeof next === "string") s.showToast(next);
    else s.setDraftField(next);
    return true;
  }
  if (d?.type === "mateConnector" && d.connector) {
    if (target?.kind === "connector" && target.key === d.id) return true;
    const c = geomClickOf(manager, target);
    if (!c) return true;
    const placed = connectorFromClick(c);
    if (typeof placed === "string") {
      s.showToast(placed);
      return true;
    }
    const { plane: _p, ...rest } = d.connector;
    s.setDraftField({ connector: { ...rest, ...placed, ...(placed.plane ? { plane: placed.plane } : {}) } });
    return true;
  }
  if (target?.kind !== "connector") return false;
  // A mate connector clicked for Move / copy's "Transform by mate connectors".
  const t = transformDraft();
  if (t && (t.transform.picking === "from" || t.transform.picking === "to")) {
    const fr = connectorFrames(activeFeatures(s), s.parts, s.builtFrames).get(target.key);
    if (!fr) return true;
    const frame = { origin: fr.origin, x: fr.x, z: fr.z };
    if (t.transform.picking === "from") s.changeDraftStep({ transform: { ...t.transform, from: frame, fromConnector: target.key, picking: t.transform.to || t.transform.toConnector ? undefined : "to" } });
    else s.changeDraftStep({ transform: { ...t.transform, to: frame, toConnector: target.key, picking: undefined } });
    return true;
  }
  // A sketch waiting for a plane: the connector's XY plane.
  const features = activeFeatures(s);
  const f = features.find((x) => x.id === target.key);
  const frame = framesOf(features, undefined, s.builtFrames).get(target.key);
  if (s.sketch && d?.sketch && !d.sketch.plane && f && frame) {
    s.setSketchPlane(planeAsSketchPlane(f, frame));
    return true;
  }
  // A mirror across its XY plane (followed as it moves, like a Plane feature).
  if (d?.type === "mirror" && f && frame) {
    s.setDraftMirrorPlane(planeAsSketchPlane(f, frame));
    return true;
  }
  // Text, or a plane based on it: its XY plane.
  if (d?.type === "text" && d.text && f && frame) {
    s.setDraftField({ text: { ...d.text, plane: planeAsSketchPlane(f, frame) } });
    return true;
  }
  if (d?.type === "plane" && d.planeDef && f && frame) {
    s.setDraftField({ planeDef: { ...d.planeDef, ref: planeAsSketchPlane(f, frame) } });
    return true;
  }
  if (!s.editing && f) s.selectFeature(f.id);
  return true;
}
