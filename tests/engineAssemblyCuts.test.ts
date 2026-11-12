/**
 * Assembly features on real parts (the OpenCascade engine runs in Node): a
 * hole drilled in an assembly through two plates cuts both copies there, in
 * exports and the clash check too, while the Part Studio's parts stay whole.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { assemblyExtrudeCut, assemblyHole, assemblySketch, cutsFor, setFeatureParts } from "../src/assembly/assemblyFeatures";
import { instancesForKernel } from "../src/assembly/placed";
import { billOfMaterials } from "../src/assembly/assembly";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh } from "../src/kernel/protocol";
import { readBinaryStl } from "../src/geometry/stl";
import type { Assembly, Feature } from "../src/model/types";
import { addPoint, addRectangle } from "../src/sketch/ops";
import { planeOnFace } from "../src/sketch/planes";
import { emptySketch } from "../src/sketch/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

/** Volume of a binary STL's triangles (mm³). */
function stlVolume(buffer: ArrayBuffer): number {
  const { vertices: v } = readBinaryStl(buffer);
  let sum = 0;
  for (let i = 0; i + 8 < v.length; i += 9) {
    sum += (v[i] * (v[i + 4] * v[i + 8] - v[i + 5] * v[i + 7]) - v[i + 1] * (v[i + 3] * v[i + 8] - v[i + 5] * v[i + 6]) + v[i + 2] * (v[i + 3] * v[i + 7] - v[i + 4] * v[i + 6])) / 6;
  }
  return Math.abs(sum);
}

const at = (x: number, y: number, z: number) => ({ position: [x, y, z] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] });

describe("assembly features", () => {
  const engine = new GeometryEngine();
  // A 40 × 40 × 5 plate, and a 40 × 40 × 4 one.
  const lower = feature("box", { width: 40, depth: 40, height: 5 });
  const upper = feature("box", { width: 40, depth: 40, height: 4 });
  let parts: PartMesh[] = [];
  beforeAll(() => {
    parts = engine.rebuild([lower, upper]).parts;
  });
  const plain = 40 * 40 * 5 + 40 * 40 * 4;

  /** The two plates stacked (the upper one 5 up), a 6 mm hole drilled down through both from the top. */
  function drilled(): { asm: Assembly; hole: Feature } {
    let asm: Assembly = {
      id: "A",
      name: "Assembly 1",
      instances: [
        { id: "i1", partId: lower.id, name: "Lower <1>", placement: at(0, 0, 0), fixed: true },
        { id: "i2", partId: upper.id, name: "Upper <1>", placement: at(0, 0, 5), fixed: true },
      ],
    };
    const data = addPoint(emptySketch(), { x: 20, y: 20 }).sketch;
    const sketch = assemblySketch(asm, planeOnFace([0, 0, 1], [0, 0, 9], "Top of Upper"), data, "s1");
    asm = { ...asm, features: [sketch] };
    const hole = assemblyHole(asm, sketch.id, { diameter: 6, throughAll: true }, "h1");
    return { asm: { ...asm, features: [sketch, hole] }, hole };
  }

  it("cuts both plates in the assembly, and leaves the Part Studio's parts whole", () => {
    const { asm } = drilled();
    const inputs = instancesForKernel(asm, parts);
    expect(inputs.every((i) => i.cuts?.length === 2)).toBe(true);
    const r = engine.assemblyCuts(inputs);
    expect(r.errors).toEqual({});
    expect(r.cut.sort()).toEqual(["i1", "i2"]);
    const holeArea = Math.PI * 9;
    const vols = r.meshes.map((m) => m.volume!);
    expect(vols.find((v) => Math.abs(v - (1600 * 5 - holeArea * 5)) < 0.01)).toBeDefined();
    expect(vols.find((v) => Math.abs(v - (1600 * 4 - holeArea * 4)) < 0.01)).toBeDefined();

    // Exports have the holes; the Part Studio's own export doesn't.
    const stl = engine.exportStl([], "fine", inputs);
    expect(stlVolume(stl.stl)).toBeCloseTo(plain - holeArea * 9, -1);
    expect(stlVolume(engine.exportStl([], "fine").stl)).toBeCloseTo(plain, 0);
    // The parts themselves are unchanged.
    expect(engine.rebuild([lower, upper]).parts.map((p) => p.volume)).toEqual(parts.map((p) => p.volume));
  });

  it("exports STEP with the holes", async () => {
    const { asm } = drilled();
    const step = await engine.exportStep([], {}, instancesForKernel(asm, parts));
    const text = new TextDecoder().decode(step.step);
    expect(text).toContain("CYLINDRICAL_SURFACE");
    const plainStep = new TextDecoder().decode((await engine.exportStep([], {}, instancesForKernel({ ...asm, features: [] }, parts))).step);
    expect(plainStep).not.toContain("CYLINDRICAL_SURFACE");
  });

  it("follows a copy moved by its placement: the hole stays where it was drawn in the assembly", () => {
    const { asm } = drilled();
    // The upper plate slid 30 along x: the hole (at x = 20) now meets only its first 10 mm, so it misses it.
    const moved: Assembly = { ...asm, instances: asm.instances.map((i) => (i.id === "i2" ? { ...i, placement: at(30, 0, 5) } : i)) };
    const r = engine.assemblyCuts(instancesForKernel(moved, parts));
    expect(r.cut).toEqual(["i1"]);
    // Slid 15 along x: the hole's still inside it, 15 mm nearer its left edge (x = 5 in the plate's own coordinates).
    const near: Assembly = { ...asm, instances: asm.instances.map((i) => (i.id === "i2" ? { ...i, placement: at(15, 0, 5) } : i)) };
    const m = engine.assemblyCuts(instancesForKernel(near, parts)).meshes.find((x) => x.id === "i2")!;
    const hole = m.faceRefs.find((f) => f.surface === "CYLINDRE");
    expect(hole).toBeDefined();
    expect(hole!.center[0]).toBeCloseTo(5, 3);
    expect(hole!.center[1]).toBeCloseTo(20, 3);
  });

  it("cuts only the chosen parts, and the parts list says which were changed", () => {
    const { asm, hole } = drilled();
    const one = setFeatureParts(asm, hole.id, ["i2"]);
    expect(cutsFor(one, "i1")).toBeUndefined();
    const r = engine.assemblyCuts(instancesForKernel(one, parts));
    expect(r.cut).toEqual(["i2"]);
    const clashes = engine.clashes(instancesForKernel(one, parts));
    expect(clashes.every((c) => c.volume < 1e-6)).toBe(true);
    const bom = billOfMaterials(one, { [lower.id]: "Lower", [upper.id]: "Upper" }, {}, undefined, {}, { modified: new Set(r.cut) });
    expect(bom.map((b) => b.name)).toEqual(["Lower", "Upper (modified in assembly)"]);
  });

  it("cuts a pocket with an Extrude that removes", () => {
    let asm: Assembly = { id: "B", name: "B", instances: [{ id: "i1", partId: lower.id, name: "Lower <1>", placement: at(0, 0, 0), fixed: true }] };
    const data = addRectangle(emptySketch(), { x: 10, y: 10 }, { x: 20, y: 30 }).sketch;
    const sketch = assemblySketch(asm, planeOnFace([0, 0, 1], [0, 0, 5], "Top"), data, "s2");
    asm = { ...asm, features: [sketch] };
    const cut = assemblyExtrudeCut(asm, sketch.id, { throughAll: false, depth: 2 }, "e2");
    asm = { ...asm, features: [sketch, cut] };
    const r = engine.assemblyCuts(instancesForKernel(asm, parts));
    expect(r.errors).toEqual({});
    expect(r.meshes[0].volume).toBeCloseTo(1600 * 5 - 10 * 20 * 2, 3);
  });

  it("drills through a mirrored copy where it sits", () => {
    const { asm } = drilled();
    const mirrored: Assembly = { ...asm, instances: asm.instances.map((i) => (i.id === "i2" ? { ...i, mirrored: true, placement: at(40, 0, 5) } : i)) };
    // The mirror image of the 0…40 plate is −40…0, placed at x 40: 0…40 again, so the hole goes through at x = 20.
    const r = engine.assemblyCuts(instancesForKernel(mirrored, parts));
    expect(r.cut.sort()).toEqual(["i1", "i2"]);
    const m = r.meshes.find((x) => x.id === "i2")!;
    expect(m.volume).toBeCloseTo(1600 * 4 - Math.PI * 9 * 4, 2);
    // The mesh is in the part's own (unmirrored) coordinates: x 40 − 20 = 20.
    expect(m.faceRefs.find((f) => f.surface === "CYLINDRE")!.center[0]).toBeCloseTo(20, 3);
  });
});
