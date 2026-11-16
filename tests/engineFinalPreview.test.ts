import { beforeAll, describe, expect, it } from "vitest";

import { GeometryEngine } from "../src/kernel/engine";
import type { StudioInput } from "../src/kernel/protocol";
import type { Feature } from "../src/model/types";
import { extrudeFeature, feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

type Inside = { builds: Map<string, unknown>; parked: Map<string, unknown> };
const inside = (e: GeometryEngine) => e as unknown as Inside;
const height = (m: { vertices: Float32Array | number[] }) => Math.max(...Array.from(m.vertices).filter((_, k) => k % 3 === 2));

describe("a Part Studio shown rolled back while a feature is edited (Final off)", () => {
  it("keeps the whole build aside: other studios aren't rebuilt, later problems stay, and closing takes it back at once", () => {
    const engine = new GeometryEngine();
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const taller = feature("box", { width: 10, depth: 10, height: 30 }, "add");
    const broken: Feature = extrudeFeature("no-such-sketch", 5, { operation: "add" });
    const derived: Feature = { ...feature("derived", { x: 0, y: 0, z: 50 }), derived: { studioId: "main", partId: box.id } };
    const whole: StudioInput[] = [
      { id: "main", features: [box, taller, broken] },
      { id: "s2", features: [derived] },
    ];
    const first = engine.rebuildStudios(whole);
    expect(first.rebuilt.sort()).toEqual(["main", "s2"]);
    expect(first.featureErrors[broken.id]).toBeTruthy();
    const full = inside(engine).builds.get("main");
    expect(height(first.parts.find((p) => p.studioId === "main")!)).toBeCloseTo(30, 4);

    // Editing the first box with Final off: only it is built, the studio using its part isn't touched.
    const edited = { ...box, params: { ...box.params, height: "12" } };
    const preview = engine.rebuildStudios([{ id: "main", features: [edited], preview: true }, whole[1]]);
    expect(preview.rebuilt).toEqual(["main"]);
    expect(height(preview.parts.find((p) => p.studioId === "main")!)).toBeCloseTo(12, 4);
    // The later feature's problem is still on its row.
    expect(preview.featureErrors[broken.id]).toBe(first.featureErrors[broken.id]);
    expect(inside(engine).parked.get("main")).toBe(full);
    // Typing on: still only that studio, still the whole build kept aside.
    const typed = engine.rebuildStudios([{ id: "main", features: [{ ...edited, params: { ...edited.params, height: "14" } }], preview: true }, whole[1]]);
    expect(typed.rebuilt).toEqual(["main"]);
    expect(inside(engine).parked.get("main")).toBe(full);

    // Cancelled (or Final ticked with nothing changed): the whole build comes back without building anything.
    const back = engine.rebuildStudios(whole);
    expect(back.rebuilt).toEqual(["main"]);
    expect(inside(engine).builds.get("main")).toBe(full);
    expect(inside(engine).parked.size).toBe(0);
    expect(height(back.parts.find((p) => p.studioId === "main")!)).toBeCloseTo(30, 4);
    expect(back.featureErrors[broken.id]).toBe(first.featureErrors[broken.id]);
  });

  it("builds everything again (with the change) when the edit is accepted", () => {
    const engine = new GeometryEngine();
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const hole = feature("cylinder", { diameter: 4, height: 40, x: 5, y: 5, z: 0 }, "remove");
    const derived: Feature = { ...feature("derived", { x: 0, y: 0, z: 50 }), derived: { studioId: "main", partId: box.id } };
    engine.rebuildStudios([{ id: "main", features: [box, hole] }, { id: "s2", features: [derived] }]);
    const edited = { ...box, params: { ...box.params, height: "20" } };
    engine.rebuildStudios([{ id: "main", features: [edited], preview: true }, { id: "s2", features: [derived] }]);
    const accepted = engine.rebuildStudios([{ id: "main", features: [edited, hole] }, { id: "s2", features: [derived] }]);
    expect(accepted.rebuilt.sort()).toEqual(["main", "s2"]);
    expect(inside(engine).parked.size).toBe(0);
    const mine = accepted.parts.find((p) => p.studioId === "main")!;
    expect(height(mine)).toBeCloseTo(20, 4);
    expect(height(accepted.parts.find((p) => p.studioId === "s2")!)).toBeCloseTo(70, 4);
  });
});
