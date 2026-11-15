import { describe, expect, it } from "vitest";

import { addCircle, addDimension, addLine, addRectangle, applyRelation, curvePoints, pointPos, setDimensionValue, type Placed } from "../src/sketch/ops";
import { clipAt, copySketchItems, dragSelection, draggableCount, pasteSketchClip, readSketchClip, selectionPoints } from "../src/sketch/clipboard";
import { analyzeSketch } from "../src/sketch/solver";
import { emptySketch, isDimension, type SketchData, type SketchLine } from "../src/sketch/types";

const at = (x: number, y: number): Placed => ({ x, y, snap: null });
const r3 = (p: [number, number]) => p.map((v) => Math.round(v * 1e3) / 1e3);

/** A 10 × 5 rectangle with its width dimensioned, plus a circle elsewhere. */
function sample() {
  const rect = addRectangle(emptySketch(), at(0, 0), at(10, 5));
  const bottom = rect.lineIds[0];
  const dim = addDimension(rect.sketch, [bottom], { x: 0, y: -3 });
  const circle = addCircle(dim.sketch, at(40, 0), 3);
  return { s: circle.sketch, rect: rect.lineIds, dim: dim.dimensionId, circle: circle.circleId };
}

function box(s: SketchData, ids: string[]) {
  const pts = ids.flatMap((id) => {
    const c = s.curves.find((k) => k.id === id)!;
    return curvePoints(c).map((p) => pointPos(s, p));
  });
  return { x0: Math.min(...pts.map((p) => p[0])), x1: Math.max(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), y1: Math.max(...pts.map((p) => p[1])) };
}

describe("sketch copy and paste", () => {
  it("copies the picked shapes with the relations and dimensions wholly inside them", () => {
    const { s, rect, dim } = sample();
    const clip = copySketchItems(s, rect)!;
    expect(clip.curves).toHaveLength(4);
    expect(clip.points).toHaveLength(4);
    // The width dimension and the rectangle's horizontal/vertical relations come along.
    expect(clip.constraints.some((c) => c.id === dim)).toBe(true);
    expect(clip.constraints.every((c) => c.refs.every((r) => clip.points.some((p) => p.id === r) || clip.curves.some((k) => k.id === r)))).toBe(true);
    expect(r3(clip.middle)).toEqual([5, 2.5]);
    // Only one line picked: its dimension comes, the relations tying it to the other sides don't.
    const one = copySketchItems(s, [rect[0]])!;
    expect(one.curves).toHaveLength(1);
    expect(one.constraints.every((c) => c.refs.length && c.refs.every((r) => r === rect[0] || one.points.some((p) => p.id === r)))).toBe(true);
    expect(one.constraints.some((c) => isDimension(c))).toBe(true);
    expect(copySketchItems(s, [])).toBe(null);
  });

  it("pastes with new ids where it's put, keeping the size and solving", () => {
    const { s, rect, dim } = sample();
    const clip = copySketchItems(s, rect)!;
    const r = pasteSketchClip(s, clip, [100, 50]);
    expect(r.error).toBe(undefined);
    expect(r.ids).toHaveLength(4);
    expect(r.sketch.curves).toHaveLength(s.curves.length + 4);
    // Every id is new.
    const old = new Set([...s.points.map((p) => p.id), ...s.curves.map((c) => c.id), ...s.constraints.map((c) => c.id)]);
    expect(r.ids.some((id) => old.has(id))).toBe(false);
    const added = r.sketch.constraints.slice(s.constraints.length);
    expect(added.length).toBe(clip.constraints.length);
    expect(added.some((c) => old.has(c.id) || c.refs.some((x) => old.has(x)))).toBe(false);
    // Centred on the pointer, the same size, and the original left where it was.
    const b = box(r.sketch, r.ids);
    expect(r3([b.x0, b.y0])).toEqual([95, 47.5]);
    expect(r3([b.x1, b.y1])).toEqual([105, 52.5]);
    expect(box(r.sketch, rect)).toEqual(box(s, rect));
    // The copy's width dimension drives the copy alone.
    const copiedDim = added.find((c) => isDimension(c))!;
    const wider = setDimensionValue(r.sketch, copiedDim.id, "30");
    expect(wider.error).toBe(undefined);
    expect(box(wider.sketch, r.ids).x1 - box(wider.sketch, r.ids).x0).toBeCloseTo(30, 6);
    expect(box(wider.sketch, rect).x1 - box(wider.sketch, rect).x0).toBeCloseTo(10, 6);
    void dim;
  });

  it("leaves behind what ties the shapes to the origin, a fixed spot or other shapes", () => {
    // A line from the origin, fixed, and a second line joined to its end.
    const a = addLine(emptySketch(), { x: 0, y: 0, snap: { kind: "origin" } }, at(10, 0));
    const fixed = applyRelation(a.sketch, "fix", [a.lineId]).sketch;
    const first = fixed.curves[0] as SketchLine;
    const b = addLine(fixed, { x: 10, y: 0, snap: { kind: "point", id: first.p2 } }, at(10, 10));
    const clip = copySketchItems(b.sketch, [a.lineId])!;
    expect(clip.constraints.some((c) => c.type === "fix")).toBe(false);
    expect(clip.constraints.some((c) => c.refs.includes("origin"))).toBe(false);
    const r = pasteSketchClip(b.sketch, clip, [50, 50]);
    const copy = r.sketch.curves.find((c) => c.id === r.ids[0]) as SketchLine;
    expect(copy.p1).not.toBe("origin");
    expect(r3(pointPos(r.sketch, copy.p1))).toEqual([45, 50]);
    expect(r3(pointPos(r.sketch, copy.p2))).toEqual([55, 50]);
    // The original is still fixed where it was.
    expect(r3(pointPos(r.sketch, first.p2))).toEqual([10, 0]);
  });

  it("pastes into another sketch and reads back from text", () => {
    const { s, rect, circle } = sample();
    const clip = copySketchItems(s, [...rect, circle])!;
    const back = readSketchClip(JSON.stringify(clip))!;
    expect(back.curves).toHaveLength(5);
    const other = addLine(emptySketch(), at(0, 0), at(5, 5)).sketch;
    const r = pasteSketchClip(other, back, [0, 0]);
    expect(r.ids).toHaveLength(5);
    expect(r.sketch.curves).toHaveLength(6);
    // Shown where it would go (same ids, moved).
    const shown = clipAt(back, [0, 0]);
    expect(shown.points[0].id).toBe(back.points[0].id);
    expect(readSketchClip("{\"kind\":\"juracad-features\"}")).toBe(null);
    expect(readSketchClip("not json")).toBe(null);
    expect(readSketchClip(null)).toBe(null);
  });

  it("keeps a pasted, dimensioned rectangle as defined as the original", () => {
    const { s, rect } = sample();
    const freedom = (d: SketchData) => analyzeSketch(d).freedom;
    const before = freedom(s);
    const r = pasteSketchClip(s, copySketchItems(s, rect)!, [80, 0]);
    // The copy adds exactly the original rectangle's freedom: its own sizes came with it.
    const rectOnly = { ...s, curves: s.curves.filter((c) => rect.includes(c.id)), points: s.points.filter((p) => rect.some((id) => curvePoints(s.curves.find((c) => c.id === id)!).includes(p.id))), constraints: copySketchItems(s, rect)!.constraints };
    expect(freedom(r.sketch)).toBe(before + freedom(rectOnly));
  });
});

describe("dragging several at once", () => {
  it("moves every picked shape together, keeping their relations", () => {
    const { s, rect, circle } = sample();
    const ids = [...rect, circle];
    expect(draggableCount(s, [...ids, "nonsense"])).toBe(5);
    expect(selectionPoints(s, ids)).toHaveLength(5);
    const moved = dragSelection(s, ids, 7, -2);
    const k = moved.curves.find((c) => c.id === circle)!;
    expect(r3(pointPos(moved, curvePoints(k)[0]))).toEqual([47, -2]);
    const b = box(moved, rect);
    expect(r3([b.x0, b.y0, b.x1, b.y1] as unknown as [number, number])).toEqual([7, -2, 17, 3]);
  });

  it("is held back by a fixed shape", () => {
    const l = addLine(emptySketch(), at(0, 0), at(10, 0));
    const fixed = applyRelation(l.sketch, "fix", [l.lineId]).sketch;
    const c = addCircle(fixed, at(20, 0), 2);
    const moved = dragSelection(c.sketch, [l.lineId, c.circleId], 5, 0);
    const line = moved.curves.find((k) => k.id === l.lineId) as SketchLine;
    expect(r3(pointPos(moved, line.p1))).toEqual([0, 0]);
  });
});
