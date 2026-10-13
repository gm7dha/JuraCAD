import { describe, expect, it } from "vitest";

import { keeps, sectionPlane } from "../src/viewport/section";

describe("section view", () => {
  it("cutting along Top keeps what's below the cut, or above when flipped", () => {
    const p = sectionPlane({ plane: "Top", offset: 10, flip: false });
    expect(keeps(p, [0, 0, 5])).toBe(true);
    expect(keeps(p, [0, 0, 15])).toBe(false);
    const f = sectionPlane({ plane: "Top", offset: 10, flip: true });
    expect(keeps(f, [0, 0, 15])).toBe(true);
    expect(keeps(f, [0, 0, 5])).toBe(false);
  });

  it("Front keeps what's behind the cut; Right keeps what's to its left", () => {
    expect(keeps(sectionPlane({ plane: "Front", offset: 0, flip: false }), [0, 4, 0])).toBe(true);
    expect(keeps(sectionPlane({ plane: "Front", offset: 0, flip: false }), [0, -4, 0])).toBe(false);
    expect(keeps(sectionPlane({ plane: "Right", offset: 20, flip: false }), [10, 0, 0])).toBe(true);
    expect(keeps(sectionPlane({ plane: "Right", offset: 20, flip: false }), [30, 0, 0])).toBe(false);
  });
});
