import { describe, expect, it } from "vitest";

import { sheetDxf } from "../src/drawing/export";
import { flatPrims, flatSize } from "../src/sheetmetal/flatExport";
import { flatPattern, foldSheet } from "../src/sheetmetal/sheet";

describe("flat pattern files", () => {
  it("draws the outline and bend lines with a margin, and saves them as DXF", () => {
    const folded = foldSheet({
      thickness: 2,
      radius: 2,
      k: 0.5,
      base: {
        frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
        outer: [
          { kind: "line", from: [0, 0], to: [60, 0] },
          { kind: "line", from: [60, 0], to: [60, 40] },
          { kind: "line", from: [60, 40], to: [0, 40] },
          { kind: "line", from: [0, 40], to: [0, 0] },
        ],
        holes: [[{ kind: "circle", center: [30, 20], radius: 5 }]],
      },
      flanges: [{ id: "f", wall: "base", edge: 1, length: 20, angle: 90, down: false }],
    });
    const flat = { ...flatPattern(folded), thickness: 2, radius: 2, k: 0.5, notShown: [] };
    const { width, height } = flatSize(flat);
    expect(height).toBeCloseTo(40, 6);
    expect(width).toBeCloseTo(60 + (Math.PI / 2) * 3 + 16, 6);
    const { prims, size } = flatPrims(flat);
    expect(size[0]).toBeCloseTo(width + 10, 6);
    expect(prims.map((p) => (p.kind === "path" ? p.style : "text"))).toEqual(["visible", "visible", "centre"]);
    const dxf = sheetDxf(prims);
    expect(dxf).toContain("\nCENTRE\n");
    expect(dxf.match(/\nLINE\n/g)!.length).toBeGreaterThan(10);
  });
});
