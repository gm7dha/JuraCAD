/** Split face and Modify fillet in the document: reading files, old files unchanged, and Delete with dependents. */
import { describe, expect, it } from "vitest";
import { findDependents } from "../src/model/dependents";
import { emptyDocument, parseDocument } from "../src/model/document";
import { visibleParamKeys } from "../src/model/features";
import type { Feature } from "../src/model/types";
import type { TopoPick } from "../src/geometry/topoRef";
import { emptySketch } from "../src/sketch/types";

function feat(id: string, type: Feature["type"], extra: Partial<Feature> = {}): Feature {
  return { id, name: id, type, operation: "new", suppressed: false, params: {}, ...extra };
}
const face = (partId: string): TopoPick => ({ partId, ref: { kind: "face", surface: "PLANE", center: [0, 0, 0], normal: [0, -1, 0] } });
const sketch = (id: string) => feat(id, "sketch", { sketch: { plane: { kind: "default", name: "Top" }, data: emptySketch() } });
const reread = (features: Feature[]) => parseDocument(JSON.parse(JSON.stringify({ ...emptyDocument("x"), features })))!.features;

describe("split face and modify fillet in files", () => {
  it("reads them back as saved", () => {
    const split = feat("sp", "split", { sketchRef: "s1", picks: [face("b")], splitDef: { plane: { kind: "default", name: "Top" }, keep: "both", mode: "face", tool: "sketch", picking: "faces" } });
    const mod = feat("m", "modifyFillet", { params: { radius: "3" }, picks: [face("b")], modifyFillet: { remove: true, noPropagate: true } });
    const fil = feat("f", "fillet", { params: { radius: "1" }, picks: [face("b")], allEdges: true });
    const [s1, s2, s3, s4] = reread([feat("b", "box"), split, mod, fil]).slice(0);
    expect(s1.type).toBe("box");
    expect(s2.splitDef).toEqual(split.splitDef);
    expect(s2.sketchRef).toBe("s1");
    expect(s2.picks).toHaveLength(1);
    expect(s3.modifyFillet).toEqual({ remove: true, noPropagate: true });
    expect(s3.picks).toHaveLength(1);
    expect(s4.allEdges).toBe(true);
  });

  it("leaves an old part split as it was", () => {
    const old = feat("sp", "split", { splitDef: { partId: "b", plane: { kind: "default", name: "Right" }, keep: "front", picking: "plane" } });
    const [, back] = reread([feat("b", "box"), old]);
    expect(back).toEqual(old);
  });

  it("hides the radius box when taking fillets off", () => {
    expect(visibleParamKeys({ type: "modifyFillet", modifyFillet: { remove: true } } as Feature).has("radius")).toBe(false);
    expect(visibleParamKeys({ type: "modifyFillet" } as Feature).has("radius")).toBe(true);
  });
});

describe("delete with dependents knows them", () => {
  it("a split face goes with its sketch, its part, or the part it's on", () => {
    const features = [
      feat("b", "box"),
      sketch("s1"),
      feat("sp", "split", { sketchRef: "s1", picks: [face("b")], splitDef: { plane: { kind: "default", name: "Top" }, keep: "both", mode: "face", tool: "sketch" } }),
    ];
    expect(findDependents(features, ["s1"]).dependents).toEqual(["sp"]);
    expect(findDependents(features, ["b"]).dependents).toEqual(["sp"]);
  });

  it("a split face along a plane doesn't use the plane's sketch, nor make a part", () => {
    const features = [
      feat("b", "box"),
      feat("pl", "plane", { planeDef: { mode: "offset", ref: { kind: "default", name: "Top" } } as Feature["planeDef"] }),
      feat("sp", "split", { picks: [face("b")], splitDef: { plane: { kind: "face", origin: [0, 0, 5], u: [1, 0, 0], v: [0, 1, 0], label: "Plane 1", planeRef: "pl" }, keep: "both", mode: "face" } }),
      // An old-style Add after it still adds to the box (the split face made no new part).
      feat("c", "cylinder", { operation: "add" }),
    ];
    expect(findDependents(features, ["pl"]).dependents).toEqual(["sp"]);
    expect(findDependents(features, ["sp"]).dependents).toEqual([]);
  });

  it("a modify fillet goes with the part its faces are on", () => {
    const features = [feat("b", "box"), feat("m", "modifyFillet", { picks: [face("b")] })];
    expect(findDependents(features, ["b"]).dependents).toEqual(["m"]);
  });
});
