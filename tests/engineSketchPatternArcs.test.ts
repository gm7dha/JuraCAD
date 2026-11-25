/**
 * With the real OpenCascade engine: a chamfer next to an arc and rounds onto a circle extrude to what the sketch
 * shows; an edited pattern's holes are all cut; a centreline (diameter) dimension placed by the Dimension tool sets
 * the size a revolve comes out.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { analyzeMesh } from "../src/geometry/meshCheck";
import { GeometryEngine } from "../src/kernel/engine";
import type { Feature } from "../src/model/types";
import { addArc, addCircle, addDimension, addLine, addRectangle, setDimensionValue } from "../src/sketch/ops";
import { chamferCorner } from "../src/sketch/sketchChamfer";
import { filletBetween } from "../src/sketch/filletCurves";
import { findRegions } from "../src/sketch/regions";
import { patternCurves } from "../src/sketch/tools";
import { editPattern } from "../src/sketch/patternEdit";
import { solveSketch } from "../src/sketch/solver";
import { emptySketch, type SketchData } from "../src/sketch/types";
import { feature, loadOpenCascade, sketchFeature, extrudeFeature, relativeError } from "./support/engineHelpers";

beforeAll(loadOpenCascade);
let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function solidOf(features: Feature[]) {
  engine = new GeometryEngine();
  const r = engine.rebuild(features);
  expect(r.featureErrors).toEqual({});
  expect(r.parts).toHaveLength(1);
  const m = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
  expect(m.watertight).toBe(true);
  return m.volume;
}
function volumeOf(data: SketchData, depth = 5): number {
  const sk = sketchFeature({ kind: "default", name: "Top" }, data);
  return solidOf([sk, extrudeFeature(sk.id, depth) as Feature]);
}
const at = (x: number, y: number) => ({ x, y });
const pt = (s: SketchData, x: number, y: number) => s.points.find((p) => Math.hypot(p.x - x, p.y - y) < 1e-6)!.id;

describe("chamfers by arcs and rounds onto circles, extruded", () => {
  it("a pie slice with a chamfer where a line meets the arc", () => {
    let s = addLine(emptySketch(), { x: 0, y: 0, snap: { kind: "origin" } }, at(10, 0)).sketch;
    const a = pt(s, 10, 0);
    s = addLine(s, at(0, 10), { x: 0, y: 0, snap: { kind: "origin" } }).sketch;
    const b = pt(s, 0, 10);
    s = solveSketch(addArc(s, { x: 10, y: 0, snap: { kind: "point", id: a } }, { x: 0, y: 10, snap: { kind: "point", id: b } }, at(7.0710678, 7.0710678)).sketch).sketch;
    const r = chamferCorner(s, a, { mode: "equal", distance: "2" });
    expect(r.error).toBeUndefined();
    const turn = 2 * Math.asin(0.1);
    const cut = (2 * 10 * Math.sin(turn)) / 2 + 50 * (turn - Math.sin(turn));
    // (The mesh draws the arc as short lines, so compare with the slice before the chamfer.)
    const plain = volumeOf(s);
    expect(relativeError(plain, 25 * Math.PI * 5)).toBeLessThan(5e-3);
    const chamfered = volumeOf(r.sketch);
    expect(relativeError(plain - chamfered, cut * 5)).toBeLessThan(2e-2);
  });

  it("a keyhole: a slot's sides rounded onto a circle", () => {
    let s = addCircle(emptySketch(), { x: 0, y: 0, snap: { kind: "origin" } }, 10).sketch;
    s = addLine(s, at(4, 0), at(4, 25)).sketch;
    const top = pt(s, 4, 25);
    s = addLine(s, { x: 4, y: 25, snap: { kind: "point", id: top } }, at(-4, 25)).sketch;
    const tl = pt(s, -4, 25);
    s = addLine(s, { x: -4, y: 25, snap: { kind: "point", id: tl } }, at(-4, 0)).sketch;
    const circle = s.curves.find((c) => c.type === "circle")!.id;
    const right = s.curves.find((c) => c.type === "line" && Math.abs(s.points.find((p) => p.id === c.p1)!.x - 4) < 1e-9 && Math.abs(s.points.find((p) => p.id === c.p2)!.x - 4) < 1e-9)!.id;
    const r1 = filletBetween(s, right, [4, 20], circle, [8, 6], "1");
    expect(r1.error).toBeUndefined();
    const left = r1.sketch.curves.find((c) => c.type === "line" && Math.abs(r1.sketch.points.find((p) => p.id === c.p1)!.x + 4) < 1e-9 && Math.abs(r1.sketch.points.find((p) => p.id === c.p2)!.x + 4) < 1e-9)!.id;
    const r2 = filletBetween(r1.sketch, left, [-4, 20], circle, [-8, 6], "1");
    expect(r2.error).toBeUndefined();
    const regions = findRegions(r2.sketch).regions;
    expect(regions).toHaveLength(1);
    // Rounds fill the inside corners: more than the circle and the slot above it, but not by much.
    const area = regions[0].outer.area;
    const v = volumeOf(r2.sketch, 2);
    expect(relativeError(v, area * 2)).toBeLessThan(5e-3);
  });
});

describe("an edited pattern, extruded", () => {
  it("a plate with a row of holes made longer and closer", () => {
    const rect = addRectangle(emptySketch(), at(-10, -10), at(80, 10));
    const hole = addCircle(rect.sketch, at(0, 0), 2);
    const p = patternCurves(hole.sketch, [hole.circleId], { kind: "linear", count: 3, spacing: 20, angle: 0 });
    const e = editPattern(p.sketch, p.patternId, { count: 6, value: "12" });
    expect(e.error).toBeUndefined();
    expect(relativeError(volumeOf(e.sketch, 3), (90 * 20 - 6 * Math.PI * 4) * 3)).toBeLessThan(2e-3);
  });
});

describe("a diameter about the centreline sets what a revolve makes", () => {
  it("a rectangle beside its axis, dimensioned across the axis to 30, turns into a ⌀30 cylinder", () => {
    // An upright axis from the origin, and the rectangle's corner on the origin.
    let s = addLine(emptySketch(), { x: 0, y: 0, snap: { kind: "origin" } }, at(0, 25), { construction: true, orientation: "vertical" }).sketch;
    const axis = s.curves[0].id;
    const rect = addRectangle(s, { x: 0, y: 0, snap: { kind: "origin" } }, at(10, 20));
    s = rect.sketch;
    const corner = pt(s, 10, 20);
    // The number put across the axis (to the left of it): a diameter.
    const d = addDimension(s, [corner, axis], { x: -12, y: 0 }, true);
    expect(d.error).toBeUndefined();
    const dim = d.sketch.constraints.find((c) => c.id === d.dimensionId)!;
    expect(dim.doubled).toBe(true);
    s = setDimensionValue(d.sketch, d.dimensionId, "30").sketch;
    // The corner is now 15 from the axis: the diameter is 30.
    const xs = rect.lineIds.flatMap((id) => {
      const l = s.curves.find((c) => c.id === id)!;
      return l.type === "line" ? [l.p1, l.p2].map((p) => s.points.find((q) => q.id === p)!.x) : [];
    });
    const outer = Math.max(...xs);
    const inner = Math.min(...xs);
    expect(outer).toBeCloseTo(15, 6);
    expect(inner).toBeGreaterThanOrEqual(-1e-9);
    const height = 20;
    const sk = sketchFeature({ kind: "default", name: "Front" }, s);
    const rev: Feature = { ...feature("revolve", { angle: 360 }), sketchRef: sk.id, revolve: { axis, flip: false } };
    expect(relativeError(solidOf([sk, rev]), Math.PI * (outer * outer - inner * inner) * height)).toBeLessThan(5e-3);
  });
});
