/**
 * Edit in context on real parts: a part's Part Studio shows the assembly's
 * other parts round it, a sketch there Uses an edge of one of them, and
 * "Update context" moves that edge (and the sketch's line follows).
 */
import { beforeAll, describe, expect, it } from "vitest";

import { contextInputs, contextPartId, takeContext, updateContext } from "../src/assembly/inContext";
import { emptyDocument } from "../src/model/document";
import { GeometryEngine } from "../src/kernel/engine";
import type { PartMesh, StudioInput } from "../src/kernel/protocol";
import type { Assembly, Feature, JuraCADDocument } from "../src/model/types";
import { linkEdge } from "../src/sketch/links";
import { emptySketch } from "../src/sketch/types";
import { feature, loadOpenCascade, sketchFeature } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

const at = (x: number, y: number, z: number) => ({ position: [x, y, z] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] });

describe("edit in context", () => {
  const engine = new GeometryEngine();
  // Part Studio 1: a 40 × 40 × 5 plate. Part Studio 2: a 10 mm block (at x 100 in its own studio).
  const plate = feature("box", { width: 40, depth: 40, height: 5 });
  const block = feature("box", { width: 10, depth: 10, height: 10, x: 100 });
  const assembly = (plateAt: number): Assembly => ({
    id: "A",
    name: "Assembly 1",
    instances: [
      { id: "i1", partId: plate.id, name: "Plate <1>", placement: at(plateAt, 0, 0), fixed: true },
      // The block sits on the plate: moved back 100 and up 5.
      { id: "i2", partId: block.id, name: "Block <1>", placement: at(-100, 0, 5), fixed: true },
    ],
  });
  const docWith = (asm: Assembly, sketches: Feature[] = []): JuraCADDocument => {
    const base = emptyDocument("In context");
    return { ...base, features: [plate], partStudios: [{ id: "ps2", name: "Part Studio 2", features: [block, ...sketches] }], assemblies: [asm] };
  };
  const inputs = (doc: JuraCADDocument): StudioInput[] => [
    { id: "main", features: doc.features },
    { id: "ps2", features: doc.partStudios![0].features, ...(contextInputs(doc, "ps2") ? { contexts: contextInputs(doc, "ps2") } : {}) },
  ];
  let parts: PartMesh[] = [];
  beforeAll(() => {
    parts = engine.rebuildStudios(inputs(docWith(assembly(0)))).parts;
  });

  it("shows the plate round the block, placed relative to it, and a sketch uses its edge", () => {
    const made = takeContext(docWith(assembly(0)), "A", "i2", parts, undefined, "c1");
    if ("error" in made) throw new Error(made.error);
    expect(made.context.studioId).toBe("ps2");
    expect(made.context.parts.map((p) => p.key)).toEqual(["i1"]);
    // The plate, seen from the block: 100 along x and 5 down.
    expect(made.context.parts[0].placement.position).toEqual([100, 0, -5]);

    const r = engine.rebuildStudios(inputs(made.doc));
    const ctx = r.contextParts!;
    expect(ctx.map((m) => [m.id, m.studioId])).toEqual([[contextPartId("c1", "i1"), "ps2"]]);
    // Context parts aren't the Part Studio's own parts.
    expect(r.parts.some((p) => p.id.startsWith("ctx:"))).toBe(false);

    // Use the plate's top edge along y at x = 140 (z = 0 in the block's studio: the Top plane).
    const m = ctx[0];
    const ref = m.edgeRefs.find((e) => e.curve === "LINE" && Math.abs(e.a[0] - 140) < 1e-6 && Math.abs(e.b[0] - 140) < 1e-6 && Math.abs(e.a[2]) < 1e-6)!;
    expect(ref).toBeDefined();
    const used = engine.useEdge(m.id, ref, { kind: "default", name: "Top" });
    if ("error" in used) throw new Error(used.error);
    const linked = linkEdge(emptySketch(), used.edge, false);
    expect(linked.error).toBeUndefined();
    const sketch = sketchFeature({ kind: "default", name: "Top" }, linked.sketch);

    const withSketch = { ...made.doc, partStudios: [{ ...made.doc.partStudios![0], features: [block, sketch] }] };
    const built = engine.rebuildStudios(inputs(withSketch));
    expect(built.featureErrors[sketch.id]).toBeUndefined();
    const line = built.sketchLinks![sketch.id].links[linked.curveId]!;
    expect(line.a[0]).toBeCloseTo(140, 6);

    // The plate moves 5 along x in the assembly; Update context; the line follows.
    const movedDoc = { ...withSketch, assemblies: [assembly(5)] };
    const updated = updateContext(movedDoc, "c1", parts);
    if ("error" in updated) throw new Error(updated.error);
    expect(updated.context.parts[0].placement.position).toEqual([105, 0, -5]);
    const again = engine.rebuildStudios(inputs(updated.doc));
    expect(again.featureErrors[sketch.id]).toBeUndefined();
    expect(again.sketchLinks![sketch.id].links[linked.curveId]!.a[0]).toBeCloseTo(145, 6);
    // Without its context, the line's edge is lost (said plainly on the sketch).
    const gone = engine.rebuildStudios(inputs({ ...updated.doc, contexts: [] }));
    expect(gone.sketchLinks![sketch.id].links[linked.curveId]).toBeNull();
  });

  it("follows the other part's shape: the plate made thicker shows thicker", () => {
    const made = takeContext(docWith(assembly(0)), "A", "i2", parts, undefined, "c2");
    if ("error" in made) throw new Error(made.error);
    const thick = { ...plate, params: { ...plate.params, height: "8" } };
    const doc = { ...made.doc, features: [thick] };
    const r = engine.rebuildStudios(inputs(doc));
    expect(r.contextParts![0].volume).toBeCloseTo(40 * 40 * 8, 3);
  });

  it("leaves out parts from the block's own Part Studio", () => {
    const asm = assembly(0);
    const two: Assembly = { ...asm, instances: [...asm.instances, { id: "i3", partId: block.id, name: "Block <2>", placement: at(-80, 0, 5), fixed: true }] };
    const made = takeContext(docWith(two), "A", "i2", parts, undefined, "c3");
    if ("error" in made) throw new Error(made.error);
    expect(made.context.parts.map((p) => p.key)).toEqual(["i1"]);
  });
});
