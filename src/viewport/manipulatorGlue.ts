/**
 * The open feature dialog's manipulators in the 3D view (Onshape's): which ones show (model/manipulators.ts), and
 * dragging them — the draft changes live, so its box and the preview follow (rebuilt as usual), and letting go is
 * one step of the dialog's own undo (Ctrl+Z while it's open); Esc mid-drag takes back just the drag.
 * The pointer side (press on a handle wins, fingers drag it, never orbit) is the same as Move / copy's triad.
 */
import { manipEditText, manipulatorsFor, manipPatch, typedManipValue, type Manipulator } from "../model/manipulators";
import { activeFeatures, useStore } from "../model/store";
import type { Feature } from "../model/types";
import { lengthUnit } from "../model/units";
import { followedSketch } from "../sketch/areaClicks";
import type { SceneManager, ScreenRay } from "./SceneManager";
import { manipStep, startManipDrag, type ManipDrag, type ManipHandle } from "./manipulatorDrag";

const NONE: Manipulator[] = [];
let cache: { draft: Feature; sketch: unknown; parts: unknown; unit: string; out: Manipulator[] } | null = null;

/** The handles for the open dialog now (the same array while nothing they depend on changed). */
export function manipulatorsNow(): Manipulator[] {
  const s = useStore.getState();
  const draft = s.editing?.draft;
  if (!draft) return NONE;
  // (A Hole's sketch is its own `hole.sketchRef`.)
  const sketchId = draft.sketchRef ?? (draft.type === "hole" ? draft.hole?.sketchRef : undefined);
  const ref = sketchId ? activeFeatures(s).find((f) => f.id === sketchId) : undefined;
  const sketch = ref ? followedSketch(ref, s.sketchLinks) : null;
  const sketchKey = sketch ? sketch.data : null;
  const unit = lengthUnit();
  if (cache && cache.draft === draft && cache.sketch === sketchKey && cache.parts === s.parts && cache.unit === unit) return cache.out;
  let out = manipulatorsFor(draft, { sketch, parts: s.parts });
  if (!out.length) out = NONE;
  // The same array when the handles are the same (so the view isn't redrawn for every rebuild).
  if (cache && JSON.stringify(cache.out) === JSON.stringify(out)) out = cache.out;
  cache = { draft, sketch: sketchKey, parts: s.parts, unit, out };
  return out;
}

let drag: { session: ManipDrag; before: Feature; step: number; manager: SceneManager; last: string } | null = null;

/** A press on an arrow that can't be dragged (a variable's, or one pointing at you): what to say if it's dragged. */
let refused: { say: string; ray: ScreenRay; within: number } | null = null;

/** Is a manipulator being dragged (or a refused one pressed) now? */
export function manipDragging(): boolean {
  return !!drag || !!refused;
}

/** Say why an arrow can't be dragged — only once the pointer really moves (a plain click passes through to what's under it). */
function refuse(manager: SceneManager, say: string, ray: ScreenRay): true {
  refused = { say, ray, within: 3 * manager.mmPerPixel() };
  return true;
}

/** A press (or a finger) landed on a manipulator. True: the press is the handle's (nothing else happens with it). */
export function manipStart(manager: SceneManager | null, handle: ManipHandle, ray: ScreenRay): boolean {
  const s = useStore.getState();
  const draft = s.editing?.draft;
  const m = manipulatorsNow().find((x) => x.id === handle.id);
  if (!manager || !draft || !m) return false;
  refused = null;
  if (m.locked) return refuse(manager, m.locked, ray);
  const session = startManipDrag(m, ray);
  if (!session) return refuse(manager, "This arrow points almost straight at you: turn the view a little to drag it.", ray);
  // A box in the dialog lets go of the keyboard, so Ctrl+Z then undoes the drag (not the box's typing).
  const focused = typeof document !== "undefined" ? document.activeElement : null;
  if (focused instanceof HTMLElement && focused.closest(".feature-dialog")) focused.blur();
  drag = { session, before: draft, step: manipStep(manager.mmPerPixel(), lengthUnit()), manager, last: "" };
  manager.setManipLabel(m.id, m.text);
  return true;
}

/** The pointer moved during a manipulator drag: the draft (its box and the preview) follows. */
export function manipMove(manager: SceneManager | null, ray: ScreenRay, shift: boolean): void {
  if (refused) {
    const o = refused.ray.origin;
    const moved = Math.hypot(ray.origin[0] - o[0], ray.origin[1] - o[1], ray.origin[2] - o[2]);
    if (moved > refused.within) {
      useStore.getState().showToast(refused.say);
      refused = { ...refused, within: Infinity };
    }
    return;
  }
  if (!drag) return;
  const s = useStore.getState();
  // The dialog closed (or another opened) mid-drag: the drag is over, nothing changes.
  if (s.editing?.draft.id !== drag.before.id) {
    drag = null;
    manager?.setManipLabel(null);
    return;
  }
  const m = drag.session.manip;
  const { value, flipped } = drag.session.move(ray, { snap: !shift, step: drag.step });
  const patch = manipPatch(drag.before, m, value, flipped);
  const key = JSON.stringify(patch);
  if (key === drag.last) return;
  drag.last = key;
  s.dragDraft(patch);
  const now = manipulatorsNow().find((x) => x.id === m.id);
  manager?.setManipLabel(m.id, now?.text ?? m.text);
}

/** The drag was let go: one step of the dialog's undo. */
export function manipEnd(manager: SceneManager | null): void {
  refused = null;
  const done = drag;
  drag = null;
  manager?.setManipLabel(null);
  if (done) useStore.getState().endDraftDrag(done.before);
}

/** The drag was taken back (Esc, a second finger, the pointer lost): the draft goes back to how it was. */
export function manipCancel(manager: SceneManager | null): void {
  refused = null;
  const done = drag;
  drag = null;
  manager?.setManipLabel(null);
  if (done) useStore.getState().endDraftDrag(done.before, true);
}

/** Esc while a manipulator is being dragged: only the drag is taken back (the dialog stays open). True if there was one. */
export function escapeManipDrag(): boolean {
  refused = null;
  const d = drag;
  if (!d) return false;
  // The view lets go of the pointer and calls the cancel.
  d.manager.cancelTriadDrag();
  if (drag) manipCancel(d.manager);
  return true;
}

/**
 * A double-click (or double-tap) on a manipulator: a small box by its tip to type the size in (Onshape's in-view
 * edit). Enter sets the box exactly as typing in the dialog's box does — the same step of the dialog's undo, and a
 * variable or a sum may be typed —; Esc or clicking elsewhere changes nothing.
 */
export function manipEdit(manager: SceneManager | null, id: string): void {
  const s = useStore.getState();
  const draft = s.editing?.draft;
  const m = manipulatorsNow().find((x) => x.id === id);
  if (!manager || !draft || !m) return;
  if (m.noEdit) {
    s.showToast(m.tip);
    return;
  }
  manager.editManipValue(id, manipEditText(draft, m), (typed) => {
    const now = useStore.getState();
    const d = now.editing?.draft;
    if (!d || d.id !== draft.id) return null;
    const r = typedManipValue(d, m, typed);
    if ("problem" in r) return r.problem;
    for (const [key, value] of Object.entries(r.params)) now.setDraftParam(key, value);
    return null;
  });
}
