import { describe, expect, it } from "vitest";

import { itemsInBox, RIGHT_CLICK_SLOP, rightClickFlip, toggled } from "../src/drawing/select";
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

describe("right-clicking a dimension's number", () => {
  const down = { dimId: "d1", x: 100, y: 50 };
  it("flips its arrows when the right button comes up where it went down", () => {
    expect(rightClickFlip(down, { button: 2, x: 100, y: 50 })).toBe("d1");
    expect(rightClickFlip(down, { button: 2, x: 103, y: 52 })).toBe("d1");
    expect(rightClickFlip(down, { button: 2, x: 100 + RIGHT_CLICK_SLOP, y: 50 })).toBe("d1");
  });
  it("doesn't when it was a right-drag to pan, another button, or not on a dimension", () => {
    expect(rightClickFlip(down, { button: 2, x: 104, y: 54 })).toBeNull();
    expect(rightClickFlip(down, { button: 2, x: 300, y: 50 })).toBeNull();
    // (A Mac's Ctrl+click is the left button: it adds to the selection instead.)
    expect(rightClickFlip(down, { button: 0, x: 100, y: 50 })).toBeNull();
    expect(rightClickFlip(down, { button: 1, x: 100, y: 50 })).toBeNull();
    expect(rightClickFlip(null, { button: 2, x: 100, y: 50 })).toBeNull();
  });
});
