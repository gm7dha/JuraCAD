/**
 * Finger and pen gestures, worked out from pointer events (pure: no DOM, the
 * time is passed in). The 3D view and the drawing sheet feed it every touch or
 * pen pointer and act on what comes out:
 *
 * - one pointer: a **tap** (it came up without moving more than `slop`; taps
 *   close together in time and place count up, so a double-tap has count 2), a
 *   **drag** (it moved further: `dragStart` from where it went down, then
 *   `drag` steps, then `dragEnd`), or a **long press** (held still for
 *   `longPressMs`: `longPress`, then `holdDrag` steps and `holdEnd`);
 * - two pointers: **pan** (the middle point moved, in pixels) and **zoom**
 *   (the fingers moved apart or together: factor above 1 = closer, about the
 *   middle point). A second finger landing during a one-pointer gesture first
 *   gives `cancel` (`started`: whether a drag had begun), so whatever the first
 *   finger began can be taken back. After a pinch nothing more happens until
 *   every finger is off the screen (a finger left behind doesn't orbit).
 *
 * The mouse never goes through here, so mouse behaviour is unchanged.
 */

export type PointerKind = "mouse" | "pen" | "touch";

export interface GestureOptions {
  /** Movement (px) still counted as a tap (finger jitter). */
  slop: number;
  /** How long (ms) a still press takes to become a long press (Infinity: never). */
  longPressMs: number;
  /** Most time (ms) between two taps of a double-tap, and how far apart (px) they may be. */
  doubleTapMs: number;
  doubleTapGap: number;
}

export type Gesture =
  | { type: "dragStart"; x: number; y: number }
  | { type: "drag"; x: number; y: number; dx: number; dy: number }
  | { type: "dragEnd"; x: number; y: number }
  | { type: "tap"; x: number; y: number; count: number }
  | { type: "longPress"; x: number; y: number }
  | { type: "holdDrag"; x: number; y: number; dx: number; dy: number }
  | { type: "holdEnd"; x: number; y: number }
  | { type: "cancel"; started: boolean }
  | { type: "pinchStart"; x: number; y: number }
  | { type: "pan"; dx: number; dy: number }
  | { type: "zoom"; factor: number; x: number; y: number }
  | { type: "pinchEnd" };

/**
 * When a pointer event happened, on the clock `performance.now()` uses. Its own time stamp is used when it has
 * one (a busy page may handle an event a while after the finger moved: a quick tap must stay a tap).
 */
export function eventTime(e: { timeStamp?: number }, now = performance.now()): number {
  const t = e.timeStamp;
  return typeof t === "number" && t > 0 && Math.abs(now - t) < 60_000 ? t : now;
}

/** Movement (px) that's still a tap: fingers wobble, a pen less, a mouse hardly. */
export function slopFor(kind: string): number {
  return kind === "touch" ? 10 : kind === "pen" ? 6 : 4;
}

/**
 * How many times bigger snapping and picking distances are for this kind of
 * pointer: a fingertip covers far more than a mouse pointer; a pen is in between.
 */
export function reachFor(kind: string): number {
  return kind === "touch" ? 2.2 : kind === "pen" ? 1.5 : 1;
}

/**
 * Whether a finger's press may become a long press: only where one does something (picking up a part in an assembly,
 * Select other in a Part Studio), never while sketching (the finger draws) and never on a Move / copy triad handle,
 * whose drag must move the handle however long the finger rested first (a long press there would hand the drag to
 * "held" moves, which turn the view).
 */
export function longPressWanted(o: { dragEnabled: boolean; selectOther: boolean; sketching: boolean; onTriad: boolean }): boolean {
  return (o.dragEnabled || o.selectOther) && !o.sketching && !o.onTriad;
}

/** The usual settings for this kind of pointer; `longPress`: false = none, a number = after that many ms (else 500). */
export function gestureOptions(kind: string, longPress: boolean | number = true): GestureOptions {
  return { slop: slopFor(kind), longPressMs: longPress === false ? Infinity : typeof longPress === "number" ? longPress : 500, doubleTapMs: 350, doubleTapGap: kind === "touch" ? 32 : 20 };
}

interface Down {
  id: number;
  x: number;
  y: number;
  /** Where it went down. */
  x0: number;
  y0: number;
  t0: number;
}

type Phase = "idle" | "press" | "drag" | "hold" | "pinch" | "done";

export class GestureTracker {
  options: GestureOptions;
  private phase: Phase = "idle";
  private pointers: Down[] = [];
  /** Pointers past the first two (ignored, but counted so "every finger off" is right). */
  private extra = new Set<number>();
  private lastTap: { x: number; y: number; t: number; count: number } | null = null;
  private pinch: { cx: number; cy: number; d: number } | null = null;

  constructor(options: GestureOptions = gestureOptions("touch")) {
    this.options = options;
  }

  /** True while any pointer is down. */
  get active(): boolean {
    return this.pointers.length + this.extra.size > 0;
  }

  /** Is this pointer one of the ones being followed? */
  has(id: number): boolean {
    return this.pointers.some((p) => p.id === id) || this.extra.has(id);
  }

  /** True while two fingers are pinching or panning (or a pinch is waiting for every finger to come off). */
  get pinching(): boolean {
    return this.phase === "pinch" || this.phase === "done";
  }

  /** When (in the same clock as the events) a still press becomes a long press; null when none is due. */
  get longPressDue(): number | null {
    if (this.phase !== "press" || !Number.isFinite(this.options.longPressMs)) return null;
    return this.pointers[0].t0 + this.options.longPressMs;
  }

  down(id: number, x: number, y: number, t: number): Gesture[] {
    if (this.pointers.some((p) => p.id === id) || this.extra.has(id)) return [];
    if (this.pointers.length >= 2 || this.phase === "done") {
      this.extra.add(id);
      return [];
    }
    const p: Down = { id, x, y, x0: x, y0: y, t0: t };
    if (this.pointers.length === 0) {
      this.pointers = [p];
      this.phase = "press";
      return [];
    }
    // A second finger: whatever the first began is taken back, and the two pinch and pan.
    const out: Gesture[] = [];
    if (this.phase === "press" || this.phase === "drag" || this.phase === "hold") out.push({ type: "cancel", started: this.phase !== "press" });
    this.pointers.push(p);
    this.phase = "pinch";
    this.lastTap = null;
    this.pinch = this.measure();
    out.push({ type: "pinchStart", x: this.pinch.cx, y: this.pinch.cy });
    return out;
  }

  move(id: number, x: number, y: number, t: number): Gesture[] {
    void t;
    const p = this.pointers.find((q) => q.id === id);
    if (!p || (p.x === x && p.y === y)) return [];
    const px = p.x;
    const py = p.y;
    p.x = x;
    p.y = y;
    if (this.phase === "press") {
      if (Math.hypot(x - p.x0, y - p.y0) <= this.options.slop) return [];
      this.phase = "drag";
      // The drag starts where the pointer went down, and has moved on since.
      return [
        { type: "dragStart", x: p.x0, y: p.y0 },
        { type: "drag", x, y, dx: x - p.x0, dy: y - p.y0 },
      ];
    }
    if (this.phase === "drag") return [{ type: "drag", x, y, dx: x - px, dy: y - py }];
    if (this.phase === "hold") return [{ type: "holdDrag", x, y, dx: x - px, dy: y - py }];
    if (this.phase === "pinch" && this.pinch && this.pointers.length === 2) {
      const now = this.measure();
      const before = this.pinch;
      this.pinch = now;
      const out: Gesture[] = [];
      if (now.cx !== before.cx || now.cy !== before.cy) out.push({ type: "pan", dx: now.cx - before.cx, dy: now.cy - before.cy });
      if (before.d > 0 && now.d > 0 && now.d !== before.d) out.push({ type: "zoom", factor: now.d / before.d, x: now.cx, y: now.cy });
      return out;
    }
    return [];
  }

  up(id: number, x: number, y: number, t: number): Gesture[] {
    if (this.extra.delete(id)) return this.settle([]);
    const i = this.pointers.findIndex((q) => q.id === id);
    if (i < 0) return [];
    const p = this.pointers[i];
    this.pointers.splice(i, 1);
    const out: Gesture[] = [];
    if (this.phase === "press") {
      const last = this.lastTap;
      const again = !!last && t - last.t <= this.options.doubleTapMs && Math.hypot(p.x0 - last.x, p.y0 - last.y) <= this.options.doubleTapGap;
      const count = again ? last!.count + 1 : 1;
      out.push({ type: "tap", x: p.x0, y: p.y0, count });
      // A double-tap is complete in itself: a third tap starts afresh.
      this.lastTap = count >= 2 ? null : { x: p.x0, y: p.y0, t, count };
    } else if (this.phase === "drag") {
      out.push({ type: "dragEnd", x, y });
      this.lastTap = null;
    } else if (this.phase === "hold") {
      out.push({ type: "holdEnd", x, y });
      this.lastTap = null;
    } else if (this.phase === "pinch") {
      out.push({ type: "pinchEnd" });
      this.phase = "done";
      this.pinch = null;
    }
    return this.settle(out);
  }

  /** The browser took the pointer away (pointercancel): end without a tap, taking back a one-pointer gesture. */
  cancel(id: number): Gesture[] {
    if (this.extra.delete(id)) return this.settle([]);
    const i = this.pointers.findIndex((q) => q.id === id);
    if (i < 0) return [];
    this.pointers.splice(i, 1);
    const out: Gesture[] = [];
    if (this.phase === "press" || this.phase === "drag" || this.phase === "hold") out.push({ type: "cancel", started: this.phase !== "press" });
    else if (this.phase === "pinch") out.push({ type: "pinchEnd" });
    this.phase = this.pointers.length || this.extra.size ? "done" : "idle";
    this.pinch = null;
    this.lastTap = null;
    return this.settle(out);
  }

  /** Call when `longPressDue` comes: the press, if still held still, becomes a long press. */
  tick(t: number): Gesture[] {
    const due = this.longPressDue;
    if (due === null || t < due) return [];
    const p = this.pointers[0];
    this.phase = "hold";
    this.lastTap = null;
    return [{ type: "longPress", x: p.x0, y: p.y0 }];
  }

  /** Forget everything (e.g. the view was switched mid-gesture). */
  reset(): void {
    this.phase = "idle";
    this.pointers = [];
    this.extra.clear();
    this.pinch = null;
    this.lastTap = null;
  }

  private settle(out: Gesture[]): Gesture[] {
    if (this.pointers.length === 0 && this.extra.size === 0) this.phase = "idle";
    return out;
  }

  private measure(): { cx: number; cy: number; d: number } {
    const [a, b] = this.pointers;
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  }
}

/**
 * Which pointers the finger gestures follow, and which are ignored: while the pen is down, a finger (a hand
 * resting on the screen) is ignored for as long as it stays down — its moves and lift too, so it can never
 * reach the mouse's way of doing things and take over the pen's stroke.
 */
export class TouchRouter {
  private readonly followed = new Map<number, string>();
  private readonly ignored = new Set<number>();

  /** A pointer went down that the gestures handle (`kind`: its pointerType): follow it (true) or ignore it (false). */
  down(id: number, kind: string): boolean {
    if (kind === "touch" && [...this.followed.values()].includes("pen")) {
      this.ignored.add(id);
      return false;
    }
    this.ignored.delete(id);
    this.followed.set(id, kind);
    return true;
  }

  /** What a later event of this pointer is: one the gestures follow, one being ignored, or neither (the mouse's way). */
  route(id: number): "gesture" | "ignore" | "other" {
    return this.followed.has(id) ? "gesture" : this.ignored.has(id) ? "ignore" : "other";
  }

  /** The pointer came up or was cancelled: what it was, and it's forgotten. */
  end(id: number): "gesture" | "ignore" | "other" {
    const r = this.route(id);
    this.followed.delete(id);
    this.ignored.delete(id);
    return r;
  }

  /** How many pointers the gestures follow now. */
  get count(): number {
    return this.followed.size;
  }

  reset(): void {
    this.followed.clear();
    this.ignored.clear();
  }
}
