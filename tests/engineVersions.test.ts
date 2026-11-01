/**
 * Comparing versions: an old version's Part Studios are built beside the
 * design (ids "<studio>@version:<id>"), with the version's own variable values,
 * without rebuilding the design's own. Real OpenCascade engine.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { compareStudioInputs, versionSuffix } from "../src/kernel/buildInput";
import { GeometryEngine } from "../src/kernel/engine";
import { emptyDocument } from "../src/model/document";
import type { JuraCADDocument } from "../src/model/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

describe("building an old version beside the design", () => {
  it("gives its parts their own ids and its own sizes, and leaves the design's build alone", () => {
    engine = new GeometryEngine();
    const box = { ...feature("box", { width: "w", depth: 10, height: 10 }), id: "box1" };
    const now: JuraCADDocument = { ...emptyDocument(), features: [box], variables: [{ id: "v", name: "w", value: "40" }] };
    const old: JuraCADDocument = { ...now, variables: [{ id: "v", name: "w", value: "20" }] };
    const first = engine.rebuildStudios([{ id: "main", features: now.features }], { w: 40 });
    expect(first.rebuilt).toEqual(["main"]);
    const inputs = compareStudioInputs("ver1", { ...old, partNames: { box1: "Old base" } });
    expect(inputs.map((s) => s.id)).toEqual(["main" + versionSuffix("ver1")]);
    const both = engine.rebuildStudios([{ id: "main", features: now.features }, ...inputs], { w: 40 });
    // Only the old version was built; the design's own parts are as they were.
    expect(both.rebuilt).toEqual(["main@version:ver1"]);
    expect(both.parts).toHaveLength(1);
    const ghost = both.parts[0];
    expect(ghost.id).toBe("box1@version:ver1");
    expect(ghost.configuration).toBe("version:ver1");
    expect(ghost.studioId).toBe("main@version:ver1");
    // Named as the old version named it, not as the design does now.
    expect(ghost.name).toBe("Old base");
    expect(first.parts[0].name).toBe("Part 1");
    expect(ghost.volume!).toBeCloseTo(20 * 10 * 10, 3);
    expect(first.parts[0].volume!).toBeCloseTo(40 * 10 * 10, 3);
    // No feature problems are reported for the old version.
    expect(Object.keys(both.featureErrors)).toEqual([]);
    // Stopping the comparison drops the old version's build, again without rebuilding the design.
    const after = engine.rebuildStudios([{ id: "main", features: now.features }], { w: 40 });
    expect(after.rebuilt).toEqual([]);
    expect(engine.partCount).toBe(1);
  });
});
