import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { useStore } from "../src/model/store";
import { addCircle, addDimension, addLine, addRectangle, type Placed } from "../src/sketch/ops";
import { SketchController } from "../src/sketch/controller";
import { finishSketchInto, openSketchMenu, runSketchKey, runSketchMenu, sketchMenuNow, switchSketchRoundDimension } from "../src/app/sketchMenuActions";
import { setSketchView, sketchViewNow } from "../src/app/sketchViewState";
import { sketchKeyFor } from "../src/sketch/sketchView";

const s = () => useStore.getState();
const draftData = () => s().editing!.draft.sketch!.data;
const at = (x: number, y: number): Placed => ({ x, y, snap: null });

beforeEach(() => {
  useStore.setState({ history: historyOf(emptyDocument()), editing: null, sketch: null, selection: [], selectedPlane: null, selectedFeatureId: null });
  s().startSketch({ kind: "default", name: "Top" });
});

describe("the sketch's right-click menu", () => {
  it("picks what's under the pointer and offers the relations that fit; choosing one adds it as one undo step", () => {
    const a = addLine(draftData(), at(0, 0), at(10, 1));
    const b = addLine(a.sketch, at(0, 5), at(10, 7));
    s().updateSketch(b.sketch, { record: true });
    s().setSketchSelection([a.lineId]);
    expect(openSketchMenu({ x: 100, y: 100 }, { x: 5, y: 6 }, 0.5)).toBe(true);
    // The line under the pointer joined the selection.
    expect(s().sketch!.selection).toEqual([a.lineId, b.lineId]);
    const menu = sketchMenuNow()!;
    const parallel = menu.items.find((i) => i.label === "Parallel")!;
    expect(parallel).toBeTruthy();
    const past = s().sketch!.past.length;
    runSketchMenu(parallel.action);
    expect(sketchMenuNow()).toBeNull();
    expect(draftData().constraints.some((c) => c.type === "parallel")).toBe(true);
    expect(s().sketch!.past.length).toBe(past + 1);
  });

  it("Select other lists both things under the pointer", () => {
    const a = addLine(draftData(), at(0, 0), at(10, 0));
    const b = addLine(a.sketch, at(5, -5), at(5, 5));
    s().updateSketch(b.sketch, { record: true });
    openSketchMenu({ x: 0, y: 0 }, { x: 5, y: 0 }, 0.5);
    const other = sketchMenuNow()!.items.find((i) => i.action.kind === "selectOther")!;
    runSketchMenu(other.action);
    expect(sketchMenuNow()!.other!.ids.sort()).toEqual([a.lineId, b.lineId].sort());
  });

  it("hides and shows constraints and dimensions", () => {
    setSketchView({ constraints: true, dimensions: true });
    openSketchMenu({ x: 0, y: 0 }, null, 0);
    runSketchMenu(sketchMenuNow()!.items.find((i) => i.action.kind === "showDimensions")!.action);
    expect(sketchViewNow().dimensions).toBe(false);
    setSketchView({ dimensions: true });
  });

  it("switches a circle's diameter to a radius", () => {
    const c = addCircle(draftData(), at(0, 0), 4);
    const d = addDimension(c.sketch, [c.circleId]);
    s().updateSketch(d.sketch, { record: true });
    switchSketchRoundDimension(d.dimensionId);
    const k = draftData().constraints.find((x) => x.id === d.dimensionId)!;
    expect(k.type).toBe("radius");
    expect(Number(k.value)).toBeCloseTo(4, 6);
  });
});

describe("sketch keys", () => {
  it("B makes two lines parallel; X picks Extend; Shift+P hides construction geometry", () => {
    const a = addLine(draftData(), at(0, 0), at(10, 1));
    const b = addLine(a.sketch, at(0, 5), at(10, 7));
    s().updateSketch(b.sketch, { record: true });
    s().setSketchSelection([a.lineId, b.lineId]);
    runSketchKey(sketchKeyFor("KeyB", false)!);
    expect(draftData().constraints.some((c) => c.type === "parallel")).toBe(true);
    runSketchKey(sketchKeyFor("KeyX", false)!);
    expect(s().sketch!.tool).toBe("extend");
    const was = sketchViewNow().hideConstruction;
    runSketchKey(sketchKeyFor("KeyP", true)!);
    expect(sketchViewNow().hideConstruction).toBe(!was);
    setSketchView({ hideConstruction: false });
  });
});

describe("Extrude straight from the sketch", () => {
  it("finishes the sketch and opens Extrude on it", () => {
    const r = addRectangle(draftData(), at(0, 0), at(10, 5));
    s().updateSketch(r.sketch, { record: true });
    const id = s().editing!.draft.id;
    expect(finishSketchInto("extrude")).toBe(true);
    expect(s().sketch).toBeNull();
    expect(s().editing?.draft.type).toBe("extrude");
    expect(s().editing?.draft.sketchRef).toBe(id);
  });

  it("refuses with no closed shape, and the sketch stays open", () => {
    const l = addLine(draftData(), at(0, 0), at(10, 0));
    s().updateSketch(l.sketch, { record: true });
    expect(finishSketchInto("revolve")).toBe(false);
    expect(s().sketch).not.toBeNull();
    expect(s().sketch!.message?.tone).toBe("error");
  });
});

describe("the controller says when a shape is half drawn", () => {
  it("busy while a spline is being clicked", () => {
    s().setSketchTool("spline");
    const c = new SketchController();
    expect(c.busy()).toBe(false);
    c.pointerDown({ x: 0, y: 0, mmPerPx: 0.1, shift: false, ctrl: false });
    c.pointerUp();
    expect(c.busy()).toBe(true);
    c.cancel();
    expect(c.busy()).toBe(false);
  });
});
