import { describe, expect, it } from "vitest";

import { addArc, addCircle, addPoint, applyRelation, arcSweep, dragPoint, addDimension, addLine, dimensionFor, dragArcRim, measure, measureToOf, pointPos, setDimensionValue, setMeasureTo } from "../src/sketch/ops";
import { dimensionLayout } from "../src/sketch/layout";
import { parseSketchData } from "../src/sketch/validate";
import { solveSketch } from "../src/sketch/solver";
import { emptySketch, type SketchArc, type SketchCircle, type SketchData } from "../src/sketch/types";

const at = (x: number, y: number) => ({ x, y });
const arcOf = (s: SketchData) => s.curves.find((c): c is SketchArc => c.type === "arc")!;
const r2 = Math.SQRT1_2 * 10;

describe("dragging an arc's rim", () => {
  it("changes its radius and keeps its centre and its angle", () => {
    const a = addArc(emptySketch(), at(10, 0), at(0, 10), at(r2, r2));
    const arc = arcOf(a.sketch);
    const c0 = pointPos(a.sketch, arc.center);
    expect(c0[0]).toBeCloseTo(0, 9);
    expect(c0[1]).toBeCloseTo(0, 9);
    const s = dragArcRim(a.sketch, a.arcId, 15);
    const c = pointPos(s, arc.center);
    expect(c[0]).toBeCloseTo(0, 6);
    expect(c[1]).toBeCloseTo(0, 6);
    const st = pointPos(s, arc.start);
    const en = pointPos(s, arc.end);
    expect(st[0]).toBeCloseTo(15, 6);
    expect(st[1]).toBeCloseTo(0, 6);
    expect(en[0]).toBeCloseTo(0, 6);
    expect(en[1]).toBeCloseTo(15, 6);
  });

  it("pulls a line joined to its end along, and leaves the line's far end where it was", () => {
    let s = addArc(emptySketch(), at(10, 0), at(0, 10), at(r2, r2)).sketch;
    const arc = arcOf(s);
    s = addLine(s, { x: 10, y: 0, snap: { kind: "point", id: arc.start } }, at(30, 0)).sketch;
    const line = s.curves.find((c) => c.type === "line")!;
    const far = line.type === "line" ? (line.p1 === arc.start ? line.p2 : line.p1) : "";
    // The line starts on the arc's end (joined, not just touching).
    expect(line.type === "line" && [line.p1, line.p2].includes(arc.start)).toBe(true);
    const out = dragArcRim(s, arc.id, 12);
    expect(pointPos(out, arc.start)[0]).toBeCloseTo(12, 6);
    expect(pointPos(out, far)[0]).toBeCloseTo(30, 6);
    expect(pointPos(out, far)[1]).toBeCloseTo(0, 6);
  });

  it("can't change a radius held by a dimension", () => {
    const a = addArc(emptySketch(), at(10, 0), at(0, 10), at(r2, r2));
    const d = addDimension(a.sketch, [a.arcId]);
    expect(d.error).toBeUndefined();
    const out = dragArcRim(d.sketch, a.arcId, 20);
    const arc = arcOf(out);
    const st = pointPos(out, arc.start);
    const c = pointPos(out, arc.center);
    expect(Math.hypot(st[0] - c[0], st[1] - c[1])).toBeCloseTo(10, 6);
  });
});

describe("arc length and arc angle dimensions", () => {
  // A quarter circle of radius 10 round (0, 0).
  const quarter = () => {
    const a = addArc(emptySketch(), at(10, 0), at(0, 10), at(r2, r2));
    return { s: a.sketch, arc: arcOf(a.sketch) };
  };

  it("an arc and its centre give its angle; an arc and one of its ends give its length", () => {
    const { s, arc } = quarter();
    expect(dimensionFor(s, [arc.id, arc.center])).toEqual({ type: "arcAngle", refs: [arc.id] });
    expect(dimensionFor(s, [arc.end, arc.id])).toEqual({ type: "arcLength", refs: [arc.id] });
    expect(dimensionFor(s, [arc.id])).toEqual({ type: "radius", refs: [arc.id] });
    const ang = addDimension(s, [arc.id, arc.center]);
    expect(ang.sketch.constraints[0].value).toBe("90");
    const len = addDimension(s, [arc.id, arc.start]);
    expect(Number(len.sketch.constraints[0].value)).toBeCloseTo(5 * Math.PI, 2);
  });

  it("typing an angle turns the arc's end round its centre (the start and radius stay)", () => {
    const { s, arc } = quarter();
    const d0 = addDimension(s, [arc.id, arc.center]);
    // Hold the start where it is, so only the end can move.
    const id = d0.sketch.constraints[0].id;
    const d = { ...d0, sketch: { ...d0.sketch, constraints: [...d0.sketch.constraints, { id: "fx", type: "fix" as const, refs: [arc.start], extra: [10, 0] }, { id: "fc", type: "fix" as const, refs: [arc.center], extra: [0, 0] }] } };
    const r = setDimensionValue(d.sketch, id, "120");
    expect(r.error).toBeUndefined();
    const e = pointPos(r.sketch, arc.end);
    expect(e[0]).toBeCloseTo(10 * Math.cos((2 * Math.PI) / 3), 6);
    expect(e[1]).toBeCloseTo(10 * Math.sin((2 * Math.PI) / 3), 6);
    expect(measure(r.sketch, r.sketch.constraints.find((c) => c.id === id)!)).toBeCloseTo(120, 6);
    expect(setDimensionValue(d.sketch, id, "360").error).toMatch(/less than 360/);
  });

  it("typing a length makes the arc that long round its rim", () => {
    const { s, arc } = quarter();
    const d = addDimension(s, [arc.id, arc.end]);
    const id = d.sketch.constraints[0].id;
    // Radius 10 held too: a length of 10π makes it a half circle.
    const r1 = addDimension(d.sketch, [arc.id]);
    const r = setDimensionValue(r1.sketch, id, String(10 * Math.PI));
    expect(r.error).toBeUndefined();
    const c = pointPos(r.sketch, arc.center);
    const st = pointPos(r.sketch, arc.start);
    const en = pointPos(r.sketch, arc.end);
    expect(Math.hypot(st[0] - c[0], st[1] - c[1])).toBeCloseTo(10, 6);
    // Half way round: the ends are opposite each other, 20 apart.
    expect(Math.hypot(en[0] - st[0], en[1] - st[1])).toBeCloseTo(20, 6);
  });

  it("draws an arc for the dimension, and survives a save and load", () => {
    const { s, arc } = quarter();
    const d = addDimension(s, [arc.id, arc.end], { x: 3, y: 3 });
    const layout = dimensionLayout(d.sketch, d.sketch.constraints[0])!;
    // The label sits 3, 3 from the middle of the arc.
    const c = pointPos(d.sketch, arc.center);
    const st = pointPos(d.sketch, arc.start);
    const rad = Math.hypot(st[0] - c[0], st[1] - c[1]);
    const a0 = Math.atan2(st[1] - c[1], st[0] - c[0]);
    expect(layout.label[0]).toBeCloseTo(c[0] + rad * Math.cos(a0 + arcSweep(d.sketch, arc) / 2) + 3, 9);
    expect(layout.label[1]).toBeCloseTo(c[1] + rad * Math.sin(a0 + arcSweep(d.sketch, arc) / 2) + 3, 9);
    expect(layout.lines.length).toBeGreaterThan(8);
    const back = parseSketchData(JSON.parse(JSON.stringify(d.sketch)))!;
    expect(back.constraints[0].type).toBe("arcLength");
  });
});

describe("measuring to circles' edges", () => {
  const two = () => {
    let s = addCircle(emptySketch(), at(0, 0), 5).sketch;
    s = addCircle(s, at(30, 0), 3).sketch;
    const [a, b] = s.curves as SketchCircle[];
    return { s, a, b };
  };

  it("switches a centre-to-centre distance to the nearest or furthest edges, keeping the shape", () => {
    const { s, a, b } = two();
    const d = addDimension(s, [a.id, b.id]);
    const id = d.sketch.constraints[0].id;
    expect(d.sketch.constraints[0].type).toBe("distance");
    expect(measureToOf(d.sketch, d.sketch.constraints[0])).toBe("centre");
    const near = setMeasureTo(d.sketch, id, "nearest");
    expect(near.error).toBeUndefined();
    const c = near.sketch.constraints[0];
    expect(c.type).toBe("rimDistance");
    expect(Number(c.value)).toBeCloseTo(22, 9);
    expect(measureToOf(near.sketch, c)).toBe("nearest");
    const far = setMeasureTo(near.sketch, id, "furthest");
    expect(Number(far.sketch.constraints[0].value)).toBeCloseTo(38, 9);
    const back = setMeasureTo(far.sketch, id, "centre");
    expect(back.sketch.constraints[0].type).toBe("distance");
    expect(Number(back.sketch.constraints[0].value)).toBeCloseTo(30, 9);
  });

  it("typing a gap between the edges moves the circles to that gap", () => {
    const { s, a, b } = two();
    const first = addDimension(s, [a.id, b.id]);
    const id = first.sketch.constraints[0].id;
    let sk: SketchData = setMeasureTo(first.sketch, id, "nearest").sketch;
    // Hold the circles' sizes too.
    sk = addDimension(sk, [a.id]).sketch;
    sk = addDimension(sk, [b.id]).sketch;
    const r = setDimensionValue(sk, id, "10");
    expect(r.error).toBeUndefined();
    const ca = pointPos(r.sketch, a.center);
    const cb = pointPos(r.sketch, b.center);
    expect(Math.hypot(cb[0] - ca[0], cb[1] - ca[1])).toBeCloseTo(18, 6);
  });

  it("a circle inside another: the narrowest gap of the ring between them", () => {
    let s = addCircle(emptySketch(), at(0, 0), 20).sketch;
    s = addCircle(s, at(5, 0), 4).sketch;
    const [a, b] = s.curves as SketchCircle[];
    const d = addDimension(s, [a.id, b.id]);
    const near = setMeasureTo(d.sketch, d.sketch.constraints[0].id, "nearest");
    // 20 − 5 − 4 = 11.
    expect(Number(near.sketch.constraints[0].value)).toBeCloseTo(11, 9);
    expect(near.sketch.constraints[0].extra).toEqual([-1, 1]);
    expect(solveSketch(near.sketch).ok).toBe(true);
  });

  it("circles that overlap have no gap to measure", () => {
    let s = addCircle(emptySketch(), at(0, 0), 5).sketch;
    s = addCircle(s, at(6, 0), 3).sketch;
    const [a, b] = s.curves as SketchCircle[];
    const d = addDimension(s, [a.id, b.id]);
    expect(setMeasureTo(d.sketch, d.sketch.constraints[0].id, "nearest").error).toMatch(/overlap/);
    expect(setMeasureTo(d.sketch, d.sketch.constraints[0].id, "furthest").error).toBeUndefined();
  });

  it("a line and a circle: to the near or far side of the circle", () => {
    let s = addCircle(emptySketch(), at(0, 10), 4).sketch;
    s = addLine(s, at(-20, 0), at(20, 0)).sketch;
    const circle = s.curves.find((c) => c.type === "circle")!;
    const line = s.curves.find((c) => c.type === "line")!;
    const d = addDimension(s, [circle.id, line.id]);
    const id = d.sketch.constraints[0].id;
    expect(d.sketch.constraints[0].type).toBe("pointLineDistance");
    const near = setMeasureTo(d.sketch, id, "nearest");
    expect(Number(near.sketch.constraints[0].value)).toBeCloseTo(6, 9);
    // The dimension line runs from the bottom of the circle down to the line.
    const lay = dimensionLayout(near.sketch, near.sketch.constraints[0])!;
    const ends = lay.lines[2];
    expect(ends[0][1]).toBeCloseTo(6, 9);
    expect(ends[1][1]).toBeCloseTo(0, 9);
    const far = setMeasureTo(near.sketch, id, "furthest");
    expect(Number(far.sketch.constraints[0].value)).toBeCloseTo(14, 9);
    // Typing a new far-side distance moves the circle (its radius held).
    const held = addDimension(far.sketch, [circle.id]).sketch;
    const r = setDimensionValue(held, id, "20");
    expect(r.error).toBeUndefined();
    // The circle's centre ends up 16 from the line (20 less its radius of 4).
    expect(measure(r.sketch, { id: "", type: "pointLineDistance", refs: [(circle as SketchCircle).center, line.id] })).toBeCloseTo(16, 6);
  });

  it("other dimensions can't be switched", () => {
    const { s, a } = two();
    const d = addDimension(s, [a.id]);
    expect(measureToOf(d.sketch, d.sketch.constraints[0])).toBeNull();
    expect(setMeasureTo(d.sketch, d.sketch.constraints[0].id, "nearest").error).toMatch(/Select a dimension between/);
  });
});

describe("a point halfway between two points", () => {
  it("puts the first point picked midway between the other two, and keeps it there", () => {
    let s = emptySketch();
    const p = addPoint(s, at(3, 4));
    s = p.sketch;
    const a = addPoint(s, at(0, 0));
    s = a.sketch;
    const b = addPoint(s, at(20, 10));
    s = b.sketch;
    const r = applyRelation(s, "midpoint", [p.pointId, a.pointId, b.pointId]);
    expect(r.error).toBeUndefined();
    const m = pointPos(r.sketch, p.pointId);
    const pa = pointPos(r.sketch, a.pointId);
    const pb = pointPos(r.sketch, b.pointId);
    expect(m[0]).toBeCloseTo((pa[0] + pb[0]) / 2, 9);
    expect(m[1]).toBeCloseTo((pa[1] + pb[1]) / 2, 9);
    // Dragging an end point carries the middle point along.
    const moved = dragPoint(r.sketch, b.pointId, 40, 30);
    const m2 = pointPos(moved, p.pointId);
    const a2 = pointPos(moved, a.pointId);
    expect(pointPos(moved, b.pointId)[0]).toBeCloseTo(40, 6);
    expect(m2[0]).toBeCloseTo((a2[0] + 40) / 2, 6);
    expect(m2[1]).toBeCloseTo((a2[1] + 30) / 2, 6);
    // Two points alone aren't enough.
    expect(applyRelation(s, "midpoint", [p.pointId, a.pointId]).error).toMatch(/three points/);
  });
});
