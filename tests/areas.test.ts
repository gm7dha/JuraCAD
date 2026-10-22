import { describe, expect, it } from "vitest";

import { areasUsedByAll, matchArea, pickedAreas, pickOf, pointInside, regionsAt, sketchAreas, subBezier, toggleArea } from "../src/sketch/areas";
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
    expect(performance.now() - t).toBeLessThan(30_000); // generous: CI machines under load are slow
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
    expect(parseDocument(docWith({ areas: [[1], ["a", 2], [1, 2, 3, 4]] }))!.features[1].areas).toBeUndefined();
    expect(parseDocument(docWith({ areas: [[1, 2], [null, 2]] }))!.features[1].areas).toEqual([[1, 2]]);
    // Newer picks carry the area's size too; a size that isn't positive is dropped (just the point is kept).
    expect(parseDocument(docWith({ areas: [[1, 2, 300], [3, 4, -1]] }))!.features[1].areas).toEqual([[1, 2, 300], [3, 4]]);
    // Newest picks also list what bounds the area; anything that isn't a curve id with its side is dropped.
    expect(parseDocument(docWith({ areas: [[1, 2, 300, "l1+", "l2-"], [5, 6, 7, "bad"]] }))!.features[1].areas).toEqual([[1, 2, 300, "l1+", "l2-"]]);
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

describe("picks follow their areas when the sketch changes", () => {
  /** The same sketch with its points moved (curves and their ids unchanged), as editing it would. */
  const movePoints = (s: SketchData, f: (x: number, y: number) => [number, number]): SketchData => ({
    ...s,
    points: s.points.map((p) => {
      const [x, y] = f(p.x, p.y);
      return { ...p, x, y };
    }),
  });
  /** A W × 30 rectangle with upright dividers at the given x positions. */
  const strips = (w: number, ...xs: number[]): SketchData => {
    let s = rect(emptySketch(), 0, 0, w, 30);
    for (const x of xs) s = addLine(s, at(x, 0), at(x, 30)).sketch;
    return s;
  };
  /** Pick the area round a point, then find what that pick means in the edited sketch: its area (or -1). */
  const follow = (before: SketchData, at: Pt, after: SketchData) => {
    const m = sketchAreas(before);
    const pick = pickOf(m.areas[m.areaAt(at)]);
    const now = sketchAreas(after);
    const i = matchArea(now, pick);
    return i < 0 ? -1 : now.areas[i].area;
  };
  type Pt = [number, number];
  /** Areas with curved edges are measured on their straight-piece outlines: within half a percent. */
  const near = (got: number, want: number) => expect(Math.abs(got / want - 1)).toBeLessThan(0.005);

  it("remembers a pick by a point inside, its size and what bounds it", () => {
    const s = strips(40, 10);
    const m = sketchAreas(s);
    const pick = pickOf(m.areas[m.areaAt([5, 5])]);
    expect(pick[2]).toBe(300);
    expect(pick[0]).toBeCloseTo(5, 1);
    expect(pick[1]).toBeCloseTo(15, 0);
    // Bounded by four lines: three sides of the rectangle and the divider.
    expect(pick.slice(3)).toHaveLength(4);
    const divider = s.curves[4].id;
    expect(pick.slice(3).some((x) => x === `${divider}+` || x === `${divider}-`)).toBe(true);
  });

  it("the divider moved (even past the saved point): still the left strip", () => {
    const s = strips(40, 10);
    for (const d of [4, 2, 1]) expect(follow(s, [5, 15], movePoints(s, (x, y) => [x === 10 ? d : x, y]))).toBeCloseTo(d * 30, 9);
  });

  it("a quarter-split shape made narrower or wider: still the right part", () => {
    const s = strips(40, 10);
    for (const w of [20, 80, 120]) expect(follow(s, [25, 15], movePoints(s, (x, y) => [x === 10 ? w / 4 : x === 40 ? w : x, y]))).toBeCloseTo(w * 0.75 * 30, 9);
  });

  it("halves of a shape made two or three times as wide", () => {
    const s = strips(40, 20);
    for (const k of [2, 3]) {
      const wide = movePoints(s, (x, y) => [x * k, y]);
      expect(follow(s, [5, 15], wide)).toBeCloseTo(600 * k, 9);
      expect(follow(s, [35, 15], wide)).toBeCloseTo(600 * k, 9);
    }
  });

  it("the whole sketch scaled or moved", () => {
    const s = strips(40, 10);
    for (const k of [2, 3, 0.5]) expect(follow(s, [5, 15], movePoints(s, (x, y) => [x * k, y * k]))).toBeCloseTo(300 * k * k, 9);
    for (const d of [20, 50, 200]) expect(follow(s, [5, 15], movePoints(s, (x, y) => [x + d, y + d]))).toBeCloseTo(300, 9);
  });

  it("a hole made bigger: the plate stays the plate and the disc the disc", () => {
    let s = rect(emptySketch(), 0, 0, 40, 30);
    s = addCircle(s, at(20, 15), 5).sketch;
    const big: SketchData = { ...s, curves: s.curves.map((c) => (c.type === "circle" ? { ...c, radius: 14 } : c)) };
    near(follow(s, [2, 2], big), 1200 - Math.PI * 196);
    near(follow(s, [20, 15], big), Math.PI * 196);
  });

  it("a pipe's wall made thinner or thicker", () => {
    let s = addCircle(emptySketch(), at(0, 0), 20).sketch;
    s = addCircle(s, at(0, 0), 18).sketch;
    const inner = s.curves[1].id;
    for (const r of [19, 16]) {
      const t: SketchData = { ...s, curves: s.curves.map((c) => (c.id === inner && c.type === "circle" ? { ...c, radius: r } : c)) };
      near(follow(s, [19, 0], t), Math.PI * (400 - r * r));
      near(follow(s, [0, 0], t), Math.PI * r * r);
    }
  });

  it("the middle of three strips, squeezed and moved", () => {
    const s = strips(60, 20, 40);
    expect(follow(s, [30, 15], movePoints(s, (x, y) => [x === 20 ? 28 : x === 40 ? 32 : x, y]))).toBeCloseTo(120, 9);
    expect(follow(s, [30, 15], movePoints(s, (x, y) => [x === 20 ? 5 : x === 40 ? 10 : x, y]))).toBeCloseTo(150, 9);
  });

  it("thin areas find themselves again unchanged (a thin ring, a sliver)", () => {
    let ring = addCircle(emptySketch(), at(0, 0), 100).sketch;
    ring = addCircle(ring, at(0, 0), 99).sketch;
    near(follow(ring, [99.5, 0], ring), Math.PI * (10000 - 9801));
    const sliver = rect(emptySketch(), 0, 0, 40, 0.01);
    expect(follow(sliver, [20, 0.005], sliver)).toBeCloseTo(0.4, 9);
  });

  it("two overlapping circles: the lens and each crescent, as one circle moves", () => {
    let s = addCircle(emptySketch(), at(0, 0), 10).sketch;
    s = addCircle(s, at(10, 0), 10).sketch;
    const b = s.curves[1].type === "circle" ? s.curves[1].center : "";
    const shift = (dx: number): SketchData => ({ ...s, points: s.points.map((p) => (p.id === b ? { ...p, x: p.x + dx } : p)) });
    // Moved a little (still overlapping): each keeps its own area.
    const lens = (d: number) => 2 * 100 * Math.acos(d / 20) - (d / 2) * Math.sqrt(400 - d * d);
    near(follow(s, [5, 0], shift(5)), lens(15));
    // The crescents: A's stays round the origin, B's moves with B.
    const m0 = sketchAreas(shift(5));
    const cA = matchArea(m0, pickOf(sketchAreas(s).areas[sketchAreas(s).areaAt([-5, 0])]));
    const cB = matchArea(m0, pickOf(sketchAreas(s).areas[sketchAreas(s).areaAt([15, 0])]));
    near(m0.areas[cA].area, 100 * Math.PI - lens(15));
    expect(m0.areas[cA].centroid[0]).toBeLessThan(0);
    expect(m0.areas[cB].centroid[0]).toBeGreaterThan(15);
    // Moved apart: each crescent becomes its whole circle.
    const apart = shift(20);
    const m = sketchAreas(s);
    const crescentA = pickOf(m.areas[m.areaAt([-5, 0])]);
    const crescentB = pickOf(m.areas[m.areaAt([15, 0])]);
    const now = sketchAreas(apart);
    expect(now.areas[matchArea(now, crescentA)].centroid[0]).toBeCloseTo(0, 6);
    expect(now.areas[matchArea(now, crescentB)].centroid[0]).toBeCloseTo(30, 6);
  });

  it("deleting the divider: the strip picked is gone", () => {
    const s = strips(40, 10);
    const divider = s.curves[4].id;
    const without: SketchData = { ...s, curves: s.curves.filter((c) => c.id !== divider) };
    expect(follow(s, [5, 15], without)).toBe(-1);
    const m = sketchAreas(s);
    expect(regionsAt(without, [pickOf(m.areas[m.areaAt([5, 15])])]).missing).toBe(1);
  });

  it("turning the divider into construction: the strip picked is gone too", () => {
    const s = strips(40, 10);
    const divider = s.curves[4].id;
    const asConstruction: SketchData = { ...s, curves: s.curves.map((c) => (c.id === divider ? { ...c, construction: true } : c)) };
    expect(follow(s, [5, 15], asConstruction)).toBe(-1);
  });

  it("a plate with hundreds of holes: the pick stays short, and survives a save and load", () => {
    let s = rect(emptySketch(), 0, 0, 240, 250);
    const points = [...s.points];
    const curves = [...s.curves];
    for (let i = 0; i < 24; i++)
      for (let j = 0; j < 25; j++) {
        points.push({ id: `h${i}-${j}c`, x: 5 + i * 10, y: 5 + j * 10 });
        curves.push({ id: `h${i}-${j}`, type: "circle", center: `h${i}-${j}c`, radius: 3, construction: false });
      }
    s = { ...s, points, curves };
    const m = sketchAreas(s);
    const pick = pickOf(m.areas[m.areaAt([10, 10])]);
    // The plate's outline: its four sides (its 600 holes aren't listed).
    expect(pick).toHaveLength(7);
    const doc = emptyDocument("Plate");
    const saved = {
      ...doc,
      features: [
        { id: "s1", name: "Sketch 1", type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane: { kind: "default", name: "Top" }, data: s } },
        { id: "e1", name: "Extrude 1", type: "extrude", operation: "new", suppressed: false, params: { depth: "10" }, sketchRef: "s1", extrude: { end: "blind", flip: false }, areas: [pick] },
      ],
    };
    const back = parseDocument(JSON.parse(JSON.stringify(saved)))!;
    expect(back.features[1].areas).toEqual([pick]);
    const r = regionsAt(back.features[0].sketch!.data, back.features[1].areas!);
    expect(r.missing).toBe(0);
    expect(r.regions).toHaveLength(1);
    expect(r.regions[0].holes).toHaveLength(600);
  });

  it("older picks (just a point, or a point and size) still work as before", () => {
    const s = strips(40, 10);
    const moved = movePoints(s, (x, y) => [x === 10 ? 4 : x, y]);
    // Just the point: the area round it.
    expect(sketchAreas(moved).areas[matchArea(sketchAreas(moved), [5, 15])].area).toBeCloseTo(1080, 9);
    // Point and size: nearest centre and size.
    expect(sketchAreas(moved).areas[matchArea(sketchAreas(moved), [5, 15, 300])].area).toBeCloseTo(120, 9);
  });

  it("rounds a pick's point to suit the area's size", () => {
    const tiny = sketchAreas(rect(emptySketch(), 0, 0, 0.04, 0.03)).areas[0];
    const p = pointInside(tiny);
    // Still well inside a 0.04 × 0.03 rectangle (a fixed 0.0001 rounding would land near its edge).
    expect(p[0]).toBeGreaterThan(0.01);
    expect(p[0]).toBeLessThan(0.03);
    expect(p[1]).toBeGreaterThan(0.005);
    expect(p[1]).toBeLessThan(0.025);
  });
});

describe("what 'every closed shape' uses", () => {
  it("a plate with a circle: the plate is used, the disc (a hole) isn't", () => {
    let s = rect(emptySketch(), 0, 0, 40, 30);
    s = addCircle(s, at(20, 15), 5).sketch;
    const m = sketchAreas(s);
    expect([...areasUsedByAll(s)]).toEqual([m.areaAt([2, 2])]);
  });

  it("a line across a rectangle: both halves are used", () => {
    let s = rect(emptySketch(), 0, 0, 40, 30);
    s = addLine(s, at(10, 0), at(10, 30)).sketch;
    expect(areasUsedByAll(s).size).toBe(2);
  });
});
