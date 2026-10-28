import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { activeHiddenDatums, useStore } from "../src/model/store";

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

  it("hides and shows planes, deselecting a hidden plane (saved in the design, undoable)", () => {
    s().selectPlane("Front");
    s().toggleDatum("Front");
    expect(activeHiddenDatums(s())).toEqual(["Front"]);
    expect(s().history.present.hiddenDatums).toEqual(["Front"]);
    expect(s().selectedPlane).toBeNull();
    s().toggleDatum("Front");
    expect(activeHiddenDatums(s())).toEqual([]);
    expect(s().history.present.hiddenDatums).toBeUndefined();
    s().toggleDatum("Origin");
    expect(activeHiddenDatums(s())).toEqual(["Origin"]);
    s().undo();
    expect(activeHiddenDatums(s())).toEqual([]);
  });

  it("shows and hides sketches and planes with the eye, and all sketches at once", () => {
    s().startCreate("sketch");
    s().setSketchPlane({ kind: "default", name: "Top" });
    expect(s().commitDraft()).toBe(true);
    const sketch = s().history.present.features.at(-1)!.id;
    s().setFeaturesVisible([sketch], false);
    expect(s().history.present.features.find((f) => f.id === sketch)!.visible).toBe(false);
    s().setAllSketchesVisible(true);
    expect(s().history.present.features.find((f) => f.id === sketch)!.visible).toBe(true);
    s().undo();
    expect(s().history.present.features.find((f) => f.id === sketch)!.visible).toBe(false);
  });
});

describe("fillet picks", () => {
  const edge = (x: number) => ({ kind: "edge" as const, curve: "LINE", a: [x, 0, 0] as [number, number, number], b: [x, 10, 0] as [number, number, number], mid: [x, 5, 0] as [number, number, number] });
  const part = {
    id: "p1",
    name: "Part 1",
    featureIds: ["p1"],
    vertices: new Float32Array(),
    normals: new Float32Array(),
    triangles: new Uint32Array(),
    faceGroups: [],
    lines: new Float32Array(),
    edgeGroups: [],
    faceRefs: [],
    edgeRefs: [edge(0), edge(10)],
  };

  it("starts with the selected edges, and clicking toggles them", () => {
    useStore.setState({ parts: [part], selection: [{ partId: "p1", kind: "edge", index: 1 }] });
    s().startCreate("fillet");
    expect(s().editing?.draft.picks).toEqual([{ partId: "p1", ref: edge(10) }]);
    expect(s().selection).toEqual([]);

    s().toggleDraftPick({ partId: "p1", ref: edge(0) });
    expect(s().editing?.draft.picks).toHaveLength(2);
    s().toggleDraftPick({ partId: "p1", ref: edge(10) });
    expect(s().editing?.draft.picks).toEqual([{ partId: "p1", ref: edge(0) }]);

    expect(s().commitDraft()).toBe(true);
    const saved = s().history.present.features.at(-1)!;
    expect(saved.type).toBe("fillet");
    expect(saved.picks).toHaveLength(1);
  });
});

describe("merging parts", () => {
  it("adds one Boolean join feature with the selected parts", async () => {
    const { activeFeatures } = await import("../src/model/store");
    useStore.getState().newDocument();
    useStore.setState({
      parts: [
        { id: "a", name: "Part 1" },
        { id: "b", name: "Part 2" },
      ] as never,
    });
    const before = activeFeatures(useStore.getState()).length;
    useStore.getState().mergeParts(["a", "b"]);
    const features = activeFeatures(useStore.getState());
    expect(features.length).toBe(before + 1);
    const f = features[features.length - 1];
    expect(f.type).toBe("boolean");
    expect(f.booleanDef?.op).toBe("union");
    expect(f.booleanDef?.targets).toEqual(["a", "b"]);
  });
});

describe("assembly patterns", () => {
  it("repeats the selected parts, changes and deletes the pattern", () => {
    s().addAssembly();
    const part = { id: "p1", name: "Bolt" };
    s().insertInstance(part);
    s().insertInstance(part);
    const asm = () => s().history.present.assemblies![0];
    const bolt = asm().instances[1];
    s().setAsmSelection([bolt.id]);
    s().createPattern();
    const p = asm().patterns![0];
    expect(s().editingPattern).toBe(p.id);
    expect(asm().instances.filter((i) => i.copyOf?.seed === bolt.id)).toHaveLength(2);
    s().updatePattern(p.id, { count: 5 });
    expect(asm().instances).toHaveLength(6);
    s().undo();
    expect(asm().instances).toHaveLength(4);
    s().deletePattern(p.id);
    expect(asm().instances).toHaveLength(2);
    expect(asm().patterns).toBe(undefined);
    expect(s().editingPattern).toBe(null);
  });
});

describe("configurations", () => {
  it("switches between saved versions, one undo step each", () => {
    s().setVariables([{ id: "v1", name: "w", value: "20" }]);
    s().addConfiguration("Large");
    s().setVariables([{ id: "v1", name: "w", value: "40" }]);
    const doc = () => s().history.present;
    const def = doc().configurations![0];
    s().switchConfiguration(def.id);
    expect(doc().variables![0].value).toBe("20");
    s().undo();
    expect(doc().variables![0].value).toBe("40");
    s().removeConfiguration(def.id);
    expect(doc().configurations).toBe(undefined);
  });
});

describe("new plane from a standard plane", () => {
  it("starts offset from the plane selected in the list", () => {
    s().selectPlane("Front");
    s().startCreate("plane");
    expect(s().editing?.draft.planeDef?.ref).toEqual({ kind: "default", name: "Front" });
    s().cancelDraft();
    s().selectPlane(null);
    s().startCreate("plane");
    expect(s().editing?.draft.planeDef?.ref).toEqual({ kind: "default", name: "Top" });
  });
});
