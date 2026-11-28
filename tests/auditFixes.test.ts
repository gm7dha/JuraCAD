/**
 * Fixes from the second hands-on audit: the first solid after a Plane or mate connector is New; a new Extrude/Revolve
 * doesn't start on a used-up sketch.
 */
import { describe, expect, it } from "vitest";

import { createFeature, emptyDocument, hasPartBefore, historyOf } from "../src/model/document";
import { useStore } from "../src/model/store";
import type { Feature, JuraCADDocument } from "../src/model/types";
import { sketchToExtrude, sketchUsedUp } from "../src/sketch/areaClicks";
import { addCircle, addLine, addRectangle, relationsFor, toggleConstruction } from "../src/sketch/ops";
import { linkEdge } from "../src/sketch/links";
import { planeRefs } from "../src/sketch/planeRefs";
import { planeFrame } from "../src/sketch/planes";
import { sketchMenuItems } from "../src/sketch/sketchMenu";
import { emptySketch } from "../src/sketch/types";

const s = () => useStore.getState();
const feat = (id: string, type: Feature["type"], extra: Partial<Feature> = {}): Feature => ({ id, name: id, type, operation: "new", suppressed: false, params: {}, ...extra });
const docOf = (features: Feature[]): JuraCADDocument => ({ ...emptyDocument("T"), features });
const twoCircles = () => {
  const a = addCircle(emptySketch(), { x: 0, y: 0 }, 5).sketch;
  return addCircle(a, { x: 30, y: 0 }, 5).sketch;
};
const sketch = (id: string, data = addCircle(emptySketch(), { x: 0, y: 0 }, 5).sketch): Feature => feat(id, "sketch", { sketch: { plane: { kind: "default", name: "Top" }, data } });
const reset = (features: Feature[], extra: Record<string, unknown> = {}) =>
  useStore.setState({ history: historyOf(docOf(features)), editing: null, sketch: null, parts: [], selection: [], selectedParts: [], selectedPlane: null, selectedFeatureId: null, rollbackTo: null, areaSelection: null, sketchLinks: {}, ...extra });

describe("the first solid after planes and mate connectors", () => {
  it("is New: planes, connectors, sketches and curves make no part", () => {
    const datums = [feat("p", "plane", { planeDef: { mode: "offset", ref: { kind: "default", name: "Top" }, axis: "u" } }), feat("m", "mateConnector"), sketch("sk"), feat("c", "curve"), feat("v", "variable")];
    expect(hasPartBefore(datums)).toBe(false);
    for (const type of ["extrude", "revolve", "sweep", "loft", "text"] as const) expect(createFeature(docOf(datums), type).operation).toBe("new");
    const withBox = [feat("b", "box"), ...datums];
    expect(hasPartBefore(withBox)).toBe(true);
    expect(createFeature(docOf(withBox), "extrude").operation).toBe("add");
    expect(createFeature(docOf(withBox), "loft").operation).toBe("add");
    // A suppressed part doesn't count.
    expect(hasPartBefore([{ ...feat("b", "box"), suppressed: true }, ...datums])).toBe(false);
  });
});

describe("a new Extrude's sketch", () => {
  it("skips sketches whose closed shapes are all used, and keeps one with shapes left", () => {
    const one = sketch("s1");
    const used = feat("e1", "extrude", { sketchRef: "s1", apart: true });
    const list = [one, used];
    const usedIds = new Set(["s1"]);
    expect(sketchUsedUp(list, "s1", one.sketch!.data, usedIds)).toBe(true);
    expect(sketchToExtrude(list, usedIds, (f) => f.sketch?.data)).toBeUndefined();
    // A sketch of two circles with one extruded: one left.
    const two = sketch("s2", twoCircles());
    const half = feat("e2", "extrude", { sketchRef: "s2", areas: [[0, 0]] });
    expect(sketchUsedUp([two, half], "s2", two.sketch!.data, new Set(["s2"]))).toBe(false);
    expect(sketchToExtrude([two, half], new Set(["s2"]), (f) => f.sketch?.data)).toBe("s2");
    // An older unused sketch is still offered before nothing.
    const fresh = sketch("s0", addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 10, y: 10 }).sketch);
    expect(sketchToExtrude([fresh, one, used], usedIds, (f) => f.sketch?.data)).toBe("s0");
    // A thin wall doesn't use the space inside.
    expect(sketchUsedUp([one, { ...used, thin: { midPlane: true } }], "s1", one.sketch!.data, usedIds)).toBe(false);
  });

  it("in the app: none when the only sketch is used up, the highlighted one when picked, the fresh one otherwise", () => {
    const one = sketch("s1");
    const used = feat("e1", "extrude", { sketchRef: "s1", apart: true, extrude: { end: "blind", flip: false }, params: { depth: "5" } });
    reset([one, used]);
    s().startCreate("extrude");
    expect(s().editing!.draft.sketchRef).toBeUndefined();
    expect(s().editing!.draft.operation).toBe("add");
    s().cancelDraft();
    reset([one, used], { selectedFeatureId: "s1" });
    s().startCreate("extrude");
    expect(s().editing!.draft.sketchRef).toBe("s1");
    s().cancelDraft();
    reset([one, used, sketch("s2")]);
    s().startCreate("revolve");
    expect(s().editing!.draft.sketchRef).toBe("s2");
    s().cancelDraft();
  });
});

describe("a plane's line brought into a sketch", () => {
  const ctx = { busy: false, canPaste: false, showConstraints: true, showDimensions: true, under: 1 };
  it("can't be made solid, and has no relations of its own; with a line of the sketch the usual ones are offered", () => {
    const front = planeRefs(planeFrame({ kind: "default", name: "Top" }))[0];
    const brought = linkEdge(emptySketch(), front, true);
    const id = brought.curveId;
    const menu = sketchMenuItems(brought.sketch, [id], ctx);
    expect(menu.some((m) => m.action.kind === "construction")).toBe(false);
    expect(menu.some((m) => m.action.kind === "relation")).toBe(false);
    expect(menu.some((m) => m.action.kind === "copy" || m.action.kind === "delete")).toBe(false);
    expect(relationsFor(brought.sketch, [id])).toEqual([]);
    // Q leaves it construction.
    const after = toggleConstruction(brought.sketch, [id]);
    expect(after.curves.find((c) => c.id === id)!.construction).toBe(true);
    // A line of its own picked with it: Parallel is offered; Q changes only the sketch's own line.
    const line = addLine(brought.sketch, { x: 0, y: 10 }, { x: 20, y: 15 });
    const lineId = line.sketch.curves.at(-1)!.id;
    expect(relationsFor(line.sketch, [id, lineId])).toContain("parallel");
    const both = toggleConstruction(line.sketch, [id, lineId]);
    expect(both.curves.find((c) => c.id === id)!.construction).toBe(true);
    expect(both.curves.find((c) => c.id === lineId)!.construction).toBe(true);
    expect(sketchMenuItems(line.sketch, [id, lineId], ctx).find((m) => m.action.kind === "construction")!.label).toBe("Make it construction");
  });
});

describe("small things", () => {
  it("names JuraCAD's own swatch colours in the 3MF's filament list", async () => {
    const { filamentsNote } = await import("../src/model/faceColours");
    expect(filamentsNote([{ colour: "#ef8a2f" }, { colour: "#123456" }])).toBe("2 filaments, load them in this order: 1 orange (any orange filament), 2 your own colour #123456.");
  });

  it("a sketch's message goes with an undo or redo", () => {
    const sk = sketch("s1", emptySketch());
    reset([sk]);
    s().startEdit("s1");
    const before = s().editing!.draft.sketch!.data;
    s().updateSketch(addCircle(before, { x: 0, y: 0 }, 5).sketch, { record: true });
    s().setSketchMessage("Pattern changed.", "info");
    s().sketchUndo();
    expect(s().sketch!.message).toBeNull();
    s().setSketchMessage("Pattern changed.", "info");
    s().sketchRedo();
    expect(s().sketch!.message).toBeNull();
    s().cancelDraft();
  });
});

describe("Accept waits for an Extrude's sketch; a Sweep's profile isn't used up", () => {
  it("says what to click when there's no sketch, and starts a Sweep on a fresh closed shape", async () => {
    const { missingPick } = await import("../src/model/draftReady");
    expect(missingPick(feat("e", "extrude"))).toMatch(/Click the areas to extrude/);
    expect(missingPick(feat("e", "revolve", { sketchRef: "s" }))).toBeNull();
    expect(missingPick(feat("w", "sweep"))).toMatch(/area to sweep/);
    expect(missingPick(feat("w", "sweep", { sweepControl: { face: { partId: "p", ref: { kind: "face", surface: "PLANE", center: [0, 0, 0], normal: [0, 0, 1] } } } as never }))).toBeNull();
    // Profile used up by an extrude, a path of open lines after it: no profile, the path kept.
    const prof = sketch("prof");
    const used = feat("e1", "extrude", { sketchRef: "prof", apart: true, extrude: { end: "blind", flip: false }, params: { depth: "5" } });
    const path = sketch("path", addLine(emptySketch(), { x: 0, y: 0 }, { x: 0, y: 30 }).sketch);
    reset([prof, used, path]);
    s().startCreate("sweep");
    expect(s().editing!.draft.sketchRef).toBeUndefined();
    expect(s().editing!.draft.pathRef).toBe("path");
    s().cancelDraft();
    // A fresh circle before the path: it's the profile.
    const fresh = sketch("fresh");
    reset([prof, used, fresh, path]);
    s().startCreate("sweep");
    expect(s().editing!.draft.sketchRef).toBe("fresh");
    expect(s().editing!.draft.pathRef).toBe("path");
    s().cancelDraft();
  });
});
