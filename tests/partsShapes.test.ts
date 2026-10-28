/**
 * Onshape-style parts, round 2 (real OpenCascade engine): one extrude using
 * areas of several sketches, Intersect on every part it reaches, and a
 * threaded hole drilled into two parts at once (checked and remembered per part).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { analyzeMesh } from "../src/geometry/meshCheck";
import { GeometryEngine } from "../src/kernel/engine";
import { defaultParams } from "../src/model/features";
import type { Feature } from "../src/model/types";
import { pickOf, sketchAreas, type AreaPick } from "../src/sketch/areas";
import { addCircle, addPoint, addRectangle } from "../src/sketch/ops";
import type { SketchPlane } from "../src/sketch/planes";
import { emptySketch, type SketchData } from "../src/sketch/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine | undefined;
afterEach(() => engine?.dispose());
const build = (features: Feature[]) => {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features);
};

const TOP: SketchPlane = { kind: "default", name: "Top" };
const faceAt = (z: number): SketchPlane => ({ kind: "face", origin: [0, 0, z], u: [1, 0, 0], v: [0, 1, 0], label: `Face at z = ${z}` });
const sketch = (id: string, data: SketchData, plane: SketchPlane = TOP): Feature => ({ id, name: `Sketch ${id}`, type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane, data } });
const pickAt = (data: SketchData, x: number, y: number): AreaPick => {
  const map = sketchAreas(data);
  return pickOf(map.areas[map.areaAt([x, y])]);
};
const extrude = (id: string, sketchRef: string, operation: Feature["operation"], depth: number, extra: Partial<Feature> = {}): Feature => ({
  id,
  name: id,
  type: "extrude",
  operation,
  suppressed: false,
  params: { ...defaultParams("extrude"), depth: String(depth) },
  sketchRef,
  extrude: { end: "blind", flip: false },
  ...extra,
});
const size = (p: { vertices: Float32Array; triangles: Uint32Array }) => {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 2; i < p.vertices.length; i += 3) {
    lo = Math.min(lo, p.vertices[i]);
    hi = Math.max(hi, p.vertices[i]);
  }
  return { height: hi - lo, volume: analyzeMesh(p.vertices, p.triangles).volume };
};
const close = (actual: number, exact: number) => expect(Math.abs(actual / exact - 1)).toBeLessThan(0.005);

const small = addCircle(emptySketch(), { x: 0, y: 0 }, 5).sketch;
const big = addCircle(emptySketch(), { x: 40, y: 0 }, 15).sketch;

describe("one extrude using areas of two sketches", () => {
  it("extrudes the small circle of Sketch 1 and the big circle of Sketch 2 together: two parts", () => {
    const r = build([sketch("s1", small), sketch("s2", big), extrude("e1", "s1", "new", 20, { apart: true, areas: [pickAt(small, 0, 0)], moreAreas: [{ sketch: "s2", areas: [pickAt(big, 40, 0)] }] })]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((p) => p.name)).toEqual(["Part 1", "Part 2"]);
    const vols = r.parts.map((p) => size(p).volume).sort((a, b) => a - b);
    close(vols[0], Math.PI * 25 * 20);
    close(vols[1], Math.PI * 225 * 20);
    for (const p of r.parts) expect(size(p).height).toBeCloseTo(20, 6);
  });

  it("without the newer part rules both pieces are one part; an extra sketch below the extrude is explained", () => {
    const r = build([sketch("s1", small), sketch("s2", big), extrude("e1", "s1", "new", 20, { areas: [pickAt(small, 0, 0)], moreAreas: [{ sketch: "s2", areas: [pickAt(big, 40, 0)] }] })]);
    expect(r.parts).toHaveLength(1);
    close(size(r.parts[0]).volume, Math.PI * 25 * 20 + Math.PI * 225 * 20);
    const later = build([sketch("s1", small), extrude("e1", "s1", "new", 20, { areas: [pickAt(small, 0, 0)], moreAreas: [{ sketch: "s2", areas: [pickAt(big, 40, 0)] }] }), sketch("s2", big)]);
    expect(later.featureErrors.e1).toMatch(/^Sketch s2: .*comes after this extrude/);
  });
});

describe("Intersect on every part it reaches", () => {
  const both = addCircle(small, { x: 40, y: 0 }, 15).sketch;
  const twoParts = () => [sketch("s1", both), extrude("e1", "s1", "new", 60, { apart: true, areas: [pickAt(both, 0, 0)] }), extrude("e2", "s1", "add", 30, { apart: true, areas: [pickAt(both, 40, 0)] })];
  const slab = addRectangle(emptySketch(), { x: -20, y: -20 }, { x: 60, y: 20 }).sketch;

  it("keeps the bottom 5 mm of both cylinders", () => {
    const r = build([...twoParts(), sketch("s2", slab), extrude("i1", "s2", "intersect", 5, { apart: true, intersectAll: true })]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((p) => p.name)).toEqual(["Part 1", "Part 2"]);
    for (const p of r.parts) expect(size(p).height).toBeCloseTo(5, 6);
    close(size(r.parts[0]).volume, Math.PI * 25 * 5);
    close(size(r.parts[1]).volume, Math.PI * 225 * 5);
  });

  it("older intersects work on the latest part only; one reaching nothing says so", () => {
    const old = build([...twoParts(), sketch("s2", slab), extrude("i1", "s2", "intersect", 5, { apart: true })]);
    expect(old.featureErrors).toEqual({});
    expect(size(old.parts[0]).height).toBeCloseTo(60, 6);
    expect(size(old.parts[1]).height).toBeCloseTo(5, 6);
    const far = addRectangle(emptySketch(), { x: 200, y: 200 }, { x: 210, y: 210 }).sketch;
    const miss = build([...twoParts(), sketch("s2", far), extrude("i1", "s2", "intersect", 5, { apart: true, intersectAll: true })]);
    expect(miss.featureErrors.i1).toMatch(/doesn't overlap any part/);
  });
});

describe("a threaded hole drilled into two parts", () => {
  it("threads both, and builds the same again from what it remembered", () => {
    const blocks = [feature("box", { width: 20, depth: 20, height: 10 }), feature("box", { width: 20, depth: 20, height: 10, x: 30 })];
    const points = addPoint(addPoint(emptySketch(), { x: 10, y: 10 }).sketch, { x: 40, y: 10 }).sketch;
    const sk = sketch("hp", points, faceAt(10));
    const hole = (thread: boolean): Feature => ({
      ...feature("hole", { diameter: 2.5, depth: 8, threadDepth: 6 }, "remove"),
      id: "h1",
      apart: true,
      hole: { sketchRef: "hp", kind: "simple", standard: "M3", fit: "tapped", end: "blind", flip: false, ...(thread ? { modelThread: true } : {}) },
    });
    const plain = build([...blocks, sk, hole(false)]);
    expect(plain.featureErrors).toEqual({});
    const drilled = engine!.check("normal").parts.map((p) => p.exactVolume!);
    expect(drilled).toHaveLength(2);
    for (const v of drilled) expect(v).toBeLessThan(4000);
    const features = [...blocks, sk, hole(true)];
    const r = build(features);
    expect(r.featureErrors).toEqual({});
    const threaded = engine!.check("normal").parts.map((p) => p.exactVolume!);
    // Each part lost a thread's groove on top of the plain hole, and is still one sound solid.
    threaded.forEach((v, i) => expect(v).toBeLessThan(drilled[i] - 0.5));
    for (const p of engine!.check("normal").parts) expect(p.geometryValid).toBe(true);
    // Rebuilt (nothing changed): the remembered results, part by part.
    const again = engine!.rebuild(features);
    expect(again.featureErrors).toEqual({});
    engine!.check("normal").parts.forEach((p, i) => expect(p.exactVolume!).toBeCloseTo(threaded[i], 6));
  });
});
