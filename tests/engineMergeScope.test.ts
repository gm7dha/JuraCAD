/**
 * Onshape's Merge scope with the real OpenCascade engine: three 10 mm boxes in a row (x 0…10, 20…30, 40…50), and
 * Add / Remove / Intersect / patterns that may change only the parts chosen.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { GeometryEngine } from "../src/kernel/engine";
import { analyzeMesh } from "../src/geometry/meshCheck";
import { defaultParams } from "../src/model/features";
import type { Feature, Operation } from "../src/model/types";
import { addRectangle } from "../src/sketch/ops";
import { emptySketch } from "../src/sketch/types";
import { loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);
let engine: GeometryEngine | null = null;
afterEach(() => {
  engine?.dispose();
  engine = null;
});

const box = (id: string, x: number): Feature => ({
  id,
  name: id,
  type: "box",
  operation: "new",
  suppressed: false,
  params: { ...defaultParams("box"), width: "10", depth: "10", height: "10", x: String(x), y: "0", z: "0" },
});
const boxes = () => [box("b1", 0), box("b2", 20), box("b3", 40)];
const sketch = (id: string, x0: number, y0: number, x1: number, y1: number): Feature => ({
  id,
  name: id,
  type: "sketch",
  operation: "new",
  suppressed: false,
  params: {},
  sketch: { plane: { kind: "default", name: "Top" }, data: addRectangle(emptySketch(), { x: x0, y: y0 }, { x: x1, y: y1 }).sketch },
});
/** An Onshape-style extrude, symmetric about the Top plane. */
const extrude = (id: string, sketchRef: string, operation: Operation, depth: number, extra: Partial<Feature> = {}): Feature => ({
  id,
  name: id,
  type: "extrude",
  operation,
  suppressed: false,
  params: { ...defaultParams("extrude"), depth: String(depth) },
  sketchRef,
  extrude: { end: "symmetric", flip: false },
  apart: true,
  intersectAll: true,
  ...extra,
});
const build = (features: Feature[]) => {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features);
};
const volumes = (r: ReturnType<GeometryEngine["rebuild"]>) => Object.fromEntries(r.parts.map((p) => [p.id, analyzeMesh(p.vertices, p.triangles).volume]));
const near = (actual: number | undefined, exact: number) => expect(Math.abs((actual ?? NaN) - exact)).toBeLessThan(0.01);

/** A slot 2 wide (y 4…6) across all three boxes, right through their height: 200 mm³ out of each. */
const slot = () => sketch("s", -5, 4, 55, 6);

describe("Merge scope", () => {
  it("Remove with no scope cuts every box (as before); with box 2 only, just box 2", () => {
    const all = build([...boxes(), slot(), extrude("cut", "s", "remove", 40)]);
    expect(all.featureErrors).toEqual({});
    for (const v of Object.values(volumes(all))) near(v, 800);
    const one = build([...boxes(), slot(), extrude("cut", "s", "remove", 40, { mergeScope: ["b2"] })]);
    expect(one.featureErrors).toEqual({});
    const v = volumes(one);
    near(v.b1, 1000);
    near(v.b2, 800);
    near(v.b3, 1000);
  });

  it("Add touching boxes 1 and 2 with scope = box 1 joins only box 1; with box 3 it's a new part", () => {
    // x 8…22, y 0…10, z −1…1: 280 mm³, overlapping each of boxes 1 and 2 by 20 mm³.
    const plate = sketch("s", 8, 0, 22, 10);
    const all = build([...boxes(), plate, extrude("add", "s", "add", 2)]);
    expect(all.parts.map((p) => p.id)).toEqual(["b1", "b3"]);
    near(volumes(all).b1, 2000 + 280 - 40);
    const one = build([...boxes(), plate, extrude("add", "s", "add", 2, { mergeScope: ["b1"] })]);
    expect(one.featureErrors).toEqual({});
    expect(one.parts.map((p) => p.id)).toEqual(["b1", "b2", "b3"]);
    const v = volumes(one);
    near(v.b1, 1000 + 280 - 20);
    near(v.b2, 1000);
    const none = build([...boxes(), plate, extrude("add", "s", "add", 2, { mergeScope: ["b3"] })]);
    expect(none.featureErrors).toEqual({});
    expect(none.parts).toHaveLength(4);
    near(volumes(none).add, 280);
    near(volumes(none).b1, 1000);
  });

  it("Intersect with scope = box 2 keeps only its overlap, leaving the others whole", () => {
    const half = sketch("s", -5, 0, 55, 5);
    const r = build([...boxes(), half, extrude("int", "s", "intersect", 40, { mergeScope: ["b2"] })]);
    expect(r.featureErrors).toEqual({});
    const v = volumes(r);
    near(v.b1, 1000);
    near(v.b2, 500);
    near(v.b3, 1000);
  });

  it("a pattern of a scoped cut cuts only the scope's parts; the pattern's own scope wins", () => {
    // A 2 × 2 hole in box 1, repeated 20 apart along X (copies land in boxes 2 and 3).
    const pin = sketch("s", 1, 1, 3, 3);
    const cut = extrude("cut", "s", "remove", 40, { mergeScope: ["b1"] });
    const pattern = (scope?: string[]): Feature => ({
      id: "pat",
      name: "pat",
      type: "linearPattern",
      operation: "add",
      suppressed: false,
      params: { ...defaultParams("linearPattern"), count: "3", spacing: "20" },
      pattern: { sources: ["cut"], axis: "x", flip: false },
      ...(scope ? { mergeScope: scope } : {}),
    });
    const own = build([...boxes(), pin, cut, pattern()]);
    expect(own.featureErrors).toEqual({});
    let v = volumes(own);
    near(v.b1, 960);
    near(v.b2, 1000);
    near(v.b3, 1000);
    const wider = build([...boxes(), pin, cut, pattern(["b1", "b3"])]);
    expect(wider.featureErrors).toEqual({});
    v = volumes(wider);
    near(v.b1, 960);
    near(v.b2, 1000);
    near(v.b3, 960);
  });

  it("a scope part that's gone is left out with a warning; all gone is a plain error", () => {
    const some = build([...boxes(), slot(), extrude("cut", "s", "remove", 40, { mergeScope: ["b2", "gone"] })]);
    expect(some.featureErrors).toEqual({});
    expect(some.featureWarnings?.cut).toMatch(/1 of the 2 parts it was to cut no longer exists/);
    near(volumes(some).b2, 800);
    near(volumes(some).b1, 1000);
    const none = build([...boxes(), slot(), extrude("cut", "s", "remove", 40, { mergeScope: ["gone"] })]);
    expect(none.featureErrors.cut).toMatch(/no longer exists/);
    for (const v of Object.values(volumes(none))) near(v, 1000);
  });

  it("follows a scope part merged into another by an earlier Add", () => {
    // A bridge joins boxes 1 and 2 (box 2 merged into box 1); the cut picked box 2 before that.
    const bridge = sketch("s1", 8, 0, 22, 10);
    const r = build([...boxes(), bridge, extrude("add", "s1", "add", 2), slot(), extrude("cut", "s", "remove", 40, { mergeScope: ["b2"] })]);
    expect(r.featureErrors).toEqual({});
    const v = volumes(r);
    // Boxes + bridge = 2240; the slot (y 4…6) takes 200 from each box, 40 from the bridge between them and 2 × 4 from the
    // bridge's underside below them (z −1…0).
    near(v.b1, 2240 - 400 - 40 - 8);
    near(v.b3, 1000);
  });

  it("Thicken with a scope it doesn't touch makes new parts numbered on, with no name twice", () => {
    const first = build(boxes());
    const refs = first.parts[0].faceRefs;
    const face = (z: number) => ({ partId: "b1", ref: refs[refs.findIndex((f) => f.surface === "PLANE" && f.normal[2] * z > 0.99)] });
    const thicken: Feature = { id: "th", name: "th", type: "thicken", operation: "add", suppressed: false, params: { ...defaultParams("thicken"), thickness: "2" }, picks: [face(1), face(-1)], mergeScope: ["b3"] };
    const r = build([...boxes(), thicken, box("b4", 80)]);
    expect(r.featureErrors).toEqual({});
    const names = r.parts.map((p) => p.name);
    expect(names).toHaveLength(6);
    expect(new Set(names).size).toBe(6);
    near(volumes(r).b1, 1000);
  });
});
