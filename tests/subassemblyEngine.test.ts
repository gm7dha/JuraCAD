/**
 * Sub-assemblies on real parts (the OpenCascade engine runs in Node): a mate
 * to a part inside a sub-assembly moves the whole sub-assembly; a change to
 * the sub-assembly's own mates reaches every place it's used; exports carry
 * every part to its place; the clash check looks across levels.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { billOfMaterials } from "../src/assembly/assembly";
import { DEFAULT_CLASH_OPTIONS, judgeContacts } from "../src/assembly/assemblyCheck";
import { compose, IDENTITY, type Placement } from "../src/assembly/math";
import { connectorFrameFor, solveWithParts } from "../src/assembly/mates";
import { kernelInstances, leavesOf } from "../src/assembly/subassembly";
import { analyzeMesh } from "../src/geometry/meshCheck";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh } from "../src/kernel/protocol";
import type { Assembly, Instance, Mate, MateConnector } from "../src/model/types";
import { feature, importFeature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

const close = (a: readonly number[], b: readonly number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

/** The flat face of a part pointing along `normal`. */
const face = (p: PartMesh, normal: number[]) => {
  const i = p.faceRefs.findIndex((r) => r.surface === "PLANE" && r.normal.every((v, k) => Math.abs(v - normal[k]) < 1e-6));
  expect(i).toBeGreaterThanOrEqual(0);
  return { partId: p.id, ref: p.faceRefs[i] };
};
const at = (x: number, y: number, z: number): Placement => ({ position: [x, y, z], rotation: [0, 0, 0, 1] });
const inst = (id: string, partId: string, placement: Placement, fixed = false, extra: Partial<Instance> = {}): Instance => ({ id, partId, name: id, placement, fixed, ...extra });
const fasten = (id: string, a: MateConnector, b: MateConnector, values: Record<string, string> = {}): Mate => ({ id, name: id, type: "fastened", a, b, flip: false, values });

// A 10 mm cube at the origin, and a 20 × 20 × 5 plate at x = 50 (bottom face centre (60, 10, 0)).
const engine = new GeometryEngine();
const block = feature("box", { width: 10, depth: 10, height: 10 });
const plate = feature("box", { width: 20, depth: 20, height: 5, x: 50 });
let parts: PartMesh[];
let blockP: PartMesh;
let plateP: PartMesh;

/** S: the plate fixed where it is, the cube fastened on top of it (its own mate, with an optional gap). */
const hinge = (gap = ""): Assembly => ({
  id: "S",
  name: "Stack",
  instances: [inst("sp", plate.id, IDENTITY, true), inst("sb", block.id, at(100, 0, 0))],
  mates: [fasten("inner", { instanceId: "sp", pick: face(plateP, [0, 0, 1]) }, { instanceId: "sb", pick: face(blockP, [0, 0, -1]) }, gap ? { gap } : {})],
});

/** A: a cube fixed at the origin, and S mated by one of its parts to the cube's top. */
const top = (onto: MateConnector, copies = 1): Assembly => ({
  id: "A",
  name: "Top",
  instances: [inst("base", block.id, IDENTITY, true), ...Array.from({ length: copies }, (_, k) => inst(`s${k + 1}`, "", at(200, 0, 0), false, { subAssembly: "S" }))],
  mates: [fasten("outer", { instanceId: "base", pick: face(blockP, [0, 0, 1]) }, onto)],
});

/** Every part's place in the world, by key. */
function worldPlaces(a: Assembly, all: Assembly[]): Record<string, Placement> {
  const solved = solveWithParts(a, parts, { assemblies: all });
  expect(solved.mateErrors).toEqual({});
  return Object.fromEntries(leavesOf(a, parts, all).map((l) => [l.key, compose(solved.placements[l.top], l.relative)]));
}

describe("sub-assemblies on real parts", () => {
  beforeAll(() => {
    parts = engine.rebuild([block, plate]).parts;
    [blockP, plateP] = parts;
  });

  it("solves a sub-assembly's own mates inside it", () => {
    const S = hinge();
    const r = solveWithParts(S, parts);
    expect(r.mateErrors).toEqual({});
    // The cube's bottom centre (5, 5, 0) goes onto the plate's top centre (60, 10, 5).
    close(r.placements.sb.position, [55, 5, 5]);
    close(r.placements.sb.rotation, [0, 0, 0, 1]);
  });

  it("moves the whole sub-assembly when a part inside it is mated", () => {
    const S = hinge();
    const A = top({ instanceId: "s1", path: ["sp"], pick: face(plateP, [0, 0, -1]) });
    // The connector is found on the plate where S's mates put it: its bottom centre, in S's coordinates.
    const f = connectorFrameFor(A, parts, A.mates![0].b, [A, S])!;
    close(f.origin, [60, 10, 0]);
    close(f.z, [0, 0, -1]);
    const w = worldPlaces(A, [A, S]);
    // The plate's bottom centre lands on the base's top centre (5, 5, 10): S moves by (−55, −5, 10)…
    close(solveWithParts(A, parts, { assemblies: [A, S] }).placements.s1.position, [-55, -5, 10]);
    close(w["s1/sp"].position, [-55, -5, 10]);
    // …and the cube inside comes along, still on top of the plate: right above the base.
    close(w["s1/sb"].position, [0, 0, 15]);
    close(w["s1/sb"].rotation, [0, 0, 0, 1]);
    close(w.base.position, [0, 0, 0]);
  });

  it("follows a change to the sub-assembly's own mates in every place it's used", () => {
    // Mated by the cube inside: the cube's bottom sits on the base, the plate below it.
    const onCube = (S: Assembly) => top({ instanceId: "s1", path: ["sb"], pick: face(blockP, [0, 0, -1]) }, 2);
    let S = hinge();
    let A = onCube(S);
    let w = worldPlaces(A, [A, S]);
    close(w["s1/sb"].position, [0, 0, 10]);
    close(w["s1/sp"].position, [-55, -5, 5]);
    // The second copy isn't mated: it stays where it was put, its parts in the same arrangement.
    close(w["s2/sp"].position, [200, 0, 0]);
    close(w["s2/sb"].position, [255, 5, 5]);
    // Open S and give its mate a 3 mm gap: nothing in A changes, yet A follows.
    S = hinge("3");
    A = onCube(S);
    w = worldPlaces(A, [A, S]);
    close(w["s1/sb"].position, [0, 0, 10]);
    close(w["s1/sp"].position, [-55, -5, 2]);
    close(w["s2/sb"].position, [255, 5, 8]);
    // The same through a part's shape: a thicker plate pushes the cube up inside S, so S sits lower in A.
    const thicker = engine.rebuild([block, { ...plate, params: { ...plate.params, height: "7" } }]).parts;
    const r = solveWithParts(onCube(hinge()), thicker, { assemblies: [onCube(hinge()), hinge()] });
    close(r.placements.s1.position, [-55, -5, 3]);
    parts = engine.rebuild([block, plate]).parts;
    [blockP, plateP] = parts;
  });

  it("goes two levels deep: a part inside a sub-assembly inside a sub-assembly", () => {
    const S = hinge();
    const A = top({ instanceId: "s1", path: ["sp"], pick: face(plateP, [0, 0, -1]) });
    // T: A fixed 100 up, and a loose cube fastened on top of the plate inside S inside A.
    const T: Assembly = {
      id: "T",
      name: "Whole",
      instances: [inst("t1", "", at(0, 0, 100), true, { subAssembly: "A" }), inst("tb", block.id, at(300, 0, 0))],
      mates: [fasten("m", { instanceId: "t1", path: ["s1", "sp"], pick: face(plateP, [0, 0, 1]) }, { instanceId: "tb", pick: face(blockP, [0, 0, -1]) })],
    };
    const all = [T, A, S];
    const w = worldPlaces(T, all);
    // The plate's top centre in A is (5, 5, 15); in T, 100 higher: the cube's bottom centre goes there.
    close(w.tb.position, [0, 0, 115]);
    close(w["t1/s1/sb"].position, [0, 0, 115]);
    close(w["t1/base"].position, [0, 0, 100]);
    expect(Object.keys(w).sort()).toEqual(["t1/base", "t1/s1/sb", "t1/s1/sp", "tb"]);
    // Parts list: 3 cubes and a plate, flattened.
    expect(billOfMaterials(T, { [block.id]: "Cube", [plate.id]: "Plate" }, {}, undefined, {}, { assemblies: all }).map((r) => [r.name, r.quantity])).toEqual([
      ["Cube", 3],
      ["Plate", 1],
    ]);
  });

  it("finds clashes across levels, and exports every part in its place", async () => {
    const S = hinge();
    const A = top({ instanceId: "s1", path: ["sp"], pick: face(plateP, [0, 0, -1]) });
    // The loose cube sits exactly where the cube inside S inside A is: a clash of the whole cube.
    const T: Assembly = {
      id: "T",
      name: "Whole",
      instances: [inst("t1", "", at(0, 0, 100), true, { subAssembly: "A" }), inst("tb", block.id, at(0, 0, 115), true)],
    };
    const all = [T, A, S];
    const solved = solveWithParts(T, parts, { assemblies: all });
    const instances = kernelInstances(leavesOf(T, parts, all), parts, solved.placements, () => IDENTITY);
    expect(instances.map((i) => [i.id, i.name])).toEqual([
      ["t1/base", "t1 / base"],
      ["t1/s1/sp", "t1 / s1 / sp"],
      ["t1/s1/sb", "t1 / s1 / sb"],
      ["tb", "tb"],
    ]);
    const contacts = judgeContacts(engine.clashes(instances, 0.01), { ...DEFAULT_CLASH_OPTIONS, tolerance: 0.01, ignoreTouching: false });
    const overlaps = contacts.filter((c) => c.kind === "overlap") as { a: string; b: string; volume: number }[];
    expect(overlaps.map((c) => [c.a, c.b])).toEqual([["t1 / s1 / sb", "tb"]]);
    expect(overlaps[0].volume).toBeCloseTo(1000, 3);
    // Everything else only touches: inside the sub-assemblies (plate on base, cube on plate), and across them (the loose cube on the plate).
    expect(contacts.filter((c) => c.kind === "touch").map((c) => [c.a, c.b])).toEqual([
      ["t1 / base", "t1 / s1 / sp"],
      ["t1 / s1 / sp", "t1 / s1 / sb"],
      ["t1 / s1 / sp", "tb"],
    ]);

    // STEP: read back, each solid is where the assembly put it.
    const step = new TextDecoder().decode((await engine.exportStep([], {}, instances)).step);
    expect(step).toContain("PRODUCT('t1 / s1 / sb'");
    const back = new GeometryEngine();
    try {
      const r = back.rebuild([importFeature({ fileName: "whole.step", format: "step", data: step, units: "mm" })]);
      expect(r.featureErrors).toEqual({});
      const boxes = r.parts
        .map((p) => {
          const xs = (k: number) => Array.from(p.vertices).filter((_, i) => i % 3 === k);
          return [0, 1, 2].flatMap((k) => [Math.min(...xs(k)), Math.max(...xs(k))]).map((v) => Math.round(v * 1000) / 1000);
        })
        .sort((a, b) => a[4] - b[4] || a[0] - b[0]);
      expect(boxes).toEqual([
        [0, 10, 0, 10, 100, 110], // the base, 100 up
        [-5, 15, -5, 15, 110, 115], // the plate on it
        [0, 10, 0, 10, 115, 125], // the cube inside S
        [0, 10, 0, 10, 115, 125], // the loose cube, in the same place
      ]);
      expect(r.parts.map((p) => analyzeMesh(p.vertices, p.triangles).volume).sort((a, b) => a - b).map((v) => Math.round(v))).toEqual([1000, 1000, 1000, 2000]);
    } finally {
      back.dispose();
    }
  });
});
