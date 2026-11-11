import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { activeFeatures, useStore } from "../src/model/store";
import type { Feature } from "../src/model/types";
import type { TopoPick } from "../src/geometry/topoRef";
import { emptySketch } from "../src/sketch/types";

const s = () => useStore.getState();
const feat = (id: string, type: Feature["type"], extra: Partial<Feature> = {}): Feature => ({ id, name: id, type, operation: "new", suppressed: false, params: {}, ...extra });
const edge = (partId: string): TopoPick => ({ partId, ref: { kind: "edge" } as unknown as TopoPick["ref"] });
const ids = () => activeFeatures(s()).map((f) => f.id);

beforeEach(() => {
  const features = [
    feat("s1", "sketch", { sketch: { plane: { kind: "default", name: "Top" }, data: emptySketch() } }),
    feat("e1", "extrude", { sketchRef: "s1", apart: true }),
    feat("f1", "fillet", { operation: "add", picks: [edge("e1")] }),
    feat("box", "box"),
  ];
  useStore.setState({ history: historyOf({ ...emptyDocument(), features }), editing: null, selection: [], selectedPlane: null, selectedFeatureId: "e1", rollbackTo: "f1", deleteAsk: null });
});

describe("delete with dependents in the app", () => {
  it("deletes a sketch, its extrude and the fillet on it as one undo step", () => {
    s().askDelete({ ids: ["s1"], from: "menu" });
    const steps = s().history.past.length;
    expect(s().deleteFeatures(["s1"])).toBe(3);
    expect(ids()).toEqual(["box"]);
    expect(s().history.past.length).toBe(steps + 1);
    expect(s().deleteAsk).toBeNull();
    expect(s().selectedFeatureId).toBeNull();
    expect(s().rollbackTo).toBeNull();
    s().undo();
    expect(ids()).toEqual(["s1", "e1", "f1", "box"]);
    s().redo();
    expect(ids()).toEqual(["box"]);
  });

  it("can delete just the picked feature, leaving the ones that use it", () => {
    expect(s().deleteFeatures(["e1"], true)).toBe(1);
    expect(ids()).toEqual(["s1", "f1", "box"]);
  });
});
