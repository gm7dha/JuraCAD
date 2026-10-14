import { describe, expect, it } from "vitest";

import { featuresOfParts, groupByPart, partsOfFeature } from "../src/model/partLinks";
import type { Feature } from "../src/model/types";

const f = (id: string, extra: Partial<Feature> = {}): Feature => ({ id, name: id, type: "box", operation: "new", suppressed: false, params: {}, ...extra });

describe("which features made which parts", () => {
  const features = [f("box"), f("sk", { type: "sketch" }), f("ex", { type: "extrude", sketchRef: "sk" }), f("hole", { type: "cylinder", operation: "remove" }), f("box2")];
  const parts = [
    { id: "box", featureIds: ["box", "hole"] },
    { id: "ex", featureIds: ["ex"] },
    { id: "box2", featureIds: ["box2"] },
  ];

  it("finds a part's features, sketches included", () => {
    expect(featuresOfParts(parts, ["box"], features)).toEqual(["box", "hole"]);
    expect(featuresOfParts(parts, ["ex", "box2"], features)).toEqual(["sk", "ex", "box2"]);
    expect(featuresOfParts(parts, [], features)).toEqual([]);
  });

  it("finds a feature's parts, through a sketch too", () => {
    expect(partsOfFeature(parts, "hole", features)).toEqual(["box"]);
    expect(partsOfFeature(parts, "sk", features)).toEqual(["ex"]);
    expect(partsOfFeature(parts, "nothing", features)).toEqual([]);
  });
});

describe("grouping the feature list by part", () => {
  it("puts each part's features (and their sketches and planes) under it, the rest under Other", () => {
    const plane = f("pl", { type: "plane" });
    const sk = f("sk", { type: "sketch", sketch: { plane: { kind: "face", origin: [0, 0, 5], u: [1, 0, 0], v: [0, 1, 0], label: "pl", planeRef: "pl" }, data: { points: [], curves: [], constraints: [] } } });
    const ex = f("ex", { type: "extrude", sketchRef: "sk" });
    const box = f("box");
    const join = f("join", { type: "boolean" });
    const spare = f("spare", { type: "sketch" });
    const features = [plane, sk, ex, box, join, spare];
    const parts = [
      { id: "ex", name: "Part 1", featureIds: ["ex", "join"] },
      { id: "box", name: "Part 2", featureIds: ["box", "join"] },
    ];
    const g = groupByPart(parts, features);
    expect(g.groups.map((x) => x.featureIds)).toEqual([["pl", "sk", "ex", "join"], ["box", "join"]]);
    expect(g.other).toEqual(["spare"]);
  });
});
