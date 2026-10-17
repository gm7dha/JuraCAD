/**
 * Assembly extras: shifting a Fasten, weights in the parts list, duplicating
 * and replacing instances, and exploded view steps.
 */
import { describe, expect, it } from "vitest";

import {
  billOfMaterials,
  bomCsv,
  bomTotalMass,
  duplicateInstances,
  meshVolume,
  mirroredBox,
  parseAssemblies,
  removeInstances,
  replaceInstancePart,
  setExplode,
  updateAssembly,
} from "../src/assembly/assembly";
import { syncPattern } from "../src/assembly/patterns";
import type { Frame } from "../src/assembly/connectors";
import { addOffsets, putExplodeStep, removeExplodeStep, stepDistance, stepOffsets } from "../src/assembly/explode";
import type { Vec3 } from "../src/assembly/math";
import { MATE_TYPES, solveAssembly } from "../src/assembly/mates";
import { emptyDocument } from "../src/model/document";
import type { Assembly, Instance, Mate, JuraCADDocument } from "../src/model/types";

const close = (a: number[], b: number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const pick = (partId: string) => ({ partId, ref: { kind: "face" as const, surface: "PLANE", center: [0, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 } });
const inst = (id: string, partId: string, extra: Partial<Instance> = {}): Instance => ({ id, partId, name: `${partId} <1>`, placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: false, ...extra });

describe("Fasten shifts", () => {
  it("moves the part sideways on the face as well as away from it", () => {
    expect(MATE_TYPES.fastened.values.map((v) => v.key)).toEqual(["gap", "angle", "dx", "dy"]);
    expect(MATE_TYPES.fastened.values.every((v) => !v.free)).toBe(true);
    const top: Frame = { origin: [0, 0, 10], z: [0, 0, 1], x: [1, 0, 0] };
    const bottom: Frame = { origin: [0, 0, 0], z: [0, 0, -1], x: [1, 0, 0] };
    const mate: Mate = { id: "m", name: "Fasten 1", type: "fastened", a: { instanceId: "a", pick: pick("p") }, b: { instanceId: "b", pick: pick("p") }, flip: false, values: { gap: "2", dx: "5", dy: "-3" } };
    const asm: Assembly = { id: "A", name: "A", instances: [inst("a", "p", { fixed: true }), inst("b", "p")], mates: [mate] };
    const r = solveAssembly(asm, (_m, side) => (side === "a" ? top : bottom));
    expect(r.mateErrors).toEqual({});
    close(r.placements.b.position, [5, -3, 12]);
    // Old Fasten mates (no shifts saved) sit where they did.
    const old = solveAssembly({ ...asm, mates: [{ ...mate, values: { gap: "2" } }] }, (_m, side) => (side === "a" ? top : bottom));
    close(old.placements.b.position, [0, 0, 12]);
  });
});

describe("weights in the parts list", () => {
  // A 10 mm cube as triangles, facing outwards.
  const cube = () => {
    const v = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10];
    const t = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
    return { v, t };
  };

  it("works out a closed mesh's volume", () => {
    const { v, t } = cube();
    expect(meshVolume(v, t)).toBeCloseTo(1000, 9);
  });

  it("lists each part's material and weight, and the total", () => {
    const asm: Assembly = { id: "A", name: "A", instances: [inst("i1", "p1"), inst("i2", "p1"), inst("i3", "p2"), inst("i4", "gone")] };
    const info = (i: Instance) => (i.partId === "p1" ? { material: "steel", volume: 1000 } : i.partId === "p2" ? { volume: 2000 } : { volume: null });
    const rows = billOfMaterials(asm, { p1: "Bolt", p2: "Plate" }, {}, info);
    expect(rows.map((r) => [r.name, r.quantity, r.material, r.massEach])).toEqual([
      ["Bolt", 2, "Steel", 7.85],
      ["Plate", 1, "PLA", 2.48],
      ["gone", 1, undefined, undefined],
    ]);
    const total = bomTotalMass(rows);
    expect(total.grams).toBeCloseTo(2 * 7.85 + 2.48, 9);
    expect(total.partial).toBe(true);
    expect(bomCsv(rows)).toBe("Item,Part,Quantity,Material,Weight each (g),Weight (g)\n1,Bolt,2,Steel,7.9,15.7\n2,Plate,1,PLA,2.5,2.5\n3,gone,1,,,\n");
    // A surface weighs nothing, and doesn't make the total "partly unknown".
    const withSurface = billOfMaterials({ ...asm, instances: asm.instances.slice(0, 3) }, { p1: "Bolt", p2: "Skin" }, {}, (i) => (i.partId === "p2" ? { volume: null } : { material: "steel", volume: 1000 }));
    expect(withSurface[1].surface).toBe(true);
    expect(withSurface[1].massEach).toBeUndefined();
    expect(bomTotalMass(withSurface)).toEqual({ grams: 2 * 7.85, partial: false });
    // Without the extra information it's the plain three columns as before.
    expect(bomCsv(billOfMaterials(asm, { p1: "Bolt", p2: "Plate" })).split("\n")[0]).toBe("Item,Part,Quantity");
  });
});

describe("duplicating instances", () => {
  it("copies the parts beside the originals, with the mates between them", () => {
    const asm: Assembly = {
      id: "A",
      name: "A",
      instances: [inst("base", "b", { fixed: true, name: "Base <1>" }), inst("lid", "l", { name: "Lid <1>", copyOf: { pattern: "p", seed: "x", index: 1 } }), inst("arm", "r", { name: "Arm <1>" })],
      mates: [
        { id: "m1", name: "Hinge 1", type: "revolute", a: { instanceId: "lid", pick: pick("l") }, b: { instanceId: "arm", pick: pick("r") }, flip: false, values: { angle: "30" } },
        { id: "m2", name: "Fasten 1", type: "fastened", a: { instanceId: "base", pick: pick("b") }, b: { instanceId: "lid", pick: pick("l") }, flip: false, values: {} },
      ],
    };
    let n = 0;
    const placements = { lid: { position: [1, 2, 3] as Vec3, rotation: [0, 0, 0, 1] as [number, number, number, number] } };
    const { assembly, ids } = duplicateInstances(asm, ["lid", "arm"], placements, [50, 0, 0], (p) => `${p}${++n}`);
    expect(ids).toEqual(["i1", "i2"]);
    const lid2 = assembly.instances.find((i) => i.id === "i1")!;
    expect(lid2.name).toBe("Lid <2>");
    expect(lid2.copyOf).toBeUndefined();
    expect(lid2.fixed).toBe(false);
    close(lid2.placement.position, [51, 2, 3]);
    expect(assembly.instances.find((i) => i.id === "i2")!.name).toBe("Arm <2>");
    // The hinge between the two copied parts is copied; the Fasten to the base isn't.
    expect(assembly.mates!.map((m) => [m.name, m.a.instanceId, m.b.instanceId])).toEqual([
      ["Hinge 1", "lid", "arm"],
      ["Fasten 1", "base", "lid"],
      ["Hinge 2", "i1", "i2"],
    ]);
  });
});

describe("duplicating relations and groups", () => {
  it("copies gears between copied mates, and groups of copied parts, under new names", () => {
    const asm: Assembly = {
      id: "A",
      name: "A",
      instances: [inst("g", "base", { fixed: true }), inst("x", "gear"), inst("y", "gear"), inst("z", "gear")],
      mates: [
        { id: "h1", name: "Hinge 1", type: "revolute", a: { instanceId: "x", pick: pick("gear") }, b: { instanceId: "y", pick: pick("gear") }, flip: false, values: {} },
        { id: "h2", name: "Hinge 2", type: "revolute", a: { instanceId: "y", pick: pick("gear") }, b: { instanceId: "z", pick: pick("gear") }, flip: false, values: {} },
        { id: "h3", name: "Hinge 3", type: "revolute", a: { instanceId: "g", pick: pick("base") }, b: { instanceId: "x", pick: pick("gear") }, flip: false, values: {} },
      ],
      relations: [
        { id: "r1", name: "Gear 1", kind: "gear", driver: "h1", driven: "h2", ratio: "2" },
        { id: "r2", name: "Gear 2", kind: "gear", driver: "h3", driven: "h1", ratio: "1" },
      ],
      groups: [
        { id: "gr", name: "Group 1", members: ["y", "z"], offsets: { z: { position: [5, 0, 0], rotation: [0, 0, 0, 1] } } },
        { id: "gr2", name: "Group 2", members: ["g", "x"], offsets: { x: { position: [1, 0, 0], rotation: [0, 0, 0, 1] } } },
      ],
    };
    let n = 0;
    const { assembly } = duplicateInstances(asm, ["x", "y", "z"], {}, [10, 0, 0], (p) => `${p}${++n}`);
    // Hinges 1 and 2 copied as Hinge 4 and 5; the gear between them comes too, pointing at the copies.
    const newMates = assembly.mates!.slice(3);
    expect(newMates.map((m) => m.name)).toEqual(["Hinge 4", "Hinge 5"]);
    expect(assembly.relations!.map((r) => [r.name, r.driver, r.driven])).toEqual([
      ["Gear 1", "h1", "h2"],
      ["Gear 2", "h3", "h1"],
      ["Gear 3", newMates[0].id, newMates[1].id],
    ]);
    // Group 1 (all copied) is copied; Group 2 (its base wasn't copied) isn't.
    const copiedGroup = assembly.groups![2];
    expect(assembly.groups).toHaveLength(3);
    expect(copiedGroup.name).toBe("Group 3");
    const [y2, z2] = copiedGroup.members;
    expect(assembly.instances.find((i) => i.id === y2)!.name).toBe("gear <3>");
    expect(copiedGroup.offsets[z2].position).toEqual([5, 0, 0]);
  });
});

describe("placing duplicates of mirrored parts", () => {
  it("uses the mirrored part's box", () => {
    expect(mirroredBox({ min: [50, 0, 0], max: [70, 10, 5] })).toEqual({ min: [-70, 0, 0], max: [-50, 10, 5] });
  });
});

describe("replacing an instance's part", () => {
  it("shows the new part in it and its pattern copies, keeping its mates", () => {
    const asm: Assembly = {
      id: "A",
      name: "A",
      instances: [
        inst("base", "b", { fixed: true, name: "Base <1>" }),
        inst("s1", "m3", { name: "M3 bolt <1>", configuration: "long" }),
        inst("s2", "m3", { name: "M3 bolt <2>", copyOf: { pattern: "p", seed: "s1", index: 1 } }),
        inst("s3", "m3", { name: "Special one" }),
      ],
      patterns: [{ id: "p", name: "Pattern 1", kind: "linear", seeds: ["s1"], count: 2, amount: "20", axis: "x" }],
      mates: [{ id: "m", name: "Fasten 1", type: "fastened", a: { instanceId: "base", pick: pick("b") }, b: { instanceId: "s1", pick: pick("m3") }, flip: false, values: {} }],
    };
    const out = replaceInstancePart(asm, "s1", { id: "m4", name: "M4 bolt" }, "M3 bolt");
    expect(out.instances.map((i) => [i.id, i.partId, i.name])).toEqual([
      ["base", "b", "Base <1>"],
      ["s1", "m4", "M4 bolt <1>"],
      ["s2", "m4", "M4 bolt <2>"],
      ["s3", "m3", "Special one"],
    ]);
    expect(out.instances[1].configuration).toBeUndefined();
    expect(out.mates![0].a.pick.partId).toBe("b");
    expect(out.mates![0].b.pick.partId).toBe("m4");
    // Nothing changes when it's already that part.
    expect(replaceInstancePart(asm, "s3", { id: "m3", name: "M3 bolt" })).toBe(asm);
  });
});

describe("exploded view steps", () => {
  const base: Assembly = { id: "A", name: "A", instances: [inst("a", "p"), inst("b", "p"), inst("c", "p")] };

  it("moves chosen parts along an axis, step after step", () => {
    let a = putExplodeStep(base, { id: "s1", instances: ["a", "b"], axis: "z", distance: "30" });
    a = putExplodeStep(a, { id: "s2", instances: ["b"], axis: "x", flip: true, distance: "10 + 5" });
    a = putExplodeStep(a, { id: "s3", instances: ["c"], axis: "y", distance: "nonsense" });
    const off = stepOffsets(a.explodeSteps!);
    close(off.a, [0, 0, 30]);
    close(off.b, [-15, 0, 30]);
    expect(off.c).toBeUndefined();
    expect("error" in stepDistance(a.explodeSteps![2])).toBe(true);
    close(addOffsets({ a: [1, 1, 1] }, off).a, [1, 1, 31]);
    expect(removeExplodeStep(removeExplodeStep(removeExplodeStep(a, "s1"), "s2"), "s3").explodeSteps).toBeUndefined();
  });

  it("forgets parts that a pattern change removes", () => {
    const seeded: Assembly = { ...base, instances: [...base.instances] };
    let doc: JuraCADDocument = { ...emptyDocument(), assemblies: [seeded] };
    let k = 0;
    const pattern = { id: "pt", name: "Pattern 1", kind: "linear" as const, seeds: ["a"], count: 3, amount: "20", axis: "x" as const };
    doc = updateAssembly(doc, "A", (a) => syncPattern(a, pattern, () => `copy${++k}`));
    doc = updateAssembly(doc, "A", (a) => putExplodeStep(a, { id: "s", instances: ["copy2", "b"], axis: "z", distance: "10" }));
    // Two in the pattern now: copy 2 goes, and the step forgets it.
    doc = updateAssembly(doc, "A", (a) => syncPattern(a, { ...pattern, count: 2 }, () => `copy${++k}`));
    expect(doc.assemblies![0].instances.some((i) => i.id === "copy2")).toBe(false);
    expect(doc.assemblies![0].explodeSteps).toEqual([{ id: "s", instances: ["b"], axis: "z", distance: "10" }]);
  });

  it("can show only the steps (no spread), and saves and reopens them", () => {
    let doc: JuraCADDocument = { ...emptyDocument(), assemblies: [putExplodeStep(base, { id: "s1", instances: ["a", "zzz"], axis: "x", distance: "12" })] };
    doc = setExplode(doc, "A", 0);
    expect(doc.assemblies![0].explode).toBe(0);
    expect(setExplode(doc, "A", null).assemblies![0].explode).toBeUndefined();
    const back = parseAssemblies(JSON.parse(JSON.stringify(doc.assemblies)));
    expect(back[0].explode).toBe(0);
    // A part that isn't there any more is dropped from the step.
    expect(back[0].explodeSteps).toEqual([{ id: "s1", instances: ["a"], axis: "x", distance: "12" }]);
    // Removing the part removes the step it was alone in.
    const gone = removeInstances({ ...doc, assemblies: back }, "A", ["a"]);
    expect(gone.assemblies![0].explodeSteps).toBeUndefined();
  });
});
