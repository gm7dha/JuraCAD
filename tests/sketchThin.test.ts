import { describe, expect, it } from "vitest";

import { findRegions } from "../src/sketch/regions";
import { loopArea, thinAmounts, thinLoops, thinSketches } from "../src/sketch/thin";
import type { SketchCurve, SketchData, SketchPoint } from "../src/sketch/types";

/** A sketch from points (id → [x, y]) and curves. */
function sketch(pts: Record<string, [number, number]>, curves: SketchCurve[]): SketchData {
  const points: SketchPoint[] = Object.entries(pts).map(([id, [x, y]]) => ({ id, x, y }));
  return { points, curves, constraints: [] };
}
const line = (id: string, p1: string, p2: string, construction = false): SketchCurve => ({ id, type: "line", p1, p2, construction });

/** The wall's area: every closed shape of every run's sketch (outer minus holes). */
function wallArea(pieces: SketchData[]): number {
  let a = 0;
  for (const p of pieces) {
    const { regions, problems } = findRegions(p);
    expect(problems).toEqual([]);
    for (const r of regions) a += r.outer.area - r.holes.reduce((s, h) => s + h.area, 0);
  }
  return a;
}
function box(pieces: SketchData[]) {
  const ids = new Set(pieces.flatMap((p) => p.curves.filter((c) => c.id.startsWith("thin:")).flatMap((c) => (c.type === "line" ? [c.p1, c.p2] : c.type === "arc" ? [c.start, c.end] : []))));
  const pts = pieces.flatMap((p) => p.points.filter((q) => ids.has(q.id)));
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return [r(Math.min(...pts.map((p) => p.x))), r(Math.min(...pts.map((p) => p.y))), r(Math.max(...pts.map((p) => p.x))), r(Math.max(...pts.map((p) => p.y)))];
}

describe("thin walls (pure)", () => {
  it("works out each side's amount: one side, two, centred, flipped", () => {
    expect(thinAmounts({ thickness: 2, thickness2: 0 })).toEqual([2, 0]);
    expect(thinAmounts({ thickness: 2, thickness2: 1 })).toEqual([2, 1]);
    expect(thinAmounts({ thickness: 2, thickness2: 1, flip: true })).toEqual([1, 2]);
    expect(thinAmounts({ thickness: 3, thickness2: 9, midPlane: true })).toEqual([1.5, 1.5]);
  });

  it("makes a straight line into a rectangle with square ends, on its first side (above a left-to-right line)", () => {
    const s = sketch({ a: [40, 0], b: [0, 0] }, [line("l", "a", "b")]);
    const pieces = thinSketches(s, { thickness: 2, thickness2: 0 });
    expect(pieces).toHaveLength(1);
    expect(wallArea(pieces)).toBeCloseTo(80, 9);
    expect(box(pieces)).toEqual([0, 0, 40, 2]);
    expect(box(thinSketches(s, { thickness: 2, thickness2: 0, flip: true }))).toEqual([0, -2, 40, 0]);
    expect(box(thinSketches(s, { thickness: 2, thickness2: 0, midPlane: true }))).toEqual([0, -1, 40, 1]);
    expect(box(thinSketches(s, { thickness: 2, thickness2: 3 }))).toEqual([0, -3, 40, 2]);
  });

  it("keeps an L's corner sharp (mitred), so a centred wall's area is its length × thickness", () => {
    const s = sketch({ a: [0, 0], b: [40, 0], c: [40, 30] }, [line("l1", "a", "b"), line("l2", "b", "c")]);
    const pieces = thinSketches(s, { thickness: 2, thickness2: 0, midPlane: true });
    expect(wallArea(pieces)).toBeCloseTo(140, 9);
    // Six corners: two square ends of two corners each, plus the sharp outside and inside corners.
    expect(pieces[0].curves.filter((c) => c.id.startsWith("thin:"))).toHaveLength(6);
    expect(box(pieces)).toEqual([0, -1, 41, 30]);
    // All on one side: the area changes by the corner square.
    const one = thinSketches(s, { thickness: 2, thickness2: 0 });
    expect(wallArea(one)).toBeCloseTo(70 * 2 - 4, 9);
  });

  it("makes a closed rectangle into a ring: inside by default, outside when flipped", () => {
    const s = sketch({ a: [0, 0], b: [40, 0], c: [40, 20], d: [0, 20] }, [line("l1", "a", "b"), line("l2", "b", "c"), line("l3", "c", "d"), line("l4", "d", "a")]);
    const inside = thinSketches(s, { thickness: 2, thickness2: 0 });
    expect(wallArea(inside)).toBeCloseTo(800 - 36 * 16, 9);
    expect(box(inside)).toEqual([0, 0, 40, 20]);
    const outside = thinSketches(s, { thickness: 2, thickness2: 0, flip: true });
    expect(wallArea(outside)).toBeCloseTo(44 * 24 - 800, 9);
    expect(box(outside)).toEqual([-2, -2, 42, 22]);
    const both = thinSketches(s, { thickness: 2, thickness2: 0, midPlane: true });
    expect(wallArea(both)).toBeCloseTo(42 * 22 - 38 * 18, 9);
  });

  it("keeps arcs as arcs and circles as circles", () => {
    const circle = sketch({ o: [5, 5] }, [{ id: "c", type: "circle", center: "o", radius: 10, construction: false }]);
    const ring = thinSketches(circle, { thickness: 2, thickness2: 0, midPlane: true });
    expect(ring[0].curves.filter((c) => c.type === "circle" && c.id.startsWith("thin:")).map((c) => (c as { radius: number }).radius).sort()).toEqual([11, 9]);
    expect(wallArea(ring)).toBeCloseTo(Math.PI * (121 - 81), 0);
    // A half circle: an arc of a ring, its ends square.
    const half = sketch({ o: [0, 0], s: [10, 0], e: [-10, 0] }, [{ id: "a", type: "arc", center: "o", start: "s", end: "e", construction: false }]);
    const band = thinSketches(half, { thickness: 2, thickness2: 0, midPlane: true });
    expect(band[0].curves.filter((c) => c.type === "arc" && c.id.startsWith("thin:"))).toHaveLength(2);
    expect(wallArea(band)).toBeCloseTo((Math.PI * (121 - 81)) / 2, 0);
    const loops = thinLoops([{ kind: "arc", from: [10, 0], mid: [0, 10], to: [-10, 0] }], false, [1, 1]);
    expect(loopArea(loops[0])).toBeCloseTo((Math.PI * (121 - 81)) / 2, 9);
  });

  it("joins a line and a tangent arc smoothly (no extra corner)", () => {
    // A J: down a line, then round a half circle.
    const loops = thinLoops([{ kind: "line", from: [0, 20], to: [0, 0] }, { kind: "arc", from: [0, 0], mid: [5, -5], to: [10, 0] }], false, [1, 1]);
    if (!("prims" in loops[0])) throw new Error("expected pieces");
    // line, arc, end, arc back, line back, end.
    expect(loops[0].prims.map((p) => p.kind)).toEqual(["line", "arc", "line", "arc", "line", "line"]);
    expect(loopArea(loops[0])).toBeCloseTo(2 * (20 + Math.PI * 5), 9);
  });

  it("refuses walls too thick for the shape, splines, and nothing drawn, in plain words", () => {
    const circle = sketch({ o: [0, 0] }, [{ id: "c", type: "circle", center: "o", radius: 3, construction: false }]);
    expect(() => thinSketches(circle, { thickness: 4, thickness2: 0 })).toThrow(/too thick for a circle/);
    const s = sketch({ a: [0, 0], b: [10, 0], c: [10, 4], d: [0, 4] }, [line("l1", "a", "b"), line("l2", "b", "c"), line("l3", "c", "d"), line("l4", "d", "a")]);
    expect(() => thinSketches(s, { thickness: 3, thickness2: 0 })).toThrow(/too thick/);
    const spline = sketch({ a: [0, 0], b: [5, 5], c: [10, 0] }, [{ id: "s", type: "spline", points: ["a", "b", "c"], closed: false } as SketchCurve]);
    expect(() => thinSketches(spline, { thickness: 1, thickness2: 0 })).toThrow(/splines/);
    const onlyConstruction = sketch({ a: [0, 0], b: [10, 0] }, [line("l", "a", "b", true)]);
    expect(() => thinSketches(onlyConstruction, { thickness: 1, thickness2: 0 })).toThrow(/no lines/);
    expect(() => thinSketches(s, { thickness: 0, thickness2: 0 })).toThrow(/thickness/);
  });

  it("leaves a revolve's axis line out of the wall but keeps it in the sketch", () => {
    const s = sketch({ a: [0, -10], b: [0, 10], c: [10, 0], d: [10, 20] }, [line("axis", "a", "b"), line("l", "c", "d")]);
    const pieces = thinSketches(s, { thickness: 2, thickness2: 0 }, "axis");
    expect(pieces).toHaveLength(1);
    expect(pieces[0].curves.find((c) => c.id === "axis")?.construction).toBe(true);
    expect(wallArea(pieces)).toBeCloseTo(40, 9);
  });

  it("makes separate walls for separate runs, and for each line at a junction", () => {
    const s = sketch({ a: [0, 0], b: [10, 0], c: [0, 5], d: [10, 5] }, [line("l1", "a", "b"), line("l2", "c", "d")]);
    expect(thinSketches(s, { thickness: 1, thickness2: 0 })).toHaveLength(2);
    const t = sketch({ a: [0, 0], b: [10, 0], c: [20, 0], d: [10, 10] }, [line("l1", "a", "b"), line("l2", "b", "c"), line("l3", "b", "d")]);
    expect(thinSketches(t, { thickness: 1, thickness2: 0 })).toHaveLength(3);
  });
});
