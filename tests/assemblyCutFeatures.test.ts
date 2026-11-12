/**
 * Assembly features and Edit in context, without the geometry engine: which
 * copies a cut reaches, where the cut is given to the engine, what goes with
 * a deleted sketch, saving and reading back, and contexts' snapshots.
 */
import { describe, expect, it } from "vitest";

import { addAssemblyFeatures, assemblyFeatureDependents, assemblyHole, assemblySketch, cutsFor, deleteAssemblyFeatures, featureCuts, setFeatureParts } from "../src/assembly/assemblyFeatures";
import { updateAssembly, withoutInstances } from "../src/assembly/assembly";
import { instancesForKernel } from "../src/assembly/placed";
import { contextInputs, contextPartOf, contextPartId, removeContext, setContextHidden, takeContext, tidyContexts } from "../src/assembly/inContext";
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
    expect(inputs.find((i) => i.id === "i2")?.cuts?.map((f) => f.id)).toEqual(["sk", "ho"]);
    // Placed where solved: no separate place to cut at.
    expect(inputs.find((i) => i.id === "i2")?.cutAt).toBeUndefined();
    // An exploded view moves the copy on, but it's cut where it sits in the assembly.
    const shown = instancesForKernel(asm, parts, [asm], undefined, { i1: at(0, 0, 0), i2: at(0, 0, 50) });
    expect(shown.find((i) => i.id === "i2")?.cutAt?.position).toEqual([0, 0, 5]);
    const plain = { ...asm, features: undefined };
    expect(instancesForKernel(plain, parts, [asm]).every((i) => !("cuts" in i) && !("cutAt" in i))).toBe(true);
    // A suppressed hole cuts nothing.
    const off = { ...asm, features: asm.features!.map((f) => (f.id === "ho" ? { ...f, suppressed: true } : f)) };
    expect(cutsFor(off, "i1")).toBeUndefined();
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
});
