import { describe, expect, it } from "vitest";

import {
  addCircle,
  addDimension,
  addLine,
  addPoint,
  addRectangle,
  applyRelation,
  deleteItems,
  dimensionFor,
  dragPoint,
  joinPoints,
  measure,
  placedDistance,
  pointPos,
  radiusOf,
  setDimensionDriven,
  setDimensionValue,
  splinePath,
} from "../src/sketch/ops";
import { dimensionLayout } from "../src/sketch/layout";
import { findRegions } from "../src/sketch/regions";
import { analyzeSketch, solveSketch } from "../src/sketch/solver";
import { addCentreArc, addEllipse, addPolygon, addSlot, addSpline, extendAt, filletCorner, offsetCurves, polygonCorners, splitAt, trimAt } from "../src/sketch/tools";
import { parseSketchData } from "../src/sketch/validate";
import { emptySketch, type SketchArc, type SketchCircle, type SketchData, type SketchLine } from "../src/sketch/types";

const at = (x: number, y: number) => ({ x, y });
const line = (s: SketchData, id: string) => s.curves.find((c) => c.id === id) as SketchLine;
const lengthOf = (s: SketchData, id: string) => {
  const l = line(s, id);
  const [a, b] = [pointPos(s, l.p1), pointPos(s, l.p2)];
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
};
const areas = (s: SketchData) => findRegions(s).regions.map((r) => [r.outer.area, ...r.holes.map((h) => h.area)]);

describe("trim (fixes)", () => {
  it("trimming a polygon side doesn't pull the rest of the polygon out of shape", () => {
    const p = addPolygon(emptySketch(), at(0, 0), at(10, 0), 6);
    const cut = addLine(p.sketch, at(-20, 1), at(20, 1));
    const r = trimAt(cut.sketch, p.lineIds[0], at(9.5, 0.5));
    expect(r.error).toBeUndefined();
    // Every polygon point stays exactly where it was.
    for (const q of cut.sketch.points) {
      const now = r.sketch.points.find((k) => k.id === q.id);
      if (!now) continue;
      expect(Math.hypot(now.x - q.x, now.y - q.y)).toBeLessThan(1e-6);
    }
    // The trimmed side now runs from the crossing (y = 1) to its far corner.
    const side = line(r.sketch, p.lineIds[0]);
    const ys = [pointPos(r.sketch, side.p1)[1], pointPos(r.sketch, side.p2)[1]].sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(1, 6);
    expect(ys[1]).toBeCloseTo(10 * Math.sin(Math.PI / 3), 6);
  });

  it("trims a line back to where a spline crosses it, instead of deleting the whole line", () => {
    const l = addLine(emptySketch(), at(0, 0), at(20, 0));
    const sp = addSpline(l.sketch, [at(10, -5), at(10, 0), at(10, 5)], false);
    const r = trimAt(sp.sketch, l.lineId, at(15, 0));
    expect(r.error).toBeUndefined();
    expect(r.sketch.curves).toHaveLength(2);
    expect(lengthOf(r.sketch, l.lineId)).toBeCloseTo(10, 2);
  });

  it("trims a circle between the two places an ellipse crosses it", () => {
    const c = addCircle(emptySketch(), at(0, 0), 10);
    const e = addEllipse(c.sketch, at(10, 0), at(15, 0), [10, 3]);
    const r = trimAt(e.sketch, c.circleId, at(10, 0));
    expect(r.error).toBeUndefined();
    const arc = r.sketch.curves.find((k) => k.id === c.circleId) as SketchArc;
    expect(arc.type).toBe("arc");
    // The kept arc goes the long way round (the bit inside the ellipse is gone).
    const [sx, sy] = pointPos(r.sketch, arc.start);
    const [ex, ey] = pointPos(r.sketch, arc.end);
    expect(Math.hypot(sx, sy)).toBeCloseTo(10, 4);
    expect(Math.hypot(ex, ey)).toBeCloseTo(10, 4);
    expect(sy).toBeGreaterThan(0);
    expect(ey).toBeLessThan(0);
  });
});

describe("rounding a corner joined by dragging", () => {
  it("rounds a corner whose two lines were dragged together (separate end points held coincident)", () => {
    let s = addLine(emptySketch(), at(0, 0), at(10, 0)).sketch;
    s = addLine(s, at(10, 0.5), at(10, 10)).sketch;
    const [l1, l2] = s.curves as SketchLine[];
    s = joinPoints(s, l2.p1, l1.p2).sketch;
    const r = filletCorner(s, l1.p2, "2");
    expect(r.error).toBeUndefined();
    const arc = r.sketch.curves.find((c) => c.id === r.arcId) as SketchArc;
    expect(radiusOf(r.sketch, arc)).toBeCloseTo(2, 6);
    expect(lengthOf(r.sketch, l1.id)).toBeCloseTo(8, 6);
    expect(lengthOf(r.sketch, l2.id)).toBeCloseTo(8, 6);
    // The merged point is gone; nothing points at it.
    expect(r.sketch.points.some((p) => p.id === l2.p1)).toBe(false);
    expect(solveSketch(r.sketch).ok).toBe(true);
  });
});

describe("offset keeps its distance", () => {
  it("an inward offset of a rectangle follows when the rectangle is resized", () => {
    const rc = addRectangle(emptySketch(), at(0, 0), at(20, 10));
    // Its height is held, so only the width changes below.
    const tall = addDimension(rc.sketch, [rc.lineIds[1]], { x: 3, y: 0 });
    const o = offsetCurves(tall.sketch, rc.lineIds[0], at(5, 1), "2");
    expect(o.error).toBeUndefined();
    const offset = o.sketch.constraints.filter((c) => c.type === "offset");
    expect(offset).toHaveLength(1);
    expect(measure(o.sketch, offset[0])).toBeCloseTo(2, 6);
    const d = addDimension(o.sketch, [rc.lineIds[0]], { x: 0, y: -3 });
    const wider = setDimensionValue(d.sketch, d.dimensionId, "30");
    expect(wider.error).toBeUndefined();
    const [[outer, hole]] = areas(wider.sketch);
    expect(outer).toBeCloseTo(300, 6);
    expect(hole).toBeCloseTo(26 * 6, 4);
    // And the distance itself can be changed.
    const gap = setDimensionValue(wider.sketch, offset[0].id, "3");
    expect(gap.error).toBeUndefined();
    expect(areas(gap.sketch)[0][1]).toBeCloseTo(24 * 4, 4);
  });

  it("an offset slot (lines and arcs) keeps its distance", () => {
    const sl = addSlot(emptySketch(), at(0, 0), at(30, 0), 5);
    // Hold the original still, so the copy is what moves.
    const held = applyRelation(sl.sketch, "fix", sl.curveIds).sketch;
    const o = offsetCurves(held, sl.curveIds[0], at(15, 8), "2");
    const c = o.sketch.constraints.find((k) => k.type === "offset")!;
    const changed = setDimensionValue(o.sketch, c.id, "4");
    expect(changed.error).toBeUndefined();
    const [[outer, inner]] = areas(changed.sketch);
    expect(inner).toBeCloseTo(30 * 10 + Math.PI * 25, 0);
    expect(outer).toBeCloseTo(30 * 18 + Math.PI * 81, 0);
  });

  const roundedRect = () => {
    const rc = addRectangle(emptySketch(), at(0, 0), at(40, 20));
    let s = rc.sketch;
    for (const id of rc.lineIds) s = filletCorner(s, line(rc.sketch, id).p2, "3").sketch;
    return { s, lineIds: rc.lineIds };
  };

  it("offset copies can't flip over to the other side of the original", () => {
    const { s, lineIds } = roundedRect();
    const held = applyRelation(s, "fix", s.curves.map((c) => c.id)).sketch;
    const o = offsetCurves(held, lineIds[0], at(20, 1), "2");
    expect(o.error).toBeUndefined();
    // Nothing left to move: the copy is pinned by the offset.
    expect(analyzeSketch(o.sketch).freedom).toBe(0);
    const copyArcs = () => o.curveIds.map((id) => o.sketch.curves.find((c) => c.id === id)!).filter((c): c is SketchArc => c.type === "arc");
    expect(copyArcs()).toHaveLength(4);
    for (const a of copyArcs()) expect(radiusOf(o.sketch, a)).toBeCloseTo(1, 6);
    // Dragging a copy's corner hard outwards: it stays put rather than jumping to the far side.
    const copyLine = o.sketch.curves.find((c) => c.id === o.curveIds.find((id) => o.sketch.curves.find((k) => k.id === id)?.type === "line"))! as SketchLine;
    const dragged = dragPoint(o.sketch, copyLine.p1, -10, -10);
    for (const a of copyArcs()) expect(radiusOf(dragged, a)).toBeCloseTo(1, 6);
    // An inward gap bigger than the corners' radius can't be made: the corner copies would have to turn inside out.
    const gap = o.sketch.constraints.find((c) => c.type === "offset")!;
    expect(setDimensionValue(o.sketch, gap.id, "5").error).toBeDefined();
    const [[outer, pocket]] = areas(dragged);
    expect(outer).toBeGreaterThan(pocket);
    expect(pocket).toBeCloseTo(36 * 16 - (4 - Math.PI), 0);
  });

  it("a dragged offset line stays on its own side of the original", () => {
    const l = addLine(emptySketch(), at(0, 0), at(20, 0));
    const held = applyRelation(l.sketch, "fix", [l.lineId]).sketch;
    const o = offsetCurves(held, l.lineId, at(10, 1), "2");
    const copy = line(o.sketch, o.curveIds[0]);
    const dragged = dragPoint(o.sketch, copy.p1, 0, -3);
    expect(pointPos(dragged, copy.p1)[1]).toBeCloseTo(2, 6);
    expect(pointPos(dragged, copy.p2)[1]).toBeCloseTo(2, 6);
  });

  it("offsetting a slot or a rounded rectangle adds no new freedom", () => {
    const sl = addSlot(emptySketch(), at(0, 0), at(30, 0), 5);
    const before = analyzeSketch(sl.sketch).freedom;
    const o = offsetCurves(sl.sketch, sl.curveIds[0], at(15, 8), "2");
    expect(analyzeSketch(o.sketch).freedom).toBe(before);
    const { s, lineIds } = roundedRect();
    const o2 = offsetCurves(s, lineIds[0], at(20, 1), "2");
    expect(analyzeSketch(o2.sketch).freedom).toBe(analyzeSketch(s).freedom);
  });

  it("an offset circle grows with the original", () => {
    const c = addCircle(emptySketch(), at(0, 0), 10);
    const o = offsetCurves(c.sketch, c.circleId, at(13, 0), "2");
    const d = addDimension(o.sketch, [c.circleId], { x: 5, y: 5 });
    const r = setDimensionValue(d.sketch, d.dimensionId, "30");
    const copy = r.sketch.curves.find((k) => k.id === o.curveIds[0]) as SketchCircle;
    expect(copy.radius).toBeCloseTo(17, 6);
  });

  it("deleting one offset copy keeps the distance on the others", () => {
    const rc = addRectangle(emptySketch(), at(0, 0), at(20, 10));
    const o = offsetCurves(rc.sketch, rc.lineIds[0], at(5, 1), "2");
    const s = deleteItems(o.sketch, [o.curveIds[1]]);
    const c = s.constraints.find((k) => k.type === "offset");
    expect(c?.refs).toHaveLength(6);
    expect(solveSketch(s).ok).toBe(true);
  });
});

describe("dimensions across, up or straight", () => {
  const twoPoints = () => {
    let s = emptySketch();
    const a = addPoint(s, at(0, 0));
    s = a.sketch;
    const b = addPoint(s, at(10, 20));
    return { s: b.sketch, a: a.pointId, b: b.pointId };
  };

  it("picks horizontal above or below, vertical beside, straight in the corners", () => {
    expect(placedDistance([0, 0], [10, 20], { x: 0, y: 15 })).toBe("horizontalDistance");
    expect(placedDistance([0, 0], [10, 20], { x: 0, y: -15 })).toBe("horizontalDistance");
    expect(placedDistance([0, 0], [10, 20], { x: 12, y: 0 })).toBe("verticalDistance");
    expect(placedDistance([0, 0], [10, 20], { x: 12, y: -15 })).toBe("distance");
    expect(placedDistance([0, 0], [10, 20], { x: 0, y: 0 })).toBe("distance");
    // One slanted line: its own length anywhere beside it, across or up only past its ends.
    expect(placedDistance([0, 0], [100, 10], { x: -1, y: 10 }, true)).toBe("distance");
    expect(placedDistance([0, 0], [3, 4], { x: 20, y: -15 }, true)).toBe("distance");
    expect(placedDistance([0, 0], [100, 10], { x: 0, y: 30 }, true)).toBe("distance");
    expect(placedDistance([0, 0], [30, 40], { x: 0, y: 40 }, true)).toBe("horizontalDistance");
    // Level points: always a plain distance.
    expect(placedDistance([0, 0], [10, 0], { x: 0, y: 15 })).toBe("distance");
  });

  it("dimensions two points horizontally and then sets that distance", () => {
    const { s, a, b } = twoPoints();
    const r = addDimension(s, [a, b], { x: 0, y: 15 });
    const c = r.sketch.constraints.find((k) => k.id === r.dimensionId)!;
    expect(c.type).toBe("horizontalDistance");
    expect(c.value).toBe("10");
    const v = setDimensionValue(r.sketch, r.dimensionId, "15");
    expect(v.error).toBeUndefined();
    expect(pointPos(v.sketch, b)[0] - pointPos(v.sketch, a)[0]).toBeCloseTo(15, 6);
    // Its lines are square: extension lines straight up, the dimension line across.
    const layout = dimensionLayout(v.sketch, v.sketch.constraints.find((k) => k.id === r.dimensionId)!)!;
    const [, , dimLine] = layout.lines;
    expect(dimLine[0][1]).toBeCloseTo(dimLine[1][1], 9);
    expect(Math.abs(dimLine[1][0] - dimLine[0][0])).toBeCloseTo(15, 6);
  });

  it("dimensions two points vertically", () => {
    const { s, a, b } = twoPoints();
    const r = addDimension(s, [a, b], { x: -12, y: 0 });
    const c = r.sketch.constraints.find((k) => k.id === r.dimensionId)!;
    expect(c.type).toBe("verticalDistance");
    expect(c.value).toBe("20");
  });

  it("a slanted line's size can be dimensioned across", () => {
    const l = addLine(emptySketch(), at(0, 0), at(30, 40));
    const r = addDimension(l.sketch, [l.lineId], { x: 0, y: 40 });
    // Beside the line, between its ends: its length.
    const beside = addDimension(l.sketch, [l.lineId], { x: -8, y: 6 });
    expect(beside.sketch.constraints.find((k) => k.id === beside.dimensionId)!.type).toBe("length");
    expect(r.sketch.constraints.find((k) => k.id === r.dimensionId)!.type).toBe("horizontalDistance");
    // Placed right on the line, it's still the line's length.
    const plain = addDimension(l.sketch, [l.lineId]);
    const c = plain.sketch.constraints.find((k) => k.id === plain.dimensionId)!;
    expect(c.type).toBe("length");
    expect(c.value).toBe("50");
  });
});

describe("dimensions to circles and arcs", () => {
  it("measures between two circles' centres", () => {
    let s = addCircle(emptySketch(), at(0, 0), 3).sketch;
    s = addCircle(s, at(10, 0), 3).sketch;
    const [c1, c2] = s.curves as SketchCircle[];
    const spec = dimensionFor(s, [c1.id, c2.id]);
    expect(spec).toEqual({ type: "distance", refs: [c1.center, c2.center] });
    const r = addDimension(s, [c1.id, c2.id]);
    const v = setDimensionValue(r.sketch, r.dimensionId, "25");
    const [x1, y1] = pointPos(v.sketch, c1.center);
    const [x2, y2] = pointPos(v.sketch, c2.center);
    expect(Math.hypot(x2 - x1, y2 - y1)).toBeCloseTo(25, 6);
  });

  it("measures from the origin to a hole's centre, across and up", () => {
    const c = addCircle(emptySketch(), at(12, 7), 2);
    const across = addDimension(c.sketch, ["origin", c.circleId], { x: 0, y: -10 });
    const k = across.sketch.constraints.find((x) => x.id === across.dimensionId)!;
    expect(k.type).toBe("horizontalDistance");
    expect(k.value).toBe("12");
    const up = addDimension(across.sketch, ["origin", c.circleId], { x: 15, y: 0 });
    expect(up.sketch.constraints.find((x) => x.id === up.dimensionId)!.value).toBe("7");
  });

  it("measures from a line to a circle's centre", () => {
    const l = addLine(emptySketch(), at(0, 0), at(20, 0));
    const c = addCircle(l.sketch, at(5, 8), 2);
    const spec = dimensionFor(c.sketch, [l.lineId, c.circleId]) as { type: string; refs: string[] };
    expect(spec.type).toBe("pointLineDistance");
    const r = addDimension(c.sketch, [l.lineId, c.circleId]);
    expect(r.sketch.constraints.find((x) => x.id === r.dimensionId)!.value).toBe("8");
  });

  it("explains that circles sharing a centre are sized instead", () => {
    const c = addCircle(emptySketch(), at(0, 0), 3);
    const centre = (c.sketch.curves[0] as SketchCircle).center;
    const d = addCircle(c.sketch, { x: 0, y: 0, snap: { kind: "point", id: centre } }, 5);
    expect(dimensionFor(d.sketch, [c.circleId, d.circleId])).toMatch(/same centre/);
  });
});

describe("reference (driven) dimensions", () => {
  const sized = () => {
    const rc = addRectangle(emptySketch(), at(0, 0), at(20, 10));
    const w = addDimension(rc.sketch, [rc.lineIds[0]], { x: 0, y: -3 });
    return { rc, s: w.sketch, width: w.dimensionId };
  };

  it("a dimension that would over-define is added as a reference that follows the geometry", () => {
    const { rc, s, width } = sized();
    const r = addDimension(s, [rc.lineIds[2]], { x: 0, y: 3 });
    expect(r.error).toBeUndefined();
    expect(r.driven).toBe(true);
    const ref = r.sketch.constraints.find((c) => c.id === r.dimensionId)!;
    expect(ref.driven).toBe(true);
    expect(solveSketch(r.sketch).ok).toBe(true);
    expect(analyzeSketch(r.sketch).freedom).toBe(analyzeSketch(s).freedom);
    // It shows the size as it is now: the width changes, so does it.
    const v = setDimensionValue(r.sketch, width, "35");
    expect(v.error).toBeUndefined();
    expect(measure(v.sketch, ref)).toBeCloseTo(35, 6);
    // It can't be typed into.
    expect(setDimensionValue(v.sketch, ref.id, "12").error).toMatch(/just shows the size/);
    // Nor made driving while the width dimension sets the same size…
    expect(setDimensionDriven(v.sketch, ref.id, false).error).toMatch(/already set/);
    // …but it can once that's gone.
    const freed = deleteItems(v.sketch, [width]);
    const driving = setDimensionDriven(freed, ref.id, false);
    expect(driving.error).toBeUndefined();
    const now = driving.sketch.constraints.find((c) => c.id === ref.id)!;
    expect(now.driven).toBeUndefined();
    expect(now.value).toBe("35");
    expect(analyzeSketch(driving.sketch).freedom).toBe(analyzeSketch(freed).freedom - 1);
  });

  it("a driving dimension can be made a reference, freeing what it held", () => {
    const { s, width } = sized();
    const r = setDimensionDriven(s, width, true);
    expect(r.error).toBeUndefined();
    expect(analyzeSketch(r.sketch).freedom).toBe(analyzeSketch(s).freedom + 1);
  });

  it("with a conflict already in the sketch, says to fix that first instead of making a reference", () => {
    const { rc, s } = sized();
    // A clash: the top side forced to a different length from the bottom.
    const clash = { ...s, constraints: [...s.constraints, { id: "bad", type: "length" as const, refs: [rc.lineIds[2]], value: "5" }] };
    expect(solveSketch(clash).ok).toBe(false);
    const c = addCircle(clash, at(100, 100), 4);
    const r = addDimension(c.sketch, [c.circleId]);
    expect(r.driven).toBeUndefined();
    expect(r.error).toMatch(/red/);
    const ref = addDimension(s, [rc.lineIds[2]], { x: 0, y: 3 });
    const clashed = { ...ref.sketch, constraints: [...ref.sketch.constraints, { id: "bad", type: "length" as const, refs: [rc.lineIds[1]], value: "1", labelOffset: { x: 0, y: 0 } }, { id: "bad2", type: "length" as const, refs: [rc.lineIds[3]], value: "3" }] };
    expect(setDimensionDriven(clashed, ref.dimensionId, false).error).toMatch(/red/);
  });

  it("keeps a typed expression when it's switched to show-only and back", () => {
    const { s, width } = sized();
    const typed = setDimensionValue(s, width, "10 + 15");
    const shown = setDimensionDriven(typed.sketch, width, true);
    expect(shown.sketch.constraints.find((c) => c.id === width)!.value).toBe("10 + 15");
    const back = setDimensionDriven(shown.sketch, width, false);
    expect(back.error).toBeUndefined();
    expect(back.sketch.constraints.find((c) => c.id === width)!.value).toBe("10 + 15");
  });

  it("is kept when the sketch is saved and opened again", () => {
    const { rc, s } = sized();
    const r = addDimension(s, [rc.lineIds[2]], { x: 0, y: 3 });
    const back = parseSketchData(JSON.parse(JSON.stringify(r.sketch)))!;
    expect(back.constraints.find((c) => c.id === r.dimensionId)!.driven).toBe(true);
  });
});

describe("midpoint of an arc", () => {
  it("holds a point halfway round an arc, and keeps it there as the arc changes", () => {
    const sl = addSlot(emptySketch(), at(0, 0), at(30, 0), 5);
    const arc = sl.sketch.curves.find((c) => c.id === sl.curveIds[2]) as SketchArc;
    const p = addPoint(sl.sketch, at(-3, 1));
    const r = applyRelation(p.sketch, "midpoint", [p.pointId, arc.id]);
    expect(r.error).toBeUndefined();
    const halfway = (s: SketchData) => {
      const [cx, cy] = pointPos(s, arc.center);
      const [sx, sy] = pointPos(s, arc.start);
      const [ex, ey] = pointPos(s, arc.end);
      const a0 = Math.atan2(sy - cy, sx - cx);
      let a1 = Math.atan2(ey - cy, ex - cx);
      while (a1 <= a0) a1 += 2 * Math.PI;
      const rr = Math.hypot(sx - cx, sy - cy);
      return [cx + rr * Math.cos((a0 + a1) / 2), cy + rr * Math.sin((a0 + a1) / 2)];
    };
    const [px, py] = pointPos(r.sketch, p.pointId);
    const [hx, hy] = halfway(r.sketch);
    expect(px).toBeCloseTo(hx, 6);
    expect(py).toBeCloseTo(hy, 6);
    // On the far (left) side of the slot's left end, not the right.
    expect(px).toBeLessThan(pointPos(r.sketch, arc.center)[0]);
    // Widen the slot: the point stays halfway round.
    const d = addDimension(r.sketch, [arc.id], { x: -5, y: 5 });
    const wide = setDimensionValue(d.sketch, d.dimensionId, "9");
    expect(wide.error).toBeUndefined();
    expect(radiusOf(wide.sketch, arc)).toBeCloseTo(9, 6);
    const [qx, qy] = pointPos(wide.sketch, p.pointId);
    const [wx, wy] = halfway(wide.sketch);
    expect(qx).toBeCloseTo(wx, 6);
    expect(qy).toBeCloseTo(wy, 6);
    expect(applyRelation(r.sketch, "midpoint", [arc.start, arc.id]).error).toMatch(/own points/);
  });
});

describe("polygon sized across flats", () => {
  it("puts the pointer at the middle of a side, and sizes it like a nut", () => {
    const corners = polygonCorners([0, 0], [5, 0], 6, "flats");
    // The side between the first two corners has its middle at the pointer.
    expect((corners[0][0] + corners[1][0]) / 2).toBeCloseTo(5, 9);
    expect((corners[0][1] + corners[1][1]) / 2).toBeCloseTo(0, 9);
    const r = addPolygon(emptySketch(), at(0, 0), at(3, 0), 6, false, "flats");
    expect(r.error).toBeUndefined();
    expect(analyzeSketch(r.sketch).freedom).toBe(4);
    // An M3 nut is 5.5 mm across flats.
    const d = addDimension(r.sketch, [r.sizeCircleId!]);
    expect(d.sketch.constraints.find((c) => c.id === d.dimensionId)!.type).toBe("diameter");
    const nut = setDimensionValue(d.sketch, d.dimensionId, "5.5");
    expect(nut.error).toBeUndefined();
    const area = findRegions(nut.sketch).regions[0].outer.area;
    // A hexagon's area is (√3 / 2) × (across flats)².
    expect(area).toBeCloseTo((Math.sqrt(3) / 2) * 5.5 * 5.5, 6);
  });

  it("across corners is still the default, sized by the circle through the corners", () => {
    const r = addPolygon(emptySketch(), at(0, 0), at(10, 0), 6);
    const circle = r.sketch.curves.find((c) => c.id === r.sizeCircleId) as SketchCircle;
    expect(circle.radius).toBeCloseTo(10, 9);
  });

  it("a slot says which line is its centre line, to size its length", () => {
    const sl = addSlot(emptySketch(), at(0, 0), at(30, 0), 5);
    const axis = line(sl.sketch, sl.axisId!);
    expect(axis.construction).toBe(true);
    expect(lengthOf(sl.sketch, sl.axisId!)).toBeCloseTo(30, 9);
  });
});

describe("split and extend arcs", () => {
  // A quarter arc of radius 10 round the origin, from (10, 0) anticlockwise to (0, 10).
  const quarter = () => {
    const r = addCentreArc(emptySketch(), { x: 0, y: 0, snap: { kind: "origin" } }, at(10, 0), at(0, 10));
    return { s: r.sketch, arcId: r.arcId };
  };
  const ends = (s: SketchData, id: string) => {
    const a = s.curves.find((c) => c.id === id) as SketchArc;
    return [pointPos(s, a.start), pointPos(s, a.end)].map((p) => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6]);
  };

  it("splits an arc where it's clicked into two on the same circle", () => {
    const { s, arcId } = quarter();
    const r = splitAt(s, arcId, at(8, 7));
    expect(r.error).toBeUndefined();
    expect(r.lineIds).toHaveLength(2);
    const [a, b] = r.lineIds.map((id) => r.sketch.curves.find((c) => c.id === id) as SketchArc);
    expect(a.end).toBe(b.start);
    expect(a.center).toBe(b.center);
    const [mx, my] = pointPos(r.sketch, a.end);
    expect(Math.hypot(mx, my)).toBeCloseTo(10, 6);
    expect(Math.atan2(my, mx)).toBeCloseTo(Math.atan2(7, 8), 6);
    // Too near an end.
    expect(splitAt(s, arcId, at(10, 0.01)).error).toMatch(/further from/);
  });

  it("a radius dimension still sizes both pieces after a split", () => {
    const { s, arcId } = quarter();
    const d = addDimension(s, [arcId], { x: 5, y: 5 });
    const r = splitAt(d.sketch, arcId, at(8, 7));
    const v = setDimensionValue(r.sketch, d.dimensionId, "15");
    expect(v.error).toBeUndefined();
    for (const id of r.lineIds) expect(radiusOf(v.sketch, v.sketch.curves.find((c) => c.id === id) as SketchArc)).toBeCloseTo(15, 6);
  });

  it("extends an arc round its circle to the next line, from either end", () => {
    const { s, arcId } = quarter();
    const wall = addLine(s, at(-20, 6), at(20, 6), { construction: false });
    // From its end (0, 10) anticlockwise... nothing until the line y = 6 on the left.
    const left = extendAt(wall.sketch, arcId, at(1, 10));
    expect(left.error).toBeUndefined();
    expect(ends(left.sketch, arcId)[1]).toEqual([-8, 6]);
    // From its start (10, 0) clockwise round to y = -… : add a line below.
    const floor = addLine(s, at(-20, -6), at(20, -6));
    const down = extendAt(floor.sketch, arcId, at(10, 1));
    expect(down.error).toBeUndefined();
    expect(ends(down.sketch, arcId)[0]).toEqual([8, -6]);
    expect(down.sketch.constraints.some((c) => c.type === "pointOnLine" && c.refs[1] === floor.lineId)).toBe(true);
    expect(extendAt(s, arcId, at(10, 1)).error).toMatch(/nothing further/);
  });

  it("explains that circles can't be split", () => {
    const c = addCircle(emptySketch(), at(0, 0), 5);
    expect(splitAt(c.sketch, c.circleId, at(5, 0)).error).toMatch(/Trim/);
  });
});

describe("rounding where a line meets an arc", () => {
  it("rounds the corner between a line and an arc, touching both smoothly", () => {
    // A line along the X axis to the origin; an arc round (10, 0) from (10, 10) down to the origin.
    const l = addLine(emptySketch(), at(-10, 0), { x: 0, y: 0, snap: { kind: "origin" } });
    const corner = line(l.sketch, l.lineId).p2;
    const arcMade = addCentreArc(l.sketch, at(10, 0), at(10, 10), { x: 0, y: 0, snap: { kind: "point", id: corner } });
    expect(arcMade.error).toBeUndefined();
    const r = filletCorner(arcMade.sketch, corner, "2");
    expect(r.error).toBeUndefined();
    const fillet = r.sketch.curves.find((c) => c.id === r.arcId) as SketchArc;
    expect(radiusOf(r.sketch, fillet)).toBeCloseTo(2, 6);
    const [fx, fy] = pointPos(r.sketch, fillet.center);
    expect(fx).toBeCloseTo(10 - Math.sqrt(140), 5);
    expect(fy).toBeCloseTo(2, 5);
    // The line now stops under the rounding's centre, and the corner is kept as a point for dimensions.
    expect(lengthOf(r.sketch, l.lineId)).toBeCloseTo(10 - Math.sqrt(140) + 10, 5);
    expect(pointPos(r.sketch, corner)[0]).toBeCloseTo(0, 6);
    // The old arc ends where the rounding touches it (12 from its centre through the rounding's centre).
    const arc = r.sketch.curves.find((c) => c.id === arcMade.arcId) as SketchArc;
    expect(radiusOf(r.sketch, arc)).toBeCloseTo(10, 6);
    const touching = [arc.start, arc.end].some((id) => fillet.start === id || fillet.end === id);
    expect(touching).toBe(true);
    // Bigger radius: still touching the arc from outside.
    const bigger = setDimensionValue(r.sketch, r.sketch.constraints.find((c) => c.type === "radius" && c.refs[0] === r.arcId)!.id, "3");
    expect(bigger.error).toBeUndefined();
    const [gx, gy] = pointPos(bigger.sketch, fillet.center);
    const [cx, cy] = pointPos(bigger.sketch, arc.center);
    expect(Math.hypot(gx - cx, gy - cy)).toBeCloseTo(radiusOf(bigger.sketch, arc) + 3, 6);
    const ln = line(bigger.sketch, l.lineId);
    const [ax, ay] = pointPos(bigger.sketch, ln.p1);
    const [bx, by] = pointPos(bigger.sketch, ln.p2);
    expect(Math.abs((bx - ax) * (gy - ay) - (by - ay) * (gx - ax)) / Math.hypot(bx - ax, by - ay)).toBeCloseTo(3, 6);
  });

  it("rounds the corner where two arcs meet", () => {
    // One arc round (0, 10) leaving the origin to the right, another round (−10, 0) leaving it upwards.
    const a = addCentreArc(emptySketch(), at(0, 10), { x: 0, y: 0, snap: { kind: "origin" } }, at(10, 10));
    const arcA = a.sketch.curves.find((c) => c.id === a.arcId) as SketchArc;
    const corner = arcA.start;
    const b = addCentreArc(a.sketch, at(-10, 0), { x: 0, y: 0, snap: { kind: "point", id: corner } }, at(-10, 10));
    const r = filletCorner(b.sketch, corner, "1");
    expect(r.error).toBeUndefined();
    const fillet = r.sketch.curves.find((c) => c.id === r.arcId) as SketchArc;
    const [fx, fy] = pointPos(r.sketch, fillet.center);
    const x = (-16 + Math.sqrt(392)) / 4;
    expect(fx).toBeCloseTo(x, 5);
    expect(fy).toBeCloseTo(2 - x, 5);
    expect(r.sketch.constraints.filter((c) => c.type === "tangent" && c.refs.includes(r.arcId)).map((c) => c.extra?.[0]).sort()).toEqual([0, 1]);
  });

  it("says when the radius doesn't fit", () => {
    const l = addLine(emptySketch(), at(-10, 0), { x: 0, y: 0, snap: { kind: "origin" } });
    const corner = line(l.sketch, l.lineId).p2;
    const arcMade = addCentreArc(l.sketch, at(10, 0), at(10, 10), { x: 0, y: 0, snap: { kind: "point", id: corner } });
    expect(filletCorner(arcMade.sketch, corner, "40").error).toMatch(/doesn't fit/);
  });
});

describe("overlapping shapes", () => {
  const plateWith = (add: (s: SketchData) => SketchData) => add(addRectangle(emptySketch(), at(0, 0), at(100, 100)).sketch);

  it("a notch drawn flush with any edge of a plate is still a hole", () => {
    for (const [a, b] of [
      [at(40, 0), at(60, 20)],
      [at(40, 80), at(60, 100)],
      [at(0, 40), at(20, 60)],
      [at(80, 40), at(100, 60)],
    ]) {
      const regions = findRegions(plateWith((s) => addRectangle(s, a, b).sketch)).regions;
      expect(regions).toHaveLength(1);
      expect(regions[0].holes).toHaveLength(1);
      expect(regions[0].holes[0].area).toBeCloseTo(400, 6);
    }
  });

  it("a triangle whose corners touch the plate's edges is a hole", () => {
    const s = plateWith((p) => {
      let t = addLine(p, at(50, 100), at(0, 50)).sketch;
      const first = t.curves[t.curves.length - 1] as SketchLine;
      t = addLine(t, { x: 0, y: 50, snap: { kind: "point", id: first.p2 } }, at(100, 50)).sketch;
      const second = t.curves[t.curves.length - 1] as SketchLine;
      return addLine(t, { x: 100, y: 50, snap: { kind: "point", id: second.p2 } }, { x: 50, y: 100, snap: { kind: "point", id: first.p1 } }).sketch;
    });
    const regions = findRegions(s).regions;
    expect(regions).toHaveLength(1);
    expect(regions[0].holes).toHaveLength(1);
    expect(regions[0].holes[0].area).toBeCloseTo(2500, 6);
  });

  it("two overlapping rectangles plus a hole in the overlap: the hole goes through both", () => {
    let s = addRectangle(emptySketch(), at(0, 40), at(100, 60)).sketch;
    s = addRectangle(s, at(40, 0), at(60, 100)).sketch;
    s = addCircle(s, at(50, 50), 5).sketch;
    const regions = findRegions(s).regions;
    expect(regions).toHaveLength(2);
    expect(regions.every((r) => r.holes.length === 1)).toBe(true);
  });

  it("two bars crossing where no corner or side's middle lands in the other still join", () => {
    let s = addRectangle(emptySketch(), at(0, 45), at(100, 55)).sketch;
    s = addRectangle(s, at(13, 0), at(17, 100)).sketch;
    s = addCircle(s, at(15, 50), 1).sketch;
    const regions = findRegions(s).regions;
    expect(regions).toHaveLength(2);
    expect(regions.every((r) => r.holes.length === 1)).toBe(true);
  });

  it("a circle overlapping either side of a rectangle joins onto it rather than cutting a notch", () => {
    for (const x of [0, 20]) {
      let s = addRectangle(emptySketch(), at(0, 0), at(20, 10)).sketch;
      s = addCircle(s, at(x, 5), 3).sketch;
      const regions = findRegions(s).regions;
      expect(regions).toHaveLength(2);
      expect(regions.every((r) => r.holes.length === 0)).toBe(true);
    }
  });

  it("a circle wholly inside (even touching a side) is still a hole", () => {
    let s = addRectangle(emptySketch(), at(0, 0), at(20, 10)).sketch;
    s = addCircle(s, at(10, 5), 5).sketch;
    const regions = findRegions(s).regions;
    expect(regions).toHaveLength(1);
    expect(regions[0].holes).toHaveLength(1);
  });
});

describe("points on splines and ellipses", () => {
  const onEllipse = (s: SketchData, id: string, pid: string) => {
    const e = s.curves.find((c) => c.id === id)!;
    if (e.type !== "ellipse") throw new Error("not an ellipse");
    const [cx, cy] = pointPos(s, e.center);
    const [mx, my] = pointPos(s, e.major);
    const [nx, ny] = pointPos(s, e.minor);
    const rx = Math.hypot(mx - cx, my - cy);
    const ry = Math.hypot(nx - cx, ny - cy);
    const [px, py] = pointPos(s, pid);
    const ux = (mx - cx) / rx, uy = (my - cy) / rx;
    const a = (px - cx) * ux + (py - cy) * uy;
    const b = -(px - cx) * uy + (py - cy) * ux;
    return Math.hypot(a / rx, b / ry);
  };

  it("holds a point on an ellipse with Coincident, and keeps it there when the ellipse is resized", () => {
    const e = addEllipse(emptySketch(), at(0, 0), at(10, 0), [0, 5]);
    const p = addPoint(e.sketch, at(6, 5));
    const r = applyRelation(p.sketch, "coincident", [p.pointId, e.ellipseId]);
    expect(r.error).toBeUndefined();
    expect(onEllipse(r.sketch, e.ellipseId, p.pointId)).toBeCloseTo(1, 6);
    const el = r.sketch.curves.find((c) => c.id === e.ellipseId)!;
    if (el.type !== "ellipse") throw new Error("not an ellipse");
    const moved = dragPoint(r.sketch, el.major, 20, 0);
    expect(onEllipse(moved, e.ellipseId, p.pointId)).toBeCloseTo(1, 6);
  });

  it("a line drawn to a spline stays on it when the spline is reshaped", () => {
    const sp = addSpline(emptySketch(), [at(0, 0), at(10, 5), at(20, 0)], false);
    const l = addLine(sp.sketch, at(10, -10), { x: 10, y: 4, snap: { kind: "curve", id: sp.splineId } });
    expect(l.sketch.constraints.some((c) => c.type === "pointOnCurve")).toBe(true);
    const spline = l.sketch.curves.find((c) => c.id === sp.splineId)!;
    if (spline.type !== "spline") throw new Error("not a spline");
    const moved = dragPoint(l.sketch, spline.points[1], 10, 9);
    const end = pointPos(moved, line(moved, l.lineId).p2);
    const path = splinePathOf(moved, sp.splineId);
    const gap = Math.min(...path.map(([x, y]) => Math.hypot(x - end[0], y - end[1])));
    expect(gap).toBeLessThan(0.05);
    expect(solveSketch(moved).ok).toBe(true);
  });

  it("extends a line up to a spline", () => {
    const sp = addSpline(emptySketch(), [at(0, 10), at(10, 12), at(20, 10)], false);
    const l = addLine(sp.sketch, at(10, 0), at(10, 3));
    const r = extendAt(l.sketch, l.lineId, at(10, 2.9));
    expect(r.error).toBeUndefined();
    expect(pointPos(r.sketch, line(r.sketch, l.lineId).p2)[1]).toBeGreaterThan(11);
    expect(r.sketch.constraints.some((c) => c.type === "pointOnCurve")).toBe(true);
  });
});

function splinePathOf(s: SketchData, id: string): [number, number][] {
  const c = s.curves.find((k) => k.id === id);
  if (c?.type !== "spline") return [];
  return splinePath(s, c, 64);
}
