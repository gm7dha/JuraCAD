import { describe, expect, it } from "vitest";

import { addDrawing, parseDrawings, toggleView } from "../src/drawing/drawing";
import { layoutSheet } from "../src/drawing/sheet";
import { flatProjection } from "../src/sheetmetal/flatExport";
import type { FlatPatternData } from "../src/kernel/protocol";
import { emptyDocument } from "../src/model/document";

const flat: FlatPatternData = {
  outline: [
    [0, 0],
    [80, 0],
    [80, 40],
    [0, 40],
  ],
  holes: [[[10, 10], [14, 10], [14, 14], [10, 14]]],
  bendLines: [[[60, 0], [60, 40]]],
  bends: [{ line: [[60, 0], [60, 40]], angle: 90, radius: 1.5, up: true }],
  cuts: [[[30, 20], [34, 20]]],
  thickness: 1.5,
  radius: 1.5,
  k: 0.45,
  notShown: [],
};

describe("flat pattern drawing view", () => {
  it("turns the flat pattern into lines with its bends", () => {
    const p = flatProjection(flat);
    expect(p.kind).toBe("flat");
    expect(p.bounds).toEqual([0, 0, 80, 40]);
    // The outline closed, the hole closed, and the cut.
    expect(p.visible).toHaveLength(3);
    expect(p.visible[0]).toEqual([0, 0, 80, 0, 80, 40, 0, 40, 0, 0]);
    expect(p.points).toHaveLength(8);
    expect(p.bends).toEqual([{ line: [60, 0, 60, 40], angle: 90, radius: 1.5, up: true }]);
  });

  it("is ticked on like other views, drawn with its name, numbered bend lines and a bend list", () => {
    let d = addDrawing(emptyDocument(), "d1", { kind: "part", id: "sm" }).drawings![0];
    d = toggleView(d, "flat");
    expect(d.views.map((v) => v.kind)).toContain("flat");
    expect(parseDrawings(JSON.parse(JSON.stringify([d])))[0].views.some((v) => v.kind === "flat")).toBe(true);
    const l = layoutSheet({ ...d, views: d.views.filter((v) => v.kind === "flat") }, { flat: flatProjection(flat) }, { designName: "D", subject: "S", date: "16/10/2026" });
    const texts = l.prims.filter((p) => p.kind === "text").map((p) => (p.kind === "text" ? p.text : ""));
    expect(texts).toContain("FLAT PATTERN");
    expect(texts).toContain("B1");
    expect(texts).toContain("B1: UP 90°  R1.5");
    const centre = l.prims.filter((p) => p.kind === "path" && p.style === "centre");
    expect(centre).toHaveLength(1);
    const view = l.views.find((v) => v.key === "flat")!;
    // The bend line runs up the view, 3/4 of the way across.
    expect(centre[0].kind === "path" && centre[0].points[0]).toBeCloseTo(view.box[0] + (view.box[2] - view.box[0]) * 0.75, 6);
  });
});
