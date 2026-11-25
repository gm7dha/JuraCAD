import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { useStore } from "../src/model/store";
import { SketchController, type SketchPointer } from "../src/sketch/controller";
import { useEditToolOptions } from "../src/sketch/editToolOptions";
import { addArc, addCircle, addLine, pointPos, type Placed } from "../src/sketch/ops";
import { readPattern } from "../src/sketch/patternEdit";
import { openSketchMenu, runSketchMenu, sketchMenuNow } from "../src/app/sketchMenuActions";
import { applyPatternChange, makeSketchPattern } from "../src/app/sketchActions";
import { withoutEmptyExtras } from "../src/sketch/sketchText";
import type { SketchArc, SketchData } from "../src/sketch/types";

const s = () => useStore.getState();
const draftData = () => s().editing!.draft.sketch!.data;
const MM = 0.1;
const mouse = (x: number, y: number): SketchPointer => ({ x, y, mmPerPx: MM, shift: false, ctrl: false });
const click = (c: SketchController, x: number, y: number) => {
  c.pointerDown(mouse(x, y));
  c.pointerUp();
};
const put = (d: SketchData) => s().updateSketch(d, { record: true });
const at = (x: number, y: number): Placed => ({ x, y, snap: null });

beforeEach(() => {
  useStore.setState({ history: historyOf(emptyDocument()), editing: null, sketch: null, selection: [], selectedPlane: null, selectedFeatureId: null });
  s().startSketch({ kind: "default", name: "Top" });
  useEditToolOptions.setState({ chamferMode: "equal", chamferDistance: "2", chamferDistance2: "2", chamferAngle: "45", slotWidth: "5", pattern2: false, editingPattern: null });
});

describe("editing a sketch pattern in the app", () => {
  it("Make pattern keeps the pattern; the menu's Edit pattern… opens it; Apply changes it as one undo step", () => {
    const c = addCircle(draftData(), at(0, 0), 2);
    put(c.sketch);
    s().setSketchTool("sketchPattern");
    s().setSketchOptions({ patternKind: "linear", patternCount: 3, patternSpacing: "10", patternAngle: "0" });
    s().setSketchSelection([c.circleId]);
    expect(makeSketchPattern()).toBe(true);
    const id = draftData().patterns![0].id;
    s().setSketchTool("select");
    // Right-click on a copy.
    expect(openSketchMenu({ x: 0, y: 0 }, { x: 22, y: 0 }, 0.5)).toBe(true);
    const item = sketchMenuNow()!.items.find((i) => i.action.kind === "editPattern")!;
    expect(item.label).toBe("Edit pattern…");
    runSketchMenu(item.action);
    expect(useEditToolOptions.getState().editingPattern).toBe(id);
    const past = s().sketch!.past.length;
    expect(applyPatternChange(id, { count: 5, value: "8" })).toBe(true);
    expect(s().sketch!.past.length).toBe(past + 1);
    expect(draftData().curves.filter((k) => k.type === "circle")).toHaveLength(5);
    expect(readPattern(draftData(), id)).toMatchObject({ count: 5, value: "8" });
    // Saved with the sketch.
    s().commitDraft();
    const f = s().history.present.features.find((k) => k.type === "sketch")!;
    expect(withoutEmptyExtras(f.sketch!.data).patterns).toHaveLength(1);
  });
});

describe("chamfer and round with arcs and circles, clicked", () => {
  it("Chamfer: a line, then an arc it meets, chamfers their corner", () => {
    let d = addLine(draftData(), at(0, 0), at(10, 0)).sketch;
    const end = d.points.find((p) => p.x === 10)!.id;
    d = addArc(d, { x: 10, y: 0, snap: { kind: "point", id: end } }, at(0, 10), at(7.0710678, 7.0710678)).sketch;
    put(d);
    s().setSketchTool("sketchChamfer");
    const c = new SketchController();
    click(c, 5, 0);
    expect(s().sketch!.message?.text).toMatch(/other line or arc/);
    click(c, 7.0710678, 7.0710678);
    expect(s().sketch!.message?.tone).not.toBe("error");
    const arc = draftData().curves.find((k): k is SketchArc => k.type === "arc")!;
    const ends = [arc.start, arc.end].map((p) => pointPos(draftData(), p));
    expect(ends.some(([x, y]) => Math.abs(Math.hypot(x - 10, y) - 2) < 1e-6)).toBe(true);
  });

  it("Round: a line, then a circle it crosses", () => {
    let d = addCircle(draftData(), at(0, 0), 10).sketch;
    d = addLine(d, at(-20, 5), at(20, 5)).sketch;
    put(d);
    s().setSketchOptions({ filletRadius: "2" });
    s().setSketchTool("sketchFillet");
    const c = new SketchController();
    click(c, 18, 5);
    click(c, 0, -10);
    expect(draftData().curves.filter((k) => k.type === "circle")).toHaveLength(0);
    expect(draftData().curves.filter((k) => k.type === "arc")).toHaveLength(2);
  });
});

describe("centreline dimensions by where the number goes", () => {
  it("a point and a construction line: on the far side it's the diameter, on the near side the distance", () => {
    let d = addLine(draftData(), at(0, -20), at(0, 20), { construction: true }).sketch;
    const line = d.curves[0].id;
    d = addLine(d, at(10, 5), at(10, 15)).sketch;
    put(d);
    const p = draftData().points.find((q) => q.x === 10 && q.y === 5)!.id;
    s().setSketchTool("dimension");
    const c = new SketchController();
    click(c, 10, 5);
    click(c, 0, -10);
    // Placing it across the line.
    c.pointerMove(mouse(-6, 5), false);
    click(c, -6, 5);
    let dim = draftData().constraints.find((k) => k.type === "pointLineDistance" && k.refs[0] === p)!;
    expect(dim.doubled).toBe(true);
    expect(Number(dim.value)).toBeCloseTo(20, 6);
    // The same pair placed on the point's side: the plain distance.
    s().updateSketch({ ...draftData(), constraints: draftData().constraints.filter((k) => k.id !== dim.id) }, { record: true });
    click(c, 10, 5);
    click(c, 0, -10);
    click(c, 4, 5);
    dim = draftData().constraints.find((k) => k.type === "pointLineDistance" && k.refs[0] === p)!;
    expect(dim.doubled).toBeUndefined();
    expect(Number(dim.value)).toBeCloseTo(10, 6);
    void line;
  });
});
