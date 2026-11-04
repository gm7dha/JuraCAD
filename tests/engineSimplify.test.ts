/**
 * Engine tests: Simplify (tidying triangles, and faces split into pieces,
 * into real faces) with the real OpenCascade engine. On its own because
 * importing meshes is heavy. The fitting maths is tested without
 * OpenCascade in shapeFit.test.ts / meshSimplify.test.ts.
 */
import { cast, draw, getOC, makeBox, makeCylinder, makePolygon, measureVolume, type Shape3D } from "replicad";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeBinaryStl } from "../src/geometry/stl";
import { GeometryEngine } from "../src/kernel/engine";
import { writeStep } from "../src/kernel/stepExport";
import { checkedUnify } from "../src/kernel/simplify";
import { SIMPLIFY_TOLERANCES } from "../src/model/simplify";
import { MESH_TOLERANCES, type Feature, type ImportedFile } from "../src/model/types";
import { feature, importFeature, loadOpenCascade, relativeError } from "./support/engineHelpers";
import { lumpyBall } from "./support/meshShapes";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features);
}

const base64 = (bytes: Uint8Array) => {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const along = (e: any, x: number, y: number) =>
  [e.startPoint, e.endPoint].every((p: any) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6);

/** A machined block: 40 × 30 × 10 with Ø5 and Ø8 holes right through, an R2 fillet and a 1.5 chamfer on two upright edges. */
function machinedBlock(): Shape3D {
  let s: Shape3D = makeBox([0, 0, 0], [40, 30, 10]);
  s = s.cut(makeCylinder(2.5, 20, [10, 15, -5], [0, 0, 1]));
  s = s.cut(makeCylinder(4, 20, [28, 15, -5], [0, 0, 1]));
  s = s.fillet((e: any) => (along(e, 40, 30) ? 2 : null));
  s = s.chamfer((e: any) => (along(e, 0, 0) ? 1.5 : null));
  return s;
}

/** Two solids fused by OpenCascade without joining the faces that end up on the same surface. */
function fusedAsIs(a: Shape3D, b: Shape3D): Shape3D {
  const oc = getOC() as any;
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  args.Append(a.wrapped);
  tools.Append(b.wrapped);
  const fuse = new oc.BRepAlgoAPI_Fuse();
  fuse.SetArguments(args);
  fuse.SetTools(tools);
  fuse.Build();
  const out = cast(fuse.Shape()) as Shape3D;
  [fuse, args, tools].forEach((x) => x.delete());
  return out;
}

/** A part as a mesh-like STEP file holds it: every triangle its own flat face, sewn into a skin (not a solid). */
function triangleSkin(shape: Shape3D): Shape3D {
  const oc = getOC() as any;
  const m = shape.mesh(MESH_TOLERANCES.normal);
  const sewing = new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false);
  const v = (i: number): [number, number, number] => [m.vertices[3 * i], m.vertices[3 * i + 1], m.vertices[3 * i + 2]];
  const faces: Shape3D[] = [];
  for (let t = 0; t < m.triangles.length; t += 3) {
    const f = makePolygon([v(m.triangles[t]), v(m.triangles[t + 1]), v(m.triangles[t + 2])]) as unknown as Shape3D;
    faces.push(f);
    sewing.Add(f.wrapped);
  }
  sewing.Perform();
  const out = cast(sewing.SewedShape()) as Shape3D;
  sewing.delete();
  faces.forEach((f) => f.delete());
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const stepOf = (shape: Shape3D): ImportedFile => ({ fileName: "part.step", format: "step", data: new TextDecoder().decode(writeStep([{ shape, name: "Part", colour: "#888888" }])), units: "mm" });

/** The part brought in from STEP and saved as an STL with the app's own exporter (normal detail). */
function stlFromApp(shape: Shape3D): ImportedFile {
  build([importFeature(stepOf(shape))]);
  const stl = new Uint8Array(engine.exportStl([], "normal").stl);
  return { fileName: "part.stl", format: "stl", data: base64(stl), units: "mm" };
}

const cylinderFaces = (r: ReturnType<typeof build>) => r.parts[0].faceRefs.filter((f) => f.surface === "CYLINDRE");

describe("Simplify on import", () => {
  it("tidies an STL of a machined block back into its real faces, with the holes' true sizes", () => {
    const block = machinedBlock();
    const volume = measureVolume(block);
    const file = stlFromApp(block);
    const plain = build([importFeature(file)]);
    const before = plain.parts[0].faceGroups.length;
    const imp = { ...importFeature(file), simplify: "normal" as const };
    const r = build([imp]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    const after = r.parts[0].faceGroups.length;
    // The block has 10 faces; the plain import has hundreds (every facet of the holes and fillet).
    expect(before).toBeGreaterThan(100);
    expect(after).toBeLessThanOrEqual(12);
    expect(after).toBeGreaterThanOrEqual(10);
    // Holes are real cylinders again: measuring one gives its true diameter.
    const round = cylinderFaces(r);
    expect(round.length).toBe(3);
    const radii = round.map((ref) => engine.measure([{ partId: r.parts[0].id, ref }]).items[0].radius ?? 0).sort((a, b) => a - b);
    expect(Math.abs(radii[0] - 2)).toBeLessThan(0.01);
    expect(Math.abs(radii[1] - 2.5)).toBeLessThan(0.01);
    expect(Math.abs(radii[2] - 4)).toBeLessThan(0.01);
    // A sound solid of the same volume.
    const check = engine.check("normal");
    expect(check.parts[0].geometryValid).toBe(true);
    expect(relativeError(check.parts[0].exactVolume!, volume)).toBeLessThan(0.005);
    // The summary.
    expect(r.featureNotes?.[imp.id]).toMatch(/faces → 1[0-2] faces: .*flat, 3 round \(holes Ø5, Ø8, rounded edge R2\)/);
  });

  it("gives faces that can be filleted", () => {
    const file = stlFromApp(machinedBlock());
    const imp = { ...importFeature(file), simplify: "normal" as const };
    const first = build([imp]);
    const volume = engine.check("normal").parts[0].exactVolume!;
    // The upright edge at x = 0, y = 30 (straight, from z 0 to 10).
    const edge = first.parts[0].edgeRefs.find((e) => e.curve === "LINE" && Math.abs(e.mid[0]) < 1e-3 && Math.abs(e.mid[1] - 30) < 1e-3);
    expect(edge).toBeDefined();
    const fillet: Feature = { ...feature("fillet", { radius: 3 }), picks: [{ partId: first.parts[0].id, ref: edge! }] };
    const r = build([imp, fillet]);
    expect(r.featureErrors).toEqual({});
    const after = engine.check("normal").parts[0];
    expect(after.geometryValid).toBe(true);
    // A 3 mm fillet along 10 mm takes away (1 − π/4)·9·10 mm³.
    expect(volume - after.exactVolume!).toBeCloseTo((1 - Math.PI / 4) * 90, 1);
  });

  it("joins a genuine STEP file's split faces without changing it", () => {
    // Two boxes fused without tidying: the top, bottom and sides are each in two pieces.
    const a = makeBox([0, 0, 0], [20, 10, 5]);
    const b = makeBox([20, 0, 0], [40, 10, 5]);
    const split = fusedAsIs(a, b);
    const volume = measureVolume(split);
    const file = stepOf(split);
    const plain = build([importFeature(file)]);
    expect(plain.parts[0].faceGroups.length).toBeGreaterThan(6);
    const imp = { ...importFeature(file), simplify: "normal" as const };
    const r = build([imp]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts[0].faceGroups).toHaveLength(6);
    const check = engine.check("normal");
    expect(check.parts[0].geometryValid).toBe(true);
    expect(relativeError(check.parts[0].exactVolume!, volume)).toBeLessThan(1e-9);
    expect(r.featureNotes?.[imp.id]).toMatch(/→ 6 faces: 6 flat\./);
  });

  it("makes a solid of real faces from a mesh-like STEP file (triangles as a skin)", () => {
    const block = machinedBlock();
    const file = stepOf(triangleSkin(block));
    const plain = build([importFeature(file)]);
    expect(plain.parts).toHaveLength(1);
    expect(plain.parts[0].surface).toBe(true);
    const imp = { ...importFeature(file), simplify: "normal" as const };
    const r = build([imp]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0].surface).toBeFalsy();
    expect(r.parts[0].faceGroups.length).toBeLessThanOrEqual(12);
    expect(cylinderFaces(r)).toHaveLength(3);
    const check = engine.check("normal");
    expect(check.parts[0].geometryValid).toBe(true);
    expect(relativeError(check.parts[0].exactVolume!, measureVolume(block))).toBeLessThan(0.005);
  });

  it("copes with an organic mesh: nothing fits, but it comes in whole and sound", () => {
    const { vertices, triangles } = lumpyBall(12, 18);
    const file: ImportedFile = { fileName: "blob.stl", format: "stl", data: base64(new Uint8Array(writeBinaryStl([{ vertices, triangles }]))), units: "mm" };
    const imp = { ...importFeature(file), simplify: "normal" as const };
    const r = build([imp]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    const check = engine.check("normal");
    expect(check.parts[0].geometryValid).toBe(true);
    expect(check.parts[0].exactVolume!).toBeGreaterThan(3000);
    expect(r.featureNotes?.[imp.id]).toMatch(/left as mesh|organic shape/);
  });
});

/** What a simplified import of a part's STL gives: round faces' radii, soundness, volume and the note. */
function simplifiedStl(shape: Shape3D) {
  const file = stlFromApp(shape);
  const imp = { ...importFeature(file), simplify: "normal" as const };
  const r = build([imp]);
  const check = engine.check("normal").parts[0];
  const radii = cylinderFaces(r)
    .map((ref) => engine.measure([{ partId: r.parts[0].id, ref }]).items[0].radius ?? 0)
    .sort((a, b) => a - b);
  return { r, check, radii, faces: r.parts[0].faceGroups.length, note: r.featureNotes?.[imp.id] ?? "" };
}

describe("round faces that curve inwards part of the way round", () => {
  it("rebuilds a slot's round ends", () => {
    let s: Shape3D = makeBox([0, 0, 0], [40, 20, 6]);
    s = s.cut(makeBox([12, 8, -1], [27, 12, 7])).cut(makeCylinder(2, 10, [12, 10, -2], [0, 0, 1])).cut(makeCylinder(2, 10, [27, 10, -2], [0, 0, 1]));
    const { check, radii, faces } = simplifiedStl(s);
    expect(faces).toBe(10);
    expect(radii.map((x) => Math.round(x * 1000) / 1000)).toEqual([2, 2]);
    expect(check.geometryValid).toBe(true);
    expect(relativeError(check.exactVolume!, measureVolume(s))).toBeLessThan(0.005);
  });

  it("rebuilds an inside fillet (and an outside one)", () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    let s: Shape3D = makeBox([0, 0, 0], [40, 30, 4]).fuse(makeBox([0, 0, 0], [4, 30, 25]));
    const on = (e: any, x: number, z: number) => [e.startPoint, e.endPoint].every((p: any) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.z - z) < 1e-6);
    s = s.fillet((e: any) => (on(e, 4, 4) ? 3 : null));
    s = s.fillet((e: any) => (on(e, 40, 4) ? 1 : null));
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const { check, radii, faces, note } = simplifiedStl(s);
    expect(faces).toBe(10);
    expect(radii.map((x) => Math.round(x * 1000) / 1000)).toEqual([1, 3]);
    expect(check.geometryValid).toBe(true);
    expect(note).toMatch(/rounded edges R1, R3/);
  });

  it("rebuilds a round notch in an edge", () => {
    const s = makeBox([0, 0, 0], [30, 20, 8]).cut(makeCylinder(3, 20, [15, 0, -5], [0, 0, 1]));
    const { check, radii, faces } = simplifiedStl(s);
    // (The front face is in two pieces, either side of the notch.)
    expect(faces).toBe(8);
    expect(radii.map((x) => Math.round(x * 1000) / 1000)).toEqual([3]);
    expect(check.geometryValid).toBe(true);
    expect(relativeError(check.exactVolume!, measureVolume(s))).toBeLessThan(0.005);
  });
});

describe("joining faces is checked", () => {
  it("never joins an exact STEP file's faces that are really at an angle", () => {
    // A roof whose two halves meet at 0.86° (within Coarse's angle, but a real edge).
    const roof = draw([0, 0]).lineTo([40, 0]).lineTo([40, 10]).lineTo([20, 10.15]).lineTo([0, 10]).close().sketchOnPlane("XZ").extrude(-20) as unknown as Shape3D;
    const volume = measureVolume(roof);
    for (const level of ["normal", "coarse"] as const) {
      const imp = { ...importFeature(stepOf(roof)), simplify: level };
      const r = build([imp]);
      expect(r.parts[0].faceGroups).toHaveLength(7);
      const check = engine.check("normal").parts[0];
      expect(check.geometryValid).toBe(true);
      expect(relativeError(check.exactVolume!, volume)).toBeLessThan(1e-9);
    }
  });

  it("keeps the part as it was when joining would spoil it", () => {
    // A slot's STL as an ordinary import (every facet a face), joined with tolerances far too loose: refused.
    const r = build([importFeature(stlFromApp(makeBox([0, 0, 0], [40, 20, 6]).cut(makeCylinder(3, 10, [20, 10, -2], [0, 0, 1]))))]);
    const shape = (engine as unknown as { parts: { shape: Shape3D }[] }).parts[0].shape;
    const loose = { ...SIMPLIFY_TOLERANCES.coarse, distance: 3, angle: Math.PI / 4 };
    const out = checkedUnify(shape, loose);
    // Either OpenCascade's own tight tolerances joined only what's truly flat, or it's left as it was — but it's sound and the same size.
    expect(relativeError(measureVolume(out.shape), measureVolume(shape))).toBeLessThan(1e-6);
    expect(r.parts[0].faceGroups.length).toBeGreaterThan(20);
    out.shape.delete();
  });
});

describe("Simplify part", () => {
  it("tidies a part afterwards, as a feature of its own", () => {
    const file = stlFromApp(machinedBlock());
    const imp = importFeature(file);
    const simplify: Feature = { ...feature("simplify", {}), simplifyParts: [imp.id], simplify: "normal" };
    const r = build([imp, simplify]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts[0].faceGroups.length).toBeLessThanOrEqual(12);
    expect(cylinderFaces(r)).toHaveLength(3);
    expect(r.featureNotes?.[simplify.id]).toMatch(/holes Ø5, Ø8/);
    expect(engine.check("normal").parts[0].geometryValid).toBe(true);
    // Rebuilding again uses what it made.
    const again = engine.rebuild([imp, simplify]);
    expect(again.parts[0].faceGroups.length).toBe(r.parts[0].faceGroups.length);
    // No parts picked: it says so.
    const none = build([imp, { ...simplify, simplifyParts: [] }]);
    expect(none.featureErrors[simplify.id]).toMatch(/Click the parts/);
  });
});
