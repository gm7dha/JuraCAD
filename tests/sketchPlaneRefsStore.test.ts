/**
 * Planes as sketch references through the sketch tools (the controller), as the view drives them: drawing onto the
 * origin's axes (Front's and Right's lines in a sketch on Top), dimensioning to one, picking one for a relation, and
 * a Plane feature's line in a sketch on Front.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { useStore } from "../src/model/store";
import { SketchController, type SketchPointer } from "../src/sketch/controller";
import { addLine, applyRelation, pointPos } from "../src/sketch/ops";
import { PLANE_ITEM } from "../src/sketch/planeRefs";
import type { Feature, PlaneOptions } from "../src/model/types";
import type { SketchData, SketchLine } from "../src/sketch/types";

const s = () => useStore.getState();
const d = (): SketchData => s().editing!.draft.sketch!.data;
const m = (x: number, y: number): SketchPointer => ({ x, y, mmPerPx: 0.1, shift: false, ctrl: false });
const click = (c: SketchController, x: number, y: number) => {
  c.pointerMove(m(x, y), false);
  c.pointerDown(m(x, y));
  c.pointerUp();
};
const linked = () => d().curves.filter((k) => "link" in k && k.link) as SketchLine[];

beforeEach(() => {
  useStore.setState({ history: historyOf(emptyDocument()), editing: null, sketch: null, selection: [], selectedPlane: null, selectedFeatureId: null });
});

describe("the origin's axes in a sketch on Top", () => {
  beforeEach(() => s().startSketch({ kind: "default", name: "Top" }));

  it("a point drawn onto the X axis is held level with the origin; nothing is brought in", () => {
    s().setSketchTool("point");
    const c = new SketchController();
    click(c, 20, 0.2);
    const p = d().points.find((q) => q.standalone)!;
    expect(pointPos(d(), p.id)).toEqual([20, 0]);
    expect(d().constraints.some((k) => k.type === "horizontal" && k.refs[0] === p.id && k.refs[1] === "origin")).toBe(true);
    expect(linked()).toHaveLength(0);
  });

  it("the dimension tool measures from a point to Front's line (bringing it in as a reference)", () => {
    const l = addLine(d(), { x: 5, y: 8, snap: null }, { x: 25, y: 12, snap: null });
    s().updateSketch(l.sketch, { record: true });
    s().setSketchTool("dimension");
    const c = new SketchController();
    click(c, 5, 8);
    click(c, 40, 0.1);
    click(c, 45, 4);
    const brought = linked();
    expect(brought).toHaveLength(1);
    expect(brought[0].link).toEqual({ sketch: "@Front", item: PLANE_ITEM });
    expect(brought[0].construction).toBe(true);
    const dim = d().constraints.find((k) => k.type === "pointLineDistance" || k.type === "verticalDistance");
    expect(dim).toBeTruthy();
  });

  it("Right's line can be picked for a relation: a line made parallel to it stands upright", () => {
    const l = addLine(d(), { x: 10, y: 0.5, snap: null }, { x: 12, y: 9, snap: null });
    s().updateSketch(l.sketch, { record: true });
    s().setSketchTool("select");
    const c = new SketchController();
    click(c, 0.1, 30);
    const axis = s().sketch!.selection[0];
    expect(linked().map((k) => k.id)).toEqual([axis]);
    const r = applyRelation(d(), "parallel", [l.lineId, axis]);
    expect(r.error).toBeUndefined();
    const line = r.sketch.curves.find((k) => k.id === l.lineId) as SketchLine;
    const [a, b] = [pointPos(r.sketch, line.p1), pointPos(r.sketch, line.p2)];
    expect(a[0]).toBeCloseTo(b[0], 6);
  });

  it("clicking along an axis and then elsewhere leaves no copy behind, and no undo step", () => {
    const l = addLine(d(), { x: 10, y: 5, snap: null }, { x: 12, y: 9, snap: null });
    s().updateSketch(l.sketch, { record: true });
    s().setSketchTool("select");
    const steps = s().sketch!.past.length;
    const c = new SketchController();
    // On the X axis (Front's line): it's picked, as Onshape picks the plane.
    click(c, 30, 0.1);
    expect(linked()).toHaveLength(1);
    expect(s().sketch!.selection).toEqual([linked()[0].id]);
    // Empty space: nothing picked, and the copy goes again.
    click(c, 30, 40);
    expect(s().sketch!.selection).toEqual([]);
    expect(linked()).toHaveLength(0);
    // Picking the axis and then the line instead: the copy goes too.
    click(c, 30, 0.1);
    click(c, 11, 7);
    expect(s().sketch!.selection).toEqual([l.lineId]);
    expect(linked()).toHaveLength(0);
    expect(s().sketch!.past.length).toBe(steps);
    // Used by a relation, it stays when it's no longer picked.
    click(c, 0.1, 30);
    const axis = s().sketch!.selection[0];
    const r = applyRelation(d(), "parallel", [l.lineId, axis]);
    s().updateSketch(r.sketch, { record: true });
    click(c, 30, 40);
    expect(linked().map((k) => k.id)).toEqual([axis]);
  });
});

describe("a Plane feature's line", () => {
  it("is offered in a sketch on Front, where an offset of Top crosses it", () => {
    const plane: Feature = {
      id: "pl1",
      name: "Plane 1",
      type: "plane",
      operation: "new",
      suppressed: false,
      params: { distance: "15" },
      planeDef: { mode: "offset", ref: { kind: "default", name: "Top" }, axis: "u" } as PlaneOptions,
    };
    useStore.setState({ history: historyOf({ ...emptyDocument(), features: [plane] }) });
    s().startSketch({ kind: "default", name: "Front" });
    s().setSketchTool("point");
    const c = new SketchController();
    click(c, 8, 15.2);
    const p = d().points.find((q) => q.standalone)!;
    expect(pointPos(d(), p.id)[1]).toBeCloseTo(15, 6);
    expect(linked().map((k) => k.link)).toEqual([{ sketch: "pl1", item: PLANE_ITEM }]);
    // Hidden, its line isn't offered (default planes' lines always are).
    useStore.setState({ history: historyOf({ ...emptyDocument(), features: [{ ...plane, visible: false }] }) });
    s().startSketch({ kind: "default", name: "Front" });
    s().setSketchTool("point");
    const c2 = new SketchController();
    click(c2, 8, 15.2);
    expect(linked()).toHaveLength(0);
  });
});
