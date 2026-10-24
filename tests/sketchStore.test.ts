import { beforeEach, describe, expect, it } from "vitest";

import { emptyDocument, historyOf } from "../src/model/document";
import { useStore } from "../src/model/store";
import { addCircle, addRectangle, curveById, pointPos } from "../src/sketch/ops";
import { linkEdge, projectEdge } from "../src/sketch/links";
import { planeFrame } from "../src/sketch/planes";
import { addText, DEFAULT_TEXT } from "../src/sketch/sketchText";

const s = () => useStore.getState();
const draftData = () => s().editing!.draft.sketch!.data;

beforeEach(() => {
  useStore.setState({ history: historyOf(emptyDocument()), editing: null, sketch: null, selection: [], selectedPlane: null, selectedFeatureId: null });
});

describe("sketch sessions", () => {
  it("asks for a plane, then uses the one picked", () => {
    s().startSketch(null);
    expect(s().sketch).not.toBeNull();
    expect(s().sketch?.message?.text).toMatch(/Top, Front or Right/);
    expect(s().commitDraft()).toBe(false);
    expect(s().sketch?.message?.tone).toBe("error");

    s().setSketchPlane({ kind: "default", name: "Front" });
    expect(s().editing?.draft.sketch?.plane).toEqual({ kind: "default", name: "Front" });
    expect(s().sketch?.message).toBeNull();
  });

  it("keeps text through edits that only know about lines and points, and keeps it selected", () => {
    s().startSketch({ kind: "default", name: "Top" });
    const t = addText(draftData(), { x: 0, y: 0 }, { ...DEFAULT_TEXT, value: "Hi" });
    s().updateSketch(t.sketch, { selection: [t.textId] });
    const bare = { points: draftData().points, curves: draftData().curves, constraints: draftData().constraints };
    s().updateSketch(addRectangle(bare, { x: 20, y: 0 }, { x: 30, y: 10 }).sketch);
    expect(draftData().texts?.map((x) => x.value)).toEqual(["Hi"]);
    expect(draftData().curves).toHaveLength(4);
    expect(s().sketch?.selection).toEqual([t.textId]);
    expect(s().commitDraft()).toBe(true);
  });

  it("starts on the selected plane", () => {
    useStore.setState({ selectedPlane: "Right" });
    s().startCreate("sketch");
    expect(s().editing?.draft.sketch?.plane).toEqual({ kind: "default", name: "Right" });
  });

  it("has its own undo and redo while sketching", () => {
    s().startSketch({ kind: "default", name: "Top" });
    const rect = addRectangle(draftData(), { x: 0, y: 0 }, { x: 10, y: 10 });
    s().updateSketch(rect.sketch);
    const withCircle = addCircle(draftData(), { x: 5, y: 5 }, 2);
    s().updateSketch(withCircle.sketch);
    expect(draftData().curves).toHaveLength(5);

    s().sketchUndo();
    expect(draftData().curves).toHaveLength(4);
    s().sketchUndo();
    expect(draftData().curves).toHaveLength(0);
    s().sketchRedo();
    expect(draftData().curves).toHaveLength(4);

    // Drags don't add a step per frame: one step when they finish.
    const before = draftData();
    s().updateSketch({ ...before, points: before.points.map((p) => ({ ...p, x: p.x + 1 })) }, { record: false });
    s().updateSketch({ ...before, points: before.points.map((p) => ({ ...p, x: p.x + 2 })) }, { record: false });
    s().recordSketchStep(before);
    s().sketchUndo();
    expect(draftData()).toBe(before);
  });

  it("saves the sketch as a feature, and reopens it for editing", () => {
    s().startSketch({ kind: "default", name: "Top" });
    s().updateSketch(addRectangle(draftData(), { x: 0, y: 0 }, { x: 10, y: 10 }).sketch);
    expect(s().commitDraft()).toBe(true);
    expect(s().sketch).toBeNull();
    const saved = s().history.present.features[0];
    expect(saved.type).toBe("sketch");
    expect(saved.sketch?.data.curves).toHaveLength(4);

    s().startEdit(saved.id);
    expect(s().sketch).not.toBeNull();
    s().cancelDraft();
    expect(s().sketch).toBeNull();

    // Extrude picks the latest sketch, and adds to existing solids.
    s().startCreate("extrude");
    expect(s().editing?.draft.sketchRef).toBe(saved.id);
    expect(s().editing?.draft.operation).toBe("new");
  });
});

describe("sketches that follow the part", () => {
  it("closing a sketch tidies away references nothing uses", () => {
    s().startSketch({ kind: "default", name: "Top" });
    const edge = projectEdge(planeFrame({ kind: "default", name: "Top" }), { partId: "box", ref: { kind: "edge", curve: "LINE", a: [0, 0, 0], b: [10, 0, 0], mid: [5, 0, 0] } })!;
    s().updateSketch(addCircle(linkEdge(draftData(), edge, true).sketch, { x: 5, y: 5 }, 2).sketch);
    expect(draftData().curves).toHaveLength(2);
    expect(s().commitDraft()).toBe(true);
    const saved = s().history.present.features.find((f) => f.type === "sketch");
    expect(saved?.sketch?.data.curves.map((c) => c.type)).toEqual(["circle"]);
  });

  it("the open sketch moves its linked edges and plane to where the rebuild found them", () => {
    const face = { partId: "box", ref: { kind: "face" as const, surface: "PLANE", center: [20, 10, 10] as [number, number, number], normal: [0, 0, 1] as [number, number, number] } };
    const plane = { kind: "face" as const, origin: [0, 0, 10] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number], label: "Face of Part 1", face };
    s().startSketch(plane);
    const edge = (x: number) => projectEdge(planeFrame(plane), { partId: "box", ref: { kind: "edge", curve: "LINE", a: [x, 0, 10], b: [x, 20, 10], mid: [x, 10, 10] } })!;
    const used = linkEdge(draftData(), edge(40), true);
    s().updateSketch(used.sketch);
    const id = s().editing!.draft.id;
    const moved = { ...plane, origin: [0, 0, 15] as [number, number, number] };
    s().setRebuildResult(s().parts, {}, 1, undefined, undefined, { [id]: { edges: [edge(60)], links: { [used.curveId]: edge(60) }, plane: moved } });
    const line = curveById(draftData(), used.curveId);
    expect(line?.type === "line" ? pointPos(draftData(), line.p1)[0] : NaN).toBeCloseTo(60, 6);
    expect(s().editing?.draft.sketch?.plane).toEqual(moved);
    expect(s().sketchLinks[id].edges).toHaveLength(1);
    // A second result with nothing new changes nothing (no rebuild loop), even with a plane a hair's breadth away.
    const before = s().editing;
    s().setRebuildResult(s().parts, {}, 1, undefined, undefined, { [id]: { edges: [edge(60)], links: { [used.curveId]: edge(60) } } });
    expect(s().editing).toBe(before);
    const hair = { ...moved, origin: [0, 0, 15.00004] as [number, number, number] };
    s().setRebuildResult(s().parts, {}, 1, undefined, undefined, { [id]: { edges: [edge(60)], links: { [used.curveId]: edge(60) }, plane: hair } });
    expect(s().editing).toBe(before);
  });
});
