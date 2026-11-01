/**
 * Round 8 sketch gaps with the real OpenCascade engine: circles (of another
 * sketch, or a part's round edge) seen at a slant come in as ellipses, and
 * another sketch's spline as a spline — each following when the original
 * changes; Pierce finds every crossing of a wiggly part edge.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { GeometryEngine } from "../src/kernel/engine";
import type { Feature } from "../src/model/types";
import { curveParam } from "../src/sketch/curves";
import { linkEdge, linkPoint } from "../src/sketch/links";
import { addCircle, curveById, pointPos, type Placed } from "../src/sketch/ops";
import { planeFrame, planeOnFace, toSketch, type SketchPlane } from "../src/sketch/planes";
import { addSpline } from "../src/sketch/tools";
import { emptySketch, type SketchData, type SketchEllipse, type SketchSpline } from "../src/sketch/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

const TOP: SketchPlane = { kind: "default", name: "Top" };
const FRONT: SketchPlane = { kind: "default", name: "Front" };
const S60 = Math.sin(Math.PI / 3);
const TILT = planeOnFace([0, -S60, 0.5], [0, 0, 0], "Tilted");
const tilt = planeFrame(TILT);
const seen = (p: [number, number, number]) => toSketch(tilt, p);
const close = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const at = (x: number, y: number): Placed => ({ x, y, snap: null });
const sketch = (id: string, plane: SketchPlane, data: SketchData, name = id): Feature => ({ id, name, type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane, data } });
const extrude = (id: string, sketchRef: string, depth: number): Feature => ({ ...feature("extrude", { depth }), id, name: id, sketchRef, extrude: { end: "blind", flip: false } });

function build(features: Feature[]) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuildStudios([{ id: "main", features }]);
}

/** The ellipse's centre and its two axis lengths. */
function axes(s: SketchData, id: string): { c: [number, number]; rx: number; ry: number } {
  const el = curveById(s, id) as SketchEllipse;
  const c = pointPos(s, el.center);
  return { c, rx: close(pointPos(s, el.major), c), ry: close(pointPos(s, el.minor), c) };
}

describe("another sketch's circle, seen at a slant", () => {
  it("is offered as an ellipse; brought in, it follows when the circle grows", () => {
    const c = addCircle(emptySketch(), at(5, 5), 4);
    build([sketch("skA", TOP, c.sketch, "Sketch A"), sketch("skB", TILT, emptySketch())]);
    const ref = engine.sketchCandidates("main", "skB")!.find((e) => e.source?.item === c.circleId)!;
    expect(ref.kind).toBe("curve");
    expect(ref.shape?.kind).toBe("ellipse");
    const r = linkEdge(emptySketch(), ref, false);
    expect(r.error).toBeUndefined();
    const bigger = { ...c.sketch, curves: c.sketch.curves.map((k) => (k.type === "circle" ? { ...k, radius: 6 } : k)) };
    const out = build([sketch("skA", TOP, bigger, "Sketch A"), sketch("skB", TILT, r.sketch)]);
    expect(out.featureErrors).toEqual({});
    const now = axes(out.sketchLinks!.skB.sketch!.data, r.curveId);
    expect(close(now.c, seen([5, 5, 0]))).toBeLessThan(1e-9);
    expect(now.rx).toBeCloseTo(6, 9);
    expect(now.ry).toBeCloseTo(3, 9);
  });
});

describe("another sketch's spline", () => {
  it("is used as a spline that follows the original exactly", () => {
    const sp = addSpline(emptySketch(), [at(0, 0), at(10, 6), at(20, -2), at(30, 5)], false);
    build([sketch("skA", TOP, sp.sketch, "Sketch A"), sketch("skB", TILT, emptySketch())]);
    const ref = engine.sketchCandidates("main", "skB")!.find((e) => e.source?.item === sp.splineId && e.kind === "curve")!;
    expect(ref.shape?.kind).toBe("spline");
    const r = linkEdge(emptySketch(), ref, false);
    const ids = (curveById(sp.sketch, sp.splineId) as SketchSpline).points;
    const moved: SketchData = { ...sp.sketch, points: sp.sketch.points.map((p) => (p.id === ids[2] ? { ...p, x: 24, y: -9 } : p)) };
    const out = build([sketch("skA", TOP, moved, "Sketch A"), sketch("skB", TILT, r.sketch)]);
    expect(out.featureErrors).toEqual({});
    const now = out.sketchLinks!.skB.sketch!.data;
    const a = curveParam(now, curveById(now, r.curveId)!);
    const o = curveParam(moved, curveById(moved, sp.splineId)!);
    let worst = 0;
    for (let i = 0; i <= 120; i++) {
      const u = (3 * i) / 120;
      const p = o.at(o.lo + u);
      worst = Math.max(worst, close(a.at(a.lo + u), seen([p[0], p[1], 0])));
    }
    expect(worst).toBeLessThan(1e-9);
  });
});

describe("a part's round edge, seen at a slant", () => {
  const part = (r: number) => [sketch("base", TOP, addCircle(emptySketch(), at(0, 0), r).sketch), extrude("ext", "base", 10)];

  it("Use brings the top edge of a cylinder (r 6, 10 high) in as an ellipse 6 by 3, and it follows when the cylinder grows to r 8", () => {
    const first = build([...part(6), sketch("skB", TILT, emptySketch())]);
    expect(first.featureErrors).toEqual({});
    const top = (first.parts.find((p) => p.id === "ext")?.edgeRefs ?? []).find((e) => e.curve === "CIRCLE" && Math.abs(e.mid[2] - 10) < 1e-6)!;
    expect(top).toBeDefined();
    // Offered as an ellipse in the snap list too (so it can be dimensioned to).
    const offered = engine.sketchCandidates("main", "skB")!.find((e) => e.pick && e.kind === "curve" && Math.abs(e.pick.ref.kind === "edge" ? e.pick.ref.mid[2] - 10 : 1) < 1e-6)!;
    expect(offered.shape?.kind).toBe("ellipse");
    const used = engine.useEdge("ext", top, TILT);
    if ("error" in used) throw new Error(used.error);
    expect(used.edge.shape?.kind).toBe("ellipse");
    const r = linkEdge(emptySketch(), used.edge, false);
    expect(r.error).toBeUndefined();
    const was = axes(r.sketch, r.curveId);
    expect(close(was.c, seen([0, 0, 10]))).toBeLessThan(1e-6);
    expect(was.rx).toBeCloseTo(6, 6);
    expect(was.ry).toBeCloseTo(3, 6);
    const out = build([...part(8), sketch("skB", TILT, r.sketch)]);
    expect(out.featureErrors).toEqual({});
    const now = axes(out.sketchLinks!.skB.sketch!.data, r.curveId);
    expect(close(now.c, seen([0, 0, 10]))).toBeLessThan(1e-6);
    expect(now.rx).toBeCloseTo(8, 6);
    expect(now.ry).toBeCloseTo(4, 6);
  });
});

describe("Pierce on a wiggly part edge", () => {
  it("finds every place a coil's long winding edge passes through Front: one each half turn (32 even samples found 4)", () => {
    // A coil 20 across, 3 mm a turn, 30 turns: its edges wind round 30 times, through Front (y = 0) twice a turn.
    const coil: Feature = { ...feature("coil", { diameter: 20, wire: 2, pitch: 3, turns: 30, x: 0, y: 0, z: 0 }), id: "coil", name: "Coil" };
    const out = build([coil, sketch("skB", FRONT, emptySketch())]);
    expect(out.featureErrors).toEqual({});
    const refs = engine.sketchCandidates("main", "skB")!;
    const byEdge = new Map<string, [number, number][]>();
    for (const e of refs) {
      if (!e.pierce || !e.pick || e.pick.ref.kind !== "edge") continue;
      const k = JSON.stringify(e.pick.ref);
      byEdge.set(k, [...(byEdge.get(k) ?? []), e.a]);
    }
    const longest = [...byEdge.values()].sort((a, b) => b.length - a.length)[0];
    expect(longest.length).toBeGreaterThanOrEqual(58);
    // Up the coil, half a turn (1.5 mm) apart, on alternate sides.
    const sorted = [...longest].sort((a, b) => a[1] - b[1]);
    for (let i = 1; i < sorted.length; i++) {
      expect(Math.abs(sorted[i][1] - sorted[i - 1][1] - 1.5)).toBeLessThan(0.01);
      expect(Math.sign(sorted[i][0])).toBe(-Math.sign(sorted[i - 1][0]));
    }
    // A point put at the 30th place stays there on rebuild (rebuilding samples the edge the same way).
    const ref = refs.find((e) => e.pierce && e.pick && Math.abs(e.a[1] - sorted[29][1]) < 1e-9 && Math.abs(e.a[0] - sorted[29][0]) < 1e-9)!;
    const p = linkPoint(emptySketch(), ref, "a");
    const again = build([coil, sketch("skB", FRONT, p.sketch)]);
    const placed = again.sketchLinks!.skB.pointLinks![p.pointId]!;
    expect(close(placed, sorted[29])).toBeLessThan(1e-6);
  });
});
