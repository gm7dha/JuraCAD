import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { useStore } from "../src/model/store";
import { SketchController, type SketchPointer } from "../src/sketch/controller";
import { addRectangle, pointPos } from "../src/sketch/ops";

const s = () => useStore.getState();
const draftData = () => s().editing!.draft.sketch!.data;
/** A finger at (x, y) mm, at 0.1 mm per pixel, reaching as far as a finger does. */
const finger = (x: number, y: number): SketchPointer => ({ x, y, mmPerPx: 0.1, reach: 2.2, shift: false, ctrl: false });

beforeEach(() => {
  useStore.setState({ history: historyOf(emptyDocument()), editing: null, sketch: null, selection: [], selectedPlane: null, selectedFeatureId: null });
  s().startSketch({ kind: "default", name: "Top" });
});

describe("a second finger landing mid-stroke (to pan or zoom) takes the stroke back", () => {
  it("Select: a point already being dragged goes back where it was", () => {
    const rect = addRectangle(draftData(), { x: 0, y: 0 }, { x: 10, y: 10 });
    s().updateSketch(rect.sketch);
    const corner = draftData().points.find((p) => p.id !== "origin" && pointPos(draftData(), p.id)[0] === 10 && pointPos(draftData(), p.id)[1] === 10)!;
    const before = draftData();
    s().setSketchTool("select");
    const c = new SketchController();
    expect(c.touchDragStarts()).toBe(true);
    expect(c.touchLiftClicks()).toBe(false);
    c.beginStroke();
    // (A finger a little off the corner still picks it up: it reaches further than a mouse.)
    c.pointerDown(finger(10.8, 10.8));
    c.pointerMove(finger(14, 16), true);
    c.pointerMove(finger(20, 25), true);
    expect(pointPos(draftData(), corner.id)).not.toEqual([10, 10]);
    c.cancelStroke();
    expect(draftData().points).toEqual(before.points);
    expect(pointPos(draftData(), corner.id)).toEqual([10, 10]);
    // Nothing is left half-done: lifting the finger now changes nothing.
    c.pointerUp();
    expect(draftData().points).toEqual(before.points);
  });

  it("Line: a line started by the drag leaves no stray point, and the next tap starts afresh", () => {
    s().setSketchTool("line");
    const c = new SketchController();
    const before = draftData();
    expect(c.touchDragStarts()).toBe(true);
    c.beginStroke();
    c.pointerDown(finger(0, 0));
    c.pointerMove(finger(5, 0), true);
    c.cancelStroke();
    c.endStroke();
    expect(draftData()).toBe(before);
    // Two taps now draw one line from the first tap (not from where the cancelled drag began).
    c.pointerDown(finger(20, 20));
    c.pointerUp();
    c.pointerDown(finger(30, 20));
    c.pointerUp();
    const d = draftData();
    expect(d.curves).toHaveLength(1);
    const line = d.curves[0] as { type: string; p1: string; p2: string };
    expect(line.type).toBe("line");
    expect([pointPos(d, line.p1), pointPos(d, line.p2)].map((p) => p.map((v) => Math.round(v)))).toEqual([
      [20, 20],
      [30, 20],
    ]);
  });

  it("a drag that carries on from a half-drawn line keeps its start", () => {
    s().setSketchTool("line");
    const c = new SketchController();
    c.pointerDown(finger(0, 0)); // a tap placed the line's start
    c.pointerUp();
    // A drag now doesn't press again where it begins; it ends the line where the finger lifts.
    expect(c.touchDragStarts()).toBe(false);
    expect(c.touchLiftClicks()).toBe(true);
  });
});
