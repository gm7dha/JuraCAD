/**
 * Pattern types (Part / Feature / Face), face mirrors and Composite part,
 * without geometry: files read back what was saved (and old files exactly as
 * before), and Delete with dependents knows what they use.
 */
import { describe, expect, it } from "vitest";
import { findDependents, withoutGone } from "../src/model/dependents";
import { createFeature, emptyDocument, parseDocument } from "../src/model/document";
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
    const d = findDependents(features, ["a"]);
    expect(d.dependents).toEqual(["p"]);
    expect(d.partial.map((x) => x.id)).toEqual(["c"]);
    expect(withoutGone(features[3], new Set(["a"])).compositeParts).toEqual(["b"]);
    // A face pattern goes with the part its faces are on.
    const fp = feat("f", "linearPattern", { operation: "add", pattern: { sources: [], axis: "x", flip: false, of: "face" }, picks: [face("b")] });
    expect(findDependents([...features.slice(0, 2), fp], ["b"]).dependents).toEqual(["f"]);
    // A part pattern of two parts keeps the one left.
    const two = feat("q", "linearPattern", { operation: "add", pattern: { sources: [], axis: "x", flip: false, of: "part", parts: ["a", "b"] } });
    expect(findDependents([...features.slice(0, 2), two], ["a"]).partial.map((x) => x.id)).toEqual(["q"]);
    expect(withoutGone(two, new Set(["a"])).pattern?.parts).toEqual(["b"]);
  });
});
