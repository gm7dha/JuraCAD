/**
 * Fillet/Chamfer picking (Onshape's): while edges are clicked the Part Studio is shown as before the feature, so a
 * picked edge can be clicked again (to take it off, or for a variable fillet's radius point); typing a size or
 * "Done" shows the result; a click on what the result made goes back to picking.
 */
import { describe, expect, it } from "vitest";

import { emptyDocument, historyOf, pickingPreview, picksPartsBefore, withoutPicking } from "../src/model/document";
import { madeByOpenFeature, showingResult, withStartPicking } from "../src/model/edgePicking";
import { useStore } from "../src/model/store";
import type { Feature } from "../src/model/types";

const s = () => useStore.getState();
const feat = (id: string, type: Feature["type"], extra: Partial<Feature> = {}): Feature => ({ id, name: id, type, operation: "new", suppressed: false, params: {}, ...extra });
const edgePick = { partId: "b", ref: { kind: "edge" as const, curve: "LINE", mid: [0, 15, 20] as [number, number, number], a: [-20, 15, 20] as [number, number, number], b: [20, 15, 20] as [number, number, number] } };

describe("picking a fillet's edges on the part as it was", () => {
  it("starts picking when nothing is picked; shows the result once asked; never saved", () => {
    const f = feat("f", "fillet", { picks: [] });
    const picking = withStartPicking(f);
    expect(picking.edgesPicking).toBe(true);
    expect(picksPartsBefore(picking)).toBe(true);
    expect(picksPartsBefore(feat("c", "chamfer", { edgesPicking: true }))).toBe(true);
    expect(picksPartsBefore(f)).toBe(false);
    const list = [feat("b", "box"), picking, feat("later", "fillet")];
    expect(pickingPreview(list, picking).map((x) => x.id)).toEqual(["b"]);
    expect(withStartPicking({ ...f, picks: [edgePick as never] }).edgesPicking).toBeUndefined();
    expect(withStartPicking(feat("s", "shell", { picks: [] })).edgesPicking).toBeUndefined();
    expect("edgesPicking" in showingResult(picking)).toBe(false);
    expect(showingResult(f)).toBe(f);
    expect("edgesPicking" in withoutPicking(picking)).toBe(false);
  });

  it("knows what the result itself made: its round faces and the edges round them", () => {
    // Face 0 made by the fillet, face 1 by the box; edge 0 lies on face 0, edge 1 only on face 1.
    const mesh = {
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 0, 6, 5, 0, 5, 6, 0]),
      triangles: new Uint32Array([0, 1, 2, 3, 4, 5]),
      faceGroups: [{ start: 0, count: 3 }, { start: 3, count: 3 }],
      lines: new Float32Array([0, 0, 0, 1, 0, 0, 5, 5, 0, 6, 5, 0]),
      edgeGroups: [{ start: 0, count: 2 }, { start: 2, count: 2 }],
      faceMakers: ["fil", "box"],
    };
    expect(madeByOpenFeature(mesh, { kind: "face", index: 0 }, "fil")).toBe(true);
    expect(madeByOpenFeature(mesh, { kind: "face", index: 1 }, "fil")).toBe(false);
    expect(madeByOpenFeature(mesh, { kind: "edge", index: 0 }, "fil")).toBe(true);
    expect(madeByOpenFeature(mesh, { kind: "edge", index: 1 }, "fil")).toBe(false);
    expect(madeByOpenFeature({ ...mesh, faceMakers: undefined }, { kind: "face", index: 0 }, "fil")).toBe(false);
  });

  it("in the app: a new Fillet picks on the part as it was; typing the radius shows the result; Accept saves no flag", () => {
    useStore.setState({ history: historyOf({ ...emptyDocument("T"), features: [feat("b", "box", { params: { width: "40", depth: "30", height: "20" } })] }), editing: null, sketch: null, parts: [], selection: [], selectedParts: [], selectedPlane: null, selectedFeatureId: null, rollbackTo: null, areaSelection: null, sketchLinks: {} });
    s().startCreate("fillet");
    expect(s().editing!.draft.edgesPicking).toBe(true);
    s().toggleDraftPick(edgePick as never);
    // Picking the same edge again takes it off (it's there to click: the part is shown as it was).
    s().toggleDraftPick(edgePick as never);
    expect(s().editing!.draft.picks).toEqual([]);
    s().toggleDraftPick(edgePick as never);
    expect(s().editing!.draft.edgesPicking).toBe(true);
    s().setDraftParam("radius", "3");
    expect(s().editing!.draft.edgesPicking).toBeUndefined();
    s().setDraftField({ edgesPicking: true });
    expect(s().editing!.draft.edgesPicking).toBe(true);
    s().commitDraft();
    const saved = s().history.present.features.find((f) => f.type === "fillet")!;
    expect(saved.picks).toHaveLength(1);
    expect("edgesPicking" in saved && saved.edgesPicking !== undefined).toBe(false);
  });
});
