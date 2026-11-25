/**
 * Measure and Mass properties in an assembly, on the real OpenCascade engine: copies measured where they're
 * placed (moved, turned, mirrored), cut copies weighed as cut, and the whole thing's centre of mass.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { assemblyHole, assemblySketch } from "../src/assembly/assemblyFeatures";
import { copiesToWeigh } from "../src/assembly/asmMeasure";
import { quatFromAxisAngle } from "../src/assembly/math";
import { instancesForKernel } from "../src/assembly/placed";
import { GeometryEngine } from "../src/kernel/engine";
import type { InstanceInput, PartMesh } from "../src/kernel/protocol";
import { massSummary } from "../src/model/massProps";
import type { Assembly } from "../src/model/types";
import { addPoint } from "../src/sketch/ops";
import { planeOnFace } from "../src/sketch/planes";
import { emptySketch } from "../src/sketch/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

type V3 = [number, number, number];
const at = (x: number, y: number, z: number, q: [number, number, number, number] = [0, 0, 0, 1]) => ({ position: [x, y, z] as V3, rotation: q });

describe("measure and mass in an assembly", () => {
  const engine = new GeometryEngine();
  // A 10 × 20 × 30 box with its corner on the origin.
  const box = feature("box", { width: 10, depth: 20, height: 30 });
  let parts: PartMesh[] = [];
  beforeAll(() => {
    parts = engine.rebuild([box]).parts;
  });
  const partId = () => parts[0].id;
  const face = (nx: number, ny = 0, nz = 0) => ({ partId: partId(), ref: parts[0].faceRefs.find((f) => f.kind === "face" && Math.abs(f.normal[0] - nx) + Math.abs(f.normal[1] - ny) + Math.abs(f.normal[2] - nz) < 1e-6)! });

  function twoBoxes(): Assembly {
    return {
      id: "A",
      name: "Assembly 1",
      instances: [
        { id: "i1", partId: partId(), name: "Box <1>", placement: at(0, 0, 0), fixed: true },
        { id: "i2", partId: partId(), name: "Box <2>", placement: at(50, 0, 0), fixed: true },
      ],
    };
  }

  it("measures the gap between faces of two placed copies, and their centres", () => {
    const inputs = instancesForKernel(twoBoxes(), parts);
    // The +X face of copy 1 (x = 10) and the -X face of copy 2 (x = 50): 40 apart.
    const m = engine.measure([face(1), face(-1)], inputs, ["i1", "i2"]);
    expect(m.items).toHaveLength(2);
    expect(m.distance).toBeCloseTo(40, 6);
    expect(m.closest![1][0]).toBeCloseTo(50, 6);
    expect(m.angle).toBeCloseTo(0, 6);
    // The same face on both copies: the copies' faces are 50 apart.
    const same = engine.measure([face(1), face(1)], inputs, ["i1", "i2"]);
    expect(same.distance).toBeCloseTo(50, 6);
    // Whole copies: the gap between them.
    expect(engine.measureParts(["i1", "i2"], inputs).distance).toBeCloseTo(40, 6);
  });

  it("measures a turned copy where it sits (angle between faces, a corner's X/Y/Z)", () => {
    const asm = twoBoxes();
    asm.instances[1] = { ...asm.instances[1], placement: at(100, 0, 0, quatFromAxisAngle([0, 0, 1], Math.PI / 2)) };
    const inputs = instancesForKernel(asm, parts);
    // Copy 2's +X face now faces +Y: square to copy 1's +X face.
    const m = engine.measure([face(1), face(1)], inputs, ["i1", "i2"]);
    expect(m.angle).toBeCloseTo(90, 6);
    // The box's far corner (10, 20, 30) on copy 2 turned a quarter about Z and moved: (100 − 20, 10, 30).
    const corner = { partId: partId(), ref: { kind: "vertex" as const, p: [10, 20, 30] as V3, rel: [1, 1, 1] as V3, dirs: [[-1, 0, 0], [0, -1, 0], [0, 0, -1]] as V3[] } };
    const c = engine.measure([corner], inputs, ["i2"]);
    expect(c.items[0].point![0]).toBeCloseTo(80, 6);
    expect(c.items[0].point![1]).toBeCloseTo(10, 6);
    expect(c.items[0].point![2]).toBeCloseTo(30, 6);
  });

  it("weighs the assembly: the sum of its copies, the centre of mass where they're placed", () => {
    const inputs = instancesForKernel(twoBoxes(), parts);
    const props = engine.massProperties([], inputs);
    expect(props.map((p) => p.partId).sort()).toEqual(["i1", "i2"]);
    const s = massSummary(props, () => 1.24);
    expect(s.volume).toBeCloseTo(12000, 4);
    expect(s.mass).toBeCloseTo(2 * 6 * 1.24, 6);
    // Centres at x 5 and 55: the whole thing's at 30.
    expect(s.centre![0]).toBeCloseTo(30, 5);
    expect(s.centre![1]).toBeCloseTo(10, 5);
    expect(s.centre![2]).toBeCloseTo(15, 5);
    expect(s.box![1][0] - s.box![0][0]).toBeCloseTo(60, 4);
    // Copy 2 in steel: the centre moves towards it.
    const heavy = massSummary(props, (id) => (id === "i2" ? 7.85 : 1.24));
    expect(heavy.centre![0]).toBeCloseTo((1.24 * 5 + 7.85 * 55) / (1.24 + 7.85), 5);
    // Only one copy picked.
    const one = copiesToWeigh(inputs, ["i2"], []);
    expect(one.instances.map((i) => i.id)).toEqual(["i2"]);
    expect(engine.massProperties([], one.instances)[0].centre[0]).toBeCloseTo(55, 5);
  });

  it("a mirrored copy weighs the same (volume positive), its centre mirrored", () => {
    const asm = twoBoxes();
    asm.instances[1] = { ...asm.instances[1], mirrored: true };
    const inputs: InstanceInput[] = instancesForKernel(asm, parts);
    expect(inputs.find((i) => i.id === "i2")!.mirrored).toBe(true);
    const props = engine.massProperties([], inputs);
    const m = props.find((p) => p.partId === "i2")!;
    expect(m.volume).toBeCloseTo(6000, 4);
    // Flipped across its own YZ plane (x → −x), then moved 50: centre at 45.
    expect(m.centre[0]).toBeCloseTo(45, 5);
    // The copy spans x 40…50; its own +X face is now at x = 40, 30 from copy 1's +X face (x = 10).
    const d = engine.measure([face(1), face(1)], inputs, ["i1", "i2"]);
    expect(d.distance).toBeCloseTo(30, 6);
  });

  it("a copy drilled by an assembly feature weighs less, and its hole can be measured", () => {
    let asm = twoBoxes();
    const data = addPoint(emptySketch(), { x: 55, y: 10 }).sketch;
    const sketch = assemblySketch(asm, planeOnFace([0, 0, 1], [0, 0, 30], "Top of Box <2>"), data, "s1");
    asm = { ...asm, features: [sketch] };
    const hole = assemblyHole(asm, sketch.id, { diameter: 6, throughAll: true }, "h1");
    asm = { ...asm, features: [sketch, hole], featureParts: { h1: ["i2"] } };
    const inputs = instancesForKernel(asm, parts);
    const props = engine.massProperties([], inputs);
    const plain = props.find((p) => p.partId === "i1")!;
    const cut = props.find((p) => p.partId === "i2")!;
    expect(plain.volume).toBeCloseTo(6000, 4);
    expect(cut.volume).toBeCloseTo(6000 - Math.PI * 9 * 30, 1);
    // The hole's wall, picked on the cut copy as shown (in the part's own coordinates: x 5, y 10).
    const wall = { partId: partId(), ref: { kind: "face" as const, surface: "CYLINDRE", center: [5, 10, 15] as V3, normal: [1, 0, 0] as V3 } };
    const m = engine.measure([wall], inputs, ["i2"]);
    expect(m.items[0].radius).toBeCloseTo(3, 6);
    expect(m.items[0].centre![0]).toBeCloseTo(55, 4);
  });
  it("copies inside a sub-assembly are weighed and measured where they sit in the parent", () => {
    const inner = twoBoxes();
    const outer: Assembly = { id: "B", name: "Assembly 2", instances: [{ id: "s1", partId: "", subAssembly: "A", name: "Assembly 1 <1>", placement: at(0, 100, 0), fixed: true }] };
    const inputs = instancesForKernel(outer, parts, [inner, outer]);
    expect(inputs.map((i) => i.id).sort()).toEqual(["s1/i1", "s1/i2"]);
    const s = massSummary(engine.massProperties([], inputs), () => 1);
    expect(s.volume).toBeCloseTo(12000, 4);
    expect(s.centre![0]).toBeCloseTo(30, 5);
    expect(s.centre![1]).toBeCloseTo(110, 5);
    const m = engine.measure([face(1), face(-1)], inputs, ["s1/i1", "s1/i2"]);
    expect(m.distance).toBeCloseTo(40, 6);
    expect(m.closest![0][1]).toBeGreaterThanOrEqual(100 - 1e-6);
  });
});

