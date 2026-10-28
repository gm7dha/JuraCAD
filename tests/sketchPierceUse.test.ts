/**
 * Pierce and Use on curved edges, without the geometry engine: where curves
 * pass through a sketch's plane, curved shapes seen in a sketch, and copies
 * that follow them.
 */
import { describe, expect, it } from "vitest";

import { curveParam, nearestParam } from "../src/sketch/curves";
import { followLinks, linkAllEdges, linkEdge, linkedPoints, lostLinksMessage, linkProblem, piercePoint, pruneReferences, type RefEdge } from "../src/sketch/links";
import { addCircle, addLine, curveById, pointPos, type Placed } from "../src/sketch/ops";
import { planeFrame, type PlaneFrame } from "../src/sketch/planes";
import { edgePierces, nearestPlace, seeShape, sketchCurvePierces, sketchPierceRefs, type CurveShape3 } from "../src/sketch/projected";
import { findRegions } from "../src/sketch/regions";
import { solveSketch } from "../src/sketch/solver";
import { addEllipse, addSpline } from "../src/sketch/tools";
import { emptySketch, type SketchData, type SketchEllipse, type SketchSpline } from "../src/sketch/types";
import { parseSketchData } from "../src/sketch/validate";

type P2 = [number, number];
type V3 = [number, number, number];
const at = (x: number, y: number): Placed => ({ x, y, snap: null });
const r6 = (p: P2) => p.map((v) => Math.round(v * 1e6) / 1e6 + 0);
const TOP = planeFrame({ kind: "default", name: "Top" });
const FRONT = planeFrame({ kind: "default", name: "Front" });

/** A circle of radius r round c in the plane spanned by unit vectors x and y, as a curved edge's shape (`n` pieces). */
function circleShape(c: V3, x: V3, y: V3, r: number, n: number, ellipse = false): CurveShape3 {
  const points: V3[] = [];
  const tangents: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (2 * Math.PI * i) / n;
    points.push([0, 1, 2].map((k) => c[k] + r * (Math.cos(t) * x[k] + Math.sin(t) * y[k])) as V3);
    const k = (2 * Math.PI) / n;
    tangents.push([0, 1, 2].map((j) => r * k * (-Math.sin(t) * x[j] + Math.cos(t) * y[j])) as V3);
  }
  return { points, tangents, ...(ellipse ? { ellipse: { centre: c, major: x.map((v) => v * r) as V3, minor: y.map((v) => v * r * 0.5) as V3, t0: 0, t1: 2 * Math.PI, whole: true } } : {}) };
}

describe("where curves pass through a sketch's plane", () => {
  it("another sketch's circle, line and spline, on Front, seen from Top", () => {
    // On Front, sketch y is height: z = 0 is the Top plane.
    let s = addCircle(emptySketch(), at(10, 2), 5).sketch;
    const circle = s.curves[0].id;
    const ln = addLine(s, at(-10, -4), at(-2, 4));
    s = ln.sketch;
    const src = { id: "a", plane: { kind: "default" as const, name: "Front" as const }, data: s };
    // The circle meets z = 0 where (x − 10)² + 4 = 25: x = 10 ± √21.
    const places = sketchCurvePierces(src, circle, TOP).map(r6).sort((p, q) => p[0] - q[0]);
    expect(places).toEqual([r6([10 - Math.sqrt(21), 0]), r6([10 + Math.sqrt(21), 0])]);
    // The line passes through at its middle, x = −6.
    expect(sketchCurvePierces(src, ln.lineId, TOP).map(r6)).toEqual([[-6, 0]]);
    // As references to snap to: each place once, following its curve.
    const refs = sketchPierceRefs(src, TOP);
    expect(refs).toHaveLength(3);
    expect(refs.every((e) => e.pierce && e.kind === "point" && e.source?.sketch === "a")).toBe(true);
    // Parallel sketches never pass through each other.
    const flat = { id: "b", plane: { kind: "default" as const, name: "Top" as const }, data: s };
    expect(sketchCurvePierces(flat, circle, planeFrame({ kind: "face", origin: [0, 0, 3], u: [1, 0, 0], v: [0, 1, 0], label: "" }))).toEqual([]);
    expect(sketchPierceRefs(flat, TOP)).toEqual([]);
  });

  it("an edge by points along it: changes of side are homed in on, an edge in the plane doesn't count", () => {
    // A helix-like edge round the Z axis, rising from z = −3 to z = 3 over 1½ turns.
    const helix = (f: number): V3 => [10 * Math.cos(3 * Math.PI * f), 10 * Math.sin(3 * Math.PI * f), -3 + 6 * f];
    const places = edgePierces(TOP, helix, 32);
    expect(places).toHaveLength(1);
    // Halfway up: 3π/2 round, at (0, −10).
    expect(r6(places[0])).toEqual([0, -10]);
    // A wave crossing the plane three times.
    const wave = (f: number): V3 => [30 * f, 0, Math.sin(3 * Math.PI * f)];
    expect(edgePierces(TOP, wave, 32).map(r6)).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
      [30, 0],
    ]);
    // Lying in the plane: nowhere in particular.
    expect(edgePierces(TOP, (f) => [f * 10, 0, 0], 4)).toEqual([]);
    // Nearest place to a point, and the first without one.
    expect(nearestPlace([[0, 0], [10, 0], [20, 0]], [12, 3])).toEqual([10, 0]);
    expect(nearestPlace([], [0, 0])).toBeNull();
  });
});

describe("Pierce", () => {
  /** References as the engine gives them: an edge seen end-on at (5, 5) (its end, and where it passes through). */
  const ref = { kind: "edge" as const, curve: "LINE", a: [5, 5, -10] as V3, b: [5, 5, 10] as V3, mid: [5, 5, 0] as V3 };
  const refs: RefEdge[] = [
    { pick: { partId: "box", ref }, project: true, kind: "point", a: [5, 5], b: [5, 5], mid: [5, 5] },
    { pick: { partId: "box", ref }, project: true, pierce: true, kind: "point", a: [5, 5], b: [5, 5], mid: [5, 5] },
  ];

  it("joins the point to one that follows where the edge passes through", () => {
    const l = addLine(emptySketch(), at(0, 0), at(6, 7));
    const end = (l.sketch.curves[0] as { p2: string }).p2;
    // The edge was brought in by clicking it (seen end-on, it's its end).
    const brought = { ...l.sketch, points: [...l.sketch.points, { id: "e", x: 5, y: 5, link: { partId: "box", ref, end: "a" as const } }], constraints: [...l.sketch.constraints, { id: "fx", type: "fix" as const, refs: ["e"], extra: [5, 5] }] };
    const r = piercePoint(brought, [end, "e"], refs);
    expect(r.error).toBeUndefined();
    expect(r6(pointPos(r.sketch, end))).toEqual([5, 5]);
    const p = r.sketch.points.find((q) => q.id === r.pointId)!;
    expect(p.link).toEqual({ partId: "box", ref, end: "pierce" });
    expect(r.sketch.constraints.some((k) => k.type === "coincident" && k.refs.includes(end) && k.refs.includes(p.id))).toBe(true);
    // Saved and read back, it's still a Pierce point.
    expect(parseSketchData(JSON.parse(JSON.stringify(r.sketch)))!.points.find((q) => q.id === p.id)!.link).toEqual(p.link);
    // It stays when the sketch is tidied (the end it was brought in by goes: nothing uses it now).
    const kept = pruneReferences(r.sketch);
    expect(kept.points.some((q) => q.id === p.id)).toBe(true);
    expect(kept.points.some((q) => q.id === "e")).toBe(false);
    // The engine moves it; the line's end follows.
    const moved = followLinks(r.sketch, {}, { [p.id]: [8, 5] });
    expect(r6(pointPos(moved, end))).toEqual([8, 5]);
    // Lost: said in its own words.
    const info = { edges: [], links: {}, pointLinks: { [p.id]: null } };
    expect(lostLinksMessage(r.sketch, info)).toBe(
      "A point placed where an edge or curve passes through this sketch can't be placed any more: it no longer passes through the sketch's plane (or it was deleted), so the point stays where it was. Delete it, or pierce with an edge or curve that goes through the sketch.",
    );
    expect(linkProblem(info, r.sketch)).toMatch(/^A point placed where an edge or curve passes through this sketch can't be placed any more/);
  });

  it("says what to select, and why it can't", () => {
    const l = addLine(emptySketch(), at(0, 0), at(6, 7));
    const end = (l.sketch.curves[0] as { p2: string }).p2;
    expect(piercePoint(l.sketch, [end], refs).error).toMatch(/^Select a point and an edge or curve from outside this sketch/);
    expect(piercePoint(l.sketch, [end, l.lineId], refs).error).toMatch(/part of this sketch/);
    // A curve from another sketch that has no place where it passes through.
    const other = { ...l.sketch, curves: [...l.sketch.curves, { id: "o", type: "line" as const, p1: "q1", p2: "q2", construction: true, link: { sketch: "a", item: "z" } }], points: [...l.sketch.points, { id: "q1", x: 0, y: 1 }, { id: "q2", x: 4, y: 1 }] };
    expect(piercePoint(other, [end, "o"], refs).error).toBe(
      "That curve doesn't pass through this sketch's plane (it misses it, runs alongside it or lies in it), so there's nowhere to put the point. Pick one that goes through the sketch.",
    );
  });
});

describe("Use on curved edges", () => {
  it("an ellipse lying flat comes in as an ellipse; at a slant it's a spline", () => {
    const shape = circleShape([3, 4, 2], [1, 0, 0], [0, 1, 0], 10, 16, true);
    const flat = seeShape(TOP, shape)!;
    expect(flat.kind).toBe("ellipse");
    if (flat.kind !== "ellipse") return;
    expect(r6(flat.centre)).toEqual([3, 4]);
    expect(r6(flat.major)).toEqual([13, 4]);
    expect(r6(flat.minor)).toEqual([3, 9]);
    // From Front it's seen edge-on (a straight line on paper): nothing to copy.
    expect(seeShape(FRONT, shape)).toBeNull();
    // Tipped 45° about X, seen from Top: a spline (squashed).
    const s2 = Math.SQRT1_2;
    const tipped = seeShape(TOP, circleShape([0, 0, 0], [1, 0, 0], [0, s2, s2], 10, 16, true))!;
    expect(tipped.kind).toBe("spline");
  });

  it("a whole ellipse edge: fixed, solves, and follows the edge when it's longer", () => {
    const edge: RefEdge = {
      pick: { partId: "p", ref: { kind: "edge", curve: "ELLIPSE", a: [20, 0, 0], b: [20, 0, 0], mid: [-20, 0, 0] } },
      kind: "curve",
      a: [20, 0],
      b: [20, 0],
      mid: [-20, 0],
      shape: { kind: "ellipse", centre: [0, 0], major: [20, 0], minor: [0, 10] },
    };
    const r = linkEdge(emptySketch(), edge, false);
    expect(r.error).toBeUndefined();
    const el = curveById(r.sketch, r.curveId) as SketchEllipse;
    expect(el.type).toBe("ellipse");
    expect(el.link).toEqual({ partId: "p", ref: edge.pick!.ref });
    expect(solveSketch(r.sketch).ok).toBe(true);
    // Its points are the edge's: shown as anchored, not draggable.
    expect([...linkedPoints(r.sketch)].sort()).toEqual([el.center, el.major, el.minor].sort());
    const longer = followLinks(r.sketch, { [el.id]: { ...edge, shape: { kind: "ellipse", centre: [1, 0], major: [31, 0], minor: [1, 10] } } });
    expect(r6(pointPos(longer, el.major))).toEqual([31, 0]);
    expect(r6(pointPos(longer, el.center))).toEqual([1, 0]);
    const area = findRegions(longer).regions[0].outer.area;
    expect(Math.abs(area / (Math.PI * 30 * 10) - 1)).toBeLessThan(0.005);
    // Saved and read back, the link is kept.
    expect((parseSketchData(JSON.parse(JSON.stringify(r.sketch)))!.curves[0] as SketchEllipse).link).toEqual(el.link);
  });

  it("part of an ellipse keeps its ends where the edge's are", () => {
    const edge: RefEdge = {
      pick: { partId: "p", ref: { kind: "edge", curve: "ELLIPSE", a: [20, 0, 0], b: [0, 10, 0], mid: [14.14, 7.07, 0] } },
      kind: "curve",
      a: [20, 0],
      b: [0, 10],
      mid: [14.14, 7.07],
      shape: { kind: "ellipse", centre: [0, 0], major: [20, 0], minor: [0, 10], start: [20, 0], end: [0, 10] },
    };
    const r = linkEdge(emptySketch(), edge, false);
    const el = curveById(r.sketch, r.curveId) as SketchEllipse;
    expect(r6(pointPos(r.sketch, el.start!))).toEqual([20, 0]);
    expect(r6(pointPos(r.sketch, el.end!))).toEqual([0, 10]);
    expect(r.points.a).toBe(el.start);
    expect(r.points.b).toBe(el.end);
    expect(solveSketch(r.sketch).ok).toBe(true);
  });

  it("a spline edge: exactly its pieces, following new places and handles with the same points", () => {
    const shape = seeShape(TOP, circleShape([0, 0, 0], [1, 0, 0], [0, 1, 0], 10, 16))!;
    expect(shape.kind).toBe("spline");
    if (shape.kind !== "spline") return;
    const edge: RefEdge = { pick: { partId: "p", ref: { kind: "edge", curve: "BSPLINE_CURVE", a: [10, 0, 0], b: [10, 0, 0], mid: [-10, 0, 0] } }, kind: "curve", a: [10, 0], b: [10, 0], mid: [-10, 0], shape };
    const r = linkEdge(emptySketch(), edge, false);
    expect(r.error).toBeUndefined();
    const sp = curveById(r.sketch, r.curveId) as SketchSpline;
    // Closed (its last point was its first): 16 points, each fixed.
    expect(sp.closed).toBe(true);
    expect(sp.points).toHaveLength(16);
    expect(r.sketch.constraints.filter((k) => k.type === "fix")).toHaveLength(16);
    // Sixteen cubic pieces matching a circle's places and directions: within 1 µm of its radius everywhere.
    const path = curveParam(r.sketch, sp);
    for (let i = 0; i <= 160; i++) expect(Math.abs(Math.hypot(...path.at((16 * i) / 160)) - 10)).toBeLessThan(1e-3);
    expect(solveSketch(r.sketch).ok).toBe(true);
    // The edge grows to radius 12 round (2, 0): every point and handle follows, the same points.
    const bigger = seeShape(TOP, circleShape([2, 0, 0], [1, 0, 0], [0, 1, 0], 12, 16))!;
    const moved = followLinks(r.sketch, { [sp.id]: { ...edge, shape: bigger } });
    const after = curveById(moved, sp.id) as SketchSpline;
    expect(after.points).toEqual(sp.points);
    const p2 = curveParam(moved, after);
    for (let i = 0; i <= 160; i++) {
      const q = p2.at((16 * i) / 160);
      expect(Math.abs(Math.hypot(q[0] - 2, q[1]) - 12)).toBeLessThan(1.2e-3);
    }
    // A shape with a different number of points is left alone (the engine always sends as many as the copy has).
    const other = seeShape(TOP, circleShape([2, 0, 0], [1, 0, 0], [0, 1, 0], 12, 6))!;
    expect(followLinks(r.sketch, { [sp.id]: { ...edge, shape: other } })).toBe(r.sketch);
    // Saved and read back, the link is kept.
    expect((parseSketchData(JSON.parse(JSON.stringify(r.sketch)))!.curves[0] as SketchSpline).link).toEqual(sp.link);
    // Without a shape, a curved edge still can't be used (as before).
    expect(linkEdge(emptySketch(), { ...edge, shape: undefined }, false).error).toMatch(/Only straight and round edges/);
  });

  it("Use all edges joins a spline's ends to the lines meeting them, so the outline is closed", () => {
    // A D shape: a straight edge from (0, −10) to (0, 10), and a curved one back round through (10, 0).
    const line: RefEdge = { pick: { partId: "p", ref: { kind: "edge", curve: "LINE", a: [0, -10, 0], b: [0, 10, 0], mid: [0, 0, 0] } }, kind: "line", a: [0, -10], b: [0, 10], mid: [0, 0] };
    const half: CurveShape3 = { points: [], tangents: [] };
    for (let i = 0; i <= 4; i++) {
      const t = Math.PI / 2 - (Math.PI * i) / 4;
      half.points.push([10 * Math.cos(t), 10 * Math.sin(t), 0]);
      half.tangents.push([(10 * Math.PI * Math.sin(t)) / 4, (-10 * Math.PI * Math.cos(t)) / 4, 0]);
    }
    const shape = seeShape(TOP, half)!;
    const curve: RefEdge = { pick: { partId: "p", ref: { kind: "edge", curve: "BSPLINE_CURVE", a: [0, 10, 0], b: [0, -10, 0], mid: [10, 0, 0] } }, kind: "curve", a: [0, 10], b: [0, -10], mid: [10, 0], shape };
    const r = linkAllEdges(emptySketch(), [line, curve]);
    expect(r.error).toBeUndefined();
    expect(r.curveIds).toHaveLength(2);
    // Two corners, shared.
    const sp = curveById(r.sketch, r.curveIds[1]) as SketchSpline;
    const ln = curveById(r.sketch, r.curveIds[0]) as { p1: string; p2: string };
    expect([sp.points[0], sp.points[sp.points.length - 1]].sort()).toEqual([ln.p1, ln.p2].sort());
    expect(solveSketch(r.sketch).ok).toBe(true);
    const area = findRegions(r.sketch).regions[0].outer.area;
    expect(Math.abs(area / ((Math.PI * 100) / 2) - 1)).toBeLessThan(0.005);
  });
});

describe("old sketches", () => {
  it("a spline or ellipse without a link reads back exactly as before (no link field appears)", () => {
    const sp = addSpline(emptySketch(), [at(0, 0), at(10, 5), at(20, 0)], false);
    const el = addEllipse(sp.sketch, at(0, 0), at(10, 0), [0, 4]);
    const back = parseSketchData(JSON.parse(JSON.stringify(el.sketch)))!;
    expect(JSON.stringify(back.curves)).toBe(JSON.stringify(el.sketch.curves));
    expect(back.curves.every((c) => !("link" in c))).toBe(true);
  });

  it("a nearest-place check: within one sketch, a pierce dot list is kept where it is", () => {
    const frame: PlaneFrame = TOP;
    expect(edgePierces(frame, (f) => [f, f, 1 - 2 * f], 1).map(r6)).toEqual([[0.5, 0.5]]);
  });
});
