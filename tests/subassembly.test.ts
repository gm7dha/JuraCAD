/**
 * Sub-assemblies: one assembly inside another, moving as one piece. Pure
 * logic — cycles refused, nested placements, the parts list, saved files.
 * (Mates to parts inside a sub-assembly, on real parts: subassemblyEngine.test.ts.)
 */
import { describe, expect, it } from "vitest";

import { addAssembly, billOfMaterials, bomCsv, bomTotalMass, parseAssemblies, partInstances, removeAssembly, renameAssembly, putMate, type BomInfo } from "../src/assembly/assembly";
import { applyPlacement, IDENTITY, quatFromAxisAngle, type Placement, type Vec3 } from "../src/assembly/math";
import { solvedInside, solveAssembly } from "../src/assembly/mates";
import { pickConnector, samePieceClick, solveWithParts } from "../src/assembly/mates";
import { mateInactive } from "../src/assembly/suppress";
import { syncPattern } from "../src/assembly/patterns";
import { instanceAt, insertProblem, insertSubAssembly, kernelInstances, ownBox, leavesOf, leafKey, pathOfKey, topOfKey, tidySubAssemblies, usesAssembly, whereUsed } from "../src/assembly/subassembly";
import { emptyDocument } from "../src/model/document";
import type { Assembly, Instance, JuraCADDocument, Mate } from "../src/model/types";

const close = (a: readonly number[], b: readonly number[], digits = 9) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const at = (x: number, y: number, z: number, rotation: Placement["rotation"] = [0, 0, 0, 1]): Placement => ({ position: [x, y, z], rotation });
const part = (id: string, partId: string, placement: Placement = IDENTITY, extra: Partial<Instance> = {}): Instance => ({ id, partId, name: `${partId} <${id}>`, placement, fixed: false, ...extra });
const sub = (id: string, assemblyId: string, placement: Placement = IDENTITY, extra: Partial<Instance> = {}): Instance => ({ id, partId: "", subAssembly: assemblyId, name: `${assemblyId} <${id}>`, placement, fixed: false, ...extra });
const docWith = (assemblies: Assembly[]): JuraCADDocument => ({ ...emptyDocument(), assemblies });
const RAD90 = Math.PI / 2;

describe("putting one assembly inside another", () => {
  const two = () => {
    let doc = addAssembly(addAssembly(emptyDocument(), "A"), "B");
    doc = { ...doc, assemblies: doc.assemblies!.map((a) => (a.id === "B" ? { ...a, instances: [part("p1", "bolt")] } : a)) };
    return doc;
  };

  it("adds it as one instance, named after the assembly, fixed when it's the first", () => {
    const doc = insertSubAssembly(two(), "A", "B", at(5, 0, 0), "s1");
    const a = doc.assemblies!.find((x) => x.id === "A")!;
    expect(a.instances).toEqual([{ id: "s1", partId: "", subAssembly: "B", name: "Assembly 2 <1>", placement: at(5, 0, 0), fixed: true }]);
    // Several copies of the same one.
    const again = insertSubAssembly(doc, "A", "B", IDENTITY, "s2");
    const list = again.assemblies!.find((x) => x.id === "A")!.instances;
    expect(list.map((i) => [i.name, i.fixed])).toEqual([
      ["Assembly 2 <1>", true],
      ["Assembly 2 <2>", false],
    ]);
    expect(whereUsed(again.assemblies!, "B").map((x) => x.id)).toEqual(["A"]);
  });

  it("refuses an assembly inside itself, or round a circle, in plain words", () => {
    let doc = two();
    expect(insertProblem(doc, "A", "A")).toMatch(/can't go inside itself/);
    expect(insertSubAssembly(doc, "A", "A")).toBe(doc);
    doc = insertSubAssembly(doc, "A", "B", IDENTITY, "s1");
    // B into A is fine; A into B would be a circle.
    expect(insertProblem(doc, "B", "A")).toBe("Assembly 1 already has Assembly 2 inside it, so putting it into Assembly 2 would go round in a circle. Pick another assembly, or take Assembly 2 out of Assembly 1 first.");
    expect(insertSubAssembly(doc, "B", "A")).toBe(doc);
    // Three deep: C inside B inside A; A into C goes round too.
    doc = addAssembly(doc, "C");
    doc = insertSubAssembly(doc, "B", "C", IDENTITY, "s2");
    expect(usesAssembly(doc.assemblies!, "A", "C")).toBe(true);
    expect(usesAssembly(doc.assemblies!, "C", "A")).toBe(false);
    expect(insertProblem(doc, "C", "A")).toMatch(/would go round in a circle/);
    expect(insertProblem(doc, "C", "B")).toMatch(/would go round in a circle/);
    expect(insertProblem(doc, "A", "C")).toBeNull();
    expect(insertProblem(doc, "A", "nope")).toBe("That assembly no longer exists.");
  });

  it("takes an assembly out of the others when it's deleted, with the mates on it", () => {
    const pick = { partId: "bolt", ref: { kind: "face" as const, surface: "PLANE", center: [0, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 } };
    let doc = insertSubAssembly(two(), "A", "B", IDENTITY, "s1");
    doc = { ...doc, assemblies: doc.assemblies!.map((a) => (a.id === "A" ? { ...a, instances: [...a.instances, part("p9", "bolt")] } : a)) };
    const m: Mate = { id: "m", name: "Fasten 1", type: "fastened", a: { instanceId: "p9", pick }, b: { instanceId: "s1", path: ["p1"], pick }, flip: false, values: {} };
    doc = putMate(doc, "A", m);
    const gone = removeAssembly(doc, "B");
    const a = gone.assemblies!.find((x) => x.id === "A")!;
    expect(gone.assemblies!.map((x) => x.id)).toEqual(["A"]);
    expect(a.instances.map((i) => i.id)).toEqual(["p9"]);
    expect(a.mates).toBeUndefined();
  });

  it("renames its copies when the assembly is renamed (unless they were renamed by hand)", () => {
    let doc = insertSubAssembly(two(), "A", "B", IDENTITY, "s1");
    doc = insertSubAssembly(doc, "A", "B", IDENTITY, "s2");
    doc = { ...doc, assemblies: doc.assemblies!.map((a) => (a.id === "A" ? { ...a, instances: a.instances.map((i) => (i.id === "s2" ? { ...i, name: "Left hinge" } : i)) } : a)) };
    const r = renameAssembly(doc, "B", "Hinge");
    expect(r.assemblies!.find((x) => x.id === "A")!.instances.map((i) => i.name)).toEqual(["Hinge <1>", "Left hinge"]);
    expect(r.assemblies!.find((x) => x.id === "B")!.name).toBe("Hinge");
  });
});

describe("parts inside sub-assemblies", () => {
  // C: one part, 1, 2, 3 along. B: C turned a quarter about Z and moved 10 along X, plus a part of its own.
  // A: B turned a quarter about X and lifted 100.
  const qz = quatFromAxisAngle([0, 0, 1], RAD90);
  const qx = quatFromAxisAngle([1, 0, 0], RAD90);
  const C: Assembly = { id: "C", name: "Cap", instances: [part("c1", "pin", at(1, 2, 3), { fixed: true })] };
  const B: Assembly = { id: "B", name: "Body", instances: [sub("b1", "C", at(10, 0, 0, qz), { fixed: true }), part("b2", "plate", at(0, 0, 50))] };
  const A: Assembly = { id: "A", name: "Top", instances: [sub("a1", "B", at(0, 0, 100, qx), { fixed: true }), part("a2", "plate", at(7, 0, 0))] };
  const all = [A, B, C];

  it("places a part two levels deep: each level's move and turn, one after another", () => {
    const leaves = leavesOf(A, [], all);
    expect(leaves.map((l) => [l.key, l.top, l.path, l.instance.partId, l.name])).toEqual([
      ["a1/b1/c1", "a1", ["b1", "c1"], "pin", "B <a1> / C <b1> / pin <c1>"],
      ["a1/b2", "a1", ["b2"], "plate", "B <a1> / plate <b2>"],
      ["a2", "a2", [], "plate", "plate <a2>"],
    ]);
    // The pin's own origin: (1, 2, 3) in C; turned a quarter about Z → (−2, 1, 3), +10 along X → (8, 1, 3);
    // turned a quarter about X → (8, −3, 1), lifted 100 → (8, −3, 101).
    const tops = { a1: A.instances[0].placement, a2: A.instances[1].placement };
    const k = kernelInstances(leaves, [{ id: "pin" }, { id: "plate" }] as never, tops, () => IDENTITY);
    const pin = k.find((i) => i.id === "a1/b1/c1")!;
    close(pin.position, [8, -3, 101]);
    // Its X axis: the Z turn takes it to Y, the X turn takes Y up to Z. Its Z axis: the X turn takes it to −Y.
    const p = { position: pin.position, rotation: pin.rotation };
    close(applyPlacement(p, [1, 0, 0]), [8, -3, 102]);
    close(applyPlacement(p, [0, 0, 1]), [8, -4, 101]);
    // B's own plate: (0, 0, 50) → turned about X → (0, −50, 0), lifted → (0, −50, 100).
    close(k.find((i) => i.id === "a1/b2")!.position, [0, -50, 100]);
    close(k.find((i) => i.id === "a2")!.position, [7, 0, 0]);
    // Moving the sub-assembly (its top-level place) carries every part inside along.
    const moved = kernelInstances(leaves, [{ id: "pin" }, { id: "plate" }] as never, { ...tops, a1: at(0, 0, 200, qx) }, () => IDENTITY);
    close(moved.find((i) => i.id === "a1/b1/c1")!.position, [8, -3, 201]);
  });

  it("leaves out suppressed instances at any level, and parts that no longer exist", () => {
    const B2: Assembly = { ...B, instances: B.instances.map((i) => (i.id === "b2" ? { ...i, suppressed: true } : i)) };
    expect(leavesOf(A, [], [A, B2, C]).map((l) => l.key)).toEqual(["a1/b1/c1", "a2"]);
    const A2: Assembly = { ...A, instances: A.instances.map((i) => (i.id === "a1" ? { ...i, suppressed: true } : i)) };
    expect(leavesOf(A2, [], all).map((l) => l.key)).toEqual(["a2"]);
    expect(kernelInstances(leavesOf(A, [], all), [{ id: "plate" }] as never, {}, () => IDENTITY).map((i) => i.id)).toEqual(["a1/b2", "a2"]);
    expect(partInstances(A, all).map((p) => p.name)).toEqual(["B <a1> / C <b1> / pin <c1>", "B <a1> / plate <b2>", "plate <a2>"]);
  });

  it("finds what a key names", () => {
    expect(instanceAt(A, all, "a1/b1/c1")?.part.id).toBe("c1");
    expect(instanceAt(A, all, "a1/b1/c1")?.top.id).toBe("a1");
    expect(instanceAt(A, all, "a2")?.part.id).toBe("a2");
    // A sub-assembly itself isn't a part; a wrong step is nothing.
    expect(instanceAt(A, all, "a1")).toBeNull();
    expect(instanceAt(A, all, "a1/nope")).toBeNull();
    expect(topOfKey("a1/b1/c1")).toBe("a1");
    expect(pathOfKey("a1/b1/c1")).toEqual(["b1", "c1"]);
    expect(leafKey("a1", ["b1"])).toBe("a1/b1");
  });

  it("moves as one piece in the parent: its own mates aren't solved there", () => {
    // In A, the sub-assembly is just one instance; it sits where it's put.
    const r = solveAssembly(A, () => null);
    expect(r.placements.a1).toEqual(A.instances[0].placement);
    // Inside, its parts sit where its own (unmated) placements say.
    close(solvedInside(B, [], all).b1.position, [10, 0, 0]);
  });

  it("has a box round all its parts (for exploded views and placing new copies beside it)", () => {
    // Every part is a 1 mm cube at its origin; mirrored ones span −1…0 in X.
    const cube = () => ({ min: [0, 0, 0] as Vec3, max: [1, 1, 1] as Vec3 });
    const meshes = [{ id: "pin" }, { id: "plate" }] as never;
    // B's own place doesn't matter: the box is in its own coordinates. The pin sits at (8, 1, 3) turned (a cube from x 7…8),
    // the plate at (0, 0, 50).
    const box = ownBox(A, A.instances[0], meshes, all, cube)!;
    close(box.min, [0, 0, 3]);
    close(box.max, [8, 2, 51]);
    const mirrored = ownBox(A, { ...A.instances[1], mirrored: true }, meshes, all, cube)!;
    close(mirrored.min, [-1, 0, 0]);
    close(mirrored.max, [0, 1, 1]);
  });

  it("never goes round a circle, even in a broken file", () => {
    const loopA: Assembly = { id: "A", name: "A", instances: [sub("x", "B")] };
    const loopB: Assembly = { id: "B", name: "B", instances: [sub("y", "A"), part("p", "bolt")] };
    expect(leavesOf(loopA, [], [loopA, loopB]).map((l) => l.key)).toEqual(["x/p"]);
  });
});

describe("parts list with sub-assemblies", () => {
  // S: 3 bolts and a plate. A: a base and 2 copies of S.
  const S: Assembly = { id: "S", name: "Hinge", instances: [part("s1", "bolt"), part("s2", "bolt"), part("s3", "bolt"), part("s4", "plate")] };
  const A: Assembly = { id: "A", name: "Door", instances: [part("a1", "base"), sub("a2", "S"), sub("a3", "S")] };
  const names = { bolt: "Bolt", plate: "Plate", base: "Base" };
  const grams: Record<string, number> = { bolt: 1000, plate: 2000, base: 5000 };
  const info: BomInfo = (i) => ({ material: "pla", volume: grams[i.partId] });

  it("counts every part, however deep (flattened): 2 hinges × 3 bolts = 6", () => {
    const rows = billOfMaterials(A, names, {}, undefined, {}, { assemblies: [A, S] });
    expect(rows.map((r) => [r.partId, r.name, r.quantity])).toEqual([
      ["base", "Base", 1],
      ["bolt", "Bolt", 6],
      ["plate", "Plate", 2],
    ]);
    // Without the other assemblies to look into (old callers), sub-assemblies are simply not listed.
    expect(billOfMaterials(A, names).map((r) => r.partId)).toEqual(["base"]);
  });

  it("lists each sub-assembly once, with what's in one of it underneath (structured)", () => {
    const rows = billOfMaterials(A, names, {}, info, {}, { assemblies: [A, S], structured: true });
    expect(rows.map((r) => [r.item, r.level, r.name, r.quantity, !!r.subAssembly])).toEqual([
      ["1", 0, "Base", 1, false],
      ["2", 0, "Hinge", 2, true],
      ["2.1", 1, "Bolt", 3, false],
      ["2.2", 1, "Plate", 1, false],
    ]);
    // A hinge weighs its 3 bolts and plate; the total is the same either way.
    const each = (k: string) => rows.find((r) => r.partId === k)!.massEach!;
    expect(rows[1].massEach).toBeCloseTo(3 * each("bolt") + each("plate"), 9);
    const flat = billOfMaterials(A, names, {}, info, {}, { assemblies: [A, S] });
    expect(bomTotalMass(rows).grams).toBeCloseTo(bomTotalMass(flat).grams, 9);
    expect(bomTotalMass(flat).grams).toBeCloseTo(each("base") + 6 * each("bolt") + 2 * each("plate"), 9);
    // The spreadsheet keeps the item numbers.
    expect(bomCsv(rows.map(({ material: _m, massEach: _w, ...r }) => r)).split("\n").slice(0, 5)).toEqual(["Item,Part,Quantity", "1,Base,1", "2,Hinge,2", "2.1,Bolt,3", "2.2,Plate,1"]);
  });

  it("nests deeper, and leaves out suppressed parts and sub-assemblies", () => {
    const T: Assembly = { id: "T", name: "Top", instances: [sub("t1", "A"), sub("t2", "A"), sub("t3", "S", IDENTITY, { suppressed: true })] };
    const S2: Assembly = { ...S, instances: S.instances.map((i) => (i.id === "s4" ? { ...i, suppressed: true } : i)) };
    const rows = billOfMaterials(T, names, {}, undefined, {}, { assemblies: [T, A, S2] });
    expect(rows.map((r) => [r.partId, r.quantity])).toEqual([
      ["base", 2],
      ["bolt", 12],
    ]);
    const structured = billOfMaterials(T, names, {}, undefined, {}, { assemblies: [T, A, S2], structured: true });
    expect(structured.map((r) => [r.item, r.name, r.quantity])).toEqual([
      ["1", "Door", 2],
      ["1.1", "Base", 1],
      ["1.2", "Hinge", 2],
      ["1.2.1", "Bolt", 3],
    ]);
  });

  it("is unchanged for an assembly without sub-assemblies", () => {
    const plain: Assembly = { id: "P", name: "P", instances: [part("a", "bolt"), part("b", "bolt"), part("c", "plate", IDENTITY, { mirrored: true })] };
    expect(billOfMaterials(plain, names, {}, undefined, {}, { assemblies: [plain] })).toEqual(billOfMaterials(plain, names));
    expect(billOfMaterials(plain, names).map((r) => [r.partId, r.quantity, r.level, r.item])).toEqual([
      ["bolt", 2, undefined, undefined],
      ["plate~mirrored", 1, undefined, undefined],
    ]);
  });
});

describe("saved files", () => {
  it("opens old files unchanged", () => {
    const old = [
      {
        id: "A",
        name: "Old",
        instances: [
          { id: "i1", partId: "f1", name: "Box <1>", placement: { position: [1, 2, 3], rotation: [0, 0, 0, 1] }, fixed: true },
          { id: "i2", partId: "f2", name: "Pin <1>", placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: false, mirrored: true },
        ],
      },
    ];
    expect(parseAssemblies(old)).toEqual(old);
  });

  it("keeps sub-assemblies and paths, and drops ones that are missing or go round in a circle", () => {
    const pick = { partId: "f1", ref: { kind: "face", surface: "PLANE", center: [0, 0, 0], normal: [0, 0, 1] } };
    const raw = [
      {
        id: "A",
        name: "A",
        instances: [
          { id: "i1", partId: "f1", name: "Box <1>", placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: true },
          { id: "s1", partId: "", subAssembly: "B", name: "B <1>", placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: false, mirrored: true, configuration: "c" },
          { id: "s2", subAssembly: "gone", name: "Gone <1>", placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: false },
        ],
        mates: [{ id: "m1", name: "Fasten 1", type: "fastened", a: { instanceId: "i1", pick }, b: { instanceId: "s1", path: ["j1", 5], pick }, flip: false, values: {} },
          { id: "m2", name: "Fasten 2", type: "fastened", a: { instanceId: "i1", pick }, b: { instanceId: "s2", path: ["j1"], pick }, flip: false, values: {} }],
      },
      // B has A inside it: a circle. A keeps B; B loses its copy of A.
      { id: "B", name: "B", instances: [{ id: "j1", partId: "f1", name: "Box <1>", placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: true }, { id: "j2", subAssembly: "A", partId: "", name: "A <1>", placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: false }] },
      // C inside itself.
      { id: "C", name: "C", instances: [{ id: "k1", subAssembly: "C", name: "C <1>", placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: false }] },
    ];
    const [a, b, c] = parseAssemblies(raw);
    // Mirroring and configurations are for parts: a sub-assembly doesn't take them.
    expect(a.instances.map((i) => [i.id, i.subAssembly, i.partId, i.mirrored, i.configuration])).toEqual([
      ["i1", undefined, "f1", undefined, undefined],
      ["s1", "B", "", undefined, undefined],
    ]);
    // The path is kept (bad steps make it unusable, so it's dropped); the mate on the missing one went with it.
    expect(a.mates!.map((m) => [m.id, m.b.path])).toEqual([["m1", undefined]]);
    expect(b.instances.map((i) => i.id)).toEqual(["j1"]);
    expect(c.instances).toEqual([]);
    const good = parseAssemblies([{ ...raw[0], mates: [{ ...raw[0].mates![0], b: { instanceId: "s1", path: ["j1"], pick } }] }, raw[1]]);
    expect(good[0].mates![0].b.path).toEqual(["j1"]);
    expect(tidySubAssemblies(good)).toEqual(good);
  });
});

describe("mates and patterns with sub-assemblies", () => {
  const face = { partId: "bolt", ref: { kind: "face" as const, surface: "PLANE", center: [0, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 } };
  it("refuses a second click on another part inside the same sub-assembly copy (it moves as one piece)", () => {
    const first = pickConnector({ type: "fastened" }, { instanceId: "s1", path: ["p1"], pick: face });
    // Another part of the same copy: refused (the store keeps the first pick and explains).
    expect(samePieceClick({ type: "fastened", ...first }, { instanceId: "s1", path: ["p2"], pick: face })).toBe(true);
    expect(samePieceClick({ type: "fastened", ...first }, { instanceId: "s1", path: ["p1", "q"], pick: face })).toBe(true);
    // The same part again, another copy, a plain part, or the first click: fine.
    expect(samePieceClick({ type: "fastened", ...first }, { instanceId: "s1", path: ["p1"], pick: face })).toBe(false);
    expect(samePieceClick({ type: "fastened", ...first }, { instanceId: "s2", path: ["p1"], pick: face })).toBe(false);
    expect(samePieceClick({ type: "fastened" }, { instanceId: "s1", path: ["p2"], pick: face })).toBe(false);
    expect(samePieceClick({ type: "fastened", a: { instanceId: "x", pick: face } }, { instanceId: "x", pick: face })).toBe(false);
    // Once both sides are picked, a click starts again as usual.
    const both = { type: "fastened" as const, ...first, b: { instanceId: "s2", path: ["p1"], pick: face } };
    expect(samePieceClick(both, { instanceId: "s1", path: ["p2"], pick: face })).toBe(false);
    // Width: the second face of a side may be on another part of the same copy (a slot made by two plates)…
    const slot = { type: "width" as const, a: { instanceId: "s1", path: ["p1"], pick: face } };
    expect(samePieceClick(slot, { instanceId: "s1", path: ["p2"], pick: face })).toBe(false);
    expect(pickConnector(slot, { instanceId: "s1", path: ["p2"], pick: face }).a).toEqual({ instanceId: "s1", path: ["p1"], pick: face, pick2: face, path2: ["p2"] });
    // …but once that side has both faces, the other side can't be in the same copy.
    expect(samePieceClick({ type: "width", a: { ...slot.a, pick2: face, path2: ["p2"] } }, { instanceId: "s1", path: ["p3"], pick: face })).toBe(true);
    const other = pickConnector({ type: "fastened", ...first }, { instanceId: "s2", path: ["p1"], pick: face });
    expect(other.b).toEqual({ instanceId: "s2", path: ["p1"], pick: face });
  });

  it("repeats a sub-assembly in a line (but doesn't mirror one)", () => {
    const a: Assembly = { id: "A", name: "A", instances: [sub("s1", "S", at(0, 0, 0))] };
    let n = 0;
    const lin = syncPattern(a, { id: "p", name: "Linear pattern 1", kind: "linear", seeds: ["s1"], count: 3, amount: "20", axis: "x" }, () => `c${++n}`);
    expect(lin.instances.map((i) => [i.id, i.subAssembly, i.partId, i.placement.position[0]])).toEqual([
      ["s1", "S", "", 0],
      ["c1", "S", "", 20],
      ["c2", "S", "", 40],
    ]);
    const mir = syncPattern(a, { id: "q", name: "Mirror 1", kind: "mirror", seeds: ["s1"], count: 2, amount: "0", axis: "x" }, () => `m${++n}`);
    expect(mir.instances.map((i) => i.id)).toEqual(["s1"]);
  });
});

describe("when the way to a part inside a sub-assembly breaks", () => {
  const face = { partId: "bolt", ref: { kind: "face" as const, surface: "PLANE", center: [0, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 } };
  const H: Assembly = { id: "H", name: "Hinge", instances: [part("p1", "bolt", IDENTITY, { name: "Pin <1>", fixed: true }), part("p2", "bolt", IDENTITY, { name: "Pin <2>" })] };
  const m: Mate = { id: "m", name: "Fasten 1", type: "fastened", a: { instanceId: "base", pick: face }, b: { instanceId: "h1", path: ["p2"], pick: face }, flip: false, values: {} };
  const T: Assembly = { id: "T", name: "Top", instances: [part("base", "bolt", IDENTITY, { fixed: true }), sub("h1", "H", IDENTITY, { name: "Hinge <1>" })], mates: [m] };

  it("says the part inside is suppressed, and shows the mate as not used", () => {
    const off: Assembly = { ...H, instances: H.instances.map((i) => (i.id === "p2" ? { ...i, suppressed: true } : i)) };
    expect(mateInactive(T, m, [T, off])).toBe("Not used while Pin <2> inside Hinge <1> is suppressed");
    expect(mateInactive(T, m, [T, H])).toBeNull();
    expect(solveWithParts(T, [], { assemblies: [T, off] }).mateErrors.m).toBe("Pin <2> inside Hinge <1> is suppressed. Unsuppress it, or edit the mate and pick another face.");
  });

  it("says the part inside was removed", () => {
    const less: Assembly = { ...H, instances: [H.instances[0]] };
    expect(solveWithParts(T, [], { assemblies: [T, less] }).mateErrors.m).toBe("The part it used inside Hinge <1> was removed from Hinge. Edit the mate and pick a face again.");
    expect(mateInactive(T, m, [T, less])).toBeNull();
  });

  it("drops mates that reach a part through a copy of a deleted assembly", () => {
    // Top holds Mid, which holds a copy of Hinge; a mate in Top reaches Pin <2> through it.
    const Mid: Assembly = { id: "M", name: "Mid", instances: [sub("h9", "H", IDENTITY, { fixed: true })] };
    const deep: Mate = { ...m, b: { instanceId: "mid", path: ["h9", "p2"], pick: face } };
    const Top: Assembly = { id: "T", name: "Top", instances: [part("base", "bolt", IDENTITY, { fixed: true }), sub("mid", "M")], mates: [deep] };
    const after = removeAssembly(docWith([Top, Mid, H]), "H");
    expect(after.assemblies!.map((a) => [a.id, a.instances.map((i) => i.id), a.mates?.length ?? 0])).toEqual([
      ["T", ["base", "mid"], 0],
      ["M", [], 0],
    ]);
  });
});

describe("assemblies without sub-assemblies", () => {
  it("put each part exactly where it was (no extra rounding)", () => {
    const q = quatFromAxisAngle([1, 2, 3], 0.7);
    const A: Assembly = { id: "A", name: "A", instances: [part("a", "bolt", at(1.1, 2.2, 3.3, q))] };
    const placed = { a: at(0.1 + 0.2, 1 / 3, 7, q) };
    const k = kernelInstances(leavesOf(A, [], [A]), [{ id: "bolt" }] as never, placed, () => IDENTITY);
    expect(k[0].position).toEqual(placed.a.position);
    expect(k[0].rotation).toEqual(placed.a.rotation);
  });
});

describe("tidying", () => {
  it("leaves documents without sub-assemblies alone", () => {
    const plain: Assembly[] = [{ id: "A", name: "A", instances: [part("a", "bolt")] }];
    expect(tidySubAssemblies(plain)).toBe(plain);
    expect(docWith(plain).assemblies).toBe(plain);
  });
});
