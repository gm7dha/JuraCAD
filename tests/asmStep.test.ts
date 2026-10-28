/**
 * Assembly STEP files with their structure kept (the real OpenCascade engine):
 * each part written once and every copy pointing at it, sub-assemblies as
 * sub-assemblies, instance names and places — checked by reading the file
 * back, and against the flat export of the same assembly.
 */
import { measureShapeVolumeProperties, type Shape3D } from "replicad";
import { beforeAll, describe, expect, it } from "vitest";

import { quatFromAxisAngle, type Placement } from "../src/assembly/math";
import { stepPartCount, stepTree } from "../src/assembly/stepTree";
import { kernelInstances, leavesOf } from "../src/assembly/subassembly";
import { GeometryEngine } from "../src/kernel/engine";
import { importSolids } from "../src/kernel/importer";
import type { Assembly, Instance } from "../src/model/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

const at = (position: [number, number, number], rotation: Placement["rotation"] = [0, 0, 0, 1]): Placement => ({ position, rotation });
const inst = (id: string, partId: string, name: string, placement: Placement, extra: Partial<Instance> = {}): Instance => ({ id, partId, name, placement, fixed: true, ...extra });

/** Each solid read back: its volume and middle (mm), in a fixed order for comparing. */
function solidsOf(text: string): { volume: number; centre: number[] }[] {
  const solids = importSolids({ fileName: "a.step", format: "step", data: text, units: "mm" });
  const out = solids.map((s: Shape3D) => {
    const p = measureShapeVolumeProperties(s);
    const r = { volume: p.volume, centre: [...p.centerOfMass] };
    p.delete();
    s.delete();
    return r;
  });
  return out.sort((a, b) => Math.round(a.volume - b.volume) || a.centre[0] - b.centre[0] || a.centre[1] - b.centre[1] || a.centre[2] - b.centre[2]);
}

const count = (text: string, word: string) => text.split(word).length - 1;

describe("structured assembly STEP files", () => {
  it("keeps sub-assemblies, shares part definitions and puts every copy in its place", async () => {
    const engine = new GeometryEngine();
    const box = { ...feature("box", { width: 10, depth: 20, height: 5, x: 5 }), name: "Bracket" };
    const pin = { ...feature("cylinder", { diameter: 6, height: 30 }), name: "Pin" };
    const parts = engine.rebuild([box, pin]).parts;
    expect(parts.length).toBe(2);
    const [bracket, rod] = [parts.find((p) => p.featureIds.includes(box.id))!, parts.find((p) => p.featureIds.includes(pin.id))!];
    const hinge: Assembly = {
      id: "sub",
      name: "Hinge",
      instances: [inst("h1", bracket.id, "Bracket <1>", at([0, 0, 0])), inst("h2", rod.id, "Pin <1>", at([0, 0, 5]))],
    };
    const machine: Assembly = {
      id: "top",
      name: "Machine",
      instances: [
        inst("t1", "", "Hinge <1>", at([100, 0, 0], quatFromAxisAngle([0, 0, 1], Math.PI / 2)), { subAssembly: "sub" }),
        inst("t2", "", "Hinge <2>", at([0, 50, 0]), { subAssembly: "sub" }),
        inst("t3", bracket.id, "Bracket <2>", at([0, 0, -20], quatFromAxisAngle([1, 0, 0], 0.3))),
        inst("t4", bracket.id, "Bracket <3>", at([-40, 0, 0]), { mirrored: true }),
        inst("t5", rod.id, "Pin <2>", at([0, 0, 200]), { suppressed: true }),
      ],
    };
    const assemblies = [machine, hinge];
    const tops = Object.fromEntries(machine.instances.map((i) => [i.id, i.placement]));
    const tree = stepTree(machine, parts, tops, assemblies)!;
    expect(Object.keys(tree.parts).length).toBe(3);
    expect(Object.keys(tree.assemblies).sort()).toEqual(["sub", "top"]);
    expect(stepPartCount(tree)).toBe(6);

    const structured = await engine.exportStep([], { [box.id]: "#ff8000" }, undefined, tree);
    expect(structured.partCount).toBe(6);
    const text = new TextDecoder().decode(structured.step);
    // The structure: two assemblies, each part written once (three shapes for six parts), six placed components with their names.
    expect(count(text, "MANIFOLD_SOLID_BREP(")).toBe(3);
    expect(count(text, "NEXT_ASSEMBLY_USAGE_OCCURRENCE(")).toBe(6);
    for (const name of ["Machine", "Hinge", bracket.name, rod.name, `${bracket.name} (mirrored)`]) expect(text).toContain(`PRODUCT('${name}'`);
    for (const name of ["Hinge <1>", "Hinge <2>", "Bracket <1>", "Pin <1>", "Bracket <2>", "Bracket <3>"]) expect(text).toContain(`'${name}'`);
    expect(text).not.toContain("'Pin <2>'");
    // The bracket's colour comes along.
    const colours = [...text.replace(/\s+/g, "").matchAll(/COLOUR_RGB\('[^']*',([-\d.Ee+]+),([-\d.Ee+]+),([-\d.Ee+]+)\)/g)].map((m) => m.slice(1, 4).map(Number));
    expect(colours.some(([r, g, b]) => Math.abs(r - 1) < 0.01 && Math.abs(g - 128 / 255) < 0.01 && Math.abs(b) < 0.01)).toBe(true);
    // The hinge is used twice but defined once: both its copies point at the same product.
    const uses = [...text.matchAll(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\('\d+','Hinge <\d>','',(#\d+),(#\d+)/g)];
    expect(uses.length).toBe(2);
    expect(uses[0][2]).toBe(uses[1][2]);

    // Read back: the same six solids, the same sizes, in the same places as the flat export of the same assembly.
    const back = solidsOf(text);
    const flat = await engine.exportStep([], {}, kernelInstances(leavesOf(machine, parts, assemblies), parts, tops, (id) => tops[id]));
    expect(flat.partCount).toBe(6);
    const expected = solidsOf(new TextDecoder().decode(flat.step));
    expect(back.length).toBe(6);
    back.forEach((s, k) => {
      expect(s.volume).toBeCloseTo(expected[k].volume, 4);
      s.centre.forEach((v, j) => expect(v).toBeCloseTo(expected[k].centre[j], 4));
    });
    expect(back.filter((s) => Math.abs(s.volume - 1000) < 1e-6).length).toBe(4);
    // The mirror image of the bracket (x 5…15 flipped to −15…−5), moved 40 mm along −X.
    const mirrored = back.find((s) => Math.abs(s.centre[0] + 50) < 1e-6);
    expect(mirrored?.centre[1]).toBeCloseTo(10, 6);
    expect(mirrored?.centre[2]).toBeCloseTo(2.5, 6);
    // The first hinge turned a quarter turn: its bracket's middle (10, 10, 2.5) lands at (90, 10, 2.5).
    expect(back.some((s) => Math.abs(s.centre[0] - 90) < 1e-6 && Math.abs(s.centre[1] - 10) < 1e-6)).toBe(true);
    // The STEP file is smaller than the flat one, which repeats every copy's shape.
    expect(structured.step.byteLength).toBeLessThan(flat.step.byteLength);
  });
});
