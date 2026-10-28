/**
 * Tangent lines while drawing (Onshape's tangent inference): from one circle
 * or arc to another (outer and crossing lines), and from a point to a circle.
 */
import { describe, expect, it } from "vitest";

import { addArc, addCircle, addDimension, curveById, pointPos, setDimensionValue, type Placed } from "../src/sketch/ops";
import { circleTangents, pointTangents, addTangentLine, tangentLineAt } from "../src/sketch/tangents";
import type { RefEdge } from "../src/sketch/links";
import { solveSketch } from "../src/sketch/solver";
import { emptySketch, type SketchData, type SketchLine } from "../src/sketch/types";

type P2 = [number, number];
const round = (p: P2, d = 5): P2 => [Math.round(p[0] * 10 ** d) / 10 ** d, Math.round(p[1] * 10 ** d) / 10 ** d];

/** Distance from a point to the (infinite) line through a and b. */
const toLine = (p: P2, a: P2, b: P2) => Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Two circles: r5 at (0, 0) and r3 at (20, 0). */
function twoCircles(): { s: SketchData; c1: string; c2: string } {
  const a = addCircle(emptySketch(), { x: 0, y: 0 }, 5);
  const b = addCircle(a.sketch, { x: 20, y: 0 }, 3);
  return { s: b.sketch, c1: a.circleId, c2: b.circleId };
}

const s99 = Math.sqrt(0.99);
const s84 = Math.sqrt(0.84);

describe("tangent lines between two circles", () => {
  it("finds the two outer and two crossing lines (r5 at 0,0 and r3 at 20,0)", () => {
    const t = circleTangents([0, 0], 5, [20, 0], 3);
    const outer = t.filter((x) => x.kind === "outer").map((x) => [round(x.a), round(x.b)]);
    const crossing = t.filter((x) => x.kind === "crossing").map((x) => [round(x.a), round(x.b)]);
    // Outer: the line's normal makes cos θ = (3 − 5) / 20 = −0.1 with the centre line.
    expect(outer).toEqual([
      [round([0.5, -5 * s99]), round([20.3, -3 * s99])],
      [round([0.5, 5 * s99]), round([20.3, 3 * s99])],
    ]);
    // Crossing: cos θ = −(5 + 3) / 20 = −0.4; the line passes between the circles.
    expect(crossing).toEqual([
      [round([2, -5 * s84]), round([18.8, 3 * s84])],
      [round([2, 5 * s84]), round([18.8, -3 * s84])],
    ]);
    expect(round([0.5, 5 * s99], 5)).toEqual([0.5, 4.97494]);
    expect(round([18.8, 3 * s84], 5)).toEqual([18.8, 2.74955]);
    // Each one touches both circles: 5 from (0, 0) and 3 from (20, 0).
    for (const x of t) {
      expect(toLine([0, 0], x.a, x.b)).toBeCloseTo(5, 9);
      expect(toLine([20, 0], x.a, x.b)).toBeCloseTo(3, 9);
    }
  });

  it("has no crossing lines when the circles overlap, and none at all when one is inside the other", () => {
    expect(circleTangents([0, 0], 5, [6, 0], 3).map((x) => x.kind)).toEqual(["outer", "outer"]);
    expect(circleTangents([0, 0], 5, [1, 0], 2)).toEqual([]);
    expect(circleTangents([0, 0], 5, [0, 0], 3)).toEqual([]);
  });

  it("from a point: the two places a line just touches the circle", () => {
    const t = pointTangents([10, 0], [0, 0], 5).map((p) => round(p));
    expect(t).toEqual([round([2.5, 5 * Math.sin(Math.PI / 3)]), round([2.5, -5 * Math.sin(Math.PI / 3)])]);
    expect(pointTangents([3, 0], [0, 0], 5)).toEqual([]);
  });
});

describe("drawing a tangent line", () => {
  const onRim = (id: string, x: number, y: number): Placed => ({ x, y, snap: { kind: "curve", id } });

  it("offers the outer line near the top of the second circle, and the crossing one near its bottom", () => {
    const { s, c1, c2 } = twoCircles();
    const start = onRim(c1, 0, 5);
    const top = tangentLineAt(s, start, 20.4, 3.2, 1);
    expect(top?.kind).toBe("outer");
    expect(round(top!.start)).toEqual(round([0.5, 5 * s99]));
    expect(round(top!.end)).toEqual(round([20.3, 3 * s99]));
    expect(top!.startOn).toEqual({ kind: "curve", id: c1 });
    expect(top!.endOn).toEqual({ kind: "curve", id: c2 });
    const bottom = tangentLineAt(s, start, 18.7, -2.9, 1);
    expect(bottom?.kind).toBe("crossing");
    expect(round(bottom!.start)).toEqual(round([2, 5 * s84]));
    expect(round(bottom!.end)).toEqual(round([18.8, -3 * s84]));
    // Too far from where a line would touch: nothing offered.
    expect(tangentLineAt(s, start, 23, 0, 1)).toBeNull();
  });

  it("makes the line with its ends on both circles and Tangent to each, and it stays tangent when a circle changes size", () => {
    const { s, c1, c2 } = twoCircles();
    const start = onRim(c1, 0, 5);
    const t = tangentLineAt(s, start, 20.4, 3.2, 1)!;
    const r = addTangentLine(s, start, t);
    expect(r.error).toBeUndefined();
    const line = curveById(r.sketch, r.lineId) as SketchLine;
    expect(round(pointPos(r.sketch, line.p1), 4)).toEqual(round([0.5, 5 * s99], 4));
    expect(round(pointPos(r.sketch, line.p2), 4)).toEqual(round([20.3, 3 * s99], 4));
    const kinds = r.sketch.constraints.map((k) => `${k.type}:${k.refs.join(",")}`);
    expect(kinds).toContain(`tangent:${r.lineId},${c1}`);
    expect(kinds).toContain(`tangent:${r.lineId},${c2}`);
    expect(kinds).toContain(`pointOnCircle:${line.p1},${c1}`);
    expect(kinds).toContain(`pointOnCircle:${line.p2},${c2}`);
    expect(r.endId).toBe(line.p2);
    // Make the small circle 4 mm across (a circle is dimensioned by its diameter): the line follows round both circles.
    const dim = addDimension(r.sketch, [c2]);
    const bigger = setDimensionValue(dim.sketch, dim.dimensionId, "4");
    expect(bigger.error).toBeUndefined();
    const k = bigger.sketch;
    const [a, b] = [pointPos(k, line.p1), pointPos(k, line.p2)];
    // Wherever the solver left the circles, the line still just touches each (at its ends).
    for (const [id, end] of [[c1, a], [c2, b]] as const) {
      const c = curveById(k, id);
      if (c?.type !== "circle") throw new Error("circle gone");
      const centre = pointPos(k, c.center);
      expect(toLine(centre, a, b)).toBeCloseTo(c.radius, 6);
      expect(Math.hypot(end[0] - centre[0], end[1] - centre[1])).toBeCloseTo(c.radius, 6);
    }
    expect((curveById(k, c2) as { radius: number }).radius).toBeCloseTo(2, 9);
    expect(solveSketch(k).ok).toBe(true);
  });

  it("makes a crossing line too", () => {
    const { s, c1 } = twoCircles();
    const start = onRim(c1, 0, -5);
    const t = tangentLineAt(s, start, 18.9, 2.6, 1)!;
    expect(t.kind).toBe("crossing");
    const r = addTangentLine(s, start, t);
    const line = curveById(r.sketch, r.lineId) as SketchLine;
    expect(round(pointPos(r.sketch, line.p1), 4)).toEqual(round([2, -5 * s84], 4));
    expect(round(pointPos(r.sketch, line.p2), 4)).toEqual(round([18.8, 3 * s84], 4));
  });

  it("from a free point: the line ends where it just touches the circle", () => {
    const a = addCircle(emptySketch(), { x: 0, y: 0 }, 5);
    const start: Placed = { x: 10, y: 0, snap: null };
    const t = tangentLineAt(a.sketch, start, 2.4, 4.5, 1)!;
    expect(t.kind).toBe("point");
    expect(round(t.start)).toEqual([10, 0]);
    expect(round(t.end)).toEqual(round([2.5, 5 * Math.sin(Math.PI / 3)]));
    const r = addTangentLine(a.sketch, start, t);
    const line = curveById(r.sketch, r.lineId) as SketchLine;
    expect(round(pointPos(r.sketch, line.p1), 4)).toEqual([10, 0]);
    expect(round(pointPos(r.sketch, line.p2), 4)).toEqual(round([2.5, 5 * Math.sin(Math.PI / 3)], 4));
    expect(r.sketch.constraints.filter((k) => k.type === "tangent")).toHaveLength(1);
  });

  it("an arc counts, but only where the line would touch the arc itself", () => {
    const a = addCircle(emptySketch(), { x: 0, y: 0 }, 5);
    // The top half of a circle r3 round (20, 0): from (23, 0) anticlockwise to (17, 0), through (20, 3).
    const arc = addArc(a.sketch, { x: 23, y: 0 }, { x: 17, y: 0 }, { x: 20, y: 3 });
    expect(arc.error).toBeUndefined();
    const start = onRim(a.circleId, 0, 5);
    const top = tangentLineAt(arc.sketch, start, 20.4, 3.2, 1);
    expect(top?.kind).toBe("outer");
    expect(round(top!.end)).toEqual(round([20.3, 3 * s99]));
    // The bottom half isn't there: no line touching it is offered.
    expect(tangentLineAt(arc.sketch, start, 20.4, -3.2, 1)).toBeNull();
    const r = addTangentLine(arc.sketch, start, top!);
    expect(r.error).toBeUndefined();
    expect(r.sketch.constraints.some((k) => k.type === "tangent" && k.refs[1] === arc.arcId)).toBe(true);
  });

  it("a circle shown from elsewhere (a part edge) is brought in and followed", () => {
    const a = addCircle(emptySketch(), { x: 0, y: 0 }, 5);
    const hole: RefEdge = {
      pick: { partId: "box", ref: { kind: "edge", curve: "CIRCLE", a: [23, 0, 0], b: [23, 0, 0], mid: [17, 0, 0] } },
      project: true,
      kind: "circle",
      a: [23, 0],
      b: [23, 0],
      mid: [17, 0],
      centre: [20, 0],
      radius: 3,
    };
    const start = onRim(a.circleId, 0, 5);
    const t = tangentLineAt(a.sketch, start, 20.4, 3.2, 1, [hole])!;
    expect(t.endOn).toEqual({ kind: "ref", edge: hole });
    const r = addTangentLine(a.sketch, start, t);
    expect(r.error).toBeUndefined();
    const brought = r.sketch.curves.find((c) => c.type === "circle" && "link" in c && c.link);
    expect(brought?.construction).toBe(true);
    expect(r.sketch.constraints.some((k) => k.type === "tangent" && k.refs[1] === brought!.id)).toBe(true);
    const line = curveById(r.sketch, r.lineId) as SketchLine;
    expect(round(pointPos(r.sketch, line.p2), 4)).toEqual(round([20.3, 3 * s99], 4));
  });

  it("between two circles of another sketch: a click on the first's rim starts it, both come in and are held tangent", () => {
    const circle = (item: string, cx: number, r: number): RefEdge => ({
      kind: "circle",
      a: [cx + r, 0],
      b: [cx + r, 0],
      mid: [cx - r, 0],
      centre: [cx, 0],
      radius: r,
      source: { sketch: "skA", item, ends: { c: `${item}c` } },
    });
    const refs = [circle("k1", 0, 5), circle("k2", 20, 3)];
    const start: Placed = { x: 0.05, y: 5.02, snap: null };
    const t = tangentLineAt(emptySketch(), start, 20.4, 3.2, 1, refs)!;
    expect(t.kind).toBe("outer");
    expect(round(t.start)).toEqual(round([0.5, 5 * s99]));
    expect(round(t.end)).toEqual(round([20.3, 3 * s99]));
    const r = addTangentLine(emptySketch(), start, t);
    expect(r.error).toBeUndefined();
    const linked = r.sketch.curves.filter((c) => c.type === "circle" && "link" in c && c.link);
    expect(linked.map((c) => ("link" in c ? c.link : null))).toEqual([
      { sketch: "skA", item: "k1" },
      { sketch: "skA", item: "k2" },
    ]);
    expect(r.sketch.constraints.filter((k) => k.type === "tangent")).toHaveLength(2);
    const line = curveById(r.sketch, r.lineId) as SketchLine;
    expect(round(pointPos(r.sketch, line.p1), 4)).toEqual(round([0.5, 5 * s99], 4));
    expect(round(pointPos(r.sketch, line.p2), 4)).toEqual(round([20.3, 3 * s99], 4));
  });
});
