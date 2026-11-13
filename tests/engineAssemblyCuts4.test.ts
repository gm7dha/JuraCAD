/**
 * A drilled part moved by a Part Studio change (own file for OpenCascade's memory): the base a plate is fastened to
 * made wider slides the plate along, and a pin mated into the hole the assembly drilled must stay in the hole that's
 * shown. The drilled copies are stored where the solve now puts them (settleCutCopies), so the solver's cut copy and
 * the one shown agree.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { assemblyHole, assemblySketch, setFeatureParts } from "../src/assembly/assemblyFeatures";
import { settleCutCopies, settleCutCopiesIn } from "../src/assembly/cutSettle";
import { solveWithParts } from "../src/assembly/mates";
import { cutMeshesFrom, instancesForKernel, storedCutInputs } from "../src/assembly/placed";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh } from "../src/kernel/protocol";
import { emptyDocument } from "../src/model/document";
import type { Assembly, Mate } from "../src/model/types";
import { addPoint } from "../src/sketch/ops";
import { planeOnFace } from "../src/sketch/planes";
import { emptySketch } from "../src/sketch/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

const at = (x: number, y: number, z: number) => ({ position: [x, y, z] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] });

describe("a drilled part moved by an upstream change", () => {
  const engine = new GeometryEngine();
  const base = feature("box", { width: 40, depth: 40, height: 5 });
  const plate = feature("box", { width: 20, depth: 20, height: 5, x: 100 });
  const pin = feature("cylinder", { diameter: 6, height: 20, x: 200 });
  const built = (w: number) => engine.rebuild([{ ...base, params: { ...base.params, width: String(w) } }, plate, pin]).parts;
  const cutsOf = (list: readonly Assembly[], parts: PartMesh[]) => cutMeshesFrom(engine.assemblyCuts(storedCutInputs(list, parts)).meshes);
  /** Where the hole shown is (in the assembly), from the copy cut where the solve puts the plate. */
  const shownHole = (asm: Assembly, parts: PartMesh[], solved: ReturnType<typeof solveWithParts>) => {
    const m = engine.assemblyCuts(instancesForKernel(asm, parts, [asm], solved)).meshes.find((x) => x.id === "p")!;
    const c = m.faceRefs.find((f) => f.surface === "CYLINDRE")!.center;
    return [c[0] + solved.placements.p.position[0], c[1] + solved.placements.p.position[1]];
  };

  it("keeps a pin in the hole shown when the base is widened 40 → 46 mm and the centred plate slides 3 mm", () => {
    let list = built(40);
    const face = (id: string, n: number, z: number) => {
      const m = list.find((p) => p.id === id)!;
      return { partId: id, ref: m.faceRefs.find((f) => f.surface === "PLANE" && Math.abs(f.normal[2] - n) < 1e-6 && Math.abs(f.center[2] - z) < 1e-6)! };
    };
    // The plate fastened centred on the base's top (face middles), so it follows the base's middle.
    const fasten: Mate = { id: "m0", name: "Fastened 1", type: "fastened", a: { instanceId: "b", pick: face(base.id, 1, 5) }, b: { instanceId: "p", pick: face(plate.id, -1, 0) }, flip: false, values: {} };
    let asm: Assembly = {
      id: "U",
      name: "Upstream",
      instances: [
        { id: "b", partId: base.id, name: "Base <1>", placement: at(0, 0, 0), fixed: true },
        { id: "p", partId: plate.id, name: "Plate <1>", placement: at(0, 0, 0), fixed: false },
        { id: "n", partId: pin.id, name: "Pin <1>", placement: at(-250, 0, 0), fixed: false },
      ],
      mates: [fasten],
    };
    const placed = solveWithParts(asm, list, { assemblies: [asm] });
    expect(placed.mateErrors).toEqual({});
    asm = { ...asm, instances: asm.instances.map((i) => ({ ...i, placement: placed.placements[i.id] ?? i.placement })) };
    expect(asm.instances[1].placement.position[0]).toBeCloseTo(-90, 4);
    // A hole drilled through the plate at (22, 20), off its middle.
    const sk = assemblySketch(asm, planeOnFace([0, 0, 1], [0, 0, 10], "Top"), addPoint(emptySketch(), { x: 22, y: 20 }).sketch, "s_h1");
    asm = setFeatureParts({ ...asm, features: [sk, assemblyHole({ features: [sk] }, sk.id, { diameter: 6, throughAll: true }, "h1")] }, "h1", ["p"]);
    const wall = engine.assemblyCuts(instancesForKernel(asm, list, [asm])).meshes.find((m) => m.id === "p")!.faceRefs.find((f) => f.surface === "CYLINDRE")!;
    const side = list.find((p) => p.id === pin.id)!.faceRefs.find((f) => f.surface === "CYLINDRE")!;
    asm = { ...asm, mates: [fasten, { id: "m1", name: "Cylindrical 1", type: "cylindrical", a: { instanceId: "p", pick: { partId: plate.id, ref: wall } }, b: { instanceId: "n", pick: { partId: pin.id, ref: side } }, flip: false, values: {} }] };
    const before = solveWithParts(asm, list, { assemblies: [asm], cutMeshes: cutsOf([asm], list) });
    expect(before.mateErrors).toEqual({});
    expect(before.placements.n.position[0] + 200).toBeCloseTo(22, 4);
    expect(settleCutCopies([asm], list, cutsOf([asm], list))).toEqual([asm]);

    // The base made 46 wide: the plate slides 3 mm along X, the hole shown stays where it was drilled.
    list = built(46);
    const stale = solveWithParts(asm, list, { assemblies: [asm], cutMeshes: cutsOf([asm], list) });
    expect(stale.placements.p.position[0]).toBeCloseTo(-87, 4);
    expect(shownHole(asm, list, stale)[0]).toBeCloseTo(22, 4);
    // (Without settling, the solver's copy is still cut where the plate is stored: the pin would sit 3 mm off the hole.)
    expect(stale.placements.n.position[0] + 200).toBeCloseTo(25, 4);

    const assemblies = settleCutCopies([asm], list, cutsOf([asm], list));
    const settled = assemblies[0];
    expect(settled).not.toBe(asm);
    expect(settled.instances.find((i) => i.id === "p")!.placement.position[0]).toBeCloseTo(-87, 4);
    // Only the drilled copy is stored again; the pin and the fixed base keep theirs.
    expect(settled.instances.find((i) => i.id === "n")).toBe(asm.instances.find((i) => i.id === "n"));
    expect(settled.instances.find((i) => i.id === "b")).toBe(asm.instances.find((i) => i.id === "b"));
    const after = solveWithParts(settled, list, { assemblies, cutMeshes: cutsOf(assemblies, list) });
    expect(after.mateErrors).toEqual({});
    const hole = shownHole(settled, list, after);
    expect(hole[0]).toBeCloseTo(22, 4);
    expect(after.placements.n.position[0] + 200).toBeCloseTo(hole[0], 4);
    expect(after.placements.n.position[1]).toBeCloseTo(hole[1], 4);
    // Once: a settled state settles to itself, and a document with nothing to settle is the same document.
    expect(settleCutCopies(assemblies, list, cutsOf(assemblies, list))).toBe(assemblies);
    const doc = { ...emptyDocument("D"), assemblies: [...assemblies] };
    expect(settleCutCopiesIn(doc, list, cutsOf(assemblies, list))).toBe(doc);
  });
});
