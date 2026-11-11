/**
 * Move / copy's triad in the 3D view: what the open dialog's triad looks like,
 * dragging its handles (the boxes follow live; letting go is one change to the
 * draft, undone with Ctrl+Z while the dialog is open), and clicks that choose
 * where the triad, a direction, a line or a mate connector goes. The maths is
 * in transformMath.ts / transformDrag.ts / transformPicks.ts (pure).
 */
import { resolveParams } from "../model/features";
import { activeFeatures, useStore } from "../model/store";
import { baseFrame, compose, IDENTITY, invert, savedFrame, toMatrix4, transformMode, transformMotion, transformTriad, valuesInFrame, type Frame, type Rigid, type Triad, type TransformValues, type Vec3 } from "../model/transformMath";
import { directionBy, directionOf, frameBy, lineBy, lineOf, spotFrame, tidyVec, type SpotSource } from "../model/transformPicks";
import { lengthUnit, startingLength } from "../model/units";
import type { Feature } from "../model/types";
import { planeFrame, type SketchPlane } from "../sketch/planes";
import { framesOf, planeAsSketchPlane } from "../sketch/planeFeature";
import type { PickTarget, SceneManager, ScreenRay } from "./SceneManager";
import { handleName, lengthStep, startTriadDrag, type TriadDrag, type TriadHandle } from "./transformDrag";

type TransformDraft = Feature & { transform: NonNullable<Feature["transform"]> };

/** The open Move / copy draft, if that's what's open. */
export function transformDraft(): TransformDraft | null {
  const d = useStore.getState().editing?.draft;
  return d?.type === "transform" && d.transform ? (d as TransformDraft) : null;
}

/** The draft's values, with the boxes being dragged (live) on top. */
function valuesOf(d: Feature, live: Record<string, string> | null): TransformValues {
  return resolveParams(live ? { ...d, params: { ...d.params, ...live } } : d).values;
}

/** The triad for the open draft (null: none to show), as the dialog's boxes say now. */
export function triadFor(d: TransformDraft | null, centre: Vec3 | undefined, live: Record<string, string> | null): Triad | null {
  if (!d || !centre || !d.transform.partId) return null;
  return transformTriad(d.transform, valuesOf(d, live), centre);
}

/** The id of the mesh that shows the moved part: the copy (named after the feature) or the part itself. */
function movedMeshId(d: TransformDraft): string {
  return d.transform.copy ? d.id : d.transform.partId ?? "";
}

/** How the part shown now has been moved (the draft as last built; none when it couldn't be built). */
function shownMotion(d: TransformDraft): Rigid {
  const s = useStore.getState();
  const centre = s.transformCentres[d.id];
  if (!centre || s.featureErrors[d.id]) return IDENTITY;
  const m = transformMotion(d.transform, valuesOf(d, null), centre);
  return typeof m === "string" ? IDENTITY : m;
}

const lengthKeys = new Set(["dx", "dy", "dz", "distance"]);

/** A dragged value as the box shows it: lengths in the design's units, angles in degrees. */
function boxText(key: string, value: number): string {
  return lengthKeys.has(key) ? startingLength(value) : String(Math.round(value * 1000) / 1000);
}

let drag: { session: TriadDrag; draft: TransformDraft; base: Rigid; centre: Vec3; step: number; live: Record<string, string> | null } | null = null;
/** After a drag is let go: the parts on show then (the moved look is kept until the rebuilt part arrives). */
let waitingFor: unknown = null;

/** A drag began on a triad handle. */
export function triadStart(manager: SceneManager | null, handle: TriadHandle, ray: ScreenRay, _shift: boolean, size: number): boolean {
  const s = useStore.getState();
  const d = transformDraft();
  const centre = d ? s.transformCentres[d.id] : undefined;
  const triad = triadFor(d, centre, null);
  if (!d || !centre || !triad || !manager) return false;
  const session = startTriadDrag(handle, triad, size, ray, valuesOf(d, null), transformMode(d.transform));
  if (!session) {
    s.showToast(`The ${handleName(handle)} points almost straight at you: turn the view a little to drag it.`);
    return false;
  }
  drag = { session, draft: d, base: shownMotion(d), centre, step: lengthStep(manager.mmPerPixel(), lengthUnit()), live: null };
  return true;
}

/** The pointer moved during a triad drag: the boxes show the new values and the part is shown moved. */
export function triadMove(manager: SceneManager | null, ray: ScreenRay, shift: boolean): void {
  if (!drag) return;
  const values = drag.session.move(ray, { snap: !shift, step: drag.step });
  const live = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, boxText(k, v as number)]));
  drag.live = live;
  useStore.getState().setTransformLive(live);
  const d = drag.draft;
  const m = transformMotion(d.transform, valuesOf(d, live), drag.centre);
  if (typeof m !== "string") manager?.setPreviewMove(movedMeshId(d), toMatrix4(compose(m, invert(drag.base))));
}

/** The drag was let go: one change to the draft (rebuilt as usual). */
export function triadEnd(manager: SceneManager | null): void {
  const done = drag;
  drag = null;
  const s = useStore.getState();
  const changed = done?.live && Object.entries(done.live).some(([k, v]) => (done.draft.params[k] ?? "0") !== v);
  if (!done || !changed || transformDraft()?.id !== done.draft.id) {
    s.setTransformLive(null);
    manager?.clearPreviewMoves();
    return;
  }
  waitingFor = s.parts;
  s.changeDraftStep({ params: done.live! });
}

/** The drag was taken back (a second finger, or the pointer was lost): nothing changes. */
export function triadCancel(manager: SceneManager | null): void {
  drag = null;
  useStore.getState().setTransformLive(null);
  manager?.clearPreviewMoves();
}

/** New parts arrived: stop showing the dragged part ahead of its rebuild. */
export function partsArrived(manager: SceneManager | null, parts: unknown): void {
  if (drag || (waitingFor !== null && parts === waitingFor)) return;
  waitingFor = null;
  manager?.clearPreviewMoves();
}

/** What a click hit, as transformPicks wants it (null: nothing it can use). */
function spotSource(manager: SceneManager | null, target: PickTarget | null): { src: SpotSource; partId?: string } | null {
  const s = useStore.getState();
  if (!target) return null;
  if (target.kind === "plane") return { src: { kind: "plane", frame: planeFrame({ kind: "default", name: target.plane }) } };
  if (target.kind === "customPlane") {
    const features = activeFeatures(s);
    const f = features.find((x) => x.id === target.id);
    const frame = framesOf(features).get(target.id);
    const plane: SketchPlane | null = f && frame ? planeAsSketchPlane(f, frame) : null;
    return plane ? { src: { kind: "plane", frame: planeFrame(plane) } } : null;
  }
  if (target.kind !== "part") return null;
  const part = s.parts.find((p) => p.id === target.item.partId);
  const at = target.point;
  if (target.item.kind === "face") {
    const ref = part?.faceRefs?.[target.item.index];
    return ref?.kind === "face" ? { src: { kind: "face", ref, at }, partId: target.item.partId } : null;
  }
  const ref = part?.edgeRefs?.[target.item.index];
  if (ref?.kind !== "edge") return null;
  return { src: { kind: "edge", ref, at, points: manager?.edgePoints(target.item.partId, target.item.index) ?? [] }, partId: target.item.partId };
}

/**
 * A click while Move / copy is open: the part to move, or (after a "click…" button) where the triad goes, the
 * direction or axis, the line, or a mate connector. True when it was used.
 */
export function transformPick(manager: SceneManager | null, target: PickTarget | null): boolean {
  const s = useStore.getState();
  const d = transformDraft();
  if (!d) return false;
  const t = d.transform;
  const picking = t.picking ?? "part";
  if (picking === "part") {
    if (target?.kind === "part" && target.item.partId !== d.id) s.setDraftField({ transform: { ...t, partId: target.item.partId } });
    return true;
  }
  const hit = spotSource(manager, target);
  if (!hit) return true;
  // Clicked on the part being moved (as it's shown, moved): taken back to where it was before the move.
  const onMoved = hit.partId !== undefined && (hit.partId === d.id || (!t.copy && hit.partId === t.partId));
  const back = onMoved ? invert(shownMotion(d)) : IDENTITY;
  const centre = s.transformCentres[d.id] ?? [0, 0, 0];
  const say = (problem: string) => s.showToast(problem);
  if (picking === "triad") {
    const near = triadFor(d, centre, null)?.frame.origin ?? baseFrame(t, centre).origin;
    const shown = spotFrame(hit.src, near);
    if (typeof shown === "string") return say(shown), true;
    // Its origin as before the move; its directions as seen (the triad keeps its directions while the part turns).
    const frame: Frame = { ...shown, origin: onMoved ? frameBy(back, shown).origin : shown.origin };
    placeTriad(d, frame);
    return true;
  }
  if (picking === "along") {
    const shown = directionOf(hit.src);
    if (typeof shown === "string") return say(shown), true;
    const dir = directionBy(back, shown);
    s.changeDraftStep({ transform: { ...t, along: { dir: tidyVec(dir.dir), through: tidyVec(dir.through) }, picking: undefined } });
    return true;
  }
  if (picking === "line") {
    const shown = lineOf(hit.src);
    if (typeof shown === "string") return say(shown), true;
    const line = lineBy(back, shown);
    s.changeDraftStep({ transform: { ...t, line: { a: tidyVec(line.a), b: tidyVec(line.b) }, picking: undefined } });
    return true;
  }
  const shown = spotFrame(hit.src, triadFor(d, centre, null)?.frame.origin ?? centre);
  if (typeof shown === "string") return say(shown), true;
  if (picking === "from") {
    s.changeDraftStep({ transform: { ...t, from: savedFrame(frameBy(back, shown)), picking: t.to ? undefined : "to" } });
    return true;
  }
  s.changeDraftStep({ transform: { ...t, to: savedFrame(shown), picking: undefined } });
  return true;
}

/**
 * Put the triad somewhere else (null: back to the part's centre, along X, Y and Z). The boxes are worked out again
 * for its new directions, so the part stays where it is.
 */
export function placeTriad(d: TransformDraft, frame: Frame | null): void {
  const s = useStore.getState();
  const t = d.transform;
  const centre = s.transformCentres[d.id] ?? [0, 0, 0];
  const mode = transformMode(t);
  const next: TransformDraft["transform"] = { ...t, picking: undefined };
  if (frame) next.triad = savedFrame(frame);
  else delete next.triad;
  if (mode !== "free" && mode !== "xyz") {
    s.changeDraftStep({ transform: next });
    return;
  }
  const kept = valuesInFrame(t, resolveParams(d).values, centre, frame ?? baseFrame(next, centre));
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(kept)) if (mode === "free" || k.startsWith("d")) params[k] = boxText(k, v);
  s.changeDraftStep({ transform: next, params });
}
