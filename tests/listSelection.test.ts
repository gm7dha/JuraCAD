import { describe, expect, it } from "vitest";

import { clickRow, dragRows, rowsBetween } from "../src/model/listSelection";

const order = ["a", "b", "c", "d", "e"];

describe("choosing several parts in a list", () => {
  it("picks the rows between two, either way round", () => {
    expect(rowsBetween(order, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rowsBetween(order, "d", "b")).toEqual(["b", "c", "d"]);
    expect(rowsBetween(order, "x", "c")).toEqual(["c"]);
  });

  it("click picks one; Ctrl + click adds and removes; Shift + click picks a run", () => {
    let s = clickRow(order, [], null, "b", { add: false, range: false });
    expect(s).toEqual({ selected: ["b"], anchor: "b" });
    s = clickRow(order, s.selected, s.anchor, "e", { add: true, range: false });
    expect(s.selected).toEqual(["b", "e"]);
    s = clickRow(order, s.selected, s.anchor, "b", { add: true, range: false });
    expect(s.selected).toEqual(["e"]);
    // Shift + click runs from the last row clicked (b) to this one.
    s = clickRow(order, s.selected, s.anchor, "d", { add: false, range: true });
    expect(s).toEqual({ selected: ["b", "c", "d"], anchor: "b" });
    // Shift with Ctrl adds the run to what's picked.
    expect(clickRow(order, ["a"], "c", "d", { add: true, range: true }).selected).toEqual(["a", "c", "d"]);
  });

  it("drag picks the rows passed over", () => {
    expect(dragRows(order, [], "b", "d")).toEqual(["b", "c", "d"]);
    expect(dragRows(order, [], "d", "a")).toEqual(["a", "b", "c", "d"]);
    // Holding Ctrl keeps what was already picked.
    expect(dragRows(order, ["e"], "a", "b")).toEqual(["a", "b", "e"]);
  });
});
