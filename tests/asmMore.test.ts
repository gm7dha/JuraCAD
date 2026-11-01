/**
 * More assembly tools (pure): mirroring across any plane or a clicked face,
 * symmetric parts mirrored as themselves, exploded view steps for parts inside
 * sub-assemblies, and the STEP structure of an assembly.
 */
import { describe, expect, it } from "vitest";

import { billOfMaterials, parseAssemblies, removeAssembly, removeInstances, updateAssembly } from "../src/assembly/assembly";
import { mateInactive } from "../src/assembly/suppress";
import { emptyDocument } from "../src/model/document";
import { parseExplodeStep, stepPartOffsets, tidyExplodeSteps } from "../src/assembly/explode";
import { applyPlacement, quatFromAxisAngle, type Placement, type Vec3 } from "../src/assembly/math";
import { solveAssembly, type FrameLookup } from "../src/assembly/mates";
import { mirrorAcross, mirrorPlacement, OWN_YZ, syncPattern, type MirrorPlane, type OwnPlane } from "../src/assembly/patterns";
import { stepPartCount, stepTree } from "../src/assembly/stepTree";
import { kernelInstances, leavesOf } from "../src/assembly/subassembly";
import { ownSymmetry } from "../src/assembly/symmetry";
import type { PartMesh } from "../src/kernel/protocol";
import type { Assembly, AssemblyPattern, ExplodeStep, Instance, MateConnector } from "../src/model/types";

const close = (a: readonly number[], b: readonly number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const at = (x: number, y: number, z: number, rotation: Placement["rotation"] = [0, 0, 0, 1]): Placement => ({ position: [x, y, z], rotation });
const inst = (id: string, partId: string, placement: Placement, extra: Partial<Instance> = {}): Instance => ({ id, partId, name: `${id} <1>`, placement, fixed: false, ...extra });
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
/** A point reflected across a plane. */
const reflect = (plane: MirrorPlane, v: Vec3): Vec3 => {
  const n = unit(plane.normal);
  const d = 2 * ((v[0] - plane.point[0]) * n[0] + (v[1] - plane.point[1]) * n[1] + (v[2] - plane.point[2]) * n[2]);
  return [v[0] - d * n[0], v[1] - d * n[1], v[2] - d * n[2]];
};
/** A point of the part's own reflected across one of its own planes. */
const ownReflect = (own: OwnPlane, v: Vec3): Vec3 => {
  const k = own.axis === "x" ? 0 : own.axis === "y" ? 1 : 2;
  const out = [...v] as Vec3;
  out[k] = 2 * own.at - v[k];
  return out;
};
const turned = at(10, 4, -3, quatFromAxisAngle(unit([1, 2, 3]), 0.7));
const LOCALS: Vec3[] = [
  [0, 0, 0],
  [1, 2, 3],
  [-4, 0.5, 9],
];

/** A box's six faces as a display mesh (two triangles each). */
function boxFaces(min: Vec3, max: Vec3, into: { v: number[]; t: number[]; g: PartMesh["faceGroups"]; f: PartMesh["faceRefs"] }) {
  const c = (i: number, j: number, k: number): Vec3 => [i ? max[0] : min[0], j ? max[1] : min[1], k ? max[2] : min[2]];
  const quads: Vec3[][] = [
    [c(0, 0, 0), c(0, 1, 0), c(0, 1, 1), c(0, 0, 1)],
    [c(1, 0, 0), c(1, 0, 1), c(1, 1, 1), c(1, 1, 0)],
    [c(0, 0, 0), c(0, 0, 1), c(1, 0, 1), c(1, 0, 0)],
    [c(0, 1, 0), c(1, 1, 0), c(1, 1, 1), c(0, 1, 1)],
    [c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0)],
    [c(0, 0, 1), c(0, 1, 1), c(1, 1, 1), c(1, 0, 1)],
  ];
  for (const q of quads) {
    const base = into.v.length / 3;
    q.forEach((p) => into.v.push(...p));
    into.g.push({ start: into.t.length, count: 6, faceId: into.g.length });
    into.t.push(base, base + 1, base + 2, base, base + 2, base + 3);
    // The face's exact data, as the engine sends it: its middle and which way it faces (out of the box).
    const centre = [0, 1, 2].map((k) => (q[0][k] + q[2][k]) / 2) as Vec3;
    const u = [0, 1, 2].map((k) => q[1][k] - q[0][k]);
    const w = [0, 1, 2].map((k) => q[3][k] - q[0][k]);
    const n = unit([u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]);
    const mid = [0, 1, 2].map((k) => (min[k] + max[k]) / 2);
    const out = n.reduce((t, v, k) => t + v * (centre[k] - mid[k]), 0) >= 0 ? n : (n.map((v) => -v) as Vec3);
    into.f.push({ kind: "face", surface: "PLANE", center: centre, normal: out.map((v) => v + 0) as Vec3 });
  }
}
function mesh(boxes: [Vec3, Vec3][]): Pick<PartMesh, "vertices" | "triangles" | "faceGroups" | "faceRefs"> {
  const into = { v: [] as number[], t: [] as number[], g: [] as PartMesh["faceGroups"], f: [] as PartMesh["faceRefs"] };
  for (const [a, b] of boxes) boxFaces(a, b, into);
  return { vertices: new Float32Array(into.v), triangles: new Uint32Array(into.t), faceGroups: into.g, faceRefs: into.f };
}

describe("mirroring across any plane", () => {
  it("puts a mirror-image copy point for point across a sloping plane, and back again", () => {
    const plane: MirrorPlane = { point: [5, -2, 1], normal: [1, 1, 0.5] };
    const copy = mirrorAcross(plane, turned);
    for (const local of LOCALS) close(applyPlacement(copy, [-local[0], local[1], local[2]]), reflect(plane, applyPlacement(turned, local)));
    const back = mirrorAcross(plane, copy);
    close(back.position, turned.position);
    close(applyPlacement(back, [1, 2, 3]), applyPlacement(turned, [1, 2, 3]));
    // The assembly's planes are the same thing, square to X, Y or Z.
    close(mirrorPlacement({ axis: "y", centre: [0, 7, 0] }, turned).position, mirrorAcross({ point: [0, 7, 0], normal: [0, 1, 0] }, turned).position);
  });

  it("turns a symmetric part to fill its mirror image (no mirror image needed)", () => {
    const plane: MirrorPlane = { point: [20, 0, 0], normal: [1, 0, 0.2] };
    for (const own of [{ axis: "x", at: 0 }, { axis: "y", at: 3 }, { axis: "z", at: -1.5 }] as OwnPlane[]) {
      const copy = mirrorAcross(plane, turned, own);
      // Every point of the copy (the part itself, not flipped) is the mirror image of a point of the original:
      // the one the part's own symmetry takes it to — so, the part being symmetric, the shapes match exactly.
      for (const local of LOCALS) close(applyPlacement(copy, local), reflect(plane, applyPlacement(turned, ownReflect(own, local))));
      close(mirrorAcross(plane, copy, own).position, turned.position);
    }
    close(mirrorAcross(plane, turned, OWN_YZ).position, mirrorAcross(plane, turned).position);
  });
});

describe("telling whether a part is symmetric", () => {
  it("finds the plane a part is symmetric across, through the middle of its box", () => {
    expect(ownSymmetry(mesh([[[2, 0, 0], [12, 4, 6]]]))).toEqual({ axis: "x", at: 7 });
    // A block with a tab in the middle of one side: not symmetric left to right, but front to back.
    const tab = ownSymmetry(mesh([[[0, 0, 0], [10, 10, 10]], [[10, 3.5, 0], [12, 6.5, 10]]]));
    expect(tab?.axis).toBe("y");
    expect(tab?.at).toBeCloseTo(5, 6);
    // The tab in a corner: not symmetric at all.
    expect(ownSymmetry(mesh([[[0, 0, 0], [10, 10, 10]], [[10, 0, 0], [12, 3, 3]]]))).toBeNull();
    // Tabs on both sides, one 0.05 mm off (or 0.02 mm thicker): not symmetric left to right (only top to bottom).
    expect(ownSymmetry(mesh([[[0, 0, 0], [10, 10, 10]], [[10, 3.5, 0], [12, 6.5, 10]], [[-2, 3.55, 0], [0, 6.55, 10]]]))?.axis).toBe("z");
    expect(ownSymmetry(mesh([[[0, 0, 0], [10, 10, 10]], [[10, 3.5, 0], [12, 6.5, 10]], [[-2.02, 3.5, 0], [0, 6.5, 10]]]))?.axis).toBe("y");
    expect(ownSymmetry(mesh([[[0, 0, 0], [10, 10, 10]], [[10, 3.5, 0], [12, 6.5, 10]], [[-2, 3.5, 0], [0, 6.5, 10]]]))).toEqual({ axis: "x", at: 5 });
  });
});

describe("Mirror in an assembly: faces and symmetric parts", () => {
  const plate = (over: Partial<AssemblyPattern> = {}): AssemblyPattern => ({ id: "mr", name: "Mirror 1", kind: "mirror", seeds: ["arm"], count: 2, amount: "0", axis: "x", ...over });
  let n = 0;
  const ids = () => `c${++n}`;
  // The wall's face: its own frame (origin and the way it faces), on the wall wherever the wall is put.
  const wallFace: MateConnector = { instanceId: "wall", pick: { partId: "p_wall", ref: { kind: "face", surface: "PLANE", center: [0, 0, 0], normal: [1, 0, 0] } } };
  const normal = unit([1, 1, 0]);
  const frames: FrameLookup = (m) => (m.a.instanceId === "wall" ? { origin: [0, 0, 0], z: normal, x: unit([1, -1, 0]), surface: "plane" } : null);
  const base = (wallAt: Placement): Assembly => ({
    id: "a",
    name: "A",
    instances: [inst("wall", "p_wall", wallAt, { fixed: true }), inst("arm", "p_arm", at(5, 0, 0), { fixed: true })],
  });

  it("mirrors across a clicked face, and follows the face when its part moves", () => {
    const made = syncPattern(base(at(10, 0, 0)), plate({ plane: wallFace }), ids);
    const copy = made.instances.find((i) => i.copyOf)!;
    expect(copy.mirrored).toBe(true);
    const solved = solveAssembly(made, frames);
    expect(solved.patternErrors).toBeUndefined();
    const plane = { point: [10, 0, 0] as Vec3, normal };
    for (const local of LOCALS) close(applyPlacement(solved.placements[copy.id], [-local[0], local[1], local[2]]), reflect(plane, applyPlacement(at(5, 0, 0), local)));
    // The wall moved (and turned a quarter turn): the plane goes with it.
    const turnedWall = at(0, 30, 0, quatFromAxisAngle([0, 0, 1], Math.PI / 2));
    const moved = { ...made, instances: made.instances.map((i) => (i.id === "wall" ? { ...i, placement: turnedWall } : i)) };
    const again = solveAssembly(moved, frames).placements[copy.id];
    const plane2 = { point: [0, 30, 0] as Vec3, normal: unit([-1, 1, 0]) };
    close(applyPlacement(again, [-1, 2, 3]), reflect(plane2, applyPlacement(at(5, 0, 0), [1, 2, 3])));
  });

  it("follows a mirror across a face of another mirror's copy in the same solve", () => {
    const a: Assembly = {
      id: "a",
      name: "A",
      instances: [inst("wall", "p_wall", at(10, 0, 0), { fixed: true }), inst("arm", "p_arm", at(5, 0, 0), { fixed: true }), inst("arm2", "p_arm", at(0, 7, 3), { fixed: true })],
    };
    let made = syncPattern(a, plate({ plane: wallFace }), ids);
    const c1 = made.instances.find((i) => i.copyOf?.pattern === "mr")!;
    // The second mirror's face is on the first mirror's copy (whose saved place is out of date: at the origin).
    made = { ...made, instances: made.instances.map((i) => (i.id === c1.id ? { ...i, placement: at(0, 0, 0) } : i)) };
    const onCopy: MateConnector = { ...wallFace, instanceId: c1.id };
    made = syncPattern(made, plate({ id: "mr2", name: "Mirror 2", seeds: ["arm2"], plane: onCopy }), ids);
    const c2 = made.instances.find((i) => i.copyOf?.pattern === "mr2")!;
    const look: FrameLookup = (m) => (m.a.instanceId === "wall" || m.a.instanceId === c1.id ? { origin: [0, 0, 0], z: normal, x: unit([1, -1, 0]), surface: "plane" } : null);
    const solved = solveAssembly(made, look);
    expect(solved.patternErrors).toBeUndefined();
    const first = mirrorAcross({ point: [10, 0, 0], normal }, at(5, 0, 0));
    close(solved.placements[c1.id].position, first.position);
    // The second plane: the face where the first copy really is (not where it was saved).
    const plane2 = { point: first.position, normal: applyPlacement({ position: [0, 0, 0], rotation: first.rotation }, normal) };
    close(solved.placements[c2.id].position, mirrorAcross(plane2, at(0, 7, 3)).position);
  });

  it("refuses a face on a part fastened to the mirror's own copy, without drifting", () => {
    let made = syncPattern(base(at(10, 0, 0)), plate({ plane: wallFace }), ids);
    const copy = made.instances.find((i) => i.copyOf)!;
    // The wall isn't fixed: it's fastened to the copy, so moving the copy moves the face it's mirrored across.
    made = {
      ...made,
      instances: made.instances.map((i) => (i.id === "wall" ? { ...i, fixed: false } : i)),
      mates: [{ id: "fx", name: "Fasten 1", type: "fastened", a: { ...wallFace, instanceId: copy.id }, b: wallFace, flip: false, values: { gap: "5" } }],
    };
    // (The copy's face sits off to the side of the copy's own origin, as faces usually do.)
    const frames = (zc: number, zw: number): FrameLookup => (m, side) =>
      m[side].instanceId === "wall" ? { origin: [0, 0, 0], z: [zw, 0, 0], x: [0, 1, 0], surface: "plane" } : m[side].instanceId === copy.id ? { origin: [3, 1, 0], z: [zc, 0, 0], x: [0, 1, 0], surface: "plane" } : null;
    // Some such arrangements do settle (the copy is the mirror image across the wall, and the wall is fastened to the copy): fine.
    const settles = solveAssembly(made, (m, side) =>
      m[side].instanceId === "wall" ? { origin: [0, 0, 0], z: normal, x: unit([1, -1, 0]), surface: "plane" } : m[side].instanceId === copy.id ? { origin: [3, 1, 0], z: [1, 0, 0], x: [0, 1, 0], surface: "plane" } : null,
    );
    expect(settles.patternErrors).toBeUndefined();
    // The arm (at x 5) and its copy are mirror images across the wall's face, where the wall ended up.
    close(settles.placements[copy.id].position, mirrorAcross({ point: settles.placements.wall.position, normal: applyPlacement({ position: [0, 0, 0], rotation: settles.placements.wall.rotation }, normal) }, at(5, 0, 0)).position);
    // Others chase each other for ever: the copies are held where they are, with a plain reason.
    const look = frames(-1, -1);
    const once = solveAssembly(made, look);
    expect(once.patternErrors?.mr).toMatch(/depends on the mirror's own copies/);
    // Stored and solved again (as the app does after each change): nothing moves.
    const settled = { ...made, instances: made.instances.map((i) => ({ ...i, placement: once.placements[i.id] ?? i.placement })) };
    const twice = solveAssembly(settled, look);
    for (const id of ["wall", copy.id]) close(twice.placements[id].position, once.placements[id].position);
  });

  it("says plainly when the face can't be used", () => {
    const made = syncPattern(base(at(10, 0, 0)), plate({ plane: wallFace }), ids);
    const gone = { ...made, instances: made.instances.filter((i) => i.id !== "wall") };
    expect(solveAssembly(gone, frames).patternErrors?.mr).toMatch(/removed/);
    expect(solveAssembly(made, () => null).patternErrors?.mr).toMatch(/can't be found/);
    const own = { ...made, patterns: [{ ...made.patterns![0], plane: { ...wallFace, instanceId: made.instances.find((i) => i.copyOf)!.id } }] };
    expect(solveAssembly(own, frames).patternErrors?.mr).toMatch(/its own copies/);
    // An assembly plane, as before: no face needed.
    expect(solveAssembly(syncPattern(base(at(10, 0, 0)), plate({ centre: [20, 0, 0] }), ids), () => null).patternErrors).toBeUndefined();
  });

  it("copies a symmetric part as itself (one part in the parts list), others as mirror images", () => {
    const a: Assembly = { ...base(at(10, 0, 0)), instances: [...base(at(10, 0, 0)).instances, inst("hook", "p_hook", at(0, 5, 0), { fixed: true })] };
    const symmetric = (i: Instance) => i.partId === "p_arm";
    const made = syncPattern(a, plate({ seeds: ["arm", "hook"], centre: [20, 0, 0], samePart: true }), ids, symmetric);
    const armCopy = made.instances.find((i) => i.copyOf?.seed === "arm")!;
    const hookCopy = made.instances.find((i) => i.copyOf?.seed === "hook")!;
    expect(armCopy.mirrored).toBeUndefined();
    expect(hookCopy.mirrored).toBe(true);
    const bom = billOfMaterials(made, { p_wall: "Wall", p_arm: "Arm", p_hook: "Hook" });
    expect(bom.map((r) => [r.name, r.quantity])).toEqual([
      ["Wall", 1],
      ["Arm", 2],
      ["Hook", 1],
      ["Hook (mirrored)", 1],
    ]);
    // The arm is symmetric across its own Y plane at 2 mm: its copy is turned so its shape lands on the mirror image.
    const own: OwnPlane = { axis: "y", at: 2 };
    const solved = solveAssembly(made, () => null, { symmetry: (i) => (i.partId === "p_arm" ? own : null) });
    expect(solved.patternErrors).toBeUndefined();
    const plane = { point: [20, 0, 0] as Vec3, normal: [1, 0, 0] as Vec3 };
    for (const local of LOCALS) close(applyPlacement(solved.placements[armCopy.id], local), reflect(plane, applyPlacement(at(5, 0, 0), ownReflect(own, local))));
    // If the part stops being symmetric, the copy can't be a true mirror image: say so, and how to fix it.
    expect(solveAssembly(made, () => null).patternErrors?.mr).toMatch(/isn't symmetric.*Untick/);
    // Saved and read back; turning it off gives a mirror image again.
    const back = parseAssemblies(JSON.parse(JSON.stringify([made])))[0];
    expect(back.patterns?.[0].samePart).toBe(true);
    const off = syncPattern(made, { ...made.patterns![0], samePart: undefined }, ids, symmetric);
    expect(off.instances.find((i) => i.copyOf?.seed === "arm")?.mirrored).toBe(true);
  });

  it("reads a mirror across a face back from a file (and older mirrors unchanged)", () => {
    const made = syncPattern(base(at(10, 0, 0)), plate({ plane: { ...wallFace, path: ["inner"] } }), ids);
    const back = parseAssemblies(JSON.parse(JSON.stringify([made])))[0];
    expect(back.patterns?.[0].plane).toEqual({ ...wallFace, path: ["inner"] });
    const old = parseAssemblies(JSON.parse(JSON.stringify([syncPattern(base(at(10, 0, 0)), plate({ centre: [20, 0, 0] }), ids)])))[0];
    expect(old.patterns?.[0]).toEqual(plate({ centre: [20, 0, 0] }));
  });
});

describe("exploded view steps for parts inside sub-assemblies", () => {
  const S: Assembly = { id: "S", name: "Hinge", instances: [inst("leaf", "p_leaf", at(0, 0, 0), { fixed: true }), inst("pin", "p_pin", at(0, 0, 5), { fixed: true })] };
  const A: Assembly = {
    id: "A",
    name: "Top",
    instances: [inst("base", "p_base", at(0, 0, 0), { fixed: true }), inst("h1", "", at(100, 0, 0), { subAssembly: "S", fixed: true }), inst("h2", "", at(200, 0, 0), { subAssembly: "S", fixed: true })],
  };
  const step = (over: Partial<ExplodeStep>): ExplodeStep => ({ id: "x", instances: [], axis: "z", distance: "30", ...over });
  const parts = ["p_base", "p_leaf", "p_pin"].map((id) => ({ id, name: id }) as PartMesh);

  it("moves just the chosen part of one copy, on top of where its sub-assembly is", () => {
    const steps = [step({ id: "1", parts: [{ instanceId: "h1", path: ["pin"] }] }), step({ id: "2", axis: "x", flip: true, distance: "4", instances: ["h1"], parts: [{ instanceId: "h1", path: ["pin"] }] })];
    expect(stepPartOffsets(steps)).toEqual({ "h1/pin": [-4, 0, 30] });
    const tops = { base: at(0, 0, 0), h1: at(100, 0, 0), h2: at(200, 0, 0) };
    const placed = kernelInstances(leavesOf(A, parts, [A, S]), parts, tops, () => at(0, 0, 0), stepPartOffsets(steps));
    const where = Object.fromEntries(placed.map((i) => [i.id, i.position]));
    close(where["h1/pin"], [96, 0, 35]);
    // The other copy's pin, the leaves and the plain part stay where they are.
    close(where["h2/pin"], [200, 0, 5]);
    close(where["h1/leaf"], [100, 0, 0]);
    close(where.base, [0, 0, 0]);
  });

  it("is saved, read back, and tidied when the sub-assembly goes (older steps unchanged)", () => {
    const s = step({ parts: [{ instanceId: "h1", path: ["pin"] }, { instanceId: "h1", path: ["pin"] }, { instanceId: "", path: ["x"] }] as ExplodeStep["parts"] });
    expect(parseExplodeStep(JSON.parse(JSON.stringify(s)))).toEqual(step({ parts: [{ instanceId: "h1", path: ["pin"] }] }));
    expect(parseExplodeStep({ id: "o", instances: ["base"], axis: "x", distance: "5" })).toEqual({ id: "o", instances: ["base"], axis: "x", distance: "5" });
    expect(parseExplodeStep({ id: "e", instances: [], axis: "x", distance: "5" })).toBeNull();
    const withSteps: Assembly = { ...A, explodeSteps: [step({ id: "1", parts: [{ instanceId: "h1", path: ["pin"] }] }), step({ id: "2", instances: ["base"], parts: [{ instanceId: "h1", path: ["leaf"] }] })] };
    const without = tidyExplodeSteps({ ...withSteps, instances: withSteps.instances.filter((i) => i.id !== "h1") });
    expect(without.explodeSteps).toEqual([step({ id: "2", instances: ["base"] })]);
    expect(tidyExplodeSteps(withSteps).explodeSteps).toEqual(withSteps.explodeSteps);
  });
});

describe("keeping inner explode steps and Width mates tidy", () => {
  const face = { partId: "p", ref: { kind: "face" as const, surface: "PLANE", center: [0, 0, 0] as Vec3, normal: [1, 0, 0] as Vec3 } };
  // Top ⊃ Mid (two copies) ⊃ Hinge ⊃ leaf, pin.
  const H: Assembly = { id: "H", name: "Hinge", instances: [inst("leaf", "p_leaf", at(0, 0, 0), { fixed: true }), inst("pin", "p_pin", at(0, 0, 5))] };
  const M: Assembly = { id: "M", name: "Mid", instances: [inst("h", "", at(0, 0, 0), { subAssembly: "H", fixed: true })] };
  const T: Assembly = {
    id: "T",
    name: "Top",
    instances: [inst("m1", "", at(0, 0, 0), { subAssembly: "M", fixed: true }), inst("m2", "", at(50, 0, 0), { subAssembly: "M", fixed: true })],
    explodeSteps: [
      { id: "1", instances: [], axis: "z", distance: "10", parts: [{ instanceId: "m1", path: ["h", "pin"] }] },
      { id: "2", instances: ["m2"], axis: "x", distance: "10", parts: [{ instanceId: "m2", path: ["h", "leaf"] }] },
    ],
  };
  const doc = (...assemblies: Assembly[]) => ({ ...emptyDocument(), assemblies });

  it("drops steps' parts whose way down (two levels deep) no longer leads to a part", () => {
    // The pin taken out of the hinge: the first step goes (it moved nothing else); the second keeps its leaf.
    const noPin = removeInstances(doc(T, M, H), "H", ["pin"]);
    expect(noPin.assemblies!.find((a) => a.id === "T")!.explodeSteps!.map((s) => [s.id, s.parts?.map((p) => p.path.join("/"))])).toEqual([["2", ["h/leaf"]]]);
    // The hinge deleted altogether: only the step's own sub-assembly move is left.
    const noHinge = removeAssembly(doc(T, M, H), "H");
    expect(noHinge.assemblies!.find((a) => a.id === "T")!.explodeSteps).toEqual([{ id: "2", instances: ["m2"], axis: "x", distance: "10" }]);
    // A suppressed part is kept (it comes back when unsuppressed); an unrelated change leaves the steps as they are.
    const quiet = updateAssembly(doc(T, M, H), "H", (a) => ({ ...a, instances: a.instances.map((i) => (i.id === "pin" ? { ...i, suppressed: true } : i)) }));
    expect(quiet.assemblies!.find((a) => a.id === "T")).toBe(T);
  });

  it("says a Width mate isn't used while the part with its slot's second face is suppressed", () => {
    const S: Assembly = { id: "S", name: "Slot", instances: [inst("left", "p", at(0, 0, 0), { fixed: true, name: "Plate <1>" }), inst("right", "p", at(15, 0, 0), { fixed: true, name: "Plate <2>", suppressed: true })] };
    const A: Assembly = { id: "A", name: "A", instances: [inst("s1", "", at(0, 0, 0), { subAssembly: "S", fixed: true, name: "Slot <1>" }), inst("k", "key", at(0, 0, 0))] };
    const m = { id: "w", name: "Width 1", type: "width" as const, a: { instanceId: "s1", path: ["left"], pick: face, pick2: face, path2: ["right"] }, b: { instanceId: "k", pick: face, pick2: face }, flip: false, values: {} };
    expect(mateInactive(A, m, [A, S])).toBe("Not used while Plate <2> inside Slot <1> is suppressed");
  });
});

describe("an assembly's STEP structure", () => {
  const parts = ["p_box", "p_pin", "p_other"].map((id) => ({ id, name: id.slice(2).toUpperCase() }) as PartMesh);
  const S: Assembly = { id: "S", name: "Hinge", instances: [inst("leaf", "p_box", at(0, 0, 0), { fixed: true }), inst("pin", "p_pin", at(0, 0, 5), { fixed: true })] };
  const E: Assembly = { id: "E", name: "Empty", instances: [inst("gone", "p_missing", at(0, 0, 0))] };
  const A: Assembly = {
    id: "A",
    name: "Top",
    instances: [
      inst("b1", "p_box", at(1, 0, 0), { fixed: true }),
      inst("b2", "p_box", at(2, 0, 0), { mirrored: true }),
      inst("h1", "", at(100, 0, 0), { subAssembly: "S" }),
      inst("h2", "", at(200, 0, 0), { subAssembly: "S" }),
      inst("e1", "", at(0, 0, 0), { subAssembly: "E" }),
      inst("off", "p_other", at(0, 0, 0), { suppressed: true }),
    ],
  };

  it("lists each part once, each sub-assembly once, and every copy with its name and place", () => {
    const tree = stepTree(A, parts, { b1: at(1, 1, 1) }, [A, S, E])!;
    expect(tree.root).toBe("A");
    expect(tree.parts).toEqual({ p_box: { partId: "p_box", name: "BOX" }, "p_box~mirrored": { partId: "p_box", name: "BOX (mirrored)", mirrored: true }, p_pin: { partId: "p_pin", name: "PIN" } });
    expect(tree.assemblies.A.components.map((c) => [c.name, c.part ?? c.assembly, c.position[0]])).toEqual([
      ["b1 <1>", "p_box", 1],
      ["b2 <1>", "p_box~mirrored", 2],
      ["h1 <1>", "S", 100],
      ["h2 <1>", "S", 200],
    ]);
    expect(tree.assemblies.S.components.map((c) => [c.name, c.part, c.position[2]])).toEqual([
      ["leaf <1>", "p_box", 0],
      ["pin <1>", "p_pin", 5],
    ]);
    // The empty sub-assembly (its part isn't built) and the suppressed part are left out.
    expect(tree.assemblies.E.components).toEqual([]);
    expect(stepPartCount(tree)).toBe(6);
    expect(stepTree({ ...A, instances: [A.instances[4]] }, parts, {}, [A, S, E])).toBeNull();
  });
});
