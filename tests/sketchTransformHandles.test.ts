import { describe, expect, it } from "vitest";

import { addArc, addCircle, addDimension, addLine, addRectangle, applyRelation, curvePoints, pointPos, type Placed } from "../src/sketch/ops";
import {
  GIZMO_RING_PX,
  gizmoPartAt,
  gizmoShapes,
  HELD_MESSAGE,
  readScale,
  selectionCentre,
  snapScale,
  snapTurn,
  transformCopy,
  transformSelection,
  turnBetween,
  VARIABLE_SIZE_MESSAGE,
} from "../src/sketch/transformSelection";
import { emptySketch, type SketchData, type SketchLine } from "../src/sketch/types";

const at = (x: number, y: number): Placed => ({ x, y, snap: null });
const r6 = (p: [number, number]) => p.map((v) => Math.round(v * 1e6) / 1e6 + 0);
const corners = (s: SketchData, ids: string[]) => {
  const pts = new Set(ids.flatMap((id) => curvePoints(s.curves.find((c) => c.id === id)!)));
  return [...pts].map((id) => r6(pointPos(s, id)));
};
const has = (list: number[][], p: number[]) => list.some((q) => q[0] === p[0] && q[1] === p[1]);
const len = (s: SketchData, id: string) => {
  const l = s.curves.find((c) => c.id === id) as SketchLine;
  const a = pointPos(s, l.p1), b = pointPos(s, l.p2);
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
};

describe("moving, turning and scaling picked shapes", () => {
  it("finds the middle of what's picked (circles by their full size)", () => {
    const r = addRectangle(emptySketch(), at(0, 0), at(10, 4));
    expect(selectionCentre(r.sketch, r.lineIds)).toEqual([5, 2]);
    const c = addCircle(emptySketch(), at(3, 3), 2);
    expect(selectionCentre(c.sketch, [c.circleId])).toEqual([3, 3]);
    expect(selectionCentre(c.sketch, [])).toBe(null);
  });

  it("turns a rectangle by 30° and it stays a rectangle of the same size", () => {
    const r = addRectangle(emptySketch(), at(0, 0), at(10, 4));
    const t = transformSelection(r.sketch, r.lineIds, { dx: 0, dy: 0, angle: 30, scale: 1 });
    expect(t.error).toBe(undefined);
    const s = t.sketch;
    expect(s.constraints.some((c) => c.type === "horizontal" || c.type === "vertical")).toBe(false);
    expect(s.constraints.filter((c) => c.type === "parallel" || c.type === "perpendicular")).toHaveLength(3);
    const lengths = r.lineIds.map((id) => Math.round(len(s, id) * 1e6) / 1e6).sort((a, b) => a - b);
    expect(lengths).toEqual([4, 4, 10, 10]);
    // The middle stays where it was.
    const m = selectionCentre(s, r.lineIds)!;
    const pts = corners(s, r.lineIds);
    const mean = [pts.reduce((a, p) => a + p[0], 0) / 4, pts.reduce((a, p) => a + p[1], 0) / 4];
    expect(mean[0]).toBeCloseTo(5, 6);
    expect(mean[1]).toBeCloseTo(2, 6);
    expect(m).toBeTruthy();
  });

  it("a quarter turn swaps level and upright, keeping them", () => {
    const r = addRectangle(emptySketch(), at(0, 0), at(10, 4));
    const before = r.sketch.constraints.filter((c) => c.type === "horizontal").length;
    const t = transformSelection(r.sketch, r.lineIds, { dx: 0, dy: 0, angle: 90, scale: 1 });
    expect(t.error).toBe(undefined);
    expect(t.sketch.constraints.filter((c) => c.type === "vertical").length).toBe(before);
    const xs = corners(t.sketch, r.lineIds).map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(4, 6);
  });

  it("moves, and refuses when something holds part of it", () => {
    const r = addRectangle(emptySketch(), at(0, 0), at(10, 4));
    const moved = transformSelection(r.sketch, r.lineIds, { dx: 5, dy: -2, angle: 0, scale: 1 });
    expect(has(corners(moved.sketch, r.lineIds), [5, -2])).toBe(true);
    const l = r.sketch.curves.find((c) => c.id === r.lineIds[0]) as SketchLine;
    const fixed = applyRelation(r.sketch, "fix", [l.p1]).sketch;
    const held = transformSelection(fixed, r.lineIds, { dx: 5, dy: 0, angle: 0, scale: 1 });
    expect(held.error).toBe(HELD_MESSAGE);
    expect(held.sketch).toBe(fixed);
  });

  it("scales shapes and their plain-number sizes; refuses sizes set by a variable", () => {
    const r = addRectangle(emptySketch(), at(0, 0), at(10, 4));
    const d = addDimension(r.sketch, [r.lineIds[0]]);
    const c = addCircle(d.sketch, at(20, 0), 2);
    const dc = addDimension(c.sketch, [c.circleId]);
    const ids = [...r.lineIds, c.circleId];
    const t = transformSelection(dc.sketch, ids, { dx: 0, dy: 0, angle: 0, scale: 2 });
    expect(t.error).toBe(undefined);
    expect(len(t.sketch, r.lineIds[0])).toBeCloseTo(2 * len(dc.sketch, r.lineIds[0]), 6);
    const circle = t.sketch.curves.find((k) => k.id === c.circleId);
    expect(circle?.type === "circle" && circle.radius).toBeCloseTo(4, 6);
    const dim = t.sketch.constraints.find((k) => k.id === d.dimensionId)!;
    expect(Number(dim.value)).toBeCloseTo(2 * len(dc.sketch, r.lineIds[0]), 6);
    const withVar = { ...dc.sketch, constraints: dc.sketch.constraints.map((k) => (k.id === d.dimensionId ? { ...k, value: "width" } : k)) };
    expect(transformSelection(withVar, ids, { dx: 0, dy: 0, angle: 0, scale: 2 }).error).toBe(VARIABLE_SIZE_MESSAGE);
    expect(typeof transformSelection(dc.sketch, ids, { dx: 0, dy: 0, angle: 0, scale: 0 }).error).toBe("string");
  });

  it("copies, leaving the original where it was", () => {
    const r = addRectangle(emptySketch(), at(0, 0), at(10, 4));
    const t = transformCopy(r.sketch, r.lineIds, { dx: 20, dy: 0, angle: 0, scale: 1 });
    expect(t.error).toBe(undefined);
    expect(t.sketch.curves).toHaveLength(8);
    expect(has(corners(t.sketch, r.lineIds), [0, 0])).toBe(true);
    expect(has(corners(t.sketch, t.ids), [20, 0])).toBe(true);
  });
});

describe("after the review", () => {
  it("the handles sit in the middle of the shapes as drawn, not of their centre points", () => {
    // A shallow arc: its centre is ~100 mm below it, but the handles go on the arc.
    const a = addArc(emptySketch(), at(0, 0), at(20, 0), { x: 10, y: 0.5 });
    const c = selectionCentre(a.sketch, [a.arcId])!;
    expect(c[0]).toBeCloseTo(10, 6);
    expect(c[1]).toBeCloseTo(0.25, 3);
  });

  it("two picked shapes turned by 30° are held square to ONE line, so neither can spin on its own", () => {
    const plate = addRectangle(emptySketch(), at(0, 0), at(40, 20));
    const slot = addRectangle(plate.sketch, at(10, 8), at(30, 12));
    const ids = [...plate.lineIds, ...slot.lineIds];
    const t = transformSelection(slot.sketch, ids, { dx: 0, dy: 0, angle: 30, scale: 1 });
    expect(t.error).toBe(undefined);
    const held = t.sketch.constraints.filter((k) => k.type === "parallel" || k.type === "perpendicular");
    expect(held).toHaveLength(7);
    expect(new Set(held.map((k) => k.refs[0])).size).toBe(1);
  });

  it("keeps inches when scaling a size typed as 0.5in", () => {
    const ln = addLine(emptySketch(), at(0, 0), at(12.7, 0));
    const d = addDimension(ln.sketch, [ln.lineId]);
    for (const [typed, want] of [["0.5in", "1.5 in"], ["0.5 in", "1.5 in"], ["(0.5 in)", "1.5 in"], ["12.7", "38.1"]] as const) {
      const s = { ...d.sketch, constraints: d.sketch.constraints.map((k) => (k.id === d.dimensionId ? { ...k, value: typed } : k)) };
      const t = transformSelection(s, [ln.lineId], { dx: 0, dy: 0, angle: 0, scale: 3 });
      expect(t.sketch.constraints.find((k) => k.id === d.dimensionId)?.value).toBe(want);
    }
    expect(HELD_MESSAGE).toMatch(/Use/);
  });
});

describe("the handles", () => {
  const g = { centre: [0, 0] as [number, number], mmPerPx: 0.1 };
  it("tells the middle, the ring and the scale square apart", () => {
    expect(gizmoPartAt(g, 0.3, 0.2)).toBe("move");
    expect(gizmoPartAt(g, GIZMO_RING_PX * 0.1, 0)).toBe("turn");
    expect(gizmoPartAt(g, 0, -GIZMO_RING_PX * 0.1 - 0.3)).toBe("turn");
    const d = (84 * 0.1) / Math.SQRT2;
    expect(gizmoPartAt(g, d, d)).toBe("scale");
    expect(gizmoPartAt(g, 3, 0)).toBe(null);
    // A finger reaches further.
    expect(gizmoPartAt(g, 1.6, 0)).toBe(null);
    expect(gizmoPartAt(g, 1.6, 0, 2.2)).toBe("move");
    expect(gizmoShapes(g).every((s) => s.handle)).toBe(true);
  });

  it("snaps turns to 15° and scales to 0.05 unless Shift is held", () => {
    expect(turnBetween([0, 0], [1, 0], [0, 1])).toBeCloseTo(90, 9);
    expect(turnBetween([0, 0], [0, 1], [1, 0])).toBeCloseTo(-90, 9);
    expect(snapTurn(37, false)).toBe(30);
    expect(snapTurn(-7, false)).toBe(0);
    expect(snapTurn(37.123, true)).toBe(37.12);
    expect(snapScale(1.32, false)).toBeCloseTo(1.3, 9);
    expect(snapScale(0.001, false)).toBe(0.05);
    expect(snapScale(1.234, true)).toBe(1.234);
    expect(readScale("2 * 0.75")).toBe(1.5);
    expect(readScale("")).toBe(1);
    expect(typeof readScale("0")).toBe("string");
  });
});
