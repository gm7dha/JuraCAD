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
  const cutsOf = (list: Assembly[]) => cutMeshesFrom(engine.assemblyCuts(storedCutInputs(list, parts)).meshes);

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
