import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { keepsSteps, useStore } from "../src/model/store";

const s = () => useStore.getState();

beforeEach(() => {
  useStore.setState({ history: historyOf(emptyDocument()), editing: null, selection: [], selectedPlane: null, selectedFeatureId: null, draftSteps: null, transformLive: null });
});

describe("a manipulator drag in a feature dialog", () => {
  it("changes the draft live, and letting go is one step of the dialog's undo", () => {
    s().startCreate("box");
    expect(s().commitDraft()).toBe(true);
    s().startCreate("shell");
    const before = s().editing!.draft;
    expect(keepsSteps(before)).toBe(true);
    s().dragDraft({ params: { thickness: "3" } });
    s().dragDraft({ params: { thickness: "4" } });
    expect(s().editing!.draft.params.thickness).toBe("4");
    // Not a step until it's let go.
    expect(s().draftSteps?.drafts.length ?? 0).toBe(0);
    s().endDraftDrag(before);
    expect(s().draftSteps!.drafts.length).toBe(1);
    expect(s().undoDraftStep()).toBe(true);
    expect(s().editing!.draft.params.thickness).toBe(before.params.thickness);
    expect(s().undoDraftStep()).toBe(false);
  });

  it("taken back (Esc) puts the draft back as it was, with no step", () => {
    s().startCreate("box");
    expect(s().commitDraft()).toBe(true);
    s().startCreate("shell");
    const before = s().editing!.draft;
    s().dragDraft({ params: { thickness: "7" } });
    s().endDraftDrag(before, true);
    expect(s().editing!.draft).toBe(before);
    expect(s().draftSteps?.drafts.length ?? 0).toBe(0);
    // A drag that changed nothing is no step either.
    s().endDraftDrag(s().editing!.draft);
    expect(s().draftSteps?.drafts.length ?? 0).toBe(0);
  });

  it("typing and toggles in these dialogs are steps too, so Ctrl+Z goes back in order", () => {
    s().startCreate("box");
    expect(s().commitDraft()).toBe(true);
    s().startCreate("shell");
    const before = s().editing!.draft;
    s().dragDraft({ params: { thickness: "5" } });
    s().endDraftDrag(before);
    s().setDraftParam("thickness", "6");
    s().setDraftParam("thickness", "6.5");
    expect(s().undoDraftStep()).toBe(true);
    expect(s().editing!.draft.params.thickness).toBe("5");
    expect(s().undoDraftStep()).toBe(true);
    expect(s().editing!.draft.params.thickness).toBe(before.params.thickness);
    // A box's dialog keeps no undo of its own (Ctrl+Z there is left alone, as before).
    s().cancelDraft();
    s().startCreate("box");
    s().setDraftParam("width", "40");
    expect(keepsSteps(s().editing!.draft)).toBe(false);
    expect(s().undoDraftStep()).toBe(false);
  });

  it("a drag past zero can flip the extrude (fields change with the size), undone together", () => {
    s().startCreate("box");
    expect(s().commitDraft()).toBe(true);
    s().startCreate("shell");
    const before = s().editing!.draft;
    s().dragDraft({ params: { thickness: "2" }, fields: { flipSide: true } });
    expect(s().editing!.draft.flipSide).toBe(true);
    s().endDraftDrag(before);
    s().undoDraftStep();
    expect(s().editing!.draft.flipSide).toBe(before.flipSide);
  });
});
