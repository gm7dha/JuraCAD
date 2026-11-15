/**
 * The open feature dialog's manipulators in the 3D view (Onshape's): which ones show (model/manipulators.ts), and
 * dragging them — the draft changes live, so its box and the preview follow (rebuilt as usual), and letting go is
 * one step of the dialog's own undo (Ctrl+Z while it's open); Esc mid-drag takes back just the drag.
 * The pointer side (press on a handle wins, fingers drag it, never orbit) is the same as Move / copy's triad.
 */
import { manipulatorsFor, manipPatch, type Manipulator } from "../model/manipulators";
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
  const ref = draft.sketchRef ? activeFeatures(s).find((f) => f.id === draft.sketchRef) : undefined;
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

/** Is a manipulator being dragged now? */
export function manipDragging(): boolean {
  return !!drag;
}

/** A press (or a finger) landed on a manipulator. True: the press is the handle's (nothing else happens with it). */
export function manipStart(manager: SceneManager | null, handle: ManipHandle, ray: ScreenRay): boolean {
  const s = useStore.getState();
  const draft = s.editing?.draft;
  const m = manipulatorsNow().find((x) => x.id === handle.id);
  if (!manager || !draft || !m) return false;
  if (m.locked) {
    s.showToast(m.locked);
    return true;
  }
  const session = startManipDrag(m, ray);
  if (!session) {
    s.showToast("This arrow points almost straight at you: turn the view a little to drag it.");
    return true;
  }
  // A box in the dialog lets go of the keyboard, so Ctrl+Z then undoes the drag (not the box's typing).
  const focused = typeof document !== "undefined" ? document.activeElement : null;
  if (focused instanceof HTMLElement && focused.closest(".feature-dialog")) focused.blur();
  drag = { session, before: draft, step: manipStep(manager.mmPerPixel(), lengthUnit()), manager, last: "" };
  manager.setManipLabel(m.id, m.text);
  return true;
}

/** The pointer moved during a manipulator drag: the draft (its box and the preview) follows. */
export function manipMove(manager: SceneManager | null, ray: ScreenRay, shift: boolean): void {
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
  const done = drag;
  drag = null;
  manager?.setManipLabel(null);
  if (done) useStore.getState().endDraftDrag(done.before);
}

/** The drag was taken back (Esc, a second finger, the pointer lost): the draft goes back to how it was. */
export function manipCancel(manager: SceneManager | null): void {
  const done = drag;
  drag = null;
  manager?.setManipLabel(null);
  if (done) useStore.getState().endDraftDrag(done.before, true);
}

/** Esc while a manipulator is being dragged: only the drag is taken back (the dialog stays open). True if there was one. */
export function escapeManipDrag(): boolean {
  const d = drag;
  if (!d) return false;
  // The view lets go of the pointer and calls the cancel.
  d.manager.cancelTriadDrag();
  if (drag) manipCancel(d.manager);
  return true;
}
