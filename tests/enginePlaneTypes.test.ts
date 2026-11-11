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
import { addRectangle } from "../src/sketch/ops";
import { emptySketch } from "../src/sketch/types";
import { addEllipse } from "../src/sketch/tools";
import { fractionAlong } from "../src/model/geomClicks";
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
    // Where it was built is told to the app (to show it there).
    expect(r(first.followed![plane.id].origin)).toEqual([10, 0, 5]);
    const before = first.parts.findIndex((p) => p.id === pad.id);
    expect(boundsOf(first.parts, before)).toEqual([[10, 0, 5], [12, 2, 8]]);

    const wider = engine.rebuild(features, { w: 30 });
    expect(wider.featureErrors).toEqual({});
    const now = wider.followed![plane.id];
    expect(r(now.origin)).toEqual([30, 0, 5]);
    expect(r(now.n)).toEqual([0, 0, 1]);
    // The pad sketched on the plane went with it, in the same build — and the app is told where the sketch is.
    const after = wider.parts.findIndex((p) => p.id === pad.id);
    expect(boundsOf(wider.parts, after)).toEqual([[30, 0, 5], [32, 2, 8]]);
    const shownAt = wider.sketchLinks?.[sketch.id]?.plane;
    expect(shownAt?.kind === "face" && r(shownAt.origin)).toEqual([30, 0, 5]);
    // The design is left as clicked: building never changes what it's given.
    expect(JSON.stringify(features[1].planeDef!.points![0].p)).toBe("[10,0,5]");
  });

  it("a plane based on a followed plane follows in the same build (Point normal → Offset → sketch → pad)", () => {
    const box = feature("box", { width: "w", depth: 20, height: 5 });
    const corner: GeomPick = { p: [10, 0, 5], pick: edge(box.id, [0, 0, 5], [10, 0, 5]), end: "b" };
    const pn = planeOf({ mode: "pointNormal", ref: { kind: "default", name: "Top" }, axis: "u", points: [corner], line: { p: [0, 0, 0], axis: "z" } });
    const off = planeOf({ mode: "offset", ref: { kind: "face", origin: [10, 0, 5], u: [1, 0, 0], v: [0, 1, 0], label: pn.name, planeRef: pn.id }, axis: "u" }, { distance: 5 });
    const data = addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 2, y: 2 }).sketch;
    const sketch = sketchFeature({ kind: "face", origin: [10, 0, 10], u: [1, 0, 0], v: [0, 1, 0], label: off.name, planeRef: off.id }, data);
    const pad = extrudeFeature(sketch.id, 3);
    engine = new GeometryEngine();
    expect(engine.rebuild([box, pn, off, sketch, pad], { w: 10 }).featureErrors).toEqual({});
    const b = engine.rebuild([box, pn, off, sketch, pad], { w: 30 });
    expect(boundsOf(b.parts, b.parts.findIndex((p) => p.id === pad.id))).toEqual([[30, 0, 10], [32, 2, 13]]);
    expect(r(b.followed![off.id].origin)).toEqual([30, 0, 10]);
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
    // Through (0,0,5), (30,0,5), (30,20,0).
    const t = res.followed![three.id];
    expect(r(t.origin)).toEqual([0, 0, 5]);
    expect(Math.abs(t.n[0])).toBeLessThan(1e-9);
    expect(r(t.n.map(Math.abs))).toEqual(r([0, 5 / Math.hypot(5, 20), 20 / Math.hypot(5, 20)]));
    const c = res.followed![curve.id];
    // A quarter of the way along the 30 mm edge, square to it.
    expect(r(c.origin)).toEqual([7.5, 0, 0]);
    expect(r(c.n)).toEqual([1, 0, 0]);
    expect(r(res.followed![parallel.id].origin)).toEqual([30, 20, 0]);
  });

  it("Curve point on an ellipse: a share of the edge's length, as the app measures the click", () => {
    const data = addEllipse(emptySketch(), { x: 0, y: 0 }, { x: 20, y: 0 }, [0, 5]).sketch;
    const sk = sketchFeature({ kind: "default", name: "Top" }, data);
    const ex = extrudeFeature(sk.id, 5);
    engine = new GeometryEngine();
    const part = engine.rebuild([sk, ex]).parts[0];
    const i = part.edgeRefs.findIndex((e) => e.curve === "ELLIPSE" && e.a[2] > 4);
    const g = part.edgeGroups[i];
    const pts: Vec3[] = [];
    for (let k = g.start; k < g.start + g.count; k++) pts.push([part.lines[3 * k], part.lines[3 * k + 1], part.lines[3 * k + 2]]);
    for (const position of [0.1, 0.35]) {
      const plane = planeOf({ mode: "curvePoint", ref: { kind: "default", name: "Top" }, axis: "u", position, points: [{ p: [0, 0, 0], pick: { partId: part.id, ref: part.edgeRefs[i] } }] });
      const res = engine.rebuild([sk, ex, plane]);
      expect(res.featureErrors).toEqual({});
      // The plane crosses the edge where a click that far along the drawn edge would be.
      expect(Math.abs(fractionAlong(pts, res.followed![plane.id].origin) - position)).toBeLessThan(2e-3);
    }
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
    expect(r(res.followed![top.id].origin)).toEqual([15, 10, 5]);
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

  it("a sketch on a connector whose part is moved later is built and shown where the connector went", () => {
    const box = feature("box", { width: 10, depth: 20, height: 5 });
    const conn = connectorOf({ at: { p: [5, 10, 5], pick: face(box.id, [5, 10, 5], [0, 0, 1]) } });
    const move: Feature = { ...feature("transform", { dx: 100 }, "add"), transform: { partId: box.id, axis: "z", about: "centre", copy: false } };
    const data = addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 2, y: 2 }).sketch;
    const sketch = sketchFeature({ kind: "face", origin: [5, 10, 5], u: [1, 0, 0], v: [0, 1, 0], label: conn.name, planeRef: conn.id }, data);
    const pad = extrudeFeature(sketch.id, 3);
    engine = new GeometryEngine();
    const res = engine.rebuild([box, conn, move, sketch, pad]);
    expect(res.featureErrors).toEqual({});
    expect(boundsOf(res.parts, res.parts.findIndex((p) => p.id === pad.id))).toEqual([[105, 10, 5], [107, 12, 8]]);
    expect(r(res.followed![conn.id].origin)).toEqual([105, 10, 5]);
    const shownAt = res.sketchLinks?.[sketch.id]?.plane;
    expect(shownAt?.kind === "face" && r(shownAt.origin)).toEqual([105, 10, 5]);
  });

  it("belong to the merged part when their part is joined into another (Boolean union, an Add joining parts)", () => {
    const a = feature("box", { width: 10, depth: 20, height: 5 });
    const b = feature("box", { width: 4, depth: 4, height: 8, x: 2, y: 2 });
    const conn = connectorOf({ at: { p: [4, 4, 8], pick: { partId: b.id, ref: { kind: "face", surface: "PLANE", center: [4, 4, 8], normal: [0, 0, 1] } } } });
    const uni: Feature = { ...feature("boolean", {}), booleanDef: { op: "union", targets: [a.id, b.id], tools: [], keepTools: false, picking: "targets" } };
    engine = new GeometryEngine();
    const res = engine.rebuild([a, b, conn, uni]);
    expect(res.featureErrors).toEqual({});
    expect(res.parts.map((p) => p.connectors?.length ?? 0)).toEqual([1]);
    engine.dispose();
    // An Add (Onshape-style) touching two parts joins them into the oldest.
    const left = feature("box", { width: 10, depth: 10, height: 5 });
    const right = feature("box", { width: 10, depth: 10, height: 5, x: 30 });
    const onRight = connectorOf({ at: { p: [35, 5, 5], pick: { partId: right.id, ref: { kind: "face", surface: "PLANE", center: [35, 5, 5], normal: [0, 0, 1] } } } });
    const bridge = sketchFeature({ kind: "default", name: "Top" }, addRectangle(emptySketch(), { x: 5, y: 2 }, { x: 35, y: 8 }).sketch);
    const add: Feature = { ...extrudeFeature(bridge.id, 5, { operation: "add" }), apart: true };
    engine = new GeometryEngine();
    const joined = engine.rebuild([left, right, onRight, bridge, add]);
    expect(joined.featureErrors).toEqual({});
    expect(joined.parts).toHaveLength(1);
    expect(joined.parts[0].connectors?.map((c) => c.id)).toEqual([onRight.id]);
  });

  it("cut away by a Subtract: no part takes it over, and it says so", () => {
    const a = feature("box", { width: 10, depth: 20, height: 5 });
    const b = feature("box", { width: 4, depth: 4, height: 8, x: 2, y: 2 });
    const conn = connectorOf({ at: { p: [4, 4, 8], pick: { partId: b.id, ref: { kind: "face", surface: "PLANE", center: [4, 4, 8], normal: [0, 0, 1] } } } });
    const sub: Feature = { ...feature("boolean", {}), name: "Subtract 1", booleanDef: { op: "subtract", targets: [a.id], tools: [b.id], keepTools: false, picking: "targets" } };
    engine = new GeometryEngine();
    const res = engine.rebuild([a, b, conn, sub]);
    expect(res.featureErrors).toEqual({});
    expect(res.parts.map((p) => p.connectors?.length ?? 0)).toEqual([0]);
    expect(res.featureWarnings?.[conn.id]).toMatch(/used up by Subtract 1/);
  });

  it("is kept on the parts built in another configuration too", () => {
    const base = feature("box", { width: "w", depth: 20, height: 5 });
    const top = connectorOf({ at: { p: [5, 10, 5], pick: face(base.id, [5, 10, 5], [0, 0, 1]) } });
    const other = feature("box", { width: 3, depth: 3, height: 3, x: 50 });
    engine = new GeometryEngine();
    const res = engine.rebuildStudios([{ id: "main", features: [base, top, other] }, { id: "main@big", features: [base, top, other], variables: { w: 40 }, partSuffix: "@big" }], { w: 10 });
    const owned = Object.fromEntries(res.parts.map((p) => [p.id, (p.connectors ?? []).map((c) => r(c.origin))]));
    expect(owned[base.id]).toEqual([[5, 10, 5]]);
    expect(owned[`${base.id}@big`]).toEqual([[20, 10, 5]]);
    expect(owned[other.id]).toEqual([]);
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
