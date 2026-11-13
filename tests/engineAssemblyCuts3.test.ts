/**
 * Mates on faces assembly features made (own file for OpenCascade's memory):
 * the solve settles at once when such a mate would move the part the hole was
 * drilled in (it's switched off and said), a sub-assembly's own mate to its
 * own drilled hole holds in the assemblies using it, a parent's mate reaches a
 * hole drilled inside a sub-assembly, and taking "the parts it reaches now"
 * with a pin already in the hole doesn't break anything.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { assemblyHole, assemblySketch, setFeatureParts } from "../src/assembly/assemblyFeatures";
import { rememberCutMeshes, solvedInside, solveWithParts } from "../src/assembly/mates";
import { cutMeshesFrom, instancesForKernel, storedCutInputs } from "../src/assembly/placed";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh } from "../src/kernel/protocol";
import type { Assembly, Mate } from "../src/model/types";
import { addPoint } from "../src/sketch/ops";
import { planeOnFace } from "../src/sketch/planes";
import { emptySketch } from "../src/sketch/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

const at = (x: number, y: number, z: number) => ({ position: [x, y, z] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] });

const drill = (asm: Assembly, x: number, y: number, z: number, id = "h1"): Assembly => {
  const sk = assemblySketch(asm, planeOnFace([0, 0, 1], [0, 0, z], "Top"), addPoint(emptySketch(), { x, y }).sketch, `s_${id}`);
  const h = assemblyHole({ features: [sk] }, sk.id, { diameter: 6, throughAll: true }, id);
  return { ...asm, features: [...(asm.features ?? []), sk, h] };
};

describe("mates on faces made by assembly features", () => {
  const engine = new GeometryEngine();
  const plate = feature("box", { width: 40, depth: 40, height: 5 });
  const pin = feature("cylinder", { diameter: 6, height: 20 });
  let parts: PartMesh[] = [];
  let wall: Mate["a"]["pick"];
  let side: Mate["a"]["pick"];
  beforeAll(() => {
    parts = engine.rebuild([plate, pin]).parts;
    const one: Assembly = drill({ id: "Z", name: "Z", instances: [{ id: "i1", partId: plate.id, name: "Plate <1>", placement: at(0, 0, 0), fixed: true }] }, 20, 12, 5);
    const r = engine.assemblyCuts(instancesForKernel(one, parts));
    wall = { partId: plate.id, ref: r.meshes.find((m) => m.id === "i1")!.faceRefs.find((f) => f.surface === "CYLINDRE")! };
    side = { partId: pin.id, ref: parts.find((p) => p.id === pin.id)!.faceRefs.find((f) => f.surface === "CYLINDRE")! };
  });
  const cutsOfIn = (list: Assembly[], built: PartMesh[]) => cutMeshesFrom(engine.assemblyCuts(storedCutInputs(list, built)).meshes);
  const cutsOf = (list: Assembly[]) => cutsOfIn(list, parts);

  it("settles when the mate would move the drilled part: switched off with a plain message, the same every time", () => {
    const asm: Assembly = {
      ...drill(
        {
          id: "A",
          name: "A",
          instances: [
            { id: "i1", partId: plate.id, name: "Plate <1>", placement: at(0, 0, 0), fixed: false },
            { id: "i2", partId: pin.id, name: "Pin <1>", placement: at(-30, 70, 0), fixed: true },
          ],
        },
        20,
        12,
        5,
      ),
      mates: [{ id: "m1", name: "Cylindrical 1", type: "cylindrical", a: { instanceId: "i2", pick: side }, b: { instanceId: "i1", pick: wall }, flip: false, values: {} }],
    };
    const cuts = cutsOf([asm]);
    const first = solveWithParts(asm, parts, { assemblies: [asm], cutMeshes: cuts });
    expect(first.mateErrors.m1).toMatch(/made by an assembly feature on Plate <1>/);
    expect(first.placements.i1.position).toEqual([0, 0, 0]);
    // The cut copies come from the design alone, so solving again (as the app does after each answer) is the same.
    const again = solveWithParts(asm, parts, { assemblies: [asm], cutMeshes: cutsOf([asm]) });
    expect(again.placements).toEqual(first.placements);
    expect(again.mateErrors).toEqual(first.mateErrors);
  });

  it("keeps a pin in its hole when the part under the drilled plate is made thicker in its Part Studio", () => {
    // A fixed Base 5 mm thick, a Plate fastened on top, a hole drilled through the Plate, a Pin mated into the hole.
    const base = feature("box", { width: 40, depth: 40, height: 5 });
    const plate2 = feature("box", { width: 40, depth: 40, height: 5, x: 100 });
    const pin2 = feature("cylinder", { diameter: 6, height: 20, x: 200 });
    const built = (h: number) => engine.rebuild([{ ...base, params: { ...base.params, height: String(h) } }, plate2, pin2]).parts;
    let list = built(5);
    const face = (id: string, n: number, z: number) => {
      const m = list.find((p) => p.id === id)!;
      return { partId: id, ref: m.faceRefs.find((f) => f.surface === "PLANE" && Math.abs(f.normal[2] - n) < 1e-6 && Math.abs(f.center[2] - z) < 1e-6)! };
    };
    const fasten: Mate = { id: "m0", name: "Fastened 1", type: "fastened", a: { instanceId: "b", pick: face(base.id, 1, 5) }, b: { instanceId: "p", pick: face(plate2.id, -1, 0) }, flip: false, values: {} };
    let asm: Assembly = {
      id: "U",
      name: "Upstream",
      instances: [
        { id: "b", partId: base.id, name: "Base <1>", placement: at(0, 0, 0), fixed: true },
        { id: "p", partId: plate2.id, name: "Plate <1>", placement: at(0, 0, 0), fixed: false },
        { id: "n", partId: pin2.id, name: "Pin <1>", placement: at(-250, 0, 0), fixed: false },
      ],
      mates: [fasten],
    };
    // Where the Plate goes, kept (as the app does after a mate is made), then drilled there.
    const placed = solveWithParts(asm, list, { assemblies: [asm] });
    expect(placed.mateErrors).toEqual({});
    asm = { ...asm, instances: asm.instances.map((i) => ({ ...i, placement: placed.placements[i.id] ?? i.placement })) };
    asm = setFeatureParts(drill(asm, 20, 20, 10), "h1", ["p"]);
    const cutWall = engine.assemblyCuts(instancesForKernel(asm, list, [asm])).meshes.find((m) => m.id === "p")!.faceRefs.find((f) => f.surface === "CYLINDRE")!;
    const pinSide = list.find((p) => p.id === pin2.id)!.faceRefs.find((f) => f.surface === "CYLINDRE")!;
    asm = { ...asm, mates: [fasten, { id: "m1", name: "Cylindrical 1", type: "cylindrical", a: { instanceId: "p", pick: { partId: plate2.id, ref: cutWall } }, b: { instanceId: "n", pick: { partId: pin2.id, ref: pinSide } }, flip: false, values: {} }] };
    const before = solveWithParts(asm, list, { assemblies: [asm], cutMeshes: cutsOfIn([asm], list) });
    expect(before.mateErrors).toEqual({});
    expect(before.placements.n.position[0] + 200).toBeCloseTo(20, 4);
    // The Base made 8 mm thick: the Plate lifts to sit on it, its hole goes with it, and the pin stays in the hole.
    list = built(8);
    const after = solveWithParts(asm, list, { assemblies: [asm], cutMeshes: cutsOfIn([asm], list) });
    expect(after.mateErrors).toEqual({});
    expect(after.placements.p.position[2] - before.placements.p.position[2]).toBeCloseTo(3, 4);
    expect(after.placements.n.position[0] + 200).toBeCloseTo(20, 4);
    expect(after.placements.n.position[1]).toBeCloseTo(20, 4);
    // Solving again gives the same answer.
    expect(solveWithParts(asm, list, { assemblies: [asm], cutMeshes: cutsOfIn([asm], list) }).placements).toEqual(after.placements);
    // (The engine back to the parts the other cases use.)
    parts = engine.rebuild([plate, pin]).parts;
  });

  it("a pin mated into the hole of a part that stays put goes in", () => {
    const asm: Assembly = {
      ...drill(
        {
          id: "A",
          name: "A",
          instances: [
            { id: "i1", partId: plate.id, name: "Plate <1>", placement: at(0, 0, 0), fixed: true },
            { id: "i2", partId: pin.id, name: "Pin <1>", placement: at(-30, 7, 0), fixed: false },
          ],
        },
        20,
        12,
        5,
      ),
      mates: [{ id: "m1", name: "Cylindrical 1", type: "cylindrical", a: { instanceId: "i1", pick: wall }, b: { instanceId: "i2", pick: side }, flip: false, values: {} }],
    };
    const solved = solveWithParts(asm, parts, { assemblies: [asm], cutMeshes: cutsOf([asm]) });
    expect(solved.mateErrors).toEqual({});
    expect(solved.placements.i2.position[0]).toBeCloseTo(20, 4);
  });

  const sub = (): Assembly => ({
    ...drill(
      {
        id: "S",
        name: "Sub",
        instances: [
          { id: "i1", partId: plate.id, name: "Plate <1>", placement: at(0, 0, 0), fixed: true },
          { id: "i2", partId: pin.id, name: "Pin <1>", placement: at(-30, 7, 0), fixed: false },
        ],
      },
      20,
      12,
      5,
    ),
    mates: [{ id: "m1", name: "Cylindrical 1", type: "cylindrical", a: { instanceId: "i1", pick: wall }, b: { instanceId: "i2", pick: side }, flip: false, values: {} }],
  });

  it("keeps a sub-assembly's own mate to its own drilled hole in the assembly using it", () => {
    const s = sub();
    const parent: Assembly = { id: "P", name: "Parent", instances: [{ id: "c1", partId: "", subAssembly: "S", name: "Sub <1>", placement: at(100, 0, 0), fixed: true }] };
    const assemblies = [s, parent];
    const cuts = cutsOf(assemblies);
    expect(solvedInside(s, parts, assemblies, [s.id], cuts).i2.position[0]).toBeCloseTo(20, 4);
    // Remembered for this design (as the app and the extension do), every solve and export finds them.
    rememberCutMeshes(assemblies, parts, cuts);
    const placed = instancesForKernel(parent, parts, assemblies);
    const p = placed.find((i) => i.id === "c1/i2")!;
    expect(p.position[0]).toBeCloseTo(120, 4);
    expect(p.position[1]).toBeCloseTo(12, 4);
  });

  it("finds a hole drilled inside a sub-assembly for a mate of the assembly using it", () => {
    const s = drill({ id: "S2", name: "Sub 2", instances: [{ id: "i1", partId: plate.id, name: "Plate <1>", placement: at(0, 0, 0), fixed: true }] }, 20, 12, 5, "h2");
    const parent: Assembly = {
      id: "P2",
      name: "Parent 2",
      instances: [
        { id: "c1", partId: "", subAssembly: "S2", name: "Sub <1>", placement: at(100, 0, 0), fixed: true },
        { id: "c2", partId: pin.id, name: "Pin <1>", placement: at(0, -50, 0), fixed: false },
      ],
      mates: [{ id: "m1", name: "Cylindrical 1", type: "cylindrical", a: { instanceId: "c1", path: ["i1"], pick: wall }, b: { instanceId: "c2", pick: side }, flip: false, values: {} }],
    };
    const assemblies = [s, parent];
    expect(solveWithParts(parent, parts, { assemblies }).mateErrors.m1).toBeDefined();
    const solved = solveWithParts(parent, parts, { assemblies, cutMeshes: cutsOf(assemblies) });
    expect(solved.mateErrors).toEqual({});
    expect(solved.placements.c2.position[0]).toBeCloseTo(120, 4);
    expect(solved.placements.c2.position[1]).toBeCloseTo(12, 4);
  });

  it("takes the parts it reaches now with a pin already in the hole without breaking", () => {
    let asm: Assembly = drill(
      {
        id: "A3",
        name: "A3",
        instances: [
          { id: "i1", partId: plate.id, name: "Plate <1>", placement: at(0, 0, 0), fixed: true },
          { id: "i2", partId: pin.id, name: "Pin <1>", placement: at(20, 12, -5), fixed: true },
        ],
      },
      20,
      12,
      5,
    );
    asm = setFeatureParts(asm, "h1", ["i1"]);
    // "The parts it reaches now": every top-level copy tried once, and what it really cut kept.
    const r = engine.assemblyCuts(instancesForKernel(setFeatureParts(asm, "h1", null), parts, [asm]));
    expect(r.reached.h1).toContain("i1");
    asm = setFeatureParts(asm, "h1", r.reached.h1);
    const again = engine.assemblyCuts(instancesForKernel(asm, parts, [asm]));
    expect(again.cut).toContain("i1");
    for (const m of again.meshes) expect(m.volume ?? 0).toBeGreaterThan(0);
    // The geometry still works afterwards.
    expect(engine.rebuild([plate, pin]).parts.length).toBe(2);
  });
});
