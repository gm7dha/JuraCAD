/**
 * A Plane feature's line used as a Revolve's axis, with the real OpenCascade engine: the solid spins round where the
 * plane crosses the sketch, and moves (and changes size) when the plane's offset changes.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { GeometryEngine } from "../src/kernel/engine";
import type { Feature, PlaneOptions } from "../src/model/types";
import { linkEdge } from "../src/sketch/links";
import { addRectangle } from "../src/sketch/ops";
import { planeRefs } from "../src/sketch/planeRefs";
import { planeFrame, type SketchPlane } from "../src/sketch/planes";
import { solveSketch } from "../src/sketch/solver";
import { emptySketch } from "../src/sketch/types";
import { feature, loadOpenCascade, sketchFeature } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuildStudios([{ id: "main", features }]);
}

describe("a plane's line as a revolve axis", () => {
  it("spins round where an offset of Right crosses a sketch on Front, and follows the plane", () => {
    const FRONT: SketchPlane = { kind: "default", name: "Front" };
    const plane: Feature = { ...feature("plane", { distance: 30 }), planeDef: { mode: "offset", ref: { kind: "default", name: "Right" }, axis: "u" } as PlaneOptions };
    const right = planeFrame({ kind: "default", name: "Right" });
    const frame = { ...right, origin: [30, 0, 0] as [number, number, number] };
    const line = planeRefs(planeFrame(FRONT), [{ id: plane.id, name: plane.name, frame }]).find((e) => e.source?.sketch === plane.id)!;
    expect(line.a[0]).toBeCloseTo(30, 9);
    const used = linkEdge(emptySketch(), line, true);
    // A 10 × 10 square from x 40 to 50, its left side held 10 from the plane's line.
    const rect = addRectangle(used.sketch, { x: 40, y: 0, snap: null }, { x: 50, y: 10, snap: null });
    const [bottom, side] = rect.lineIds;
    const left = rect.sketch.curves.find((c) => c.id === rect.lineIds[3])!;
    const corner = (left as { p1: string }).p1;
    const solved = solveSketch({
      ...rect.sketch,
      constraints: [
        ...rect.sketch.constraints,
        { id: "w", type: "length", refs: [bottom], value: "10" },
        { id: "h", type: "length", refs: [side], value: "10" },
        { id: "g", type: "pointLineDistance", refs: [corner, used.curveId], value: "10" },
      ],
    });
    expect(solved.ok).toBe(true);
    const sk = sketchFeature(FRONT, solved.sketch);
    const rev: Feature = { ...feature("revolve", { angle: 360 }), sketchRef: sk.id, revolve: { axis: used.curveId, flip: false } };
    const first = build([plane, sk, rev]);
    expect(first.featureErrors).toEqual({});
    expect(engine.massProperties([rev.id])[0].volume).toBeCloseTo(Math.PI * (20 * 20 - 10 * 10) * 10, 0);
    // The plane moved to 35: the axis moves with it (the square, held 10 from it, too) — same size, round x = 35.
    const moved = build([{ ...plane, params: { ...plane.params, distance: "35" } }, sk, rev]);
    expect(moved.featureErrors).toEqual({});
    const mp = engine.massProperties([rev.id])[0];
    expect(mp.volume).toBeCloseTo(Math.PI * (20 * 20 - 10 * 10) * 10, 0);
    expect(mp.centre[0]).toBeCloseTo(35, 3);
  });
});
