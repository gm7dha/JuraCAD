import { describe, expect, it } from "vitest";

import { featuresOfParts, partsOfFeature } from "../src/model/partLinks";
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
