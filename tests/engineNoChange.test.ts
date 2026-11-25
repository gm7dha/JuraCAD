/**
 * Features that change nothing (real OpenCascade engine): a Remove pointing out of the part into the air, an Add wholly
 * inside the part, get a "This doesn't change anything" warning — and features that do change something, or are a
 * pattern's seed, don't.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { GeometryEngine, noChangeMessage } from "../src/kernel/engine";
import { defaultParams } from "../src/model/features";
import type { Feature } from "../src/model/types";
import { addCircle } from "../src/sketch/ops";
import type { SketchPlane } from "../src/sketch/planes";
import { emptySketch } from "../src/sketch/types";
import { loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine | undefined;
afterEach(() => engine?.dispose());
const build = (features: Feature[]) => {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features);
};

const box: Feature = { id: "b", name: "Box", type: "box", operation: "new", suppressed: false, params: defaultParams("box") };
const top: SketchPlane = { kind: "face", origin: [0, 0, 20], u: [1, 0, 0], v: [0, 1, 0], label: "Top of the box" };
const circle = (id: string, x: number, y: number, r: number, plane = top): Feature => ({ id, name: id, type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane, data: addCircle(emptySketch(), { x, y }, r).sketch } });
const extrude = (id: string, sketchRef: string, operation: Feature["operation"], depth: number, flip: boolean): Feature => ({
  id,
  name: id,
  type: "extrude",
  operation,
  suppressed: false,
  params: { ...defaultParams("extrude"), depth: String(depth) },
  sketchRef,
  extrude: { end: "blind", flip },
  apart: true,
  intersectAll: true,
});

describe("a feature that changes nothing", () => {
  it("warns about a Remove cutting up into the air from the top face, and not once it's flipped into the part", () => {
    const up = build([box, circle("s", 20, 15, 5), extrude("cut", "s", "remove", 5, false)]);
    expect(up.featureWarnings?.cut).toBe(noChangeMessage("remove"));
    expect(up.featureErrors.cut).toBeUndefined();
    const down = build([box, circle("s", 20, 15, 5), extrude("cut", "s", "remove", 5, true)]);
    expect(down.featureWarnings?.cut).toBeUndefined();
    expect(down.parts[0].volume).toBeCloseTo(24000 - Math.PI * 25 * 5, 0);
  });

  it("warns about an Add wholly inside the part, not one that grows it or makes a new part", () => {
    const inside = build([box, circle("s", 20, 15, 5), extrude("boss", "s", "add", 5, true)]);
    expect(inside.featureWarnings?.boss).toBe(noChangeMessage("add"));
    const grows = build([box, circle("s", 20, 15, 5), extrude("boss", "s", "add", 5, false)]);
    expect(grows.featureWarnings?.boss).toBeUndefined();
    const apart: SketchPlane = { kind: "face", origin: [0, 0, 40], u: [1, 0, 0], v: [0, 1, 0], label: "Up high" };
    const floating = build([box, circle("s", 20, 15, 5, apart), extrude("boss", "s", "add", 5, false)]);
    expect(floating.parts.length).toBe(2);
    expect(floating.featureWarnings?.boss).toBeUndefined();
  });

  it("says nothing about a cut a pattern repeats (its seed may sit off the part on purpose)", () => {
    const pattern: Feature = { id: "p", name: "p", type: "linearPattern", operation: "add", suppressed: false, params: { ...defaultParams("linearPattern"), spacing: "10" }, pattern: { sources: ["cut"], axis: "x", flip: false } };
    const r = build([box, circle("s", 20, 15, 5), extrude("cut", "s", "remove", 5, false), pattern]);
    expect(r.featureWarnings?.cut).toBeUndefined();
  });
});
