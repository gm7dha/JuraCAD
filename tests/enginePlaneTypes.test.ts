/**
 * Engine tests: Onshape's other Plane types and Part Studio mate connectors
 * follow the model when it changes (a variable makes the box wider), things
 * on them follow too, a mate connector moves its part in Move / copy, and an
 * assembly mate can use a part's own connector. Runs the real OpenCascade engine.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { analyzeMesh } from "../src/geometry/meshCheck";
import { GeometryEngine } from "../src/kernel/engine";
import type { EdgeRef, FaceRef, TopoPick } from "../src/geometry/topoRef";
import type { Feature, GeomPick, MateConnectorDef, PlaneOptions } from "../src/model/types";
import { applyFollowed } from "../src/model/followed";
import { emptyDocument } from "../src/model/document";
import { addRectangle } from "../src/sketch/ops";
import { emptySketch } from "../src/sketch/types";
import { connectorFrameOnParts } from "../src/assembly/connectors";
import { loadOpenCascade, feature, sketchFeature, extrudeFeature } from "./support/engineHelpers";
import type { Vec3 } from "../src/sketch/planes";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

const r = (v: number[]) => v.map((n) => Math.round(n * 1e4) / 1e4 + 0);
/**
 * Picks as the app makes them: the edge or face as the 3D view has it (with where it sits in the part's box), from a
 * 10 × 20 × 5 box built once.
 */
let shown: { edges: EdgeRef[]; faces: FaceRef[] } | null = null;
function picked(): { edges: EdgeRef[]; faces: FaceRef[] } {
  if (!shown) {
    const e = new GeometryEngine();
    const part = e.rebuild([{ ...feature("box", { width: 10, depth: 20, height: 5 }), id: "seen" }]).parts[0];
    shown = { edges: part.edgeRefs, faces: part.faceRefs };
    e.dispose();
  }
  return shown;
}
const near = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-6;
const edge = (partId: string, a: Vec3, b: Vec3): TopoPick => {
  const ref = picked().edges.find((e) => (near(e.a, a) && near(e.b, b)) || (near(e.a, b) && near(e.b, a)));
  if (!ref) throw new Error("no such edge");
  // As clicked: from a to b.
  return { partId, ref: near(ref.a, a) ? ref : { ...ref, a: ref.b, b: ref.a } };
};
const face = (partId: string, center: Vec3, normal: Vec3): TopoPick => {
  const ref = picked().faces.find((f) => near(f.center, center) && near(f.normal, normal));
  // (A part that never changes size: a plain face is enough.)
  return { partId, ref: ref ?? { kind: "face", surface: "PLANE", center, normal } };
};

function planeOf(planeDef: PlaneOptions, params: Record<string, number> = {}): Feature {
  return { ...feature("plane", params), planeDef };
}
function connectorOf(def: Omit<MateConnectorDef, "base">, params: Record<string, number> = {}): Feature {
  return { ...feature("mateConnector", params), connector: { ...def, base: { origin: [0, 0, 0], x: [1, 0, 0], z: [0, 0, 1] } } };
}
const boundsOf = (parts: { vertices: Float32Array; triangles: Uint32Array }[], i: number) => {
  const b = analyzeMesh(parts[i].vertices, parts[i].triangles).bounds!;
  return [r(b.min), r(b.max)];
};

describe("newer planes follow the model", () => {
  it("Point normal through a corner, square to an edge, moves when the box gets wider; a sketch on it follows", () => {
    // A box 10 (or w) × 20 × 5 from the origin.
    const box = feature("box", { width: "w", depth: 20, height: 5 });
    const corner: GeomPick = { p: [10, 0, 5], pick: edge(box.id, [0, 0, 5], [10, 0, 5]), end: "b" };
    const upright: GeomPick = { p: [10, 0, 0], dir: [0, 0, 1], pick: edge(box.id, [10, 0, 0], [10, 0, 5]) };
    const plane = planeOf({ mode: "pointNormal", ref: { kind: "default", name: "Top" }, axis: "u", points: [corner], line: upright });
    const data = addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 2, y: 2 }).sketch;
    const sketch = sketchFeature({ kind: "face", origin: [10, 0, 5], u: [1, 0, 0], v: [0, 1, 0], label: plane.name, planeRef: plane.id }, data);
    const pad = extrudeFeature(sketch.id, 3);
    const features = [box, plane, sketch, pad];
    engine = new GeometryEngine();
    const first = engine.rebuild(features, { w: 10 });
    expect(first.featureErrors).toEqual({});
    // Nothing moved: nothing to tell the app.
    expect(first.followed?.[plane.id]).toBeUndefined();
    const before = first.parts.findIndex((p) => p.id === pad.id);
    expect(boundsOf(first.parts, before)).toEqual([[10, 0, 5], [12, 2, 8]]);

    const wider = engine.rebuild(features, { w: 30 });
    expect(wider.featureErrors).toEqual({});
    const now = wider.followed?.[plane.id]?.planeDef;
    expect(now?.points?.[0].p).toEqual([30, 0, 5]);
    expect(r(now!.line!.dir!)).toEqual([0, 0, 1]);
    // The pad sketched on the plane went with it, in the same build.
    const after = wider.parts.findIndex((p) => p.id === pad.id);
    expect(boundsOf(wider.parts, after)).toEqual([[30, 0, 5], [32, 2, 8]]);

    // Written into the design (as the app does), the plane and the sketch's stored frame are where they are now, and building again changes nothing more.
    const doc = applyFollowed({ ...emptyDocument(), features, variables: [] }, wider.followed!, { w: 30 });
    const sk = doc.features.find((f) => f.id === sketch.id)!.sketch!.plane!;
    expect(sk.kind === "face" && r(sk.origin)).toEqual([30, 0, 5]);
    const again = engine.rebuild(doc.features, { w: 30 });
    expect(again.followed?.[plane.id]).toBeUndefined();
  });

  it("Three point, Curve point and Plane point on a part's corners, edges and faces", () => {
    const box = feature("box", { width: "w", depth: 20, height: 5 });
    const three = planeOf({
      mode: "threePoint",
      ref: { kind: "default", name: "Top" },
      axis: "u",
      points: [
        { p: [0, 0, 5], pick: edge(box.id, [0, 0, 5], [10, 0, 5]), end: "a" },
        { p: [10, 0, 5], pick: edge(box.id, [0, 0, 5], [10, 0, 5]), end: "b" },
        { p: [10, 20, 0], pick: edge(box.id, [10, 0, 0], [10, 20, 0]), end: "b" },
      ],
    });
    const curve = planeOf({ mode: "curvePoint", ref: { kind: "default", name: "Top" }, axis: "u", position: 0.25, points: [{ p: [0, 0, 0], pick: edge(box.id, [0, 0, 0], [10, 0, 0]) }] });
    const parallel = planeOf({ mode: "point", ref: { kind: "face", origin: [5, 10, 5], u: [1, 0, 0], v: [0, 1, 0], label: "Face", face: face(box.id, [5, 10, 5], [0, 0, 1]) }, axis: "u", points: [{ p: [10, 20, 0], pick: edge(box.id, [10, 0, 0], [10, 20, 0]), end: "b" }] });
    engine = new GeometryEngine();
    // Clicked at 10 wide, then made 30 wide.
    expect(engine.rebuild([box, three, curve, parallel], { w: 10 }).featureErrors).toEqual({});
    const res = engine.rebuild([box, three, curve, parallel], { w: 30 });
    expect(res.featureErrors).toEqual({});
    expect(res.followed![three.id].planeDef!.points!.map((p) => p.p)).toEqual([[0, 0, 5], [30, 0, 5], [30, 20, 0]]);
    const c = res.followed![curve.id].planeDef!;
    // A quarter of the way along the 30 mm edge, square to it.
    expect(r(c.points![0].p)).toEqual([7.5, 0, 0]);
    expect(r(c.points![0].dir!)).toEqual([1, 0, 0]);
    expect(res.followed![parallel.id].planeDef!.points![0].p).toEqual([30, 20, 0]);
  });

  it("says plainly when what it was made from is gone", () => {
    const plane = planeOf({ mode: "pointNormal", ref: { kind: "default", name: "Top" }, axis: "u", points: [{ p: [0, 0, 0], pick: edge("gone", [0, 0, 0], [10, 0, 0]), end: "a" }], line: { p: [0, 0, 0], axis: "z" } });
    engine = new GeometryEngine();
    const res = engine.rebuild([plane]);
    expect(res.featureErrors[plane.id]).toMatch(/no longer exists/);
  });
});

describe("mate connectors in the Part Studio", () => {
  it("sit on a face, follow it, belong to the part, and move a part in Move / copy", () => {
    const base = feature("box", { width: "w", depth: 20, height: 5 });
    const top = connectorOf({ at: { p: [5, 10, 5], pick: face(base.id, [5, 10, 5], [0, 0, 1]) } });
    const lid = feature("box", { width: 4, depth: 4, height: 2, x: 50, y: 50, z: 0 });
    // The lid's own connector: under its bottom face, turned over so Z points down out of it — Z onto Z puts faces together.
    const under = connectorOf({ at: { p: [52, 52, 0], pick: face(lid.id, [52, 52, 0], [0, 0, -1]) }, flipZ: true });
    const move: Feature = { ...feature("transform", {}, "add"), transform: { partId: lid.id, axis: "z", about: "centre", copy: false, mode: "mates", fromConnector: under.id, toConnector: top.id } };
    engine = new GeometryEngine();
    const res = engine.rebuild([base, top, lid, under, move], { w: 30 });
    expect(res.featureErrors).toEqual({});
    expect(res.followed![top.id].connector!.base.origin).toEqual([15, 10, 5]);
    const basePart = res.parts.find((p) => p.id === base.id)!;
    expect(basePart.connectors?.map((c) => [c.id, r(c.origin), r(c.z)])).toEqual([[top.id, [15, 10, 5], [0, 0, 1]]]);
    // The lid now sits on the middle of the base's top.
    const lidPart = res.parts.findIndex((p) => p.id === lid.id);
    expect(boundsOf(res.parts, lidPart)).toEqual([[13, 8, 5], [17, 12, 7]]);
    // Its own connector went with it.
    const lidMesh = res.parts[lidPart];
    expect(lidMesh.connectors?.map((c) => r(c.origin))).toEqual([[15, 10, 5]]);
    // An assembly mate end on that connector finds its frame on the part.
    const frame = connectorFrameOnParts(res.parts, { pick: { partId: base.id, ref: { kind: "face", surface: "PLANE", center: [0, 0, 0], normal: [0, 0, 1] } }, connector: top.id });
    expect(frame && r(frame.origin)).toEqual([15, 10, 5]);
  });

  it("on an edge's end and on a plane, with moves and turns", () => {
    const box = feature("box", { width: 10, depth: 20, height: 5 });
    const end = connectorOf({ at: { p: [10, 0, 5], pick: edge(box.id, [0, 0, 5], [10, 0, 5]), spot: "end" } }, { dz: 2 });
    const onPlane = connectorOf({ at: { p: [3, 4, 9] }, plane: { kind: "default", name: "Front" }, owner: box.id }, { rz: 90 });
    engine = new GeometryEngine();
    const res = engine.rebuild([box, end, onPlane]);
    expect(res.featureErrors).toEqual({});
    const owned = res.parts[0].connectors!;
    // Z along the edge (+X), 2 further along it.
    expect(r(owned[0].origin)).toEqual([12, 0, 5]);
    // On Front: brought onto the plane (y = 0), Z out of Front (−Y), turned a quarter about Z.
    expect(r(owned[1].origin)).toEqual([3, 0, 9]);
    expect(r(owned[1].z)).toEqual([0, -1, 0]);
  });
});
