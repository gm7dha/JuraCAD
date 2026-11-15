/**
 * Variable fillet (Onshape's Fillet › Variable) on the real OpenCascade engine: radii set at points along picked
 * edges, measured by probing how far the rounded face lies from where the sharp corner was.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getOC, measureVolume, type Shape3D } from "replicad";
import type { EdgeRef, TopoPick, Vec3 } from "../src/geometry/topoRef";
import { GeometryEngine } from "../src/kernel/engine";
import type { Feature, FilletRadiusPoint } from "../src/model/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features);
}
const shapeOf = (id: string): Shape3D => (engine as unknown as { parts: { id: string; shape: Shape3D }[] }).parts.find((p) => p.id === id)!.shape;

function edgeNear(r: ReturnType<typeof build>, at: Vec3): TopoPick {
  const part = r.parts[0];
  const best = [...part.edgeRefs!].sort((p, q) => Math.hypot(...(p as EdgeRef).mid.map((v, i) => v - at[i])) - Math.hypot(...(q as EdgeRef).mid.map((v, i) => v - at[i])))[0];
  return { partId: part.id, ref: best };
}

/** The radius of a fillet between two square faces at point p of the old sharp corner: its distance to the part / (√2 − 1). */
function radiusAt(shape: Shape3D, p: Vec3): number {
  const oc = getOC() as any;
  const pnt = new oc.gp_Pnt(p[0], p[1], p[2]);
  const mv = new oc.BRepBuilderAPI_MakeVertex(pnt);
  const ds = new oc.BRepExtrema_DistShapeShape();
  ds.LoadS1(mv.Vertex());
  ds.LoadS2(shape.wrapped);
  ds.Perform();
  const d = ds.Value();
  ds.delete();
  mv.delete();
  pnt.delete();
  return d / (Math.SQRT2 - 1);
}

const box = () => feature("box", { width: 10, depth: 10, height: 10 });
const point = (pick: TopoPick, at: number, radius: number | string): FilletRadiusPoint => ({ part: pick.partId, edge: (pick.ref as EdgeRef).mid, at, radius: String(radius) });
const fillet = (picks: TopoPick[], radius: number, points?: FilletRadiusPoint[], straight?: boolean): Feature => ({
  ...feature("fillet", { radius }, "add"),
  picks,
  ...(points ? { variableFillet: { points, ...(straight ? { straight: true as const } : {}) } } : {}),
});
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

describe("variable fillet", () => {
  it("grows from 1 mm at one end of a box edge to 4 mm at the other", () => {
    const b = box();
    const pick = edgeNear(build([b]), [5, 0, 10]);
    const ref = pick.ref as EdgeRef;
    const one = build([b, fillet([pick], 1)]);
    const v1 = measureVolume(shapeOf(one.parts[0].id));
    const four = build([b, fillet([pick], 4)]);
    const v4 = measureVolume(shapeOf(four.parts[0].id));
    const r = build([b, fillet([pick], 2, [point(pick, 0, 1), point(pick, 1, 4)])]);
    expect(r.featureErrors).toEqual({});
    const shape = shapeOf(r.parts[0].id);
    const v = measureVolume(shape);
    expect(v).toBeLessThan(v1);
    expect(v).toBeGreaterThan(v4);
    expect(engine.check("normal").parts[0].geometryValid).toBe(true);
    // 1 mm at the pick's `a` end, 4 mm at its `b` end.
    expect(radiusAt(shape, lerp(ref.a, ref.b, 0.001))).toBeCloseTo(1, 1);
    expect(radiusAt(shape, lerp(ref.a, ref.b, 0.999))).toBeCloseTo(4, 1);
  });

  it("follows three points along an edge, smooth or straight", () => {
    const b = box();
    const pick = edgeNear(build([b]), [5, 0, 10]);
    const ref = pick.ref as EdgeRef;
    const pts = [point(pick, 0, 1), point(pick, 0.5, 3), point(pick, 1, 1)];
    for (const straight of [false, true]) {
      const r = build([b, fillet([pick], 2, pts, straight)]);
      expect(r.featureErrors).toEqual({});
      const shape = shapeOf(r.parts[0].id);
      expect(radiusAt(shape, lerp(ref.a, ref.b, 0.001))).toBeCloseTo(1, 1);
      expect(radiusAt(shape, lerp(ref.a, ref.b, 0.5))).toBeCloseTo(3, 1);
      expect(radiusAt(shape, lerp(ref.a, ref.b, 0.999))).toBeCloseTo(1, 1);
      // Straight steps are flatter between the points than the smooth curve (which bulges towards 3 sooner).
      const quarter = radiusAt(shape, lerp(ref.a, ref.b, 0.25));
      if (straight) expect(quarter).toBeLessThan(2.05);
      else expect(quarter).toBeGreaterThan(2.05);
      expect(engine.check("normal").parts[0].geometryValid).toBe(true);
    }
  });

  it("keeps each radius at its end when the edge comes back the other way round", () => {
    const b = box();
    const pick = edgeNear(build([b]), [5, 0, 10]);
    const ref = pick.ref as EdgeRef;
    // The same edge, but remembered with its ends the other way round (as after a rebuild that reverses it).
    const flipped: TopoPick = { ...pick, ref: { ...ref, a: ref.b, b: ref.a } };
    const r = build([b, fillet([flipped], 2, [point(flipped, 0, 1), point(flipped, 1, 4)])]);
    expect(r.featureErrors).toEqual({});
    const shape = shapeOf(r.parts[0].id);
    // The 1 mm radius is at the flipped pick's `a` — the original `b`.
    expect(radiusAt(shape, lerp(ref.b, ref.a, 0.001))).toBeCloseTo(1, 1);
    expect(radiusAt(shape, lerp(ref.b, ref.a, 0.999))).toBeCloseTo(4, 1);
  });

  it("uses the main radius on edges and ends without a point", () => {
    const b = box();
    const base = build([b]);
    const pick = edgeNear(base, [5, 0, 10]);
    const other = edgeNear(base, [5, 10, 10]);
    const ref = pick.ref as EdgeRef;
    const r = build([b, fillet([pick, other], 2, [point(pick, 0, 3)])]);
    expect(r.featureErrors).toEqual({});
    const shape = shapeOf(r.parts[0].id);
    expect(radiusAt(shape, lerp(ref.a, ref.b, 0.001))).toBeCloseTo(3, 1);
    expect(radiusAt(shape, lerp(ref.a, ref.b, 0.999))).toBeCloseTo(2, 1);
    const o = other.ref as EdgeRef;
    expect(radiusAt(shape, lerp(o.a, o.b, 0.5))).toBeCloseTo(2, 2);
  });

  it("varies along a run of edges that meet smoothly", () => {
    // A rounded upright corner makes the top edges beside it one smooth run (line, arc, line).
    const b = box();
    const upright = edgeNear(build([b]), [10, 0, 5]);
    const rounded = build([b, fillet([upright], 2)]);
    const pick = edgeNear(rounded, [5, 0, 10]);
    const ref = pick.ref as EdgeRef;
    const r = build([b, fillet([upright], 2), fillet([pick], 1, [point(pick, 0, 1), point(pick, 1, 1.5)])]);
    expect(r.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].geometryValid).toBe(true);
    const shape = shapeOf(r.parts[0].id);
    const nearA = radiusAt(shape, lerp(ref.a, ref.b, 0.01));
    const nearB = radiusAt(shape, lerp(ref.a, ref.b, 0.99));
    expect(Math.min(nearA, nearB)).toBeCloseTo(1, 1);
    expect(Math.max(nearA, nearB)).toBeCloseTo(1.5, 1);
  });

  it("builds an ordinary fillet exactly as before", () => {
    const b = box();
    const pick = edgeNear(build([b]), [5, 0, 10]);
    const r = build([b, fillet([pick], 2)]);
    expect(r.featureErrors).toEqual({});
    expect(measureVolume(shapeOf(r.parts[0].id))).toBeCloseTo(1000 - (4 - Math.PI) * 10, 6);
    // Variable on with no points is the same fillet.
    const r2 = build([b, fillet([pick], 2, [])]);
    expect(measureVolume(shapeOf(r2.parts[0].id))).toBeCloseTo(1000 - (4 - Math.PI) * 10, 6);
  });

  it("refuses a radius too big, and a bad radius, in plain words", () => {
    const b = box();
    const base = build([b]);
    const pick = edgeNear(base, [5, 0, 10]);
    const tooBig = build([b, fillet([pick], 2, [point(pick, 0, 1), point(pick, 1, 30)])]);
    expect(Object.values(tooBig.featureErrors)[0]).toMatch(/smaller radius/);
    const bad = build([b, fillet([pick], 2, [point(pick, 0, "nope + 1")])]);
    expect(Object.values(bad.featureErrors)[0]).toMatch(/Radius point 1/);
    const zero = build([b, fillet([pick], 2, [point(pick, 0, 0)])]);
    expect(Object.values(zero.featureErrors)[0]).toMatch(/more than 0/);
  });
});
