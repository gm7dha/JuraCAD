/**
 * Engine tests: Simplify (tidying triangles, and faces split into pieces,
 * into real faces) with the real OpenCascade engine. On its own because
 * importing meshes is heavy. The fitting maths is tested without
 * OpenCascade in shapeFit.test.ts / meshSimplify.test.ts.
 */
import { cast, getOC, makeBox, makeCylinder, makePolygon, measureVolume, type Shape3D } from "replicad";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeBinaryStl } from "../src/geometry/stl";
import { GeometryEngine } from "../src/kernel/engine";
import { writeStep } from "../src/kernel/stepExport";
import { MESH_TOLERANCES, type Feature, type ImportedFile } from "../src/model/types";
import { feature, importFeature, loadOpenCascade, relativeError } from "./support/engineHelpers";

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
    expect(r.featureNotes?.[imp.id]).toMatch(/faces → 1[0-2] faces: .*flat, 3 round \(holes Ø5, Ø8, fillet R2\)/);
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
    // A lumpy ball.
    const N = 12;
    const M = 18;
    const vertices: number[] = [];
    const triangles: number[] = [];
    for (let i = 0; i <= N; i++)
      for (let j = 0; j < M; j++) {
        if ((i === 0 || i === N) && j > 0) continue;
        const th = (Math.PI * i) / N;
        const ph = (2 * Math.PI * j) / M;
        const r = 10 + 2 * Math.sin(3 * th) * Math.cos(2 * ph) + ((i * 7 + j * 13) % 5) * 0.1;
        vertices.push(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th));
      }
    const at = (i: number, j: number) => (i === 0 ? 0 : i === N ? 1 + (N - 1) * M : 1 + (i - 1) * M + (j % M));
    for (let i = 0; i < N; i++)
      for (let j = 0; j < M; j++) {
        if (i > 0) triangles.push(at(i, j), at(i + 1, j), at(i, j + 1));
        if (i < N - 1) triangles.push(at(i, j + 1), at(i + 1, j), at(i + 1, j + 1));
      }
    const file: ImportedFile = { fileName: "blob.stl", format: "stl", data: base64(new Uint8Array(writeBinaryStl([{ vertices, triangles }]))), units: "mm" };
    const imp = { ...importFeature(file), simplify: "normal" as const };
    const r = build([imp]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    const check = engine.check("normal");
    expect(check.parts[0].geometryValid).toBe(true);
    expect(check.parts[0].exactVolume!).toBeGreaterThan(3000);
    expect(r.featureNotes?.[imp.id]).toMatch(/left as mesh/);
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
