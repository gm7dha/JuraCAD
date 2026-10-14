import { describe, expect, it } from "vitest";

import { dropCoveredHidden } from "../src/drawing/hidden";

describe("hidden lines under visible ones", () => {
  const square = [[0, 0, 10, 0, 10, 10, 0, 10, 0, 0]];
  it("drops hidden lines lying on visible ones", () => {
    expect(dropCoveredHidden(square, [[0, 0, 10, 0], [2, 10, 8, 10]])).toEqual([]);
  });
  it("keeps hidden lines that are anywhere else, even if their ends touch", () => {
    const inside = [2, 0, 2, 10];
    const across = [0, 0, 10, 10];
    const partly = [5, 0, 15, 0];
    expect(dropCoveredHidden(square, [inside, across, partly])).toEqual([inside, across, partly]);
  });
  it("copes with nothing visible", () => {
    expect(dropCoveredHidden([], [[0, 0, 1, 1]])).toEqual([[0, 0, 1, 1]]);
  });
});
