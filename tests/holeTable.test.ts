import { describe, expect, it } from "vitest";

import { holeRows, holeTableView } from "../src/drawing/holeTable";
import type { ViewProjection } from "../src/kernel/protocol";

const plate: ViewProjection = {
  kind: "top",
  visible: [
    [0, 0, 60, 0],
    [60, 0, 60, 40],
    [60, 40, 0, 40],
    [0, 40, 0, 0],
  ],
  hidden: [],
  circles: [
    { cx: 10, cy: 10, r: 2, hidden: false, full: true },
    { cx: 50, cy: 10, r: 2, hidden: false, full: true },
    { cx: 30, cy: 25, r: 5, hidden: false, full: true },
    // A counterbore round the big hole.
    { cx: 30, cy: 25, r: 8, hidden: false, full: true },
    { cx: 5, cy: 35, r: 1, hidden: true, full: true },
  ],
  points: [0, 0, 60, 0, 60, 0, 60, 40, 60, 40, 0, 40, 0, 40, 0, 0],
  bounds: [0, 0, 60, 40],
};

describe("hole table", () => {
  it("tags each hole once, a letter per size (biggest first), measured from the corner", () => {
    expect(holeRows(plate).map((r) => [r.tag, r.x, r.y, r.diameter])).toEqual([
      ["A1", 30, 25, 10],
      ["B1", 10, 10, 4],
      ["B2", 50, 10, 4],
    ]);
  });

  it("describes the top view if it has holes", () => {
    expect(holeTableView({ views: [{ id: "a", kind: "front", at: [0, 0] }, { id: "b", kind: "top", at: [0, 0] }] } as never, { top: plate })).toBe("top");
    expect(holeTableView({ views: [{ id: "a", kind: "front", at: [0, 0] }] } as never, { top: plate })).toBe(null);
  });
});

describe("hole table on the sheet", () => {
  it("tags the holes and lists them above the title block", async () => {
    const { layoutSheet } = await import("../src/drawing/sheet");
    const drawing = {
      id: "d",
      name: "Drawing 1",
      source: { kind: "part", id: "p" },
      sheet: "A4",
      views: [{ id: "v", kind: "top", at: null }],
      hiddenLines: false,
      title: {},
      holeTable: true,
    };
    const layout = layoutSheet(drawing as never, { top: plate }, { designName: "x", subject: "Plate", date: "1/1/2026" });
    const texts = layout.prims.filter((p) => p.kind === "text").map((p) => (p.kind === "text" ? p.text : ""));
    for (const t of ["HOLE", "A1", "B1", "B2", "Ø10", "Ø4"]) expect(texts).toContain(t);
  });
});
