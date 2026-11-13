/**
 * More assembly features and Edit in context on real parts (own file for
 * OpenCascade's memory): a sub-assembly's own holes carried up to its parents,
 * structured STEP sharing copies a cut doesn't reach, mating a pin into a hole
 * the assembly drilled, the parts list's weight of a cut copy, and two Part
 * Studios each edited in the context of the other.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { assemblyHole, assemblySketch, modifiedCopies } from "../src/assembly/assemblyFeatures";
import { billOfMaterials } from "../src/assembly/assembly";
import { contextInputs, contextPartId, takeContext } from "../src/assembly/inContext";
import { solveWithParts } from "../src/assembly/mates";
import { cutMeshesFrom, cutsInsideSubAssemblies, instancesForKernel, storedCutInputs } from "../src/assembly/placed";
import { stepTree } from "../src/assembly/stepTree";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh, StudioInput } from "../src/kernel/protocol";
import { emptyDocument } from "../src/model/document";
import type { Assembly, JuraCADDocument } from "../src/model/types";
import { linkEdge } from "../src/sketch/links";
import { addPoint } from "../src/sketch/ops";
import { planeOnFace } from "../src/sketch/planes";
import { emptySketch } from "../src/sketch/types";
import { feature, loadOpenCascade, sketchFeature } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

const at = (x: number, y: number, z: number) => ({ position: [x, y, z] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] });

/** A 6 mm hole drilled down through everything at (x, y), from a sketch at height z. */
const drill = (asm: Assembly, x: number, y: number, z: number, id = "h1"): Assembly => {
  const sk = assemblySketch(asm, planeOnFace([0, 0, 1], [0, 0, z], "Top"), addPoint(emptySketch(), { x, y }).sketch, `s_${id}`);
  const h = assemblyHole({ features: [sk] }, sk.id, { diameter: 6, throughAll: true }, id);
  return { ...asm, features: [...(asm.features ?? []), sk, h] };
};
const HOLE = Math.PI * 9;

describe("assembly features, more", () => {
  const engine = new GeometryEngine();
  const plate = feature("box", { width: 40, depth: 40, height: 5 });
  const far = feature("box", { width: 10, depth: 10, height: 10, x: 200 });
  const pin = feature("cylinder", { diameter: 6, height: 20 });
  let parts: PartMesh[] = [];
  beforeAll(() => {
    parts = engine.rebuild([plate, far, pin]).parts;
  });

  it("carries a sub-assembly's own holes up to the assembly using it, in each copy's place", () => {
    const sub = drill({ id: "S", name: "Sub", instances: [{ id: "j1", partId: plate.id, name: "Plate <1>", placement: at(0, 0, 0), fixed: true }] }, 20, 20, 5);
    const parent: Assembly = {
      id: "P",
      name: "Parent",
      instances: [
        { id: "c1", partId: "", subAssembly: "S", name: "Sub <1>", placement: at(0, 0, 0), fixed: true },
        { id: "c2", partId: "", subAssembly: "S", name: "Sub <2>", placement: at(100, 0, 0), fixed: true },
      ],
    };
    const inputs = instancesForKernel(parent, parts, [sub, parent]);
    expect(inputs.map((i) => [i.id, i.cuts?.length ?? 0])).toEqual([
      ["c1/j1", 1],
      ["c2/j1", 1],
    ]);
    const r = engine.assemblyCuts(inputs);
    expect(r.cut.sort()).toEqual(["c1/j1", "c2/j1"]);
    // Each copy has its hole at (20, 20) in its own coordinates, though the second sits 100 along.
    for (const m of r.meshes) {
      expect(m.volume).toBeCloseTo(8000 - HOLE * 5, 2);
      expect(m.faceRefs.find((f) => f.surface === "CYLINDRE")!.center.slice(0, 2).map((v) => Math.round(v * 1000) / 1000)).toEqual([20, 20]);
    }
    // The parts list of the parent says they're modified; a STEP keeping the structure couldn't show it, so it's flat.
    const bom = billOfMaterials(parent, { [plate.id]: "Plate" }, {}, undefined, {}, { assemblies: [sub, parent], modified: modifiedCopies(r) });
    expect(bom.map((b) => [b.name, b.quantity])).toEqual([["Plate (modified in assembly)", 2]]);
    expect(cutsInsideSubAssemblies(parent, parts, [sub, parent])).toBe(true);
  });

  it("writes copies the cut doesn't reach as the shared plain part in a structured STEP", async () => {
    const asm = drill(
      {
        id: "A",
        name: "A",
        instances: [
          { id: "i1", partId: plate.id, name: "Plate <1>", placement: at(0, 0, 0), fixed: true },
          { id: "i2", partId: plate.id, name: "Plate <2>", placement: at(100, 0, 0), fixed: true },
          { id: "i3", partId: plate.id, name: "Plate <3>", placement: at(200, 0, 0), fixed: true },
        ],
      },
      20,
      20,
      5,
    );
    const r = engine.assemblyCuts(instancesForKernel(asm, parts));
    expect(r.cut).toEqual(["i1"]);
    const tree = stepTree(asm, parts, { i1: at(0, 0, 0), i2: at(100, 0, 0), i3: at(200, 0, 0) })!;
    const step = await engine.exportStep([], {}, undefined, tree);
    const text = new TextDecoder().decode(step.step);
    // Three copies placed, but only two shapes written: the cut one and the plain one the two untouched copies share.
    expect(step.partCount).toBe(3);
    expect(text.match(/MANIFOLD_SOLID_BREP/g)!.length).toBe(2);
    expect(text).toContain("(modified in assembly)");
  });

  it("weighs a modified copy as cut", () => {
    const asm = drill({ id: "A", name: "A", instances: [{ id: "i1", partId: plate.id, name: "Plate <1>", placement: at(0, 0, 0), fixed: true }] }, 20, 20, 5);
    const r = engine.assemblyCuts(instancesForKernel(asm, parts));
    const info = () => ({ material: "pla", volume: 8000 });
    const bom = billOfMaterials(asm, { [plate.id]: "Plate" }, {}, info, {}, { modified: modifiedCopies(r) });
    const plain = billOfMaterials(asm, { [plate.id]: "Plate" }, {}, info, {});
    expect(bom[0].massEach! / plain[0].massEach!).toBeCloseTo((8000 - HOLE * 5) / 8000, 4);
  });

  it("mates a pin into a hole the assembly drilled", () => {
    let asm: Assembly = drill(
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
    );
    const r = engine.assemblyCuts(instancesForKernel(asm, parts));
    const wall = r.meshes.find((m) => m.id === "i1")!.faceRefs.find((f) => f.surface === "CYLINDRE")!;
    const pinMesh = parts.find((p) => p.id === pin.id)!;
    const side = pinMesh.faceRefs.find((f) => f.surface === "CYLINDRE")!;
    asm = { ...asm, mates: [{ id: "m1", name: "Cylindrical 1", type: "cylindrical", a: { instanceId: "i1", pick: { partId: plate.id, ref: wall } }, b: { instanceId: "i2", pick: { partId: pin.id, ref: side } }, flip: false, values: {} }] };
    // Without the cut copies the hole's wall isn't there to mate to; with them, the pin goes into the hole.
    expect(solveWithParts(asm, parts).mateErrors.m1).toBeDefined();
    const cuts = cutMeshesFrom(engine.assemblyCuts(storedCutInputs([asm], parts)).meshes);
    const solved = solveWithParts(asm, parts, { cutMeshes: cuts });
    expect(solved.mateErrors).toEqual({});
    expect(solved.placements.i2.position[0]).toBeCloseTo(20, 4);
    expect(solved.placements.i2.position[1]).toBeCloseTo(12, 4);
  });
});

describe("two Part Studios edited in each other's context", () => {
  const plate = feature("box", { width: 40, depth: 40, height: 5 });
  const block = feature("box", { width: 10, depth: 10, height: 10 });
  const asm: Assembly = {
    id: "A",
    name: "A",
    instances: [
      { id: "i1", partId: plate.id, name: "Plate <1>", placement: at(0, 0, 0), fixed: true },
      { id: "i2", partId: block.id, name: "Block <1>", placement: at(0, 0, 5), fixed: true },
    ],
  };
  const inputs = (d: JuraCADDocument): StudioInput[] => [
    { id: "main", features: d.features, ...(contextInputs(d, "main") ? { contexts: contextInputs(d, "main") } : {}) },
    { id: "ps2", features: d.partStudios![0].features, ...(contextInputs(d, "ps2") ? { contexts: contextInputs(d, "ps2") } : {}) },
  ];
  const engine = new GeometryEngine();
  let doc: JuraCADDocument = { ...emptyDocument("x"), features: [plate], partStudios: [{ id: "ps2", name: "PS2", features: [block] }], assemblies: [asm] };

  it("shows each one's parts in the other", () => {
    const ps = engine.rebuildStudios(inputs(doc)).parts;
    const a = takeContext(doc, "A", "i1", ps, undefined, "ca");
    if ("error" in a) throw new Error(a.error);
    const b = takeContext(a.doc, "A", "i2", ps, undefined, "cb");
    if ("error" in b) throw new Error(b.error);
    doc = b.doc;
    const r = engine.rebuildStudios(inputs(doc));
    expect((r.contextParts ?? []).map((p) => [p.id, p.studioId]).sort()).toEqual([
      [contextPartId("ca", "i2"), "main"],
      [contextPartId("cb", "i1"), "ps2"],
    ]);
    // Built again with nothing changed: nothing placed again (and nothing lost).
    const again = engine.rebuildStudios(inputs(doc));
    expect(again.contextRebuilt).toBeUndefined();
  });

  it("each can use the other's edges — and where both do, says plainly that one can't be built first", () => {
    const r = engine.rebuildStudios(inputs(doc));
    expect(r.contextRebuilt ?? []).toEqual([]);
    // Edges brought in from the other one's parts, on each side.
    const ctxMeshes = (() => {
      // (the meshes were sent by the first build of this context; take them again from a fresh engine)
      const e2 = new GeometryEngine();
      return e2.rebuildStudios(inputs(doc)).contextParts!;
    })();
    const linked = (ctxId: string) => {
      const m = ctxMeshes.find((x) => x.id === ctxId)!;
      const ref = m.edgeRefs.find((e) => e.curve === "LINE" && Math.abs(e.a[2] - e.b[2]) < 1e-6)!;
      const used = engine.useEdge(m.id, ref, { kind: "face", origin: [0, 0, ref.a[2]], u: [1, 0, 0], v: [0, 1, 0], label: "level" });
      if ("error" in used) throw new Error(used.error);
      return { sketch: sketchFeature({ kind: "face", origin: [0, 0, ref.a[2]], u: [1, 0, 0], v: [0, 1, 0], label: "level" }, linkEdge(emptySketch(), used.edge, false).sketch) };
    };
    // Only the block's studio uses the plate: fine.
    const inBlock = linked(contextPartId("cb", "i1")).sketch;
    const one = { ...doc, partStudios: [{ ...doc.partStudios![0], features: [block, inBlock] }] };
    const r1 = engine.rebuildStudios(inputs(one));
    expect(r1.featureErrors[inBlock.id]).toBeUndefined();
    // Both use the other's: one of them can't be built first, and says why.
    const inPlate = linked(contextPartId("ca", "i2")).sketch;
    const both = { ...one, features: [plate, inPlate] };
    const r2 = engine.rebuildStudios(inputs(both));
    const said = [r2.featureErrors[inPlate.id], r2.featureErrors[inBlock.id]].filter(Boolean);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/neither can be built first/);
  });
});
