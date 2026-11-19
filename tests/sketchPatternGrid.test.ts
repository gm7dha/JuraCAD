import { describe, expect, it } from "vitest";

import { addCircle, addDimension, pointPos, setDimensionValue } from "../src/sketch/ops";
import { analyzeSketch } from "../src/sketch/solver";
import { patternGrid, readSecondDirection } from "../src/sketch/patternGrid";
import { emptySketch, type SketchCircle } from "../src/sketch/types";

describe("two-direction sketch pattern", () => {
  it("makes rows × columns that follow the original", () => {
    const c = addCircle(emptySketch(), { x: 0, y: 0, snap: { kind: "origin" } }, 2);
    let s = addDimension(c.sketch, [c.circleId], { x: 3, y: 3 }).sketch;
    expect(analyzeSketch(s).freedom).toBe(0);
    const second = readSecondDirection({ pattern2: true, pattern2Count: 3, pattern2Spacing: "5", pattern2Angle: "90" });
    expect(typeof second).toBe("object");
    const r = patternGrid(s, [c.circleId], { kind: "linear", count: 4, spacing: 10, angle: 0 }, second as Exclude<typeof second, string | null>);
    expect(r.error).toBeUndefined();
    s = r.sketch;
    const circles = s.curves.filter((k): k is SketchCircle => k.type === "circle");
    expect(circles).toHaveLength(12);
    const centres = circles.map((k) => pointPos(s, k.center)).map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).sort();
    expect(centres).toContain("30,10");
    expect(analyzeSketch(s).freedom).toBe(0);
    // The originals' size carries to every copy.
    const dim = s.constraints.find((k) => k.type === "radius" || k.type === "diameter")!;
    const t = setDimensionValue(s, dim.id, dim.type === "radius" ? "1" : "2").sketch;
    expect(t.curves.filter((k): k is SketchCircle => k.type === "circle").every((k) => Math.abs(k.radius - 1) < 1e-6)).toBe(true);
  });

  it("reads the second direction's boxes", () => {
    expect(readSecondDirection({ pattern2: false, pattern2Count: 3, pattern2Spacing: "5", pattern2Angle: "90" })).toBeNull();
    expect(readSecondDirection({ pattern2: true, pattern2Count: 3, pattern2Spacing: "x +", pattern2Angle: "90" })).toMatch(/Second direction/);
  });
});
