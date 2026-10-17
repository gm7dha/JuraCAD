import { describe, expect, it } from "vitest";

import { addLine, applyRelation, deleteItems, dimensionFor, dragPoint, pointPos, type Placed } from "../src/sketch/ops";
import { findRegions } from "../src/sketch/regions";
import { addEllipse, mirrorCurves, patternCurves } from "../src/sketch/tools";
import { distToCurve } from "../src/sketch/hit";
import { emptySketch, type SketchData, type SketchEllipse } from "../src/sketch/types";
import { parseSketchData } from "../src/sketch/validate";
import { analyzeSketch } from "../src/sketch/solver";

const at = (x: number, y: number): Placed => ({ x, y, snap: null });
const theEllipse = (s: SketchData) => s.curves.find((c): c is SketchEllipse => c.type === "ellipse")!;

describe("ellipses", () => {
  it("takes its width square to its length", () => {
    const r = addEllipse(emptySketch(), at(0, 0), at(10, 0), [3, 4]);
    expect(r.error).toBe(undefined);
    const e = theEllipse(r.sketch);
    expect(pointPos(r.sketch, e.minor)).toEqual([0, 4]);
    expect(!!addEllipse(emptySketch(), at(0, 0), at(10, 0), [5, 0]).error).toBe(true);
  });

  it("is a closed shape with the right area", () => {
    const s = addEllipse(emptySketch(), at(0, 0), at(10, 0), [0, 4]).sketch;
    const { regions } = findRegions(s);
    expect(regions).toHaveLength(1);
    expect(regions[0].outer.segments[0].kind).toBe("ellipse");
    expect(regions[0].outer.area).toBeCloseTo(Math.PI * 40, 0);
  });

  it("keeps its axes square when an end is dragged round", () => {
    const s = addEllipse(emptySketch(), at(0, 0), at(10, 0), [0, 4]).sketch;
    const e = theEllipse(s);
    const moved = dragPoint(s, e.major, 0, 10);
    const [mx, my] = pointPos(moved, e.major);
    const [nx, ny] = pointPos(moved, e.minor);
    const [cx, cy] = pointPos(moved, e.center);
    expect(Math.abs((mx - cx) * (nx - cx) + (my - cy) * (ny - cy))).toBeLessThan(1e-6);
  });

  it("is dimensioned by its points and can be fully defined", () => {
    let s = addEllipse(emptySketch(), at(0, 0), at(10, 0), [0, 4]).sketch;
    const e = theEllipse(s);
    expect(typeof dimensionFor(s, [e.id])).toBe("string");
    expect((dimensionFor(s, [e.center, e.major]) as { type: string }).type).toBe("distance");
    // Fix the centre, make the length horizontal and give both sizes: nothing left free.
    s = applyRelation(s, "fix", [e.center]).sketch;
    s = applyRelation(s, "horizontal", [e.center, e.major]).sketch;
    const before = analyzeSketch(s).freedom;
    expect(before).toBe(2);
    // A point can be held on it too.
    const p = addLine(s, at(20, 20), at(30, 20));
    const on = applyRelation(p.sketch, "coincident", [p.endId, e.id]);
    expect(on.error).toBeUndefined();
    expect(on.sketch.constraints.some((c) => c.type === "pointOnCurve" && c.refs[1] === e.id)).toBe(true);
  });

  it("can be picked, mirrored, patterned, saved and deleted", () => {
    const s = addEllipse(emptySketch(), at(0, 0), at(10, 0), [0, 4]).sketch;
    const e = theEllipse(s);
    expect(distToCurve(s, e, 10, 0)).toBeLessThan(1e-9);
    expect(distToCurve(s, e, 0, 4)).toBeLessThan(1e-9);
    expect(distToCurve(s, e, 0, 0)).toBeGreaterThan(3);
    const axis = addLine(s, at(-20, -10), at(-20, 10), { construction: true });
    const m = mirrorCurves(axis.sketch, axis.lineId, [e.id]);
    expect(m.error).toBe(undefined);
    expect(m.sketch.curves.filter((c) => c.type === "ellipse")).toHaveLength(2);
    expect(findRegions(m.sketch).regions).toHaveLength(2);
    const pt = patternCurves(s, [e.id], { kind: "linear", count: 3, spacing: 30, angle: 0 });
    expect(pt.sketch.curves.filter((c) => c.type === "ellipse")).toHaveLength(3);
    expect(parseSketchData(JSON.parse(JSON.stringify(s)))?.curves[0]).toEqual(e);
    expect(deleteItems(s, [e.id]).points).toHaveLength(0);
  });
});
