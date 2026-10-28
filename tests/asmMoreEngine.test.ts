/**
 * More assembly tools on real parts (the OpenCascade engine runs in Node): a
 * Width mate whose slot is made by two parts of one sub-assembly copy, a
 * mirror across a clicked face, and symmetric parts mirrored as themselves.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { billOfMaterials } from "../src/assembly/assembly";
import { applyPlacement, type Placement } from "../src/assembly/math";
import { pickConnector, samePieceClick, solveWithParts } from "../src/assembly/mates";
import { syncPattern } from "../src/assembly/patterns";
import { ownSymmetry } from "../src/assembly/symmetry";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh } from "../src/kernel/protocol";
import type { Assembly, Instance, Mate, MateConnector } from "../src/model/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

const close = (a: readonly number[], b: readonly number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const face = (p: PartMesh, normal: number[]) => {
  const i = p.faceRefs.findIndex((r) => r.surface === "PLANE" && r.normal.every((v, k) => Math.abs(v - normal[k]) < 1e-6));
  expect(i).toBeGreaterThanOrEqual(0);
  return { partId: p.id, ref: p.faceRefs[i] };
};
const at = (x: number, y: number, z: number): Placement => ({ position: [x, y, z], rotation: [0, 0, 0, 1] });
const inst = (id: string, partId: string, placement: Placement, fixed = false, extra: Partial<Instance> = {}): Instance => ({ id, partId, name: `${id} <1>`, placement, fixed, ...extra });

const engine = new GeometryEngine();
// A 5 mm thick plate (x 0…5), a key 6 mm wide (x 0…6), and an L-shaped bracket (not symmetric across its own X).
const plate = feature("box", { width: 5, depth: 20, height: 20 });
const key = feature("box", { width: 6, depth: 10, height: 10, x: 100 });
const lArm = feature("box", { width: 30, depth: 10, height: 4, x: 200 });
const lUp = feature("box", { width: 4, depth: 10, height: 20, x: 200 }, "add");
let parts: PartMesh[];
const part = (id: string) => parts.find((p) => p.featureIds.includes(id))!;

describe("more assembly tools on real parts", () => {
  beforeAll(() => {
    parts = engine.rebuild([plate, key, lArm, lUp]).parts;
    expect(parts.length).toBe(3);
  });

  it("centres a key in a slot made by two plates of one sub-assembly copy (Width mate)", () => {
    const P = part(plate.id);
    const K = part(key.id);
    // The slot: two plates 10 mm apart (the gap is x 5…15), both inside one sub-assembly.
    const slot: Assembly = { id: "S", name: "Slot", instances: [inst("left", P.id, at(0, 0, 0), true), inst("right", P.id, at(15, 0, 0), true)] };
    const top: Assembly = { id: "A", name: "Top", instances: [inst("s1", "", at(50, 0, 0), true, { subAssembly: "S" }), inst("k", K.id, at(0, 40, 0))] };
    // Picked the way the mate dialog does: the left plate's right face, then the right plate's left face (same copy, another part).
    let draft: { type: "width"; a?: MateConnector; b?: MateConnector } = { type: "width" };
    const clicks: MateConnector[] = [
      { instanceId: "s1", path: ["left"], pick: face(P, [1, 0, 0]) },
      { instanceId: "s1", path: ["right"], pick: face(P, [-1, 0, 0]) },
      { instanceId: "k", pick: face(K, [-1, 0, 0]) },
      { instanceId: "k", pick: face(K, [1, 0, 0]) },
    ];
    for (const c of clicks) {
      expect(samePieceClick(draft, c)).toBe(false);
      draft = { ...draft, ...pickConnector(draft, c) };
    }
    expect(draft.a?.path2).toEqual(["right"]);
    const mate: Mate = { id: "w", name: "Width 1", type: "width", a: draft.a!, b: draft.b!, flip: false, values: {} };
    const solved = solveWithParts({ ...top, mates: [mate] }, parts, { assemblies: [top, slot] });
    expect(solved.mateErrors).toEqual({});
    // The key (x 100…106 in its own coordinates) sits centred in the gap: x 55…65 in the world, so its middle at 60.
    const middle = applyPlacement(solved.placements.k, [103, 0, 0]);
    expect(middle[0]).toBeCloseTo(60, 6);
    // The right plate taken out of the sub-assembly: the mate says why it can't be used.
    const broken = solveWithParts({ ...top, mates: [mate] }, parts, { assemblies: [top, { ...slot, instances: [slot.instances[0]] }] });
    expect(broken.mateErrors.w).toMatch(/removed/);
  });

  it("mirrors a part across a clicked face of another part", () => {
    const P = part(plate.id);
    const L = part(lArm.id);
    const a: Assembly = { id: "M", name: "M", instances: [inst("wall", P.id, at(40, 0, 0), true), inst("arm", L.id, at(-200, 0, 0), true)] };
    // The wall's right face is at x = 45.
    const made = syncPattern(a, { id: "mr", name: "Mirror 1", kind: "mirror", seeds: ["arm"], count: 2, amount: "0", axis: "x", plane: { instanceId: "wall", pick: face(P, [1, 0, 0]) } }, () => "copy");
    const solved = solveWithParts(made, parts);
    expect(solved.patternErrors).toBeUndefined();
    // The bracket's far end (x 230 → world 30) lands at 60; its upright (x 200…204 → world 0…4) at 86…90.
    const copy = solved.placements.copy;
    expect(made.instances.find((i) => i.id === "copy")?.mirrored).toBe(true);
    close(applyPlacement(copy, [-230, 0, 0]), [60, 0, 0]);
    close(applyPlacement(copy, [-200, 5, 10]), [90, 5, 10]);
  });

  it("knows which parts are symmetric, and mirrors those as the same part", () => {
    const P = part(plate.id);
    const L = part(lArm.id);
    expect(ownSymmetry(P)).toEqual({ axis: "x", at: 2.5 });
    // The L-shaped bracket isn't symmetric across its own X; it is across its own Y (front to back).
    expect(ownSymmetry(L)?.axis).toBe("y");
    // Round parts too (their faces' facets differ a little). A plate with a hole off-centre both ways is only symmetric top to bottom.
    const e2 = new GeometryEngine();
    const rod = feature("cylinder", { diameter: 12, height: 30 });
    const holed = feature("box", { width: 20, depth: 20, height: 5, x: 50 });
    const hole = feature("cylinder", { diameter: 4, height: 5, x: 58, y: 13 }, "remove");
    const more = e2.rebuild([rod, holed, hole]).parts;
    expect(ownSymmetry(more.find((p) => p.featureIds.includes(rod.id))!)?.axis).toBe("x");
    expect(ownSymmetry(more.find((p) => p.featureIds.includes(holed.id))!)).toEqual({ axis: "z", at: 2.5 });
    e2.dispose();
    const a: Assembly = { id: "M", name: "M", instances: [inst("plate", P.id, at(0, 0, 0), true), inst("arm", L.id, at(-200, 30, 0), true)] };
    const symmetric = (i: Instance) => !!ownSymmetry(parts.find((p) => p.id === i.partId)!);
    let n = 0;
    // Mirrored left ↔ right across x = 50, the same part for symmetric parts: both are, so no mirror images at all.
    const made = syncPattern(a, { id: "mr", name: "Mirror 1", kind: "mirror", seeds: ["plate", "arm"], count: 2, amount: "0", axis: "x", centre: [50, 0, 0], samePart: true }, () => `c${++n}`, symmetric);
    expect(made.instances.filter((i) => i.mirrored)).toEqual([]);
    const solved = solveWithParts(made, parts);
    expect(solved.patternErrors).toBeUndefined();
    // The plate (x 0…5) lands at x 95…100 — the same shape as its mirror image (turned end for end, so its own x 0 is at 95).
    close(applyPlacement(solved.placements.c1, [0, 0, 0]), [95, 0, 0]);
    close(applyPlacement(solved.placements.c1, [5, 20, 20]), [100, 20, 20]);
    // The bracket's upright (world x 0…4) lands at 96…100, its arm reaching back towards the middle, as a mirror image would.
    const up = [0, 4].map((x) => applyPlacement(solved.placements.c2, [200 + x, 0, 20])[0]);
    expect(Math.min(...up)).toBeCloseTo(96, 6);
    expect(Math.max(...up)).toBeCloseTo(100, 6);
    expect(applyPlacement(solved.placements.c2, [230, 5, 2])[0]).toBeCloseTo(70, 6);
    const bom = billOfMaterials(made, Object.fromEntries(parts.map((p) => [p.id, p.name])));
    expect(bom.map((r) => r.quantity)).toEqual([2, 2]);
  });
});
