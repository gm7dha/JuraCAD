/**
 * Engine tests: corners (vertices) picked in the 3D view are found again on each rebuild — a box's corner followed
 * when a variable makes the box bigger — and used where a point is wanted: an extrude up to a corner, a three-point
 * plane on corners, a mate connector on a corner and Measure between corners. Runs the real OpenCascade engine.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import { cornersOf, type VertexPick } from "../src/geometry/vertexRef";
import type { PartMesh } from "../src/kernel/protocol";
import type { Feature, GeomPick } from "../src/model/types";
import { loadOpenCascade, feature, sketchFeature, extrudeFeature, rectSketch } from "./support/engineHelpers";
import type { Vec3 } from "../src/sketch/planes";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

const near = (p: Vec3, q: Vec3, tol = 1e-6) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < tol;

/** A corner as a click in the app picks it: from the part's mesh. */
function corner(part: PartMesh, at: Vec3): VertexPick {
  const ref = cornersOf(part).find((c) => near(c.p, at));
  if (!ref) throw new Error(`no corner at ${at}`);
  return { partId: part.id, ref };
}

/** A box w × 20 × h from the origin, built once at the sizes given, to pick its corners. */
function boxPart(box: Feature, vars: Record<string, number>): PartMesh {
  const e = new GeometryEngine();
  const part = e.rebuild([box], vars).parts[0];
  e.dispose();
  return part;
}

describe("corners", () => {
  it("a box has 8 corners, each with its three edges", () => {
    const box = feature("box", { width: 10, depth: 20, height: 5 });
    const corners = cornersOf(boxPart(box, {}));
    expect(corners.length).toBe(8);
    for (const c of corners) expect(c.dirs?.length).toBe(3);
  });

  it("a three-point plane on corners follows the box when it gets wider", () => {
    const box = feature("box", { width: "w", depth: 20, height: 5 });
    const part = boxPart(box, { w: 10 });
    const pts: GeomPick[] = ([[10, 0, 5], [10, 20, 5], [10, 0, 0]] as Vec3[]).map((p) => ({ p, vertex: corner(part, p) }));
    const plane: Feature = { ...feature("plane", {}), planeDef: { mode: "threePoint", ref: { kind: "default", name: "Top" }, axis: "u", points: pts } };
    engine = new GeometryEngine();
    const first = engine.rebuild([box, plane], { w: 10 });
    expect(first.featureErrors).toEqual({});
    const f1 = first.followed![plane.id];
    expect(Math.abs(Math.abs(f1.n[0]) - 1)).toBeLessThan(1e-6);
    expect(Math.abs(f1.origin[0] - 10)).toBeLessThan(1e-6);
    const wider = engine.rebuild([box, plane], { w: 30 });
    expect(wider.featureErrors).toEqual({});
    expect(Math.abs(wider.followed![plane.id].origin[0] - 30)).toBeLessThan(1e-6);
  });

  it("an extrude goes up to a corner, and follows it when the box gets taller", () => {
    const box = feature("box", { width: 10, depth: 20, height: "h" });
    const part = boxPart(box, { h: 5 });
    const sketch = sketchFeature({ kind: "default", name: "Top" }, rectSketch(20, 0, 5, 5));
    const ex: Feature = { ...extrudeFeature(sketch.id, 1), extrude: { end: "upToVertex", flip: false, upToCorner: corner(part, [10, 20, 5]) } };
    engine = new GeometryEngine();
    const r1 = engine.rebuild([box, sketch, ex], { h: 5 });
    expect(r1.featureErrors).toEqual({});
    const pad = (r: typeof r1) => r.parts.find((p) => p.id === ex.id)!;
    expect(Math.abs(pad(r1).volume! - 125)).toBeLessThan(1e-3);
    const r2 = engine.rebuild([box, sketch, ex], { h: 8 });
    expect(r2.featureErrors).toEqual({});
    expect(Math.abs(pad(r2).volume! - 200)).toBeLessThan(1e-3);
  });

  it("a corner that's gone (cut away) is said plainly", () => {
    const box = feature("box", { width: 10, depth: 20, height: 5 });
    const part = boxPart(box, {});
    // A chamfer on the box's corner turns it into three corners elsewhere: the corner picked is gone.
    const cut = sketchFeature({ kind: "default", name: "Top" }, rectSketch(8, 18, 4, 4));
    const remove = extrudeFeature(cut.id, 10, { operation: "remove", end: "symmetric" });
    const sketch = sketchFeature({ kind: "default", name: "Top" }, rectSketch(20, 0, 5, 5));
    const ex: Feature = { ...extrudeFeature(sketch.id, 1), extrude: { end: "upToVertex", flip: false, upToCorner: corner(part, [10, 20, 5]) } };
    engine = new GeometryEngine();
    const r = engine.rebuild([box, cut, remove, sketch, ex], {});
    expect(r.featureErrors[ex.id]).toMatch(/corner it uses can't be found/);
  });

  it("a mate connector sits on a corner", () => {
    const box = feature("box", { width: "w", depth: 20, height: 5 });
    const part = boxPart(box, { w: 10 });
    const at: GeomPick = { p: [10, 20, 5], vertex: corner(part, [10, 20, 5]) };
    const mc: Feature = { ...feature("mateConnector", {}), connector: { at, base: { origin: [0, 0, 0], x: [1, 0, 0], z: [0, 0, 1] } } };
    engine = new GeometryEngine();
    const r = engine.rebuild([box, mc], { w: 15 });
    expect(r.featureErrors).toEqual({});
    const o = r.followed![mc.id].origin;
    expect(near(o, [15, 20, 5], 1e-6)).toBe(true);
    // Owned by the box it's on.
    expect(r.parts[0].connectors?.map((c) => c.id)).toEqual([mc.id]);
  });

  it("measures between corners, and from a corner to a face", () => {
    const box = feature("box", { width: 10, depth: 20, height: 5 });
    engine = new GeometryEngine();
    const r = engine.rebuild([box], {});
    const part = r.parts[0];
    const m = engine.measure([corner(part, [0, 0, 0]), corner(part, [10, 20, 5])]);
    expect(m.items.map((i) => i.label)).toEqual(["Corner", "Corner"]);
    expect(Math.abs(m.distance! - Math.sqrt(525))).toBeLessThan(1e-6);
    expect(m.items[1].point).toEqual([10, 20, 5]);
    const bottom = part.faceRefs.findIndex((f) => f.surface === "PLANE" && f.normal[2] < -0.9);
    const m2 = engine.measure([corner(part, [10, 20, 5]), { partId: part.id, ref: part.faceRefs[bottom] }]);
    expect(Math.abs(m2.distance! - 5)).toBeLessThan(1e-6);
    expect(m2.angle).toBeUndefined();
  });
});
