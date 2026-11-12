import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { copyFeatures } from "../src/model/featureClipboard";
import { viewsOf } from "../src/model/namedViews";
import { activeFeatures, useStore, viewOwner } from "../src/model/store";
import type { Feature } from "../src/model/types";
import { emptySketch } from "../src/sketch/types";

const s = () => useStore.getState();
const feat = (id: string, type: Feature["type"], extra: Partial<Feature> = {}): Feature => ({ id, name: id, type, operation: "new", suppressed: false, params: {}, ...extra });

beforeEach(() => {
  const features = [
    feat("f_s1", "sketch", { name: "Sketch 1", sketch: { plane: { kind: "default", name: "Top" }, data: emptySketch() } }),
    feat("f_e1", "extrude", { name: "Extrude 1", sketchRef: "f_s1", params: { depth: "wall" } }),
    feat("f_box", "box", { name: "Box 1" }),
  ];
  useStore.setState({ history: historyOf({ ...emptyDocument(), features, variables: [{ id: "v1", name: "wall", value: "4" }] }), editing: null, sketch: null, activeTab: null, rollbackTo: null, pasteAsk: null, selectedFeatureId: null });
});

describe("paste in the app", () => {
  it("pastes a copy after the rollback bar as one undo step", () => {
    const clip = copyFeatures(activeFeatures(s()), ["f_e1"], s().history.present.variables)!.clip;
    s().setRollback("f_e1");
    const steps = s().history.past.length;
    const r = s().pasteFeatures(clip, false)!;
    expect(r.pasted.map((f) => f.name)).toEqual(["Sketch 2", "Extrude 2"]);
    expect(activeFeatures(s()).map((f) => f.name)).toEqual(["Sketch 1", "Extrude 1", "Sketch 2", "Extrude 2", "Box 1"]);
    expect(s().rollbackTo).toBe(r.pasted[1].id);
    expect(s().selectedFeatureId).toBe(r.pasted[1].id);
    expect(s().history.past.length).toBe(steps + 1);
    s().undo();
    expect(activeFeatures(s())).toHaveLength(3);
  });

  it("adds missing variables in the same step when asked", () => {
    const clip = copyFeatures(activeFeatures(s()), ["f_e1"], s().history.present.variables)!.clip;
    useStore.setState({ history: historyOf({ ...emptyDocument(), features: [] }) });
    s().pasteFeatures(clip, true);
    expect(s().history.present.variables?.map((v) => v.name)).toEqual(["wall"]);
    s().undo();
    expect(s().history.present.variables ?? []).toEqual([]);
  });

  it("won't paste while a sketch or dialog is open", () => {
    const clip = copyFeatures(activeFeatures(s()), ["f_box"])!.clip;
    useStore.setState({ editing: { mode: "create", draft: feat("x", "box") } as never });
    expect(s().pasteFeatures(clip, false)).toBeNull();
  });
});

describe("named views in the app", () => {
  it("saves, renames and deletes, undoably, per Part Studio", () => {
    const cam = { dir: [1, 0, 0] as [number, number, number], target: [0, 0, 0] as [number, number, number], zoom: 1, up: [0, 0, 1] as [number, number, number] };
    s().saveNamedView(cam);
    const owner = viewOwner(s());
    const [v] = viewsOf(s().history.present, owner);
    expect(v.name).toBe("View 1");
    s().renameNamedView(v.id, "Side");
    expect(viewsOf(s().history.present, owner)[0].name).toBe("Side");
    s().deleteNamedView(v.id);
    expect(viewsOf(s().history.present, owner)).toEqual([]);
    s().undo();
    expect(viewsOf(s().history.present, owner)[0].name).toBe("Side");
  });
});
