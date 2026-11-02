import { describe, expect, it } from "vitest";

import { installTouchCompat, LIFT_MS } from "../src/app/touchCompat";

/** A tiny stand-in for the page: one row (with a right-click menu), and real timers. */
function fakePage() {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const fired: string[] = [];
  let offset = 0;
  class FakeMouseEvent {
    type: string;
    constructor(type: string, init: object) {
      this.type = type;
      Object.assign(this, init);
    }
  }
  const win = { requestAnimationFrame: (f: () => void) => setTimeout(f, 1) as unknown as number, cancelAnimationFrame: (id: number) => clearTimeout(id as never), setTimeout, clearTimeout, MouseEvent: FakeMouseEvent };
  const doc = {
    defaultView: win,
    addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] ??= []).push(f),
    removeEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] = (listeners[t] ?? []).filter((x) => x !== f)),
  };
  const row = { closest: () => null, isConnected: true, dispatchEvent: (e: { type: string }) => (fired.push(e.type), true) };
  /** Send a trusted event; true if the app's handlers never see it (dropped). */
  const send = (type: string, extra: Record<string, unknown> = {}) => {
    let dropped = false;
    const e = { type, isTrusted: true, timeStamp: 0, target: row, clientX: 10, clientY: 10, preventDefault() {}, stopImmediatePropagation: () => (dropped = true), ...extra };
    for (const f of listeners[type] ?? []) f(e);
    return dropped;
  };
  const stop = installTouchCompat(doc as unknown as Document, { longPressMs: 30, now: () => performance.now() + offset });
  return { send, fired, stop, later: (ms: number) => (offset += ms), listeners };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const finger = { pointerType: "touch", pointerId: 1 };

describe("long press and double-tap on the app's controls", () => {
  it("a long press opens the right-click menu, and only the lifting finger's made-up click is dropped", async () => {
    const p = fakePage();
    p.send("pointerdown", finger);
    await wait(120);
    expect(p.fired).toEqual(["contextmenu"]);
    p.send("pointerup", finger);
    // iPad Safari: the made-up mouse events where the finger lifted are dropped.
    expect(p.send("mousedown")).toBe(true);
    expect(p.send("click")).toBe(true);
    // Once that click is gone, a click elsewhere goes through.
    expect(p.send("click", { clientX: 200, clientY: 200 })).toBe(false);
    p.stop();
  });

  it("never swallows a real mouse or trackpad after a long press (Chrome sends no follow-up click)", async () => {
    const p = fakePage();
    p.send("pointerdown", finger);
    await wait(120);
    p.send("pointerup", finger);
    // Chrome says where events come from: a mouse's are kept even right where the finger lifted.
    expect(p.send("mousedown", { sourceCapabilities: { firesTouchEvents: false } })).toBe(false);
    expect(p.send("click", { sourceCapabilities: { firesTouchEvents: false } })).toBe(false);
    // A mouse pressed anywhere ends the dropping at once.
    p.send("pointerdown", { pointerType: "mouse", pointerId: 9 });
    expect(p.send("mousedown")).toBe(false);
    expect(p.send("click")).toBe(false);
    p.stop();
  });

  it("stops dropping a while after the lift, and away from where the finger was", async () => {
    const p = fakePage();
    p.send("pointerdown", finger);
    await wait(120);
    p.send("pointerup", finger);
    expect(p.send("mousedown", { clientX: 300, clientY: 300 })).toBe(false);
    p.later(LIFT_MS + 50);
    expect(p.send("mousedown")).toBe(false);
    expect(p.send("click")).toBe(false);
    p.stop();
  });

  it("a tap is just a tap; a double-tap is a double-click (the browser's own one after it is dropped)", async () => {
    const p = fakePage();
    p.send("pointerdown", finger);
    p.send("pointerup", finger);
    expect(p.send("click")).toBe(false);
    p.send("pointerdown", { ...finger, pointerId: 2 });
    p.send("pointerup", { ...finger, pointerId: 2 });
    await wait(60);
    expect(p.fired).toEqual(["dblclick"]);
    expect(p.send("dblclick")).toBe(true);
    p.stop();
  });

  it("nothing is sent after it's taken down (no timer left behind)", async () => {
    const p = fakePage();
    p.send("pointerdown", finger);
    p.stop();
    await wait(120);
    expect(p.fired).toEqual([]);
    expect(Object.values(p.listeners).every((l) => l.length === 0)).toBe(true);
  });
});
