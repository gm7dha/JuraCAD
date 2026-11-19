import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { useStore } from "../src/model/store";
import { SketchController, type SketchPointer } from "../src/sketch/controller";
import { useEditToolOptions } from "../src/sketch/editToolOptions";
import { addLine, addRectangle, pointPos } from "../src/sketch/ops";
import type { SketchData, SketchLine } from "../src/sketch/types";

const s = () => useStore.getState();
const draftData = () => s().editing!.draft.sketch!.data;
const MM = 0.1;
const mouse = (x: number, y: number, shift = false): SketchPointer => ({ x, y, mmPerPx: MM, shift, ctrl: false });
const click = (c: SketchController, x: number, y: number) => {
  c.pointerDown(mouse(x, y));
  c.pointerUp();
};
const put = (d: SketchData) => s().updateSketch(d, { record: true });

beforeEach(() => {
  useStore.setState({ history: historyOf(emptyDocument()), editing: null, sketch: null, selection: [], selectedPlane: null, selectedFeatureId: null });
  s().startSketch({ kind: "default", name: "Top" });
  useEditToolOptions.setState({ chamferMode: "equal", chamferDistance: "2", chamferDistance2: "2", chamferAngle: "45", slotWidth: "5" });
});

describe("the sketch's newer editing tools, clicked", () => {
  it("Chamfer: clicking two corners makes two chamfers, the second Equal to the first", () => {
    const r = addRectangle(draftData(), { x: 0, y: 0 }, { x: 40, y: 20 });
    put(r.sketch);
    s().setSketchTool("sketchChamfer");
    const c = new SketchController();
    click(c, 40, 0);
    click(c, 40, 20);
    const d = draftData();
    expect(d.curves.filter((k) => k.type === "line" && !k.construction)).toHaveLength(6);
    expect(d.constraints.filter((k) => k.type === "length")).toHaveLength(1);
    expect(d.constraints.filter((k) => k.type === "equal").length).toBeGreaterThanOrEqual(3);
  });

  it("Round: a line, then another line it doesn't meet, rounds between them", () => {
    let d = addLine(draftData(), { x: 0, y: 0 }, { x: 30, y: 0 }).sketch;
    d = addLine(d, { x: 20, y: 10 }, { x: 20, y: 40 }).sketch;
    put(d);
    s().setSketchOptions({ filletRadius: "5" });
    s().setSketchTool("sketchFillet");
    const c = new SketchController();
    const past = s().sketch!.past.length;
    click(c, 5, 0);
    expect(s().sketch!.message?.text).toMatch(/other line or arc/);
    click(c, 20, 30);
    const after = draftData();
    expect(after.curves.some((k) => k.type === "arc")).toBe(true);
    expect(s().sketch!.past.length).toBe(past + 1);
  });

  it("Trim: dragging across two lines trims both in one undo step; a click still trims one", () => {
    let d = addLine(draftData(), { x: 0, y: 0 }, { x: 30, y: 0 }).sketch;
    for (const x of [5, 15, 25]) d = addLine(d, { x, y: -10 }, { x, y: 10 }).sketch;
    put(d);
    s().setSketchTool("trim");
    const c = new SketchController();
    const past = s().sketch!.past.length;
    c.pointerDown(mouse(12, 5));
    for (const x of [14, 18, 22, 28]) c.pointerMove(mouse(x, 5), true);
    c.pointerUp();
    expect(s().sketch!.past.length).toBe(past + 1);
    expect(s().sketch!.message?.text).toMatch(/Trimmed 2 pieces/);
    const tops = (k: SketchData) =>
      k.curves.filter((l): l is SketchLine => l.type === "line" && Math.abs(pointPos(k, l.p1)[0] - pointPos(k, l.p2)[0]) < 1e-9).map((l) => Math.max(pointPos(k, l.p1)[1], pointPos(k, l.p2)[1]));
    expect(tops(draftData()).filter((y) => y > 1)).toHaveLength(1);
    // A plain click on the last upright's top trims it.
    click(c, 5, 5);
    expect(tops(draftData()).filter((y) => y > 1)).toHaveLength(0);
  });

  it("Trim with a finger: the drag's lift ends the path, a second finger drops it", () => {
    let d = addLine(draftData(), { x: 0, y: 0 }, { x: 30, y: 0 }).sketch;
    for (const x of [5, 15]) d = addLine(d, { x, y: -10 }, { x, y: 10 }).sketch;
    put(d);
    s().setSketchTool("trim");
    const c = new SketchController();
    const before = draftData();
    expect(c.touchDragStarts(mouse(2, 5))).toBe(true);
    c.beginStroke();
    c.pointerDown(mouse(2, 5));
    c.pointerMove(mouse(10, 5), true);
    c.cancelStroke();
    c.pointerUp();
    expect(draftData()).toBe(before);
    c.beginStroke();
    c.pointerDown(mouse(2, 5));
    c.pointerMove(mouse(10, 5), true);
    c.pointerMove(mouse(18, 5), true);
    expect(c.touchLiftClicks()).toBe(true);
    c.pointerDown(mouse(19, 5));
    c.pointerUp();
    c.endStroke();
    expect(s().sketch!.message?.text).toMatch(/Trimmed 2 pieces/);
  });

  it("Elliptical arc: centre, axis end, start, end", () => {
    s().setSketchTool("ellipticalArc");
    const c = new SketchController();
    for (const [x, y] of [
      [0, 0],
      [20, 0],
      [0, 10],
      [20, 1],
    ])
      click(c, x, y);
    const el = draftData().curves.find((k) => k.type === "ellipse");
    expect(el?.type === "ellipse" && !!el.start && !!el.end).toBe(true);
  });

  it("Slot on a curve: click a line", () => {
    put(addLine(draftData(), { x: 0, y: 0 }, { x: 30, y: 0 }).sketch);
    useEditToolOptions.setState({ slotWidth: "6" });
    s().setSketchTool("slotAlong");
    const c = new SketchController();
    click(c, 15, 0);
    const d = draftData();
    expect(d.curves.filter((k) => k.type === "arc")).toHaveLength(2);
    expect(d.constraints.find((k) => k.type === "offset")?.value).toBe("3");
  });
});
