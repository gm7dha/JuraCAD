/**
 * Right-click and double-click on a touch screen, for the app's ordinary
 * controls (the feature list, the tabs, the parts list, sketch dimensions…):
 *
 * - a **long press** (held still about half a second) acts as a right-click:
 *   a `contextmenu` event goes to what's under the finger, so every right-click
 *   menu opens; the mouse events and click the browser makes up when that finger
 *   lifts are dropped (they'd close the menu again or pick the row) — only those:
 *   for at most `LIFT_MS` after the lift, only events that come from the touch
 *   (Chrome's `sourceCapabilities.firesTouchEvents`; elsewhere, near where the
 *   finger lifted), and never once a mouse, trackpad or pen goes down;
 * - a **double-tap** acts as a double-click (`dblclick`), e.g. to rename a tab
 *   or edit a feature.
 *
 * iPad Safari sends neither by itself; Android browsers sometimes do, so a
 * browser's own event that follows ours is dropped (and ours isn't sent when
 * the browser's came first). The 3D view and the drawing sheet work out their
 * own gestures and are left alone, as are text boxes (where a long press
 * selects text). The mouse, a trackpad and a pen are never changed.
 */

import { eventTime, GestureTracker, gestureOptions } from "../viewport/gestures";

/** Things that handle fingers themselves (or must keep the browser's own touch behaviour). */
const OWN_TOUCH = ".viewport-canvas, .drawing-svg, input, textarea, select, [contenteditable], [data-own-touch]";

const NATIVE = ["click", "mousedown", "mouseup", "contextmenu", "dblclick"];

/** How long (ms) after a long-pressed finger lifts the browser's made-up mouse events for it are dropped. */
export const LIFT_MS = 800;
/** How near (px) to where the finger lifted a made-up mouse event lands (for browsers that don't say where events come from). */
const LIFT_NEAR = 24;

type Closest = { closest?: (selector: string) => unknown; isConnected?: boolean; dispatchEvent: (e: Event) => boolean };
type Native = Event & { clientX?: number; clientY?: number; sourceCapabilities?: { firesTouchEvents?: boolean } | null };

export interface TouchCompatOptions {
  /** Long press time (ms; the usual 500 when missing). */
  longPressMs?: number;
  /** The clock (performance.now when missing). */
  now?: () => number;
}

export function installTouchCompat(doc: Document, options: TouchCompatOptions = {}): () => void {
  const win = doc.defaultView as (Window & typeof globalThis) | null;
  if (!win) return () => {};
  const now = options.now ?? (() => performance.now());
  const tracker = new GestureTracker(gestureOptions("touch", options.longPressMs ?? true));
  const Mouse = (win as { MouseEvent?: typeof MouseEvent }).MouseEvent ?? MouseEvent;
  let target: Closest | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let frame: number | null = null;
  let later: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  /** Until when (now()) the browser's own events of these kinds are dropped. */
  const dropUntil = { contextmenu: 0, dblclick: 0 };
  /** A long press is being held (its finger still down). */
  let holding = false;
  /** After that finger lifted: drop the browser's made-up mousedown/mouseup/click from it until then, near there. */
  let lift: { until: number; x: number; y: number } | null = null;
  let nativeMenuSeen = false;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const fire = (type: "contextmenu" | "dblclick", at: Closest, x: number, y: number) => {
    const ev = new Mouse(type, { bubbles: true, cancelable: true, composed: true, view: win, clientX: x, clientY: y, button: type === "contextmenu" ? 2 : 0, buttons: 0, detail: type === "dblclick" ? 2 : 0 });
    at.dispatchEvent(ev);
  };
  const schedule = () => {
    clear();
    const due = tracker.longPressDue;
    if (due === null) return;
    timer = setTimeout(() => {
      // After the next frame, so a finger already lifted (its event still waiting) counts as a tap.
      const at = now();
      frame = win.requestAnimationFrame(() => {
        frame = null;
        later = win.setTimeout(() => {
          later = null;
          timer = null;
          if (disposed) return;
          for (const g of tracker.tick(at)) {
            if (g.type !== "longPress" || !target || nativeMenuSeen || target.isConnected === false) continue;
            holding = true;
            dropUntil.contextmenu = now() + 1200;
            fire("contextmenu", target, g.x, g.y);
          }
        }, 0);
      });
    }, Math.max(0, due - now()) + 5);
  };

  const onDown = (ev: Event) => {
    const e = ev as PointerEvent;
    // A mouse, trackpad or pen: nothing of a long press is dropped any more.
    if (e.pointerType !== "touch") {
      lift = null;
      holding = false;
      return;
    }
    const el = e.target as unknown as Closest | null;
    lift = null;
    if (!tracker.active) {
      if (!el || typeof el.closest !== "function" || el.closest(OWN_TOUCH)) return;
      target = el;
      nativeMenuSeen = false;
      holding = false;
    }
    tracker.down(e.pointerId, e.clientX, e.clientY, eventTime(e, now()));
    schedule();
  };
  const onMove = (ev: Event) => {
    const e = ev as PointerEvent;
    if (e.pointerType !== "touch" || !tracker.active) return;
    tracker.move(e.pointerId, e.clientX, e.clientY, eventTime(e, now()));
    schedule();
  };
  const onUp = (ev: Event) => {
    const e = ev as PointerEvent;
    if (e.pointerType !== "touch" || !tracker.active) return;
    const out = e.type === "pointerup" ? tracker.up(e.pointerId, e.clientX, e.clientY, eventTime(e, now())) : tracker.cancel(e.pointerId);
    schedule();
    if (holding && !tracker.active) {
      holding = false;
      lift = { until: now() + LIFT_MS, x: e.clientX, y: e.clientY };
    }
    for (const g of out) {
      if (g.type !== "tap" || g.count !== 2 || !target || target.isConnected === false) continue;
      // (The browser's own click for this tap still comes, just before the double-click — as with a mouse.)
      const at = target;
      dropUntil.dblclick = now() + 700;
      win.setTimeout(() => !disposed && fire("dblclick", at, g.x, g.y), 0);
    }
  };
  /** A mouse event the browser made up for the long-pressed finger (not a real mouse or trackpad). */
  const fromLift = (e: Native): boolean => {
    if (holding) return e.sourceCapabilities?.firesTouchEvents !== false;
    if (!lift) return false;
    if (now() > lift.until) {
      lift = null;
      return false;
    }
    const caps = e.sourceCapabilities;
    if (caps && typeof caps.firesTouchEvents === "boolean") return caps.firesTouchEvents;
    return typeof e.clientX === "number" && typeof e.clientY === "number" && Math.hypot(e.clientX - lift.x, e.clientY - lift.y) <= LIFT_NEAR;
  };
  // The browser's own: dropped when ours was (or will be) sent.
  const onNative = (ev: Event) => {
    if (!ev.isTrusted) return;
    if (ev.type === "click" || ev.type === "mousedown" || ev.type === "mouseup") {
      if (fromLift(ev as Native)) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        if (ev.type === "click") lift = null;
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
    if (now() < dropUntil[type]) {
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
  doc.addEventListener("lostpointercapture", onUp, passive);
  for (const t of NATIVE) doc.addEventListener(t, onNative, capture);
  return () => {
    disposed = true;
    clear();
    if (frame !== null) win.cancelAnimationFrame?.(frame);
    if (later) clearTimeout(later);
    doc.removeEventListener("pointerdown", onDown, passive);
    doc.removeEventListener("pointermove", onMove, passive);
    doc.removeEventListener("pointerup", onUp, passive);
    doc.removeEventListener("pointercancel", onUp, passive);
    doc.removeEventListener("lostpointercapture", onUp, passive);
    for (const t of NATIVE) doc.removeEventListener(t, onNative, capture);
  };
}
