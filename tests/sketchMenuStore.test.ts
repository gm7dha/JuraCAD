import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { useStore } from "../src/model/store";
import { addCircle, addDimension, addLine, addRectangle, type Placed } from "../src/sketch/ops";
import { SketchController } from "../src/sketch/controller";
import { finishSketchInto, openSketchMenu, openSketchMenuOn, runSketchKey, runSketchMenu, sketchMenuNow, switchSketchRoundDimension } from "../src/app/sketchMenuActions";
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

  it("on empty space it still opens, with Hide all constraints; hidden ones still hold the shapes", () => {
    const r = addRectangle(draftData(), at(0, 0), at(20, 10));
    s().updateSketch(r.sketch, { record: true });
    const before = draftData().constraints.length;
    setSketchView({ constraints: true });
    expect(openSketchMenu({ x: 0, y: 0 }, { x: 200, y: 200 }, 0.5)).toBe(true);
    expect(s().sketch!.selection).toEqual([]);
    const hide = sketchMenuNow()!.items.find((i) => i.label === "Hide all constraints")!;
    expect(hide).toBeTruthy();
    runSketchMenu(hide.action);
    expect(sketchViewNow().constraints).toBe(false);
    expect(draftData().constraints.length).toBe(before);
    expect(s().sketch!.message?.text).toContain("still hold");
    openSketchMenu({ x: 0, y: 0 }, null, 0);
    const show = sketchMenuNow()!.items.find((i) => i.label === "Show all constraints")!;
    runSketchMenu(show.action);
    expect(sketchViewNow().constraints).toBe(true);
  });

  it("right-clicking a relation badge or a dimension picks it and opens the menu", () => {
    const c = addCircle(draftData(), at(0, 0), 4);
    const d = addDimension(c.sketch, [c.circleId]);
    s().updateSketch(d.sketch, { record: true });
    s().setSketchSelection([]);
    expect(openSketchMenuOn(d.dimensionId, { x: 10, y: 10 })).toBe(true);
    expect(s().sketch!.selection).toEqual([d.dimensionId]);
    expect(sketchMenuNow()!.items.map((i) => i.label)).toContain("Show as a radius");
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

describe("a sketch opens with the Select tool", () => {
  it("new, and edited again", () => {
    expect(s().sketch!.tool).toBe("select");
    const r = addRectangle(draftData(), at(0, 0), at(20, 10));
    s().updateSketch(r.sketch, { record: true });
    s().setSketchTool("line");
    expect(s().commitDraft()).toBe(true);
    const id = s().history.present.features.find((f) => f.type === "sketch")!.id;
    s().startEdit(id);
    expect(s().sketch!.tool).toBe("select");
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

describe("hidden construction geometry", () => {
  it("can't be clicked or boxed while hidden, and can again once shown", () => {
    // (Beside the Y axis — Right's line, which can be clicked too.)
    const axis = addLine(draftData(), at(5, -10), at(5, 10), { construction: true });
    s().updateSketch(axis.sketch, { record: true });
    s().setSketchTool("select");
    const c = new SketchController();
    const click = (x: number, y: number) => {
      c.pointerDown({ x, y, mmPerPx: 0.1, shift: false, ctrl: false });
      c.pointerUp();
    };
    c.setHidden(new Set([axis.lineId]));
    click(5, 3);
    expect(s().sketch!.selection).toEqual([]);
    c.setHidden(new Set());
    click(5, 3);
    expect(s().sketch!.selection).toEqual([axis.lineId]);
  });

  it("isn't offered by the right-click menu's Select other", () => {
    const axis = addLine(draftData(), at(0, -10), at(0, 10), { construction: true });
    s().updateSketch(axis.sketch, { record: true });
    setSketchView({ hideConstruction: true });
    try {
      openSketchMenu({ x: 0, y: 0 }, { x: 0, y: 3 }, 1);
      expect(sketchMenuNow()!.under).toEqual([]);
      expect(s().sketch!.selection).toEqual([]);
    } finally {
      setSketchView({ hideConstruction: false });
    }
  });
});
