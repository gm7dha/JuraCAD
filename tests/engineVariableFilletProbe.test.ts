/**
 * Variable fillet, harder cases on the real OpenCascade engine: which end of a smooth run each radius lands on,
 * a part resized by a variable after the points were set, and an edge whose neighbour changed.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getOC, type Shape3D } from "replicad";
import type { EdgeRef, TopoPick, Vec3 } from "../src/geometry/topoRef";
import { GeometryEngine } from "../src/kernel/engine";
import type { Feature, FilletRadiusPoint } from "../src/model/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[], variables: Record<string, number> = {}) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features, variables);
}
const shapeOf = (id: string): Shape3D => (engine as unknown as { parts: { id: string; shape: Shape3D }[] }).parts.find((p) => p.id === id)!.shape;

function edgeNear(r: ReturnType<typeof build>, at: Vec3): TopoPick {
  const part = r.parts[0];
  const best = [...part.edgeRefs!].sort((p, q) => Math.hypot(...(p as EdgeRef).mid.map((v, i) => v - at[i])) - Math.hypot(...(q as EdgeRef).mid.map((v, i) => v - at[i])))[0];
  return { partId: part.id, ref: best };
}

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

const point = (pick: TopoPick, at: number, radius: number | string): FilletRadiusPoint => ({ part: pick.partId, edge: (pick.ref as EdgeRef).mid, at, radius: String(radius) });
const fillet = (picks: TopoPick[], radius: number, points: FilletRadiusPoint[]): Feature => ({ ...feature("fillet", { radius }, "add"), picks, variableFillet: { points } });
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

describe("variable fillet probes", () => {
  it("puts each radius at its own end of an edge in a smooth run, either way round", () => {
    const b = feature("box", { width: 10, depth: 10, height: 10 });
    const upright = edgeNear(build([b]), [10, 0, 5]);
    const rounded = build([b, fillet([upright], 2, [])]);
    const pick0 = edgeNear(rounded, [4, 0, 10]);
    for (const flip of [false, true]) {
      const r0 = pick0.ref as EdgeRef;
      const pick: TopoPick = flip ? { ...pick0, ref: { ...r0, a: r0.b, b: r0.a } } : pick0;
      const ref = pick.ref as EdgeRef;
      const r = build([b, fillet([upright], 2, []), fillet([pick], 1, [point(pick, 0, 1.6), point(pick, 1, 1.2)])]);
      expect(r.featureErrors).toEqual({});
      const shape = shapeOf(r.parts[0].id);
      expect(radiusAt(shape, lerp(ref.a, ref.b, 0.02))).toBeCloseTo(1.6, 1);
      expect(radiusAt(shape, lerp(ref.a, ref.b, 0.98))).toBeCloseTo(1.2, 1);
      // The other straight edge of the run (beyond the rounded corner) ends at the main radius.
      expect(radiusAt(shape, [10, 8, 10])).toBeLessThan(1.25);
      expect(radiusAt(shape, [10, 9.9, 10])).toBeCloseTo(1, 1);
    }
  });

  it("keeps the radii at their ends after a variable makes the part longer", () => {
    const b = feature("box", { width: "w", depth: 10, height: 10 });
    const pick = edgeNear(build([b], { w: 10 }), [5, 0, 10]);
    const ref = pick.ref as EdgeRef;
    const pts = [point(pick, 0, 1), point(pick, 0.5, "w / 5"), point(pick, 1, 3)];
    const r = build([b, fillet([pick], 2, pts)], { w: 25 });
    expect(r.featureErrors).toEqual({});
    const shape = shapeOf(r.parts[0].id);
    const lo = ref.a[0] < ref.b[0];
    const atStart: Vec3 = [lo ? 0.02 : 24.98, 0, 10];
    const atEnd: Vec3 = [lo ? 24.98 : 0.02, 0, 10];
    expect(radiusAt(shape, atStart)).toBeCloseTo(1, 1);
    expect(radiusAt(shape, [12.5, 0, 10])).toBeCloseTo(5, 1);
    expect(radiusAt(shape, atEnd)).toBeCloseTo(3, 1);
  });

  it("puts a point halfway along an edge in a run of unequal edges at its middle", () => {
    const b = feature("box", { width: 30, depth: 10, height: 10 });
    const upright = edgeNear(build([b]), [30, 0, 5]);
    const rounded = build([b, fillet([upright], 3, [])]);
    const pick = edgeNear(rounded, [12, 0, 10]);
    const ref = pick.ref as EdgeRef;
    const f = fillet([pick], 1, [point(pick, 0, 1.2), point(pick, 0.5, 2), point(pick, 1, 1.2)]);
    const r = build([b, fillet([upright], 3, []), { ...f, variableFillet: { ...f.variableFillet!, straight: true } }]);
    expect(r.featureErrors).toEqual({});
    const shape = shapeOf(r.parts[0].id);
    expect(radiusAt(shape, lerp(ref.a, ref.b, 0.5))).toBeCloseTo(2, 1);
    expect(radiusAt(shape, lerp(ref.a, ref.b, 0.25))).toBeCloseTo(1.6, 1);
  });
});
