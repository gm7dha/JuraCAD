import { describe, expect, it } from "vitest";

import { addLine, deleteItems, dimensionFor, pointPos, type Placed } from "../src/sketch/ops";
import { findRegions } from "../src/sketch/regions";
import { bezierAt, splineBeziers, splinePolyline } from "../src/sketch/spline";
import { addSpline, mirrorCurves, patternCurves } from "../src/sketch/tools";
import { distToCurve } from "../src/sketch/hit";
import { emptySketch, type SketchSpline } from "../src/sketch/types";
import { parseSketchData } from "../src/sketch/validate";

const at = (x: number, y: number): Placed => ({ x, y, snap: null });

describe("splines", () => {
  it("pass through every point, smoothly", () => {
    const pts: [number, number][] = [
      [0, 0],
      [10, 10],
      [20, 0],
      [30, 10],
    ];
    const pieces = splineBeziers(pts, false);
    expect(pieces).toHaveLength(3);
    pieces.forEach((b, i) => {
      expect(bezierAt(b, 0)).toEqual(pts[i]);
      expect(bezierAt(b, 1)).toEqual(pts[i + 1]);
    });
    // Smooth at the joins: the handles either side of a point line up through it.
    const [, , inHandle, joint] = pieces[0];
    const [, outHandle] = pieces[1];
    const cross = (inHandle[0] - joint[0]) * (outHandle[1] - joint[1]) - (inHandle[1] - joint[1]) * (outHandle[0] - joint[0]);
    expect(Math.abs(cross)).toBeLessThan(1e-9);
    expect(splineBeziers(pts, true)).toHaveLength(4);
  });

  it("a closed spline is a shape of its own; an open one can close a shape with lines", () => {
    const closed = addSpline(emptySketch(), [at(0, 0), at(20, 0), at(20, 20), at(0, 20)], true);
    expect(closed.error).toBe(undefined);
    const r = findRegions(closed.sketch);
    expect(r.regions).toHaveLength(1);
    expect(r.regions[0].outer.segments.every((s) => s.kind === "bezier")).toBe(true);

    // A line along the bottom, and a spline arching over the top back to it.
    const l = addLine(emptySketch(), at(0, 0), at(30, 0));
    const p1 = { ...at(0, 0), snap: { kind: "point" as const, id: (l.sketch.curves[0] as { p1: string }).p1 } };
    const p2 = { ...at(30, 0), snap: { kind: "point" as const, id: l.endId } };
    const arch = addSpline(l.sketch, [p2, at(25, 10), at(5, 10), p1], false);
    const r2 = findRegions(arch.sketch);
    expect(r2.regions).toHaveLength(1);
    expect(r2.regions[0].outer.segments.map((s) => s.kind).sort()).toEqual(["bezier", "bezier", "bezier", "line"]);
    expect(r2.regions[0].outer.area).toBeGreaterThan(150);
  });

  it("clicking the first point again closes it", () => {
    const s = addSpline(emptySketch(), [at(0, 0), at(10, 0), at(5, 8)], false).sketch;
    const first = (s.curves[0] as SketchSpline).points[0];
    const again = addSpline(emptySketch(), [at(0, 0), at(10, 0), at(5, 8), { x: 0, y: 0, snap: { kind: "point", id: first } }], false);
    expect(again.error).toBe(undefined);
    expect(!!addSpline(emptySketch(), [at(0, 0)], false).error).toBe(true);
  });

  it("can be picked, mirrored, patterned, saved and deleted", () => {
    const r = addSpline(emptySketch(), [at(0, 0), at(10, 5), at(20, 0)], false);
    const s = r.sketch;
    const sp = s.curves[0];
    const mid = splinePolyline(sp.type === "spline" ? sp.points.map((id) => pointPos(s, id)) : [], false)[16];
    expect(distToCurve(s, sp, mid[0], mid[1])).toBeLessThan(1e-9);
    expect(typeof dimensionFor(s, [sp.id])).toBe("string");
    const axis = addLine(s, at(-5, -10), at(-5, 10), { construction: true });
    const m = mirrorCurves(axis.sketch, axis.lineId, [sp.id]);
    expect(m.error).toBe(undefined);
    expect(m.sketch.curves.filter((c) => c.type === "spline")).toHaveLength(2);
    const p = patternCurves(s, [sp.id], { kind: "linear", count: 3, spacing: 30, angle: 0 });
    expect(p.sketch.curves.filter((c) => c.type === "spline")).toHaveLength(3);
    expect(parseSketchData(JSON.parse(JSON.stringify(s)))?.curves[0]).toEqual(sp);
    expect(deleteItems(s, [sp.id]).points).toHaveLength(0);
  });
});
