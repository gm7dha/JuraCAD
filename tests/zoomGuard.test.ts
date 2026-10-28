import { describe, expect, it } from "vitest";

import { gestureFactor, guardZoom, orbitWheelDelta, sheetWheelFactor, SHEET_MIN_WIDTH, zoomBox } from "../src/viewport/zoomGuard";

describe("how far a wheel or pinch zooms the drawing sheet", () => {
  it("a mouse wheel's notch zooms as it always has (Ctrl held on the keyboard too)", () => {
    expect(sheetWheelFactor({ deltaY: 100, deltaMode: 0 })).toBeCloseTo(Math.exp(0.15), 12);
    expect(sheetWheelFactor({ deltaY: -100, deltaMode: 0 }, false)).toBeCloseTo(Math.exp(-0.15), 12);
  });

  it("counts Firefox's lines and pages as pixels", () => {
    expect(sheetWheelFactor({ deltaY: 3, deltaMode: 1 })).toBeCloseTo(Math.exp(3 * 16 * 0.0015), 12);
    expect(sheetWheelFactor({ deltaY: 1, deltaMode: 2 })).toBeCloseTo(Math.exp(0.15), 12);
  });

  it("makes a pinch's small steps count, but never jumps more than about 1.65 times at once", () => {
    expect(sheetWheelFactor({ deltaY: -4 }, true)).toBeCloseTo(Math.exp(-0.06), 12);
    expect(sheetWheelFactor({ deltaY: -1000 }, true)).toBeCloseTo(Math.exp(-0.5), 12);
    expect(sheetWheelFactor({ deltaY: 1000 }, true)).toBeCloseTo(Math.exp(0.5), 12);
  });

  it("Safari's pinch scale becomes the same kind of factor", () => {
    expect(gestureFactor(1, 2)).toBe(0.5);
    expect(gestureFactor(2, 1)).toBe(2);
    expect(gestureFactor(1, 0)).toBe(1);
    expect(gestureFactor(Number.NaN, 1)).toBe(1);
  });
});

describe("zooming the sheet's view box about the pointer", () => {
  const rect = { left: 100, top: 50, width: 200, height: 100 };

  it("keeps the point under the pointer where it is", () => {
    // 0.5 SVG units per pixel; the pointer 50 px across and 25 px down is at (25, 12.5).
    expect(zoomBox([0, 0, 100, 50], rect, [150, 75], 0.5, SHEET_MIN_WIDTH, 1000)).toEqual([12.5, 6.25, 50, 25]);
    expect(zoomBox([0, 0, 100, 50], rect, [150, 75], 2, SHEET_MIN_WIDTH, 1000)).toEqual([-25, -12.5, 200, 100]);
  });

  it("allows for the box being centred in a wider window", () => {
    // A 100 × 100 box in a 200 × 100 window: 1 unit per pixel, 50 px of margin each side.
    // The pointer 60 px in is 10 units into the box.
    expect(zoomBox([0, 0, 100, 100], rect, [160, 50], 0.5, SHEET_MIN_WIDTH, 1000)).toEqual([5, 0, 50, 50]);
  });

  it("stops at the limits, leaving the box as it is there", () => {
    const tight: [number, number, number, number] = [0, 0, SHEET_MIN_WIDTH, 10];
    expect(zoomBox(tight, rect, [150, 75], 0.5, SHEET_MIN_WIDTH, 1000)).toBe(tight);
    expect(zoomBox([0, 0, 30, 15], rect, [100, 50], 0.5, SHEET_MIN_WIDTH, 1000)[2]).toBe(SHEET_MIN_WIDTH);
    const wide: [number, number, number, number] = [0, 0, 1000, 500];
    expect(zoomBox(wide, rect, [150, 75], 2, SHEET_MIN_WIDTH, 1000)).toBe(wide);
  });

  it("does nothing before the sheet has a size on screen", () => {
    const b: [number, number, number, number] = [0, 0, 100, 50];
    expect(zoomBox(b, { left: 0, top: 0, width: 0, height: 0 }, [0, 0], 0.5, SHEET_MIN_WIDTH, 1000)).toBe(b);
  });
});

describe("a Safari pinch on the 3D view", () => {
  it("becomes the wheel step that zooms OrbitControls by the same amount", () => {
    // OrbitControls zooms by 0.95^(zoomSpeed × |deltaY| / 100) per wheel event.
    const zoomOf = (deltaY: number, speed: number) => Math.pow(0.95, speed * Math.abs(deltaY) * 0.01);
    const inStep = orbitWheelDelta(0.5, 1.2);
    expect(inStep).toBeLessThan(0);
    expect(zoomOf(inStep, 1.2)).toBeCloseTo(0.5, 12);
    const outStep = orbitWheelDelta(2, 1.2);
    expect(outStep).toBeGreaterThan(0);
    expect(zoomOf(outStep, 1.2)).toBeCloseTo(0.5, 12);
    expect(orbitWheelDelta(1, 1.2)).toBe(0);
    expect(orbitWheelDelta(0, 1.2)).toBe(0);
  });
});

describe("guarding a view against the page zooming", () => {
  /** An event like the browser's, with the extra fields set. */
  function event(type: string, fields: Record<string, unknown> = {}): Event {
    const e = new Event(type, { cancelable: true, bubbles: true });
    for (const [k, v] of Object.entries(fields)) Object.defineProperty(e, k, { value: v });
    return e;
  }

  it("stops pinches and Ctrl + wheel over the view, and passes them on", () => {
    const el = new EventTarget() as unknown as Element;
    const wheels: number[] = [];
    const pinches: [number, number, number][] = [];
    const stop = guardZoom(el, { owns: () => true, wheel: (e) => wheels.push(e.deltaY), pinch: (f, x, y) => pinches.push([f, x, y]) });
    const w = event("wheel", { deltaY: -3, ctrlKey: true });
    el.dispatchEvent(w);
    expect(w.defaultPrevented).toBe(true);
    expect(wheels).toEqual([-3]);
    // Plain wheel too (the view zooms; the page mustn't scroll).
    const plain = event("wheel", { deltaY: 100 });
    el.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    // Safari: start, two steps, end — each stopped; the steps zoom by how much the scale changed since the last.
    const steps = [event("gesturestart", { scale: 1 }), event("gesturechange", { scale: 1.25, clientX: 5, clientY: 6 }), event("gesturechange", { scale: 2.5, clientX: 5, clientY: 6 }), event("gestureend", { scale: 2.5 })];
    for (const s of steps) el.dispatchEvent(s);
    expect(steps.map((s) => s.defaultPrevented)).toEqual([true, true, true, true]);
    expect(pinches).toEqual([
      [0.8, 5, 6],
      [0.5, 5, 6],
    ]);
    stop();
    const after = event("wheel", { deltaY: 1, ctrlKey: true });
    el.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    expect(wheels).toHaveLength(2);
  });

  it("tells a trackpad pinch from Ctrl held on the keyboard with the mouse wheel", () => {
    const el = new EventTarget() as unknown as Element;
    const keys = new EventTarget();
    const seen: boolean[] = [];
    const stop = guardZoom(el, { owns: () => true, wheel: (_, pinch) => seen.push(pinch), pinch: () => {} }, keys);
    // A pinch: Ctrl set on the wheel event, but the key never pressed.
    el.dispatchEvent(event("wheel", { deltaY: -3, ctrlKey: true }));
    // Ctrl pressed, the wheel turned; then let go.
    keys.dispatchEvent(event("keydown", { key: "Control" }));
    el.dispatchEvent(event("wheel", { deltaY: -100, ctrlKey: true }));
    keys.dispatchEvent(event("keyup", { key: "Control" }));
    el.dispatchEvent(event("wheel", { deltaY: -3, ctrlKey: true }));
    // A plain wheel is never a pinch.
    el.dispatchEvent(event("wheel", { deltaY: 100 }));
    expect(seen).toEqual([true, false, true, false]);
    stop();
    keys.dispatchEvent(event("keydown", { key: "Control" }));
    expect(seen).toHaveLength(4);
  });

  it("leaves events elsewhere alone (the page can still be zoomed there)", () => {
    const el = new EventTarget() as unknown as Element;
    let called = 0;
    guardZoom(el, { owns: () => false, wheel: () => called++, pinch: () => called++ });
    const w = event("wheel", { deltaY: -3, ctrlKey: true });
    const g = event("gesturestart", { scale: 1 });
    el.dispatchEvent(w);
    el.dispatchEvent(g);
    expect(w.defaultPrevented).toBe(false);
    expect(g.defaultPrevented).toBe(false);
    expect(called).toBe(0);
  });
});
