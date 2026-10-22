/**
 * Sheet metal round 2 against the real OpenCascade engine: Bend along a
 * sketched line, Jog, and mitred corners — exact volumes, sizes and flat
 * patterns.
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { analyzeMesh } from "../src/geometry/meshCheck";
import type { EdgeRef } from "../src/geometry/topoRef";
import { GeometryEngine } from "../src/kernel/engine";
import { defaultParams } from "../src/model/features";
import type { Feature } from "../src/model/types";
import { foldSheet, type SheetSpec } from "../src/sheetmetal/sheet";
import { addCircle, addLine, addRectangle } from "../src/sketch/ops";
import type { SketchPlane } from "../src/sketch/planes";
import { emptySketch, type SketchData } from "../src/sketch/types";

beforeAll(async () => {
  setOC(await opencascade());
});

let engine: GeometryEngine;
afterEach(() => engine?.dispose());
function build(features: Feature[]) {
  engine = new GeometryEngine();
  return engine.rebuild(features);
}
const top: SketchPlane = { kind: "default", name: "Top" };
const sketchFeature = (id: string, data: SketchData, plane: SketchPlane = top): Feature => ({ id, name: id, type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane, data } });
const plateSketch = sketchFeature("plate", addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 100, y: 50 }).sketch);
const sheet: Feature = { id: "sm", name: "Sheet metal 1", type: "sheetMetal", operation: "new", suppressed: false, params: { thickness: "2", radius: "2", kFactor: "0.45", depth: "20" }, sketchRef: "plate" };
const lineSketch = (id: string, x: number) => sketchFeature(id, addLine(emptySketch(), { x, y: -10 }, { x, y: 60 }).sketch);
const bend = (id: string, sketchRef: string, params: Record<string, string> = {}, extra: Partial<Feature> = {}, type: "bend" | "jog" = "bend"): Feature => ({
  id,
  name: id,
  type,
  operation: "add",
  suppressed: false,
  params: { ...defaultParams(type), ...params },
  sketchRef,
  ...extra,
});
const vol = (i = 0) => engine.check("normal").parts[i].exactVolume!;
const valid = (i = 0) => engine.check("normal").parts[i].geometryValid;
const box = (r: ReturnType<typeof build>, i = 0) => {
  const v = r.parts[i].vertices;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < v.length; k += 3) for (let j = 0; j < 3; j++) {
    lo[j] = Math.min(lo[j], v[k + j]);
    hi[j] = Math.max(hi[j], v[k + j]);
  }
  return [...lo, ...hi];
};
const bounds2 = (pts: [number, number][]) => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
const near = (a: number[], b: number[], digits = 4) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], digits));
/** Bend allowance and a quarter bend's volume per mm (radius 2, thickness 2, K 0.45). */
const A90 = (Math.PI / 2) * (2 + 0.45 * 2);
const Q90 = (Math.PI / 4) * (16 - 4);

describe("bend along a line", () => {
  it("stands the smaller piece up along the line; the flat pattern is the plate as drawn", () => {
    const ln = lineSketch("ln", 60);
    const r = build([plateSketch, sheet, ln, bend("b", "ln")]);
    expect(r.featureErrors).toEqual({});
    // The plate less the bend's flat strip, plus the quarter bend, all 50 long.
    expect(vol()).toBeCloseTo((100 - A90) * 50 * 2 + Q90 * 50, 2);
    expect(valid()).toBe(true);
    // Its outside face at 60 − a/2 + R + T; it rises 40 − a/2 past the bend's top (z = 4).
    near(box(r), [0, 0, 0, 60 - A90 / 2 + 4, 50, 4 + 40 - A90 / 2]);
    const flat = r.parts[0].flat!;
    near(bounds2(flat.outline), [0, 0, 100, 50], 6);
    near([...flat.bendLines[0][0], ...flat.bendLines[0][1]], [60, 0, 60, 50], 6);
    // Laid flat: the plate's volume again.
    const laid = engine.unfold("sm")!;
    expect(analyzeMesh(laid.vertices, laid.triangles).volume).toBeCloseTo(100 * 50 * 2, 1);
  });

  it("bends down, at another angle and radius, or keeps the other side still", () => {
    let r = build([plateSketch, sheet, lineSketch("ln", 60), bend("b", "ln", { angle: "45", radius: "5" }, { flipSide: true })]);
    expect(r.featureErrors).toEqual({});
    const a45 = (Math.PI / 4) * (5 + 0.45 * 2);
    expect(vol()).toBeCloseTo((100 - a45) * 100 + (Math.PI / 8) * (49 - 25) * 50, 2);
    // Down: below the plate, never above it.
    const b = box(r);
    expect(b[5]).toBeCloseTo(2, 6);
    expect(b[2]).toBeLessThan(-20);
    // The bigger side moves instead: it stands up off x = 60 + a/2 (the left piece, 60 − a/2 long, stays).
    r = build([plateSketch, sheet, lineSketch("ln", 60), bend("b", "ln", {}, { keepOtherSide: true })]);
    expect(r.featureErrors).toEqual({});
    expect(vol()).toBeCloseTo((100 - A90) * 100 + Q90 * 50, 2);
    near(box(r), [60 + A90 / 2 - 4, 0, 0, 100, 50, 4 + 60 - A90 / 2]);
  });

  it("carries a hole cut earlier round with the bent piece; the flat pattern still shows it where it was", () => {
    const holeSketch = sketchFeature("hs", addCircle(emptySketch(), { x: 80, y: 25 }, 5).sketch);
    const cut: Feature = { id: "cut", name: "cut", type: "extrude", operation: "remove", suppressed: false, params: { depth: "10" }, sketchRef: "hs", extrude: { end: "throughAll", flip: false } };
    const r = build([plateSketch, sheet, holeSketch, cut, lineSketch("ln", 60), bend("b", "ln")]);
    expect(r.featureErrors).toEqual({});
    expect(vol()).toBeCloseTo((100 - A90) * 100 + Q90 * 50 - Math.PI * 25 * 2, 1);
    const flat = r.parts[0].flat!;
    expect(flat.notShown).toEqual([]);
    near(bounds2(flat.cuts!.flat()), [75, 20, 85, 30], 2);
    const laid = engine.unfold("sm")!;
    expect(analyzeMesh(laid.vertices, laid.triangles).volume).toBeCloseTo(10000 - Math.PI * 25 * 2, 0);
    // A hole the bend would run through can't be bent.
    const across = build([plateSketch, sheet, holeSketch, cut, lineSketch("ln", 82), bend("b", "ln")]);
    expect(across.featureErrors.b).toMatch(/cut through the sheet crosses the bend/);
  });

  it("then takes flanges on the bent piece", () => {
    const r = build([plateSketch, sheet, lineSketch("ln", 60), bend("b", "ln")]);
    // The standing piece's top edge (its tip, at x = 60 − a/2 + 2..4, z = 41.7): on its outside face.
    const tipZ = 4 + 40 - A90 / 2;
    const tip = r.parts[0].edgeRefs.find((e): e is EdgeRef => e.kind === "edge" && e.curve === "LINE" && Math.abs(e.a[2] - tipZ) < 1e-3 && Math.abs(e.b[2] - tipZ) < 1e-3 && Math.abs(e.a[0] - (60 - A90 / 2 + 4)) < 1e-3)!;
    expect(tip).toBeDefined();
    const fl: Feature = { id: "fl", name: "fl", type: "flange", operation: "add", suppressed: false, params: { length: "10", angle: "90", inset: "0" }, picks: [{ partId: "sm", ref: tip }] };
    const r2 = build([plateSketch, sheet, lineSketch("ln", 60), bend("b", "ln"), fl]);
    expect(r2.featureErrors).toEqual({});
    expect(vol()).toBeCloseTo((100 - A90) * 100 + Q90 * 50 * 2 + (10 - 4) * 2 * 50, 2);
    near(bounds2(r2.parts[0].flat!.outline), [0, 0, 100 + A90 + 6, 50], 6);
  });

  it("explains what it can't do", () => {
    const two = sketchFeature("two", addLine(addLine(emptySketch(), { x: 30, y: -10 }, { x: 30, y: 60 }).sketch, { x: 70, y: -10 }, { x: 70, y: 60 }).sketch);
    expect(build([plateSketch, sheet, two, bend("b", "two")]).featureErrors.b).toMatch(/just one line/);
    const slanted = sketchFeature("sl", addLine(emptySketch(), { x: 40, y: -10 }, { x: 60, y: 60 }).sketch);
    expect(build([plateSketch, sheet, slanted, bend("b", "sl")]).featureErrors.b).toMatch(/at right angles/);
    const front = sketchFeature("fr", addLine(emptySketch(), { x: 40, y: -10 }, { x: 40, y: 60 }).sketch, { kind: "default", name: "Front" });
    expect(build([plateSketch, sheet, front, bend("b", "fr")]).featureErrors.b).toMatch(/on a flat face of a sheet metal part/);
  });
});

describe("jog", () => {
  it("steps the sheet up by the height, the far side parallel; the flat pattern keeps the plate's size", () => {
    const r = build([plateSketch, sheet, lineSketch("ln", 60), bend("j", "ln", { height: "10" }, {}, "jog")]);
    expect(r.featureErrors).toEqual({});
    expect(vol()).toBeCloseTo((100 - 2 * A90) * 100 + 2 * Q90 * 50, 2);
    expect(valid()).toBe(true);
    // The stepped piece's underside is 10 up; its far end lands at 100 − 2a + (R + T) + R − (R + T).
    near(box(r), [0, 0, 0, 102 - 2 * A90, 50, 12]);
    const flat = r.parts[0].flat!;
    near(bounds2(flat.outline), [0, 0, 100, 50], 6);
    expect(flat.bendLines).toHaveLength(2);
    // Down, and at 60°: the same flat size, 10 below.
    const r2 = build([plateSketch, sheet, lineSketch("ln", 60), bend("j", "ln", { height: "10", angle: "60" }, { flipSide: true }, "jog")]);
    expect(r2.featureErrors).toEqual({});
    const b = box(r2);
    expect(b[2]).toBeCloseTo(-10, 4);
    expect(b[5]).toBeCloseTo(2, 6);
    near(bounds2(r2.parts[0].flat!.outline), [0, 0, 100, 50], 6);
    const laid = engine.unfold("sm")!;
    expect(analyzeMesh(laid.vertices, laid.triangles).volume).toBeCloseTo(10000, 1);
  });

  it("says when the step is too small for its bends", () => {
    expect(build([plateSketch, sheet, lineSketch("ln", 60), bend("j", "ln", { height: "5" }, {}, "jog")]).featureErrors.j).toMatch(/Too small a step.*more than 6\.01 mm/);
  });
});

describe("mitred corners", () => {
  const topEdges = (r: ReturnType<typeof build>) =>
    r.parts[0].edgeRefs.filter((e): e is EdgeRef => e.kind === "edge" && e.curve === "LINE" && Math.abs(e.a[2] - 2) < 1e-6 && Math.abs(e.b[2] - 2) < 1e-6);
  const hem = (id: string, refs: EdgeRef[], mitre: boolean, gap = "0.2"): Feature => ({
    id,
    name: id,
    type: "hem",
    operation: "add",
    suppressed: false,
    params: { length: "8", gap: "0", inset: "0", cornerGap: gap },
    picks: refs.map((ref) => ({ partId: "sm", ref })),
    ...(mitre ? { mitreCorners: true } : {}),
  });

  it("hems on all four edges: unchanged unless asked; mitred, each corner loses a 0.2 mm strip along its diagonal", () => {
    const edges = topEdges(build([plateSketch, sheet]));
    expect(edges).toHaveLength(4);
    expect(build([plateSketch, sheet, hem("h", edges, false)]).featureErrors).toEqual({});
    expect(vol()).toBeCloseTo(16267.2, 1);
    expect(build([plateSketch, sheet, hem("h", edges, true)]).featureErrors).toEqual({});
    // Each corner: a band 0.2 wide along the 8√2 diagonal, 2 thick.
    expect(vol()).toBeCloseTo(16267.2 - 4 * 8 * Math.SQRT2 * 0.2 * 2, 2);
    expect(valid()).toBe(true);
    // A wider gap: a wider strip.
    expect(build([plateSketch, sheet, hem("h", edges, true, "0.5")]).featureErrors).toEqual({});
    expect(vol()).toBeCloseTo(16267.2 - 4 * 8 * Math.SQRT2 * 0.5 * 2, 2);
    // They can't be cut to meet exactly.
    expect(build([plateSketch, sheet, hem("h", edges, true, "0")]).featureErrors.h).toMatch(/Gap at mitred corners/);
    expect(build([plateSketch, sheet, hem("h", edges, true, "0.001")]).featureErrors.h).toMatch(/at least 0.01 mm/);
  });

  it("trims a hem made earlier when the next one asks", () => {
    const edges = topEdges(build([plateSketch, sheet]));
    const right = edges.find((e) => Math.abs(e.a[0] - 100) < 1e-6 && Math.abs(e.b[0] - 100) < 1e-6)!;
    const bottom = edges.find((e) => Math.abs(e.a[1]) < 1e-6 && Math.abs(e.b[1]) < 1e-6)!;
    const expected = 13261.6 - 8 * Math.SQRT2 * 0.2 * 2;
    expect(build([plateSketch, sheet, hem("h", [right, bottom], true)]).featureErrors).toEqual({});
    expect(vol()).toBeCloseTo(expected, 2);
    const one = build([plateSketch, sheet, hem("h1", [right], false)]);
    const second = one.parts[0].edgeRefs.find((e): e is EdgeRef => e.kind === "edge" && e.curve === "LINE" && Math.abs(e.a[1]) < 1e-6 && Math.abs(e.b[1]) < 1e-6 && Math.abs(e.a[2] - 2) < 1e-6 && Math.abs(e.b[2] - 2) < 1e-6)!;
    expect(build([plateSketch, sheet, hem("h1", [right], false), hem("h2", [second], true)]).featureErrors).toEqual({});
    expect(vol()).toBeCloseTo(expected, 2);
    expect(valid()).toBe(true);
  });

  it("flanges leaning in at 120° on all four edges: trimmed so they don't run into each other", () => {
    const edges = topEdges(build([plateSketch, sheet]));
    const fl: Feature = { id: "fl", name: "fl", type: "flange", operation: "add", suppressed: false, params: { length: "20", angle: "120", inset: "0", cornerGap: "0.2" }, picks: edges.map((ref) => ({ partId: "sm", ref })), mitreCorners: true };
    const r = build([plateSketch, sheet, fl]);
    expect(r.featureErrors).toEqual({});
    expect(valid()).toBe(true);
    // The plate, four 120° bends (radii 2 and 4), and the trimmed walls (from the sheet model), none overlapping.
    const spec = { thickness: 2, radius: 2, k: 0.45, base: { frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] }, outer: [
      { kind: "line", from: [0, 0], to: [100, 0] },
      { kind: "line", from: [100, 0], to: [100, 50] },
      { kind: "line", from: [100, 50], to: [0, 50] },
      { kind: "line", from: [0, 50], to: [0, 0] },
    ], holes: [] }, flanges: [0, 1, 2, 3].map((edge) => ({ id: `f${edge}`, wall: "base", edge, length: 20, angle: 120, down: false, mitre: 0.2 })) } as SheetSpec;
    const folded = foldSheet(spec);
    const wallArea = folded.walls.slice(1).reduce((s, w) => {
      const pts = w.outline.map((g) => (g as { from: [number, number] }).from);
      return s + pts.reduce((a, p, i) => a + p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1], 0) / 2;
    }, 0);
    expect(wallArea).toBeLessThan(300 * folded.bends[0].straight - 10);
    expect(vol()).toBeCloseTo(10000 + 300 * ((2 * Math.PI) / 6) * 12 + wallArea * 2, 1);
  });
});
