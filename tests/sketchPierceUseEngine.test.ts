/**
 * Pierce, and Use on curved edges, with the real OpenCascade engine: a point
 * placed where an edge (or another sketch's curve) passes through the
 * sketch's plane, and splines and ellipses copied from a part's curved
 * edges — each following when what it came from changes.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { EdgeRef } from "../src/geometry/topoRef";
import { GeometryEngine } from "../src/kernel/engine";
import type { Feature } from "../src/model/types";
import { curveParam, nearestParam } from "../src/sketch/curves";
import { linkEdge, linkPoint, lostLinksMessage, piercePoint } from "../src/sketch/links";
import { addCircle, addLine, curveById, pointPos, type Placed } from "../src/sketch/ops";
import { addEllipse, addSpline } from "../src/sketch/tools";
import type { SketchPlane } from "../src/sketch/planes";
import { findRegions } from "../src/sketch/regions";
import { snapAt } from "../src/sketch/snaps";
import { solveSketch } from "../src/sketch/solver";
import { emptySketch, type SketchData, type SketchEllipse, type SketchLine, type SketchSpline } from "../src/sketch/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

const TOP: SketchPlane = { kind: "default", name: "Top" };
const FRONT: SketchPlane = { kind: "default", name: "Front" };
const sketch = (id: string, plane: SketchPlane, data: SketchData, name = id): Feature => ({ id, name, type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane, data } });
const extrude = (id: string, sketchRef: string, depth: number): Feature => ({ ...feature("extrude", { depth }), id, name: id, sketchRef, extrude: { end: "blind", flip: false } });
/** A box 20 × 10 × 20 with its corner at (x, 5, z): its four upright edges pass through the Top plane when z < 0 < z + 20. */
const box = (x: number, z = -10): Feature => ({ ...feature("box", { width: 20, depth: 10, height: 20, x, y: 5, z }), id: "box", name: "Box" });

function build(features: Feature[]) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuildStudios([{ id: "main", features }]);
}

const r6 = (p: [number, number]) => p.map((v) => Math.round(v * 1e6) / 1e6 + 0);
const at = (x: number, y: number): Placed => ({ x, y, snap: null });
const tol = { pointTol: 1, curveTol: 0.5 };

/** How far apart two curves are at most (each sampled, measured to the other). */
function apart(sa: SketchData, a: string, sb: SketchData, b: string): number {
  const pa = curveParam(sa, curveById(sa, a)!);
  const pb = curveParam(sb, curveById(sb, b)!);
  let worst = 0;
  for (const [p, q] of [
    [pa, pb],
    [pb, pa],
  ]) {
    for (let i = 0; i <= 200; i++) {
      const x = p.at(p.lo + ((p.hi - p.lo) * i) / 200);
      const y = q.at(nearestParam(q, x));
      worst = Math.max(worst, Math.hypot(x[0] - y[0], x[1] - y[1]));
    }
  }
  return worst;
}

describe("Pierce", () => {
  it("puts a point where an upright edge of a box passes through the sketch, and it follows the box", () => {
    const l = addLine(emptySketch(), at(-10, -10), at(6, 6));
    const end = (curveById(l.sketch, l.lineId) as SketchLine).p2;
    build([box(5), sketch("sk", TOP, l.sketch)]);
    const refs = engine.sketchCandidates("main", "sk")!;
    // The four upright edges pass through Top at the box's corners seen from above.
    const dots = refs.filter((e) => e.pierce).map((e) => r6(e.a).join(","));
    expect(dots.sort()).toEqual(["25,15", "25,5", "5,15", "5,5"]);
    // The upright edge at (5, 5) is seen end-on: bring it in (a click does) and pierce the line's end with it.
    const upright = refs.find((e) => !e.pierce && e.kind === "point" && r6(e.a).join(",") === "5,5")!;
    const brought = linkPoint(l.sketch, upright, "a");
    expect(brought.error).toBeUndefined();
    const r = piercePoint(brought.sketch, [end, brought.pointId], refs);
    expect(r.error).toBeUndefined();
    expect(r6(pointPos(r.sketch, end))).toEqual([5, 5]);
    const pierce = r.sketch.points.find((p) => p.id === r.pointId)!;
    expect(pierce.link).toMatchObject({ partId: "box", end: "pierce" });

    // The box moves to x = 8: the line's end follows the edge to (8, 5).
    const moved = build([box(8), sketch("sk", TOP, r.sketch)]);
    expect(moved.featureErrors).toEqual({});
    const info = moved.sketchLinks!.sk;
    expect(r6(info.pointLinks![r.pointId!]!)).toEqual([8, 5]);
    expect(r6(pointPos(info.sketch!.data, end))).toEqual([8, 5]);
    expect(lostLinksMessage(r.sketch, info)).toBeNull();

    // Lifted clear of the plane (z = 1 to 21), the edge no longer passes through: said plainly, and the point stays put.
    const lifted = build([box(5, 1), sketch("sk", TOP, r.sketch)]);
    expect(lifted.sketchLinks!.sk.pointLinks![r.pointId!]).toBeNull();
    expect(lifted.featureErrors.sk).toMatch(/no longer passes through the sketch's plane/);
    expect(lostLinksMessage(r.sketch, lifted.sketchLinks!.sk)).toMatch(/can't be placed any more/);
  });

  it("refuses kindly when the edge doesn't pass through the sketch", () => {
    const l = addLine(emptySketch(), at(-10, -10), at(6, 6));
    const end = (curveById(l.sketch, l.lineId) as SketchLine).p2;
    // Clear of the plane: z = 1 to 21.
    build([box(5, 1), sketch("sk", TOP, l.sketch)]);
    const refs = engine.sketchCandidates("main", "sk")!;
    expect(refs.some((e) => e.pierce)).toBe(false);
    const upright = refs.find((e) => e.kind === "point" && r6(e.a).join(",") === "5,5")!;
    const brought = linkPoint(l.sketch, upright, "a");
    const r = piercePoint(brought.sketch, [end, brought.pointId], refs);
    expect(r.error).toMatch(/doesn't pass through this sketch's plane/);
    // And a curve of the sketch itself can't pierce it.
    expect(piercePoint(l.sketch, [end, l.lineId], refs).error).toMatch(/part of this sketch/);
  });

  it("another sketch's circle passes through twice: the point keeps to the place it was put at", () => {
    // Sketch A on Front: a circle r 5 centred on the Top plane's line (z = 0) at x = cx, so it passes through Top at cx ± 5.
    const sketchA = (cx: number) => {
      const c = addCircle(emptySketch(), at(cx, 0), 5);
      return { f: sketch("skA", FRONT, c.sketch, "Sketch A"), circle: c.circleId, data: c.sketch };
    };
    const a = sketchA(10);
    build([a.f, sketch("skB", TOP, emptySketch())]);
    const refs = engine.sketchCandidates("main", "skB")!;
    const dots = refs.filter((e) => e.pierce && e.source?.item === a.circle).map((e) => r6(e.a).join(","));
    expect(dots.sort()).toEqual(["15,0", "5,0"]);
    // Snapping a line's end onto the left place brings in a point following it.
    const snapped = snapAt(emptySketch(), 5.2, 0.3, { ...tol, refs }).placed;
    expect(snapped.snap).toMatchObject({ kind: "ref" });
    const l = addLine(emptySketch(), at(0, 20), snapped);
    const end = (curveById(l.sketch, l.lineId) as SketchLine).p2;
    const followed = l.sketch.points.find((p) => p.link)!;
    expect(followed.link).toEqual({ sketch: "skA", item: a.circle, end: "pierce" });
    expect(r6(pointPos(l.sketch, end))).toEqual([5, 0]);

    // Sketch A's circle moves to x = 12: it now passes through at 7 and 17; the line's end goes to 7 (nearest its own place).
    const data: SketchData = { ...a.data, points: a.data.points.map((p) => ({ ...p, x: 12 })) };
    const r = build([{ ...a.f, sketch: { plane: FRONT, data } }, sketch("skB", TOP, l.sketch)]);
    expect(r.featureErrors).toEqual({});
    expect(r6(pointPos(r.sketchLinks!.skB.sketch!.data, end))).toEqual([7, 0]);
  });

  it("another sketch's spline: placed exactly where it passes through", () => {
    // Sketch A on Front: a spline from (0, −10) up through (10, 4) to (20, 10) (sketch y is height z): it passes through z = 0 once.
    const sp = addSpline(emptySketch(), [at(0, -10), at(10, 4), at(20, 10)], false);
    build([sketch("skA", FRONT, sp.sketch, "Sketch A"), sketch("skB", TOP, emptySketch())]);
    const refs = engine.sketchCandidates("main", "skB")!;
    const dot = refs.find((e) => e.pierce && e.source?.item === sp.splineId)!;
    expect(dot).toBeDefined();
    // Check against the spline itself: where its height is 0, by halving along it.
    const path = curveParam(sp.sketch, curveById(sp.sketch, sp.splineId)!);
    let lo = path.lo, hi = path.hi;
    for (let k = 0; k < 100; k++) {
      const m = (lo + hi) / 2;
      if (path.at(m)[1] < 0) lo = m;
      else hi = m;
    }
    expect(dot.a[0]).toBeCloseTo(path.at(lo)[0], 9);
    expect(dot.a[1]).toBeCloseTo(0, 9);
    const p = linkPoint(emptySketch(), dot, "a");
    const r = build([sketch("skA", FRONT, sp.sketch, "Sketch A"), sketch("skB", TOP, p.sketch)]);
    expect(r.sketchLinks!.skB.pointLinks![p.pointId]![0]).toBeCloseTo(path.at(lo)[0], 9);
  });
});

describe("Use on curved edges", () => {
  /** A part made by extruding Sketch "base" on Top 10 mm. */
  const part = (data: SketchData) => [sketch("base", TOP, data), extrude("ext", "base", 10)];
  /** The part's top edges (z = 10) of a kind. */
  const topEdges = (r: ReturnType<typeof build>, kind: (curve: string) => boolean): EdgeRef[] =>
    (r.parts.find((p) => p.id === "ext")?.edgeRefs ?? []).filter((e) => kind(e.curve) && Math.abs(e.mid[2] - 10) < 1e-6);

  it("an ellipse's edge comes in as an ellipse, and follows when the ellipse is made longer", () => {
    const el = addEllipse(emptySketch(), at(0, 0), at(20, 0), [0, 10]);
    const ellipse = curveById(el.sketch, el.ellipseId) as SketchEllipse;
    const first = build([...part(el.sketch), sketch("sk", TOP, emptySketch())]);
    expect(first.featureErrors).toEqual({});
    const edges = topEdges(first, (c) => c !== "LINE");
    expect(edges.length).toBeGreaterThan(0);
    // The whole outline: each of its edges comes in (an ellipse in one or more parts).
    let data = emptySketch();
    const ids: string[] = [];
    for (const ref of edges) {
      const used = engine.useEdge("ext", ref, TOP);
      expect("error" in used).toBe(false);
      if ("error" in used) return;
      expect(used.edge.shape?.kind).toBe("ellipse");
      const r = linkEdge(data, used.edge, false);
      expect(r.error).toBeUndefined();
      data = r.sketch;
      ids.push(r.curveId);
    }
    const copy = curveById(data, ids[0]) as SketchEllipse;
    const centre = pointPos(data, copy.center);
    expect(r6(centre)).toEqual([0, 0]);
    expect(Math.hypot(...pointPos(data, copy.major))).toBeCloseTo(20, 6);
    expect(Math.hypot(...pointPos(data, copy.minor))).toBeCloseTo(10, 6);
    expect(solveSketch(data).ok).toBe(true);

    // The base ellipse is made 30 long: the copy follows (it still encloses π·30·10).
    const longer = { ...el.sketch, points: el.sketch.points.map((p) => (p.id === ellipse.major ? { ...p, x: 30 } : p)) };
    const r = build([...part(longer), sketch("sk", TOP, data)]);
    expect(r.featureErrors).toEqual({});
    const now = r.sketchLinks!.sk.sketch!.data;
    const after = curveById(now, ids[0]) as SketchEllipse;
    expect(Math.hypot(...pointPos(now, after.major))).toBeCloseTo(30, 6);
    expect(Math.hypot(...pointPos(now, after.minor))).toBeCloseTo(10, 6);
    const area = findRegions(now).regions.reduce((t, g) => t + g.outer.area, 0);
    // (Areas are measured on the outline drawn as short straight pieces: within 0.5 %.)
    expect(Math.abs(area / (Math.PI * 30 * 10) - 1)).toBeLessThan(0.005);
  });

  it("a spline's edge comes in as a spline within half a micron, and follows when the spline changes", () => {
    const base = addSpline(emptySketch(), [at(0, 0), at(20, -5), at(30, 10), at(10, 20)], true);
    const first = build([...part(base.sketch), sketch("sk", TOP, emptySketch())]);
    expect(first.featureErrors).toEqual({});
    const edges = topEdges(first, (c) => c.startsWith("BSPLINE") || c.startsWith("BEZIER"));
    expect(edges.length).toBeGreaterThan(0);
    let data = emptySketch();
    const ids: string[] = [];
    for (const ref of edges) {
      const used = engine.useEdge("ext", ref, TOP);
      if ("error" in used) throw new Error(used.error);
      expect(used.edge.shape?.kind).toBe("spline");
      const r = linkEdge(data, used.edge, false);
      expect(r.error).toBeUndefined();
      data = r.sketch;
      ids.push(r.curveId);
    }
    expect(solveSketch(data).ok).toBe(true);
    // Every copy lies on the base spline (to half a micron).
    for (const id of ids) {
      const copy = curveParam(data, curveById(data, id)!);
      const orig = curveParam(base.sketch, curveById(base.sketch, base.splineId)!);
      for (let i = 0; i <= 100; i++) {
        const q = copy.at(copy.lo + ((copy.hi - copy.lo) * i) / 100);
        const o = orig.at(nearestParam(orig, q));
        expect(Math.hypot(q[0] - o[0], q[1] - o[1])).toBeLessThan(5e-4);
      }
    }
    const one = curveById(data, ids[0]) as SketchSpline;
    expect(one.link).toMatchObject({ partId: "ext" });

    // A point of the base spline moves: the copy follows, keeping its number of points.
    const moved = { ...base.sketch, points: base.sketch.points.map((p) => (p.x === 30 && p.y === 10 ? { ...p, x: 40 } : p)) };
    const r = build([...part(moved), sketch("sk", TOP, data)]);
    expect(r.featureErrors).toEqual({});
    const now = r.sketchLinks!.sk.sketch!.data;
    const after = curveById(now, ids[0]) as SketchSpline;
    expect(after.points).toEqual(one.points);
    let worst = 0;
    for (const id of ids) {
      const copy = curveParam(now, curveById(now, id)!);
      const orig = curveParam(moved, curveById(moved, base.splineId)!);
      for (let i = 0; i <= 100; i++) {
        const q = copy.at(copy.lo + ((copy.hi - copy.lo) * i) / 100);
        const o = orig.at(nearestParam(orig, q));
        worst = Math.max(worst, Math.hypot(q[0] - o[0], q[1] - o[1]));
      }
    }
    expect(worst).toBeLessThan(5e-3);
    // And it really moved (the old copy is well away from the new one somewhere).
    expect(Math.max(...ids.map((id) => apart(data, id, now, id)))).toBeGreaterThan(1);
  });
});
