/**
 * Fillet and Chamfer as assembly features (own file for OpenCascade's memory): edges picked on a copy are rounded on
 * that assembly's copy only — the part in its Part Studio, other copies and the part mated to it are untouched — they
 * go with the copy when it's placed elsewhere, and a chamfer on a hole's rim the assembly drilled is made after it.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { assemblyEdgeFeature, assemblyFeatureDependents, assemblyHole, assemblySketch, cutsFor, deleteAssemblyFeatures, edgeNeeds, setFeatureNeeds } from "../src/assembly/assemblyFeatures";
import { instancesForKernel } from "../src/assembly/placed";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh } from "../src/kernel/protocol";
import type { Assembly } from "../src/model/types";
import { addPoint } from "../src/sketch/ops";
import { planeOnFace } from "../src/sketch/planes";
import { emptySketch } from "../src/sketch/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

const at = (x: number, y: number, z: number) => ({ position: [x, y, z] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] });

describe("Fillet and Chamfer in an assembly", () => {
  const engine = new GeometryEngine();
  const plate = feature("box", { width: 40, depth: 40, height: 5 });
  const pin = feature("cylinder", { diameter: 6, height: 20, x: 100 });
  let parts: PartMesh[] = [];
  beforeAll(() => {
    parts = engine.rebuild([plate, pin]).parts;
  });
  const upright = () => parts.find((p) => p.id === plate.id)!.edgeRefs.filter((e) => e.curve === "LINE" && Math.abs(e.a[2] - e.b[2]) > 1);

  const base = (): Assembly => ({
    id: "A",
    name: "A",
    instances: [
      { id: "i1", partId: plate.id, name: "Plate <1>", placement: at(0, 0, 0), fixed: true },
      { id: "i2", partId: plate.id, name: "Plate <2>", placement: at(100, 0, 0), fixed: true },
      { id: "i3", partId: pin.id, name: "Pin <1>", placement: at(-80, 20, 5), fixed: false },
    ],
    mates: [],
  });

  it("rounds the edges picked on one copy only, and keeps the rounding when the copy is placed elsewhere", () => {
    const fillet = assemblyEdgeFeature({ features: [] }, "fillet", upright().map((ref) => ({ partId: "i1", ref })), { size: 3 }, "f1");
    let asm: Assembly = { ...base(), features: [fillet] };
    expect(cutsFor(asm, "i1")?.map((f) => f.id)).toEqual(["f1"]);
    expect(cutsFor(asm, "i2")).toBeUndefined();
    const r = engine.assemblyCuts(instancesForKernel(asm, parts, [asm]));
    expect(r.errors).toEqual({});
    expect(r.cut).toEqual(["i1"]);
    expect(r.reached.f1).toEqual(["i1"]);
    const corner = (9 - (Math.PI * 9) / 4) * 5;
    expect(r.meshes[0].volume).toBeCloseTo(8000 - 4 * corner, 2);
    // The plate in its Part Studio, the other copy and the pin standing on it are unchanged.
    expect(Math.round(parts.find((p) => p.id === plate.id)!.volume!)).toBe(8000);
    const placed = engine.assemblyCuts(instancesForKernel({ ...asm, features: [fillet, { ...fillet, id: "never", picks: [] }] }, parts, [asm]));
    expect(placed.meshes.map((m) => m.id)).toEqual(["i1"]);
    // Moved and turned in the assembly, the copy keeps its rounded edges (the picks are on the copy, not in space).
    asm = { ...asm, instances: asm.instances.map((i) => (i.id === "i1" ? { ...i, placement: { position: [30, -40, 7], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] } } : i)) };
    const moved = engine.assemblyCuts(instancesForKernel(asm, parts, [asm]));
    expect(moved.meshes[0].volume).toBeCloseTo(8000 - 4 * corner, 2);
  });

  it("bevels a hole's rim the assembly drilled, and the chamfer goes when the hole is deleted", () => {
    const sk = assemblySketch({ features: [] }, planeOnFace([0, 0, 1], [0, 0, 5], "Top"), addPoint(emptySketch(), { x: 20, y: 20 }).sketch, "s1");
    const hole = assemblyHole({ features: [sk] }, sk.id, { diameter: 6, throughAll: true }, "h1");
    let asm: Assembly = { ...base(), features: [sk, hole], featureParts: { h1: ["i1"] } };
    const drilled = engine.assemblyCuts(instancesForKernel(asm, parts, [asm]));
    const copy = drilled.meshes.find((m) => m.id === "i1")!;
    const rim = copy.edgeRefs.filter((e) => e.curve === "CIRCLE" && Math.abs(e.mid[2] - 5) < 1e-6);
    expect(rim.length).toBeGreaterThan(0);
    const picks = rim.map((ref) => ({ partId: "i1", ref }));
    const chamfer = assemblyEdgeFeature(asm, "chamfer", picks, { size: 1 }, "c1");
    const needs = edgeNeeds(picks, (k) => parts.find((p) => p.id === asm.instances.find((i) => i.id === k)!.partId), drilled.reached, () => undefined);
    expect(needs).toEqual(["h1"]);
    asm = setFeatureNeeds({ ...asm, features: [sk, hole, chamfer] }, "c1", needs);
    const r = engine.assemblyCuts(instancesForKernel(asm, parts, [asm]));
    expect(r.errors).toEqual({});
    // A 45° bevel 1 mm round a Ø6 hole: a ring of triangle section, its middle at r = 3 + 1/3.
    const bevel = 0.5 * 2 * Math.PI * (3 + 1 / 3);
    expect(r.meshes.find((m) => m.id === "i1")!.volume).toBeCloseTo(8000 - Math.PI * 9 * 5 - bevel, 1);
    // An edge the plain part has (an upright corner) needs nothing; the hole's rim needs the hole.
    expect(edgeNeeds([{ partId: "i1", ref: upright()[0] }], () => parts.find((p) => p.id === plate.id), drilled.reached, () => undefined)).toEqual([]);
    expect(assemblyFeatureDependents(asm, ["h1"])).toEqual(["h1", "c1"]);
    expect(assemblyFeatureDependents(asm, ["s1"])).toEqual(["s1", "h1", "c1"]);
    const after = deleteAssemblyFeatures(asm, ["h1"]);
    expect(after.features!.map((f) => f.id)).toEqual(["s1"]);
    expect(after.featureNeeds).toBeUndefined();
    // Deleting the chamfer alone leaves the hole.
    expect(deleteAssemblyFeatures(asm, ["c1"]).features!.map((f) => f.id)).toEqual(["s1", "h1"]);
  });

  it("says plainly when a fillet is too big for its edges, and still makes the rest", () => {
    const fillet = assemblyEdgeFeature({ features: [] }, "fillet", upright().map((ref) => ({ partId: "i1", ref })), { size: 30 }, "f1");
    const asm: Assembly = { ...base(), features: [fillet] };
    const r = engine.assemblyCuts(instancesForKernel(asm, parts, [asm]));
    expect(r.errors.f1).toMatch(/smaller radius/);
    expect(r.cut).toEqual([]);
  });
});
