import { describe, expect, it } from "vitest";

import { eventTime, GestureTracker, gestureOptions, reachFor, slopFor, type Gesture } from "../src/viewport/gestures";

const types = (gs: Gesture[]) => gs.map((g) => g.type);

describe("finger gestures", () => {
  it("a tap: down and up without moving more than the jitter allowance", () => {
    const g = new GestureTracker(gestureOptions("touch"));
    expect(g.down(1, 100, 100, 0)).toEqual([]);
    // A finger's wobble (under 10 px) is still a tap.
    expect(g.move(1, 106, 104, 30)).toEqual([]);
    expect(g.up(1, 106, 104, 80)).toEqual([{ type: "tap", x: 100, y: 100, count: 1 }]);
    expect(g.active).toBe(false);
  });

  it("a double-tap counts 2 when quick and close; slow or far taps start again", () => {
    const g = new GestureTracker(gestureOptions("touch"));
    g.down(1, 50, 50, 0);
    g.up(1, 50, 50, 50);
    g.down(2, 60, 55, 200);
    expect(g.up(2, 60, 55, 250)).toEqual([{ type: "tap", x: 60, y: 55, count: 2 }]);
    // A third tap is a fresh single tap.
    g.down(3, 60, 55, 400);
    expect(g.up(3, 60, 55, 420)).toEqual([{ type: "tap", x: 60, y: 55, count: 1 }]);
    // Too slow.
    g.down(4, 60, 55, 2000);
    expect((g.up(4, 60, 55, 2020)[0] as { count: number }).count).toBe(1);
    // Too far apart.
    g.down(5, 300, 55, 2100);
    expect((g.up(5, 300, 55, 2120)[0] as { count: number }).count).toBe(1);
  });

  it("a drag: starts where the finger went down once it moves past the allowance, then steps", () => {
    const g = new GestureTracker(gestureOptions("touch"));
    g.down(1, 10, 10, 0);
    expect(g.move(1, 25, 10, 20)).toEqual([
      { type: "dragStart", x: 10, y: 10 },
      { type: "drag", x: 25, y: 10, dx: 15, dy: 0 },
    ]);
    expect(g.move(1, 30, 12, 40)).toEqual([{ type: "drag", x: 30, y: 12, dx: 5, dy: 2 }]);
    expect(g.up(1, 30, 12, 60)).toEqual([{ type: "dragEnd", x: 30, y: 12 }]);
  });

  it("a long press after holding still; then moves drag what was held", () => {
    const g = new GestureTracker(gestureOptions("touch"));
    g.down(1, 10, 10, 1000);
    expect(g.longPressDue).toBe(1500);
    expect(g.tick(1400)).toEqual([]);
    expect(g.tick(1500)).toEqual([{ type: "longPress", x: 10, y: 10 }]);
    expect(g.longPressDue).toBeNull();
    expect(g.move(1, 40, 10, 1600)).toEqual([{ type: "holdDrag", x: 40, y: 10, dx: 30, dy: 0 }]);
    expect(g.up(1, 40, 10, 1700)).toEqual([{ type: "holdEnd", x: 40, y: 10 }]);
    // Moving first means no long press.
    g.down(2, 10, 10, 3000);
    g.move(2, 40, 10, 3100);
    expect(g.longPressDue).toBeNull();
    expect(g.tick(4000)).toEqual([]);
  });

  it("no long press when switched off (sketching): a still press then a slow drag still draws", () => {
    const g = new GestureTracker(gestureOptions("touch", false));
    g.down(1, 10, 10, 0);
    expect(g.longPressDue).toBeNull();
    expect(g.tick(5000)).toEqual([]);
    expect(types(g.move(1, 30, 10, 5100))).toEqual(["dragStart", "drag"]);
  });

  it("two fingers: the first finger's gesture is taken back, then the middle point pans and the spread zooms", () => {
    const g = new GestureTracker(gestureOptions("touch"));
    g.down(1, 100, 100, 0);
    g.move(1, 120, 100, 10); // already dragging
    expect(g.down(2, 220, 100, 20)).toEqual([
      { type: "cancel", started: true },
      { type: "pinchStart", x: 170, y: 100 },
    ]);
    expect(g.pinching).toBe(true);
    // Both move right 10 px, one after the other: the middle moves 10 px; the spread comes back to where it was.
    expect(g.move(1, 130, 100, 30)).toEqual([
      { type: "pan", dx: 5, dy: 0 },
      { type: "zoom", factor: 90 / 100, x: 175, y: 100 },
    ]);
    expect(g.move(2, 230, 100, 30)).toEqual([
      { type: "pan", dx: 5, dy: 0 },
      { type: "zoom", factor: 100 / 90, x: 180, y: 100 },
    ]);
    // Spread apart about the middle (180, 100): zoom in (factor above 1), no pan.
    expect(g.move(2, 280, 100, 40)).toEqual([
      { type: "pan", dx: 25, dy: 0 },
      { type: "zoom", factor: 150 / 100, x: 205, y: 100 },
    ]);
    const g2 = new GestureTracker(gestureOptions("touch"));
    g2.down(1, 100, 100, 0);
    g2.down(2, 200, 100, 0);
    expect(g2.move(1, 50, 100, 10)).toEqual([
      { type: "pan", dx: -25, dy: 0 },
      { type: "zoom", factor: 1.5, x: 125, y: 100 },
    ]);
    expect(g2.move(1, 125, 100, 20)).toEqual([
      { type: "pan", dx: 37.5, dy: 0 },
      { type: "zoom", factor: 75 / 150, x: 162.5, y: 100 },
    ]);
  });

  it("a second finger before the first moved: taken back as not started (nothing was drawn yet)", () => {
    const g = new GestureTracker(gestureOptions("touch"));
    g.down(1, 100, 100, 0);
    expect(types(g.down(2, 150, 100, 40))).toEqual(["cancel", "pinchStart"]);
    expect(g.down(2, 150, 100, 40)).toEqual([]); // (the same finger again: ignored)
  });

  it("after a pinch, the finger left behind neither taps nor turns the view until all are off", () => {
    const g = new GestureTracker(gestureOptions("touch"));
    g.down(1, 100, 100, 0);
    g.down(2, 200, 100, 10);
    expect(g.up(2, 200, 100, 100)).toEqual([{ type: "pinchEnd" }]);
    expect(g.move(1, 300, 300, 120)).toEqual([]);
    // A new finger meanwhile is ignored too.
    expect(g.down(3, 50, 50, 130)).toEqual([]);
    expect(g.up(3, 50, 50, 140)).toEqual([]);
    expect(g.up(1, 300, 300, 150)).toEqual([]);
    expect(g.active).toBe(false);
    // Then all is as new.
    g.down(4, 10, 10, 1000);
    expect(types(g.up(4, 10, 10, 1050))).toEqual(["tap"]);
  });

  it("a third finger is ignored; the pinch carries on with the first two", () => {
    const g = new GestureTracker(gestureOptions("touch"));
    g.down(1, 0, 0, 0);
    g.down(2, 100, 0, 0);
    expect(g.down(3, 50, 50, 0)).toEqual([]);
    expect(g.move(3, 80, 80, 10)).toEqual([]);
    expect(g.up(3, 80, 80, 20)).toEqual([]);
    expect(types(g.move(2, 200, 0, 30))).toEqual(["pan", "zoom"]);
  });

  it("the browser taking a finger away (pointercancel) takes the gesture back, with no tap", () => {
    const g = new GestureTracker(gestureOptions("touch"));
    g.down(1, 10, 10, 0);
    expect(g.cancel(1)).toEqual([{ type: "cancel", started: false }]);
    expect(g.active).toBe(false);
    g.down(2, 10, 10, 100);
    g.down(3, 60, 10, 100);
    expect(g.cancel(2)).toEqual([{ type: "pinchEnd" }]);
    expect(g.up(3, 60, 10, 200)).toEqual([]);
    expect(g.active).toBe(false);
  });

  it("says which pointers it follows", () => {
    const g = new GestureTracker(gestureOptions("touch"));
    g.down(1, 0, 0, 0);
    g.down(2, 50, 0, 0);
    g.down(3, 90, 0, 0);
    expect([1, 2, 3, 4].map((id) => g.has(id))).toEqual([true, true, true, false]);
    g.cancel(3);
    expect(g.has(3)).toBe(false);
  });

  it("fingers reach further than the pen, the pen than the mouse; the jitter allowance likewise", () => {
    expect(reachFor("touch")).toBeGreaterThan(reachFor("pen"));
    expect(reachFor("pen")).toBeGreaterThan(reachFor("mouse"));
    expect(reachFor("mouse")).toBe(1);
    expect(slopFor("touch")).toBeGreaterThan(slopFor("pen"));
    expect(slopFor("pen")).toBeGreaterThan(slopFor("mouse"));
  });
});

describe("event times", () => {
  it("uses the event's own time stamp (a busy page handles events late), else now", () => {
    expect(eventTime({ timeStamp: 1000 }, 1800)).toBe(1000);
    expect(eventTime({ timeStamp: 0 }, 1800)).toBe(1800);
    expect(eventTime({}, 1800)).toBe(1800);
    // A stamp on some other clock (far from now) isn't trusted.
    expect(eventTime({ timeStamp: 1.7e12 }, 1800)).toBe(1800);
  });
});
