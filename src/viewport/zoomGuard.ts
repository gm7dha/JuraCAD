/**
 * Keeping the browser from zooming the whole page (toolbars, panels and all)
 * when the user zooms one of the app's views.
 *
 * A trackpad pinch arrives as a wheel event with `ctrlKey` set (Chrome, Edge,
 * Firefox), and Ctrl + mouse wheel is the same event; Safari on a Mac sends its
 * own `gesturestart` / `gesturechange` / `gestureend` events for a pinch. Unless
 * the page calls `preventDefault()` on them, the browser zooms the page. That
 * only works from a listener added with `{ passive: false }`: React's `onWheel`
 * listens passively, so it can't. These listeners are added straight on the
 * element, and only take events over the view itself (`owns`), so the page can
 * still be zoomed as usual from anywhere else.
 */

type P2 = [number, number];

/** The sheet's narrowest view (sheet mm across: about a 20 mm patch fills the screen) — zooming in further does nothing. */
export const SHEET_MIN_WIDTH = 20;

/**
 * How much one wheel event zooms the drawing sheet: the factor on how much of
 * it is shown (above 1 zooms out). A mouse wheel's notch is as before; lines and
 * pages (Firefox) count as 16 and 100 pixels; a pinch's small steps count ten
 * times (as the 3D view does); one event never zooms more than about 1.65 times.
 */
export function sheetWheelFactor(e: { deltaY: number; deltaMode?: number; ctrlKey?: boolean }): number {
  let d = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
  if (e.ctrlKey) d *= 10;
  return Math.exp(Math.max(-0.5, Math.min(0.5, d * 0.0015)));
}

/** Safari's pinch: from the gesture's scale at the last step and now, the factor on how much is shown (above 1 zooms out). */
export function gestureFactor(prevScale: number, scale: number): number {
  if (!(prevScale > 0) || !(scale > 0) || !Number.isFinite(prevScale) || !Number.isFinite(scale)) return 1;
  return prevScale / scale;
}

/**
 * The sheet's view box ([x, y, width, height], SVG units, y down) zoomed by
 * `factor` about the point under the pointer (`client`, screen pixels; `rect` is
 * where the SVG is on screen; the box is fitted inside it, centred, as SVG does
 * by default). The width stays between `minW` and `maxW`; at a limit it's left
 * as it is.
 */
export function zoomBox(
  box: [number, number, number, number],
  rect: { left: number; top: number; width: number; height: number },
  client: P2,
  factor: number,
  minW: number,
  maxW: number,
): [number, number, number, number] {
  const [bx, by, bw, bh] = box;
  if (!(rect.width > 0) || !(rect.height > 0) || !(bw > 0) || !(bh > 0)) return box;
  // SVG units per screen pixel, and the point under the pointer in SVG units.
  const s = Math.max(bw / rect.width, bh / rect.height);
  const x = bx - (rect.width * s - bw) / 2 + (client[0] - rect.left) * s;
  const y = by - (rect.height * s - bh) / 2 + (client[1] - rect.top) * s;
  const nw = Math.min(Math.max(bw * factor, minW), maxW);
  const f = nw / bw;
  if (f === 1) return box;
  return [x - (x - bx) * f, y - (y - by) * f, nw, bh * f];
}

/**
 * The wheel step that makes the 3D view's OrbitControls (three r169) zoom so
 * `factor` as much is shown (it zooms by 0.95^(zoomSpeed × |deltaY| / 100) per event).
 */
export function orbitWheelDelta(factor: number, zoomSpeed: number): number {
  if (!(factor > 0) || !(zoomSpeed > 0)) return 0;
  return Math.log(factor) / (zoomSpeed * 0.01 * -Math.log(0.95));
}

/** How long (ms) after a pinch's wheel event a Safari gesture step is taken to be the same pinch (so it isn't zoomed twice). */
const SAME_PINCH_MS = 250;

/** Safari's gesture events (not in the DOM types). */
type GestureLike = Event & { scale?: number; clientX?: number; clientY?: number };

/**
 * Listen on `el` for wheel and pinch events over the view (`owns(target)`):
 * stop the browser zooming the page, and pass them on — `wheel` gets each wheel
 * event, `pinch` each step of a Safari pinch (the factor on how much is shown,
 * and where). Returns a function that stops listening.
 */
export function guardZoom(
  el: Element,
  opts: {
    owns: (target: EventTarget | null) => boolean;
    wheel: (e: WheelEvent) => void;
    pinch: (factor: number, clientX: number, clientY: number) => void;
  },
): () => void {
  let lastScale = 1;
  let lastPinchWheel = -Infinity;
  const onWheel = (ev: Event) => {
    const e = ev as WheelEvent;
    if (!opts.owns(e.target)) return;
    // Always — also when the view is already zoomed in (or out) as far as it goes.
    e.preventDefault();
    if (e.ctrlKey && e.isTrusted) lastPinchWheel = performance.now();
    opts.wheel(e);
  };
  const onGesture = (ev: Event) => {
    const e = ev as GestureLike;
    if (!opts.owns(e.target)) return;
    e.preventDefault();
    const scale = typeof e.scale === "number" ? e.scale : 1;
    if (e.type === "gesturestart") lastScale = 1;
    else if (e.type === "gesturechange") {
      const factor = gestureFactor(lastScale, scale);
      lastScale = scale;
      // (If the browser also sent the pinch as wheel events, that's already zoomed.)
      if (factor !== 1 && performance.now() - lastPinchWheel > SAME_PINCH_MS) opts.pinch(factor, e.clientX ?? 0, e.clientY ?? 0);
    }
  };
  const active = { passive: false } as AddEventListenerOptions;
  el.addEventListener("wheel", onWheel, active);
  for (const t of ["gesturestart", "gesturechange", "gestureend"]) el.addEventListener(t, onGesture, active);
  return () => {
    el.removeEventListener("wheel", onWheel, active);
    for (const t of ["gesturestart", "gesturechange", "gestureend"]) el.removeEventListener(t, onGesture, active);
  };
}

/**
 * The 3D view (part studios, sketches, assemblies): `area` holds the canvas and
 * what floats over it (sketch dimensions and constraint badges). Over the canvas,
 * OrbitControls zooms (it also calls preventDefault, but not while the view is
 * being dragged — this does, always). Over the floating labels the wheel is
 * passed on to the canvas, so zooming carries on instead of the page zooming.
 * A Safari pinch is turned into the same wheel steps.
 */
export function guardViewportZoom(area: Element, canvas: HTMLElement, zoomSpeed: () => number): () => void {
  const overLabels = (t: EventTarget | null) => t instanceof Element && t !== canvas && !!t.closest(".sketch-overlay");
  const toCanvas = (init: WheelEventInit) => canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init }));
  return guardZoom(area, {
    owns: (t) => t === canvas || overLabels(t),
    wheel: (e) => {
      if (e.target === canvas) return;
      toCanvas({ deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey, altKey: e.altKey, clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY });
    },
    pinch: (factor, clientX, clientY) => {
      toCanvas({ deltaY: orbitWheelDelta(factor, zoomSpeed()), deltaMode: 0, clientX, clientY });
    },
  });
}
