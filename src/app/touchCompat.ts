/**
 * Right-click and double-click on a touch screen, for the app's ordinary
 * controls (the feature list, the tabs, the parts list, sketch dimensions…):
 *
 * - a **long press** (held still about half a second) acts as a right-click:
 *   a `contextmenu` event goes to what's under the finger, so every right-click
 *   menu opens; the mouse events and click the browser makes up when that finger
 *   lifts are dropped (they'd close the menu again or pick the row);
 * - a **double-tap** acts as a double-click (`dblclick`), e.g. to rename a tab
 *   or edit a feature.
 *
 * iPad Safari sends neither by itself; Android browsers sometimes do, so a
 * browser's own event that follows ours is dropped (and ours isn't sent when
 * the browser's came first). The 3D view and the drawing sheet work out their
 * own gestures and are left alone, as are text boxes (where a long press
 * selects text). The mouse never comes here.
 */

import { GestureTracker, gestureOptions } from "../viewport/gestures";

/** Things that handle fingers themselves (or must keep the browser's own touch behaviour). */
const OWN_TOUCH = ".viewport-canvas, .drawing-svg, input, textarea, select, [contenteditable], [data-own-touch]";

const NATIVE = ["click", "mousedown", "mouseup", "contextmenu", "dblclick"];

export function installTouchCompat(doc: Document): () => void {
  const win = doc.defaultView;
  if (!win) return () => {};
  const tracker = new GestureTracker(gestureOptions("touch"));
  let target: Element | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Until when (performance.now()) the browser's own events of these kinds are dropped. */
  const dropUntil = { contextmenu: 0, dblclick: 0 };
  /** After a long press: drop the browser's made-up mousedown/mouseup/click until the next finger comes down. */
  let dropLift = false;
  let nativeMenuSeen = false;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const fire = (type: "contextmenu" | "dblclick", at: Element, x: number, y: number) => {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: win, clientX: x, clientY: y, button: type === "contextmenu" ? 2 : 0, buttons: 0, detail: type === "dblclick" ? 2 : 0 });
    at.dispatchEvent(ev);
  };
  const schedule = () => {
    clear();
    const due = tracker.longPressDue;
    if (due === null) return;
    timer = setTimeout(() => {
      timer = null;
      for (const g of tracker.tick(performance.now())) {
        if (g.type !== "longPress" || !target || nativeMenuSeen || !target.isConnected) continue;
        const now = performance.now();
        dropLift = true;
        dropUntil.contextmenu = now + 1200;
        fire("contextmenu", target, g.x, g.y);
      }
    }, Math.max(0, due - performance.now()) + 5);
  };

  const onDown = (ev: Event) => {
    const e = ev as PointerEvent;
    if (e.pointerType !== "touch") return;
    const el = e.target instanceof Element ? e.target : null;
    dropLift = false;
    if (!tracker.active) {
      if (!el || el.closest(OWN_TOUCH)) return;
      target = el;
      nativeMenuSeen = false;
    }
    tracker.down(e.pointerId, e.clientX, e.clientY, performance.now());
    schedule();
  };
  const onMove = (ev: Event) => {
    const e = ev as PointerEvent;
    if (e.pointerType !== "touch" || !tracker.active) return;
    tracker.move(e.pointerId, e.clientX, e.clientY, performance.now());
    schedule();
  };
  const onUp = (ev: Event) => {
    const e = ev as PointerEvent;
    if (e.pointerType !== "touch" || !tracker.active) return;
    const out = e.type === "pointercancel" ? tracker.cancel(e.pointerId) : tracker.up(e.pointerId, e.clientX, e.clientY, performance.now());
    schedule();
    for (const g of out) {
      if (g.type !== "tap" || g.count !== 2 || !target?.isConnected) continue;
      // (The browser's own click for this tap still comes, just before the double-click — as with a mouse.)
      const at = target;
      dropUntil.dblclick = performance.now() + 700;
      win.setTimeout(() => fire("dblclick", at, g.x, g.y), 0);
    }
  };
  // The browser's own: dropped when ours was (or will be) sent.
  const onNative = (ev: Event) => {
    if (!ev.isTrusted) return;
    if (ev.type === "click" || ev.type === "mousedown" || ev.type === "mouseup") {
      if (dropLift) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
      return;
    }
    const type = ev.type as keyof typeof dropUntil;
    if (type === "contextmenu" && tracker.active && timer) {
      // The browser sent its own right-click for this press first: don't send ours too.
      nativeMenuSeen = true;
      clear();
      return;
    }
    if (performance.now() < dropUntil[type]) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      dropUntil[type] = 0;
    }
  };

  const capture = { capture: true } as AddEventListenerOptions;
  const passive = { capture: true, passive: true } as AddEventListenerOptions;
  doc.addEventListener("pointerdown", onDown, passive);
  doc.addEventListener("pointermove", onMove, passive);
  doc.addEventListener("pointerup", onUp, passive);
  doc.addEventListener("pointercancel", onUp, passive);
  for (const t of NATIVE) doc.addEventListener(t, onNative, capture);
  return () => {
    clear();
    doc.removeEventListener("pointerdown", onDown, passive);
    doc.removeEventListener("pointermove", onMove, passive);
    doc.removeEventListener("pointerup", onUp, passive);
    doc.removeEventListener("pointercancel", onUp, passive);
    for (const t of NATIVE) doc.removeEventListener(t, onNative, capture);
  };
}
