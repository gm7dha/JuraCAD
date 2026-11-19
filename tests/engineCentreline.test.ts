/**
 * Centreline dimensions (`SketchConstraint.doubled`) with the real OpenCascade engine: a revolve profile dimensioned as a
 * diameter across its axis comes out that diameter.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { Feature } from "../src/model/types";
import { addDimension, addLine, addRectangle, measure, setDimensionValue } from "../src/sketch/ops";
import { setCentrelineDimension } from "../src/sketch/dimensionKinds";
import { emptySketch } from "../src/sketch/types";
import { loadOpenCascade, feature, sketchFeature, meshOf, relativeError } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

describe("a centreline dimension on a revolve profile", () => {
  it("gives the turned part the diameter typed", () => {
    const axis = addLine(emptySketch(), { x: 0, y: -5, snap: null }, { x: 0, y: 20, snap: null }, { construction: true });
    // The axis held upright through the origin (else the solver may lean it to meet the size).
    const held = { ...axis.sketch, constraints: [...axis.sketch.constraints, { id: "fixAxis", type: "fix" as const, refs: [axis.sketch.points[0].id] }, { id: "upright", type: "vertical" as const, refs: [axis.lineId] }] };
    const rect = addRectangle(held, { x: 2, y: 0, snap: null }, { x: 6, y: 10, snap: null });
    const right = rect.sketch.curves.find((c) => c.id === rect.lineIds[1]);
    if (right?.type !== "line") throw new Error("no right side");
    const d = addDimension(rect.sketch, [right.p2, axis.lineId]);
    expect(d.error).toBeUndefined();
    const on = setCentrelineDimension(d.sketch, d.dimensionId, true);
    expect(on.error).toBeUndefined();
    const typed = setDimensionValue(on.sketch, d.dimensionId, "30");
    expect(typed.error).toBeUndefined();
    const c = typed.sketch.constraints.find((k) => k.id === d.dimensionId)!;
    expect(measure(typed.sketch, c)).toBeCloseTo(30, 6);
    const sk = sketchFeature({ kind: "default", name: "Front" }, typed.sketch);
    const rev: Feature = { ...feature("revolve", { angle: 360 }), sketchRef: sk.id, revolve: { axis: axis.lineId, flip: false } };
    engine = new GeometryEngine();
    const r = engine.rebuild([sk, rev]);
    expect(r.featureErrors).toEqual({});
    const v = r.parts[0].vertices;
    let most = 0;
    for (let i = 0; i < v.length; i += 3) most = Math.max(most, Math.hypot(v[i], v[i + 1]));
    expect(most).toBeCloseTo(15, 2);
    // A tube from radius 2 to 15, 10 tall.
    expect(relativeError(meshOf(r).volume, Math.PI * (15 * 15 - 2 * 2) * 10)).toBeLessThan(0.01);
  });
});
