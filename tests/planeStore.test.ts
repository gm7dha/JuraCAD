/**
 * The store and planes that follow the model: a rebuild's result (where the planes and mate connectors were built)
 * is kept for showing them, but never changes the design — no undo step, nothing to save, the same document.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { emptyDocument, historyOf } from "../src/model/document";
import { useStore } from "../src/model/store";
import { framesOf } from "../src/sketch/planeFeature";

const s = () => useStore.getState();

beforeEach(() => {
  useStore.setState({ history: historyOf(emptyDocument()), editing: null, selection: [], selectedPlane: null, selectedFeatureId: null, draftSteps: null });
});

describe("planes that follow the model, in the app", () => {
  it("a rebuild never changes the design; where they were built is shown instead", () => {
    s().startCreate("plane");
    s().setDraftField({ planeDef: { mode: "pointNormal", ref: { kind: "default", name: "Top" }, axis: "u", points: [{ p: [10, 0, 5] }], line: { p: [0, 0, 0], dir: [0, 0, 1], axis: "z" } } });
    expect(s().commitDraft()).toBe(true);
    const plane = s().history.present.features.at(-1)!;
    const before = s().history;
    const frame = { origin: [30, 0, 5] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number], n: [0, 0, 1] as [number, number, number] };
    s().setRebuildResult([], {}, 1, undefined, undefined, undefined, undefined, undefined, { [plane.id]: frame });
    // The same document and history (nothing to undo, nothing unsaved)…
    expect(s().history).toBe(before);
    // …but the plane is shown, and used, where it was built.
    expect(framesOf(s().history.present.features, undefined, s().builtFrames).get(plane.id)!.origin).toEqual([30, 0, 5]);
    expect(framesOf(s().history.present.features).get(plane.id)!.origin).toEqual([10, 0, 5]);
    // The same answer again keeps the same object (nothing redraws).
    const kept = s().builtFrames;
    s().setRebuildResult([], {}, 1, undefined, undefined, undefined, undefined, undefined, { [plane.id]: { ...frame } });
    expect(s().builtFrames).toBe(kept);
    expect(s().history).toBe(before);
  });
});
