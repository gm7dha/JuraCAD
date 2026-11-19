import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { useStore } from "../src/model/store";
import { SketchController, type SketchPointer } from "../src/sketch/controller";
import { addCircle, addRectangle, curvePoints, pointPos } from "../src/sketch/ops";
import { copySketchItems } from "../src/sketch/clipboard";

const s = () => useStore.getState();
const draftData = () => s().editing!.draft.sketch!.data;
const mouse = (x: number, y: number): SketchPointer => ({ x, y, mmPerPx: 0.1, shift: false, ctrl: false });

beforeEach(() => {
  useStore.setState({ history: historyOf(emptyDocument()), editing: null, sketch: null, selection: [], selectedPlane: null, selectedFeatureId: null });
  s().startSketch({ kind: "default", name: "Top" });
});

describe("pasting in the sketch tool", () => {
  it("the copy follows the pointer and a click puts it down, selected, as one undo step", () => {
    const rect = addRectangle(draftData(), { x: 0, y: 0 }, { x: 10, y: 10 });
    s().updateSketch(rect.sketch, { record: true });
    const clip = copySketchItems(draftData(), rect.lineIds)!;
    s().setSketchTool("line");
    const c = new SketchController();
    c.startPaste(clip);
    expect(s().sketch!.tool).toBe("select");
    expect(c.isPasting()).toBe(true);
    let preview: unknown[] = [];
    c.onChange((t) => (preview = t.preview));
    c.pointerMove(mouse(50, 50), false);
    expect(preview).toHaveLength(4);
    const past = s().sketch!.past.length;
    c.pointerDown(mouse(50, 50));
    c.pointerUp();
    expect(c.isPasting()).toBe(false);
    expect(draftData().curves).toHaveLength(8);
    const picked = s().sketch!.selection;
    expect(picked).toHaveLength(4);
    const xs = picked.flatMap((id) => curvePoints(draftData().curves.find((k) => k.id === id)!).map((p) => pointPos(draftData(), p)[0]));
    expect(Math.min(...xs)).toBeCloseTo(45, 6);
    expect(s().sketch!.past.length).toBe(past + 1);
  });

  it("on a touch screen the copy follows the finger and lifting puts it down; lone points are drawn", () => {
    const pt = { id: "p1", x: 0, y: 0, standalone: true };
    s().updateSketch({ ...draftData(), points: [...draftData().points, pt] });
    const c = new SketchController();
    c.startPaste(copySketchItems(draftData(), ["p1"])!);
    expect(c.touchDragStarts()).toBe(false);
    expect(c.touchLiftClicks()).toBe(true);
    let preview: unknown[] = [];
    c.onChange((t) => (preview = t.preview));
    c.pointerMove(mouse(5, 5), true);
    expect(preview).toHaveLength(1);
    c.pointerDown(mouse(5, 5));
    c.pointerUp();
    expect(draftData().points.filter((p) => p.standalone)).toHaveLength(2);
    expect(c.touchDragStarts()).toBe(true);
  });

  it("Esc stops placing without changing anything", () => {
    const circle = addCircle(draftData(), { x: 0, y: 0 }, 4);
    s().updateSketch(circle.sketch);
    const before = draftData();
    const c = new SketchController();
    c.startPaste(copySketchItems(before, [circle.circleId])!);
    expect(c.cancel()).toBe(true);
    // (Off the X axis, which can be clicked — Front's line.)
    c.pointerDown(mouse(20, 7));
    c.pointerUp();
    expect(draftData().curves).toHaveLength(before.curves.length);
  });
});

describe("dragging a selection", () => {
  it("pressing on one of several picked shapes drags them all", () => {
    const rect = addRectangle(draftData(), { x: 0, y: 0 }, { x: 10, y: 10 });
    const circle = addCircle(rect.sketch, { x: 30, y: 0 }, 2);
    s().updateSketch(circle.sketch);
    s().setSketchTool("select");
    s().setSketchSelection([...rect.lineIds, circle.circleId]);
    const c = new SketchController();
    // Press on the rectangle's bottom edge, drag 5 up.
    c.pointerDown(mouse(5, 0));
    c.pointerMove(mouse(5, 2), true);
    c.pointerMove(mouse(5, 5), true);
    c.pointerUp();
    const k = draftData().curves.find((x) => x.id === circle.circleId)!;
    expect(pointPos(draftData(), curvePoints(k)[0])[1]).toBeCloseTo(5, 6);
    // Still selected.
    expect(s().sketch!.selection).toHaveLength(5);
  });
});
