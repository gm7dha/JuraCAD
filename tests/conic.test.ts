import { describe, expect, it } from "vitest";

import { addLine, type Placed } from "../src/sketch/ops";
import { findRegions } from "../src/sketch/regions";
import { bezierAt, conicBeziers, splinePolyline } from "../src/sketch/spline";
import { addConic, mirrorCurves, setConicRho } from "../src/sketch/tools";
import { emptySketch, type SketchSpline } from "../src/sketch/types";
import { parseSketchData } from "../src/sketch/validate";

const at = (x: number, y: number): Placed => ({ x, y, snap: null });

describe("conics", () => {
  it("with fullness √2 − 1 over a square corner, is a quarter circle (to within a thousandth of a mm)", () => {
    const pieces = conicBeziers([10, 0], [10, 10], [0, 10], Math.SQRT2 - 1);
    expect(pieces[0][0]).toEqual([10, 0]);
    expect(pieces[pieces.length - 1][3]).toEqual([0, 10]);
    let worst = 0;
    for (const b of pieces) for (let k = 0; k <= 10; k++) worst = Math.max(worst, Math.abs(Math.hypot(...bezierAt(b, k / 10)) - 10));
    expect(worst).toBeLessThan(1e-3);
  });

  it("with fullness 0.5 is a parabola (its middle a quarter of the way to the corner); fuller bulges further", () => {
    const mid = (rho: number) => {
      const pts = splinePolyline([[0, 0], [10, 20], [20, 0]], false, 18, rho);
      return pts[(pts.length - 1) / 2];
    };
    expect(mid(0.5)[0]).toBeCloseTo(10, 6);
    expect(mid(0.5)[1]).toBeCloseTo(10, 6);
    expect(mid(0.8)[1]).toBeGreaterThan(mid(0.5)[1]);
    expect(mid(0.2)[1]).toBeLessThan(mid(0.5)[1]);
  });

  it("closes a shape with a line, keeps its fullness when saved, copied or changed", () => {
    const l = addLine(emptySketch(), at(0, 0), at(20, 0));
    const p1 = { ...at(0, 0), snap: { kind: "point" as const, id: (l.sketch.curves[0] as { p1: string }).p1 } };
    const p2 = { ...at(20, 0), snap: { kind: "point" as const, id: l.endId } };
    const r = addConic(l.sketch, p2, p1, at(10, 15), 0.5);
    expect(r.error).toBe(undefined);
    const conic = r.sketch.curves.find((c) => c.id === r.conicId) as SketchSpline;
    expect([conic.conic, conic.points.length, conic.closed]).toEqual([0.5, 3, false]);
    // A parabola 7.5 high over a 20 wide base: area ⅔ × 20 × 7.5 = 100.
    const regions = findRegions(r.sketch).regions;
    expect(regions).toHaveLength(1);
    expect(regions[0].outer.area).toBeCloseTo(100, 0);
    // Saved and read back.
    const back = parseSketchData(JSON.parse(JSON.stringify(r.sketch)))!;
    expect((back.curves.find((c) => c.id === r.conicId) as SketchSpline).conic).toBe(0.5);
    // Changing its fullness.
    const fuller = setConicRho(r.sketch, r.conicId, 0.7);
    expect((fuller.curves.find((c) => c.id === r.conicId) as SketchSpline).conic).toBe(0.7);
    expect(setConicRho(r.sketch, r.conicId, 1.2)).toBe(r.sketch);
    // Mirrored copies are conics too.
    const axis = addLine(r.sketch, at(-5, -10), at(-5, 30));
    const m = mirrorCurves(axis.sketch, axis.sketch.curves[axis.sketch.curves.length - 1].id, [r.conicId]);
    expect(m.error).toBe(undefined);
    expect(m.sketch.curves.filter((c) => c.type === "spline" && c.conic === 0.5)).toHaveLength(2);
  });

  it("needs a corner off to one side", () => {
    expect(addConic(emptySketch(), at(0, 0), at(20, 0), at(10, 0), 0.5).error).toMatch(/in line/);
    expect(addConic(emptySketch(), at(0, 0), at(20, 0), at(10, 5), 1).error).toMatch(/between 0 and 1/);
  });
});
