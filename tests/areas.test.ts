import { describe, expect, it } from "vitest";

import { pickedAreas, pointInside, regionsAt, sketchAreas, subBezier, toggleArea } from "../src/sketch/areas";
import { bezierAt } from "../src/sketch/spline";
import { addArc, addCircle, addLine, addRectangle } from "../src/sketch/ops";
import { emptySketch, type SketchData } from "../src/sketch/types";
import { emptyDocument, parseDocument } from "../src/model/document";

const at = (x: number, y: number) => ({ x, y });
const rect = (s: SketchData, x0: number, y0: number, x1: number, y1: number) => addRectangle(s, at(x0, y0), at(x1, y1)).sketch;
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const areasOf = (s: SketchData) => sorted(sketchAreas(s).areas.map((a) => a.area));

describe("sketch areas (where curves cross)", () => {
  it("a plain rectangle is one area", () => {
    const m = sketchAreas(rect(emptySketch(), 0, 0, 40, 30));
    expect(m.areas).toHaveLength(1);
    expect(m.areas[0].area).toBeCloseTo(1200, 9);
    expect(m.areas[0].outer.segments).toHaveLength(4);
    expect(m.areas[0].holes).toHaveLength(0);
  });

  it("a line across a rectangle, ending on its sides (T-junctions), makes two areas", () => {
    let s = rect(emptySketch(), 0, 0, 40, 30);
    s = addLine(s, at(10, 0), at(10, 30)).sketch;
    const a = areasOf(s);
    expect(a[0]).toBeCloseTo(300, 9);
    expect(a[1]).toBeCloseTo(900, 9);
  });

  it("a line crossing right over a rectangle makes two areas (the ends sticking out are ignored)", () => {
    let s = rect(emptySketch(), 0, 0, 40, 30);
    s = addLine(s, at(-5, 10), at(45, 10)).sketch;
    const a = areasOf(s);
    expect(a).toHaveLength(2);
    expect(a[0]).toBeCloseTo(400, 9);
    expect(a[1]).toBeCloseTo(800, 9);
  });

  it("two lines crossing inside a rectangle make four areas", () => {
    let s = rect(emptySketch(), 0, 0, 40, 30);
    s = addLine(s, at(0, 0), at(40, 30)).sketch;
    s = addLine(s, at(0, 30), at(40, 0)).sketch;
    const a = areasOf(s);
    // Four triangles meeting in the middle (20, 15): each is a quarter of the rectangle.
    expect(a).toHaveLength(4);
    for (const x of a) expect(x).toBeCloseTo(300, 9);
  });

  it("a loose line inside, or one joining two shapes, doesn't split anything", () => {
    let s = rect(emptySketch(), 0, 0, 40, 30);
    s = addLine(s, at(20, 30), at(20, 10)).sketch; // from the top side, stopping inside
    s = addCircle(s, at(30, 15), 4).sketch;
    s = addLine(s, at(40, 15), at(34, 15)).sketch; // from the right side to the circle (a bridge)
    const m = sketchAreas(s);
    expect(m.areas).toHaveLength(2);
    const plate = m.areas.find((x) => x.holes.length === 1)!;
    expect(plate.outer.area).toBeCloseTo(1200, 9);
    expect(plate.holes[0].segments[0].kind).toBe("circle");
  });

  it("a circle inside a rectangle: the plate with a hole, and the disc", () => {
    let s = rect(emptySketch(), 0, 0, 40, 30);
    s = addCircle(s, at(20, 15), 5).sketch;
    const m = sketchAreas(s);
    expect(m.areas).toHaveLength(2);
    const disc = m.areaAt([20, 15]);
    const plate = m.areaAt([2, 2]);
    expect(m.areas[disc].outer.segments).toEqual([{ kind: "circle", center: [20, 15], radius: 5 }]);
    expect(m.areas[plate].holes).toHaveLength(1);
    // Joining both fills the hole in; the plate alone keeps it.
    const both = m.join([disc, plate]);
    expect(both).toHaveLength(1);
    expect(both[0].holes).toHaveLength(0);
    expect(both[0].outer.area).toBeCloseTo(1200, 9);
    const plateOnly = m.join([plate]);
    expect(plateOnly).toHaveLength(1);
    expect(plateOnly[0].holes).toHaveLength(1);
    expect(m.areaAt([100, 100])).toBe(-1);
  });

  it("a circle over a rectangle's side makes three areas", () => {
    let s = rect(emptySketch(), 0, 0, 20, 10);
    s = addCircle(s, at(20, 5), 3).sketch;
    const m = sketchAreas(s);
    expect(m.areas).toHaveLength(3);
    // The two halves of the circle, and the rectangle with a half-circle bite out of it.
    const inside = m.areas[m.areaAt([19, 5])];
    const outside = m.areas[m.areaAt([21, 5])];
    const rest = m.areas[m.areaAt([5, 5])];
    expect(inside.outer.segments.map((x) => x.kind).sort()).toEqual(["arc", "line"]);
    expect(outside.outer.segments.map((x) => x.kind).sort()).toEqual(["arc", "line"]);
    // The arcs end exactly where the circle crosses the side: (20, 2) and (20, 8).
    const arc = inside.outer.segments.find((x) => x.kind === "arc")!;
    if (arc.kind === "arc") {
      const ends = sorted([arc.from[1], arc.to[1]]);
      expect(arc.from[0]).toBeCloseTo(20, 9);
      expect(ends[0]).toBeCloseTo(2, 9);
      expect(ends[1]).toBeCloseTo(8, 9);
      expect(arc.mid[0]).toBeCloseTo(17, 9);
    }
    // Polygon areas are approximate (the arcs are drawn as short straight pieces).
    expect(inside.area).toBeCloseTo((9 * Math.PI) / 2, 1);
    expect(rest.area).toBeCloseTo(200 - (9 * Math.PI) / 2, 1);
    // Joining the rest and the inside half gives back the full rectangle.
    const r = m.join([m.areaAt([5, 5]), m.areaAt([19, 5])]);
    expect(r).toHaveLength(1);
    expect(r[0].outer.area).toBeCloseTo(200, 9);
    expect(r[0].outer.segments.every((x) => x.kind === "line")).toBe(true);
  });

  it("two overlapping circles make three areas", () => {
    let s = addCircle(emptySketch(), at(0, 0), 10).sketch;
    s = addCircle(s, at(10, 0), 10).sketch;
    const m = sketchAreas(s);
    expect(m.areas).toHaveLength(3);
    const lens = m.areas[m.areaAt([5, 0])];
    expect(lens.outer.segments.map((x) => x.kind)).toEqual(["arc", "arc"]);
    // Lens of two radius-10 circles 10 apart: 2r²·acos(d/2r) − (d/2)·√(4r²−d²).
    const exact = 2 * 100 * Math.acos(0.5) - 5 * Math.sqrt(300);
    expect(lens.area).toBeCloseTo(exact, 0);
  });

  it("a line across an ellipse cuts it into two ellipse pieces", () => {
    let s: SketchData = {
      points: [
        { id: "c", x: 0, y: 0 },
        { id: "mj", x: 20, y: 0 },
        { id: "mn", x: 0, y: 10 },
      ],
      curves: [{ id: "e", type: "ellipse", center: "c", major: "mj", minor: "mn", construction: false }],
      constraints: [],
    };
    s = addLine(s, at(0, -15), at(0, 15)).sketch;
    const m = sketchAreas(s);
    expect(m.areas).toHaveLength(2);
    const right = m.areas[m.areaAt([10, 0])];
    const piece = right.outer.segments.find((x) => x.kind === "ellipseArc")!;
    expect(piece).toBeDefined();
    if (piece.kind === "ellipseArc") {
      // From the bottom (t = -π/2 ≡ 3π/2) round to the top (t = π/2 + 2π).
      expect(piece.t1 - piece.t0).toBeCloseTo(Math.PI, 9);
      expect(Math.cos(piece.t0)).toBeCloseTo(0, 9);
    }
    expect(right.area).toBeCloseTo(Math.PI * 20 * 10 / 2, 0);
  });

  it("a line across an arc-and-line D shape", () => {
    // A half disc of radius 10 (arc from (10,0) round to (-10,0)), and a line up its middle.
    let s = addArc(emptySketch(), at(10, 0), at(-10, 0), at(0, 10)).sketch;
    s = addLine(s, at(-10, 0), at(10, 0)).sketch;
    s = addLine(s, at(0, 0), at(0, 10)).sketch;
    const m = sketchAreas(s);
    expect(m.areas).toHaveLength(2);
    for (const a of m.areas) expect(a.area).toBeCloseTo(25 * Math.PI, 0);
  });

  it("splits a spline where a line crosses it, exactly", () => {
    const b: [number, number][] = [[0, 0], [10, 20], [30, 20], [40, 0]];
    const half = subBezier(b as never, 0.25, 0.75);
    // The piece's ends lie on the curve at 0.25 and 0.75.
    expect(half[0][0]).toBeCloseTo(bezierAt(b as never, 0.25)[0], 12);
    expect(half[3][1]).toBeCloseTo(bezierAt(b as never, 0.75)[1], 12);
    // ...and its middle at 0.5.
    const m = bezierAt(half, 0.5);
    expect(m[0]).toBeCloseTo(bezierAt(b as never, 0.5)[0], 12);
    expect(m[1]).toBeCloseTo(bezierAt(b as never, 0.5)[1], 12);
  });

  it("picked points find their areas again after a small change, and say when one has gone", () => {
    let s = rect(emptySketch(), 0, 0, 40, 30);
    const line = addLine(s, at(10, 0), at(10, 30));
    s = line.sketch;
    const m = sketchAreas(s);
    const left = pointInside(m.areas[m.areaAt([5, 15])]);
    // Well inside the 10 × 30 strip.
    expect(left[0]).toBeGreaterThan(3);
    expect(left[0]).toBeLessThan(7);
    let r = regionsAt(s, [left]);
    expect(r.missing).toBe(0);
    expect(r.regions).toHaveLength(1);
    expect(r.regions[0].outer.area).toBeCloseTo(300, 9);
    // Move the dividing line 2 mm right: the same point now picks a 12 mm strip.
    const moved: SketchData = { ...s, points: s.points.map((p) => (p.x === 10 ? { ...p, x: 12 } : p)) };
    r = regionsAt(moved, [left]);
    expect(r.regions[0].outer.area).toBeCloseTo(360, 9);
    // Both points: the strips join into the whole rectangle (4 sides, one of them in two pieces each way).
    const right = pointInside(m.areas[m.areaAt([30, 15])]);
    r = regionsAt(s, [left, right]);
    expect(r.regions).toHaveLength(1);
    expect(r.regions[0].outer.area).toBeCloseTo(1200, 9);
    expect(r.regions[0].holes).toHaveLength(0);
    // The top and bottom sides, cut where the line met them, are whole again: four straight sides.
    expect(r.regions[0].outer.segments).toHaveLength(4);
    // A point outside every area counts as missing.
    r = regionsAt(s, [left, [100, 100]]);
    expect(r.missing).toBe(1);
  });

  it("finds the areas of a plate with 900 holes quickly", () => {
    const n = 30;
    let s = rect(emptySketch(), 0, 0, n * 10, n * 10);
    const points = [...s.points];
    const curves = [...s.curves];
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const id = `h${i}-${j}`;
        points.push({ id: `${id}c`, x: 5 + i * 10, y: 5 + j * 10 });
        curves.push({ id, type: "circle", center: `${id}c`, radius: 4, construction: false });
      }
    s = { ...s, points, curves };
    const t = performance.now();
    const m = sketchAreas(s);
    expect(performance.now() - t).toBeLessThan(3000);
    expect(m.areas).toHaveLength(901);
    const plate = m.areas[m.areaAt([10, 10])];
    expect(plate.holes).toHaveLength(900);
  });
});

describe("saving picked areas", () => {
  const docWith = (extra: Record<string, unknown>) => {
    const doc = emptyDocument("Areas");
    return {
      ...doc,
      features: [
        { id: "s1", name: "Sketch 1", type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane: { kind: "default", name: "Top" }, data: emptySketch() } },
        { id: "e1", name: "Extrude 1", type: "extrude", operation: "new", suppressed: false, params: { depth: "10" }, sketchRef: "s1", extrude: { end: "blind", flip: false }, ...extra },
      ],
    };
  };

  it("keeps the picked points through a save and load", () => {
    const d = parseDocument(JSON.parse(JSON.stringify(docWith({ areas: [[5, 15], [25.5, 3]] }))))!;
    expect(d.features[1].areas).toEqual([
      [5, 15],
      [25.5, 3],
    ]);
  });

  it("old files (no picks) and broken entries mean every closed shape", () => {
    expect(parseDocument(docWith({}))!.features[1].areas).toBeUndefined();
    expect(parseDocument(docWith({ areas: "all" }))!.features[1].areas).toBeUndefined();
    expect(parseDocument(docWith({ areas: [[1], ["a", 2], [1, 2, 3]] }))!.features[1].areas).toBeUndefined();
    expect(parseDocument(docWith({ areas: [[1, 2], [null, 2]] }))!.features[1].areas).toEqual([[1, 2]]);
  });
});

describe("clicking areas in the picker", () => {
  it("picks, adds and unpicks areas; none left means every closed shape", () => {
    let s = rect(emptySketch(), 0, 0, 40, 30);
    s = addLine(s, at(10, 0), at(10, 30)).sketch;
    const m = sketchAreas(s);
    const left = m.areaAt([5, 5]);
    const right = m.areaAt([30, 5]);
    let pts = toggleArea(m, undefined, left);
    expect(pts).toHaveLength(1);
    expect(pickedAreas(m, pts).picked.has(left)).toBe(true);
    pts = toggleArea(m, pts, right);
    expect([...pickedAreas(m, pts).picked].sort()).toEqual([left, right].sort());
    pts = toggleArea(m, pts, left);
    expect([...pickedAreas(m, pts).picked]).toEqual([right]);
    expect(toggleArea(m, pts, right)).toBeUndefined();
    // A point whose area has gone is reported, and dropped on the next click.
    const stale: [number, number][] = [[100, 100]];
    expect(pickedAreas(m, stale).missing).toBe(1);
    expect(toggleArea(m, stale, left)).toHaveLength(1);
  });
});
