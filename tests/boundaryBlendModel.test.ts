import { describe, expect, it } from "vitest";
import { createFeature, emptyDocument, parseDocument, withoutPicking } from "../src/model/document";
import { findDependents, withoutGone } from "../src/model/dependents";
import { blendClick, boundaryClick, setMatch } from "../src/model/surfaceClicks";
import { featureForEngine } from "../src/kernel/buildInput";
import type { Feature } from "../src/model/types";
import type { TopoPick } from "../src/geometry/topoRef";

const edge = (partId: string, n = 0): TopoPick => ({ partId, ref: { kind: "edge", curve: "LINE", a: [n, 0, 0], b: [n, 1, 0], mid: [n, 0.5, 0] } as unknown as TopoPick["ref"] });
const face = (partId: string, n = 0): TopoPick => ({ partId, ref: { kind: "face", surface: "PLANE", center: [n, 0, 0], normal: [0, 0, 1] } as unknown as TopoPick["ref"] });
const feat = (id: string, type: Feature["type"], extra: Partial<Feature> = {}): Feature => ({ id, name: id, type, operation: "new", suppressed: false, params: {}, ...extra });

describe("Boundary surface and Face blend: clicks", () => {
  it("adds curves to the direction being picked, takes a clicked one out again, at most two each way", () => {
    let def = createFeature(emptyDocument(), "boundary").boundary!;
    expect(def).toEqual({ u: [], v: [], picking: "u" });
    def = boundaryClick(def, { kind: "edge", pick: edge("p1", 1) }) as typeof def;
    def = boundaryClick(def, { kind: "curve", id: "c1" }) as typeof def;
    expect(def.u).toHaveLength(2);
    expect(boundaryClick(def, { kind: "sketch", id: "s1" })).toMatch(/already two U curves/);
    def = boundaryClick({ ...def, picking: "v" }, { kind: "sketch", id: "s1" }) as typeof def;
    expect(def.v).toEqual([{ sketch: "s1" }]);
    // Clicked again (even while picking the other way): taken out.
    def = boundaryClick(def, { kind: "curve", id: "c1" }) as typeof def;
    expect(def.u).toEqual([{ edge: edge("p1", 1) }]);
    expect(boundaryClick(def, { kind: "edge", pick: face("p1") })).toMatch(/not faces/);
    // A side condition only on part edges.
    expect(setMatch(def, "u", 0, "tangent").u[0].match).toBe("tangent");
    expect(setMatch(def, "v", 0, "tangent").v[0].match).toBeUndefined();
    expect(setMatch(setMatch(def, "u", 0, "curvature"), "u", 0, undefined).u[0]).toEqual({ edge: edge("p1", 1) });
  });

  it("puts faces on side 1 or side 2, and takes them out when clicked again", () => {
    const start = createFeature(emptyDocument(), "faceBlend");
    expect(start.blend).toEqual({ side2: [], picking: "side1" });
    let d = blendClick(start, face("a")) as Pick<Feature, "picks" | "blend">;
    expect(d.picks).toHaveLength(1);
    d = blendClick({ ...d, blend: { ...d.blend!, picking: "side2" } }, face("b")) as typeof d;
    expect(d.blend!.side2).toHaveLength(1);
    d = blendClick(d, face("a")) as typeof d;
    expect(d.picks).toEqual([]);
    expect(blendClick(d, edge("a"))).toMatch(/not edges/);
  });
});

describe("Boundary surface and Face blend: files and the engine", () => {
  it("are saved and read back, without what a click picks", () => {
    const b = { ...feat("b1", "boundary"), boundary: { u: [{ edge: edge("p1"), match: "tangent" as const }, { curve: "c1" }], v: [{ sketch: "s1" }], picking: "v" as const } };
    const fb = { ...feat("fb1", "faceBlend", { params: { radius: "3" } }), picks: [face("p1")], blend: { side2: [face("p2")], flip2: true, noTrim: true, picking: "side2" as const } };
    const doc = { ...emptyDocument(), features: [withoutPicking(b), withoutPicking(fb)] };
    const back = parseDocument(JSON.parse(JSON.stringify(doc)))!;
    expect(back.features[0].boundary).toEqual({ u: [{ edge: edge("p1"), match: "tangent" }, { curve: "c1" }], v: [{ sketch: "s1" }] });
    expect(back.features[1].blend).toEqual({ side2: [face("p2")], flip2: true, noTrim: true });
    expect(back.features[1].picks).toEqual([face("p1")]);
    // The engine never sees the picking (so switching sides doesn't rebuild).
    expect(featureForEngine(b).boundary?.picking).toBeUndefined();
    expect(featureForEngine(fb).blend?.picking).toBeUndefined();
  });

  it("know what they use, for Delete with dependents", () => {
    const list = [
      feat("box", "box"),
      feat("box2", "box"),
      feat("c1", "curve"),
      { ...feat("b1", "boundary"), boundary: { u: [{ edge: edge("box") }, { curve: "c1" }], v: [] } },
      { ...feat("fb", "faceBlend"), picks: [face("box")], blend: { side2: [face("box"), face("box2")] } },
    ];
    expect(findDependents(list, ["c1"]).dependents).toEqual(["b1"]);
    expect(findDependents(list, ["box"]).dependents).toEqual(["b1", "fb"]);
    // Losing one of side 2's faces keeps the blend, without it.
    const d = findDependents(list, ["box2"]);
    expect(d.dependents).toEqual([]);
    expect(d.partial.map((p) => p.id)).toEqual(["fb"]);
    expect(withoutGone(list[4], new Set(["box2"])).blend!.side2).toEqual([face("box")]);
  });
});
