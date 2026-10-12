import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { useStore } from "../src/model/store";

const s = () => useStore.getState();

/** Create a box and return its id. */
function addBox(): string {
  s().startCreate("box");
  expect(s().commitDraft()).toBe(true);
  return s().history.present.features.at(-1)!.id;
}

function editX(id: string, x: string) {
  s().startEdit(id);
  s().setDraftParam("x", x);
  expect(s().commitDraft()).toBe(true);
}

const xOf = (id: string) => s().history.present.features.find((f) => f.id === id)?.params.x;

beforeEach(() => {
  useStore.setState({
    history: historyOf(emptyDocument()),
    editing: null,
    selection: [],
    selectedPlane: null,
    hiddenDatums: [],
    selectedFeatureId: null,
  });
});

describe("undo and redo", () => {
  it("steps back exactly one change at a time", () => {
    const id = addBox();
    editX(id, "10");
    editX(id, "20");
    editX(id, "30");
    s().undo();
    expect(xOf(id)).toBe("20");
    s().undo();
    expect(xOf(id)).toBe("10");
    s().redo();
    expect(xOf(id)).toBe("20");
  });

  it("doesn't record a step when a dialog is accepted without changes", () => {
    const id = addBox();
    editX(id, "10");
    const steps = s().history.past.length;
    s().startEdit(id);
    s().commitDraft();
    expect(s().history.past.length).toBe(steps);
    s().undo();
    expect(xOf(id)).toBe("0");
  });

  it("does nothing while a feature dialog is open", () => {
    const id = addBox();
    editX(id, "10");
    s().startEdit(id);
    s().setDraftParam("x", "99");
    s().undo();
    expect(xOf(id)).toBe("10");
    expect(s().editing?.draft.params.x).toBe("99");
  });
});

describe("default planes", () => {
  it("selects one plane at a time, clearing face selection", () => {
    useStore.setState({ selection: [{ partId: "p", kind: "face", index: 0 }] });
    s().selectPlane("Top");
    expect(s().selectedPlane).toBe("Top");
    expect(s().selection).toEqual([]);
    s().setSelection([{ partId: "p", kind: "edge", index: 2 }]);
    expect(s().selectedPlane).toBeNull();
  });

  it("hides and shows planes, deselecting a hidden plane", () => {
    s().selectPlane("Front");
    s().toggleDatum("Front");
    expect(s().hiddenDatums).toEqual(["Front"]);
    expect(s().selectedPlane).toBeNull();
    s().toggleDatum("Front");
    expect(s().hiddenDatums).toEqual([]);
    s().toggleDatum("Origin");
    expect(s().hiddenDatums).toEqual(["Origin"]);
  });
});
