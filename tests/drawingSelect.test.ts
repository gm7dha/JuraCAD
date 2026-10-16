import { describe, expect, it } from "vitest";

import { itemsInBox, toggled } from "../src/drawing/select";
import type { SheetLayout } from "../src/drawing/sheet";

const layout = {
  dims: [
    { id: "d1", label: [10, 10] },
    { id: "d2", label: [50, 10] },
  ],
  notes: [{ id: "n1", box: [20, 20, 40, 30] }],
} as unknown as Pick<SheetLayout, "dims" | "notes">;

describe("box selection on drawings", () => {
  it("left to right takes only what's wholly inside", () => {
    expect(itemsInBox(layout, [0, 0], [45, 25])).toEqual(["d1"]);
    expect(itemsInBox(layout, [0, 0], [45, 35])).toEqual(["d1", "n1"]);
  });

  it("right to left takes anything it touches", () => {
    expect(itemsInBox(layout, [60, 0], [30, 25])).toEqual(["d2", "n1"]);
    expect(itemsInBox(layout, [5, 35], [0, 0])).toEqual([]);
  });

  it("Ctrl-click adds or takes away", () => {
    expect(toggled(["a"], "b")).toEqual(["a", "b"]);
    expect(toggled(["a", "b"], "a")).toEqual(["b"]);
  });
});
