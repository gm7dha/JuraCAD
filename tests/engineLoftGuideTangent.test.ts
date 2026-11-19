/**
 * Loft guide continuity on the real OpenCascade engine (Onshape's "Match tangent" on a guide that's a part's edge):
 * the loft leaves the guide carrying on the face beside it, with no crease; without it, the loft only passes through.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeVertex, measureDistanceBetween, type Shape3D } from "replicad";
import { GeometryEngine } from "../src/kernel/engine";
import type { EdgeRef } from "../src/geometry/topoRef";
import type { Feature, LoftCurve } from "../src/model/types";
import { feature, loadOpenCascade, sketchFeature } from "./support/engineHelpers";
import { polySketch } from "./support/frameSketch";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

const shapeOf = (id: string): Shape3D | undefined => (engine as unknown as { parts: { id: string; shape: Shape3D }[] }).parts.find((p) => p.id === id)?.shape;
function build(features: Feature[]) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features);
}

/** The angle (degrees) between the solid's surface nearest `q` and the direction `want`. */
function normalAngle(shape: Shape3D, q: [number, number, number], want: [number, number, number]): number {
  const vx = makeVertex(q);
  let best = Infinity;
  let angle = NaN;
  for (const f of shape.faces) {
    const d = measureDistanceBetween(vx, f);
    if (d < best) {
      best = d;
      const n = f.normalAt(q);
      const l = Math.hypot(n.x, n.y, n.z);
      angle = (Math.acos(Math.max(-1, Math.min(1, (n.x * want[0] + n.y * want[1] + n.z * want[2]) / l))) * 180) / Math.PI;
    }
    f.delete();
  }
  vx.delete();
  return angle;
}

describe("a guide matching tangent", () => {
  it("blends a loft into a box's side face along its top edge with no crease", () => {
    const box = feature("box", { width: 40, depth: 30, height: 10 });
    const part = build([box]).parts[0];
    const ref = part.edgeRefs.find((e: EdgeRef) => Math.abs(e.a[1]) < 1e-6 && Math.abs(e.b[1]) < 1e-6 && Math.abs(e.a[2] - 10) < 1e-6 && Math.abs(e.b[2] - 10) < 1e-6)!;
    expect(ref).toBeTruthy();
    // A leaning triangle on the box's top, its corner on the front top edge, at x = 5 and x = 35.
    const tri: [number, number][] = [
      [0, 10],
      [8, 10],
      [3, 18],
    ];
    const s1 = sketchFeature({ kind: "face", origin: [5, 0, 0], u: [0, 1, 0], v: [0, 0, 1], label: "x 5" }, polySketch(tri));
    const s2 = sketchFeature({ kind: "face", origin: [35, 0, 0], u: [0, 1, 0], v: [0, 0, 1], label: "x 35" }, polySketch(tri));
    const loft = (guide: LoftCurve): Feature => ({ ...feature("loft", {}), sections: [s1.id, s2.id], loft: { guide }, apart: true });
    const matched = loft({ edges: [{ partId: box.id, ref }], continuity: "matchTangent" });
    const r = build([box, s1, s2, matched]);
    expect(r.featureErrors).toEqual({});
    expect(engine.check("normal", [matched.id]).parts[0].geometryValid).toBe(true);
    const out: [number, number, number] = [0, -1, 0];
    // Halfway along, just above the edge: the loft's side carries on the box's front face (facing −Y).
    const tangent = normalAngle(shapeOf(matched.id)!, [20, -0.3, 10.3], out);
    expect(tangent).toBeLessThan(4);
    for (const x of [12, 16, 24, 28]) expect(normalAngle(shapeOf(matched.id)!, [x, -0.3, 10.3], out)).toBeLessThan(4);
    // Passing through only: the side leans in as drawn (about 20.6° off the front face).
    const plain = loft({ edges: [{ partId: box.id, ref }] });
    build([box, s1, s2, plain]);
    const creased = normalAngle(shapeOf(plain.id)!, [20, -0.3, 10.3], out);
    expect(creased).toBeGreaterThan(15);
  });
});
