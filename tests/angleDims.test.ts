import { describe, expect, it } from "vitest";

import { angleGeometry, dimLabel, drawDimension, measureDim, placeAngle, resolveDim } from "../src/drawing/dimensions";
import { parseDrawings } from "../src/drawing/drawing";
import type { ViewProjection } from "../src/kernel/protocol";
import type { Dimension } from "../src/model/types";

type P2 = [number, number];
const pt = (at: P2) => ({ at, rel: [0, 0] as P2 });

describe("angle dimensions on drawings", () => {
  it("works out where two edges meet and the angle between them", () => {
    const g = angleGeometry([0, 0], [10, 0], [0, 0], [10, 10])!;
    expect(g.vertex).toEqual([0, 0]);
    expect(g.degrees).toBeCloseTo(45, 9);
    expect(angleGeometry([0, 0], [10, 0], [0, 0], [10, 10], [1, -1])!.degrees).toBeCloseTo(135, 9);
    expect(angleGeometry([0, 0], [10, 0], [0, 5], [10, 5])).toBe(null);
  });

  it("measures the angle the pointer is in", () => {
    const inside = placeAngle([0, 0], [10, 0], [0, 0], [10, 10], [8, 3])!;
    expect(inside.rays).toEqual([1, 1]);
    expect(inside.offset).toBeCloseTo(Math.hypot(8, 3), 1);
    const outside = placeAngle([0, 0], [10, 0], [0, 0], [10, 10], [-1, 8])!;
    expect(outside.rays).toEqual([-1, 1]);
  });

  it("draws an arc with its value, and is saved", () => {
    const p: ViewProjection = { kind: "front", visible: [[0, 0, 10, 0], [0, 0, 10, 10]], hidden: [], circles: [], points: [0, 0, 10, 0, 10, 10], bounds: [0, 0, 10, 10] };
    const dim: Dimension = { id: "a", view: "front", type: "angle", a: pt([0, 0]), b: pt([10, 0]), c: pt([0, 0]), d: pt([10, 10]), offset: 20, rays: [1, 1] };
    const r = resolveDim(dim, p);
    expect(r.found).toBe(true);
    const value = measureDim(dim, r);
    expect(dimLabel(dim, value)).toBe("45°");
    const drawn = drawDimension(dim, r, (q) => q, value);
    expect(drawn.prims.some((x) => x.kind === "text" && x.text === "45°")).toBe(true);
    const raw = [{ id: "d", name: "D", source: null, sheet: "A4", hiddenLines: true, views: [{ id: "v", kind: "front" }], title: {}, dimensions: [dim] }];
    expect(parseDrawings(JSON.parse(JSON.stringify(raw)))[0].dimensions?.[0]).toEqual(dim);
  });
});
