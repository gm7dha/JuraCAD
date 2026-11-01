/**
 * Mirrors in an assembly, further: a whole sub-assembly mirrored (as its
 * mirror image, or as itself when it's symmetric), mirrors across a mate
 * connector you place yourself, and symmetric parts found across slanted
 * planes. Pure logic on hand-made box parts (exact faces).
 */
import { describe, expect, it } from "vitest";

import { billOfMaterials } from "../src/assembly/assembly";
import { applyPlacement, IDENTITY, quatFromAxisAngle, type Placement, type Vec3 } from "../src/assembly/math";
import { connectorFrameFor, solveWithParts } from "../src/assembly/mates";
import { mirrorAcross, parsePattern, placedConnector, syncPattern } from "../src/assembly/patterns";
import { kernelInstances, leavesOf } from "../src/assembly/subassembly";
import { stepTree } from "../src/assembly/stepTree";
import { ownSymmetry, subAssemblySymmetry, SYMMETRY_TOLERANCE } from "../src/assembly/symmetry";
import type { PartMesh } from "../src/kernel/protocol";
import type { Assembly, AssemblyPattern, Instance, MateConnector } from "../src/model/types";
import { boxFace, boxMesh, movedMesh } from "./support/boxMesh";

const close = (a: readonly number[], b: readonly number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const at = (x: number, y: number, z: number, rotation: Placement["rotation"] = [0, 0, 0, 1]): Placement => ({ position: [x, y, z], rotation });
const part = (id: string, partId: string, placement: Placement = IDENTITY, extra: Partial<Instance> = {}): Instance => ({ id, partId, name: id, placement, fixed: false, ...extra });
const copyOf = (id: string, assemblyId: string, placement: Placement = IDENTITY, extra: Partial<Instance> = {}): Instance => ({ id, partId: "", subAssembly: assemblyId, name: id, placement, fixed: false, ...extra });
let n = 0;
const ids = () => `c${++n}`;

const block = boxMesh("block", [0, 0, 0], [10, 10, 10]);
const leaf = boxMesh("leaf", [0, 0, 0], [10, 10, 1]);
const parts = [block, leaf];
const turned = quatFromAxisAngle([0.48, 0.6, 0.64], 0.9);

/** Every face centre of every part an assembly shows, in the world (from what the exports and drawings get). */
function faceCentres(a: Assembly, assemblies: Assembly[], meshes: PartMesh[] = parts): Vec3[] {
  const r = solveWithParts(a, meshes, { assemblies });
  const k = kernelInstances(leavesOf(a, meshes, assemblies, r.inner), meshes, r.placements, () => IDENTITY);
  return k.flatMap((i) => {
    const mesh = meshes.find((m) => m.id === i.partId)!;
    return mesh.faceRefs.map((f) => applyPlacement({ position: i.position, rotation: i.rotation }, i.mirrored ? [-f.center[0], f.center[1], f.center[2]] : f.center));
  });
}
/** Every point has a partner in the other list (to a micron). */
const sameSet = (a: Vec3[], b: Vec3[]) => {
  expect(a.length).toBe(b.length);
  for (const p of a) expect(b.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-6)).toBe(true);
};
const reflectX = (at: number) => (p: Vec3): Vec3 => [2 * at - p[0], p[1], p[2]];

describe("mirroring a whole sub-assembly", () => {
  // S: a block, and a leaf turned at a slant beside it — not symmetric.
  const S: Assembly = { id: "S", name: "Bracket", instances: [part("b", "block", IDENTITY, { fixed: true }), part("l", "leaf", at(15, 2, 3, turned))] };
  const mirror: AssemblyPattern = { id: "m", name: "Mirror 1", kind: "mirror", seeds: ["s"], count: 2, amount: "0", axis: "x", centre: [100, 0, 0] };

  it("makes the copy the sub-assembly's mirror image, point for point, with every part the opposite hand", () => {
    const A0: Assembly = { id: "A", name: "Top", instances: [copyOf("s", "S", at(20, 5, 0, quatFromAxisAngle([0, 0, 1], 0.4)), { fixed: true })] };
    const A = syncPattern(A0, mirror, ids);
    const copy = A.instances.find((i) => i.copyOf)!;
    expect(copy.mirrored).toBe(true);
    expect(copy.subAssembly).toBe("S");
    const assemblies = [A, S];
    const all = faceCentres(A, assemblies);
    const original = faceCentres(A0, [A0, S]);
    const copied = all.filter((p) => !original.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-6));
    sameSet(copied, original.map(reflectX(100)));
    // Each part in the copy is shown as its mirror image.
    const leaves = leavesOf(A, parts, assemblies).filter((l) => l.top === copy.id);
    expect(leaves.map((l) => [l.key, !!l.instance.mirrored])).toEqual([
      [`${copy.id}/b`, true],
      [`${copy.id}/l`, true],
    ]);
    // A mate connector on a part in the copy is where that face is in the mirror image.
    const top: MateConnector = { instanceId: copy.id, path: ["l"], pick: boxFace(leaf, [0, 0, 1]) };
    const f = connectorFrameFor(A, parts, top, assemblies)!;
    const r = solveWithParts(A, parts, { assemblies });
    const seen = applyPlacement(r.placements[copy.id], f.origin);
    const fo = connectorFrameFor(A, parts, { ...top, instanceId: "s" }, assemblies)!;
    close(seen, reflectX(100)(applyPlacement(r.placements.s, fo.origin)));
    // The parts list counts the opposite hands as other parts; structured, the copy is its own line.
    const names = { block: "Block", leaf: "Leaf" };
    expect(billOfMaterials(A, names, {}, undefined, {}, { assemblies }).map((x) => [x.name, x.quantity])).toEqual([
      ["Block", 1],
      ["Leaf", 1],
      ["Block (mirrored)", 1],
      ["Leaf (mirrored)", 1],
    ]);
    expect(billOfMaterials(A, names, {}, undefined, {}, { assemblies, structured: true }).map((x) => [x.item, x.name, x.quantity])).toEqual([
      ["1", "Bracket", 1],
      ["1.1", "Block", 1],
      ["1.2", "Leaf", 1],
      ["2", "Bracket (mirrored)", 1],
      ["2.1", "Block (mirrored)", 1],
      ["2.2", "Leaf (mirrored)", 1],
    ]);
    // STEP: the mirror image is a product of its own, of mirrored parts placed as plain moves and turns.
    const tree = stepTree(A, parts, r.placements, assemblies)!;
    const mirroredKey = tree.assemblies.A.components.find((c) => c.name === copy.name)!.assembly!;
    expect(mirroredKey).toBe("S~mirrored");
    expect(tree.assemblies[mirroredKey].name).toBe("Bracket (mirrored)");
    expect(tree.assemblies[mirroredKey].components.map((c) => c.part)).toEqual(["block~mirrored", "leaf~mirrored"]);
    expect(tree.parts["leaf~mirrored"]).toEqual({ partId: "leaf", name: "leaf (mirrored)", mirrored: true });
  });

  it("finds a symmetric sub-assembly and copies it as itself (the same assembly, turned)", () => {
    // T: two blocks 30 mm apart — symmetric across its own plane x = 20.
    const T: Assembly = { id: "T", name: "Pair", instances: [part("p", "block", IDENTITY, { fixed: true }), part("q", "block", at(30, 0, 0))] };
    expect(subAssemblySymmetry("T", parts, [T])).toEqual({ axis: "x", at: 20 });
    expect(subAssemblySymmetry("S", parts, [S])).toBeNull();
    expect(subAssemblySymmetry("gone", parts, [S])).toBeNull();
    const A0: Assembly = { id: "A", name: "Top", instances: [copyOf("t", "T", at(0, 7, 0, quatFromAxisAngle([0, 0, 1], 0.3)), { fixed: true })] };
    const A = syncPattern(A0, { ...mirror, seeds: ["t"], samePart: true }, ids, (seed) => !!subAssemblySymmetry(seed.subAssembly!, parts, [A0, T]));
    const copy = A.instances.find((i) => i.copyOf)!;
    expect(copy.mirrored).toBeUndefined();
    const assemblies = [A, T];
    const r = solveWithParts(A, parts, { assemblies });
    expect(r.patternErrors).toBeUndefined();
    const original = faceCentres(A0, [A0, T]);
    const copied = faceCentres(A, assemblies).slice(original.length);
    sameSet(copied, original.map(reflectX(100)));
    // The parts list: the same sub-assembly twice.
    expect(billOfMaterials(A, { block: "Block" }, {}, undefined, {}, { assemblies, structured: true }).map((x) => [x.name, x.quantity])).toEqual([
      ["Pair", 2],
      ["Block", 2],
    ]);
  });
});

describe("mirroring across a mate connector you place", () => {
  const base = part("base", "block", IDENTITY, { fixed: true });
  const arm = part("arm", "leaf", at(20, 0, 0));
  const onTop: MateConnector = { instanceId: "base", pick: boxFace(block, [0, 0, 1]) };

  it("moves and tilts the connector along its own axes", () => {
    // On the block's top: (5, 5, 10), Z up, X along the world's X. Up 5, then tilted a quarter about its Y: Z now along X.
    const p = placedConnector({ position: [5, 5, 10], rotation: [0, 0, 0, 1] }, { dz: "5", ry: "90" });
    expect("error" in p).toBe(false);
    const q = p as Placement;
    close(q.position, [5, 5, 15]);
    close(applyPlacement({ position: [0, 0, 0], rotation: q.rotation }, [0, 0, 1]), [1, 0, 0]);
    const bad = placedConnector(IDENTITY, { dx: "nope +" });
    expect("error" in bad ? bad.error : "").toMatch(/^Move X: /);
  });

  it("mirrors across the connector's XY plane, and follows its part", () => {
    const pattern: AssemblyPattern = { id: "m", name: "Mirror 1", kind: "mirror", seeds: ["arm"], count: 2, amount: "0", axis: "x", plane: onTop, placed: { dz: "5", ry: "90" } };
    const A = syncPattern({ id: "A", name: "A", instances: [base, arm] }, pattern, ids);
    const copy = A.instances.find((i) => i.copyOf)!;
    const r = solveWithParts(A, parts, { assemblies: [A] });
    expect(r.patternErrors).toBeUndefined();
    // Across the plane x = 5: the arm at x 20…30 is mirrored to x −20…−10.
    close(applyPlacement(r.placements[copy.id], [-0, 0, 0]), [-10, 0, 0]);
    // Moved with its part: the base moved 3 along X moves the plane to x = 8.
    const moved = { ...A, instances: A.instances.map((i) => (i.id === "base" ? { ...i, placement: at(3, 0, 0) } : i)) };
    close(solveWithParts(moved, parts, { assemblies: [moved] }).placements[copy.id].position, [-4, 0, 0]);
    // On an edge (no flat face needed) and on the origin's planes too.
    const edge: MateConnector = { instanceId: "base", pick: { partId: "block", ref: block.edgeRefs[0] } };
    const onEdge = syncPattern({ id: "A", name: "A", instances: [base, arm] }, { ...pattern, plane: edge, placed: {} }, ids);
    expect(solveWithParts(onEdge, parts, { assemblies: [onEdge] }).patternErrors).toBeUndefined();
    // (Without placing it, an edge isn't a face to mirror across.)
    const plainEdge = { ...onEdge, patterns: onEdge.patterns!.map((x) => ({ ...x, placed: undefined })) };
    expect(solveWithParts(plainEdge, parts, { assemblies: [plainEdge] }).patternErrors?.m).toMatch(/isn't flat/);
    const origin: MateConnector = { instanceId: "@origin", pick: { partId: "@origin", ref: { kind: "face", surface: "PLANE", center: [0, 0, 0], normal: [0, 0, 1] } } };
    const up = syncPattern({ id: "A", name: "A", instances: [base, part("arm", "leaf", at(0, 0, 20))] }, { ...pattern, plane: origin, placed: { dz: "7" } }, ids);
    const ru = solveWithParts(up, parts, { assemblies: [up] });
    // Across z = 7: the arm's bottom at z 20 goes to z −6, and its top (z 21) to −7 (a mirror image, so turned over).
    const c = up.instances.find((i) => i.copyOf)!;
    close(applyPlacement(ru.placements[c.id], [0, 0, 0]), [0, 0, -6]);
    // A typo says which box.
    const bad = { ...up, patterns: up.patterns!.map((x) => ({ ...x, placed: { rx: "1 +" } })) };
    expect(solveWithParts(bad, parts, { assemblies: [bad] }).patternErrors?.m).toMatch(/^Tilt about X: /);
  });

  it("is saved and read back (typed amounts only; only with a connector)", () => {
    const raw = { id: "m", name: "Mirror 1", kind: "mirror", seeds: ["arm"], count: 2, amount: "0", axis: "x", plane: onTop, placed: { dz: "5", ry: 90, junk: "x", dx: "  " } };
    expect(parsePattern(JSON.parse(JSON.stringify(raw)), new Set(["arm"]))!.placed).toEqual({ dz: "5" });
    expect(parsePattern({ ...raw, plane: undefined }, new Set(["arm"]))!.placed).toBeUndefined();
  });
});

describe("symmetric parts across slanted planes", () => {
  // A 10 × 20 × 30 box drawn turned at a slant: symmetric, but not across its own X, Y or Z.
  const slant = movedMesh(boxMesh("slant", [0, 0, 0], [10, 20, 30]), { position: [3, -2, 5], rotation: turned });

  it("finds a plane from the principal directions of its exact faces, to 0.01 mm", () => {
    const plane = ownSymmetry(slant)!;
    expect(plane).not.toBeNull();
    expect(plane.normal).toBeDefined();
    // It really is a symmetry plane: every face centre's mirror image is a face centre.
    const n = plane.normal!;
    for (const f of slant.faceRefs) {
      const d = 2 * (f.center[0] * n[0] + f.center[1] * n[1] + f.center[2] * n[2] - plane.at);
      const m: Vec3 = [f.center[0] - d * n[0], f.center[1] - d * n[1], f.center[2] - d * n[2]];
      expect(slant.faceRefs.some((g) => Math.hypot(g.center[0] - m[0], g.center[1] - m[1], g.center[2] - m[2]) <= SYMMETRY_TOLERANCE)).toBe(true);
    }
    // Upright parts are found across their own X, Y or Z as before (no slanted plane).
    expect(ownSymmetry(boxMesh("upright", [0, 0, 0], [10, 20, 30]))).toEqual({ axis: "x", at: 5 });
    // Spoil it by more than the tolerance (one face moved 0.05 mm): not symmetric.
    const spoilt = { ...slant, faceRefs: slant.faceRefs.map((f, i) => (i === 0 ? { ...f, center: [f.center[0] + 0.05, f.center[1], f.center[2]] as Vec3 } : f)) };
    expect(ownSymmetry(spoilt)).toBeNull();
  });

  it("mirrors it as the same part, turned to fill the mirror image exactly", () => {
    const meshes = [block, slant];
    const A0: Assembly = { id: "A", name: "A", instances: [part("s", "slant", at(40, 0, 0, quatFromAxisAngle([0, 1, 0], 0.5)), { fixed: true })] };
    const A = syncPattern(A0, { id: "m", name: "Mirror 1", kind: "mirror", seeds: ["s"], count: 2, amount: "0", axis: "x", centre: [100, 0, 0], samePart: true }, ids, (seed) => !!ownSymmetry(meshes.find((m) => m.id === seed.partId)!));
    const copy = A.instances.find((i) => i.copyOf)!;
    expect(copy.mirrored).toBeUndefined();
    const r = solveWithParts(A, meshes, { assemblies: [A] });
    expect(r.patternErrors).toBeUndefined();
    const placeOf = (id: string) => r.placements[id];
    const original = slant.faceRefs.map((f) => applyPlacement(placeOf("s"), f.center));
    const copied = slant.faceRefs.map((f) => applyPlacement(placeOf(copy.id), f.center));
    for (const p of original.map(reflectX(100))) expect(copied.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= SYMMETRY_TOLERANCE)).toBe(true);
    // mirrorAcross with a slanted own plane: twice is back where it started.
    const own = ownSymmetry(slant)!;
    const plane = { point: [100, 0, 0] as Vec3, normal: [1, 0, 0] as Vec3 };
    const back = mirrorAcross(plane, mirrorAcross(plane, placeOf("s"), own), own);
    close(back.position, placeOf("s").position);
  });
});
