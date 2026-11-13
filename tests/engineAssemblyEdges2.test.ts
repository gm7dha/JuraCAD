/**
 * Assembly Fillets / Chamfers on edges the assembly's own cuts made (own file for OpenCascade's memory): a chamfer on
 * one drilled hole's rim stays on that hole when the plate is moved by about the holes' spacing (never jumping to the
 * other hole), and it needs only the hole it's on — deleting the other hole, or a notch that shortens an edge, keeps it.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  assemblyEdgeFeature,
  assemblyExtrudeCut,
  assemblyFeatureDependents,
  assemblyFeaturesOf,
  assemblyHole,
  assemblySketch,
  deleteAssemblyFeatures,
  edgeNeeds,
  hasRef,
  setFeatureNeeds,
  storedEdgePicks,
} from "../src/assembly/assemblyFeatures";
import { instancesForKernel } from "../src/assembly/placed";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh } from "../src/kernel/protocol";
import type { Assembly, Feature } from "../src/model/types";
import type { TopoPick } from "../src/geometry/topoRef";
import { addPoint, addRectangle } from "../src/sketch/ops";
import { planeOnFace } from "../src/sketch/planes";
import { emptySketch } from "../src/sketch/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

const at = (x: number, y: number, z: number) => ({ position: [x, y, z] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] });
const top = (z: number) => planeOnFace([0, 0, 1], [0, 0, z], "Top");

describe("fillets and chamfers on edges the assembly made", () => {
  const engine = new GeometryEngine();
  const plate = feature("box", { width: 60, depth: 40, height: 5 });
  let parts: PartMesh[] = [];
  beforeAll(() => {
    parts = engine.rebuild([plate]).parts;
  });
  const plain = () => parts.find((p) => p.id === plate.id)!;

  /** A plate copy (not fixed) with 6 mm holes drilled at x = 15 (h1) and x = 25 (h2), y = 20. */
  const drilled = (): Assembly => {
    const s1 = assemblySketch({ features: [] }, top(5), addPoint(emptySketch(), { x: 15, y: 20 }).sketch, "s1");
    const h1 = assemblyHole({ features: [s1] }, "s1", { diameter: 6, throughAll: true }, "h1");
    const s2 = assemblySketch({ features: [s1, h1] }, top(5), addPoint(emptySketch(), { x: 25, y: 20 }).sketch, "s2");
    const h2 = assemblyHole({ features: [s1, h1, s2] }, "s2", { diameter: 6, throughAll: true }, "h2");
    return { id: "A", name: "A", instances: [{ id: "i1", partId: plate.id, name: "Plate <1>", placement: at(0, 0, 0), fixed: false }], mates: [], features: [s1, h1, s2, h2] };
  };
  const copyOf = (asm: Assembly) => engine.assemblyCuts(instancesForKernel(asm, parts, [asm]));
  /** As the app and Claude do: the copy made with one feature left out, for edgeNeeds. */
  const withoutOf = (asm: Assembly) => (id: string, key: string) => {
    const off = { ...asm, features: assemblyFeaturesOf(asm).map((f) => (f.id === id ? { ...f, suppressed: true } : f)) };
    return engine.assemblyCuts(instancesForKernel(off, parts, [off])).meshes.find((m) => m.id === key);
  };
  const rimAt = (m: PartMesh, x: number): TopoPick => ({ partId: "i1", ref: m.edgeRefs.find((e) => e.curve === "CIRCLE" && Math.abs(e.mid[2] - 5) < 1e-6 && Math.abs((e.a[0] + e.mid[0]) / 2 - x) < 1e-6)! });
  const chamfered = (asm: Assembly, chamfer: Feature) => ({ ...asm, features: [...assemblyFeaturesOf(asm), chamfer] });

  it("keeps a chamfer on the rim of the hole it was made on when the plate moves by the holes' spacing", () => {
    let asm = drilled();
    const copy = copyOf(asm).meshes[0];
    const pick = rimAt(copy, 15);
    expect(pick.ref).toBeDefined();
    // The rim only the hole made is kept in the assembly's coordinates; a corner of the plate itself stays on the part.
    const corner = plain().edgeRefs.find((e) => e.curve === "LINE")!;
    const stored = storedEdgePicks([pick, { partId: "i1", ref: corner }], () => plain(), () => ({ at: at(0, 0, 0), mirrored: false }));
    expect(stored.map((p) => !!p.placed)).toEqual([true, false]);
    const chamfer = assemblyEdgeFeature(asm, "chamfer", stored.slice(0, 1), { size: 1 }, "c1");
    asm = chamfered(asm, chamfer);
    const cone = (m: PartMesh) => m.faceRefs.filter((f) => f.surface === "CONE").map((f) => Math.round(f.center[0] * 1000) / 1000);
    const r0 = copyOf(asm);
    expect(r0.errors).toEqual({});
    expect(cone(r0.meshes[0])).toEqual([15]);
    // The plate stored 10 mm along +x: the holes stay where they were drilled (x = 15 and 25 in the assembly, so 5 and
    // 15 on the plate); the bevel is on h1's rim (5 on the plate), not on h2's, which is now where h1's was on the plate.
    asm = { ...asm, instances: [{ ...asm.instances[0], placement: at(10, 0, 0) }] };
    const r1 = copyOf(asm);
    expect(r1.errors).toEqual({});
    expect(cone(r1.meshes[0])).toEqual([5]);
    expect(r1.meshes[0].volume).toBeCloseTo(r0.meshes[0].volume!, 3);
  });

  it("needs only the hole it's on: deleting the other hole keeps it", () => {
    const asm = drilled();
    const copy = copyOf(asm);
    const pick = rimAt(copy.meshes[0], 15);
    const needs = edgeNeeds([pick], () => plain(), copy.reached, withoutOf(asm));
    expect(needs).toEqual(["h1"]);
    const chamfer = assemblyEdgeFeature(asm, "chamfer", storedEdgePicks([pick], () => plain(), () => ({ at: at(0, 0, 0), mirrored: false })), { size: 1 }, "c1");
    const done = setFeatureNeeds(chamfered(asm, chamfer), "c1", needs);
    expect(assemblyFeatureDependents(done, ["h2"])).toEqual(["h2"]);
    const kept = deleteAssemblyFeatures(done, ["h2"]);
    expect(kept.features!.map((f) => f.id)).toEqual(["s1", "h1", "s2", "c1"]);
    expect(copyOf(kept).errors).toEqual({});
    expect(assemblyFeatureDependents(done, ["h1"])).toEqual(["h1", "c1"]);
  });

  it("needs nothing for an edge a notch only made shorter", () => {
    // A 10 × 10 notch out of the front edge's middle: the front top edge is now two shorter pieces.
    const sk = assemblySketch({ features: [] }, top(5), addRectangle(emptySketch(), { x: 25, y: -1 }, { x: 35, y: 10 }).sketch, "sn");
    const notch = assemblyExtrudeCut({ features: [sk] }, "sn", { throughAll: true }, "n1");
    const asm: Assembly = { id: "A", name: "A", instances: [{ id: "i1", partId: plate.id, name: "Plate <1>", placement: at(0, 0, 0), fixed: true }], features: [sk, notch] };
    const copy = copyOf(asm);
    expect(copy.reached.n1).toEqual(["i1"]);
    const piece = copy.meshes[0].edgeRefs.find((e) => e.curve === "LINE" && Math.abs(e.mid[1]) < 1e-6 && Math.abs(e.mid[2] - 5) < 1e-6 && e.mid[0] < 25)!;
    expect(Math.abs(piece.b[0] - piece.a[0])).toBeCloseTo(25, 6);
    const pick: TopoPick = { partId: "i1", ref: piece };
    expect(hasRef(plain(), piece)).toBe(true);
    expect(edgeNeeds([pick], () => plain(), copy.reached, withoutOf(asm))).toEqual([]);
    // So it's kept on the part (it goes with the copy), and the notch can be deleted without it.
    expect(storedEdgePicks([pick], () => plain(), () => ({ at: at(0, 0, 0), mirrored: false }))[0].placed).toBeUndefined();
    const c = assemblyEdgeFeature(asm, "chamfer", [pick], { size: 1 }, "c1");
    expect(assemblyFeatureDependents({ ...asm, features: [sk, notch, c] }, ["n1"])).toEqual(["n1"]);
    expect(copyOf({ ...asm, features: [sk, notch, c] }).errors).toEqual({});
  });
});
