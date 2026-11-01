/**
 * Flexible sub-assemblies, mirrored sub-assemblies and slanted symmetric parts
 * on real parts (the OpenCascade engine runs in Node): a hinge that opens to
 * meet a mate in the parent, a mirrored sub-assembly written to STEP as its
 * own product, and a part drawn at a slant found symmetric and mirrored as
 * itself — checked by reading the exported files back.
 */
import { measureShapeVolumeProperties, type Shape3D } from "replicad";
import { beforeAll, describe, expect, it } from "vitest";

import { applyPlacement, IDENTITY, quatFromAxisAngle, rotate, type Placement, type Vec3 } from "../src/assembly/math";
import { solveWithParts } from "../src/assembly/mates";
import { syncPattern } from "../src/assembly/patterns";
import { instancesForKernel } from "../src/assembly/placed";
import { stepTree } from "../src/assembly/stepTree";
import { ownSymmetry } from "../src/assembly/symmetry";
import { GeometryEngine } from "../src/kernel/engine";
import { importSolids } from "../src/kernel/importer";
import type { PartMesh } from "../src/kernel/protocol";
import type { Assembly, Feature, Instance, Mate, MateConnector } from "../src/model/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

const close = (a: readonly number[], b: readonly number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const at = (x: number, y: number, z: number, rotation: Placement["rotation"] = [0, 0, 0, 1]): Placement => ({ position: [x, y, z], rotation });
const inst = (id: string, partId: string, placement: Placement = IDENTITY, extra: Partial<Instance> = {}): Instance => ({ id, partId, name: id, placement, fixed: false, ...extra });
const face = (p: PartMesh, normal: number[]) => {
  const ref = p.faceRefs.find((r) => r.surface === "PLANE" && r.normal.every((v, k) => Math.abs(v - normal[k]) < 1e-6));
  expect(ref).toBeDefined();
  return { partId: p.id, ref: ref! };
};
const turnOf = (partId: string, params: Record<string, number>): Feature => ({ ...feature("transform", params, "add"), transform: { partId, axis: "z", about: "origin", copy: false } });

/** Each solid in a STEP file: its volume and middle, sorted. */
function solidsOf(step: ArrayBuffer): { volume: number; centre: number[] }[] {
  const solids = importSolids({ fileName: "a.step", format: "step", data: new TextDecoder().decode(step), units: "mm" });
  return solids
    .map((s: Shape3D) => {
      const p = measureShapeVolumeProperties(s);
      const r = { volume: p.volume, centre: [...p.centerOfMass] };
      p.delete();
      s.delete();
      return r;
    })
    .sort((a, b) => Math.round(a.volume - b.volume) || a.centre[0] - b.centre[0] || a.centre[1] - b.centre[1] || a.centre[2] - b.centre[2]);
}
const sameSolids = (a: ReturnType<typeof solidsOf>, b: ReturnType<typeof solidsOf>) => {
  expect(a.length).toBe(b.length);
  a.forEach((s, k) => {
    expect(s.volume).toBeCloseTo(b[k].volume, 3);
    close(s.centre, b[k].centre, 4);
  });
};

const engine = new GeometryEngine();

describe("flexible sub-assemblies on real parts", () => {
  it("open a hinge to meet a mate in the parent, and export it where it is", async () => {
    const leafF = { ...feature("box", { width: 10, depth: 10, height: 1 }), name: "Leaf" };
    const stopF = { ...feature("box", { width: 10, depth: 10, height: 10 }), name: "Stop" };
    const parts = engine.rebuild([leafF, stopF]).parts;
    const [leaf, stop] = [parts.find((p) => p.featureIds.includes(leafF.id))!, parts.find((p) => p.featureIds.includes(stopF.id))!];
    const on = (instanceId: string, mesh: PartMesh, normal: number[], path?: string[]): MateConnector => ({ instanceId, ...(path ? { path } : {}), pick: face(mesh, normal) });
    const hinge: Assembly = {
      id: "H",
      name: "Hinge",
      instances: [inst("a", leaf.id, IDENTITY, { fixed: true }), inst("b", leaf.id, at(10, 0, 0))],
      mates: [{ id: "pin", name: "Hinge 1", type: "revolute", a: on("a", leaf, [1, 0, 0]), b: on("b", leaf, [-1, 0, 0]), flip: false, values: {} } as Mate],
    };
    const top = (flexible: boolean): Assembly => ({
      id: "P",
      name: "Machine",
      instances: [inst("h", "", IDENTITY, { subAssembly: "H", fixed: true, ...(flexible ? { flexible: true } : {}) }), inst("s", stop.id, at(5, -5.5, 0), { fixed: true })],
      mates: [{ id: "touch", name: "Planar 1", type: "planar", a: on("s", stop, [0, 1, 0]), b: on("h", leaf, [0, 0, 1], ["b"]), flip: false, values: {} } as Mate],
    });
    const P = top(true);
    const assemblies = [P, hinge];
    const r = solveWithParts(P, parts, { assemblies });
    expect(r.mateErrors).toEqual({});
    const b = r.inner!["h/b"];
    // b swung up a quarter turn about the hinge line (along X through (10, 5, 0.5)), its top on the stop's side y = 4.5.
    close(rotate(b.rotation, [0, 0, 1]), [0, -1, 0]);
    close(applyPlacement(b, [0, 5, 0.5]), [10, 5, 0.5]);
    // The exports: structured STEP (a product for this flexible copy) and the flat list agree, solid for solid.
    const flat = await engine.exportStep([], {}, instancesForKernel(P, parts, assemblies, r));
    const tree = stepTree(P, parts, r.placements, assemblies, r.inner)!;
    const structured = await engine.exportStep([], {}, undefined, tree);
    const solids = solidsOf(structured.step);
    sameSolids(solids, solidsOf(flat.step));
    expect(solids.filter((s) => Math.abs(s.volume - 100) < 1e-6).length).toBe(2);
    // The swung leaf goes to the engine turned a quarter about X (its middle is on the hinge line, so that stays at (15, 5, 0.5)).
    const swung = instancesForKernel(P, parts, assemblies, r).find((i) => i.id === "h/b")!;
    close(rotate(swung.rotation, [0, 0, 1]), [0, -1, 0]);
    close(applyPlacement({ position: swung.position, rotation: swung.rotation }, [5, 5, 0.5]), [15, 5, 0.5]);
    const inTree = tree.assemblies[tree.assemblies.P.components.find((c) => c.name === "h")!.assembly!].components.find((c) => c.name === "b")!;
    close(rotate(inTree.rotation, [0, 0, 1]), [0, -1, 0]);
    // Rigid (the old way), it can't open: the leaf stays flat beside the other.
    const rigid = top(false);
    const rr = solveWithParts(rigid, parts, { assemblies: [rigid, hinge] });
    expect(rr.mateErrors.touch).toMatch(/Both parts are fixed/);
    close(instancesForKernel(rigid, parts, [rigid, hinge], rr).find((i) => i.id === "h/b")!.rotation, [0, 0, 0, 1]);
  });
});

describe("mirroring a sub-assembly on real parts", () => {
  it("writes the mirror image to STEP as its own product, solid for solid as the flat export", async () => {
    const boxF = { ...feature("box", { width: 10, depth: 20, height: 5, x: 5 }), name: "Bracket" };
    const pinF = { ...feature("cylinder", { diameter: 6, height: 30 }), name: "Pin" };
    const parts = engine.rebuild([boxF, pinF]).parts;
    const [bracket, pin] = [parts.find((p) => p.featureIds.includes(boxF.id))!, parts.find((p) => p.featureIds.includes(pinF.id))!];
    const S: Assembly = { id: "S", name: "Hinge", instances: [inst("s1", bracket.id, IDENTITY, { fixed: true }), inst("s2", pin.id, at(12, 3, 5, quatFromAxisAngle([1, 0, 0], 0.4)))] };
    let n = 0;
    const A = syncPattern(
      { id: "A", name: "Machine", instances: [inst("t", "", at(20, 0, 0, quatFromAxisAngle([0, 0, 1], 0.3)), { subAssembly: "S", fixed: true })] },
      { id: "m", name: "Mirror 1", kind: "mirror", seeds: ["t"], count: 2, amount: "0", axis: "x", centre: [80, 0, 0] },
      () => `c${++n}`,
    );
    const assemblies = [A, S];
    const r = solveWithParts(A, parts, { assemblies });
    const tree = stepTree(A, parts, r.placements, assemblies)!;
    expect(Object.keys(tree.assemblies).sort()).toEqual(["A", "S", "S~mirrored"]);
    const structured = await engine.exportStep([], {}, undefined, tree);
    const text = new TextDecoder().decode(structured.step);
    expect(text).toContain("PRODUCT('Hinge (mirrored)'");
    const solids = solidsOf(structured.step);
    sameSolids(solids, solidsOf((await engine.exportStep([], {}, instancesForKernel(A, parts, assemblies, r))).step));
    // Each solid of the copy is the mirror image (across x = 80) of one of the original's.
    const original = solidsOf((await engine.exportStep([], {}, instancesForKernel({ ...A, instances: [A.instances[0]], patterns: undefined }, parts, assemblies))).step);
    for (const s of original) expect(solids.some((c) => Math.abs(c.volume - s.volume) < 1e-3 && Math.hypot(c.centre[0] - (160 - s.centre[0]), c.centre[1] - s.centre[1], c.centre[2] - s.centre[2]) < 1e-4)).toBe(true);
  });
});

describe("slanted symmetric parts on real parts", () => {
  it("are found symmetric across a slanted plane, and mirrored as themselves", async () => {
    // A 10 × 20 × 30 block, turned about X then Y: no longer symmetric across its own X, Y or Z.
    const blockF = { ...feature("box", { width: 10, depth: 20, height: 30 }), name: "Block" };
    const built = engine.rebuild([blockF, turnOf(blockF.id, { rx: 25, ry: 35 })]);
    expect(built.featureErrors).toEqual({});
    const part = built.parts[0];
    const plane = ownSymmetry(part)!;
    expect(plane).not.toBeNull();
    expect(plane.normal).toBeDefined();
    // Mirrored with "same part": the copy shows the block itself (not its mirror image), filling the mirror image exactly.
    let n = 0;
    const A = syncPattern(
      { id: "A", name: "A", instances: [inst("b", part.id, at(40, 0, 0, quatFromAxisAngle([0, 1, 0], 0.5)), { fixed: true })] },
      { id: "m", name: "Mirror 1", kind: "mirror", seeds: ["b"], count: 2, amount: "0", axis: "x", centre: [100, 0, 0], samePart: true },
      () => `c${++n}`,
      (seed) => !!ownSymmetry(built.parts.find((p) => p.id === seed.partId)!),
    );
    expect(A.instances[1].mirrored).toBeUndefined();
    const r = solveWithParts(A, built.parts, { assemblies: [A] });
    expect(r.patternErrors).toBeUndefined();
    const solids = solidsOf((await engine.exportStep([], {}, instancesForKernel(A, built.parts, [A], r))).step);
    expect(solids.length).toBe(2);
    const [s1, s2] = solids.sort((a, b) => a.centre[0] - b.centre[0]);
    expect(s1.volume).toBeCloseTo(6000, 3);
    close([s2.centre[0], s2.centre[1], s2.centre[2]], [200 - s1.centre[0], s1.centre[1], s1.centre[2]], 4);
    // Its corners too, not just its middle: every face centre of the copy is the mirror image of one of the original's.
    const world = (id: string) => part.faceRefs.map((f) => applyPlacement(r.placements[id], f.center as Vec3));
    const copied = world(A.instances[1].id);
    for (const p of world("b")) expect(copied.some((q) => Math.hypot(q[0] - (200 - p[0]), q[1] - p[1], q[2] - p[2]) < 0.01)).toBe(true);
    // With a tab in one corner (turned the same way): not symmetric at all.
    const tabbed = engine.rebuild([blockF, feature("box", { width: 2, depth: 3, height: 4, x: 10 }, "add"), turnOf(blockF.id, { rx: 25, ry: 35 })]);
    expect(tabbed.featureErrors).toEqual({});
    expect(ownSymmetry(tabbed.parts[0])).toBeNull();
  });
});
