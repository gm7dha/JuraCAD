/**
 * Flexible sub-assemblies (Onshape's "Make flexible"): the copy's own parts and
 * mates are solved with the parent's, so a mate in the parent can move a part
 * inside it. Pure logic on hand-made box parts (exact faces), so every place
 * is checked exactly.
 */
import { describe, expect, it } from "vitest";

import { billOfMaterials, parseAssemblies } from "../src/assembly/assembly";
import { expandFlexible, isFlexible, setFlexible } from "../src/assembly/flexible";
import { applyPlacement, compose, IDENTITY, quatFromAxisAngle, rotate, type Placement, type Vec3 } from "../src/assembly/math";
import { connectorFrameFor, frameLookup, solveAssembly, solvedInside, solveWithParts } from "../src/assembly/mates";
import { kernelInstances, leavesOf } from "../src/assembly/subassembly";
import { stepTree } from "../src/assembly/stepTree";
import type { Assembly, Instance, Mate, MateConnector, MateType } from "../src/model/types";
import { boxFace, boxMesh } from "./support/boxMesh";

const close = (a: readonly number[], b: readonly number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const at = (x: number, y: number, z: number, rotation: Placement["rotation"] = [0, 0, 0, 1]): Placement => ({ position: [x, y, z], rotation });
const part = (id: string, partId: string, placement: Placement = IDENTITY, extra: Partial<Instance> = {}): Instance => ({ id, partId, name: id, placement, fixed: false, ...extra });
const copyOf = (id: string, assemblyId: string, placement: Placement = IDENTITY, extra: Partial<Instance> = {}): Instance => ({ id, partId: "", subAssembly: assemblyId, name: id, placement, fixed: false, ...extra });
const mate = (id: string, type: MateType, a: MateConnector, b: MateConnector, values: Record<string, string> = {}): Mate => ({ id, name: id, type, a, b, flip: false, values });

// A leaf: a 10 × 10 × 1 plate. A block: a 10 mm cube.
const leaf = boxMesh("leaf", [0, 0, 0], [10, 10, 1]);
const block = boxMesh("block", [0, 0, 0], [10, 10, 10]);
const parts = [leaf, block];
const X: Vec3 = [1, 0, 0];
const on = (instanceId: string, normal: Vec3, path?: string[], mesh = leaf): MateConnector => ({ instanceId, ...(path ? { path } : {}), pick: boxFace(mesh, normal as [number, number, number]) });

/**
 * H, a hinge: leaf `a` fixed, leaf `b` hinged to a's +X side (its −X side on it), so b turns about the
 * line along X through (10, 5, 0.5).
 */
const hinge: Assembly = {
  id: "H",
  name: "Hinge",
  instances: [part("a", "leaf", IDENTITY, { fixed: true }), part("b", "leaf", at(10, 0, 0))],
  mates: [mate("pin", "revolute", on("a", X), on("b", [-1, 0, 0]))],
};

/** Where a point of an instance's part ends up in the world. */
const worldOf = (placements: Record<string, Placement>, top: string, rel: Placement | undefined, local: Vec3): Vec3 => applyPlacement(rel ? compose(placements[top], rel) : placements[top], local);

/**
 * P: H (fixed), and a stop: a block turned so its −Y face is the plane y = 4.5, facing −Y… placed so b's top
 * (+Z) face must lie on it. With H flexible, b swings up a quarter turn to meet it.
 */
const stop = (flexible: boolean, hingeFixed = true): Assembly => ({
  id: "P",
  name: "Top",
  instances: [copyOf("h", "H", IDENTITY, { fixed: hingeFixed, ...(flexible ? { flexible: true } : {}) }), part("s", "block", at(5, -5.5, 0), { fixed: true })],
  mates: [mate("touch", "planar", on("s", [0, 1, 0], undefined, block), on("h", [0, 0, 1], ["b"]))],
});

describe("flexible sub-assemblies", () => {
  const all = [hinge];
  const rigidHinge = solvedInside(hinge, parts, [hinge]);

  it("solve the parent's mate by moving a part inside the copy (a hinge opens)", () => {
    // The hinge on its own: b lies flat beside a.
    close(rigidHinge.b.position, [10, 0, 0]);
    close(rigidHinge.b.rotation, [0, 0, 0, 1]);
    const P = stop(true);
    const r = solveWithParts(P, parts, { assemblies: [P, ...all] });
    expect(r.mateErrors).toEqual({});
    expect(r.flexErrors).toBeUndefined();
    // The copy stays fixed where it is; a stays put inside it; b's top face now faces −Y, on the plane y = 4.5.
    expect(r.placements.h).toEqual(IDENTITY);
    close(r.inner!["h/a"].position, [0, 0, 0]);
    close(r.inner!["h/a"].rotation, [0, 0, 0, 1]);
    const b = r.inner!["h/b"];
    close(rotate(b.rotation, [0, 0, 1]), [0, -1, 0]);
    // Its hinge side still sits on a's +X side (the hinge line through (10, 5, 0.5) doesn't move).
    close(applyPlacement(b, [0, 5, 0.5]), [10, 5, 0.5]);
    // Every point of b's top face is on the stop's face.
    for (const p of [[0, 0, 1], [10, 0, 1], [10, 10, 1], [0, 10, 1]] as Vec3[]) expect(applyPlacement(b, p)[1]).toBeCloseTo(4.5, 6);
    // The parts in the 3D view, exports and drawings are where the solve put them.
    const leaves = leavesOf(P, parts, [P, ...all], r.inner);
    const k = kernelInstances(leaves, parts, r.placements, () => IDENTITY);
    close(applyPlacement({ position: k.find((i) => i.id === "h/b")!.position, rotation: k.find((i) => i.id === "h/b")!.rotation }, [5, 5, 1]), applyPlacement(b, [5, 5, 1]));
    // Without a solve passed in, the parts are where the assembly's own solve puts them — the same.
    const own = leavesOf(P, parts, [P, ...all]).find((l) => l.key === "h/b")!;
    close(own.relative.position, b.position);
    close(own.relative.rotation, b.rotation);
    // And the hinge's own tab is unchanged: rigid there, b where its own mate put it.
    expect(solvedInside(hinge, parts, [hinge]).b).toEqual(rigidHinge.b);
  });

  it("stay one rigid piece unless made flexible (old files solve exactly as before)", () => {
    const P = stop(false);
    const assemblies = [P, ...all];
    const r = solveWithParts(P, parts, { assemblies });
    // Exactly what the plain solver gives, with nothing extra.
    const plain = solveAssembly(P, frameLookup(P, parts, assemblies), {});
    expect(r.placements).toEqual(plain.placements);
    expect(r.inner).toBeUndefined();
    // Rigid, b can't swing: both the copy and the stop are fixed, so the mate can't be met.
    expect(r.mateErrors.touch).toMatch(/Both parts are fixed/);
    expect(leavesOf(P, parts, assemblies).find((l) => l.key === "h/b")!.relative).toEqual(rigidHinge.b);
    // Its flag: only on sub-assemblies, saved and read back; off again leaves no trace.
    const flex = setFlexible(P, "h", true);
    expect(isFlexible(flex.instances[0])).toBe(true);
    expect(setFlexible(flex, "s", true).instances[1]).toEqual(P.instances[1]);
    expect(setFlexible(flex, "h", false)).toEqual(P);
    const back = parseAssemblies(JSON.parse(JSON.stringify([flex, hinge])));
    expect(back[0].instances[0].flexible).toBe(true);
    const junk = parseAssemblies(JSON.parse(JSON.stringify([{ ...P, instances: [P.instances[0], { ...P.instances[1], flexible: true }] }, hinge])));
    expect(junk[0].instances.find((i) => i.id === "s")!.flexible).toBeUndefined();
    // A mirrored copy is never flexible.
    expect(isFlexible({ ...flex.instances[0], mirrored: true })).toBe(false);
  });

  it("move as a whole when the copy itself is mated, its parts following", () => {
    // The copy not fixed: a block fixed at the origin, a's bottom fastened on its top. Nothing else holds b.
    const P: Assembly = {
      id: "P",
      name: "Top",
      instances: [part("base", "block", IDENTITY, { fixed: true }), copyOf("h", "H", at(50, 0, 0), { flexible: true })],
      mates: [mate("sit", "fastened", on("base", [0, 0, 1], undefined, block), on("h", [0, 0, -1], ["a"]))],
    };
    const r = solveWithParts(P, parts, { assemblies: [P, hinge] });
    expect(r.mateErrors).toEqual({});
    // a's bottom centre (5, 5, 0) is on the block's top centre (5, 5, 10), turned over (face to face).
    const aWorld = compose(r.placements.h, r.inner!["h/a"]);
    close(applyPlacement(aWorld, [5, 5, 0]), [5, 5, 10]);
    // b is where its hinge puts it relative to a — exactly as in the rigid sub-assembly.
    const bWorld = compose(r.placements.h, r.inner!["h/b"]);
    const expected = compose(aWorld, rigidHinge.b);
    close(bWorld.position, expected.position);
    close(applyPlacement(bWorld, [3, 7, 1]), applyPlacement(expected, [3, 7, 1]));
    // And a is held to the copy's frame, as inside it (fixed there).
    close(r.inner!["h/a"].position, [0, 0, 0]);
  });

  it("keep an unmated part where it sits inside the copy when the copy moves", () => {
    const loose: Assembly = { ...hinge, id: "L", instances: [...hinge.instances, part("c", "block", at(0, 30, 0))] };
    const P: Assembly = {
      id: "P",
      name: "Top",
      instances: [part("base", "block", IDENTITY, { fixed: true }), copyOf("l", "L", at(0, 0, 100), { flexible: true })],
      mates: [mate("sit", "fastened", on("base", [0, 0, 1], undefined, block), on("l", [0, 0, -1], ["a"]))],
    };
    const r = solveWithParts(P, parts, { assemblies: [P, loose] });
    expect(r.mateErrors).toEqual({});
    close(r.inner!["l/c"].position, [0, 30, 0]);
    close(r.inner!["l/c"].rotation, [0, 0, 0, 1]);
  });

  it("say when a fixed part inside is pulled somewhere else", () => {
    // Two fixed leaves inside; the parent fastens the second one to a stop elsewhere, while the copy is fixed.
    const two: Assembly = { id: "T", name: "Pair", instances: [part("a", "leaf", IDENTITY, { fixed: true }), part("a2", "leaf", at(0, 20, 0), { fixed: true })] };
    const P: Assembly = {
      id: "P",
      name: "Top",
      instances: [copyOf("t", "T", IDENTITY, { fixed: true, flexible: true }), part("s", "block", at(0, 0, 50), { fixed: true })],
      mates: [mate("pull", "fastened", on("s", [0, 0, 1], undefined, block), on("t", [0, 0, -1], ["a2"]))],
    };
    const r = solveWithParts(P, parts, { assemblies: [P, two] });
    expect(r.mateErrors.pull).toBe("Both parts are fixed, so this mate can't move either of them. Unfix one.");
    // Fixed parts don't move inside the copy.
    close(r.inner!["t/a2"].position, [0, 20, 0]);
    // Not fixed in the parent: the copy itself moves to meet the mate, both leaves with it.
    const free = { ...P, instances: [{ ...P.instances[0], fixed: false }, P.instances[1]] };
    const f = solveWithParts(free, parts, { assemblies: [free, two] });
    expect(f.mateErrors).toEqual({});
    expect(f.flexErrors).toBeUndefined();
    close(f.inner!["t/a2"].position, [0, 20, 0]);
    close(applyPlacement(compose(f.placements.t, f.inner!["t/a2"]), [5, 5, 0]), [5, 5, 60]);
  });

  it("work two levels deep: a flexible hinge inside a flexible sub-assembly", () => {
    // O holds the hinge (flexible inside O, fixed there); P holds O (flexible) and the stop.
    const O: Assembly = { id: "O", name: "Outer", instances: [copyOf("h", "H", at(0, 0, 0), { fixed: true, flexible: true })] };
    const P: Assembly = {
      id: "P",
      name: "Top",
      instances: [copyOf("o", "O", IDENTITY, { fixed: true, flexible: true }), part("s", "block", at(5, -5.5, 0), { fixed: true })],
      mates: [mate("touch", "planar", on("s", [0, 1, 0], undefined, block), on("o", [0, 0, 1], ["h", "b"]))],
    };
    const assemblies = [P, O, hinge];
    const r = solveWithParts(P, parts, { assemblies });
    expect(r.mateErrors).toEqual({});
    const b = r.inner!["o/h/b"];
    close(rotate(b.rotation, [0, 0, 1]), [0, -1, 0]);
    close(applyPlacement(b, [0, 5, 0.5]), [10, 5, 0.5]);
    // The leaves, the connectors on them and the STEP structure all see b swung up.
    const leaves = leavesOf(P, parts, assemblies, r.inner);
    close(leaves.find((l) => l.key === "o/h/b")!.relative.position, b.position);
    const f = connectorFrameFor(P, parts, on("o", [0, 0, 1], ["h", "b"]), assemblies)!;
    close(f.z, [0, -1, 0]);
    close([f.origin[1]], [4.5]);
    const tree = stepTree(P, parts, r.placements, assemblies, r.inner)!;
    const outer = tree.assemblies[tree.assemblies.P.components.find((c) => c.name === "o")!.assembly!];
    const inner = tree.assemblies[outer.components[0].assembly!];
    const bc = inner.components.find((c) => c.name === "b")!;
    close(rotate(bc.rotation, [0, 0, 1]), [0, -1, 0]);
    // The parts list doesn't change: the same parts, however they're turned.
    expect(billOfMaterials(P, { leaf: "Leaf", block: "Block" }, {}, undefined, {}, { assemblies }).map((x) => [x.name, x.quantity])).toEqual([
      ["Leaf", 2],
      ["Block", 1],
    ]);
  });

  it("solve a flexible copy inside a rigid sub-assembly in that sub-assembly's own solve", () => {
    // O (rigid in P) holds the flexible hinge and the stop: O's own solve opens it, and every copy of O shows it open.
    const O: Assembly = { ...stop(true), id: "O", name: "Outer" };
    const P: Assembly = { id: "P", name: "Top", instances: [copyOf("o1", "O", at(0, 0, 100), { fixed: true }), copyOf("o2", "O", at(0, 0, 200))] };
    const assemblies = [P, O, hinge];
    const inside = solvedInside(O, parts, assemblies);
    close(rotate(inside["h/b"].rotation, [0, 0, 1]), [0, -1, 0]);
    const r = solveWithParts(P, parts, { assemblies });
    expect(r.inner).toBeUndefined();
    for (const top of ["o1", "o2"]) {
      const l = leavesOf(P, parts, assemblies).find((x) => x.key === `${top}/h/b`)!;
      close(l.relative.position, inside["h/b"].position);
      close(l.relative.rotation, inside["h/b"].rotation);
    }
    // A connector on b, seen from P: on b as it sits open in O.
    const f = connectorFrameFor(P, parts, on("o1", [0, 0, 1], ["h", "b"]), assemblies)!;
    close(f.z, [0, -1, 0]);
    close([f.origin[1]], [4.5]);
  });

  it("carry the copy's own patterns and origin mates along, in its own directions", () => {
    // Inside G: a leaf held to G's origin (Top plane), and a row of 3 copies of it 20 mm apart along G's X.
    const origin: MateConnector = { instanceId: "@origin", pick: { partId: "@origin", ref: { kind: "face", surface: "PLANE", center: [0, 0, 0], normal: [0, 0, 1] } } };
    const G: Assembly = {
      id: "G",
      name: "Row",
      instances: [part("p", "leaf", at(3, 3, 3)), part("p2", "leaf", at(20, 0, 0), { copyOf: { pattern: "row", seed: "p", index: 1 } }), part("p3", "leaf", at(40, 0, 0), { copyOf: { pattern: "row", seed: "p", index: 2 } })],
      mates: [mate("down", "fastened", origin, on("p", [0, 0, -1]), {})],
      patterns: [{ id: "row", name: "Row", kind: "linear", seeds: ["p"], count: 3, amount: "20", axis: "x" }],
    };
    const own = solvedInside(G, parts, [G]);
    // The copy is turned a quarter about Z, so G's X is the world's Y.
    const quarter = at(100, 0, 0, quatFromAxisAngle([0, 0, 1], Math.PI / 2));
    const P: Assembly = { id: "P", name: "Top", instances: [copyOf("g", "G", quarter, { fixed: true, flexible: true })] };
    const r = solveWithParts(P, parts, { assemblies: [P, G] });
    expect(r.mateErrors).toEqual({});
    expect(r.patternErrors).toBeUndefined();
    expect(r.flexErrors).toBeUndefined();
    for (const id of ["p", "p2", "p3"]) {
      close(r.inner![`g/${id}`].position, own[id].position);
      close(r.inner![`g/${id}`].rotation, own[id].rotation);
    }
    close(worldOf(r.placements, "g", r.inner!["g/p3"], [0, 0, 0]), applyPlacement(quarter, own.p3.position));
  });

  it("refuse a Width mate whose two faces are on parts of the copy that can move apart", () => {
    const P = stop(true);
    const width = mate("w", "width", { ...on("s", [0, 1, 0], undefined, block), pick2: boxFace(block, [0, -1, 0]) }, { ...on("h", [0, 0, 1], ["a"]), pick2: boxFace(leaf, [0, 0, -1]), path2: ["b"] });
    const Q: Assembly = { ...P, mates: [width] };
    const r = solveWithParts(Q, parts, { assemblies: [Q, hinge] });
    expect(r.mateErrors.w).toMatch(/can move apart \(it's flexible\)\. Pick both faces on one part, or untick Flexible/);
  });

  it("flatten an assembly's flexible copies for the solver, with every id prefixed", () => {
    const P = stop(true);
    const view = expandFlexible(P, [P, hinge], (sub) => solvedInside(sub, parts, [P, hinge]));
    expect(view.assembly.instances.map((i) => [i.id, i.fixed])).toEqual([
      ["h", true],
      ["h/a", false],
      ["h/b", false],
      ["s", true],
    ]);
    expect(view.bodies["h/a"]).toMatchObject({ frame: "h", fixed: true, top: "h" });
    expect(view.bodies["h/b"]).toMatchObject({ frame: "h", fixed: false, top: "h" });
    expect(view.assembly.mates!.map((m) => [m.id, m.a.instanceId, m.b.instanceId, m.b.path])).toEqual([
      ["h/pin", "h/a", "h/b", undefined],
      ["touch", "s", "h/b", undefined],
    ]);
    expect(view.from["h/pin"]).toEqual({ top: "h", name: "pin" });
    // Without flexible copies: the same object.
    expect(expandFlexible(hinge, [hinge], () => ({})).assembly).toBe(hinge);
  });
});
