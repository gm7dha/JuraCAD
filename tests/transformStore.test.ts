import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { useStore } from "../src/model/store";

const s = () => useStore.getState();

beforeEach(() => {
  useStore.setState({ history: historyOf(emptyDocument()), editing: null, selection: [], selectedPlane: null, selectedFeatureId: null, draftSteps: null, transformLive: null });
});

describe("Move / copy dialog's own undo", () => {
  it("makes each finished drag one step, undone one at a time, and accepts as one change", () => {
    s().startCreate("box");
    expect(s().commitDraft()).toBe(true);
    const doneBefore = s().history.past.length;
    s().startCreate("transform");
    // While dragging, the boxes show live values; the draft only changes when the drag is let go.
    s().setTransformLive({ dx: "12" });
    expect(s().editing!.draft.params.dx).toBe("0");
    s().changeDraftStep({ params: { dx: "12" } });
    expect(s().transformLive).toBeNull();
    s().changeDraftStep({ params: { dy: "5" } });
    expect([s().editing!.draft.params.dx, s().editing!.draft.params.dy]).toEqual(["12", "5"]);
    expect(s().undoDraftStep()).toBe(true);
    expect([s().editing!.draft.params.dx, s().editing!.draft.params.dy]).toEqual(["12", "0"]);
    expect(s().undoDraftStep()).toBe(true);
    expect(s().editing!.draft.params.dx).toBe("0");
    expect(s().undoDraftStep()).toBe(false);
    s().changeDraftStep({ params: { dx: "7" }, transform: { ...s().editing!.draft.transform!, mode: "xyz" } });
    expect(s().commitDraft()).toBe(true);
    // Accepting is one change to the design, as usual.
    expect(s().history.past.length).toBe(doneBefore + 1);
    const t = s().history.present.features.at(-1)!;
    expect([t.params.dx, t.transform?.mode]).toEqual(["7", "xyz"]);
  });
});
