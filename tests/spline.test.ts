import { describe, expect, it } from "vitest";

import { addLine, deleteItems, dimensionFor, pointPos, setSplineHandle, splineHandleEnds, splinePath, type Placed } from "../src/sketch/ops";
import { findRegions } from "../src/sketch/regions";
import { bezierAt, splineBeziers, splinePolyline, splineTangents } from "../src/sketch/spline";
import { addSpline, mirrorCurves, patternCurves, transformCurves } from "../src/sketch/tools";
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

describe("spline handles", () => {
  const three = () => {
    const r = addSpline(emptySketch(), [at(0, 0), at(10, 10), at(20, 0)], false);
    return { s: r.sketch, sp: r.sketch.curves.find((c) => c.type === "spline") as SketchSpline };
  };

  it("curve naturally until a handle is set, then follow the handle", () => {
    const { s, sp } = three();
    const pts = sp.points.map((id) => pointPos(s, id));
    // Natural tangent at the middle point: half the way from the first to the last.
    expect(splineTangents(pts, false)[1]).toEqual([10, 0]);
    // Set the middle handle straight up: the curve leaves the point going up.
    const shaped = setSplineHandle(s, sp.id, sp.points[1], [0, 12]);
    const c = shaped.curves[0] as SketchSpline;
    expect(c.tangents).toEqual({ [sp.points[1]]: [0, 12] });
    const pieces = splineBeziers(pts, false, undefined, c.points.map((id) => c.tangents?.[id]));
    expect(pieces[1][1]).toEqual([10, 14]);
    expect(pieces[0][2]).toEqual([10, 6]);
    // Still through every point.
    expect(bezierAt(pieces[1], 0)).toEqual(pts[1]);
    // Cleared again: back to natural.
    const cleared = setSplineHandle(shaped, sp.id, sp.points[1], null);
    expect((cleared.curves[0] as SketchSpline).tangents).toBe(undefined);
  });

  it("show handle ends a third of the tangent out from each point, only for selected splines", () => {
    const { s, sp } = three();
    expect(splineHandleEnds(s, [])).toHaveLength(0);
    const ends = splineHandleEnds(s, [sp.id]);
    expect(ends).toHaveLength(6);
    const mid = ends.filter((h) => h.pointId === sp.points[1]);
    expect(mid.map((h) => h.at)).toEqual([
      [10 + 10 / 3, 10],
      [10 - 10 / 3, 10],
    ]);
    // Selecting one of its points shows them too.
    expect(splineHandleEnds(s, [sp.points[0]])).toHaveLength(6);
  });

  it("handles go with copies, mirrors and moves, and are saved and loaded", () => {
    const { s, sp } = three();
    const shaped = setSplineHandle(s, sp.id, sp.points[1], [0, 12]);
    // Moved and turned 90°: the handle turns too.
    const turned = transformCurves(shaped, [sp.id], { dx: 0, dy: 0, angle: 90, copy: false });
    expect(turned.error).toBe(undefined);
    const t = (turned.sketch.curves.find((c) => c.type === "spline") as SketchSpline).tangents![sp.points[1]];
    expect(t[0]).toBeCloseTo(-12, 6);
    expect(t[1]).toBeCloseTo(0, 6);
    // Mirrored about a vertical line at x = 30: the handle (straight up) stays straight up on the copy.
    const withAxis = addLine(shaped, { x: 30, y: -5 }, { x: 30, y: 25 }).sketch;
    const axis = withAxis.curves.find((c) => c.type === "line")!;
    const m = mirrorCurves(withAxis, axis.id, [sp.id]);
    expect(m.error).toBe(undefined);
    const copy = m.sketch.curves.find((c) => c.type === "spline" && c.id !== sp.id) as SketchSpline;
    expect(Object.values(copy.tangents!)[0].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 12]);
    // Patterned copies keep the handle as it is.
    const p = patternCurves(shaped, [sp.id], { kind: "linear", count: 2, spacing: 50, angle: 0 });
    const pc = p.sketch.curves.find((c) => c.type === "spline" && c.id !== sp.id) as SketchSpline;
    expect(Object.values(pc.tangents!)).toEqual([[0, 12]]);
    // Round trip through save and load; handles for unknown points are dropped.
    const loaded = parseSketchData(JSON.parse(JSON.stringify(shaped)))!;
    expect((loaded.curves[0] as SketchSpline).tangents).toEqual({ [sp.points[1]]: [0, 12] });
    const junk = JSON.parse(JSON.stringify(shaped));
    junk.curves[0].tangents = { nope: [1, 2], [sp.points[0]]: [1, "x"] };
    expect((parseSketchData(junk)!.curves[0] as SketchSpline).tangents).toBe(undefined);
    // The drawn curve bends with the handle.
    const flat = splinePath(s, sp);
    const bent = splinePath(shaped, shaped.curves[0] as SketchSpline);
    expect(Math.max(...bent.map((q) => q[1]))).toBeGreaterThan(Math.max(...flat.map((q) => q[1])) + 0.5);
  });

  it("carry into the shapes made from the sketch", () => {
    // A closed spline (a rounded square) with one handle pulled hard to one side bulges that way.
    const r = addSpline(emptySketch(), [at(0, 0), at(20, 0), at(20, 20), at(0, 20)], true);
    const sp = r.sketch.curves[0] as SketchSpline;
    const plain = findRegions(r.sketch).regions[0];
    const shaped = setSplineHandle(r.sketch, sp.id, sp.points[1], [0, 60]);
    const bulged = findRegions(shaped).regions[0];
    // The curve arrives at that point from below now (its control sits at (20, −20)), so it dips under the square.
    const low = (reg: typeof plain) => Math.min(...reg.outer.polygon.map((q) => q[1]));
    expect(low(bulged)).toBeLessThan(low(plain) - 2);
    // An open spline closing a shape with a line, walked either way, uses the handles too.
    let s = addLine(emptySketch(), { x: 0, y: 0 }, { x: 20, y: 0 }).sketch;
    const open = addSpline(s, [{ x: 20, y: 0, snap: { kind: "point", id: s.curves[0].type === "line" ? s.curves[0].p2 : "" } }, at(10, 8), { x: 0, y: 0, snap: { kind: "point", id: s.curves[0].type === "line" ? s.curves[0].p1 : "" } }], false);
    s = open.sketch;
    const osp = s.curves.find((c) => c.type === "spline") as SketchSpline;
    const a1 = findRegions(s).regions[0];
    const pulled = setSplineHandle(s, osp.id, osp.points[1], [-30, 20]);
    const a2 = findRegions(pulled).regions[0];
    const top = (reg: typeof a1) => Math.max(...reg.outer.polygon.map((q) => q[1]));
    expect(a1.outer.polygon.length).toBeGreaterThan(5);
    expect(Math.abs(top(a2) - top(a1))).toBeGreaterThan(0.5);
  });

  it("deleting one of a spline's points takes it out of the spline", () => {
    const { s, sp } = three();
    const shaped = setSplineHandle(s, sp.id, sp.points[2], [5, 5]);
    const after = deleteItems(shaped, [sp.points[1]]);
    const left = after.curves[0] as SketchSpline;
    expect(left.points).toEqual([sp.points[0], sp.points[2]]);
    expect(left.tangents).toEqual({ [sp.points[2]]: [5, 5] });
    // Down to one point: the spline goes.
    expect(deleteItems(after, [sp.points[0]]).curves).toHaveLength(0);
  });
});
