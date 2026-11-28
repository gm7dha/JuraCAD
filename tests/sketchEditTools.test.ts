import { describe, expect, it } from "vitest";

import { addArc, addCircle, addDimension, addLine, addRectangle, measure, pointPos, radiusOf, setDimensionValue } from "../src/sketch/ops";
import { findChains, findRegions } from "../src/sketch/regions";
import { analyzeSketch, solveSketch } from "../src/sketch/solver";
import { filletCorner } from "../src/sketch/tools";
import { chamferCorner, cornerOfLines } from "../src/sketch/sketchChamfer";
import { filletBetween } from "../src/sketch/filletCurves";
import { halfWidthText, slotAlong } from "../src/sketch/slotAlong";
import { strokeCrossings, trimAlong } from "../src/sketch/trimStroke";
import { addEllipticalArc, ellipticalArcShape } from "../src/sketch/ellipticalArc";
import { emptySketch, type SketchArc, type SketchData, type SketchEllipse, type SketchLine } from "../src/sketch/types";
import { curveParam } from "../src/sketch/curves";

const at = (x: number, y: number) => ({ x, y });
const expectAt = (p: [number, number], x: number, y: number) => {
  expect(p[0]).toBeCloseTo(x, 6);
  expect(p[1]).toBeCloseTo(y, 6);
};
const lineLength = (s: SketchData, id: string) => {
  const l = s.curves.find((c) => c.id === id) as SketchLine;
  const [a, b] = [pointPos(s, l.p1), pointPos(s, l.p2)];
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
};

/** A 40 × 20 rectangle from the origin with both sizes dimensioned: fully defined. */
function definedRectangle() {
  const rect = addRectangle(emptySketch(), { x: 0, y: 0, snap: { kind: "origin" } }, at(40, 20));
  let s = addDimension(rect.sketch, [rect.lineIds[0]], { x: 0, y: -5 }).sketch;
  s = addDimension(s, [rect.lineIds[1]], { x: 5, y: 0 }).sketch;
  expect(analyzeSketch(s).freedom).toBe(0);
  const bottom = s.curves.find((c) => c.id === rect.lineIds[0]) as SketchLine;
  return { s, ids: rect.lineIds, corner: bottom.p2 };
}

describe("sketch chamfer", () => {
  it("equal distance: cuts the corner, keeps it fully defined and the width dimension measuring to the sharp", () => {
    const { s, ids, corner } = definedRectangle();
    const r = chamferCorner(s, corner, { mode: "equal", distance: "5" });
    expect(r.error).toBeUndefined();
    expect(lineLength(r.sketch, r.lineId)).toBeCloseTo(5 * Math.SQRT2, 6);
    expect(lineLength(r.sketch, ids[0])).toBeCloseTo(35, 6);
    expectAt(pointPos(r.sketch, corner), 40, 0);
    expect(findRegions(r.sketch).regions[0].outer.area).toBeCloseTo(800 - 12.5, 4);
    expect(analyzeSketch(r.sketch).freedom).toBe(0);
    // One size dimension, held on the construction line to the sharp.
    const dims = r.sketch.constraints.filter((c) => c.type === "length" && c.refs[0] === r.sizeLineId);
    expect(dims).toHaveLength(1);
    const bigger = setDimensionValue(r.sketch, dims[0].id, "8");
    expect(bigger.error).toBeUndefined();
    expect(lineLength(bigger.sketch, r.lineId)).toBeCloseTo(8 * Math.SQRT2, 5);
  });

  it("two distances and distance + angle", () => {
    const { s, corner } = definedRectangle();
    const two = chamferCorner(s, corner, { mode: "two", distance: "6", distance2: "3" });
    expect(two.error).toBeUndefined();
    expect(findRegions(two.sketch).regions[0].outer.area).toBeCloseTo(800 - 9, 4);
    expect(analyzeSketch(two.sketch).freedom).toBe(0);
    const ang = chamferCorner(s, corner, { mode: "angle", distance: "6", angle: "30" });
    expect(ang.error).toBeUndefined();
    // Right corner: the second side is 6·tan 30°.
    const second = 6 * Math.tan(Math.PI / 6);
    expect(findRegions(ang.sketch).regions[0].outer.area).toBeCloseTo(800 - (6 * second) / 2, 4);
    expect(analyzeSketch(ang.sketch).freedom).toBe(0);
    expect(ang.sketch.constraints.some((c) => c.type === "angle" && c.value === "30")).toBe(true);
  });

  it("later chamfers in Equal mode are kept Equal to the first, with one dimension", () => {
    const { s, ids } = definedRectangle();
    const corners = ids.map((id) => (s.curves.find((c) => c.id === id) as SketchLine).p2);
    const one = chamferCorner(s, corners[0], { mode: "equal", distance: "4" });
    const two = chamferCorner(one.sketch, corners[1], { mode: "equal", distance: "4", equalTo: one.sizeLineId });
    expect(two.error).toBeUndefined();
    expect(two.sketch.constraints.filter((c) => c.type === "length" && (c.refs[0] === one.sizeLineId || c.refs[0] === two.sizeLineId))).toHaveLength(1);
    expect(analyzeSketch(two.sketch).freedom).toBe(0);
    const dim = two.sketch.constraints.find((c) => c.type === "length" && c.refs[0] === one.sizeLineId)!;
    const changed = setDimensionValue(two.sketch, dim.id, "6").sketch;
    expect(lineLength(changed, two.lineId)).toBeCloseTo(6 * Math.SQRT2, 5);
  });

  it("refuses plainly when too big, and arcs", () => {
    const { s, corner } = definedRectangle();
    expect(chamferCorner(s, corner, { mode: "equal", distance: "25" }).error).toMatch(/too big/);
    expect(chamferCorner(s, corner, { mode: "angle", distance: "5", angle: "95" }).error).toMatch(/angle is too big/);
    expect(chamferCorner(s, corner, { mode: "equal", distance: "0" }).error).toMatch(/more than 0/);
  });

  it("two lines that don't meet are joined at their corner first", () => {
    let s = addLine(emptySketch(), at(0, 0), at(10, 0)).sketch;
    const r2 = addLine(s, at(20, 5), at(20, 30));
    s = r2.sketch;
    const [l1, l2] = s.curves.map((c) => c.id);
    const corner = cornerOfLines(s, l1, [5, 0], l2, [20, 20]);
    expect(corner.error).toBeUndefined();
    expectAt(pointPos(corner.sketch, corner.pointId), 20, 0);
    const c = chamferCorner(corner.sketch, corner.pointId, { mode: "equal", distance: "2" });
    expect(c.error).toBeUndefined();
    expect(lineLength(c.sketch, l1)).toBeCloseTo(18, 6);
    expect(lineLength(c.sketch, l2)).toBeCloseTo(28, 6);
  });
});

describe("round between two curves", () => {
  it("rounds between two lines that don't meet, trimming to the round", () => {
    let s = addLine(emptySketch(), at(0, 0), at(30, 0)).sketch;
    s = addLine(s, at(20, 10), at(20, 40)).sketch;
    const [l1, l2] = s.curves.map((c) => c.id);
    const r = filletBetween(s, l1, [5, 0], l2, [20, 30], "5");
    expect(r.error).toBeUndefined();
    const arc = r.sketch.curves.find((c) => c.id === r.arcId) as SketchArc;
    expect(radiusOf(r.sketch, arc)).toBeCloseTo(5, 6);
    expectAt(pointPos(r.sketch, arc.center), 15, 5);
    expect(lineLength(r.sketch, l1)).toBeCloseTo(15, 6);
    expect(lineLength(r.sketch, l2)).toBeCloseTo(35, 6);
    expect(r.sketch.constraints.some((c) => c.type === "radius" && c.refs[0] === r.arcId)).toBe(true);
    expect(solveSketch(r.sketch).ok).toBe(true);
  });

  it("rounds between a line and a circle's arc apart from it, and keeps later rounds Equal", () => {
    let s = addLine(emptySketch(), at(-20, 0), at(20, 0)).sketch;
    s = addArc(s, at(0, 20), at(-10, 10), at(-7.0710678, 17.0710678)).sketch; // arc of radius 10 round (0, 10), left half going up
    const ids = s.curves.map((c) => c.id);
    const r = filletBetween(s, ids[0], [-15, 0], ids[1], [-10, 10], "3");
    expect(r.error).toBeUndefined();
    const arc = r.sketch.curves.find((c) => c.id === r.arcId) as SketchArc;
    expect(radiusOf(r.sketch, arc)).toBeCloseTo(3, 5);
    // Second round, same size: Equal to the first.
    let t = addLine(r.sketch, at(40, 0), at(60, 0)).sketch;
    t = addLine(t, at(70, 10), at(70, 30)).sketch;
    const [a, b] = t.curves.slice(-2).map((c) => c.id);
    const r2 = filletBetween(t, a, [45, 0], b, [70, 25], "3", r.arcId);
    expect(r2.error).toBeUndefined();
    expect(r2.sketch.constraints.some((c) => c.type === "equal" && c.refs.includes(r.arcId) && c.refs.includes(r2.arcId))).toBe(true);
    expect(r2.sketch.constraints.some((c) => c.type === "radius" && c.refs[0] === r2.arcId)).toBe(false);
  });

  it("filletCorner keeps later rounds Equal to the first", () => {
    const { s, ids } = definedRectangle();
    const corners = ids.map((id) => (s.curves.find((c) => c.id === id) as SketchLine).p2);
    const one = filletCorner(s, corners[0], "3");
    const two = filletCorner(one.sketch, corners[1], "3", one.arcId);
    expect(two.sketch.constraints.filter((c) => c.type === "radius")).toHaveLength(1);
    expect(analyzeSketch(two.sketch).freedom).toBe(0);
  });

  it("takes circles too, and refuses a radius that can't touch both", () => {
    let s = addLine(emptySketch(), at(0, 0), at(30, 0)).sketch;
    s = addCircle(s, at(10, 20), 5).sketch;
    const [l, c] = s.curves.map((k) => k.id);
    expect(filletBetween(s, l, [0, 0], c, [10, 15], "2").error).toMatch(/radius/);
    expect(filletBetween(s, l, [0, 0], c, [10, 15], "10").error).toBeUndefined();
  });
});

describe("slot along a curve", () => {
  it("halves the width text", () => {
    expect(halfWidthText("6")).toBe("3");
    expect(halfWidthText("w")).toBe("(w) / 2");
  });

  it("along a line: two sides and round ends, one dimension, the line made construction", () => {
    const l = addLine(emptySketch(), { x: 0, y: 0, snap: { kind: "origin" } }, at(30, 0), { orientation: "horizontal" });
    let s = addDimension(l.sketch, [l.lineId], { x: 0, y: -5 }).sketch;
    expect(analyzeSketch(s).freedom).toBe(0);
    const r = slotAlong(s, l.lineId, "6");
    expect(r.error).toBeUndefined();
    s = r.sketch;
    expect((s.curves.find((c) => c.id === l.lineId) as SketchLine).construction).toBe(true);
    const regions = findRegions(s).regions;
    expect(regions).toHaveLength(1);
    expect(regions[0].outer.area).toBeCloseTo(30 * 6 + Math.PI * 9, 0);
    expect(s.constraints.filter((c) => c.type === "offset")).toHaveLength(1);
    // The one dimension is the slot's width (as Onshape shows it), measured across both sides.
    const dim = s.constraints.find((c) => c.id === r.dimensionId)!;
    expect(dim.value).toBe("6");
    expect(dim.doubled).toBe(true);
    expect(measure(s, dim)).toBeCloseTo(6, 6);
    expect(analyzeSketch(s).freedom).toBe(0);
    // Wider (8 across), and it follows when the line grows.
    const wider = setDimensionValue(s, r.dimensionId, "8");
    expect(findRegions(wider.sketch).regions[0].outer.area).toBeCloseTo(30 * 8 + Math.PI * 16, 0);
  });

  it("along an arc (an adjustment slot)", () => {
    const a = addArc(emptySketch(), at(20, 0), at(0, 20), at(14.1421356, 14.1421356)); // quarter circle radius 20 round the origin
    const r = slotAlong(a.sketch, a.arcId, "4");
    expect(r.error).toBeUndefined();
    const area = findRegions(r.sketch).regions[0].outer.area;
    // Quarter ring 18…22 plus two half discs of radius 2.
    expect(area).toBeCloseTo((Math.PI / 4) * (22 * 22 - 18 * 18) + Math.PI * 4, 0);
  });

  it("round a closed curve: two copies and no ends", () => {
    const c = addCircle(emptySketch(), at(0, 0), 10);
    const r = slotAlong(c.sketch, c.circleId, "4");
    expect(r.error).toBeUndefined();
    expect(r.curveIds).toHaveLength(2);
    const radii = r.curveIds.map((id) => radiusOf(r.sketch, r.sketch.curves.find((k) => k.id === id) as SketchArc)).sort((x, y) => x - y);
    expect(radii[0]).toBeCloseTo(8, 6);
    expect(radii[1]).toBeCloseTo(12, 6);
    expect(slotAlong(c.sketch, c.circleId, "30").error).toMatch(/too wide/);
  });
});

describe("drag-trim", () => {
  it("trims every piece the path crosses, in one go", () => {
    // Three upright lines crossed by a long horizontal one; drag across the middle line's top half and the right one's.
    let s = addLine(emptySketch(), at(0, 0), at(30, 0)).sketch;
    for (const x of [5, 15, 25]) s = addLine(s, at(x, -10), at(x, 10)).sketch;
    const path: [number, number][] = [
      [12, 5],
      [18, 6],
      [28, 5],
    ];
    expect(strokeCrossings(s, path).length).toBe(2);
    const r = trimAlong(s, path);
    expect(r.error).toBeUndefined();
    expect(r.trimmed).toBe(2);
    // Each crossed upright lost its top half.
    const uprights = r.sketch.curves.filter((c): c is SketchLine => c.type === "line" && Math.abs(pointPos(r.sketch, c.p1)[0] - pointPos(r.sketch, c.p2)[0]) < 1e-9);
    const tops = uprights.map((l) => Math.max(pointPos(r.sketch, l.p1)[1], pointPos(r.sketch, l.p2)[1]));
    expect(tops.filter((y) => y > 1)).toHaveLength(1);
    expect(trimAlong(s, [[100, 100], [110, 110]]).error).toMatch(/Drag across/);
  });
});

describe("elliptical arc", () => {
  it("passes through the start and runs the short way round to the end", () => {
    const shape = ellipticalArcShape([0, 0], [20, 0], [0, 10], [20, 0.5])!;
    expect(shape.g.ry).toBeCloseTo(10, 6);
    const r = addEllipticalArc(emptySketch(), at(0, 0), at(20, 0), at(0, 10), at(20, 1));
    expect(r.error).toBeUndefined();
    const el = r.sketch.curves.find((c) => c.id === r.ellipseId) as SketchEllipse;
    expect(el.start && el.end).toBeTruthy();
    const path = curveParam(r.sketch, el);
    // From the end near +x round to the top: a quarter of the ellipse, more or less.
    const ends = [path.at(path.lo), path.at(path.hi)];
    expect(ends.some((p) => Math.abs(p[1] - 10) < 1e-6)).toBe(true);
    expect(solveSketch(r.sketch).ok).toBe(true);
    expect(addEllipticalArc(emptySketch(), at(0, 0), at(20, 0), at(5, 0), at(0, 5)).error).toBeTruthy();
  });
});

describe("slot along a spline", () => {
  it("open spline: two copies and round ends", async () => {
    const { addSpline } = await import("../src/sketch/tools");
    const sp = addSpline(emptySketch(), [at(0, 0), at(10, 5), at(20, 0), at(30, 5)], false);
    const r = slotAlong(sp.sketch, sp.splineId, "2");
    expect(r.error).toBeUndefined();
    expect(r.curveIds).toHaveLength(4);
    expect(findRegions(r.sketch).regions).toHaveLength(1);
  });
});

describe("elliptical arc joins what its ends snap to", () => {
  it("start and end on existing line ends: one closed-off run, ends shared", () => {
    let s = addLine(emptySketch(), at(-10, 10), at(0, 10)).sketch;
    s = addLine(s, at(17, 5.5), at(30, 5.5)).sketch;
    const [l1, l2] = s.curves as SketchLine[];
    const r = addEllipticalArc(s, at(0, 0), at(20, 0), { x: 0, y: 10, snap: { kind: "point", id: l1.p2 } }, { x: 17, y: 5.5, snap: { kind: "point", id: l2.p1 } });
    expect(r.error).toBeUndefined();
    const el = r.sketch.curves.find((c) => c.id === r.ellipseId) as SketchEllipse;
    expect([el.start, el.end].sort()).toEqual([l1.p2, l2.p1].sort());
    const path = curveParam(r.sketch, el);
    for (const id of [l1.p2, l2.p1]) {
      const p = pointPos(r.sketch, id);
      const ends = [path.at(path.lo), path.at(path.hi)];
      expect(Math.min(...ends.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1])))).toBeLessThan(1e-6);
    }
    expect(findChains(r.sketch).chains).toHaveLength(1);
  });
});

describe("Equal to the first only while it's that size", () => {
  it("a round whose earlier one was resized gets its own dimension", () => {
    const { s, ids } = definedRectangle();
    const corners = ids.map((id) => (s.curves.find((c) => c.id === id) as SketchLine).p2);
    const one = filletCorner(s, corners[0], "3");
    const dim = one.sketch.constraints.find((c) => c.type === "radius")!;
    const resized = setDimensionValue(one.sketch, dim.id, "5").sketch;
    const two = filletCorner(resized, corners[1], "3", one.arcId);
    expect(two.sketch.constraints.filter((c) => c.type === "radius")).toHaveLength(2);
    expect(radiusOf(two.sketch, two.sketch.curves.find((c) => c.id === two.arcId) as SketchArc)).toBeCloseTo(3, 6);
    const c1 = chamferCorner(s, corners[0], { mode: "equal", distance: "4" });
    const cdim = c1.sketch.constraints.find((c) => c.type === "length" && c.refs[0] === c1.sizeLineId)!;
    const c2 = chamferCorner(setDimensionValue(c1.sketch, cdim.id, "6").sketch, corners[1], { mode: "equal", distance: "4", equalTo: c1.sizeLineId });
    expect(lineLength(c2.sketch, c2.sizeLineId)).toBeCloseTo(4, 6);
  });
});
