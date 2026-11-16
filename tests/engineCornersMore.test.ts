/**
 * Engine tests: corners (vertices) used beyond Part Studio points — a mate in an assembly on two corners (followed
 * when the part's size variable changes, and on a mirrored copy), a loft to a part's corner, and a sketch point
 * brought in from a corner with Use (followed as the part grows). Runs the real OpenCascade engine.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import { cornersOf, type VertexPick } from "../src/geometry/vertexRef";
import { connectorFrameFor, placeFrame, solveWithParts } from "../src/assembly/mates";
import { vertexConnectorPick } from "../src/assembly/connectors";
import { assemblyExtrudeCut, assemblySketch } from "../src/assembly/assemblyFeatures";
import { cutMeshesFrom, storedCutInputs } from "../src/assembly/placed";
import { planeOnFace } from "../src/sketch/planes";
import type { PartMesh } from "../src/kernel/protocol";
import type { Assembly, Feature, Mate } from "../src/model/types";
import { linkCorner } from "../src/sketch/links";
import { planeFrame, type SketchPlane, type Vec3 } from "../src/sketch/planes";
import { emptySketch } from "../src/sketch/types";
import { feature, loadOpenCascade, rectSketch, sketchFeature } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

const TOP: SketchPlane = { kind: "default", name: "Top" };
const near = (p: Vec3, q: Vec3, tol = 1e-6) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < tol;

function corner(part: PartMesh, at: Vec3): VertexPick {
  const ref = cornersOf(part).find((c) => near(c.p, at));
  if (!ref) throw new Error(`no corner at ${at}`);
  return { partId: part.id, ref };
}

const still = { position: [0, 0, 0] as Vec3, rotation: [0, 0, 0, 1] as [number, number, number, number] };

describe("corners in assemblies", () => {
  it("fastens a part's corner to another's, followed when the part gets wider, and on a mirrored copy", () => {
    const a = feature("box", { width: "w", depth: 20, height: 10 });
    const b = feature("box", { width: 10, depth: 10, height: 10, x: 100 });
    engine = new GeometryEngine();
    const parts = engine.rebuild([a, b], { w: 40 }).parts;
    const pa = parts.find((p) => p.id === a.id)!;
    const pb = parts.find((p) => p.id === b.id)!;
    const ca = corner(pa, [40, 20, 10]);
    const cb = corner(pb, [100, 0, 0]);
    const mate: Mate = {
      id: "m",
      name: "Fasten 1",
      type: "fastened",
      a: { instanceId: "i1", ...vertexConnectorPick(pa.id, ca.ref) },
      b: { instanceId: "i2", ...vertexConnectorPick(pb.id, cb.ref) },
      flip: true,
      values: {},
    };
    const asm: Assembly = {
      id: "A",
      name: "A",
      instances: [
        { id: "i1", partId: a.id, name: "a", placement: still, fixed: true },
        { id: "i2", partId: b.id, name: "b", placement: still, fixed: false },
      ],
      mates: [mate],
    };
    // The connector is at the corner, lined up with X, Y and Z.
    const fa = connectorFrameFor(asm, parts, mate.a)!;
    expect(near(fa.origin, [40, 20, 10])).toBe(true);
    expect(near(fa.z, [0, 0, 1])).toBe(true);
    expect(near(fa.x, [1, 0, 0])).toBe(true);
    let r = solveWithParts(asm, parts);
    expect(r.mateErrors).toEqual({});
    // Pointed the same way: the block is only moved (its corner onto the other's), never turned over.
    expect(near(r.placements.i2.position, [40 - 100, 20, 10], 1e-5)).toBe(true);
    expect(Math.abs(Math.abs(r.placements.i2.rotation[3]) - 1)).toBeLessThan(1e-6);

    // Wider: the corner is found again further out, and the block follows it.
    const wider = engine.rebuild([a, b], { w: 60 }).parts;
    r = solveWithParts(asm, wider);
    expect(r.mateErrors).toEqual({});
    expect(near(r.placements.i2.position, [60 - 100, 20, 10], 1e-5)).toBe(true);

    // A mirrored copy: its corner (as the copy shows it, flipped) still lands on the other's.
    const mirrored: Assembly = { ...asm, instances: asm.instances.map((i) => (i.id === "i2" ? { ...i, mirrored: true } : i)) };
    const rm = solveWithParts(mirrored, wider);
    expect(rm.mateErrors).toEqual({});
    const fb = connectorFrameFor(mirrored, wider, mate.b)!;
    expect(near(fb.origin, [-100, 0, 0])).toBe(true);
    expect(near(placeFrame(rm.placements.i2, fb).origin, [60, 20, 10], 1e-5)).toBe(true);

    // The corner gone (the block made too different) = the mate can't find it.
    const lost = connectorFrameFor(asm, wider, { ...mate.a, vertex: { kind: "vertex", p: [500, 500, 500], rel: [5, 5, 5], dirs: [[1, 0, 0]] } });
    expect(lost).toBeNull();
  });
});

describe("a corner of a copy cut by the assembly's features", () => {
  it("is the pocket's corner, not the plain part's corner near it; the part's own corners stay put", () => {
    const plate = feature("box", { width: "w", depth: 40, height: 5 });
    const cube = feature("box", { width: 10, depth: 10, height: 10, x: 100 });
    engine = new GeometryEngine();
    let parts = engine.rebuild([plate, cube], { w: 40 }).parts;
    // A 4 mm square pocket, 2 deep, cut by the assembly near the plate's back right corner.
    const sk = assemblySketch({}, planeOnFace([0, 0, 1], [0, 0, 5], "Top"), rectSketch(34, 34, 4, 4), "s1");
    const pocket = assemblyExtrudeCut({ features: [sk] }, sk.id, { throughAll: false, depth: 2 }, "c1");
    const base: Assembly = {
      id: "A",
      name: "A",
      features: [sk, pocket],
      instances: [
        { id: "i1", partId: plate.id, name: "Plate <1>", placement: still, fixed: true },
        { id: "i2", partId: cube.id, name: "Cube <1>", placement: still, fixed: false },
      ],
    };
    const cutsOf = (ps: PartMesh[]) => cutMeshesFrom(engine.assemblyCuts(storedCutInputs([base], ps)).meshes);
    let cuts = cutsOf(parts);
    const pc = cornersOf(cuts("A")!.i1).find((c) => near(c.p, [38, 38, 5]))!;
    const cb = corner(parts.find((p) => p.id === cube.id)!, [100, 0, 0]);
    const mateTo = (ref: typeof pc): Assembly => ({
      ...base,
      mates: [{ id: "m", name: "Fasten 1", type: "fastened", a: { instanceId: "i1", ...vertexConnectorPick(plate.id, ref) }, b: { instanceId: "i2", ...vertexConnectorPick(cube.id, cb.ref) }, flip: true, values: {} }],
    });
    let asm = mateTo(pc);
    expect(connectorFrameFor(asm, parts, asm.mates![0].a, [asm], [], cuts)!.origin).toEqual([38, 38, 5]);
    let r = solveWithParts(asm, parts, { cutMeshes: cuts });
    expect(r.mateErrors).toEqual({});
    expect(near(r.placements.i2.position, [-62, 38, 5], 1e-5)).toBe(true);
    // The plate moved by a mate on the pocket's corner: the pocket wouldn't be there any more, so the mate says so.
    const moving: Assembly = { ...asm, instances: asm.instances.map((i) => ({ ...i, fixed: i.id === "i2" })) };
    const rm = solveWithParts(moving, parts, { cutMeshes: cuts });
    expect(rm.mateErrors.m).toMatch(/uses a corner made by an assembly feature/);
    expect(near(rm.placements.i1.position, [0, 0, 0])).toBe(true);
    // The plate made wider: the pocket stays where it was cut, and so does the cube.
    parts = engine.rebuild([plate, cube], { w: 60 }).parts;
    cuts = cutsOf(parts);
    r = solveWithParts(asm, parts, { cutMeshes: cuts });
    expect(near(r.placements.i2.position, [-62, 38, 5], 1e-5)).toBe(true);
    // A corner the plate always had is followed on the plate itself, as it grows.
    const own = corner(engine.rebuild([plate, cube], { w: 40 }).parts.find((p) => p.id === plate.id)!, [40, 40, 5]);
    asm = mateTo(own.ref);
    expect(connectorFrameFor(asm, parts, asm.mates![0].a, [asm], [], cuts)!.origin).toEqual([60, 40, 5]);
  });
});

describe("a loft to a corner", () => {
  it("makes a pyramid up to the box's corner, which follows the box", () => {
    const box = feature("box", { width: 40, depth: 40, height: "h" });
    engine = new GeometryEngine();
    const first = engine.rebuild([box], { h: 30 }).parts[0];
    const tip = corner(first, [40, 40, 30]);
    const base = sketchFeature(TOP, rectSketch(100, 0, 20, 20));
    const lo: Feature = { ...feature("loft", {}), sections: [base.id], loft: { profiles: [{ sketch: base.id }, { point: { p: tip.ref.p, vertex: tip } }] } };
    const volume = (h: number) => {
      const r = engine.rebuild([box, base, lo], { h });
      expect(r.featureErrors).toEqual({});
      return r.parts.find((p) => p.id === lo.id)!.volume!;
    };
    expect(Math.abs(volume(30) - (400 * 30) / 3)).toBeLessThan(1e-3);
    expect(Math.abs(volume(15) - (400 * 15) / 3)).toBeLessThan(1e-3);
    // Its corner can't be found: a plain message.
    const gone: Feature = { ...lo, loft: { profiles: [{ sketch: base.id }, { point: { p: [0, 0, 0], vertex: { partId: box.id, ref: { kind: "vertex", p: [900, 900, 900], rel: [9, 9, 9] } } } }] } };
    expect(engine.rebuild([box, base, gone], { h: 30 }).featureErrors[gone.id]).toMatch(/corner can't be found/);
  });
});

describe("a sketch point used from a corner", () => {
  it("is fixed where the corner is and follows it when the part grows", () => {
    const box = feature("box", { width: "w", depth: 20, height: 10 });
    engine = new GeometryEngine();
    const part = engine.rebuild([box], { w: 40 }).parts[0];
    const used = linkCorner(emptySketch(), planeFrame(TOP), corner(part, [40, 20, 10]));
    expect(used.error).toBeUndefined();
    const pt = used.sketch.points.find((p) => p.id === used.pointId)!;
    expect([pt.x, pt.y]).toEqual([40, 20]);
    expect(pt.standalone).toBe(true);
    expect(pt.link).toMatchObject({ partId: box.id, end: "corner" });
    // The same corner again: the point already there.
    expect(linkCorner(used.sketch, planeFrame(TOP), corner(part, [40, 20, 10])).pointId).toBe(used.pointId);
    const sk = sketchFeature(TOP, used.sketch);
    const r = engine.rebuild([box, sk], { w: 65 });
    const at = r.sketchLinks?.[sk.id]?.pointLinks?.[used.pointId];
    expect(at).toBeTruthy();
    expect(Math.abs(at![0] - 65)).toBeLessThan(1e-6);
    expect(Math.abs(at![1] - 20)).toBeLessThan(1e-6);
    // Its part gone: a plain message about the corner (not an edge), and the point stays where it was.
    const lost = engine.rebuild([{ ...box, suppressed: true }, sk], { w: 65 });
    expect(lost.sketchLinks?.[sk.id]?.pointLinks?.[used.pointId]).toBeNull();
    expect(lost.featureErrors[sk.id]).toMatch(/takes from a part's corner can't be found/);
  });
});
