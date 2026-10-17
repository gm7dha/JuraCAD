/**
 * Assemblies on real parts (the OpenCascade engine runs in Node): mates found
 * again after a part changes, mirrored parts dragged about the right hinge.
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { beforeAll, describe, expect, it } from "vitest";

import { planDrag } from "../src/assembly/drag";
import { connectorFrameFor, frameLookup, solveWithParts } from "../src/assembly/mates";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh } from "../src/kernel/protocol";
import { defaultParams } from "../src/model/features";
import type { Assembly, Feature, FeatureType, Mate } from "../src/model/types";

beforeAll(async () => {
  setOC(await opencascade());
});

let n = 0;
function feature(type: FeatureType, params: Record<string, number>): Feature {
  n++;
  return {
    id: `ae${n}`,
    name: `${type} ${n}`,
    type,
    operation: "new",
    suppressed: false,
    params: { ...defaultParams(type), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) },
  };
}

/** The flat face of a part pointing along `normal`. */
const face = (p: PartMesh, normal: number[]) => {
  const i = p.faceRefs.findIndex((r) => r.surface === "PLANE" && r.normal.every((v, k) => Math.abs(v - normal[k]) < 1e-6));
  return { partId: p.id, ref: p.faceRefs[i] };
};

const engine = new GeometryEngine();

describe("assemblies on real parts", () => {
  it("keeps a mate when the part it's on changes size", () => {
    const a = feature("box", { width: 10, depth: 10, height: 10 });
    const b = feature("box", { width: 20, depth: 20, height: 5, x: 50 });
    const parts = engine.rebuild([a, b]).parts;
    const asm: Assembly = {
      id: "A",
      name: "A",
      instances: [
        { id: "i1", partId: a.id, name: "a", placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: true },
        { id: "i2", partId: b.id, name: "b", placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: false },
      ],
      mates: [{ id: "m", name: "Fasten 1", type: "fastened", a: { instanceId: "i1", pick: face(parts[0], [0, 0, 1]) }, b: { instanceId: "i2", pick: face(parts[1], [0, 0, -1]) }, flip: false, values: {} }],
    };
    expect(solveWithParts(asm, parts).placements.i2.position[2]).toBeCloseTo(10, 6);
    // The block gets taller: the top face is found again, and the plate sits on it.
    const taller = engine.rebuild([{ ...a, params: { ...a.params, height: "15" } }, b]).parts;
    const r = solveWithParts(asm, taller);
    expect(r.mateErrors).toEqual({});
    expect(r.placements.i2.position[2]).toBeCloseTo(15, 6);
  });

  it("drags a mirrored part round its own hinge", () => {
    const a = feature("box", { width: 10, depth: 10, height: 10 });
    const b = feature("box", { width: 10, depth: 10, height: 10, x: 50 });
    const parts = engine.rebuild([a, b]).parts;
    // The mirrored part (shown flipped across its own YZ plane) is the mate's first part.
    const mate: Mate = { id: "h", name: "Hinge 1", type: "revolute", a: { instanceId: "B", pick: face(parts[1], [0, 0, -1]) }, b: { instanceId: "A", pick: face(parts[0], [0, 0, 1]) }, flip: false, values: { angle: "0" } };
    const asm: Assembly = {
      id: "S",
      name: "S",
      instances: [
        { id: "A", partId: a.id, name: "a", placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: true },
        { id: "B", partId: b.id, name: "b", placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: false, mirrored: true },
      ],
      mates: [mate],
    };
    const frame = connectorFrameFor(asm, parts, mate.a)!;
    expect(frame.origin[0]).toBeCloseTo(-55, 6);
    const solved = solveWithParts(asm, parts);
    expect(solved.mateErrors).toEqual({});
    // The hinge is at the middle of a's top face (5, 5, 10): grab b 10 mm out along X and swing it a quarter turn.
    const start = planDrag(asm, solved, frameLookup(asm, parts), "B", [15, 5, 10], [0, 0, 1]);
    expect("plan" in start).toBe(true);
    if (!("plan" in start)) return;
    const change = start.plan.update({ origin: [5, 15, 50], dir: [0, 0, -1] });
    expect(change?.kind).toBe("mate");
    if (change?.kind !== "mate") return;
    expect(Math.abs(Number(change.values.angle))).toBeCloseTo(90, 3);
  });
});
