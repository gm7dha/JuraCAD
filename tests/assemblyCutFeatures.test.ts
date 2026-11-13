/**
 * Assembly features and Edit in context, without the geometry engine: which
 * copies a cut reaches, where the cut is given to the engine, what goes with
 * a deleted sketch, saving and reading back, and contexts' snapshots.
 */
import { describe, expect, it } from "vitest";

import { addAssemblyFeatures, assemblyEdgeFeature, assemblyFeaturesText, setFeatureNeeds, assemblyFeatureDependents, assemblyHole, assemblySketch, cutsFor, deleteAssemblyFeatures, featureCuts, setFeatureParts } from "../src/assembly/assemblyFeatures";
import { billOfMaterials, updateAssembly, withoutInstances } from "../src/assembly/assembly";
import { instancesForKernel } from "../src/assembly/placed";
import { carryCutMeshesOver, rememberedCutMeshes } from "../src/assembly/mates";
import { contextGone, contextInputs, contextPartOf, contextPartId, removeContext, setContextHidden, takeContext, tidyContexts } from "../src/assembly/inContext";
import { removeStudio } from "../src/model/studios";
import { emptyDocument } from "../src/model/document";
import { readDocumentFile, serializeDocument } from "../src/model/fileFormat";
import type { PartMesh } from "../src/kernel/protocol";
import type { Assembly, JuraCADDocument } from "../src/model/types";
import { addPoint } from "../src/sketch/ops";
import { planeOnFace } from "../src/sketch/planes";
import { emptySketch } from "../src/sketch/types";

const at = (x: number, y: number, z: number) => ({ position: [x, y, z] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] });

/** A stand-in built part (a 10 mm cube's corners are enough for what's checked here). */
const mesh = (id: string, studioId: string): PartMesh =>
  ({ id, name: id, studioId, featureIds: [id], vertices: new Float32Array([0, 0, 0, 10, 10, 10]), normals: new Float32Array(6), triangles: new Uint32Array(0), faceGroups: [], lines: new Float32Array(0), edgeGroups: [], faceRefs: [], edgeRefs: [] }) as PartMesh;

function doc(): { doc: JuraCADDocument; asm: Assembly } {
  const asm: Assembly = {
    id: "A",
    name: "Assembly 1",
    instances: [
      { id: "i1", partId: "p1", name: "Plate <1>", placement: at(0, 0, 0), fixed: true },
      { id: "i2", partId: "p2", name: "Lid <1>", placement: at(0, 0, 5), fixed: true },
      { id: "s1", partId: "", subAssembly: "B", name: "Sub <1>", placement: at(100, 0, 0), fixed: true },
    ],
  };
  const sub: Assembly = { id: "B", name: "Sub", instances: [{ id: "j1", partId: "p1", name: "Plate <1>", placement: at(0, 0, 0), fixed: true }] };
  const base = emptyDocument("Test");
  return { doc: { ...base, assemblies: [asm, sub] }, asm };
}

const parts = [mesh("p1", "main"), mesh("p2", "ps2")];

function withHole(): { doc: JuraCADDocument; asm: Assembly } {
  const { doc: d, asm } = doc();
  const sketch = assemblySketch(asm, planeOnFace([0, 0, 1], [0, 0, 9], "Top of Lid"), addPoint(emptySketch(), { x: 5, y: 5 }).sketch, "sk");
  const hole = assemblyHole({ features: [sketch] }, sketch.id, { diameter: 3, throughAll: true }, "ho");
  const next = addAssemblyFeatures(d, "A", [sketch, hole]);
  return { doc: next, asm: next.assemblies![0] };
}

describe("which copies an assembly feature cuts", () => {
  it("every top-level part by default, nothing inside a sub-assembly unless chosen", () => {
    const { asm } = withHole();
    expect(cutsFor(asm, "i1")?.map((f) => f.id)).toEqual(["sk", "ho"]);
    expect(cutsFor(asm, "s1/j1")).toBeUndefined();
    const chosen = setFeatureParts(asm, "ho", ["i2", "s1/j1"]);
    expect(cutsFor(chosen, "i1")).toBeUndefined();
    expect(cutsFor(chosen, "s1/j1")?.length).toBe(2);
    expect(featureCuts(setFeatureParts(chosen, "ho", null), asm.features![1], "i1")).toBe(true);
  });

  it("gives the engine the cuts in assembly coordinates, and plain parts exactly as before", () => {
    const { asm } = withHole();
    const inputs = instancesForKernel(asm, parts, [asm]);
    const stage = inputs.find((i) => i.id === "i2")!.cuts!;
    expect(stage.map((c) => c.features.map((f) => f.id))).toEqual([["sk", "ho"]]);
    // Cut where it's solved to be.
    expect(stage[0].at.position).toEqual([0, 0, 5]);
    // An exploded view moves the copy on, but it's cut where it sits in the assembly.
    const shown = instancesForKernel(asm, parts, [asm], undefined, { i1: at(0, 0, 0), i2: at(0, 0, 50) });
    const moved = shown.find((i) => i.id === "i2")!;
    expect([moved.position, moved.cuts![0].at.position]).toEqual([[0, 0, 50], [0, 0, 5]]);
    const plain = { ...asm, features: undefined };
    expect(instancesForKernel(plain, parts, [asm]).every((i) => !("cuts" in i))).toBe(true);
    // A suppressed hole cuts nothing.
    const off = { ...asm, features: asm.features!.map((f) => (f.id === "ho" ? { ...f, suppressed: true } : f)) };
    expect(cutsFor(off, "i1")).toBeUndefined();
  });

  it("cuts the sub-assembly's own features first, then the assembly's, and marks modified parts inside sub-assemblies in the structured list", () => {
    const { doc: d } = withHole();
    // The sub-assembly drills its own plate; the top assembly's hole also takes that plate.
    const subSketch = assemblySketch(d.assemblies![1], planeOnFace([0, 0, 1], [0, 0, 5], "Top"), addPoint(emptySketch(), { x: 2, y: 2 }).sketch, "ssk");
    const subHole = assemblyHole({ features: [subSketch] }, subSketch.id, { diameter: 2, throughAll: true }, "sho");
    const withSub = addAssemblyFeatures(d, "B", [subSketch, subHole]);
    const top = setFeatureParts(withSub.assemblies![0], "ho", ["i1", "s1/j1"]);
    const all = [top, withSub.assemblies![1]];
    const inner = instancesForKernel(top, parts, all).find((i) => i.id === "s1/j1")!;
    expect(inner.cuts!.map((c) => c.features.map((f) => f.id))).toEqual([["ssk", "sho"], ["sk", "ho"]]);
    const rows = billOfMaterials(top, { p1: "Plate", p2: "Lid" }, {}, undefined, {}, { assemblies: all, structured: true, modified: new Map([["s1/j1", 900]]) });
    expect(rows.some((r) => r.level === 1 && r.name === "Plate (modified in assembly)")).toBe(true);
  });

  it("solves a state not cut yet with the latest cut copies, keeping them when it would be cut the same", () => {
    const { asm } = withHole();
    const cuts = () => undefined;
    const same = [asm];
    const changed = [asm];
    carryCutMeshesOver((list) => ({ cuts, same: list === same }));
    try {
      expect(rememberedCutMeshes(same, parts)).toBe(cuts);
      expect(rememberedCutMeshes(changed, parts)).toBe(cuts);
      carryCutMeshesOver(null);
      // Kept only for the state that would be cut exactly the same.
      expect(rememberedCutMeshes(same, parts)).toBe(cuts);
      expect(rememberedCutMeshes(changed, parts)).toBeUndefined();
    } finally {
      carryCutMeshesOver(null);
    }
  });

  it("deletes a sketch's hole with it, and forgets parts that are gone", () => {
    const { asm } = withHole();
    expect(assemblyFeatureDependents(asm, ["sk"])).toEqual(["sk", "ho"]);
    const chosen = setFeatureParts(asm, "ho", ["i1", "i2"]);
    expect(deleteAssemblyFeatures(chosen, ["sk"])).toEqual({ id: asm.id, name: asm.name, instances: asm.instances });
    const d = { ...doc().doc, assemblies: [chosen, doc().doc.assemblies![1]] };
    const fewer = updateAssembly(d, "A", (a) => withoutInstances(a, ["i1"]));
    expect(fewer.assemblies![0].featureParts).toEqual({ ho: ["i2"] });
  });

  it("saves and reads back the features and the parts they cut; an old file is read as it was", () => {
    const { doc: d, asm } = withHole();
    const saved = { ...d, assemblies: [setFeatureParts(asm, "ho", ["i2"]), d.assemblies![1]] };
    const back = readDocumentFile(serializeDocument(saved));
    if (!back.ok) throw new Error(back.error);
    expect(back.doc.assemblies![0].features).toEqual(saved.assemblies[0].features);
    expect(back.doc.assemblies![0].featureParts).toEqual({ ho: ["i2"] });
    // A feature kind an assembly can't hold (a New extrude) is left out when read.
    const odd = JSON.parse(serializeDocument(saved));
    odd.assemblies[0].features.push({ ...odd.assemblies[0].features[1], id: "x1", type: "box", operation: "new" });
    const read = readDocumentFile(JSON.stringify(odd));
    expect(read.ok && read.doc.assemblies![0].features!.map((f) => f.id)).toEqual(["sk", "ho"]);
    const old = doc().doc;
    const again = readDocumentFile(serializeDocument(old));
    expect(again.ok && serializeDocument(again.doc, new Date(0))).toBe(serializeDocument(old, new Date(0)));
  });
});

describe("Fillet and Chamfer in an assembly", () => {
  const edge = (z: number) => ({ kind: "edge" as const, curve: "LINE", a: [0, 0, z] as [number, number, number], b: [10, 0, z] as [number, number, number], mid: [5, 0, z] as [number, number, number] });

  it("reaches only the copies it has edges on, each given just its own edges; copies removed drop their edges", () => {
    const { doc: d, asm } = withHole();
    const f = assemblyEdgeFeature(asm, "fillet", [{ partId: "i1", ref: edge(0) }, { partId: "i2", ref: edge(5) }, { partId: "s1/j1", ref: edge(1) }], { size: 2 }, "fi");
    expect(f).toMatchObject({ name: "Fillet 1", type: "fillet", params: { radius: "2 mm" } });
    const a = { ...asm, features: [...asm.features!, f], featureParts: { ho: ["i1"] } };
    expect(featureCuts(a, f, "i2")).toBe(true);
    expect(featureCuts(setFeatureParts(a, "fi", []), f, "i2")).toBe(true);
    expect(cutsFor(a, "i2")!.map((x) => [x.id, x.picks?.length ?? 0])).toEqual([["fi", 1]]);
    expect(cutsFor(a, "i1")!.map((x) => x.id)).toEqual(["sk", "ho", "fi"]);
    expect(cutsFor(a, "i1")!.at(-1)!.picks).toEqual([{ partId: "i1", ref: edge(0) }]);
    // The same object each time (the engine's cache and the solver's signatures compare them).
    expect(cutsFor(a, "i1")!.at(-1)).toBe(cutsFor(a, "i1")!.at(-1));
    const placed = instancesForKernel(a, parts, [a, d.assemblies![1]]);
    expect(placed.find((i) => i.id === "s1/j1")!.cuts!.at(-1)!.features.map((x) => x.id)).toEqual(["fi"]);
    const fewer = updateAssembly({ ...d, assemblies: [a, d.assemblies![1]] }, "A", (x) => withoutInstances(x, ["i2"]));
    expect(fewer.assemblies![0].features!.find((x) => x.id === "fi")!.picks!.map((p) => p.partId)).toEqual(["i1", "s1/j1"]);
    expect(assemblyFeaturesText(a, (k) => k)).toMatch(/Fillet 1 \(fillet, radius 2 mm, on 3 edges of i1, i2, s1\/j1\)/);
  });

  it("saves and reads back a chamfer and what it needs", () => {
    const { doc: d, asm } = withHole();
    const c = assemblyEdgeFeature(asm, "chamfer", [{ partId: "i1", ref: edge(5) }], { size: 1 }, "ch");
    const a = setFeatureNeeds({ ...asm, features: [...asm.features!, c] }, "ch", ["ho"]);
    expect(assemblyFeatureDependents(a, ["ho"])).toEqual(["ho", "ch"]);
    expect(assemblyFeatureDependents(a, ["sk"])).toEqual(["sk", "ho", "ch"]);
    const saved = { ...d, assemblies: [a, d.assemblies![1]] };
    const back = readDocumentFile(serializeDocument(saved));
    if (!back.ok) throw new Error(back.error);
    expect(back.doc.assemblies![0].features).toEqual(a.features);
    expect(back.doc.assemblies![0].featureNeeds).toEqual({ ch: ["ho"] });
    // Needs naming features that aren't there are dropped.
    const odd = JSON.parse(serializeDocument(saved));
    odd.assemblies[0].featureNeeds = { ch: ["gone"], ho: "x" };
    const read = readDocumentFile(JSON.stringify(odd));
    expect(read.ok && read.doc.assemblies![0].featureNeeds).toBeUndefined();
  });
});

describe("edit in context", () => {
  it("takes a snapshot of where the other parts are, relative to the part being edited", () => {
    const { doc: d } = doc();
    const r = takeContext(d, "A", "i2", parts, undefined, "c1");
    if ("error" in r) throw new Error(r.error);
    expect(r.context.studioId).toBe("ps2");
    // The plate seen from the lid (5 above it), and the plate in the sub-assembly (100 along) too.
    expect(r.context.parts.map((p) => [p.key, p.placement.position])).toEqual([
      ["i1", [0, 0, -5]],
      ["s1/j1", [100, 0, -5]],
    ]);
    // Taken again with nothing moved: the same document.
    const again = takeContext(r.doc, "A", "i2", parts);
    expect("doc" in again && again.doc).toBe(r.doc);
    expect(contextInputs(r.doc, "ps2")![0].parts.map((p) => p.id)).toEqual([contextPartId("c1", "i1"), contextPartId("c1", "s1/j1")]);
    expect(contextInputs(r.doc, "main")).toBeUndefined();
    expect(contextPartOf(contextPartId("c1", "s1/j1"))).toEqual({ context: "c1", key: "s1/j1" });
  });

  it("can be hidden, removed, and is forgotten with its Part Studio", () => {
    const { doc: d } = doc();
    const r = takeContext(d, "A", "i2", parts, undefined, "c1");
    if ("error" in r) throw new Error(r.error);
    expect(setContextHidden(r.doc, "c1", true).contexts![0].hidden).toBe(true);
    expect(removeContext(r.doc, "c1").contexts).toBeUndefined();
    expect(tidyContexts(r.doc, ["main"]).contexts).toBeUndefined();
    const back = readDocumentFile(serializeDocument(r.doc));
    expect(back.ok && back.doc.contexts).toEqual(r.doc.contexts);
  });

  it("says plainly why a copy can't be edited in context", () => {
    const { doc: d } = doc();
    expect(takeContext(d, "A", "nope", parts)).toEqual({ error: "That part isn't in this assembly any more." });
    expect(takeContext(d, "A", "i1", [mesh("p2", "ps2")])).toEqual({ error: "That part hasn't been built yet. Wait a moment, then try again." });
  });

  it("goes with its Part Studio, and stops showing anything once its assembly or part is gone", () => {
    const { doc: d } = doc();
    const withStudio = { ...d, partStudios: [{ id: "ps2", name: "Part Studio 2", features: [] }] };
    const r = takeContext(withStudio, "A", "i2", parts, undefined, "c1");
    if ("error" in r) throw new Error(r.error);
    expect(removeStudio(r.doc, "ps2").contexts).toBeUndefined();
    expect(contextGone(r.doc, r.context)).toBeNull();
    const noPart = updateAssembly(r.doc, "A", (a) => withoutInstances(a, ["i2"]));
    expect(contextGone(noPart, r.context)).toMatch(/no longer in Assembly 1/);
    expect(contextInputs(noPart, "ps2")).toBeUndefined();
    const noAssembly = { ...r.doc, assemblies: r.doc.assemblies!.filter((a) => a.id !== "A") };
    expect(contextGone(noAssembly, r.context)).toMatch(/assembly has been deleted/);
  });
});
