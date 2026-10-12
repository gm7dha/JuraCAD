import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { useStore } from "../src/model/store";
import { addCircle, addRectangle } from "../src/sketch/ops";

const s = () => useStore.getState();
const draftData = () => s().editing!.draft.sketch!.data;

beforeEach(() => {
  useStore.setState({ history: historyOf(emptyDocument()), editing: null, sketch: null, selection: [], selectedPlane: null, selectedFeatureId: null });
});

describe("sketch sessions", () => {
  it("asks for a plane, then uses the one picked", () => {
    s().startSketch(null);
    expect(s().sketch).not.toBeNull();
    expect(s().sketch?.message?.text).toMatch(/Top, Front or Right/);
    expect(s().commitDraft()).toBe(false);
    expect(s().sketch?.message?.tone).toBe("error");

    s().setSketchPlane({ kind: "default", name: "Front" });
    expect(s().editing?.draft.sketch?.plane).toEqual({ kind: "default", name: "Front" });
    expect(s().sketch?.message).toBeNull();
  });

  it("starts on the selected plane", () => {
    useStore.setState({ selectedPlane: "Right" });
    s().startCreate("sketch");
    expect(s().editing?.draft.sketch?.plane).toEqual({ kind: "default", name: "Right" });
  });

  it("has its own undo and redo while sketching", () => {
    s().startSketch({ kind: "default", name: "Top" });
    const rect = addRectangle(draftData(), { x: 0, y: 0 }, { x: 10, y: 10 });
    s().updateSketch(rect.sketch);
    const withCircle = addCircle(draftData(), { x: 5, y: 5 }, 2);
    s().updateSketch(withCircle.sketch);
    expect(draftData().curves).toHaveLength(5);

    s().sketchUndo();
    expect(draftData().curves).toHaveLength(4);
    s().sketchUndo();
    expect(draftData().curves).toHaveLength(0);
    s().sketchRedo();
    expect(draftData().curves).toHaveLength(4);

    // Drags don't add a step per frame: one step when they finish.
    const before = draftData();
    s().updateSketch({ ...before, points: before.points.map((p) => ({ ...p, x: p.x + 1 })) }, { record: false });
    s().updateSketch({ ...before, points: before.points.map((p) => ({ ...p, x: p.x + 2 })) }, { record: false });
    s().recordSketchStep(before);
    s().sketchUndo();
    expect(draftData()).toBe(before);
  });

  it("saves the sketch as a feature, and reopens it for editing", () => {
    s().startSketch({ kind: "default", name: "Top" });
    s().updateSketch(addRectangle(draftData(), { x: 0, y: 0 }, { x: 10, y: 10 }).sketch);
    expect(s().commitDraft()).toBe(true);
    expect(s().sketch).toBeNull();
    const saved = s().history.present.features[0];
    expect(saved.type).toBe("sketch");
    expect(saved.sketch?.data.curves).toHaveLength(4);

    s().startEdit(saved.id);
    expect(s().sketch).not.toBeNull();
    s().cancelDraft();
    expect(s().sketch).toBeNull();

    // Extrude picks the latest sketch, and adds to existing solids.
    s().startCreate("extrude");
    expect(s().editing?.draft.sketchRef).toBe(saved.id);
    expect(s().editing?.draft.operation).toBe("new");
  });
});
