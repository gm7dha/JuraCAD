import { describe, expect, it } from "vitest";

import { addArc, addCircle, addLine, applyRelation, pointPos, type Placed } from "../src/sketch/ops";
import { findRegions } from "../src/sketch/regions";
import { solveSketch } from "../src/sketch/solver";
import { mirrorCurves } from "../src/sketch/tools";
import { emptySketch, type SketchArc, type SketchData, type SketchLine } from "../src/sketch/types";
import { parseSketchData } from "../src/sketch/validate";

const at = (x: number, y: number): Placed => ({ x, y, snap: null });
const on = (id: string, s: SketchData): Placed => {
  const [x, y] = pointPos(s, id);
  return { x, y, snap: { kind: "point", id } };
};
const round = (p: [number, number]) => p.map((v) => Math.round(v * 1e6) / 1e6);

/** A sketch with its first line held in place (as if it were fixed to the origin). */
function pinned(s: SketchData, lineId: string): SketchData {
  const l = s.curves.find((c) => c.id === lineId) as SketchLine;
  return { ...s, constraints: [...s.constraints, ...[l.p1, l.p2].map((id, i) => ({ id: `pin${i}`, type: "fix" as const, refs: [id], extra: pointPos(s, id) }))] };
}

/** A vertical construction line on x = 0, and half an outline to its right touching it at (0, 0) and (0, 20). */
function half() {
  const axis = addLine(emptySketch(), at(0, -10), at(0, 30), { construction: true });
  let s = pinned(axis.sketch, axis.lineId);
  const l1 = addLine(s, at(0, 0), at(20, 0));
  s = l1.sketch;
  const l2 = addLine(s, on(l1.endId, s), at(20, 10));
  s = l2.sketch;
  const l3 = addLine(s, on(l2.endId, s), at(0, 20));
  s = l3.sketch;
  return { s, axis: axis.lineId, lines: [l1.lineId, l2.lineId, l3.lineId] };
}

describe("sketch mirror", () => {
  it("copies shapes across a line, sharing points that lie on it, making a closed outline", () => {
    const { s, axis, lines } = half();
    const r = mirrorCurves(s, axis, lines);
    expect(r.error).toBeUndefined();
    expect(r.curveIds).toHaveLength(3);
    // Only the two corners off the line are new points.
    expect(r.sketch.points.length - s.points.length).toBe(2);
    const copies = r.sketch.curves.filter((c): c is SketchLine => r.curveIds.includes(c.id) && c.type === "line");
    const ends = copies.flatMap((c) => [c.p1, c.p2]).map((id) => round(pointPos(r.sketch, id)));
    const has = (p: number[]) => ends.some((e) => e[0] === p[0] && e[1] === p[1]);
    expect(has([-20, 0]) && has([-20, 10])).toBe(true);
    expect(r.sketch.constraints.filter((c) => c.type === "symmetric")).toHaveLength(2);
    // The left and right halves join into one closed shape (the open ends are on the mirror line).
    const regions = findRegions(r.sketch);
    expect(regions.problems).toEqual([]);
  });

  it("keeps the copy mirrored when the original changes", () => {
    const { s, axis, lines } = half();
    const r = mirrorCurves(s, axis, lines);
    const corner = (s.curves.find((c) => c.id === lines[1]) as SketchLine).p2;
    const moved = solveSketch({ ...r.sketch, constraints: [...r.sketch.constraints, { id: "fx", type: "fix", refs: [corner], extra: [25, 12] }] });
    expect(moved.ok).toBe(true);
    const copy = r.sketch.constraints.find((c) => c.type === "symmetric" && c.refs[0] === corner)!.refs[1];
    expect(round(pointPos(moved.sketch, copy))).toEqual([-25, 12]);
  });

  it("mirrors circles (same size) and arcs (running the other way)", () => {
    const axis = addLine(emptySketch(), at(0, -10), at(0, 30), { construction: true });
    const circle = addCircle(axis.sketch, at(10, 5), 3);
    const arc = addArc(circle.sketch, at(10, 15), at(20, 15), { x: 15, y: 18 });
    const r = mirrorCurves(arc.sketch, axis.lineId, [circle.circleId, arc.arcId]);
    expect(r.error).toBeUndefined();
    const newCircle = r.sketch.curves.find((c) => r.curveIds.includes(c.id) && c.type === "circle")!;
    expect(newCircle.type === "circle" && round(pointPos(r.sketch, newCircle.center))).toEqual([-10, 5]);
    expect(r.sketch.constraints.some((c) => c.type === "equal" && c.refs.includes(newCircle.id))).toBe(true);
    const newArc = r.sketch.curves.find((c): c is SketchArc => r.curveIds.includes(c.id) && c.type === "arc")!;
    // The original goes anticlockwise from (10,15) over the top to... its mirror starts at the image of the old end.
    const old = arc.sketch.curves.find((c) => c.id === arc.arcId) as SketchArc;
    expect(round(pointPos(r.sketch, newArc.start))).toEqual(round(pointPos(arc.sketch, old.end)).map((v, i) => (i === 0 ? -v : v)));
    // Its middle bulges up, like the original's.
    const [cx, cy] = pointPos(r.sketch, newArc.center);
    const [sx, sy] = pointPos(r.sketch, newArc.start);
    const [ex, ey] = pointPos(r.sketch, newArc.end);
    const a0 = Math.atan2(sy - cy, sx - cx);
    let a1 = Math.atan2(ey - cy, ex - cx);
    while (a1 <= a0) a1 += 2 * Math.PI;
    expect(Math.sin((a0 + a1) / 2)).toBeGreaterThan(0);
  });

  it("explains what it needs", () => {
    const { s, axis, lines } = half();
    expect(mirrorCurves(s, lines[0], [lines[1]]).error).toBeUndefined(); // any straight line will do
    const c = addCircle(s, at(50, 50), 2);
    expect(mirrorCurves(c.sketch, c.circleId, lines).error).toMatch(/straight line/);
    expect(mirrorCurves(s, axis, [axis]).error).toMatch(/not the mirror line/);
  });
});

describe("symmetric relation", () => {
  it("holds two points mirror images across a line", () => {
    const axis = addLine(emptySketch(), at(0, -10), at(0, 30), { construction: true });
    const p = addLine(pinned(axis.sketch, axis.lineId), at(5, 0), at(12, 7));
    const ln = p.sketch.curves.find((c) => c.id === p.lineId) as SketchLine;
    const q = addLine(p.sketch, at(-3, 1), at(-15, 9));
    const other = q.sketch.curves.find((c) => c.id === q.lineId) as SketchLine;
    const r = applyRelation(q.sketch, "symmetric", [ln.id, other.id, axis.lineId]);
    expect(r.error).toBeUndefined();
    const [ax, ay] = pointPos(r.sketch, ln.p1);
    const [bx, by] = pointPos(r.sketch, other.p1);
    expect(ax + bx).toBeCloseTo(0, 6);
    expect(ay).toBeCloseTo(by, 6);
    expect(applyRelation(q.sketch, "symmetric", [ln.id, axis.lineId]).error).toMatch(/mirror across/);
    // Saved and read back.
    expect(parseSketchData(JSON.parse(JSON.stringify(r.sketch)))?.constraints.some((c) => c.type === "symmetric")).toBe(true);
  });
});
