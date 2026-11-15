import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { nextOffered, useStore } from "../src/model/store";
import { SketchController, type PreviewShape, type SketchPointer } from "../src/sketch/controller";
import { addPoint, addRectangle, curvePoints, pointPos } from "../src/sketch/ops";
import { copySketchItems } from "../src/sketch/clipboard";
import { GIZMO_RING_PX } from "../src/sketch/transformSelection";
import type { SketchData } from "../src/sketch/types";

const s = () => useStore.getState();
const draftData = () => s().editing!.draft.sketch!.data;
const MM = 0.1;
const mouse = (x: number, y: number, shift = false): SketchPointer => ({ x, y, mmPerPx: MM, shift, ctrl: false });
const xsOf = (d: SketchData, ids: string[]) => ids.flatMap((id) => curvePoints(d.curves.find((k) => k.id === id)!).map((p) => pointPos(d, p)[0]));
const ring = GIZMO_RING_PX * MM;

beforeEach(() => {
  useStore.setState({ history: historyOf(emptyDocument()), editing: null, sketch: null, selection: [], selectedPlane: null, selectedFeatureId: null });
  s().startSketch({ kind: "default", name: "Top" });
});

/** A 10 × 4 rectangle, centred on (5, 2), picked, with Move / copy on. */
function rectangle(): string[] {
  const r = addRectangle(draftData(), { x: 0, y: 0 }, { x: 10, y: 4 });
  s().updateSketch(r.sketch, { record: true });
  s().setSketchTool("sketchTransform");
  s().setSketchSelection(r.lineIds);
  return r.lineIds;
}

describe("Move / copy's handles in the sketch", () => {
  it("draws handles on the picked shapes", () => {
    rectangle();
    const c = new SketchController();
    let preview: PreviewShape[] = [];
    c.onChange((t) => (preview = t.preview));
    c.pointerMove(mouse(30, 30), false);
    expect(preview.some((p) => (p.kind === "line" || p.kind === "circle") && !!p.handle)).toBe(true);
  });

  it("dragging the ring turns them about their middle in 15° steps, as one undo step", () => {
    const ids = rectangle();
    const c = new SketchController();
    const past = s().sketch!.past.length;
    c.pointerDown(mouse(5 + ring, 2));
    // A quarter turn round, through a few moves (a little off 90°: it snaps).
    for (const deg of [20, 45, 70, 88]) {
      const a = (deg * Math.PI) / 180;
      c.pointerMove(mouse(5 + ring * Math.cos(a), 2 + ring * Math.sin(a)), true);
    }
    c.pointerUp();
    const xs = xsOf(draftData(), ids);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(4, 5);
    expect(Math.min(...xs)).toBeCloseTo(3, 5);
    expect(s().sketch!.past.length).toBe(past + 1);
    expect(s().sketch!.message?.text).toMatch(/Turned/);
  });

  it("dragging the middle moves them, snapping onto a point; Esc takes a drag back", () => {
    const ids = rectangle();
    const p = addPoint(draftData(), { x: 30.3, y: 2.2 });
    s().updateSketch(p.sketch, { record: true });
    const c = new SketchController();
    c.pointerDown(mouse(5, 2));
    c.pointerMove(mouse(30, 2), true);
    c.pointerUp();
    const xs = xsOf(draftData(), ids);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(30.3, 5);
    const before = draftData();
    c.pointerDown(mouse(30.3, 2.2));
    c.pointerMove(mouse(50, 2), true);
    expect(draftData()).not.toBe(before);
    expect(c.cancel()).toBe(true);
    expect(xsOf(draftData(), ids)).toEqual(xsOf(before, ids));
  });

  it("the scale square scales them; with Make a copy ticked the original stays", () => {
    const ids = rectangle();
    s().setSketchOptions({ moveCopy: true });
    const c = new SketchController();
    const d = (84 * MM) / Math.SQRT2;
    c.pointerDown(mouse(5 + d, 2 + d));
    c.pointerMove(mouse(5 + 2 * d, 2 + 2 * d), true);
    c.pointerUp();
    expect(draftData().curves).toHaveLength(8);
    expect(xsOf(draftData(), ids).sort((a, b) => a - b)[0]).toBeCloseTo(0, 6);
    const copy = s().sketch!.selection;
    const xs = xsOf(draftData(), copy);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 5);
  });

  it("a finger on a handle drags it; elsewhere it doesn't", () => {
    rectangle();
    const c = new SketchController();
    expect(c.touchDragStarts({ ...mouse(5, 2), reach: 2.2 })).toBe(true);
    expect(c.touchDragStarts({ ...mouse(30, 30), reach: 2.2 })).toBe(false);
  });
});

describe("handle drags after the review", () => {
  it("changing tool in the middle of a drag puts things back, and undo waits while a handle is held", () => {
    rectangle();
    const c = new SketchController();
    const before = draftData();
    const past = s().sketch!.past.length;
    c.pointerDown(mouse(5 + ring, 2));
    const a = (40 * Math.PI) / 180;
    c.pointerMove(mouse(5 + ring * Math.cos(a), 2 + ring * Math.sin(a)), true);
    expect(draftData()).not.toBe(before);
    expect(c.draggingHandle()).toBe(true);
    s().setSketchTool("select");
    c.pointerMove(mouse(5, 5), false);
    expect(c.draggingHandle()).toBe(false);
    expect(JSON.stringify(draftData())).toBe(JSON.stringify(before));
    c.pointerUp();
    expect(s().sketch!.past.length).toBe(past);
  });

  it("the handles are drawn again at their screen size after a zoom with no mouse move", () => {
    rectangle();
    const c = new SketchController();
    let ringR = 0;
    c.onChange((t) => {
      const r = t.preview.filter((p) => p.kind === "circle" && p.handle).map((p) => (p.kind === "circle" ? p.r : 0));
      if (r.length) ringR = Math.max(...r);
    });
    c.pointerMove(mouse(30, 30), false);
    expect(ringR).toBeCloseTo(GIZMO_RING_PX * MM, 9);
    c.zoomed(MM * 2);
    expect(ringR).toBeCloseTo(GIZMO_RING_PX * MM * 2, 9);
  });
});

describe("a pasted copy snaps", () => {
  it("its middle snaps onto a point, and Shift turns snapping off", () => {
    const r = addRectangle(draftData(), { x: 0, y: 0 }, { x: 10, y: 10 });
    const p = addPoint(r.sketch, { x: 40.4, y: 40.3 });
    s().updateSketch(p.sketch, { record: true });
    const clip = copySketchItems(draftData(), r.lineIds)!;
    const c = new SketchController();
    let snap: [number, number] | null = null;
    c.onChange((t) => (snap = t.snap));
    c.startPaste(clip);
    c.pointerMove(mouse(40, 40), false);
    expect(snap).toEqual([40.4, 40.3]);
    c.pointerDown(mouse(40, 40));
    c.pointerUp();
    const xs = xsOf(draftData(), s().sketch!.selection);
    expect(Math.min(...xs)).toBeCloseTo(35.4, 6);
    c.startPaste(clip);
    c.pointerDown(mouse(40, 40, true));
    c.pointerUp();
    const xs2 = xsOf(draftData(), s().sketch!.selection);
    expect(Math.min(...xs2)).toBeCloseTo(35, 6);
  });
});

describe("sizes offered while drawing", () => {
  it("Tab goes on to the next size offered (and Shift+Tab back), round and round", () => {
    s().setSketchTool("rectangle");
    const c = new SketchController();
    c.pointerDown(mouse(0, 0));
    c.pointerDown(mouse(10, 4));
    const offered = s().sketch!.provisional;
    expect(offered).toHaveLength(2);
    expect(s().sketch!.editingDimension).toBe(offered[0]);
    s().nextOfferedDimension(offered[0]);
    expect(s().sketch!.editingDimension).toBe(offered[1]);
    s().nextOfferedDimension(offered[1]);
    expect(s().sketch!.editingDimension).toBe(offered[0]);
    s().nextOfferedDimension(offered[0], true);
    expect(s().sketch!.editingDimension).toBe(offered[1]);
    // The last one left has nowhere to go (Tab then keeps it open, never drops it).
    expect(nextOffered(["a"], "a")).toBe(null);
    expect(nextOffered(["a", "b", "c"], "a", true)).toBe("c");
    // Both are still offered (Esc or carrying on drawing drops them, as before).
    expect(s().sketch!.provisional).toEqual(offered);
  });
});
