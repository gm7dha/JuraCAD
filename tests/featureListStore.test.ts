import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { activeFeatures, pickedFeatures, useStore } from "../src/model/store";
import type { Feature } from "../src/model/types";
import { emptySketch } from "../src/sketch/types";

const s = () => useStore.getState();
const feat = (id: string, type: Feature["type"], extra: Partial<Feature> = {}): Feature => ({ id, name: id, type, operation: "new", suppressed: false, params: {}, ...extra });
const suppressed = () => activeFeatures(s()).filter((f) => f.suppressed).map((f) => f.id);

beforeEach(() => {
  const features = [
    feat("s1", "sketch", { sketch: { plane: { kind: "default", name: "Top" }, data: emptySketch() } }),
    feat("e1", "extrude", { sketchRef: "s1", apart: true, extrude: { end: "blind", flip: false }, params: { depth: "10" } }),
    feat("b1", "box"),
    feat("b2", "box"),
  ];
  useStore.setState({ history: historyOf({ ...emptyDocument(), features }), editing: null, sketch: null, selection: [], selectedPlane: null, selectedFeatureId: null, featureSelection: [], rollbackTo: null });
});

describe("several features picked in the list", () => {
  it("keeps the picked ones, the clicked one as the main one, and gives the same list back each time", () => {
    s().selectFeatures(["e1", "b1", "b2"], "b1");
    expect(s().selectedFeatureId).toBe("b1");
    expect(pickedFeatures(s())).toEqual(["e1", "b1", "b2"]);
    expect(pickedFeatures(s())).toBe(pickedFeatures(s()));
    // A plain click elsewhere (or anything that picks one feature) lets the others go.
    s().selectFeature("b2");
    expect(pickedFeatures(s())).toEqual(["b2"]);
    expect(pickedFeatures(s())).toBe(pickedFeatures(s()));
    s().selectFeature(null);
    expect(pickedFeatures(s())).toEqual([]);
  });

  it("leaves out picked features that are gone (deleted, or taken away by an undo)", () => {
    s().selectFeatures(["e1", "b1", "b2"], "b1");
    s().deleteFeature("b2");
    expect(pickedFeatures(s())).toEqual(["e1", "b1"]);
    expect(pickedFeatures(s())).toBe(pickedFeatures(s()));
    s().undo();
    expect(pickedFeatures(s())).toEqual(["e1", "b1", "b2"]);
    s().deleteFeature("e1");
    expect(pickedFeatures(s())).toEqual(["b1", "b2"]);
    s().deleteFeature("b2");
    // One left: just the main one.
    expect(pickedFeatures(s())).toEqual(["b1"]);
  });

  it("suppresses and unsuppresses them all as one undo step", () => {
    const steps = s().history.past.length;
    s().setFeaturesSuppressed(["e1", "b1"], true);
    expect(suppressed()).toEqual(["e1", "b1"]);
    expect(s().history.past.length).toBe(steps + 1);
    s().setFeaturesSuppressed(["b1", "b2"], false);
    expect(suppressed()).toEqual(["e1"]);
    s().undo();
    expect(suppressed()).toEqual(["e1", "b1"]);
    s().undo();
    expect(suppressed()).toEqual([]);
    // Nothing to change: no undo step.
    s().setFeaturesSuppressed(["b2"], false);
    expect(s().history.past.length).toBe(steps);
  });

  it("starts a pattern repeating every picked feature that makes a solid", () => {
    s().selectFeatures(["s1", "e1", "b2"], "e1");
    s().startCreate("linearPattern");
    expect(s().editing?.draft.pattern?.sources).toEqual(["e1", "b2"]);
    // Opening a feature lets the list's picks go.
    expect(pickedFeatures(s())).toEqual([]);
  });
});

describe("dialogs remember their last options", () => {
  it("starts the next new fillet at the radius the last one was made with", () => {
    s().startCreate("fillet");
    s().setDraftParam("radius", "4");
    // (Something to round: a fillet with nothing picked can't be accepted.)
    s().setDraftField({ picks: [{ partId: "b1", ref: { kind: "edge", curve: "LINE", a: [0, 0, 0], b: [1, 0, 0], mid: [0.5, 0, 0] } }] });
    s().commitDraft();
    s().startCreate("fillet");
    expect(s().editing?.draft.params.radius).toBe("4");
    s().cancelDraft();
    // Editing an existing one doesn't change what's remembered.
    const made = activeFeatures(s()).find((f) => f.type === "fillet")!;
    s().startEdit(made.id);
    s().setDraftParam("radius", "7");
    s().commitDraft();
    s().startCreate("fillet");
    expect(s().editing?.draft.params.radius).toBe("4");
    s().cancelDraft();
  });
});
