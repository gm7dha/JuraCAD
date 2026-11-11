/**
 * Pattern types (Part / Feature / Face), face mirrors and Composite part,
 * without geometry: files read back what was saved (and old files exactly as
 * before), and Delete with dependents knows what they use.
 */
import { describe, expect, it } from "vitest";
import { findDependents, withoutGone } from "../src/model/dependents";
import { createFeature, emptyDocument, historyOf, madeByDraft, parseDocument, pickingPreview, picksPartsBefore } from "../src/model/document";
import { buildCheckReport } from "../src/model/checkReport";
import { useStore } from "../src/model/store";
import type { PartMesh } from "../src/kernel/protocol";
import { compositeProblem } from "../src/model/composite";
import type { Feature, JuraCADDocument } from "../src/model/types";
import type { TopoPick } from "../src/geometry/topoRef";

function feat(id: string, type: Feature["type"], extra: Partial<Feature> = {}): Feature {
  return { id, name: id, type, operation: "new", suppressed: false, params: {}, ...extra };
}
const face = (partId: string): TopoPick => ({ partId, ref: { kind: "face", surface: "PLANE", center: [0, 0, 0], normal: [0, 0, 1] } });
const docOf = (features: Feature[]): JuraCADDocument => ({ ...emptyDocument("T"), features });
const roundTrip = (d: JuraCADDocument) => parseDocument(JSON.parse(JSON.stringify(d)))!;

describe("saving and opening", () => {
  it("keeps a part pattern's parts, a face pattern's faces, a face mirror and a composite's parts", () => {
    const pp = feat("p1", "linearPattern", { operation: "add", pattern: { sources: [], axis: "x", flip: false, of: "part", parts: ["a", "b~2"] } });
    const fp = feat("p2", "circularPattern", { operation: "add", pattern: { sources: [], axis: "z", flip: false, of: "face" }, picks: [face("a")] });
    const fm = feat("m1", "mirror", { operation: "add", mirror: { sources: [], plane: { kind: "default", name: "Right" }, of: "face" }, picks: [face("a")] });
    const cp = feat("c1", "composite", { compositeParts: ["a", "b"] });
    const back = roundTrip(docOf([feat("a", "box"), feat("b", "box"), pp, fp, fm, cp]));
    const by = (id: string) => back.features.find((f) => f.id === id)!;
    expect(by("p1").pattern).toEqual(pp.pattern);
    expect(by("p2").pattern?.of).toBe("face");
    expect(by("p2").picks).toHaveLength(1);
    expect(by("m1").mirror?.of).toBe("face");
    expect(by("m1").picks).toHaveLength(1);
    expect(by("c1").compositeParts).toEqual(["a", "b"]);
  });

  it("opens an old pattern and mirror exactly as before (no new fields)", () => {
    const old = feat("p", "linearPattern", { operation: "add", pattern: { sources: ["a"], axis: "x", flip: false } });
    const oldMirror = feat("m", "mirror", { operation: "add", mirror: { sources: ["a"], plane: { kind: "default", name: "Right" } } });
    const back = roundTrip(docOf([feat("a", "box"), old, oldMirror]));
    expect(back.features[1]).toEqual({ ...old, params: back.features[1].params });
    expect(back.features[1].picks).toBeUndefined();
    expect(back.features[2].mirror).toEqual(oldMirror.mirror);
    expect(JSON.stringify(roundTrip(back))).toBe(JSON.stringify(back));
  });

  it("starts a composite part with no parts", () => {
    expect(createFeature(emptyDocument(), "composite").compositeParts).toEqual([]);
  });
});

describe("delete with dependents", () => {
  it("knows a part pattern and a composite use their parts", () => {
    const features = [
      feat("a", "box"),
      feat("b", "box"),
      feat("p", "linearPattern", { operation: "add", pattern: { sources: [], axis: "x", flip: false, of: "part", parts: ["a"] } }),
      feat("c", "composite", { compositeParts: ["a", "b"] }),
    ];
    // The composite would be left with one part: it goes too (as a Boolean union does).
    const d = findDependents(features, ["a"]);
    expect(d.dependents).toEqual(["p", "c"]);
    // With three parts, it keeps the two left.
    const three = [feat("a", "box"), feat("b", "box"), feat("x", "box"), feat("c", "composite", { compositeParts: ["a", "b", "x"] })];
    expect(findDependents(three, ["a"]).partial.map((x) => x.id)).toEqual(["c"]);
    expect(withoutGone(three[3], new Set(["a"])).compositeParts).toEqual(["b", "x"]);
    // A face pattern goes with the part its faces are on.
    const fp = feat("f", "linearPattern", { operation: "add", pattern: { sources: [], axis: "x", flip: false, of: "face" }, picks: [face("b")] });
    expect(findDependents([...features.slice(0, 2), fp], ["b"]).dependents).toEqual(["f"]);
    // A part pattern of two parts keeps the one left.
    const two = feat("q", "linearPattern", { operation: "add", pattern: { sources: [], axis: "x", flip: false, of: "part", parts: ["a", "b"] } });
    expect(findDependents([...features.slice(0, 2), two], ["a"]).partial.map((x) => x.id)).toEqual(["q"]);
    expect(withoutGone(two, new Set(["a"])).pattern?.parts).toEqual(["b"]);
  });
});

describe("picking parts and faces shows the parts as they were before", () => {
  const box = feat("a", "box");
  const later = feat("z", "box");
  it("leaves the open feature (and what follows) out while its parts or faces box is picking", () => {
    const pp = feat("p", "linearPattern", { operation: "add", pattern: { sources: [], axis: "x", flip: false, of: "part", parts: [], picking: "items" } });
    expect(picksPartsBefore(pp)).toBe(true);
    expect(pickingPreview([box, pp, later], pp)).toEqual([box]);
    const notPicking = { ...pp, pattern: { ...pp.pattern!, picking: undefined } };
    expect(picksPartsBefore(notPicking)).toBe(false);
    expect(pickingPreview([box, notPicking], notPicking)).toEqual([box, notPicking]);
    const comp = feat("c", "composite", { compositeParts: [] });
    expect(pickingPreview([box, comp], comp)).toEqual([box]);
    const fm = feat("m", "mirror", { mirror: { sources: [], plane: { kind: "default", name: "Right" }, of: "face", picking: "faces" } });
    expect(picksPartsBefore(fm)).toBe(true);
    expect(picksPartsBefore(feat("f", "fillet"))).toBe(false);
  });
  it("knows the parts the open feature makes itself", () => {
    expect(madeByDraft("p", "p")).toBe(true);
    expect(madeByDraft("p~3", "p")).toBe(true);
    expect(madeByDraft("p2", "p")).toBe(false);
  });
});

describe("the check report", () => {
  it("doesn't call a composite part's pieces a problem", () => {
    const mesh = { triangleCount: 24, vertexCount: 16, openEdges: 0, nonManifoldEdges: 0, flippedEdges: 0, degenerateTriangles: 0, pieces: 2, volume: 2000, area: 1200, bounds: { min: [0, 0, 0] as [number, number, number], max: [30, 10, 10] as [number, number, number] }, watertight: true };
    const r = buildCheckReport({ parts: [{ partId: "c", name: "Composite part 1", geometryValid: true, exactVolume: 2000, mesh, thinnest: null, members: 2 }] }, 0);
    const texts = r.parts[0].findings.map((f) => f.text).join("\n");
    expect(texts).not.toMatch(/separate pieces — /);
    expect(texts).toMatch(/composite part of 2 parts/);
    expect(r.parts[0].findings.every((f) => f.level === "ok")).toBe(true);
    // Split into more pieces than it had parts: it says pieces, as its Parts list does.
    const split = buildCheckReport({ parts: [{ partId: "c", name: "C", geometryValid: true, exactVolume: 2000, mesh: { ...mesh, pieces: 3 }, thinnest: null, members: 2 }] }, 0);
    expect(split.parts[0].findings.map((f) => f.text).join("\n")).toMatch(/composite part in 3 pieces/);
  });
});

describe("the app: picking parts and faces", () => {
  const s = () => useStore.getState();
  const mesh = (id: string): PartMesh =>
    ({ id, name: id, featureIds: [id], vertices: new Float32Array(), normals: new Float32Array(), triangles: new Uint32Array(), faceGroups: [], lines: new Float32Array(), edgeGroups: [], faceRefs: [{ kind: "face", surface: "PLANE", center: [0, 0, 1], normal: [0, 0, 1] }], edgeRefs: [] }) as PartMesh;
  const start = (selectedParts: string[], selection: { partId: string; kind: "face"; index: number }[] = []) => {
    useStore.setState({ history: historyOf(docOf([feat("a", "box"), feat("b", "box")])), editing: null, parts: [mesh("a"), mesh("b")], selectedParts, selection, selectedFeatureId: null, rollbackTo: null });
  };

  it("starts a pattern with the parts selected as a part pattern, and with faces selected as a face pattern", () => {
    start(["a"]);
    s().startCreate("linearPattern");
    expect(s().editing!.draft.pattern).toMatchObject({ of: "part", parts: ["a"] });
    start([], [{ partId: "b", kind: "face", index: 0 }]);
    s().startCreate("circularPattern");
    expect(s().editing!.draft.pattern?.of).toBe("face");
    expect(s().editing!.draft.picks?.map((p) => p.partId)).toEqual(["b"]);
    start([], [{ partId: "b", kind: "face", index: 0 }]);
    s().startCreate("mirror");
    expect(s().editing!.draft.mirror?.of).toBe("face");
    start(["a", "b"]);
    s().startCreate("composite");
    expect(s().editing!.draft.compositeParts).toEqual(["a", "b"]);
  });

  it("adds and takes out parts, and refuses the open feature's own parts", () => {
    start([]);
    s().startCreate("composite");
    s().toggleDraftPart("a");
    s().toggleDraftPart("b");
    expect(s().editing!.draft.compositeParts).toEqual(["a", "b"]);
    s().toggleDraftPart("a");
    expect(s().editing!.draft.compositeParts).toEqual(["b"]);
    s().toggleDraftPart(s().editing!.draft.id);
    expect(s().editing!.draft.compositeParts).toEqual(["b"]);
    expect(s().toast?.text).toMatch(/made by/);
    start(["a"]);
    s().startCreate("linearPattern");
    const id = s().editing!.draft.id;
    s().toggleDraftPart(`${id}~2`);
    expect(s().editing!.draft.pattern?.parts).toEqual(["a"]);
    s().toggleDraftPart("b");
    expect(s().editing!.draft.pattern?.parts).toEqual(["a", "b"]);
  });
});

describe("composite part problems, before Accept", () => {
  const parts = [{ id: "a", name: "Part 1" }, { id: "b", name: "Part 2" }, { id: "s", name: "Surface 1", surface: true }];
  it("asks for two or more solid parts that are there", () => {
    expect(compositeProblem([], parts)).toMatch(/two or more/);
    expect(compositeProblem(["a"], parts)).toMatch(/two or more/);
    expect(compositeProblem(["a", "a"], parts)).toMatch(/two or more/);
    expect(compositeProblem(["a", "s"], parts)).toMatch(/Surface 1 is a surface/);
    expect(compositeProblem(["a", "gone"], parts)).toMatch(/no longer exists/);
    expect(compositeProblem(["a", "b"], parts)).toBeNull();
  });
});

describe("the app: picking state isn't kept, and later parts' flags survive the preview", () => {
  const s = () => useStore.getState();
  const mesh = (id: string): PartMesh =>
    ({ id, name: id, featureIds: [id], vertices: new Float32Array(), normals: new Float32Array(), triangles: new Uint32Array(), faceGroups: [], lines: new Float32Array(), edgeGroups: [], faceRefs: [], edgeRefs: [] }) as PartMesh;

  it("drops pattern.picking and mirror.picking on Accept", () => {
    useStore.setState({ history: historyOf(docOf([feat("a", "box")])), editing: null, parts: [mesh("a")], selectedParts: ["a"], selection: [], selectedFeatureId: null, rollbackTo: null });
    s().startCreate("linearPattern");
    s().setDraftField({ pattern: { ...s().editing!.draft.pattern!, picking: "items" } });
    expect(s().commitDraft()).toBe(true);
    const saved = s().history.present.features.at(-1)!;
    expect(saved.pattern?.of).toBe("part");
    expect("picking" in saved.pattern!).toBe(false);
    useStore.setState({ selection: [], selectedParts: [] });
    s().startCreate("mirror");
    s().setDraftField({ mirror: { ...s().editing!.draft.mirror!, of: "face", picking: "faces" } });
    s().commitDraft();
    expect("picking" in s().history.present.features.at(-1)!.mirror!).toBe(false);
  });

  it("keeps hidden, see-through and selected parts while only the parts before are shown", () => {
    useStore.setState({ history: historyOf(docOf([feat("a", "box"), feat("z", "box")])), editing: null, parts: [mesh("a"), mesh("z")], hiddenParts: ["z"], transparentParts: ["z"], selectedParts: [], selection: [], rollbackTo: null });
    s().startCreate("composite");
    // The picking preview has only the parts before it (here, none after "a" would be built if it sat earlier).
    s().setRebuildResult([mesh("a")], {}, 1);
    expect(s().hiddenParts).toEqual(["z"]);
    expect(s().transparentParts).toEqual(["z"]);
    // With nothing picking, parts that are gone are forgotten as before.
    s().cancelDraft();
    s().setRebuildResult([mesh("a")], {}, 1);
    expect(s().hiddenParts).toEqual([]);
  });
});
