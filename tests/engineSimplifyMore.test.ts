/**
 * Engine tests (heavy, on their own): Simplify's newer shapes with the real OpenCascade engine — real parts made
 * here, brought in from STEP and saved as STLs with the app's own exporter, then simplified: slanted holes (ellipse
 * rims), round faces crossing (a T of bars, a hole through a hole), fillets part way round corners (parts of tori).
 * The fitting maths is tested without OpenCascade in meshSimplifyMore.test.ts.
 */
import { makeBox, makeCylinder, measureVolume, type Shape3D } from "replicad";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import { writeStep } from "../src/kernel/stepExport";
import type { Feature, ImportedFile } from "../src/model/types";
import { feature, importFeature, loadOpenCascade, relativeError } from "./support/engineHelpers";
import { base64 } from "./support/meshShapes";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features);
}

const stepOf = (shape: Shape3D): ImportedFile => ({ fileName: "part.step", format: "step", data: new TextDecoder().decode(writeStep([{ shape, name: "Part", colour: "#888888" }])), units: "mm" });

/** The part brought in from STEP and saved as an STL with the app's own exporter (normal detail). */
function stlFromApp(shape: Shape3D): ImportedFile {
  build([importFeature(stepOf(shape))]);
  const stl = new Uint8Array(engine.exportStl([], "normal").stl);
  return { fileName: "part.stl", format: "stl", data: base64(stl), units: "mm" };
}

/** A simplified import of a part's STL: its faces, round faces' radii, soundness, volume and the note. */
function simplified(shape: Shape3D) {
  const file = stlFromApp(shape);
  const imp = { ...importFeature(file), simplify: "normal" as const };
  const r = build([imp]);
  expect(r.featureErrors).toEqual({});
  const check = engine.check("normal").parts[0];
  const part = r.parts[0];
  const radii = part.faceRefs
    .filter((f) => f.surface === "CYLINDRE")
    .map((ref) => engine.measure([{ partId: part.id, ref }]).items[0].radius ?? 0)
    .map((x) => Math.round(x * 1000) / 1000)
    .sort((a, b) => a - b);
  return { imp, r, part, check, radii, faces: part.faceGroups.length, note: r.featureNotes?.[imp.id] ?? "", volume: measureVolume(shape) };
}

const deg = Math.PI / 180;
/* eslint-disable @typescript-eslint/no-explicit-any */
const slantedHolePlate = () =>
  makeBox([0, 0, 0], [40, 30, 10]).cut(makeCylinder(4, 40, [20, 15 - 20 * Math.sin(30 * deg), 5 - 20 * Math.cos(30 * deg)], [0, Math.sin(30 * deg), Math.cos(30 * deg)]));

describe("slanted holes and ends (ellipses)", () => {
  it("rebuilds a slanted hole: one round face between two elliptical rims, its true size", () => {
    const { check, radii, faces, note, volume, part } = simplified(slantedHolePlate());
    expect(faces).toBe(7);
    expect(radii).toEqual([4]);
    expect(part.edgeRefs.filter((e) => e.curve === "ELLIPSE")).toHaveLength(2);
    expect(check.geometryValid).toBe(true);
    expect(relativeError(check.exactVolume!, volume)).toBeLessThan(0.005);
    expect(note).toMatch(/→ 7 faces: 6 flat, 1 round \(slanted hole Ø8\)/);
  });

  it("gives a slanted rim that can be filleted", () => {
    const { imp, part, check } = simplified(slantedHolePlate());
    const before = check.exactVolume!;
    const rim = part.edgeRefs.find((e) => e.curve === "ELLIPSE" && e.mid[2] > 9.99);
    expect(rim).toBeDefined();
    const fillet: Feature = { ...feature("fillet", { radius: 1 }), picks: [{ partId: part.id, ref: rim! }] };
    const r = engine.rebuild([imp, fillet]);
    expect(r.featureErrors).toEqual({});
    const after = engine.check("normal").parts[0];
    expect(after.geometryValid).toBe(true);
    // Rounding the rim takes a little material away (the hole's rim is a convex edge).
    expect(after.exactVolume!).toBeLessThan(before);
    expect(before - after.exactVolume!).toBeGreaterThan(5);
    expect(before - after.exactVolume!).toBeLessThan(40);
  });

  it("rebuilds a round bar cut off at a slant, and one standing at a slant on a plate", () => {
    const cut = makeCylinder(6, 30, [0, 0, 0], [0, 0, 1]).cut(makeBox([-20, -20, 0], [20, 20, 40]).rotate(25, [0, 0, 15], [1, 0, 0]).translate([0, 0, 15]));
    const a = simplified(cut);
    expect(a.faces).toBe(3);
    expect(a.radii).toEqual([6]);
    expect(a.check.geometryValid).toBe(true);
    expect(relativeError(a.check.exactVolume!, a.volume)).toBeLessThan(0.005);
    const boss = makeBox([-20, -20, -5], [20, 20, 0]).fuse(makeCylinder(4, 20, [0, 0, -2], [0, Math.sin(30 * deg), Math.cos(30 * deg)]));
    const b = simplified(boss);
    expect(b.faces).toBe(8);
    expect(b.radii).toEqual([4]);
    expect(b.check.geometryValid).toBe(true);
    expect(relativeError(b.check.exactVolume!, b.volume)).toBeLessThan(0.005);
  });
});

describe("round faces crossing each other", () => {
  it("rebuilds a T of two round bars, centred and off-centre", () => {
    for (const y of [0, 2]) {
      const tee = makeCylinder(6, 60, [-30, 0, 0], [1, 0, 0]).fuse(makeCylinder(3, 20, [0, y, 0], [0, 0, 1]));
      const { check, radii, faces, note, volume } = simplified(tee);
      expect(faces).toBe(5);
      expect(radii).toEqual([3, 6]);
      expect(check.geometryValid).toBe(true);
      expect(relativeError(check.exactVolume!, volume)).toBeLessThan(0.005);
      expect(note).toMatch(/rounds Ø6, Ø12, 1 curved edge where round faces meet/);
    }
  });

  it("rebuilds a hole through a hole", () => {
    const block = makeBox([0, 0, 0], [40, 30, 30]).cut(makeCylinder(4, 40, [20, 15, -5], [0, 0, 1])).cut(makeCylinder(3, 50, [-5, 15, 15], [1, 0, 0]));
    const { check, radii, faces, note, volume } = simplified(block);
    // 6 flat, the upright hole and the cross hole in two pieces (either side of it).
    expect(faces).toBe(9);
    expect(radii).toEqual([3, 3, 4]);
    expect(check.geometryValid).toBe(true);
    expect(relativeError(check.exactVolume!, volume)).toBeLessThan(0.005);
    expect(note).toMatch(/holes Ø6, Ø8, 2 curved edges where round faces meet/);
  });
});

describe("fillets part way round a corner (parts of tori)", () => {
  it("rebuilds a plate with rounded corners and a rounded top edge", () => {
    let s: Shape3D = makeBox([0, 0, 0], [40, 30, 8]);
    s = s.fillet((e: any) => (Math.abs(e.startPoint.z - e.endPoint.z) > 1 ? 5 : null));
    s = s.fillet((e: any) => (Math.abs(e.startPoint.z - 8) < 1e-6 && Math.abs(e.endPoint.z - 8) < 1e-6 ? 1.5 : null));
    const { check, radii, faces, note, volume, part } = simplified(s);
    // 6 flat, 4 round corners, 4 straight roundings and 4 corner pieces of rings along the top.
    expect(faces).toBe(18);
    expect(part.faceRefs.filter((f) => f.surface === "TORUS")).toHaveLength(4);
    expect(radii).toEqual([1.5, 1.5, 1.5, 1.5, 5, 5, 5, 5]);
    expect(check.geometryValid).toBe(true);
    expect(relativeError(check.exactVolume!, volume)).toBeLessThan(0.005);
    expect(note).toMatch(/12 round \(rounded edges R1\.5, R5\)/);
  });

  it("rebuilds a rounded pocket with a rounded floor, and a rounded foot round a boss", () => {
    let s: Shape3D = makeBox([0, 0, 0], [50, 40, 12]);
    const pocket = makeBox([10, 10, 4], [40, 30, 20]).fillet((e: any) => (Math.abs(e.startPoint.z - e.endPoint.z) > 1 ? 6 : null));
    s = s.cut(pocket).fillet((e: any) => (Math.abs(e.startPoint.z - 4) < 1e-6 && Math.abs(e.endPoint.z - 4) < 1e-6 ? 2 : null));
    const a = simplified(s);
    expect(a.faces).toBe(23);
    expect(a.part.faceRefs.filter((f) => f.surface === "TORUS")).toHaveLength(4);
    expect(a.check.geometryValid).toBe(true);
    expect(relativeError(a.check.exactVolume!, a.volume)).toBeLessThan(0.005);
    const boss = makeBox([0, 0, 0], [30, 30, 5])
      .fuse(makeCylinder(5, 10, [15, 15, 5], [0, 0, 1]))
      .fillet((e: any) => (Math.abs(e.startPoint.z - 5) < 1e-6 && Math.abs(e.endPoint.z - 5) < 1e-6 && Math.hypot(e.startPoint.x - 15, e.startPoint.y - 15) < 6 ? 1 : null));
    const b = simplified(boss);
    expect(b.faces).toBe(9);
    expect(b.radii).toEqual([5]);
    expect(b.check.geometryValid).toBe(true);
    expect(relativeError(b.check.exactVolume!, b.volume)).toBeLessThan(0.005);
    expect(b.note).toMatch(/round Ø10, rounded edge R1/);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
