import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { useStore } from "../src/model/store";
import { DEFAULT_FITS } from "../src/model/printSettings";

const s = () => useStore.getState();

beforeEach(() => {
  useStore.setState({ history: historyOf(emptyDocument()), editing: null, selection: [], selectedPlane: null, selectedFeatureId: null });
});

describe("a printed fit chosen in the Hole dialog", () => {
  it("adds the fit variables on Accept, in the same undo step, and sizes the hole from them", () => {
    s().startCreate("hole");
    const hole = s().editing!.draft.hole!;
    s().setDraftField({ hole: { ...hole, standard: "Custom", printedFit: { fit: "sliding", nominal: "5 mm", fits: DEFAULT_FITS } } });
    s().setDraftParam("diameter", "5 mm + 0.3 mm");
    // Nothing is added while the dialog is open.
    expect(s().history.present.variables ?? []).toEqual([]);
    const steps = s().history.past.length;
    expect(s().commitDraft()).toBe(true);
    const doc = s().history.present;
    expect((doc.variables ?? []).map((v) => v.name)).toEqual(["fit_press", "fit_snug", "fit_sliding", "fit_loose"]);
    const made = doc.features.at(-1)!;
    expect(made.params.diameter).toBe("5 mm + fit_sliding");
    expect(made.hole!.printedFit).toBeUndefined();
    expect(s().history.past.length).toBe(steps + 1);
    // One undo takes both away.
    s().undo();
    expect(s().history.present.variables ?? []).toEqual([]);
    expect(s().history.present.features.some((f) => f.id === made.id)).toBe(false);
  });

  it("leaves the variables alone when cancelled", () => {
    s().startCreate("hole");
    const hole = s().editing!.draft.hole!;
    s().setDraftField({ hole: { ...hole, printedFit: { fit: "snug", nominal: "5 mm", fits: DEFAULT_FITS } } });
    s().cancelDraft();
    expect(s().history.present.variables ?? []).toEqual([]);
  });
});
