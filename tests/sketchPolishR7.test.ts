/** Follow-ups to Pierce, Use, Extend and offsets: in-plane stretches, near misses, spline copies respaced, crossing outlines. */
import { describe, expect, it } from "vitest";

import { followLinks, linkEdge, type RefEdge } from "../src/sketch/links";
import { addArc, addLine, addRectangle, pointPos, type Placed } from "../src/sketch/ops";
import { planeFrame } from "../src/sketch/planes";
import { edgePierces, seeShape, type CurveShape3 } from "../src/sketch/projected";
import { CROSSING_NOTE, crossingOutlineNote, offsetNotes } from "../src/sketch/offsetCheck";
import { solveSketch } from "../src/sketch/solver";
import { addPolygon, addSlot, offsetCurves } from "../src/sketch/tools";
import { emptySketch, type SketchData, type SketchSpline } from "../src/sketch/types";

type V3 = [number, number, number];
type P2 = [number, number];
const at = (x: number, y: number): Placed => ({ x, y, snap: null });
const r6 = (p: P2) => p.map((v) => Math.round(v * 1e6) / 1e6 + 0);
const TOP = planeFrame({ kind: "default", name: "Top" });

describe("where an edge passes through a plane", () => {
  it("an edge lying partly in the plane gives just the places it comes off it, not one per sample", () => {
    // Along the plane from x = 0 to 10, then up and away: it leaves the plane at (10, 0) only.
    const edge = (f: number): V3 => {
      const x = 20 * f;
      return [x, 0, x <= 10 ? 0 : (x - 10) ** 2];
    };
    expect(edgePierces(TOP, edge, 32)).toEqual([]);
    // Down through the plane, along it, and back up: still no single place (it lies in the plane there).
    const dip = (f: number): V3 => {
      const x = 30 * f;
      return [x, 0, x < 10 ? 10 - x : x > 20 ? x - 20 : 0];
    };
    expect(edgePierces(TOP, dip, 30)).toEqual([]);
    // But a sample landing on the plane where it passes through counts once.
    expect(edgePierces(TOP, (f) => [10 * f, 0, 5 - 10 * f], 2).map(r6)).toEqual([[5, 0]]);
  });

  it("finds two crossings between one pair of samples, and a dip just 1 µm through", () => {
    // A narrow dip centred on f = 0.51 (between samples 0.5 and 0.53125 of 32), 0.6 mm deep.
    const narrow = (f: number): V3 => [100 * f, 0, 1 - 1.6 * Math.exp(-(((f - 0.51) / 0.01) ** 2))];
    const two = edgePierces(TOP, narrow, 32);
    expect(two).toHaveLength(2);
    // z = 0 where exp(−d²) = 1/1.6: d = 0.01·√ln 1.6.
    const d = 0.01 * Math.sqrt(Math.log(1.6));
    expect(two[0][0]).toBeCloseTo(100 * (0.51 - d), 6);
    expect(two[1][0]).toBeCloseTo(100 * (0.51 + d), 6);
    // A wide bowl whose lowest point is 1 µm below the plane, between samples.
    const bowl = (f: number): V3 => [100 * f, 0, 40 * (f - 0.27) ** 2 - 0.001];
    const near = edgePierces(TOP, bowl, 32);
    expect(near).toHaveLength(2);
    const half = Math.sqrt(0.001 / 40);
    expect(near[0][0]).toBeCloseTo(100 * (0.27 - half), 6);
    expect(near[1][0]).toBeCloseTo(100 * (0.27 + half), 6);
    // Just touching the plane (0.01 µm above, the tolerance): one place.
    const touch = (f: number): V3 => [100 * f, 0, 40 * (f - 0.27) ** 2 + 5e-8];
    expect(edgePierces(TOP, touch, 32).map(r6)).toEqual([[27, 0]]);
    // Staying well clear: nothing (and it's not worked hard for).
    let calls = 0;
    const clear = (f: number): V3 => (calls++, [100 * f, 0, 40 * (f - 0.27) ** 2 + 0.5]);
    expect(edgePierces(TOP, clear, 32)).toEqual([]);
    expect(calls).toBe(33);
  });
});

/** A curved edge's shape (a half circle of radius r round (cx, 0)) in n pieces, seen from Top. */
function halfCircle(cx: number, r: number, n: number) {
  const sh: CurveShape3 = { points: [], tangents: [] };
  for (let i = 0; i <= n; i++) {
    const t = (Math.PI * i) / n;
    sh.points.push([cx + r * Math.cos(t), r * Math.sin(t), 0]);
    sh.tangents.push([(-r * Math.sin(t) * Math.PI) / n, (r * Math.cos(t) * Math.PI) / n, 0]);
  }
  return seeShape(TOP, sh)!;
}

describe("a spline following a curved edge", () => {
  const edge = (shape: ReturnType<typeof halfCircle>): RefEdge => ({
    pick: { partId: "p", ref: { kind: "edge", curve: "BSPLINE_CURVE", a: [10, 0, 0], b: [-10, 0, 0], mid: [0, 10, 0] } },
    kind: "curve",
    a: [10, 0],
    b: [-10, 0],
    mid: [0, 10],
    shape,
  });

  it("takes new points between its ends when the engine needs more to keep close", () => {
    const r = linkEdge(emptySketch(), edge(halfCircle(0, 10, 4)), false);
    const sp = r.sketch.curves[0] as SketchSpline;
    expect(sp.points).toHaveLength(5);
    const bigger = followLinks(r.sketch, { [sp.id]: edge(halfCircle(0, 30, 8)) });
    const after = bigger.curves[0] as SketchSpline;
    expect(after.points).toHaveLength(9);
    // Its ends keep their ids (lines drawn from them stay joined); the ones between are new, and the old ones have gone.
    expect(after.points[0]).toBe(sp.points[0]);
    expect(after.points[8]).toBe(sp.points[4]);
    for (const id of sp.points.slice(1, -1)) expect(bigger.points.some((p) => p.id === id)).toBe(false);
    expect(r6(pointPos(bigger, after.points[0]))).toEqual([30, 0]);
    expect(r6(pointPos(bigger, after.points[4]))).toEqual([0, 30]);
    // Each new point is fixed where the edge is, and the sketch still solves.
    expect(bigger.constraints.filter((k) => k.type === "fix")).toHaveLength(9);
    expect(bigger.constraints.every((k) => k.type !== "fix" || bigger.points.some((p) => p.id === k.refs[0]))).toBe(true);
    expect(solveSketch(bigger).ok).toBe(true);
  });

  it("keeps the points it has, and still follows, when something else uses one between its ends", () => {
    const r = linkEdge(emptySketch(), edge(halfCircle(0, 10, 4)), false);
    const sp = r.sketch.curves[0] as SketchSpline;
    // A line drawn from its middle point, and a text hanging from another of its points.
    const ln = addLine(r.sketch, { x: 0, y: 10, snap: { kind: "point", id: sp.points[2] } }, at(0, -20));
    const line = ln.sketch.curves.find((c) => c.id === ln.lineId) as { p1: string; p2: string };
    expect(line.p1).toBe(sp.points[2]);
    const held: SketchData = { ...ln.sketch, texts: [{ id: "t", anchor: sp.points[1], value: "A", size: 5, angle: 0, font: "regular", construction: false }] };
    const moved = followLinks(held, { [sp.id]: edge(halfCircle(0, 30, 8)) });
    const after = moved.curves.find((c) => c.id === sp.id) as SketchSpline;
    expect(after.points).toEqual(sp.points);
    // The edge's own pieces walked at the copy's four: its middle point is at the top of the new half circle, the line follows.
    expect(r6(pointPos(moved, sp.points[2]))).toEqual([0, 30]);
    expect(r6(pointPos(moved, sp.points[0]))).toEqual([30, 0]);
    expect(moved.points.some((p) => p.id === sp.points[1])).toBe(true);
    expect(moved.texts?.[0].anchor).toBe(sp.points[1]);
    // A quarter of the way round (the second of eight pieces' end), exactly on the new circle.
    expect(Math.hypot(...pointPos(moved, sp.points[1]))).toBeCloseTo(30, 9);
    expect(solveSketch(moved).ok).toBe(true);
  });
});

describe("an outline that is an offset crossing itself", () => {
  it("is noted for an extrude using it (all shapes, or an area it bounds), not otherwise", () => {
    const r = addRectangle(emptySketch(), at(0, 0), at(10, 4));
    const fine = offsetCurves(r.sketch, r.lineIds[0], { x: 5, y: 2 }, "1").sketch;
    expect(crossingOutlineNote(fine)).toBeNull();
    const bad = offsetCurves(r.sketch, r.lineIds[0], { x: 5, y: 2 }, "3");
    expect(crossingOutlineNote(bad.sketch)).toMatch(/offset copy that crosses over itself/);
    // An area bounded only by the original's lines doesn't use the copy.
    const orig = [0, 0, 40, ...r.lineIds.map((id) => `${id}+`)];
    expect(crossingOutlineNote(bad.sketch, [orig])).toBeNull();
    expect(crossingOutlineNote(bad.sketch, [[0, 0, 4, `${bad.curveIds[0]}-`, `${r.lineIds[0]}+`]])).toMatch(/crosses over itself/);
    // Older picks (no outline remembered) count as using it.
    expect(crossingOutlineNote(bad.sketch, [[5, 2]])).toMatch(/crosses over itself/);
    // A construction copy isn't extruded.
    const dashed = { ...bad.sketch, curves: bad.sketch.curves.map((c) => (bad.curveIds.includes(c.id) ? { ...c, construction: true } : c)) };
    expect(crossingOutlineNote(dashed)).toBeNull();
  });
});

describe("offsets that don't cross themselves aren't warned about", () => {
  it("slots, polygons and runs of lines and arcs, inwards and outwards", () => {
    // A slot from (0, 0) to (20, 0), radius 5: its bottom copy runs the other way round to its original.
    const slot = addSlot(emptySketch(), at(0, 0), at(20, 0), 5);
    for (const [where, d] of [[{ x: 10, y: -7 }, "1"], [{ x: 10, y: -3 }, "1"], [{ x: 10, y: -3 }, "4.5"]] as const) {
      const o = offsetCurves(slot.sketch, slot.curveIds[0], where, d);
      expect(o.error).toBeUndefined();
      expect(offsetNotes(o.sketch)).toEqual([]);
      expect(crossingOutlineNote(o.sketch)).toBeNull();
    }
    // Past its radius inwards, it really does cross.
    const deep = offsetCurves(slot.sketch, slot.curveIds[0], { x: 10, y: -3 }, "5.5");
    if (!deep.error) expect(offsetNotes(deep.sketch)).toEqual([CROSSING_NOTE]);
    // Hexagon and triangle.
    for (const sides of [3, 6]) {
      const poly = addPolygon(emptySketch(), at(0, 0), { x: 10, y: 0 }, sides);
      expect(poly.error).toBeUndefined();
      for (const [where, d] of [[{ x: 0, y: 0 }, "2"], [{ x: 30, y: 0 }, "3"]] as const) {
        const o = offsetCurves(poly.sketch, poly.lineIds[0], where, d);
        expect(o.error).toBeUndefined();
        expect(offsetNotes(o.sketch)).toEqual([]);
      }
    }
    // An open run: a line, an arc on from its end, and a line back (drawn in different directions).
    const a = addLine(emptySketch(), at(0, 0), at(10, 0));
    const end = (a.sketch.curves[0] as { p2: string }).p2;
    const arc = addArc(a.sketch, { x: 10, y: 0, snap: { kind: "point", id: end } }, at(10, 10), { x: 15, y: 5 });
    const arcEnd = (arc.sketch.curves.find((c) => c.id === arc.arcId) as { start: string; end: string });
    const top = [arcEnd.start, arcEnd.end].find((id) => id !== end)!;
    const back = addLine(arc.sketch, at(0, 10), { x: 10, y: 10, snap: { kind: "point", id: top } });
    for (const [where, d] of [[{ x: 5, y: 5 }, "1"], [{ x: 5, y: -2 }, "1"]] as const) {
      const o = offsetCurves(back.sketch, a.lineId, where, d);
      expect(o.error).toBeUndefined();
      expect(offsetNotes(o.sketch)).toEqual([]);
    }
  });
});
