/**
 * Engine tests: measured variables (Onshape's Variable › Measured) read their value from the model where they sit in
 * the feature list, and the features after them — boxes and sketch dimensions — use it; changing the model changes it.
 * Runs the real OpenCascade engine.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { FaceRef, EdgeRef, TopoPick } from "../src/geometry/topoRef";
import type { Feature } from "../src/model/types";
import type { MeasuredDef } from "../src/model/measuredVariable";
import { setCurrentScope } from "../src/model/expr";
import { buildSketch } from "../src/mcp/sketchShapes";
import { loadOpenCascade, feature, sketchFeature, extrudeFeature, meshOf } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

/** The box's faces as the 3D view has them (with where they sit in the part's box), from a 40 × 30 × 20 box built once. */
function boxFaces(): FaceRef[] {
  const e = new GeometryEngine();
  const part = e.rebuild([{ ...feature("box", { width: 40, depth: 30, height: 20 }), id: "seen" }]).parts[0];
  e.dispose();
  return part.faceRefs;
}
const facing = (faces: FaceRef[], n: [number, number, number]) => faces.find((f) => f.surface === "PLANE" && Math.hypot(f.normal[0] - n[0], f.normal[1] - n[1], f.normal[2] - n[2]) < 1e-6)!;
const measuredOf = (def: MeasuredDef): Feature => ({ ...feature("variable", {}), measured: def });

describe("measured variables", () => {
  it("measures a box's width; a later extrude's depth uses it, and follows when the box gets wider", () => {
    const faces = boxFaces();
    const box = feature("box", { width: "w", depth: 30, height: 20 });
    const pick = (n: [number, number, number]): TopoPick => ({ partId: box.id, ref: facing(faces, n) });
    const width = measuredOf({ name: "width", kind: "distance", targets: [pick([-1, 0, 0]), pick([1, 0, 0])] });
    const sk = sketchFeature({ kind: "default", name: "Top" }, buildSketch([{ type: "rectangle", corner: [100, 0], width: 10, height: 10 }], {}).data);
    const pad = { ...extrudeFeature(sk.id, 1), params: { depth: "width / 2" } };
    const features = [box, width, sk, pad];
    engine = new GeometryEngine();
    let r = engine.rebuild(features, { w: 40 });
    expect(r.featureErrors).toEqual({});
    expect(r.measuredValues?.[width.id]).toEqual({ name: "width", value: 40 });
    const padIndex = () => r.parts.findIndex((p) => p.id === pad.id);
    expect(meshOf(r, padIndex()).volume).toBeCloseTo(2000, 3);
    r = engine.rebuild(features, { w: 60 });
    expect(r.featureErrors).toEqual({});
    expect(r.measuredValues?.[width.id].value).toBeCloseTo(60, 9);
    expect(meshOf(r, padIndex()).volume).toBeCloseTo(3000, 3);
    // Along X only, between a corner-ish pair: the same here.
    const alongX = measuredOf({ name: "wx", kind: "distance", along: "x", targets: [pick([-1, 0, 0]), pick([1, 0, 0])] });
    r = engine.rebuild([box, alongX], { w: 60 });
    expect(r.measuredValues?.[alongX.id].value).toBeCloseTo(60, 9);
    // To the Top plane: the box's top face is 20 up.
    const up = measuredOf({ name: "up", kind: "distance", targets: [{ plane: "Top" }, pick([0, 0, 1])] });
    r = engine.rebuild([box, up], { w: 60 });
    expect(r.measuredValues?.[up.id].value).toBeCloseTo(20, 6);
  });

  it("a feature before the variable can't use it, and says why; a failed measurement says so to its users", () => {
    const faces = boxFaces();
    const box = feature("box", { width: 40, depth: 30, height: 20 });
    const width = measuredOf({ name: "width", kind: "distance", targets: [{ partId: box.id, ref: facing(faces, [-1, 0, 0]) }, { partId: box.id, ref: facing(faces, [1, 0, 0]) }] });
    const early = feature("box", { width: "width", depth: 5, height: 5, x: 100 });
    engine = new GeometryEngine();
    let r = engine.rebuild([box, early, width]);
    expect(r.featureErrors[early.id]).toMatch(/further down the list/);
    // A part that isn't there: the variable fails, and the feature using it says so.
    const lost = measuredOf({ name: "gone", kind: "distance", targets: [{ partId: "nope", ref: facing(faces, [-1, 0, 0]) }, { plane: "Top" }] });
    const user = feature("box", { width: "gone", depth: 5, height: 5, x: 100 });
    r = engine.rebuild([box, lost, user]);
    expect(r.featureErrors[lost.id]).toMatch(/part it measures on is gone/);
    expect(r.featureErrors[user.id]).toMatch(/couldn't be measured/);
    // A name the Variables table already has is refused.
    const clash = measuredOf({ name: "w", kind: "distance", targets: [{ plane: "Top" }, { plane: "Top" }] });
    r = engine.rebuild([box, clash], { w: 3 });
    expect(r.featureErrors[clash.id]).toMatch(/Variables table already has/);
  });

  it("a round face's diameter and radius, an edge's length", () => {
    const cyl = feature("cylinder", { diameter: 12, height: 8 });
    engine = new GeometryEngine();
    const built = engine.rebuild([cyl]).parts[0];
    const round = built.faceRefs.find((f) => f.surface === "CYLINDRE")!;
    const rim = built.edgeRefs.find((e: EdgeRef) => e.curve === "CIRCLE")!;
    const d = measuredOf({ name: "d", kind: "diameter", targets: [{ partId: cyl.id, ref: round }] });
    const rad = measuredOf({ name: "rad", kind: "radius", targets: [{ partId: cyl.id, ref: rim }] });
    const len = measuredOf({ name: "len", kind: "length", targets: [{ partId: cyl.id, ref: rim }] });
    const r = engine.rebuild([cyl, d, rad, len]);
    expect(r.featureErrors).toEqual({});
    expect(r.measuredValues?.[d.id].value).toBeCloseTo(12, 6);
    expect(r.measuredValues?.[rad.id].value).toBeCloseTo(6, 6);
    expect(r.measuredValues?.[len.id].value).toBeCloseTo(12 * Math.PI, 4);
  });

  it("the angle between a face and a tilted plane is an angle (degrees) later boxes can use", () => {
    const faces = boxFaces();
    const box = feature("box", { width: 40, depth: 30, height: 20 });
    const plane = { ...feature("plane", { distance: 0, angle: 30 }), planeDef: { mode: "angle" as const, ref: { kind: "default" as const, name: "Top" as const }, axis: "u" as const } };
    const tilt = measuredOf({ name: "tilt", kind: "angle", targets: [{ partId: box.id, ref: facing(faces, [0, 0, 1]) }, { plane: plane.id }] });
    const square = measuredOf({ name: "square", kind: "angle", targets: [{ partId: box.id, ref: facing(faces, [0, 0, 1]) }, { partId: box.id, ref: facing(faces, [1, 0, 0]) }] });
    const uses = feature("box", { width: "cos(tilt) * 10", depth: 5, height: 5, x: 100 });
    engine = new GeometryEngine();
    const r = engine.rebuild([box, plane, tilt, square, uses]);
    expect(r.featureErrors).toEqual({});
    expect(r.measuredValues?.[tilt.id]).toEqual({ name: "tilt", value: 30, angle: true });
    expect(r.measuredValues?.[square.id].value).toBeCloseTo(90, 6);
    expect(meshOf(r, 1).volume).toBeCloseTo(Math.cos(Math.PI / 6) * 10 * 25, 3);
  });

  it("a sketch after it whose dimension uses it is solved again as the model changes", () => {
    const faces = boxFaces();
    const box = feature("box", { width: "w", depth: 30, height: 20 });
    const width = measuredOf({ name: "width", kind: "distance", targets: [{ partId: box.id, ref: facing(faces, [-1, 0, 0]) }, { partId: box.id, ref: facing(faces, [1, 0, 0]) }] });
    // Drawn (as the app does) with the value as last measured: 40.
    setCurrentScope({ width: 40 });
    const data = buildSketch([{ type: "rectangle", corner: [100, 0], width: "width", height: 10 }], { width: 40 }).data;
    setCurrentScope({});
    const sk = sketchFeature({ kind: "default", name: "Top" }, data);
    const pad = extrudeFeature(sk.id, 5);
    engine = new GeometryEngine();
    let r = engine.rebuild([box, width, sk, pad], { w: 40 });
    expect(r.featureErrors).toEqual({});
    expect(meshOf(r, 1).volume).toBeCloseTo(40 * 10 * 5, 3);
    r = engine.rebuild([box, width, sk, pad], { w: 60 });
    expect(r.featureErrors).toEqual({});
    expect(meshOf(r, 1).volume).toBeCloseTo(60 * 10 * 5, 3);
    // The app is told the sketch as solved now (to show it).
    expect(r.sketchLinks?.[sk.id]?.sketch).toBeTruthy();
  });
});
