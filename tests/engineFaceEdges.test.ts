import { beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import { edgesOfFace } from "../src/model/faceEdges";
import { addCircle, addRectangle } from "../src/sketch/ops";
import { emptySketch } from "../src/sketch/types";
import { extrudeFeature, feature, loadOpenCascade, sketchFeature } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

function topFaceIndex(p: any): number {
  // face whose triangles all have max z
  let best = -1, bz = -Infinity;
  p.faceGroups.forEach((g: any, i: number) => {
    let zmin = Infinity, zmax = -Infinity;
    for (let k = g.start; k < g.start + g.count; k++) { const z = p.vertices[3 * p.triangles[k] + 2]; zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); }
    if (zmax - zmin < 1e-6 && zmax > bz) { bz = zmax; best = i; }
  });
  return best;
}

/** The Use tool on a face: the edges found round real faces as the engine meshes them (straight, round and curved). */
describe("faceEdges vs engine meshes", () => {
  for (const r of [5, 50, 200, 400]) it(`disc r=${r}`, () => {
    const e = new GeometryEngine();
    const sk = sketchFeature({ kind: "default", name: "Top" }, addCircle(emptySketch(), { x: 0, y: 0 }, r).sketch);
    const res = e.rebuild([sk, extrudeFeature(sk.id, 3)]);
    const p = res.parts[0] as any;
    const top = topFaceIndex(p);
    const got = edgesOfFace(p, top);
    expect(got.length).toBe(1);
    e.dispose();
  });
  it("plate with holes", () => {
    const e = new GeometryEngine();
    let s = addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 300, y: 200 }).sketch;
    s = addCircle(s, { x: 50, y: 50 }, 40).sketch;
    s = addCircle(s, { x: 200, y: 100 }, 3).sketch;
    const sk = sketchFeature({ kind: "default", name: "Top" }, s);
    const res = e.rebuild([sk, extrudeFeature(sk.id, 3)]);
    const p = res.parts[0] as any;
    const top = topFaceIndex(p);
    const got = edgesOfFace(p, top);
    expect(got.length).toBe(6);
    e.dispose();
  });
  it("filleted box top", () => {
    const e = new GeometryEngine();
    const sk = sketchFeature({ kind: "default", name: "Top" }, addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 100, y: 60 }).sketch);
    const ex = extrudeFeature(sk.id, 20);
    const res0 = e.rebuild([sk, ex]);
    const p0 = res0.parts[0] as any;
    // fillet all edges
    const f = feature("fillet", { radius: 5 });
    (f as any).allEdges = true; (f as any).picks = [{ partId: p0.id, kind: "part" }];
    const res = e.rebuild([sk, ex, f]);
    const p = res.parts[0] as any;
    const top = topFaceIndex(p);
    const got = edgesOfFace(p, top);
    // 4 straight edges and 4 rounded corners.
    expect(got.length).toBe(8);
    e.dispose();
  });
});
