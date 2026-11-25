/**
 * Pure: an early sketch opened for editing shows the parts as they were before it (later parts hidden, parts changed
 * later see-through), and a new drawing draws the main part rather than the last pattern copy.
 */
import { describe, expect, it } from "vitest";

import { mainPart } from "../src/drawing/defaultPart";
import { partsAfterSketch } from "../src/model/finalPreview";
import type { Feature } from "../src/model/types";

const feat = (id: string, type: Feature["type"]): Feature => ({ id, name: id, type, operation: "new", suppressed: false, params: {} });
const features = [feat("b", "box"), feat("s1", "sketch"), feat("e1", "extrude"), feat("s2", "sketch"), feat("e2", "extrude"), feat("p", "linearPattern")];
const parts = [
  { id: "b", featureIds: ["b", "e1"] },
  { id: "e2", featureIds: ["e2"] },
  { id: "p", featureIds: ["p"] },
  { id: "p~2", featureIds: ["p"] },
  { id: "x", featureIds: ["other-studio"] },
];

describe("editing an early sketch", () => {
  it("hides the parts later features made and shows the ones they changed see-through", () => {
    expect(partsAfterSketch(features, parts, { mode: "edit", draft: { id: "s1", type: "sketch" } })).toEqual({ hidden: ["e2", "p", "p~2"], seeThrough: ["b"] });
    expect(partsAfterSketch(features, parts, { mode: "edit", draft: { id: "s2", type: "sketch" } })).toEqual({ hidden: ["e2", "p", "p~2"], seeThrough: [] });
  });

  it("does nothing for a new sketch, another feature, or the last feature", () => {
    expect(partsAfterSketch(features, parts, { mode: "create", draft: { id: "s9", type: "sketch" } })).toBeNull();
    expect(partsAfterSketch(features, parts, { mode: "edit", draft: { id: "e1", type: "extrude" } })).toBeNull();
    expect(partsAfterSketch([...features, feat("s3", "sketch")], parts, { mode: "edit", draft: { id: "s3", type: "sketch" } })).toBeNull();
    expect(partsAfterSketch(features, parts, null)).toBeNull();
  });
});

describe("a new drawing's part", () => {
  it("is the biggest solid, the first of equals (not a pattern copy), surfaces only when there's nothing else", () => {
    expect(mainPart([{ id: "a", volume: 100 }, { id: "a~2", volume: 100 }, { id: "small", volume: 5 }])).toBe("a");
    expect(mainPart([{ id: "small", volume: 5 }, { id: "big", volume: 500 }])).toBe("big");
    expect(mainPart([{ id: "skin", surface: true }, { id: "solid", volume: 1 }])).toBe("solid");
    expect(mainPart([{ id: "skin", surface: true }])).toBe("skin");
    expect(mainPart([])).toBeUndefined();
  });
});
