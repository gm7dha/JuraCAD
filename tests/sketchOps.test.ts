import { describe, expect, it } from "vitest";

import {
  addArc,
  addCircle,
  addDimension,
  addLine,
  addPoint,
  addRectangle,
  applyRelation,
  circleThrough,
  deleteItems,
  dimensionFor,
  dragCircleRim,
  dragCurve,
  dragPoint,
  measure,
  moveDimensionLabel,
  pointPos,
  setDimensionValue,
  toggleConstruction,
} from "../src/sketch/ops";
import { dimensionLayout } from "../src/sketch/layout";
import { findRegions } from "../src/sketch/regions";
import { analyzeSketch, solveSketch } from "../src/sketch/solver";
import { emptySketch, ORIGIN_ID, type SketchArc, type SketchCircle, type SketchLine } from "../src/sketch/types";

const lineOf = (s: ReturnType<typeof emptySketch>, id: string) => s.curves.find((c) => c.id === id) as SketchLine;

describe("drawing", () => {
  it("draws a rectangle with square corners, snapped to the origin", () => {
    const r = addRectangle(emptySketch(), { x: 0.2, y: 0.1, snap: { kind: "origin" } }, { x: 40, y: 30 });
    expect(r.error).toBeUndefined();
    expect(r.sketch.curves).toHaveLength(4);
    expect(r.sketch.points).toHaveLength(4);
    expect(r.sketch.constraints.filter((c) => c.type === "horizontal")).toHaveLength(2);
    // The snapped corner moved onto the origin.
    const corner = lineOf(r.sketch, r.lineIds[0]).p1;
    expect(pointPos(r.sketch, corner)[0]).toBeCloseTo(0, 6);
    expect(pointPos(r.sketch, corner)[1]).toBeCloseTo(0, 6);
    expect(findRegions(r.sketch).regions).toHaveLength(1);
    // Free to stretch in width and height only.
    expect(analyzeSketch(r.sketch).freedom).toBe(2);
  });

  it("chains lines through shared points and closes the shape", () => {
    let s = emptySketch();
    const l1 = addLine(s, { x: 0, y: 0 }, { x: 30, y: 0 }, { orientation: "horizontal" });
    s = l1.sketch;
    const l2 = addLine(s, { x: 30, y: 0, snap: { kind: "point", id: l1.endId } }, { x: 15, y: 20 });
    s = l2.sketch;
    const start = lineOf(s, l1.lineId).p1;
    const l3 = addLine(s, { x: 15, y: 20, snap: { kind: "point", id: l2.endId } }, { x: 0, y: 0, snap: { kind: "point", id: start } });
    s = l3.sketch;
    expect(s.points).toHaveLength(3);
    expect(findRegions(s).regions).toHaveLength(1);
  });

  it("attaches a point to a line it was drawn on", () => {
    const base = addLine(emptySketch(), { x: 0, y: 0 }, { x: 40, y: 0 });
    const p = addPoint(base.sketch, { x: 12, y: 0.3, snap: { kind: "curve", id: base.lineId } });
    expect(p.sketch.constraints.some((c) => c.type === "pointOnLine")).toBe(true);
    // The point now lies exactly on the (possibly slightly tilted) line.
    const l = lineOf(p.sketch, base.lineId);
    const [ax, ay] = pointPos(p.sketch, l.p1);
    const [bx, by] = pointPos(p.sketch, l.p2);
    const [px, py] = pointPos(p.sketch, p.pointId);
    expect((bx - ax) * (py - ay) - (by - ay) * (px - ax)).toBeCloseTo(0, 6);
  });

  it("draws circles and three-point arcs", () => {
    const c = addCircle(emptySketch(), { x: 5, y: 5 }, 8);
    expect((c.sketch.curves[0] as SketchCircle).radius).toBe(8);

    // Arc bulging upwards from (-10,0) to (10,0) through (0,10): centre at the origin.
    const a = addArc(emptySketch(), { x: -10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 });
    expect(a.error).toBeUndefined();
    const arc = a.sketch.curves[0] as SketchArc;
    const centre = pointPos(a.sketch, arc.center);
    expect(centre[0]).toBeCloseTo(0, 6);
    expect(centre[1]).toBeCloseTo(0, 6);
    // Anticlockwise from start to end goes over the top: start is the right-hand end.
    expect(pointPos(a.sketch, arc.start)[0]).toBeCloseTo(10, 6);

    expect(addArc(emptySketch(), { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }).error).toMatch(/in a line/);
    expect(circleThrough([1, 0], [0, 1], [-1, 0])).toEqual([0, 0]);
  });

  it("refuses degenerate shapes", () => {
    expect(addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 0, y: 10 }).error).toBeTruthy();
    expect(addCircle(emptySketch(), { x: 0, y: 0 }, 0).error).toBeTruthy();
  });
});

describe("constraints and dimensions", () => {
  it("dimensions a rectangle and changes the size by typing", () => {
    const r = addRectangle(emptySketch(), { x: 0, y: 0, snap: { kind: "origin" } }, { x: 40, y: 30 });
    const width = addDimension(r.sketch, [r.lineIds[0]]);
    expect(width.error).toBeUndefined();
    const dim = width.sketch.constraints.find((c) => c.id === width.dimensionId)!;
    expect(dim.type).toBe("length");
    expect(dim.value).toBe("40");

    const changed = setDimensionValue(width.sketch, width.dimensionId, "50 + 5");
    expect(changed.error).toBeUndefined();
    expect(measure(changed.sketch, dim)).toBeCloseTo(55, 6);

    const height = addDimension(changed.sketch, [r.lineIds[1]]);
    expect(analyzeSketch(height.sketch).freedom).toBe(0);

    // Fully defined: a further dimension only shows the size (a reference dimension).
    const extra = addDimension(height.sketch, [r.lineIds[2]]);
    expect(extra.error).toBeUndefined();
    expect(extra.driven).toBe(true);
    expect(analyzeSketch(extra.sketch).freedom).toBe(0);

    expect(setDimensionValue(height.sketch, width.dimensionId, "-3").error).toBeTruthy();
    expect(setDimensionValue(height.sketch, width.dimensionId, "abc").error).toBeTruthy();
  });

  it("picks the right dimension for what's selected", () => {
    const r = addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 40, y: 30 });
    const [bottom, right, top] = r.lineIds;
    const corner = lineOf(r.sketch, bottom).p1;
    const far = lineOf(r.sketch, right).p2;
    expect((dimensionFor(r.sketch, [corner, far]) as { type: string }).type).toBe("distance");
    expect((dimensionFor(r.sketch, [bottom, top]) as { type: string }).type).toBe("pointLineDistance");
    expect((dimensionFor(r.sketch, [bottom, right]) as { type: string }).type).toBe("angle");
    const c = addCircle(emptySketch(), { x: 0, y: 0 }, 5);
    expect((dimensionFor(c.sketch, [c.circleId]) as { type: string }).type).toBe("diameter");
    expect(typeof dimensionFor(c.sketch, [])).toBe("string");
  });

  it("applies relations and refuses conflicts", () => {
    let s = addLine(emptySketch(), { x: 0, y: 0 }, { x: 30, y: 4 }).sketch;
    const l1 = s.curves[0].id;
    const l2r = addLine(s, { x: 0, y: 10 }, { x: 25, y: 18 });
    s = l2r.sketch;
    const parallel = applyRelation(s, "parallel", [l1, l2r.lineId]);
    expect(parallel.error).toBeUndefined();
    const h = applyRelation(parallel.sketch, "horizontal", [l1]);
    expect(h.error).toBeUndefined();
    const second = lineOf(h.sketch, l2r.lineId);
    expect(pointPos(h.sketch, second.p1)[1]).toBeCloseTo(pointPos(h.sketch, second.p2)[1], 6);

    expect(applyRelation(h.sketch, "vertical", [l1]).error).toMatch(/conflict|nothing/);
    expect(applyRelation(h.sketch, "horizontal", [l2r.lineId]).error).toMatch(/already set/);
    expect(applyRelation(h.sketch, "tangent", [l1]).error).toMatch(/Select/);
  });

  it("makes circles tangent and equal", () => {
    let s = addCircle(emptySketch(), { x: 0, y: 0 }, 10).sketch;
    const k1 = s.curves[0].id;
    const k2r = addCircle(s, { x: 30, y: 5 }, 4);
    s = k2r.sketch;
    s = applyRelation(s, "equal", [k1, k2r.circleId]).sketch;
    const t = applyRelation(s, "tangent", [k1, k2r.circleId]);
    expect(t.error).toBeUndefined();
    const [ax, ay] = pointPos(t.sketch, (t.sketch.curves[0] as SketchCircle).center);
    const [bx, by] = pointPos(t.sketch, (t.sketch.curves[1] as SketchCircle).center);
    const r1 = (t.sketch.curves[0] as SketchCircle).radius;
    expect(Math.hypot(bx - ax, by - ay)).toBeCloseTo(2 * r1, 5);
  });

  it("fixes geometry in place", () => {
    const r = addLine(emptySketch(), { x: 1, y: 2 }, { x: 11, y: 2 });
    const f = applyRelation(r.sketch, "fix", [r.lineId]);
    expect(analyzeSketch(f.sketch).freedom).toBe(0);
    const moved = dragPoint(f.sketch, r.endId, 50, 50);
    expect(pointPos(moved, r.endId)[0]).toBeCloseTo(11, 6);
  });
});

describe("editing", () => {
  it("drags points, whole lines and circle rims", () => {
    const r = addRectangle(emptySketch(), { x: 0, y: 0, snap: { kind: "origin" } }, { x: 40, y: 30 });
    const topRight = lineOf(r.sketch, r.lineIds[1]).p2;
    const dragged = dragPoint(r.sketch, topRight, 60, 50);
    expect(pointPos(dragged, topRight)[0]).toBeCloseTo(60, 5);
    // Still a rectangle.
    const bottomRight = lineOf(dragged, r.lineIds[1]).p1;
    expect(pointPos(dragged, bottomRight)[0]).toBeCloseTo(60, 5);
    expect(pointPos(dragged, bottomRight)[1]).toBeCloseTo(0, 5);

    // Drag the top edge up by 10: it stays horizontal, the bottom stays put.
    const moved = dragCurve(dragged, r.lineIds[2], 0, 10);
    expect(pointPos(moved, topRight)[1]).toBeCloseTo(60, 5);
    expect(pointPos(moved, bottomRight)[1]).toBeCloseTo(0, 5);

    const c = addCircle(emptySketch(), { x: 0, y: 0 }, 5);
    expect((dragCircleRim(c.sketch, c.circleId, 12).curves[0] as SketchCircle).radius).toBeCloseTo(12, 5);
  });

  it("deletes lines with their unused points and constraints", () => {
    const r = addRectangle(emptySketch(), { x: 0, y: 0, snap: { kind: "origin" } }, { x: 40, y: 30 });
    const d = addDimension(r.sketch, [r.lineIds[0]]);
    const after = deleteItems(d.sketch, [r.lineIds[0]]);
    expect(after.curves).toHaveLength(3);
    expect(after.points).toHaveLength(4); // all corners still used by the other sides
    expect(after.constraints.some((c) => c.type === "length")).toBe(false);
    const all = deleteItems(after, after.curves.map((c) => c.id));
    expect(all.points).toHaveLength(0);
    expect(all.constraints).toHaveLength(0);
  });

  it("toggles construction geometry, which isn't extruded", () => {
    const r = addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 40, y: 30 });
    const c = toggleConstruction(r.sketch, r.lineIds);
    expect(c.curves.every((x) => x.construction)).toBe(true);
    expect(findRegions(c).regions).toHaveLength(0);
    expect(toggleConstruction(c, r.lineIds).curves.every((x) => !x.construction)).toBe(true);
  });

  it("never edits the sketch it was given", () => {
    const r = addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 40, y: 30 });
    const before = JSON.stringify(r.sketch);
    dragPoint(r.sketch, r.sketch.points[2].id, 99, 99);
    addDimension(r.sketch, [r.lineIds[0]]);
    deleteItems(r.sketch, [r.lineIds[0]]);
    expect(JSON.stringify(r.sketch)).toBe(before);
    expect(ORIGIN_ID).toBe("origin");
  });

  it("turns a vertical line horizontal (and back) instead of squashing it", () => {
    let s = addLine(emptySketch(), { x: 0, y: 0 }, { x: 10, y: 5 }).sketch;
    const line = s.curves[0] as SketchLine;
    const v = applyRelation(s, "vertical", [line.id]);
    expect(v.error).toBe(undefined);
    const vid = v.sketch.constraints.find((c) => c.type === "vertical")!.id;
    // Delete the Vertical, then ask for Horizontal: the line swings round about its middle, same length.
    s = deleteItems(v.sketch, [vid]);
    const h = applyRelation(s, "horizontal", [line.id]);
    expect(h.error).toBe(undefined);
    const [ax, ay] = pointPos(h.sketch, line.p1);
    const [bx, by] = pointPos(h.sketch, line.p2);
    expect(ay).toBeCloseTo(by, 6);
    expect(Math.abs(bx - ax)).toBeCloseTo(5, 6);
    expect((ay + by) / 2).toBeCloseTo(2.5, 6);
    // And straight back to vertical.
    const hid = h.sketch.constraints.find((c) => c.type === "horizontal")!.id;
    const again = applyRelation(deleteItems(h.sketch, [hid]), "vertical", [line.id]);
    expect(again.error).toBe(undefined);
    expect(pointPos(again.sketch, line.p1)[0]).toBeCloseTo(pointPos(again.sketch, line.p2)[0], 6);
    expect(Math.abs(pointPos(again.sketch, line.p2)[1] - pointPos(again.sketch, line.p1)[1])).toBeCloseTo(5, 6);
  });

  it("angle dimensions measure the wedge the label sits in, drawn as an arc", () => {
    // Two lines joined end to end at (20, 0): one along X, the next off at 45°.
    let s = addLine(emptySketch(), { x: 0, y: 0 }, { x: 20, y: 0 }).sketch;
    const a = s.curves[0] as SketchLine;
    s = addLine(s, { x: 20, y: 0, snap: { kind: "point", id: a.p2 } }, { x: 30, y: 10 }).sketch;
    const b = s.curves[1] as SketchLine;
    // Label placed above-left of the corner: inside the 135° wedge between the first line (going back) and the second.
    const inside = addDimension(s, [a.id, b.id], { x: -3, y: 3 });
    expect(inside.error).toBe(undefined);
    const dim = inside.sketch.constraints.find((c) => c.id === inside.dimensionId)!;
    expect(dim.value).toBe("135");
    expect(dim.extra!.slice(1)).toEqual([-1, 1]);
    // Placed above-right: the 45° wedge.
    const outside = addDimension(s, [a.id, b.id], { x: 3, y: 1 });
    expect(outside.sketch.constraints.find((c) => c.id === outside.dimensionId)!.value).toBe("45");
    // The arc runs round the corner at the label's distance, with the first line extended out to meet it.
    const layout = dimensionLayout(inside.sketch, dim)!;
    expect(layout.anchor).toEqual([20, 0]);
    const r = Math.hypot(3, 3);
    for (const [p] of layout.lines.slice(0, 8)) expect(Math.hypot(p[0] - 20, p[1])).toBeCloseTo(r, 6);
    expect(layout.lines.length).toBeGreaterThan(8);
    // Dragging the label into the other wedge re-measures it as 45° without moving the lines.
    const moved = moveDimensionLabel(inside.sketch, dim.id, { x: 3, y: 1 });
    const after = moved.constraints.find((c) => c.id === dim.id)!;
    expect(after.value).toBe("45");
    expect(after.extra!.slice(1)).toEqual([1, 1]);
    expect(pointPos(moved, b.p2)).toEqual(pointPos(inside.sketch, b.p2));
    // Setting the inside angle to 90° makes the lines square to each other (measured in that wedge).
    const square = setDimensionValue(inside.sketch, dim.id, "90");
    expect(square.error).toBe(undefined);
    expect(measure(square.sketch, square.sketch.constraints.find((c) => c.id === dim.id)!)).toBeCloseTo(90, 6);
    const [p1, p2] = [pointPos(square.sketch, a.p1), pointPos(square.sketch, a.p2)];
    const [q1, q2] = [pointPos(square.sketch, b.p1), pointPos(square.sketch, b.p2)];
    expect((p2[0] - p1[0]) * (q2[0] - q1[0]) + (p2[1] - p1[1]) * (q2[1] - q1[1])).toBeCloseTo(0, 6);
  });

  it("deleting a point takes the lines that end at it, leaving a sound sketch", () => {
    const r = addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 40, y: 20 });
    const corner = (r.sketch.curves[0] as SketchLine).p2;
    const after = deleteItems(r.sketch, [corner]);
    expect(after.curves).toHaveLength(2);
    expect(after.points.every((p) => after.curves.some((c) => c.type === "line" && (c.p1 === p.id || c.p2 === p.id)))).toBe(true);
    expect(after.constraints.every((c) => c.refs.every((id) => id === ORIGIN_ID || after.points.some((p) => p.id === id) || after.curves.some((x) => x.id === id)))).toBe(true);
    expect(solveSketch(after).ok).toBe(true);
  });
});
