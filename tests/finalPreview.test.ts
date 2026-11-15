import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, featuresToBuild, historyOf } from "../src/model/document";
import { editRollback, finalChoice } from "../src/model/finalPreview";
import { shownRollback, useStore } from "../src/model/store";
import type { Feature } from "../src/model/types";
import { emptySketch } from "../src/sketch/types";

const feat = (id: string, type: Feature["type"], extra: Partial<Feature> = {}): Feature => ({ id, name: id, type, operation: "new", suppressed: false, params: {}, ...extra });
const features: Feature[] = [
  feat("s1", "sketch", { sketch: { plane: { kind: "default", name: "Top" }, data: emptySketch() } }),
  feat("e1", "extrude", { sketchRef: "s1", params: { depth: "10" } }),
  feat("f1", "fillet"),
  feat("b1", "box"),
];
const edit = (id: string) => ({ mode: "edit" as const, draft: features.find((f) => f.id === id)! });

describe("Onshape's Final tick (pure)", () => {
  it("rolls back to just after the feature being edited, unless Final is ticked", () => {
    expect(editRollback(features, edit("e1"), null, false)).toBe("e1");
    expect(editRollback(features, edit("e1"), null, true)).toBeNull();
    expect(featuresToBuild(features, edit("e1").draft, "e1").map((f) => f.id)).toEqual(["s1", "e1"]);
  });

  it("changes nothing for a new feature, a sketch, nothing open, or the last feature", () => {
    expect(editRollback(features, null, null, false)).toBeNull();
    expect(editRollback(features, { mode: "create", draft: feat("x", "fillet") }, null, false)).toBeNull();
    expect(editRollback(features, edit("s1"), null, false)).toBeNull();
    expect(editRollback(features, edit("b1"), null, false)).toBeNull();
    expect(finalChoice(features, edit("b1"), null)).toBe(false);
    expect(finalChoice(features, edit("e1"), null)).toBe(true);
  });

  it("keeps a rollback bar already above (or at) the feature, and stops at one below it", () => {
    expect(editRollback(features, edit("f1"), "e1", false)).toBe("e1");
    expect(editRollback(features, edit("e1"), "e1", false)).toBe("e1");
    expect(finalChoice(features, edit("e1"), "e1")).toBe(false);
    expect(editRollback(features, edit("e1"), "f1", false)).toBe("e1");
    expect(editRollback(features, edit("e1"), "f1", true)).toBe("f1");
  });

  it("isn't offered when everything after the feature is suppressed (nothing would change)", () => {
    const off = features.map((f) => (f.id === "f1" || f.id === "b1" ? { ...f, suppressed: true } : f));
    expect(finalChoice(off, edit("e1"), null)).toBe(false);
    expect(editRollback(off, edit("e1"), null, false)).toBeNull();
  });
});

describe("the Final tick in the store", () => {
  const s = () => useStore.getState();
  beforeEach(() => {
    useStore.setState({ history: historyOf({ ...emptyDocument(), features }), editing: null, sketch: null, selection: [], selectedFeatureId: null, rollbackTo: null, showFinal: false });
  });

  it("starts unticked, shows the rolled-back studio while editing, and comes back whole when the dialog closes", () => {
    expect(s().showFinal).toBe(false);
    s().startEdit("e1");
    expect(shownRollback(s())).toBe("e1");
    s().setShowFinal(true);
    expect(shownRollback(s())).toBeNull();
    s().setShowFinal(false);
    s().cancelDraft();
    expect(shownRollback(s())).toBeNull();
    expect(s().rollbackTo).toBeNull();
  });

  it("is remembered for the next edit (this session) and never goes into the design", () => {
    s().startEdit("e1");
    s().setShowFinal(true);
    s().cancelDraft();
    s().startEdit("f1");
    expect(s().showFinal).toBe(true);
    expect(shownRollback(s())).toBeNull();
    expect(JSON.stringify(s().history.present)).not.toContain("showFinal");
  });

  it("doesn't move the rollback bar, and a new feature still goes in at it", () => {
    s().setRollback("e1");
    s().startCreate("fillet");
    expect(shownRollback(s())).toBe("e1");
  });
});
