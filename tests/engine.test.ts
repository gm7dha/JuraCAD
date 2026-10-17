/**
 * Runs the real OpenCascade engine (in Node) against reference models and
 * checks volumes, positions and soundness. This is how we catch the
 * geometry going wrong when code changes.
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { emptyDocument, parseDocument } from "../src/model/document";

import { analyzeMesh } from "../src/geometry/meshCheck";
import type { TopoPick } from "../src/geometry/topoRef";
import { readBinaryStl } from "../src/geometry/stl";
import { GeometryEngine } from "../src/kernel/engine";
import { defaultParams } from "../src/model/features";
import type { Feature, FeatureType, Operation } from "../src/model/types";
import { defaultAxis } from "../src/sketch/axis";
import { addArc, addCircle, addLine, addPoint, addRectangle } from "../src/sketch/ops";
import { holeVolume, type HoleSize } from "../src/model/holes";
import type { FastenerKind } from "../src/model/fasteners";
import { addEllipse, addSpline } from "../src/sketch/tools";
import { matchingConnectors } from "../src/assembly/connectors";
import { planeOnFace, type SketchPlane } from "../src/sketch/planes";
import { emptySketch, type SketchData } from "../src/sketch/types";

beforeAll(async () => {
  const OC = await opencascade();
  setOC(OC);
});

let n = 0;
function feature(type: FeatureType, params: Record<string, string | number>, operation: Operation = "new"): Feature {
  n++;
  return {
    id: `f${n}`,
    name: `${type} ${n}`,
    type,
    operation,
    suppressed: false,
    params: { ...defaultParams(type), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) },
  };
}

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine = new GeometryEngine();
  return engine.rebuild(features);
}

const relativeError = (actual: number, expected: number) => Math.abs(actual - expected) / expected;

describe("geometry engine", () => {
  it("builds a box with the right size, position and topology", () => {
    const r = build([feature("box", { width: 40, depth: 30, height: 20, x: 5, y: -5, z: 2 })]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    const p = r.parts[0];
    expect(p.name).toBe("Part 1");
    expect(p.faceGroups).toHaveLength(6);
    expect(p.edgeGroups).toHaveLength(12);
    const a = analyzeMesh(p.vertices, p.triangles);
    expect(a.watertight).toBe(true);
    expect(a.volume).toBeCloseTo(24000, 1);
    expect(a.bounds?.min.map((v) => Math.round(v * 1000) / 1000)).toEqual([5, -5, 2]);
    expect(a.bounds?.max.map((v) => Math.round(v * 1000) / 1000)).toEqual([45, 25, 22]);
  });

  it("builds a cylinder standing on its base centre", () => {
    const r = build([feature("cylinder", { diameter: 20, height: 30, x: 5, y: 5, z: 2 })]);
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(a.watertight).toBe(true);
    expect(relativeError(a.volume, Math.PI * 100 * 30)).toBeLessThan(0.01);
    expect(a.bounds?.min[2]).toBeCloseTo(2, 3);
    expect(a.bounds?.max[2]).toBeCloseTo(32, 3);
    expect(a.bounds?.min[0]).toBeCloseTo(-5, 1);
    expect(a.bounds?.max[0]).toBeCloseTo(15, 1);
  });

  it("builds a sphere around its centre", () => {
    const r = build([feature("sphere", { diameter: 20, x: 0, y: 0, z: 10 })]);
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(a.watertight).toBe(true);
    expect(relativeError(a.volume, (4 / 3) * Math.PI * 1000)).toBeLessThan(0.02);
    expect(a.bounds?.min[2]).toBeCloseTo(0, 1);
    expect(a.bounds?.max[2]).toBeCloseTo(20, 1);
  });

  it("removes a hole from a block (reference model: drilled block)", () => {
    const r = build([
      feature("box", { width: 40, depth: 30, height: 20 }),
      feature("cylinder", { diameter: 10, height: 20, x: 20, y: 15, z: 0 }, "remove"),
    ]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0].featureIds).toHaveLength(2);
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(a.watertight).toBe(true);
    expect(relativeError(a.volume, 24000 - Math.PI * 25 * 20)).toBeLessThan(0.01);

    const check = engine.check("normal");
    expect(check.parts[0].geometryValid).toBe(true);
    expect(relativeError(check.parts[0].exactVolume ?? 0, 24000 - Math.PI * 25 * 20)).toBeLessThan(1e-4);
    expect(check.parts[0].mesh.watertight).toBe(true);
  });

  it("adds to the latest part, and keeps New parts separate", () => {
    const r = build([
      feature("box", { width: 10, depth: 10, height: 10 }),
      feature("box", { width: 10, depth: 10, height: 10, x: 5 }, "add"),
      feature("sphere", { diameter: 10, x: 100 }),
    ]);
    expect(r.parts.map((p) => p.name)).toEqual(["Part 1", "Part 2"]);
    const merged = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(merged.watertight).toBe(true);
    expect(merged.volume).toBeCloseTo(1500, 1);
    expect(merged.pieces).toBe(1);
  });

  it("reports separate pieces when an added solid doesn't touch", () => {
    build([
      feature("box", { width: 10, depth: 10, height: 10 }),
      feature("box", { width: 10, depth: 10, height: 10, x: 50 }, "add"),
    ]);
    const check = engine.check("normal");
    expect(check.parts).toHaveLength(1);
    expect(check.parts[0].mesh.pieces).toBe(2);
  });

  it("explains bad inputs instead of crashing", () => {
    const r = build([
      feature("box", { width: -5 }),
      feature("cylinder", {}, "add"),
      feature("sphere", { diameter: "abc" }),
    ]);
    expect(r.parts).toHaveLength(0);
    expect(Object.keys(r.featureErrors)).toHaveLength(3);
    expect(r.featureErrors[`f${n - 2}`]).toMatch(/Width/);
    expect(r.featureErrors[`f${n - 1}`]).toMatch(/no part to add to/);
  });

  it("refuses to remove the whole part, keeping the part as it was", () => {
    const r = build([
      feature("box", { width: 10, depth: 10, height: 10 }),
      feature("box", { width: 100, depth: 100, height: 100, x: -50, y: -50, z: -50 }, "remove"),
    ]);
    expect(Object.keys(r.featureErrors)).toHaveLength(1);
    expect(r.parts).toHaveLength(1);
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(a.volume).toBeCloseTo(1000, 1);
  });

  it("skips suppressed features", () => {
    const hole = feature("cylinder", { diameter: 10, height: 20 }, "remove");
    hole.suppressed = true;
    const r = build([feature("box", { width: 40, depth: 30, height: 20 }), hole]);
    expect(analyzeMesh(r.parts[0].vertices, r.parts[0].triangles).volume).toBeCloseTo(24000, 1);
  });

  it("exports a watertight binary STL, finer at higher quality", () => {
    build([
      feature("box", { width: 40, depth: 30, height: 20 }),
      feature("cylinder", { diameter: 10, height: 20, x: 20, y: 15 }, "remove"),
      feature("sphere", { diameter: 15, x: 80 }),
    ]);
    const coarse = engine.exportStl([], "coarse");
    const fine = engine.exportStl([], "fine");
    expect(fine.triangleCount).toBeGreaterThan(coarse.triangleCount);

    const stl = readBinaryStl(fine.stl);
    expect(stl.triangleCount).toBe(fine.triangleCount);
    const a = analyzeMesh(stl.vertices, Array.from({ length: stl.triangleCount * 3 }, (_, i) => i));
    expect(a.watertight).toBe(true);
    expect(a.pieces).toBe(2);
    expect(a.degenerateTriangles).toBe(0);

    const firstOnly = engine.exportStl([`f${n - 2}`], "normal");
    const one = readBinaryStl(firstOnly.stl);
    const b = analyzeMesh(one.vertices, Array.from({ length: one.triangleCount * 3 }, (_, i) => i));
    expect(b.pieces).toBe(1);
  });

  it("refuses to export an empty model", () => {
    build([]);
    expect(() => engine.exportStl([], "normal")).toThrow(/nothing to export/);
  });
});

// ---------------------------------------------------------------------------
// Sketch + Extrude


function sketchFeature(plane: SketchPlane | null, data: SketchData): Feature {
  n++;
  return { id: `f${n}`, name: `Sketch ${n}`, type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane, data } };
}

function extrudeFeature(sketchRef: string, depth: number, opts: Partial<Pick<Feature, "operation">> & { end?: "blind" | "symmetric"; flip?: boolean } = {}): Feature {
  n++;
  return {
    id: `f${n}`,
    name: `Extrude ${n}`,
    type: "extrude",
    operation: opts.operation ?? "new",
    suppressed: false,
    params: { depth: String(depth) },
    sketchRef,
    extrude: { end: opts.end ?? "blind", flip: opts.flip ?? false },
  };
}

const rectSketch = (x0: number, y0: number, w: number, h: number) => addRectangle(emptySketch(), { x: x0, y: y0 }, { x: x0 + w, y: y0 + h }).sketch;
const lineSketch = (x0: number, y0: number, x1: number, y1: number) => addLine(emptySketch(), { x: x0, y: y0 }, { x: x1, y: y1 }).sketch;
const meshOf = (r: { parts: { vertices: Float32Array; triangles: Uint32Array }[] }, i = 0) => analyzeMesh(r.parts[i].vertices, r.parts[i].triangles);

describe("sketch and extrude", () => {
  it("extrudes a rectangle on the Top plane upwards", () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, rectSketch(0, 0, 40, 30));
    const r = build([sk, extrudeFeature(sk.id, 10)]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    const a = meshOf(r);
    expect(a.watertight).toBe(true);
    expect(a.volume).toBeCloseTo(12000, 1);
    expect(a.bounds?.min[2]).toBeCloseTo(0, 4);
    expect(a.bounds?.max[2]).toBeCloseTo(10, 4);
  });

  it("extrudes towards the viewer on Front and Right, and can flip or go both ways", () => {
    const front = sketchFeature({ kind: "default", name: "Front" }, rectSketch(0, 0, 20, 10));
    const f = build([front, extrudeFeature(front.id, 5)]);
    expect(meshOf(f).bounds?.min[1]).toBeCloseTo(-5, 4); // Front extrudes along −Y
    expect(meshOf(f).bounds?.max[2]).toBeCloseTo(10, 4); // sketch "up" is Z

    const right = sketchFeature({ kind: "default", name: "Right" }, rectSketch(0, 0, 20, 10));
    const flipped = build([right, extrudeFeature(right.id, 5, { flip: true })]);
    expect(meshOf(flipped).bounds?.min[0]).toBeCloseTo(-5, 4);
    expect(meshOf(flipped).bounds?.max[1]).toBeCloseTo(20, 4); // sketch "right" is Y

    const top = sketchFeature({ kind: "default", name: "Top" }, rectSketch(0, 0, 10, 10));
    const sym = build([top, extrudeFeature(top.id, 8, { end: "symmetric" })]);
    expect(meshOf(sym).bounds?.min[2]).toBeCloseTo(-4, 4);
    expect(meshOf(sym).bounds?.max[2]).toBeCloseTo(4, 4);
  });

  it("cuts holes from circles inside the outline", () => {
    const base = rectSketch(0, 0, 40, 30);
    const withHole = addCircle(base, { x: 20, y: 15 }, 5).sketch;
    const sk = sketchFeature({ kind: "default", name: "Top" }, withHole);
    const r = build([sk, extrudeFeature(sk.id, 10)]);
    const a = meshOf(r);
    expect(a.watertight).toBe(true);
    expect(relativeError(a.volume, (1200 - Math.PI * 25) * 10)).toBeLessThan(0.01);
    const check = engine.check("normal");
    expect(check.parts[0].geometryValid).toBe(true);
  });

  it("extrudes a slot made of lines and arcs", () => {
    let s = emptySketch();
    const bottom = addLine(s, { x: 0, y: -5 }, { x: 30, y: -5 });
    s = bottom.sketch;
    const right = addArc(s, { x: 30, y: -5, snap: { kind: "point", id: bottom.endId } }, { x: 30, y: 5 }, { x: 35, y: 0 });
    s = right.sketch;
    const rightEnd = s.points.find((p) => Math.abs(p.x - 30) < 1e-6 && Math.abs(p.y - 5) < 1e-6)!.id;
    const top = addLine(s, { x: 30, y: 5, snap: { kind: "point", id: rightEnd } }, { x: 0, y: 5 });
    s = top.sketch;
    const startId = s.points.find((p) => Math.abs(p.x) < 1e-6 && Math.abs(p.y + 5) < 1e-6)!.id;
    s = addArc(s, { x: 0, y: 5, snap: { kind: "point", id: top.endId } }, { x: 0, y: -5, snap: { kind: "point", id: startId } }, { x: -5, y: 0 }).sketch;
    const sk = sketchFeature({ kind: "default", name: "Top" }, s);
    const r = build([sk, extrudeFeature(sk.id, 4)]);
    expect(r.featureErrors).toEqual({});
    const a = meshOf(r);
    expect(a.watertight).toBe(true);
    expect(relativeError(a.volume, (300 + Math.PI * 25) * 4)).toBeLessThan(0.01);
  });

  it("removes material from the latest part, like drilling", () => {
    const hole = sketchFeature({ kind: "default", name: "Top" }, addCircle(emptySketch(), { x: 20, y: 15 }, 4).sketch);
    const r = build([
      feature("box", { width: 40, depth: 30, height: 20 }),
      hole,
      extrudeFeature(hole.id, 20, { operation: "remove" }),
    ]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    expect(relativeError(meshOf(r).volume, 24000 - Math.PI * 16 * 20)).toBeLessThan(0.01);
  });

  it("sketches on a flat face and extrudes from it", () => {
    const plane = planeOnFace([0, 0, 1], [10, 10, 20], "Top face of Part 1");
    const sk = sketchFeature(plane, rectSketch(0, 0, 10, 10));
    const r = build([feature("box", { width: 40, depth: 30, height: 20 }), sk, extrudeFeature(sk.id, 5, { operation: "add" })]);
    expect(r.featureErrors).toEqual({});
    const a = meshOf(r);
    expect(a.bounds?.max[2]).toBeCloseTo(25, 4);
    expect(a.volume).toBeCloseTo(24000 + 500, 0);
  });

  it("explains problems instead of crashing", () => {
    const openShape = sketchFeature({ kind: "default", name: "Top" }, addLine(emptySketch(), { x: 0, y: 0 }, { x: 10, y: 0 }).sketch);
    const noPlane = sketchFeature(null, rectSketch(0, 0, 5, 5));
    const later = sketchFeature({ kind: "default", name: "Top" }, rectSketch(0, 0, 5, 5));
    const r = build([
      openShape,
      extrudeFeature(openShape.id, 5),
      noPlane,
      extrudeFeature(noPlane.id, 5),
      extrudeFeature(later.id, 5),
      later,
      extrudeFeature("missing", 5),
    ]);
    expect(r.parts).toHaveLength(0);
    const messages = Object.values(r.featureErrors).join(" | ");
    expect(messages).toMatch(/no closed shapes/);
    expect(messages).toMatch(/Pick a plane/);
    expect(messages).toMatch(/comes after this extrude/);
    expect(messages).toMatch(/deleted/);
  });
});

describe("fillet and chamfer", () => {
  /** A pick for the edge (or face) of the first part whose middle is nearest `at`. */
  function pickAt(r: ReturnType<typeof build>, kind: "edge" | "face", at: [number, number, number]): TopoPick {
    const part = r.parts[0];
    const refs = kind === "edge" ? part.edgeRefs : part.faceRefs;
    const pos = (x: (typeof refs)[number]) => (x.kind === "edge" ? x.mid : x.center);
    const best = [...refs].sort((p, q) => Math.hypot(...pos(p).map((v, i) => v - at[i])) - Math.hypot(...pos(q).map((v, i) => v - at[i])))[0];
    return { partId: part.id, ref: best };
  }
  const edgeFeature = (type: "fillet" | "chamfer", size: number, picks: TopoPick[]): Feature => ({
    ...feature(type, type === "fillet" ? { radius: size } : { distance: size }, "add"),
    picks,
  });
  const exactVolume = () => engine.check("normal").parts[0].exactVolume!;

  it("describes every edge and face of a part", () => {
    const r = build([feature("box", { width: 10, depth: 10, height: 10 })]);
    const p = r.parts[0];
    expect(p.edgeRefs).toHaveLength(12);
    expect(p.faceRefs).toHaveLength(6);
    expect(p.edgeRefs.every((e) => e.curve === "LINE")).toBe(true);
    const top = p.faceRefs.find((f) => f.center[2] > 9.99)!;
    expect(top.surface).toBe("PLANE");
    expect(top.normal).toEqual([0, 0, 1]);
  });

  it("rounds one edge of a cube by exactly the right amount", () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const pick = pickAt(build([box]), "edge", [5, 0, 10]);
    const r = build([box, edgeFeature("fillet", 2, [pick])]);
    expect(r.featureErrors).toEqual({});
    // A 2 mm fillet along a 10 mm edge removes (4 - π) × 10 mm³.
    expect(exactVolume()).toBeCloseTo(1000 - (4 - Math.PI) * 10, 3);
    const check = engine.check("normal").parts[0];
    expect(check.geometryValid).toBe(true);
    expect(check.mesh.watertight).toBe(true);
  });

  it("can grow the radius along the edge (variable fillet)", () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const pick = pickAt(build([box]), "edge", [5, 0, 10]);
    const r = build([box, { ...feature("fillet", { radius: 1, endRadius: 3 }, "add"), picks: [pick] }]);
    expect(r.featureErrors).toEqual({});
    const check = engine.check("normal").parts[0];
    expect(check.geometryValid).toBe(true);
    // More is taken away than a 1 mm fillet, less than a 3 mm one.
    const v = exactVolume();
    expect(v).toBeLessThan(1000 - (1 - Math.PI / 4) * 10);
    expect(v).toBeGreaterThan(1000 - (9 - (9 * Math.PI) / 4) * 10);
  });

  it("bevels one edge with a chamfer", () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const pick = pickAt(build([box]), "edge", [5, 0, 10]);
    build([box, edgeFeature("chamfer", 2, [pick])]);
    expect(exactVolume()).toBeCloseTo(1000 - 2 * 10, 3);
  });

  it("rounds all edges of a picked face", () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const pick = pickAt(build([box]), "face", [5, 5, 10]);
    const r = build([box, edgeFeature("fillet", 1, [pick])]);
    expect(r.featureErrors).toEqual({});
    const v = exactVolume();
    // Four rounded 10 mm edges remove a little under 4 × (1 - π/4) × 10.
    expect(v).toBeLessThan(1000 - 4 * (1 - Math.PI / 4) * 8);
    expect(v).toBeGreaterThan(1000 - 4 * (1 - Math.PI / 4) * 10);
    expect(r.parts[0].faceRefs.length).toBeGreaterThan(6);
  });

  it("still finds the edge after the box is resized", () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const picks = [pickAt(build([box]), "edge", [5, 0, 10]), pickAt(build([box]), "edge", [10, 0, 5])];
    const bigger = { ...box, params: { ...box.params, width: "20", height: "15" } };
    const r = build([bigger, edgeFeature("chamfer", 1, picks)]);
    expect(r.featureErrors).toEqual({});
    // Two 1 mm chamfers (0.5 mm² cross-section) along edges of 20 and 15 mm, sharing a corner.
    const v = exactVolume();
    expect(v).toBeLessThan(20 * 10 * 15 - 0.5 * 30);
    expect(v).toBeGreaterThan(20 * 10 * 15 - 0.5 * 35);
  });

  it("follows the hole when a drilled block's hole is filleted", () => {
    const block = feature("box", { width: 30, depth: 30, height: 10 });
    const hole = feature("cylinder", { diameter: 10, height: 10, x: 15, y: 15 }, "remove");
    const first = build([block, hole]);
    const rim = first.parts[0].edgeRefs.find((e) => e.curve === "CIRCLE" && e.mid[2] > 9.99)!;
    expect(rim).toBeTruthy();
    const r = build([block, hole, edgeFeature("fillet", 1, [{ partId: block.id, ref: rim }])]);
    expect(r.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].geometryValid).toBe(true);
  });

  it("explains problems in plain words", () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const pick = pickAt(build([box]), "edge", [5, 0, 10]);

    let r = build([box, edgeFeature("fillet", 2, [])]);
    expect(Object.values(r.featureErrors)[0]).toMatch(/Click the edges/);

    // Too big to fit: the part stays as it was.
    const tooBig = edgeFeature("fillet", 20, [pick]);
    r = build([box, tooBig]);
    expect(r.featureErrors[tooBig.id]).toMatch(/radius|round/i);
    expect(exactVolume()).toBeCloseTo(1000, 3);

    // The edge has gone (its part was rebuilt without it).
    const lost = edgeFeature("fillet", 1, [{ partId: box.id, ref: { ...pick.ref, a: [0, 0, 90], b: [10, 0, 90], mid: [5, 0, 90], rel: [0.5, 0, 9] } as TopoPick["ref"] }]);
    r = build([box, lost]);
    expect(r.featureErrors[lost.id]).toMatch(/can't be found/);

    const orphan = edgeFeature("fillet", 1, [{ ...pick, partId: "gone" }]);
    r = build([box, orphan]);
    expect(r.featureErrors[orphan.id]).toMatch(/no longer exists/);
  });
});

describe("revolve", () => {
  function revolveFeature(sketchRef: string, angle: number, axis = "vertical", opts: { operation?: Operation; flip?: boolean } = {}): Feature {
    n++;
    return {
      id: `f${n}`,
      name: `Revolve ${n}`,
      type: "revolve",
      operation: opts.operation ?? "new",
      suppressed: false,
      params: { angle: String(angle) },
      sketchRef,
      revolve: { axis, flip: opts.flip ?? false },
    };
  }

  it("spins a rectangle into a ring around the sketch's up-down axis", () => {
    // On Front, sketch "up" is Z, so this makes a ring around the Z axis.
    const sk = sketchFeature({ kind: "default", name: "Front" }, rectSketch(10, 0, 10, 10));
    const r = build([sk, revolveFeature(sk.id, 360)]);
    expect(r.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].exactVolume).toBeCloseTo(Math.PI * (20 * 20 - 10 * 10) * 10, 1);
    const a = meshOf(r);
    expect(a.watertight).toBe(true);
    expect(a.bounds?.min[0]).toBeCloseTo(-20, 1);
    expect(a.bounds?.max[1]).toBeCloseTo(20, 1);
    expect(a.bounds?.max[2]).toBeCloseTo(10, 3);
  });

  it("goes part of the way round", () => {
    const sk = sketchFeature({ kind: "default", name: "Front" }, rectSketch(10, 0, 10, 10));
    build([sk, revolveFeature(sk.id, 90)]);
    expect(engine.check("normal").parts[0].exactVolume).toBeCloseTo((Math.PI * 300 * 10) / 4, 1);
  });

  it("uses a construction line as the axis by default", () => {
    // A square sitting on a construction line along the sketch's X axis: spins into a 10 mm × r10 cylinder.
    let data = rectSketch(0, 0, 10, 10);
    const axis = addLine(data, { x: -5, y: 0 }, { x: 15, y: 0 }, { construction: true });
    data = axis.sketch;
    expect(defaultAxis(data)).toBe(axis.lineId);
    const sk = sketchFeature({ kind: "default", name: "Top" }, data);
    const r = build([sk, revolveFeature(sk.id, 360, axis.lineId)]);
    expect(r.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].exactVolume).toBeCloseTo(Math.PI * 100 * 10, 1);
  });

  it("can cut a groove from an existing part", () => {
    const cyl = feature("cylinder", { diameter: 40, height: 20 });
    // A 2 × 2 mm square at the cylinder's edge, half way up: spun round it cuts a groove.
    const sk = sketchFeature({ kind: "default", name: "Front" }, rectSketch(18, 9, 2, 2));
    const r = build([cyl, sk, revolveFeature(sk.id, 360, "vertical", { operation: "remove" })]);
    expect(r.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].exactVolume).toBeCloseTo(Math.PI * 400 * 20 - Math.PI * (400 - 18 * 18) * 2, 0);
  });

  it("refuses shapes that cross the axis", () => {
    const sk = sketchFeature({ kind: "default", name: "Front" }, rectSketch(-5, 0, 10, 10));
    const rev = revolveFeature(sk.id, 360);
    const r = build([sk, rev]);
    expect(r.featureErrors[rev.id]).toMatch(/crosses the line/);
    const missing = revolveFeature(sk.id, 360, "no-such-line");
    expect(build([sk, missing]).featureErrors[missing.id]).toMatch(/isn't in the sketch/);
    const tooFar = revolveFeature(sk.id, 400);
    expect(build([sk, tooFar]).featureErrors[tooFar.id]).toMatch(/at most 360/);
  });
});

describe("shell", () => {
  const shellFeature = (thickness: number, picks: TopoPick[]): Feature => ({ ...feature("shell", { thickness }, "add"), picks });
  const topFace = (r: ReturnType<typeof build>): TopoPick => {
    const part = r.parts[0];
    const top = [...part.faceRefs].sort((a, b) => b.center[2] - a.center[2])[0];
    return { partId: part.id, ref: top };
  };

  it("hollows a box into an open tray", () => {
    const box = feature("box", { width: 20, depth: 20, height: 10 });
    const pick = topFace(build([box]));
    const r = build([box, shellFeature(2, [pick])]);
    expect(r.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].exactVolume).toBeCloseTo(20 * 20 * 10 - 16 * 16 * 8, 2);
    const check = engine.check("normal").parts[0];
    expect(check.geometryValid).toBe(true);
    expect(check.mesh.watertight).toBe(true);
  });

  it("opens a part whose edges are all rounded", () => {
    // Every edge of a 30 × 20 × 10 box rounded 2 mm, then shelled 1 mm open at the top: the closed hollow less
    // the flat part of the top wall (26 × 16 × 1).
    const box = feature("box", { width: 30, depth: 20, height: 10 });
    const first = build([box]);
    const fil: Feature = { ...feature("fillet", { radius: 2 }, "add"), picks: first.parts[0].edgeRefs.map((ref) => ({ partId: box.id, ref })) };
    const rounded = build([box, fil]);
    const top = rounded.parts[0].faceRefs.find((f) => f.surface === "PLANE" && f.normal[2] > 0.99)!;
    const open = build([box, fil, shellFeature(1, [{ partId: box.id, ref: top }])]);
    expect(open.featureErrors).toEqual({});
    const v = engine.check("normal").parts[0];
    expect(v.geometryValid).toBe(true);
    build([box, fil, shellFeature(1, [])]);
    const closed = engine.check("normal").parts[0].exactVolume!;
    expect(v.exactVolume!).toBeCloseTo(closed - 26 * 16, 1);
  });

  it("hollows a ball (or a box with no face picked) closed inside", () => {
    // A 20 mm ball, its one face picked: a 2 mm skin round a 16 mm hollow.
    const ball = feature("sphere", { diameter: 20, x: 0, y: 0, z: 0 });
    const r = build([ball, shellFeature(2, [topFace(build([ball]))])]);
    expect(r.featureErrors).toEqual({});
    const check = engine.check("normal").parts[0];
    expect(check.geometryValid).toBe(true);
    expect(check.exactVolume!).toBeCloseTo((4 / 3) * Math.PI * (1000 - 512), 0);
    // A box with nothing picked: closed walls all round.
    const box = feature("box", { width: 20, depth: 20, height: 10 });
    const closed = build([box, shellFeature(2, [])]);
    expect(closed.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].exactVolume!).toBeCloseTo(20 * 20 * 10 - 16 * 16 * 6, 1);
    // Hollow with a face picked: the face only says which part; it stays closed.
    const other = feature("box", { width: 10, depth: 10, height: 10, x: 50 });
    const hollowed = build([box, other, { ...shellFeature(2, [topFace(build([box]))]), hollow: true }]);
    expect(hollowed.featureErrors).toEqual({});
    expect(engine.check("normal").parts.map((p) => Math.round(p.exactVolume!))).toEqual([20 * 20 * 10 - 16 * 16 * 6, 1000]);
  });

  it("keeps working after the box is resized", () => {
    const box = feature("box", { width: 20, depth: 20, height: 10 });
    const pick = topFace(build([box]));
    const taller = { ...box, params: { ...box.params, height: "15", width: "30" } };
    const r = build([taller, shellFeature(1, [pick])]);
    expect(r.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].exactVolume).toBeCloseTo(30 * 20 * 15 - 28 * 18 * 14, 2);
  });

  it("explains problems in plain words", () => {
    const box = feature("box", { width: 20, depth: 20, height: 10 });
    const pick = topFace(build([box]));
    const thick = shellFeature(15, [pick]);
    const r = build([box, thick]);
    expect(r.featureErrors[thick.id]).toMatch(/thinner walls/);
    expect(engine.check("normal").parts[0].exactVolume).toBeCloseTo(4000, 2);
  });
});

describe("STEP export", () => {
  it("writes exact shapes that read back with the same volume", async () => {
    const block = feature("box", { width: 30, depth: 20, height: 10 });
    const hole = feature("cylinder", { diameter: 8, height: 10, x: 15, y: 10 }, "remove");
    build([block, hole]);
    const { step, partCount } = await engine.exportStep([]);
    expect(partCount).toBe(1);
    const text = new TextDecoder().decode(step);
    expect(text.startsWith("ISO-10303-21")).toBe(true);
    // Exact shapes: the hole is stored as a true cylinder, not triangles.
    expect(text).toMatch(/CYLINDRICAL_SURFACE/);
    expect(text).toMatch(/Part 1/);
    // Millimetres.
    expect(text).toMatch(/SI_UNIT\(\.MILLI\.,\.METRE\.\)/);
    const { importSTEP, measureVolume: volumeOf } = await import("replicad");
    const back = await importSTEP(new Blob([step]));
    expect(volumeOf(back as Parameters<typeof volumeOf>[0])).toBeCloseTo(30 * 20 * 10 - Math.PI * 16 * 10, 2);
  });

  it("refuses to export an empty model", async () => {
    build([]);
    await expect(engine.exportStep([])).rejects.toThrow(/nothing to export/);
  });
});

describe("mirror and patterns", () => {
  const patternFeature = (type: "linearPattern" | "circularPattern", sources: string[], params: Record<string, number>, axis: "x" | "y" | "z" = "x"): Feature => ({
    ...feature(type, params, "add"),
    pattern: { sources, axis, flip: false },
  });
  const mirrorFeature = (sources: string[], name: "Top" | "Front" | "Right" = "Right"): Feature => ({
    ...feature("mirror", {}, "add"),
    mirror: { sources, plane: { kind: "default", name } },
  });
  const volume = () => engine.check("normal").parts[0].exactVolume!;

  it("repeats a hole in a row", () => {
    const plate = feature("box", { width: 60, depth: 20, height: 10 });
    const hole = feature("cylinder", { diameter: 6, height: 10, x: 10, y: 10 }, "remove");
    const r = build([plate, hole, patternFeature("linearPattern", [hole.id], { count: 3, spacing: 20 })]);
    expect(r.featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(12000 - 3 * Math.PI * 9 * 10, 2);
    expect(r.parts).toHaveLength(1);
  });

  it("repeats a hole round a circle", () => {
    const disc = feature("cylinder", { diameter: 60, height: 10 });
    const hole = feature("cylinder", { diameter: 6, height: 10, x: 20 }, "remove");
    const r = build([disc, hole, patternFeature("circularPattern", [hole.id], { count: 6, angle: 360 }, "z")]);
    expect(r.featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(Math.PI * 900 * 10 - 6 * Math.PI * 9 * 10, 1);
  });

  it("mirrors a boss to the other side", () => {
    const base = feature("box", { width: 40, depth: 20, height: 10, x: -20 });
    const boss = feature("cylinder", { diameter: 6, height: 5, x: 10, y: 10, z: 10 }, "add");
    const r = build([base, boss, mirrorFeature([boss.id])]);
    expect(r.featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(8000 + 2 * Math.PI * 9 * 5, 2);
    const check = engine.check("normal").parts[0];
    expect(check.geometryValid).toBe(true);
    expect(check.mesh.pieces).toBe(1);
  });

  it("explains problems in plain words", () => {
    const plate = feature("box", { width: 60, depth: 20, height: 10 });
    const hole = feature("cylinder", { diameter: 6, height: 10, x: 10, y: 10 }, "remove");
    const none = patternFeature("linearPattern", [], { count: 3, spacing: 20 });
    expect(build([plate, hole, none]).featureErrors[none.id]).toMatch(/Pick the features/);
    const half = patternFeature("linearPattern", [hole.id], { count: 2.5, spacing: 20 });
    expect(build([plate, hole, half]).featureErrors[half.id]).toMatch(/whole number/);
    const one = patternFeature("linearPattern", [hole.id], { count: 1, spacing: 20 });
    expect(build([plate, hole, one]).featureErrors[one.id]).toMatch(/at least 2/);
    const early = patternFeature("linearPattern", [hole.id], { count: 2, spacing: 20 });
    expect(build([plate, early, hole]).featureErrors[early.id]).toMatch(/comes after/);
    const gone = mirrorFeature(["nope"]);
    expect(build([plate, gone]).featureErrors[gone.id]).toMatch(/deleted/);
  });
});

describe("variables", () => {
  it("builds sizes from the document's variables", () => {
    engine = new GeometryEngine();
    const box = feature("box", { width: "wall * 10", depth: "wall * 5", height: "wall" });
    const r = engine.rebuild([box], { wall: 2 });
    expect(r.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].exactVolume).toBeCloseTo(20 * 10 * 2, 3);
    const missing = engine.rebuild([box], {});
    expect(missing.featureErrors[box.id]).toMatch(/no variable called "wall"/);
  });
});

describe("3MF export", () => {
  it("writes each part as a named, joined-up mesh", () => {
    build([feature("box", { width: 10, depth: 10, height: 10 }), feature("box", { width: 5, depth: 5, height: 5, x: 20 })]);
    const { data, triangleCount } = engine.export3mf([], "coarse", "Two boxes");
    expect(triangleCount).toBe(24);
    const text = new TextDecoder().decode(data);
    expect(text.startsWith("PK")).toBe(true);
    expect(text).toMatch(/name="Part 1"/);
    expect(text).toMatch(/name="Part 2"/);
    expect(text).toMatch(/unit="millimeter"/);
    // Corners are shared: 8 per box.
    expect(text.match(/<vertex /g)).toHaveLength(16);
  });
});

describe("fuller model check", () => {
  it("measures the thinnest wall", () => {
    build([feature("box", { width: 40, depth: 30, height: 1.2 })]);
    const t = engine.check("normal").parts[0].thinnest;
    expect(t?.thickness).toBeCloseTo(1.2, 3);
  });

  it("measures the wall of a hollowed tray, not its overall size", () => {
    const box = feature("box", { width: 30, depth: 30, height: 15 });
    const r0 = build([box]);
    const top = [...r0.parts[0].faceRefs].sort((a, b) => b.center[2] - a.center[2])[0];
    build([box, { ...feature("shell", { thickness: 1.5 }, "add"), picks: [{ partId: box.id, ref: top }] }]);
    expect(engine.check("normal").parts[0].thinnest?.thickness).toBeCloseTo(1.5, 2);
  });

  it("spots separate parts that overlap", () => {
    build([feature("box", { width: 10, depth: 10, height: 10 }), feature("box", { width: 10, depth: 10, height: 10, x: 5 })]);
    const overlaps = engine.check("normal").overlaps ?? [];
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toMatchObject({ a: "Part 1", b: "Part 2" });
    expect(overlaps[0].volume).toBeCloseTo(500, 3);
    build([feature("box", { width: 10, depth: 10, height: 10 }), feature("box", { width: 10, depth: 10, height: 10, x: 10 })]);
    expect(engine.check("normal").overlaps).toEqual([]);
  });
});

describe("extrude through all and the new sketch shapes", () => {
  it("cuts a hole right through, whichever side the sketch is on", () => {
    const block = feature("box", { width: 40, depth: 40, height: 25, z: -5 });
    const sk = sketchFeature({ kind: "default", name: "Top" }, addCircle(emptySketch(), { x: 20, y: 20 }, 4).sketch);
    const cut = { ...extrudeFeature(sk.id, 1, { operation: "remove" }), extrude: { end: "throughAll" as const, flip: false } };
    const r = build([block, sk, cut]);
    expect(r.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].exactVolume).toBeCloseTo(40 * 40 * 25 - Math.PI * 16 * 25, 1);

    const add = { ...cut, operation: "add" as const };
    expect(build([block, sk, add]).featureErrors[add.id]).toMatch(/only works with Remove/);
  });

  it("cuts notches flush with any edge, and holes where joined shapes overlap", () => {
    for (const [a, b] of [
      [{ x: 40, y: 0 }, { x: 60, y: 20 }],
      [{ x: 40, y: 80 }, { x: 60, y: 100 }],
      [{ x: 0, y: 40 }, { x: 20, y: 60 }],
      [{ x: 80, y: 40 }, { x: 100, y: 60 }],
    ]) {
      const data = addRectangle(addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 100, y: 100 }).sketch, a, b).sketch;
      const sk = sketchFeature({ kind: "default", name: "Top" }, data);
      build([sk, extrudeFeature(sk.id, 10)]);
      expect(engine.check("normal").parts[0].exactVolume).toBeCloseTo(96000, 1);
    }
    let plus = addRectangle(emptySketch(), { x: 0, y: 40 }, { x: 100, y: 60 }).sketch;
    plus = addRectangle(plus, { x: 40, y: 0 }, { x: 60, y: 100 }).sketch;
    plus = addCircle(plus, { x: 50, y: 50 }, 5).sketch;
    const sk = sketchFeature({ kind: "default", name: "Top" }, plus);
    build([sk, extrudeFeature(sk.id, 10)]);
    expect(engine.check("normal").parts[0].exactVolume).toBeCloseTo((3600 - Math.PI * 25) * 10, 1);
  });

  it("extrudes slots, polygons and rounded rectangles", async () => {
    const { addSlot, addPolygon, filletCorner } = await import("../src/sketch/tools");
    const slot = sketchFeature({ kind: "default", name: "Top" }, addSlot(emptySketch(), { x: 0, y: 0 }, { x: 30, y: 0 }, 5).sketch);
    build([slot, extrudeFeature(slot.id, 2)]);
    expect(engine.check("normal").parts[0].exactVolume).toBeCloseTo((30 * 10 + Math.PI * 25) * 2, 2);

    const hex = sketchFeature({ kind: "default", name: "Top" }, addPolygon(emptySketch(), { x: 0, y: 0 }, { x: 10, y: 0 }, 6).sketch);
    build([hex, extrudeFeature(hex.id, 1)]);
    expect(engine.check("normal").parts[0].exactVolume).toBeCloseTo((3 * Math.sqrt(3) / 2) * 100, 2);

    const rect = addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 40, y: 20 });
    const corner = (rect.sketch.curves[0] as { p2: string }).p2;
    const rounded = sketchFeature({ kind: "default", name: "Top" }, filletCorner(rect.sketch, corner, "5").sketch);
    const r = build([rounded, extrudeFeature(rounded.id, 1)]);
    expect(r.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].exactVolume).toBeCloseTo(800 - (25 - (Math.PI * 25) / 4), 2);
  });
});

describe("holes", () => {
  const holeFeature = (sketchRef: string, hole: Partial<NonNullable<Feature["hole"]>>, params: Record<string, number>): Feature => ({
    ...feature("hole", params, "remove"),
    hole: { sketchRef, kind: "simple", standard: "Custom", fit: "clearance", end: "throughAll", flip: false, ...hole },
  });
  /** A 40 × 40 × 20 block whose top face is on the Top plane, with points at two corners' insets. */
  const setup = () => {
    const block = feature("box", { width: 40, depth: 40, height: 20, z: -20 });
    let data = emptySketch();
    data = addPoint(data, { x: 10, y: 10 }).sketch;
    data = addPoint(data, { x: 30, y: 30 }).sketch;
    const sk = sketchFeature({ kind: "default", name: "Top" }, data);
    return { block, sk };
  };
  const volume = () => engine.check("normal").parts[0].exactVolume!;
  const size = (over: Partial<HoleSize>): HoleSize => ({
    kind: "simple",
    diameter: 4.5,
    depth: 10,
    throughAll: false,
    throughLength: 0,
    cboreDiameter: 8,
    cboreDepth: 4.4,
    cskDiameter: 9.4,
    cskAngle: 90,
    ...over,
  });

  it("drills straight through at each point", () => {
    const { block, sk } = setup();
    const r = build([block, sk, holeFeature(sk.id, {}, { diameter: 4.5 })]);
    expect(r.featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(32000 - 2 * Math.PI * 2.25 * 2.25 * 20, 2);
    expect(engine.check("normal").parts[0].geometryValid).toBe(true);
  });

  it("drills to a depth with a drill point, counterbored and countersunk", () => {
    const { block, sk } = setup();
    build([block, sk, holeFeature(sk.id, { end: "blind" }, { diameter: 4.5, depth: 10 })]);
    expect(volume()).toBeCloseTo(32000 - 2 * holeVolume(size({})), 2);

    build([block, sk, holeFeature(sk.id, { kind: "counterbore", end: "blind" }, { diameter: 4.5, depth: 10, cboreDiameter: 8, cboreDepth: 4.4 })]);
    expect(volume()).toBeCloseTo(32000 - 2 * holeVolume(size({ kind: "counterbore" })), 2);

    build([block, sk, holeFeature(sk.id, { kind: "countersink" }, { diameter: 4.5, cskDiameter: 9.4, cskAngle: 90 })]);
    expect(volume()).toBeCloseTo(32000 - 2 * holeVolume(size({ kind: "countersink", throughAll: true, throughLength: 20 })), 2);
  });

  it("finds the holes for drawing callouts", () => {
    const { block, sk } = setup();
    build([block, sk, holeFeature(sk.id, { kind: "counterbore", end: "blind" }, { diameter: 4.5, depth: 10, cboreDiameter: 8, cboreDepth: 4.4 })]);
    const [top, bottom, front] = engine.project([], undefined, ["top", "bottom", "front"], false);
    expect(top.holes).toHaveLength(2);
    const h = [...top.holes!].sort((a, b) => a.cx - b.cx)[0];
    expect([h.cx, h.cy].map((v) => Math.round(v * 1000) / 1000)).toEqual([10, 10]);
    expect(h.d).toBeCloseTo(4.5, 4);
    expect(h.through).toBe(false);
    expect(h.depth).toBeCloseTo(10, 3);
    expect(h.cbore!.diameter).toBeCloseTo(8, 4);
    expect(h.cbore!.depth).toBeCloseTo(4.4, 4);
    expect(h.csk).toBe(undefined);
    // Not seen from underneath (it doesn't come out there), nor from the side.
    expect(bottom.holes).toEqual([]);
    expect(front.holes).toEqual([]);
    // From the side: where each hole runs (for thread symbols), 10 deep, down from the top.
    expect(front.sideHoles).toHaveLength(2);
    const sh = front.sideHoles![0];
    expect(Math.abs(sh.a[1] - sh.b[1])).toBeCloseTo(10, 3);
    expect(sh.a[0]).toBeCloseTo(sh.b[0], 6);
    expect(sh.d).toBeCloseTo(4.5, 4);

    build([block, sk, holeFeature(sk.id, { kind: "countersink" }, { diameter: 4.5, cskDiameter: 9.4, cskAngle: 90 })]);
    const [t2, b2] = engine.project([], undefined, ["top", "bottom"], false);
    expect(t2.holes).toHaveLength(2);
    expect(t2.holes![0].through).toBe(true);
    expect(t2.holes![0].csk!.diameter).toBeCloseTo(9.4, 3);
    expect(t2.holes![0].csk!.angle).toBeCloseTo(90, 1);
    expect(t2.holes![0].cbore).toBe(undefined);
    // Through holes show from either side.
    expect(b2.holes).toHaveLength(2);

    // A round boss isn't a hole.
    build([feature("cylinder", { diameter: 10, height: 5, x: 0, y: 0, z: 0 })]);
    expect(engine.project([], undefined, ["top"], false)[0].holes).toEqual([]);
  });

  it("finds the other holes like one picked (for Replicate)", () => {
    const block = feature("box", { width: 40, depth: 40, height: 20, z: -20 });
    let data = emptySketch();
    for (const [x, y] of [
      [10, 10],
      [30, 10],
      [10, 30],
      [30, 30],
    ])
      data = addPoint(data, { x, y }).sketch;
    data = addPoint(data, { x: 20, y: 20 }).sketch;
    const sk = sketchFeature({ kind: "default", name: "Top" }, data);
    const four = holeFeature(sk.id, {}, { diameter: 4.5 });
    const r = build([block, sk, four]);
    expect(r.featureErrors).toEqual({});
    const part = r.parts[0];
    // A round edge at the top of the hole at (10, 10).
    const i = part.edgeRefs.findIndex((e) => e.curve === "CIRCLE" && Math.abs(e.mid[2]) < 1e-3 && Math.hypot(e.mid[0] - 10, e.mid[1] - 10) < 3);
    expect(i).toBeGreaterThanOrEqual(0);
    const found = matchingConnectors(part, { partId: part.id, ref: part.edgeRefs[i] });
    // The other four holes' top edges: not their bottom edges, nor the bottom of this one.
    expect(found).toHaveLength(4);
    expect(found.every((p) => p.ref.kind === "edge" && Math.abs(p.ref.mid[2]) < 1e-3)).toBe(true);
  });

  it("uses circle centres too, and can be patterned", () => {
    const block = feature("box", { width: 60, depth: 20, height: 10, z: -10 });
    const sk = sketchFeature({ kind: "default", name: "Top" }, addCircle(emptySketch(), { x: 10, y: 10 }, 1).sketch);
    const hole = holeFeature(sk.id, {}, { diameter: 4 });
    const pattern: Feature = { ...feature("linearPattern", { count: 3, spacing: 20 }, "add"), pattern: { sources: [hole.id], axis: "x", flip: false } };
    const r = build([block, sk, hole, pattern]);
    expect(r.featureErrors).toEqual({});
    expect(volume()).toBeCloseTo(12000 - 3 * Math.PI * 4 * 10, 2);
  });

  it("explains problems in plain words", () => {
    const { block } = setup();
    const empty = sketchFeature({ kind: "default", name: "Top" }, addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 5, y: 5 }).sketch);
    const h = holeFeature(empty.id, {}, { diameter: 4 });
    expect(build([block, empty, h]).featureErrors[h.id]).toMatch(/no points for holes/);
    const { sk } = setup();
    const lone = holeFeature(sk.id, {}, { diameter: 4 });
    expect(build([sk, lone]).featureErrors[lone.id]).toMatch(/no part to drill into/);
    const bad = holeFeature(sk.id, { kind: "counterbore" }, { diameter: 6, cboreDiameter: 5 });
    expect(build([block, sk, bad]).featureErrors[bad.id]).toMatch(/wider than the hole/);
  });
});

describe("boolean and intersect", () => {
  const vol = () => engine.check("normal").parts.map((p) => Math.round(p.exactVolume! * 1000) / 1000);
  const boolean = (op: "union" | "subtract" | "intersect", targets: string[], tools: string[] = [], keepTools = false): Feature => ({
    ...feature("boolean", {}),
    booleanDef: { op, targets, tools, keepTools },
  });
  // Two 10 mm cubes overlapping by 5 mm along X.
  const a = feature("box", { width: 10, depth: 10, height: 10 });
  const b = feature("box", { width: 10, depth: 10, height: 10, x: 5 });

  it("joins parts into one", () => {
    const r = build([a, b, boolean("union", [a.id, b.id])]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    expect(vol()).toEqual([1500]);
  });

  it("cuts parts with others, using them up unless kept", () => {
    const r = build([a, b, boolean("subtract", [a.id], [b.id])]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((p) => p.id)).toEqual([a.id]);
    expect(vol()).toEqual([500]);
    expect(build([a, b, boolean("subtract", [a.id], [b.id], true)]).parts).toHaveLength(2);
  });

  it("keeps only where parts overlap", () => {
    const r = build([a, b, boolean("intersect", [a.id, b.id])]);
    expect(vol()).toEqual([500]);
    expect(r.parts).toHaveLength(1);
    const far = feature("box", { width: 5, depth: 5, height: 5, x: 50 });
    expect(build([a, far, boolean("intersect", [a.id, far.id])]).featureErrors).not.toEqual({});
  });

  it("explains what's missing", () => {
    expect(build([a, b, boolean("union", [a.id])]).featureErrors).not.toEqual({});
    expect(build([a, b, boolean("subtract", [a.id])]).featureErrors).not.toEqual({});
  });

  it("intersects a new solid with the latest part", () => {
    const cyl = feature("cylinder", { diameter: 10, height: 20, x: 0, y: 0, z: -5 }, "intersect");
    const r = build([a, cyl]);
    expect(r.featureErrors).toEqual({});
    // A quarter of the cylinder's disc inside the cube, 10 mm tall.
    expect(vol()[0]).toBeCloseTo((Math.PI * 25 * 10) / 4, 1);
  });
});

describe("split, thicken and rib", () => {
  const vol = () => engine.check("normal").parts.map((p) => Math.round(p.exactVolume! * 100) / 100);
  const cube = feature("box", { width: 20, depth: 10, height: 10, x: -5 });

  it("splits a part in two along a plane, or keeps one side", () => {
    const split = (keep: "both" | "front" | "back", name: "Right" | "Top" = "Right"): Feature => ({ ...feature("split", {}), splitDef: { partId: cube.id, plane: { kind: "default", name }, keep } });
    const both = build([cube, split("both")]);
    expect(both.featureErrors).toEqual({});
    expect(both.parts).toHaveLength(2);
    // The Right plane (x = 0) faces +X: 15 mm of the box is in front, 5 behind.
    expect(vol().sort((x, y) => x - y)).toEqual([500, 1500]);
    build([cube, split("front")]);
    expect(vol()).toEqual([1500]);
    const missed = { ...split("both", "Top"), splitDef: { partId: cube.id, plane: { kind: "face" as const, origin: [0, 0, 50] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number], label: "high" }, keep: "both" as const } };
    expect(build([cube, missed]).featureErrors[missed.id]).toMatch(/doesn't go through/);
  });

  it("thickens a flat face", () => {
    const r1 = build([cube]);
    const top = r1.parts[0].faceRefs.findIndex((f) => f.surface === "PLANE" && f.normal[2] > 0.99);
    const thicken: Feature = { ...feature("thicken", { thickness: 3 }, "add"), picks: [{ partId: cube.id, ref: r1.parts[0].faceRefs[top] }] };
    const r = build([cube, thicken]);
    expect(r.featureErrors).toEqual({});
    expect(vol()).toEqual([2000 + 600]);
    // As a new part of its own.
    expect(build([cube, { ...thicken, operation: "new" }]).parts).toHaveLength(2);
  });

  it("braces a corner with a rib", () => {
    // An L: a 40 × 10 × 5 base and a 5 × 10 × 40 upright, joined.
    const base = feature("box", { width: 40, depth: 10, height: 5 });
    const upright = feature("box", { width: 5, depth: 10, height: 40 }, "add");
    // A line across the inside corner, from (5, 25) to (25, 5), sketched on a plane through the middle (y = 5).
    const sk = { ...sketchFeature({ kind: "face", origin: [0, 5, 0], u: [1, 0, 0], v: [0, 0, 1], label: "mid" }, lineSketch(5, 25, 25, 5)) };
    const rib: Feature = { ...feature("rib", { thickness: 2 }, "add"), sketchRef: sk.id };
    build([base, upright]);
    const before = vol()[0];
    const r = build([base, upright, sk, rib]);
    expect(r.featureErrors).toEqual({});
    // The triangle in the corner (20 × 20 / 2), 2 mm thick.
    expect(vol()[0] - before).toBeCloseTo(400, 0);
  });
});

describe("draft, move face and delete face", () => {
  const vol = () => Math.round(engine.check("normal").parts[0].exactVolume! * 100) / 100;
  const faceOf = (r: ReturnType<typeof build>, test: (f: { surface: string; normal: number[] }) => boolean) => {
    const p = r.parts[0];
    return p.faceRefs.filter((f) => f.kind === "face" && test(f as { surface: string; normal: number[] })).map((ref) => ({ partId: p.id, ref }));
  };

  it("moves a flat face out, or in", () => {
    const box = feature("box", { width: 20, depth: 10, height: 10 });
    const r1 = build([box]);
    const top = faceOf(r1, (f) => f.surface === "PLANE" && f.normal[2] > 0.99);
    const out: Feature = { ...feature("moveFace", { distance: 3 }), picks: top };
    expect(build([box, out]).featureErrors).toEqual({});
    expect(vol()).toBe(2600);
    build([box, { ...out, params: { distance: "-3" } }]);
    expect(vol()).toBe(1400);
  });

  it("replaces faces: moves them onto a parallel face or plane, with an offset", () => {
    const box = feature("box", { width: 20, depth: 10, height: 10 });
    const r1 = build([box]);
    const top = faceOf(r1, (f) => f.surface === "PLANE" && f.normal[2] > 0.99);
    const bottom = faceOf(r1, (f) => f.surface === "PLANE" && f.normal[2] < -0.99);
    // Up to a face 15 mm up (its normal facing down, like another part's underside).
    const high = { kind: "face" as const, origin: [3, 4, 15] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, -1, 0] as [number, number, number], label: "Face" };
    const rep: Feature = { ...feature("replaceFace", { offset: 0 }), picks: top, replaceDef: { target: high } };
    expect(build([box, rep]).featureErrors).toEqual({});
    expect(vol()).toBe(3000);
    // 2 mm short of it.
    build([box, { ...rep, params: { offset: "-2" } }]);
    expect(vol()).toBe(2600);
    // The bottom moved up onto a face at z = 4: shrinks the part.
    build([box, { ...rep, picks: bottom, replaceDef: { target: { ...high, origin: [0, 0, 4] } } }]);
    expect(vol()).toBe(1200);
    // The top onto the Top plane, 6 mm past it (up): 6 mm tall.
    build([box, { ...rep, replaceDef: { target: { kind: "default", name: "Top" } }, params: { offset: "6" } }]);
    expect(vol()).toBe(1200);
    // Not parallel: a clear message.
    const tilted = build([box, { ...rep, replaceDef: { target: { kind: "default", name: "Front" } } }]);
    expect(tilted.featureErrors[rep.id]).toMatch(/parallel/);
    // Nothing to move onto yet.
    expect(build([box, { ...rep, replaceDef: { target: null } }]).featureErrors[rep.id]).toMatch(/Click the face/);
  });

  it("rounds the top of a wall right over (a full round), tangent to both sides", () => {
    // A wall 10 thick, 40 long, 20 tall: its top becomes a half-round of radius 5.
    const wall = feature("box", { width: 10, depth: 40, height: 20 });
    const top = faceOf(build([wall]), (f) => f.surface === "PLANE" && f.normal[2] > 0.99);
    const round: Feature = { ...feature("fullRound", {}), picks: top };
    const r = build([wall, round]);
    expect(r.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].exactVolume!).toBeCloseTo(8000 - (10 * 40 * 5 - (Math.PI * 25 * 40) / 2), 1);
    // Still 20 tall at the middle of the round.
    const zs = Array.from(r.parts[0].vertices).filter((_, i) => i % 3 === 2);
    expect(Math.max(...zs)).toBeCloseTo(20, 2);
    // Too short to round right over.
    const low = feature("box", { width: 10, depth: 40, height: 3 });
    const lowTop = faceOf(build([low]), (f) => f.surface === "PLANE" && f.normal[2] > 0.99);
    expect(build([low, { ...round, picks: lowTop }]).featureErrors[round.id]).toMatch(/aren't tall enough/);
  });

  it("tapers side faces about the neutral plane", () => {
    const box = feature("box", { width: 20, depth: 20, height: 10 });
    const r1 = build([box]);
    const sides = faceOf(r1, (f) => f.surface === "PLANE" && Math.abs(f.normal[2]) < 0.01);
    const draft: Feature = { ...feature("draft", { angle: 5 }), picks: sides, neutral: { kind: "default", name: "Top" } };
    const r = build([box, draft]);
    expect(r.featureErrors).toEqual({});
    // Narrower at the top: each side leans in by 10 × tan 5° ≈ 0.875 mm.
    const v = vol();
    expect(v).toBeLessThan(4000);
    expect(v).toBeGreaterThan(3600);
  });

  it("deletes a hole's wall, closing the hole", () => {
    const box = feature("box", { width: 20, depth: 20, height: 10 });
    const hole = feature("cylinder", { diameter: 6, height: 10, x: 10, y: 10 }, "remove");
    const r1 = build([box, hole]);
    const wall = faceOf(r1, (f) => f.surface.startsWith("CYLIND"));
    expect(wall.length).toBeGreaterThan(0);
    const del: Feature = { ...feature("deleteFace", {}), picks: wall };
    const r = build([box, hole, del]);
    expect(r.featureErrors).toEqual({});
    expect(vol()).toBe(4000);
  });
});

describe("what stops a Delete face", () => {
  const filletedHole = () => {
    const block = feature("box", { width: 30, depth: 30, height: 10 });
    const hole = feature("cylinder", { diameter: 10, height: 10, x: 15, y: 15 }, "remove");
    const first = build([block, hole]);
    const rim = first.parts[0].edgeRefs.find((e) => e.curve === "CIRCLE" && e.mid[2] > 9.99)!;
    const fillet: Feature = { ...feature("fillet", { radius: 1 }, "add"), picks: [{ partId: block.id, ref: rim }] };
    const r = build([block, hole, fillet]);
    return { block, hole, fillet, r };
  };

  it("names the fillet in the way of deleting a hole's wall", () => {
    const { block, hole, fillet, r } = filletedHole();
    const wall = r.parts[0].faceRefs.filter((f) => f.kind === "face" && f.surface.startsWith("CYLIND")).map((ref) => ({ partId: block.id, ref }));
    const del: Feature = { ...feature("deleteFace", {}), picks: wall };
    const features = [block, hole, fillet, del];
    expect(build(features).featureErrors[del.id]).toBeTruthy();
    const before = engine.check("normal").parts.length;
    expect(engine.deleteFaceBlockers(features, del.id)).toEqual({ blockers: [fillet.id], makers: [] });
    // What was built is left alone.
    expect(engine.check("normal").parts.length).toBe(before);
    // And with the fillet turned off, the hole closes up.
    expect(build([block, hole, { ...fillet, suppressed: true }, del]).featureErrors).toEqual({});
  });

  it("says when the picked face is the fillet's own rounded face", () => {
    const { block, hole, fillet, r } = filletedHole();
    const round = r.parts[0].faceRefs.filter((f) => f.kind === "face" && f.surface.startsWith("TOR")).map((ref) => ({ partId: block.id, ref }));
    expect(round.length).toBeGreaterThan(0);
    const del: Feature = { ...feature("deleteFace", {}), picks: round };
    const features = [block, hole, fillet, del];
    expect(build(features).featureErrors[del.id]).toBeTruthy();
    expect(engine.deleteFaceBlockers(features, del.id)).toEqual({ blockers: [], makers: [fillet.id] });
  });
});

describe("threads", () => {
  const sideOf = (r: ReturnType<typeof build>, partId: string) => ({
    partId,
    ref: r.parts.find((p) => p.id === partId)!.faceRefs.find((f) => f.kind === "face" && f.surface === "CYLINDRE")!,
  });

  it("doesn't show the seam down a cylinder's side (so clicking there picks the round face)", () => {
    const rod = build([feature("cylinder", { diameter: 8, height: 12, x: 0, y: 0, z: 0 })]);
    const edges = rod.parts[0].edgeRefs;
    // Just the round edges at the top and bottom.
    expect(edges.map((e) => e.curve)).toEqual(["CIRCLE", "CIRCLE"]);
    expect(rod.parts[0].edgeGroups).toHaveLength(2);
    expect(rod.parts[0].lines.length / 3).toBe(rod.parts[0].edgeGroups.reduce((n, g) => n + g.count, 0));
    // A box keeps all twelve.
    expect(build([feature("box", { width: 5, depth: 5, height: 5 })]).parts[0].edgeRefs).toHaveLength(12);
  });

  it("cuts a bolt thread round a rod", () => {
    const rod = feature("cylinder", { diameter: 8, height: 12, x: 0, y: 0, z: 0 });
    const first = build([rod]);
    const before = engine.check("normal").parts[0].exactVolume!;
    const thread: Feature = { ...feature("thread", { pitch: 1.25, length: 0 }), picks: [sideOf(first, rod.id)] };
    const r = build([rod, thread]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    const check = engine.check("normal").parts[0];
    expect(check.geometryValid).toBe(true);
    // The groove takes away roughly its cross-section (½ × 0.88 × 0.77 mm²) times its length round the rod.
    expect(check.exactVolume!).toBeLessThan(before - 20);
    expect(check.exactVolume!).toBeGreaterThan(before - 200);
  });

  it("cuts a nut thread inside a hole, part of the way down", () => {
    const block = feature("box", { width: 20, depth: 20, height: 10 });
    const hole = feature("cylinder", { diameter: 6.75, height: 10, x: 10, y: 10 }, "remove");
    const first = build([block, hole]);
    const before = engine.check("normal").parts[0].exactVolume!;
    const thread: Feature = { ...feature("thread", { pitch: 1.25, length: 6 }), picks: [sideOf(first, block.id)] };
    const r = build([block, hole, thread]);
    expect(r.featureErrors).toEqual({});
    const check = engine.check("normal").parts[0];
    expect(check.geometryValid).toBe(true);
    expect(check.exactVolume!).toBeLessThan(before - 5);
    // The hole only gets bigger, so the outside doesn't change.
    const b = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles).bounds!;
    expect(b.max[0]).toBeCloseTo(20, 3);
  });

  it("explains what it needs", () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const first = build([box]);
    const flat = { partId: box.id, ref: first.parts[0].faceRefs[0] };
    const thread: Feature = { ...feature("thread", { pitch: 1, length: 0 }), picks: [] };
    expect(build([box, thread]).featureErrors[thread.id]).toMatch(/round face/);
    expect(build([box, { ...thread, picks: [flat] }]).featureErrors[thread.id]).toMatch(/round/);
  });
});

describe("measuring between parts", () => {
  it("measures between faces of two different parts, apart or overlapping", () => {
    const a = feature("box", { width: 10, depth: 10, height: 10 });
    const b = feature("box", { width: 10, depth: 10, height: 10, x: 25, y: 0, z: 0 });
    const r = build([a, b]);
    const side = (id: string, nx: number) => ({ partId: id, ref: r.parts.find((p) => p.id === id)!.faceRefs.find((f) => f.kind === "face" && f.normal[0] === nx)! });
    const m = engine.measure([side(a.id, 1), side(b.id, -1)]);
    expect(m.items).toHaveLength(2);
    expect(m.distance).toBeCloseTo(15, 6);
    const c = feature("box", { width: 10, depth: 10, height: 10, x: 5, y: 0, z: 0 });
    const r2 = build([a, c]);
    const tops = r2.parts.map((p) => ({ partId: p.id, ref: p.faceRefs.find((f) => f.kind === "face" && f.normal[2] === 1)! }));
    const m2 = engine.measure(tops);
    expect(m2.items).toHaveLength(2);
    expect(m2.distance).toBeCloseTo(0, 6);
  });

  it("measures whole parts: their volumes, the gap, and how much they overlap", () => {
    const a = feature("box", { width: 10, depth: 10, height: 10 });
    const apart = feature("box", { width: 10, depth: 10, height: 10, x: 25, y: 0, z: 0 });
    const r = build([a, apart]);
    const m = engine.measureParts(r.parts.map((p) => p.id));
    expect(m.items.map((i) => Math.round(i.volume!))).toEqual([1000, 1000]);
    expect(m.distance).toBeCloseTo(15, 6);
    expect(m.overlap).toBe(undefined);
    expect(m.centreDistance!.total).toBeCloseTo(25, 6);
    const over = feature("box", { width: 10, depth: 10, height: 10, x: 5, y: 0, z: 0 });
    const r2 = build([a, over]);
    const m2 = engine.measureParts(r2.parts.map((p) => p.id));
    expect(m2.distance).toBeCloseTo(0, 6);
    expect(m2.overlap).toBeCloseTo(500, 3);
  });
});

describe("delete part", () => {
  it("removes whole parts from that point on", () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const rod = feature("cylinder", { diameter: 4, height: 20, x: 30, y: 0, z: 0 });
    expect(build([box, rod]).parts).toHaveLength(2);
    const del: Feature = { ...feature("deletePart", {}), deleteParts: [rod.id] };
    const r = build([box, rod, del]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((p) => p.id)).toEqual([box.id]);
    expect(build([box, rod, { ...del, deleteParts: [] }]).featureErrors[del.id]).toMatch(/Click the parts/);
  });
});

describe("coil", () => {
  it("winds round wire into a spring", () => {
    const coil = feature("coil", { diameter: 20, wire: 2, pitch: 5, turns: 3, x: 0, y: 0, z: 0 });
    const r = build([coil]);
    expect(r.featureErrors).toEqual({});
    const check = engine.check("normal").parts[0];
    expect(check.geometryValid).toBe(true);
    // Wire volume ≈ π r² × length of the helix (3 turns of √((π·20)² + 5²)).
    const length = 3 * Math.hypot(Math.PI * 20, 5);
    expect(check.exactVolume!).toBeCloseTo(Math.PI * 1 * length, -1);
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(a.bounds!.max[0]).toBeCloseTo(11, 0);
    expect(build([{ ...coil, params: { ...coil.params, pitch: "1.5" } }]).featureErrors[coil.id]).toMatch(/pitch/i);
  });
});

describe("fasteners", () => {
  const fastener = (kind: FastenerKind, threaded = false, length = 12): Feature => ({
    ...feature("fastener", { length, x: 0, y: 0, z: 0 }),
    fastener: { kind, size: "M6", threaded },
  });
  const volumeOf = (r: ReturnType<typeof build>) => analyzeMesh(r.parts[0].vertices, r.parts[0].triangles).volume;
  const hexArea = (flats: number) => (Math.sqrt(3) / 2) * flats * flats;

  it("makes a hex bolt, nut and washer, named for what they are", () => {
    const bolt = build([fastener("bolt")]);
    expect(bolt.featureErrors).toEqual({});
    expect(bolt.parts[0].name).toBe("M6 × 12 hex bolt");
    expect(volumeOf(bolt)).toBeCloseTo(hexArea(10) * 4 + Math.PI * 9 * 12, -1);
    const nut = build([fastener("nut")]);
    expect(nut.parts[0].name).toBe("M6 hex nut");
    expect(volumeOf(nut)).toBeCloseTo((hexArea(10) - Math.PI * 9) * 5.2, -1);
    const washer = build([fastener("washer")]);
    expect(volumeOf(washer)).toBeCloseTo(Math.PI * (36 - 3.2 * 3.2) * 1.6, -1);
  });

  it("makes Allen key, countersunk, pan head and grub screws", () => {
    const cap = build([fastener("socketCap")]);
    expect(cap.featureErrors).toEqual({});
    expect(cap.parts[0].name).toBe("M6 × 12 socket cap screw");
    // Ø10 × 6 head less a 5 mm hex socket 3 deep, on a Ø6 × 12 shank.
    expect(volumeOf(cap)).toBeCloseTo(Math.PI * 25 * 6 - hexArea(5) * 3 + Math.PI * 9 * 12, -1);
    // Countersunk: overall length 12, a 3 mm 90° cone head (Ø12 to Ø6), 4 mm socket 2.2 deep; its top is flush at z = 0.
    const csk = build([fastener("countersunk")]);
    expect(csk.featureErrors).toEqual({});
    expect(volumeOf(csk)).toBeCloseTo((Math.PI * 3 * (9 + 18 + 36)) / 3 + Math.PI * 9 * 9 - hexArea(4) * 2.2, -1);
    const grub = build([fastener("grub", false, 10)]);
    expect(grub.parts[0].name).toBe("M6 × 10 grub screw");
    expect(volumeOf(grub)).toBeCloseTo(Math.PI * 9 * 10 - hexArea(3) * 2.4, -1);
    // Button head: a dome Ø10.5 × 3.3 (about 162 mm³) less its socket, on the shank.
    const button = volumeOf(build([fastener("buttonHead")]));
    expect(button).toBeGreaterThan(Math.PI * 9 * 12 + 100);
    expect(button).toBeLessThan(Math.PI * 9 * 12 + 170);
    // Pan head: Ø12 × 4.6 with a rounded top and a cross recess.
    const pan = build([fastener("panHead")]);
    expect(pan.featureErrors).toEqual({});
    const v = volumeOf(pan);
    expect(v).toBeGreaterThan(Math.PI * 9 * 12 + 350);
    expect(v).toBeLessThan(Math.PI * 9 * 12 + Math.PI * 36 * 4.6);
    // Too short for its head.
    expect(build([fastener("countersunk", false, 3)]).featureErrors).not.toEqual({});
  });

  it("threads screws below the head, and grub screws all along", () => {
    for (const kind of ["socketCap", "grub"] as const) {
      const plain = volumeOf(build([fastener(kind, false, 8)]));
      const threaded = build([fastener(kind, true, 8)]);
      expect(threaded.featureErrors).toEqual({});
      const v = volumeOf(threaded);
      expect(v).toBeLessThan(plain - 10);
      expect(v).toBeGreaterThan(plain - 90);
    }
  }, 120_000);

  it("cuts the thread when asked", () => {
    const plain = volumeOf(build([fastener("bolt", false, 8)]));
    const threaded = build([fastener("bolt", true, 8)]);
    expect(threaded.featureErrors).toEqual({});
    const v = volumeOf(threaded);
    expect(v).toBeLessThan(plain - 10);
    expect(v).toBeGreaterThan(plain - 80);
  }, 60_000);
});

describe("thread symbols on drawings", () => {
  it("marks a bolt's and a nut's thread on their views, and a Thread feature's on a rod", () => {
    // An M6 × 20 bolt at the origin: shank down to z = −20; root diameter 6 − 1.0825 = 4.9175.
    const bolt: Feature = { ...feature("fastener", { length: 20, x: 0, y: 0, z: 0 }), fastener: { kind: "socketCap", size: "M6", threaded: false } };
    build([bolt]);
    const [front, top] = engine.project([], undefined, ["front", "top"], true);
    expect(front.threadMarks).toHaveLength(2);
    const xs = front.threadMarks!.map((m) => Math.abs(m.line[0]));
    xs.forEach((x) => expect(x).toBeCloseTo(4.9175 / 2, 4));
    expect(front.threadMarks!.every((m) => !m.hidden)).toBe(true);
    const ys = front.threadMarks![0].line.filter((_, i) => i % 2 === 1).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(-20, 4);
    expect(ys[1]).toBeCloseTo(0, 4);
    // From above: a three-quarter circle at the root diameter.
    expect(top.threadMarks).toHaveLength(1);
    const arc = top.threadMarks![0].line;
    expect(Math.hypot(arc[0], arc[1])).toBeCloseTo(4.9175 / 2, 4);
    // A nut: dashed (inside the part) at the outside diameter, from the side.
    build([{ ...bolt, fastener: { kind: "nut", size: "M6", threaded: false } }]);
    const [nutFront] = engine.project([], undefined, ["front"], true);
    expect(nutFront.threadMarks!.every((m) => m.hidden)).toBe(true);
    expect(Math.abs(nutFront.threadMarks![0].line[0])).toBeCloseTo(3, 4);
    // A Thread feature on a 10 mm rod (pitch 1.5): root 10 − 1.62375.
    const rod = feature("cylinder", { diameter: 10, height: 30, x: 0, y: 0, z: 0 });
    const first = build([rod]);
    const side = first.parts[0].faceRefs.find((f) => f.surface === "CYLINDRE")!;
    const thread: Feature = { ...feature("thread", { pitch: 1.5, length: 10 }), picks: [{ partId: rod.id, ref: side }] };
    const r = build([rod, thread]);
    expect(r.featureErrors).toEqual({});
    const [rodFront] = engine.project([], undefined, ["front"], true);
    expect(rodFront.threadMarks).toHaveLength(2);
    expect(Math.abs(rodFront.threadMarks![0].line[0])).toBeCloseTo((10 - 1.62375) / 2, 3);
  }, 120_000);
});

describe("plane features", () => {
  it("build nothing, but say when they can't be placed", () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const plane: Feature = { ...feature("plane", { distance: 30, angle: 0 }), planeDef: { mode: "offset", ref: { kind: "default", name: "Top" }, axis: "u" } };
    const ok = build([box, plane]);
    expect(ok.featureErrors).toEqual({});
    expect(ok.parts).toHaveLength(1);
    const half: Feature = { ...plane, planeDef: { ...plane.planeDef!, mode: "midplane" } };
    expect(build([box, half]).featureErrors[plane.id]).toMatch(/second/);
  });
});

describe("move, turn and copy parts", () => {
  const transformFeature = (partId: string, t: Partial<NonNullable<Feature["transform"]>>, params: Record<string, number>): Feature => ({
    ...feature("transform", params, "add"),
    transform: { partId, axis: "z", about: "centre", copy: false, ...t },
  });
  const boundsOfPart = (r: ReturnType<typeof build>, i = 0) => analyzeMesh(r.parts[i].vertices, r.parts[i].triangles).bounds!;

  it("moves a part", () => {
    const box = feature("box", { width: 10, depth: 20, height: 5 });
    const r = build([box, transformFeature(box.id, {}, { dx: 30, dy: -5, dz: 2 })]);
    expect(r.featureErrors).toEqual({});
    expect(boundsOfPart(r).min.map((v) => Math.round(v * 1000) / 1000)).toEqual([30, -5, 2]);
  });

  it("turns a part a quarter turn about its centre", () => {
    const box = feature("box", { width: 10, depth: 20, height: 5 });
    const r = build([box, transformFeature(box.id, {}, { rz: 90 })]);
    const b = boundsOfPart(r);
    // 10 wide × 20 deep becomes 20 wide × 10 deep, still centred on (5, 10).
    expect(b.max[0] - b.min[0]).toBeCloseTo(20, 4);
    expect(b.max[1] - b.min[1]).toBeCloseTo(10, 4);
    expect((b.max[0] + b.min[0]) / 2).toBeCloseTo(5, 4);
  });

  it("turns about two axes at once (X first, then Y), and reads old designs that turned about one chosen axis", () => {
    const box = feature("box", { width: 10, depth: 20, height: 5 });
    // 90° about X stands the 20 mm depth up (and lays the height along Y); then 90° about Y swings that depth along X and the width along Z.
    const r = build([box, transformFeature(box.id, { about: "origin" }, { rx: 90, ry: 90 })]);
    expect(r.featureErrors).toEqual({});
    const b = boundsOfPart(r);
    expect(b.max[0] - b.min[0]).toBeCloseTo(20, 4);
    expect(b.max[1] - b.min[1]).toBeCloseTo(5, 4);
    expect(b.max[2] - b.min[2]).toBeCloseTo(10, 4);
    const old = parseDocument({ ...emptyDocument(), features: [box, { ...transformFeature(box.id, { axis: "y" }, {}), params: { angle: "90", dx: "0", dy: "0", dz: "0" } }] })!;
    const t = old.features[1];
    expect([t.params.rx, t.params.ry, t.params.rz, "angle" in t.params]).toEqual(["0", "90", "0", false]);
  });

  it("patterns a moved part from where it is now", () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const pattern: Feature = { ...feature("linearPattern", { count: 3, spacing: 20 }, "add"), pattern: { sources: [box.id], axis: "x", flip: false } };
    const r = build([box, transformFeature(box.id, {}, { dx: 50, dy: 5 }), pattern]);
    expect(r.featureErrors).toEqual({});
    const b = boundsOfPart(r);
    expect([b.min[0], b.max[0], b.min[1]].map((v) => Math.round(v * 1000) / 1000)).toEqual([50, 100, 5]);
  });

  it("copies a part, keeping the original", () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const copy = transformFeature(box.id, { copy: true }, { dx: 20 });
    const r = build([box, copy]);
    expect(r.parts.map((p) => p.name)).toEqual(["Part 1", "Part 2"]);
    expect(boundsOfPart(r, 0).min[0]).toBeCloseTo(0, 4);
    expect(boundsOfPart(r, 1).min[0]).toBeCloseTo(20, 4);
    // Later features on the copy work as on any part.
    const hole = feature("cylinder", { diameter: 4, height: 10, x: 25, y: 5 }, "remove");
    expect(build([box, copy, hole]).featureErrors).toEqual({});
  });

  it("explains problems in plain words", () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const nothing = transformFeature(box.id, {}, {});
    expect(build([box, nothing]).featureErrors[nothing.id]).toMatch(/Nothing to do yet/);
    const gone = transformFeature("nope", {}, { dx: 5 });
    expect(build([box, gone]).featureErrors[gone.id]).toMatch(/no longer exists/);
  });
});

describe("measure", () => {
  const pickNear = (r: ReturnType<typeof build>, kind: "edge" | "face", at: [number, number, number], part = 0): TopoPick => {
    const p = r.parts[part];
    const refs = kind === "edge" ? p.edgeRefs : p.faceRefs;
    const pos = (x: (typeof refs)[number]) => (x.kind === "edge" ? x.mid : x.center);
    const best = [...refs].sort((a, b) => Math.hypot(...pos(a).map((v, i) => v - at[i])) - Math.hypot(...pos(b).map((v, i) => v - at[i])))[0];
    return { partId: p.id, ref: best };
  };

  it("measures an edge's length and a face's area", () => {
    const r = build([feature("box", { width: 40, depth: 30, height: 20 })]);
    const m = engine.measure([pickNear(r, "edge", [20, 0, 20])]);
    expect(m.items[0].label).toBe("Straight edge");
    expect(m.items[0].length).toBeCloseTo(40, 6);
    expect(engine.measure([pickNear(r, "face", [20, 15, 20])]).items[0].area).toBeCloseTo(1200, 4);
  });

  it("measures the gap and angle between two faces", () => {
    const r = build([feature("box", { width: 40, depth: 30, height: 20 })]);
    const m = engine.measure([pickNear(r, "face", [20, 15, 20]), pickNear(r, "face", [20, 15, 0])]);
    expect(m.distance).toBeCloseTo(20, 6);
    expect(m.angle).toBe(0);
    const side = engine.measure([pickNear(r, "face", [20, 15, 20]), pickNear(r, "face", [0, 15, 10])]);
    expect(side.angle).toBe(90);
  });

  it("measures hole sizes and the spacing between holes", () => {
    const block = feature("box", { width: 50, depth: 20, height: 10 });
    const h1 = feature("cylinder", { diameter: 6, height: 10, x: 10, y: 10 }, "remove");
    const h2 = feature("cylinder", { diameter: 6, height: 10, x: 40, y: 10 }, "remove");
    const r = build([block, h1, h2]);
    const rimAt = (x: number): TopoPick => {
      const p = r.parts[0];
      const rim = p.edgeRefs.find((e) => e.curve === "CIRCLE" && e.mid[2] > 9.99 && Math.abs(e.mid[0] - x) < 4)!;
      return { partId: p.id, ref: rim };
    };
    const m = engine.measure([rimAt(10), rimAt(40)]);
    expect(m.items[0].radius).toBeCloseTo(3, 6);
    expect(m.centreDistance?.total).toBeCloseTo(30, 6);
    expect(m.centreDistance?.dx).toBeCloseTo(30, 6);
    expect(m.centreDistance?.dy).toBeCloseTo(0, 6);
    expect(m.distance).toBeCloseTo(24, 6);
  });
});

describe("part colours in exports", () => {
  it("writes colours into STEP and 3MF files", async () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    build([box]);
    const step = new TextDecoder().decode((await engine.exportStep([], { [box.id]: "#ff8000" })).step);
    // STEP wraps long lines, so join them before looking for the colour.
    const flat = step.replace(/\s+/g, "");
    const colours = [...flat.matchAll(/COLOUR_RGB\('[^']*',([-\d.Ee+]+),([-\d.Ee+]+),([-\d.Ee+]+)\)/g)].map((m) =>
      m.slice(1, 4).map(Number),
    );
    const orange = colours.some(([r, g, b]) => Math.abs(r - 1) < 0.01 && Math.abs(g - 128 / 255) < 0.01 && Math.abs(b) < 0.01);
    expect(orange ? "found" : `colours: ${JSON.stringify(colours)} ${flat.match(/.{0,80}COLOUR.{0,120}/g)?.slice(0, 4).join(" | ")}`).toBe("found");
    const mf = new TextDecoder().decode(engine.export3mf([], "coarse", "T", { [box.id]: "#ff8000" }).data);
    expect(mf).toMatch(/displaycolor="#FF8000"/);
  });
});

describe("importing STEP and STL files", () => {
  function importFeature(file: Feature["import"], operation: Operation = "new"): Feature {
    return { ...feature("import", {}, operation), import: file };
  }

  it("brings back a STEP file as the same solid, one part per solid", async () => {
    const a = feature("box", { width: 40, depth: 30, height: 20 });
    const b = feature("box", { width: 10, depth: 10, height: 10, x: 100 });
    build([a, b]);
    const step = new TextDecoder().decode((await engine.exportStep([])).step);
    engine.dispose();

    const imp = importFeature({ fileName: "two.step", format: "step", data: step, units: "mm" });
    const r = build([imp]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((p) => p.id)).toEqual([imp.id, `${imp.id}~2`]);
    expect(r.parts.map((p) => p.name)).toEqual(["Part 1", "Part 2"]);
    expect(analyzeMesh(r.parts[0].vertices, r.parts[0].triangles).volume).toBeCloseTo(24000, 0);
    expect(analyzeMesh(r.parts[1].vertices, r.parts[1].triangles).volume).toBeCloseTo(1000, 0);
    expect(r.parts[0].faceGroups).toHaveLength(6);

    // Rebuilding again uses the remembered copy and gives the same result.
    const again = engine.rebuild([imp]);
    expect(again.parts).toHaveLength(2);
  });

  it("brings in an STL as a closed solid that can be cut from another part", () => {
    build([feature("box", { width: 20, depth: 20, height: 20 })]);
    const stl = new Uint8Array(engine.exportStl([], "normal").stl);
    engine.dispose();
    let b64 = "";
    for (const x of stl) b64 += String.fromCharCode(x);
    const file = { fileName: "cube.stl", format: "stl" as const, data: btoa(b64), units: "mm" as const };

    const r = build([importFeature(file)]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    // Flat triangles are joined back into the cube's 6 faces.
    expect(r.parts[0].faceGroups).toHaveLength(6);
    expect(analyzeMesh(r.parts[0].vertices, r.parts[0].triangles).volume).toBeCloseTo(8000, 0);
    engine.dispose();

    // Cut the cube out of a bigger block.
    const r2 = build([feature("box", { width: 40, depth: 40, height: 10, x: -10, y: -10 }), importFeature(file, "remove")]);
    expect(r2.featureErrors).toEqual({});
    expect(analyzeMesh(r2.parts[0].vertices, r2.parts[0].triangles).volume).toBeCloseTo(16000 - 4000, 0);
    engine.dispose();

    // In inches, 20 units become 508 mm.
    const r3 = build([importFeature({ ...file, units: "in" })]);
    expect(analyzeMesh(r3.parts[0].vertices, r3.parts[0].triangles).volume).toBeCloseTo(8000 * 25.4 ** 3, -3);
  });

  it("brings separate bodies in an STL in as separate parts, and an open mesh as a surface", () => {
    // A 10 mm cube and a ball 30 mm away, in one STL file.
    build([feature("box", { width: 10, depth: 10, height: 10 }), feature("sphere", { diameter: 8, x: 30 })]);
    const stl = new Uint8Array(engine.exportStl([], "normal").stl);
    engine.dispose();
    let b64 = "";
    for (const x of stl) b64 += String.fromCharCode(x);
    const file = { fileName: "two.stl", format: "stl" as const, data: btoa(b64), units: "mm" as const };
    const r = build([importFeature(file)]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((p) => p.name)).toEqual(["Part 1", "Part 2"]);
    expect(engine.check("normal").parts.every((p) => p.mesh.watertight && p.geometryValid)).toBe(true);
    engine.dispose();
    // Both cut cleanly out of a block (it used to leave a broken, leaky part).
    const block = feature("box", { width: 50, depth: 20, height: 20, x: -5, y: -5, z: -5 });
    const cut = build([block, importFeature(file, "remove")]);
    expect(cut.featureErrors).toEqual({});
    const c = engine.check("normal").parts[0];
    expect(c.mesh.watertight).toBe(true);
    expect(c.exactVolume!).toBeLessThan(20000 - 1000 - 200);
    engine.dispose();
    // A single triangle: an open mesh, so a surface rather than a solid with no inside.
    const tri = "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid t\n";
    const open = build([importFeature({ fileName: "tri.stl", format: "stl", data: btoa(tri), units: "mm" })]);
    expect(open.featureErrors).toEqual({});
    expect(open.parts.map((p) => [p.name, !!p.surface])).toEqual([["Surface 1", true]]);
  });

  it("reads text STL files, and finely curved ones in reasonable time", () => {
    const P = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]];
    const tris = [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]];
    const text = `solid tet\n${tris.map((t) => `facet normal 0 0 0\nouter loop\n${t.map((i) => `vertex ${P[i].join(" ")}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid tet\n`;
    let r = build([importFeature({ fileName: "tet.stl", format: "stl", data: btoa(text), units: "mm" })]);
    expect(r.featureErrors).toEqual({});
    expect(analyzeMesh(r.parts[0].vertices, r.parts[0].triangles).volume).toBeCloseTo(1000 / 6, 1);
    engine.dispose();

    build([feature("sphere", { diameter: 40 })]);
    const stl = new Uint8Array(engine.exportStl([], "coarse").stl);
    engine.dispose();
    let b64 = "";
    for (const x of stl) b64 += String.fromCharCode(x);
    const started = performance.now();
    r = build([importFeature({ fileName: "ball.stl", format: "stl", data: btoa(b64), units: "mm" })]);
    const ms = performance.now() - started;
    expect(r.featureErrors).toEqual({});
    // Generous: shared CI machines vary a lot in speed.
    expect(ms).toBeLessThan(8000);
    expect(relativeError(analyzeMesh(r.parts[0].vertices, r.parts[0].triangles).volume, (4 / 3) * Math.PI * 8000)).toBeLessThan(0.05);
  });

  it("copes with a detailed STL", () => {
    build([feature("sphere", { diameter: 40 })]);
    const out = engine.exportStl([], "fine");
    engine.dispose();
    const stl = new Uint8Array(out.stl);
    let b64 = "";
    for (const x of stl) b64 += String.fromCharCode(x);
    const started = performance.now();
    const r = build([importFeature({ fileName: "ball.stl", format: "stl", data: btoa(b64), units: "mm" })]);
    const first = performance.now() - started;
    const t2 = performance.now();
    engine.rebuild([importFeature({ fileName: "ball.stl", format: "stl", data: btoa(b64), units: "mm" })]);
    const again = performance.now() - t2;
    expect(r.featureErrors).toEqual({});
    expect(out.triangleCount).toBeGreaterThan(20_000);
    // Generous limits for slow CI machines; rebuilding reuses the part and its mesh.
    expect(first).toBeLessThan(60_000);
    expect(again).toBeLessThan(2_000);
  });

  it("explains a damaged file", () => {
    const r = build([importFeature({ fileName: "bad.step", format: "step", data: "ISO-10303-21;\nnonsense", units: "mm" })]);
    expect(Object.values(r.featureErrors)[0]).toMatch(/STEP file/);
    expect(r.parts).toHaveLength(0);
  });
});

describe("part names", () => {
  it("uses names given to parts, in the parts and in STEP files", async () => {
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    engine = new GeometryEngine();
    const r = engine.rebuild([box], {}, { [box.id]: "Bracket" });
    expect(r.parts[0].name).toBe("Bracket");
    const step = new TextDecoder().decode((await engine.exportStep([])).step);
    expect(step).toContain("PRODUCT('Bracket'");
  });
});

describe("several Part Studios", () => {
  it("builds each, and rebuilds only the ones that changed", () => {
    engine = new GeometryEngine();
    const a = feature("box", { width: 10, depth: 10, height: 10 });
    const b = feature("cylinder", { diameter: 10, height: 5 });
    const first = engine.rebuildStudios([
      { id: "main", features: [a] },
      { id: "s2", features: [b] },
    ]);
    expect(first.rebuilt).toEqual(["main", "s2"]);
    expect(first.parts.map((p) => [p.studioId, p.name])).toEqual([
      ["main", "Part 1"],
      ["s2", "Part 1"],
    ]);
    const same = engine.rebuildStudios([
      { id: "main", features: [a] },
      { id: "s2", features: [b] },
    ]);
    expect(same.rebuilt).toEqual([]);
    expect(same.parts).toEqual([]);
    const b2 = { ...b, params: { ...b.params, height: "8" } };
    const changed = engine.rebuildStudios([
      { id: "main", features: [a] },
      { id: "s2", features: [b2] },
    ]);
    expect(changed.rebuilt).toEqual(["s2"]);
    // Checks and exports still see every part.
    expect(engine.check("coarse").parts).toHaveLength(2);
    expect(engine.check("coarse", [b2.id]).parts.map((p) => p.partId)).toEqual([b2.id]);
    // A removed Part Studio's parts go.
    engine.rebuildStudios([{ id: "main", features: [a] }]);
    expect(engine.partCount).toBe(1);
  });

  it("brings a part in from another Part Studio (Derived), and follows changes to it", () => {
    engine = new GeometryEngine();
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    // The studio using the part comes first in the list: it's still built after the one it uses.
    const derived: Feature = { ...feature("derived", { x: 0, y: 0, z: 20 }), derived: { studioId: "s2", partId: box.id } };
    const hole = feature("cylinder", { diameter: 4, height: 40, x: 5, y: 5, z: 0 }, "remove");
    const zs = (m: { vertices: Float32Array | number[] }) => Array.from(m.vertices).filter((_, k) => k % 3 === 2);
    const r = engine.rebuildStudios([
      { id: "main", features: [derived, hole] },
      { id: "s2", features: [box] },
    ]);
    expect(r.featureErrors).toEqual({});
    const mine = r.parts.find((p) => p.studioId === "main")!;
    expect(mine.name).toBe("Part 1");
    expect(Math.min(...zs(mine))).toBeCloseTo(20, 4);
    // Cut in its new home; the original is untouched.
    expect(analyzeMesh(mine.vertices, mine.triangles).volume).toBeCloseTo(1000 - Math.PI * 4 * 10, 0);
    // The original gets taller: the derived part follows.
    const taller = { ...box, params: { ...box.params, height: "15" } };
    const r2 = engine.rebuildStudios([
      { id: "main", features: [derived, hole] },
      { id: "s2", features: [taller] },
    ]);
    expect(r2.rebuilt.sort()).toEqual(["main", "s2"]);
    const mine2 = r2.parts.find((p) => p.studioId === "main")!;
    expect(Math.max(...zs(mine2))).toBeCloseTo(35, 4);
    // Gone, or using each other: said plainly.
    const lost: Feature = { ...derived, derived: { studioId: "s2", partId: "nope" } };
    expect(engine.rebuildStudios([{ id: "main", features: [lost] }, { id: "s2", features: [taller] }]).featureErrors[lost.id]).toMatch(/isn't in its Part Studio/);
    const back: Feature = { ...feature("derived", {}), derived: { studioId: "main", partId: derived.id } };
    const loop = engine.rebuildStudios([{ id: "main", features: [derived] }, { id: "s2", features: [taller, back] }]);
    expect(Object.values(loop.featureErrors).join(" ")).toMatch(/uses parts from this one/);
    // The same on a fresh start (a file just opened), not "deleted".
    engine.dispose();
    engine = new GeometryEngine();
    const fresh = engine.rebuildStudios([{ id: "main", features: [derived] }, { id: "s2", features: [taller, back] }]);
    expect(Object.values(fresh.featureErrors).join(" ")).toMatch(/uses parts from this one/);
    expect(Object.values(fresh.featureErrors).join(" ")).not.toMatch(/deleted/);
  });
});

describe("assembly exports and clashes", () => {
  it("places copies for export, and finds where they overlap", async () => {
    engine = new GeometryEngine();
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    engine.rebuild([box]);
    const turn90z: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const instances = [
      { id: "i1", partId: box.id, name: "Box <1>", position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] },
      // Turned a quarter about Z (now spans x −10…0) and moved 5 along X: overlaps the first by half.
      { id: "i2", partId: box.id, name: "Box <2>", position: [15, 0, 0] as [number, number, number], rotation: turn90z },
      { id: "i3", partId: box.id, name: "Box <3>", position: [100, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] },
    ];
    const clashes = engine.clashes(instances);
    expect(clashes).toHaveLength(1);
    expect(clashes[0].a).toBe("Box <1>");
    expect(clashes[0].b).toBe("Box <2>");
    expect(clashes[0].volume).toBeCloseTo(500, 3);

    const stl = engine.exportStl([], "coarse", instances);
    const { vertices } = readBinaryStl(stl.stl);
    const xs = Array.from(vertices).filter((_, k) => k % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(0, 3);
    expect(Math.max(...xs)).toBeCloseTo(110, 3);
    const step = new TextDecoder().decode((await engine.exportStep([], {}, instances)).step);
    expect(step).toContain("PRODUCT('Box <3>'");
    // The part itself hasn't moved.
    expect(engine.check("coarse").parts).toHaveLength(1);
  });

  it("shows mirrored copies as the part's mirror image", () => {
    engine = new GeometryEngine();
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    engine.rebuild([box]);
    const id: [number, number, number, number] = [0, 0, 0, 1];
    // Mirrored, the box spans x −10…0 instead of 0…10: next to the original, not on it.
    const mirrored = [
      { id: "i1", partId: box.id, name: "Box <1>", position: [0, 0, 0] as [number, number, number], rotation: id },
      { id: "i2", partId: box.id, name: "Box <2>", position: [0, 0, 0] as [number, number, number], rotation: id, mirrored: true },
    ];
    expect(engine.clashes(mirrored)).toHaveLength(0);
    const { vertices } = readBinaryStl(engine.exportStl([], "coarse", mirrored).stl);
    const xs = Array.from(vertices).filter((_, k) => k % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(-10, 3);
  });
});

describe("drawing views", () => {
  it("projects a part from each side, with hidden lines", () => {
    engine = new GeometryEngine();
    // A 40 × 30 × 20 block with a 10 mm blind hole from the top, at x = 10, y = 15.
    const block = feature("box", { width: 40, depth: 30, height: 20 });
    const hole = feature("cylinder", { diameter: 10, height: 15, x: 10, y: 15, z: 10 }, "remove");
    engine.rebuild([block, hole]);
    const [front, top, right, iso] = engine.project([], undefined, ["front", "top", "right", "iso"], true);
    const near = (b: number[] | null, want: number[]) => b!.forEach((v, i) => expect(v).toBeCloseTo(want[i], 3));
    near(front.bounds, [0, 0, 40, 20]);
    near(top.bounds, [0, 0, 40, 30]);
    near(right.bounds, [0, 0, 30, 20]);
    expect(iso.bounds).not.toBeNull();
    // Seen from the top, the hole is a visible circle on the left.
    const c = top.circles.find((x) => !x.hidden && x.full);
    expect(c).toBeDefined();
    expect([c!.cx, c!.cy, c!.r].map((v) => Math.round(v * 1000) / 1000)).toEqual([10, 15, 5]);
    // From the front it's hidden inside: dashed lines between x = 5 and 15, from z = 10 up.
    expect(front.hidden.length).toBeGreaterThan(0);
    const hx = front.hidden.flatMap((l) => l.filter((_, i) => i % 2 === 0));
    expect(Math.min(...hx)).toBeCloseTo(5, 3);
    expect(Math.max(...hx)).toBeCloseTo(15, 3);
    const hy = front.hidden.flatMap((l) => l.filter((_, i) => i % 2 === 1));
    expect(Math.min(...hy)).toBeCloseTo(10, 3);
    // Without hidden lines there are none.
    expect(engine.project([], undefined, ["front"], false)[0].hidden).toEqual([]);
    // The hole's centre line shows from the front (it's upright), not from the top.
    expect(front.axes).toHaveLength(1);
    const [x0, y0, x1, y1] = front.axes![0];
    expect([x0, x1].map((v) => Math.round(v * 1000) / 1000)).toEqual([10, 10]);
    expect([Math.min(y0, y1), Math.max(y0, y1)].map((v) => Math.round(v * 1000) / 1000)).toEqual([10, 20]);
    expect(top.axes).toBeUndefined();
  });

  it("cuts section views through the part along lines drawn on other views", () => {
    const block = feature("box", { width: 40, depth: 30, height: 20 });
    const hole = feature("cylinder", { diameter: 10, height: 15, x: 10, y: 15, z: 10 }, "remove");
    engine.rebuild([block, hole]);
    const area = (t: number[]) => {
      let sum = 0;
      for (let i = 0; i < t.length; i += 6) sum += Math.abs((t[i + 2] - t[i]) * (t[i + 5] - t[i + 1]) - (t[i + 4] - t[i]) * (t[i + 3] - t[i + 1])) / 2;
      return sum;
    };
    const near = (b: number[] | null, want: number[]) => b!.forEach((v, i) => expect(v).toBeCloseTo(want[i], 3));
    // A: across the top view, through the middle (y = 15) — seen like the front view.
    // B: up and down the front view at x = 10 (through the hole's axis) — seen like the right view.
    // C: like A but near the back (y = 27), missing the hole.
    const [top, a, b, c] = engine.project([], undefined, ["top"], true, [
      { key: "section:A", host: "top", a: [0, 0.5], b: [1, 0.5], flip: false },
      { key: "section:B", host: "front", a: [0.25, 0], b: [0.25, 1], flip: false },
      { key: "section:C", host: "top", a: [0, 0.9], b: [1, 0.9], flip: false },
    ]);
    expect([top.kind, a.kind, b.kind, c.kind]).toEqual(["top", "section:A", "section:B", "section:C"]);
    expect(a.hidden).toEqual([]);
    near(a.bounds, [0, 0, 40, 20]);
    // The cut face is the 40 × 20 block less the 10 × 10 slice through the hole.
    expect(area(a.cutFaces!)).toBeCloseTo(700, 1);
    // The cut-open hole still has its centre line.
    expect(a.axes?.length).toBe(1);
    near(b.bounds, [0, 0, 30, 20]);
    expect(area(b.cutFaces!)).toBeCloseTo(600 - 100, 1);
    expect(area(c.cutFaces!)).toBeCloseTo(800, 1);
  });

  it("cuts a broken-out view away to a depth inside a rectangle, hatching the floor of the cut", () => {
    engine.rebuild([feature("box", { width: 40, depth: 30, height: 20 })]);
    // On the front view (40 × 20), the middle half each way, 10 mm deep (the block is 30 deep).
    const [plain] = engine.project([], undefined, ["front"], true);
    expect(plain.depth).toBeCloseTo(30, 6);
    const [cut] = engine.project([], undefined, ["front"], true, [], [{ host: "front", a: [0.25, 0.25], b: [0.75, 0.75], depth: 10 }]);
    expect(cut.bounds).toEqual(plain.bounds);
    expect(cut.breakLines).toHaveLength(1);
    const area = (t: number[]) => {
      let sum = 0;
      for (let i = 0; i < t.length; i += 6) sum += Math.abs((t[i + 2] - t[i]) * (t[i + 5] - t[i + 1]) - (t[i + 4] - t[i]) * (t[i + 3] - t[i + 1])) / 2;
      return sum;
    };
    // The floor of the pocket: 20 × 10.
    expect(area(cut.cutFaces!)).toBeCloseTo(200, 1);
    // The pocket's walls show as more lines.
    expect(cut.visible.length).toBeGreaterThan(plain.visible.length);
  });

  it("draws auxiliary views square-on to a sloping line, without cutting", () => {
    engine.rebuild([feature("box", { width: 40, depth: 30, height: 20 })]);
    // Corner to corner across the front view (40 × 20): the view looks square-on to that diagonal.
    const [aux] = engine.project([], undefined, [], true, [{ key: "section:A", host: "front", a: [0, 0], b: [1, 1], flip: false, aux: true }]);
    expect(aux.kind).toBe("section:A");
    expect(aux.cutFaces).toBeUndefined();
    const [x0, y0, x1, y1] = aux.bounds!;
    // Across: the block's 30 mm depth. Up: the block's outline along the diagonal, 40·cos + 20·sin.
    const t = Math.atan2(20, 40);
    expect(x1 - x0).toBeCloseTo(30, 3);
    expect(y1 - y0).toBeCloseTo(40 * Math.cos(t) + 20 * Math.sin(t), 3);
  });

});

describe("extrude up to a face, and with draft", () => {
  it("extrudes from the sketch up to a parallel face of another part", () => {
    // A 10 mm high slab sits 30 mm up; a 10 × 10 square on Top goes up to its underside (z = 30).
    const slab = feature("box", { width: 40, depth: 40, height: 10, x: -10, y: -10, z: 30 });
    engine = new GeometryEngine();
    const first = engine.rebuild([slab]);
    const p = first.parts[0];
    const under = p.faceRefs.findIndex((f) => f.surface === "PLANE" && f.normal[2] < -0.99);
    const sk = sketchFeature({ kind: "default", name: "Top" }, rectSketch(0, 0, 10, 10));
    const ex = { ...extrudeFeature(sk.id, 5), extrude: { end: "upToFace" as const, flip: false, upTo: { partId: p.id, ref: p.faceRefs[under] } } };
    const r = engine.rebuild([slab, sk, ex]);
    expect(r.featureErrors).toEqual({});
    const peg = r.parts.find((x) => x.id === ex.id)!;
    const a = analyzeMesh(peg.vertices, peg.triangles);
    expect(a.volume).toBeCloseTo(10 * 10 * 30, 1);
    expect(a.bounds?.max[2]).toBeCloseTo(30, 3);
    // A side face isn't parallel to the sketch: explained.
    const side = p.faceRefs.findIndex((f) => f.surface === "PLANE" && Math.abs(f.normal[0]) > 0.99);
    const bad = { ...ex, extrude: { ...ex.extrude, upTo: { partId: p.id, ref: p.faceRefs[side] } } };
    expect(engine.rebuild([slab, sk, bad]).featureErrors[ex.id]).toMatch(/parallel/);
  });

  it("tapers the sides with a draft angle", () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, rectSketch(0, 0, 20, 20));
    const ex = { ...extrudeFeature(sk.id, 10), params: { depth: "10", draft: "10" } };
    const r = build([sk, ex]);
    expect(r.featureErrors).toEqual({});
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(a.watertight).toBe(true);
    // Each side moves in by 10·tan 10° ≈ 1.763 mm by the top: a frustum of a square pyramid.
    const t = 10 * Math.tan((10 * Math.PI) / 180);
    const top = 20 - 2 * t;
    const expected = (10 / 3) * (400 + top * top + 20 * top);
    expect(relativeError(a.volume, expected)).toBeLessThan(0.002);
    expect(a.bounds?.min[0]).toBeCloseTo(0, 3);
    expect(build([sk, { ...ex, params: { depth: "10", draft: "60" } }]).featureErrors[ex.id]).toMatch(/less than 45/);
  });
});

describe("sweep and loft", () => {
  it("lofts between ellipses (and a circle) without cutting them in two", () => {
    // An ellipse long along X at the bottom, one long along Y 20 up: one smooth side, a plain rim top and bottom.
    const low = sketchFeature({ kind: "default", name: "Top" }, addEllipse(emptySketch(), { x: 0, y: 0 }, { x: 10, y: 0 }, [0, 5]).sketch);
    const high = sketchFeature(planeOnFace([0, 0, 1], [0, 0, 20], "up"), addEllipse(emptySketch(), { x: 0, y: 0 }, { x: 6, y: 0 }, [0, 12]).sketch);
    const lo: Feature = { ...feature("loft", {}), sections: [low.id, high.id] };
    const r = build([low, high, lo]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts[0].edgeRefs.map((e) => e.curve)).toEqual(["ELLIPSE", "ELLIPSE"]);
    expect(r.parts[0].faceRefs).toHaveLength(3);
    expect(engine.check("normal").parts[0].geometryValid).toBe(true);
    // A circle up to an ellipse, turned: the same.
    const ring = sketchFeature({ kind: "default", name: "Top" }, addCircle(emptySketch(), { x: 0, y: 0 }, 8).sketch);
    const r2 = build([ring, high, { ...lo, sections: [ring.id, high.id] }]);
    expect(r2.featureErrors).toEqual({});
    expect(r2.parts[0].edgeRefs).toHaveLength(2);
    expect(r2.parts[0].faceRefs).toHaveLength(3);
    // As a surface: one face, two rims.
    const r3 = build([low, high, { ...lo, surface: true }]);
    expect(r3.featureErrors).toEqual({});
    expect(r3.parts[0].faceRefs).toHaveLength(1);
    expect(r3.parts[0].edgeRefs).toHaveLength(2);
  });

  it("sweeps a circle along an L-shaped path into a bent pipe", () => {
    // Path on Top: straight along +X for 40 mm.
    let path = emptySketch();
    path = addLine(path, { x: 0, y: 0 }, { x: 40, y: 0 }).sketch;
    const pathSk = sketchFeature({ kind: "default", name: "Top" }, path);
    // Profile on Right (the YZ plane) at the start of the path: a 6 mm circle round the origin.
    const profile = sketchFeature({ kind: "default", name: "Right" }, addCircle(emptySketch(), { x: 0, y: 0 }, 3).sketch);
    const sweep: Feature = { ...feature("sweep", {}), sketchRef: profile.id, pathRef: pathSk.id };
    const r = build([pathSk, profile, sweep]);
    expect(r.featureErrors).toEqual({});
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(a.watertight).toBe(true);
    expect(relativeError(a.volume, Math.PI * 9 * 40)).toBeLessThan(0.02);
    expect(a.bounds?.max[0]).toBeCloseTo(40, 1);
    // Same sketch for both: explained.
    expect(build([pathSk, { ...sweep, sketchRef: pathSk.id }]).featureErrors[sweep.id]).toMatch(/different sketches/);
  });

  it("lofts from a square on Top to a smaller square higher up", () => {
    const base = sketchFeature({ kind: "default", name: "Top" }, rectSketch(-10, -10, 20, 20));
    const top = sketchFeature(planeOnFace([0, 0, 1], [0, 0, 10], "10 mm up"), rectSketch(-5, -5, 10, 10));
    const loftF: Feature = { ...feature("loft", {}), sections: [base.id, top.id] };
    const r = build([base, top, loftF]);
    expect(r.featureErrors).toEqual({});
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(a.watertight).toBe(true);
    // A straight-sided frustum: h/3 (A1 + A2 + √(A1·A2)).
    expect(relativeError(a.volume, (10 / 3) * (400 + 100 + 200))).toBeLessThan(0.01);
    expect(build([base, { ...loftF, sections: [base.id] }]).featureErrors[loftF.id]).toMatch(/at least two/);
  });
});

describe("text", () => {
  it("makes solid letters, raised or engraved", () => {
    const t: Feature = { ...feature("text", { size: 10, depth: 2, x: 5, y: 5 }), text: { value: "Hi 8", plane: { kind: "default", name: "Top" }, bold: false, flip: false } };
    const r = build([t]);
    expect(r.featureErrors).toEqual({});
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(a.watertight).toBe(true);
    expect(a.bounds?.min[2]).toBeCloseTo(0, 6);
    expect(a.bounds?.max[2]).toBeCloseTo(2, 6);
    expect(a.bounds?.min[0]).toBeGreaterThan(4.9);
    expect(a.volume).toBeGreaterThan(20);
    // Engraved into the top of a block.
    const block = feature("box", { width: 60, depth: 30, height: 10 });
    const cut: Feature = { ...feature("text", { size: 10, depth: 1, x: 5, y: 10 }, "remove"), text: { value: "Hi", plane: planeOnFace([0, 0, 1], [0, 0, 10], "top"), bold: true, flip: true } };
    const e = build([block, cut]);
    expect(e.featureErrors).toEqual({});
    const v = analyzeMesh(e.parts[0].vertices, e.parts[0].triangles).volume;
    expect(v).toBeLessThan(60 * 30 * 10);
    expect(v).toBeGreaterThan(60 * 30 * 10 - 200);
    expect(build([{ ...t, text: { ...t.text!, value: "   " } }]).featureErrors[t.id]).toMatch(/Type some text/);
  });

  it("wraps round a round face, raised or engraved", () => {
    const rod = feature("cylinder", { diameter: 20, height: 30, x: 0, y: 0, z: 0 });
    const first = build([rod]);
    const side = first.parts[0].faceRefs.find((f) => f.kind === "face" && f.surface === "CYLINDRE")!;
    expect(side).toBeTruthy();
    const pick = { partId: rod.id, ref: side };
    const solidVolume = analyzeMesh(first.parts[0].vertices, first.parts[0].triangles).volume;
    const raised: Feature = { ...feature("text", { size: 6, depth: 1, x: 0, y: 0 }, "add"), text: { value: "ROD", plane: null, bold: true, flip: false, face: pick } };
    const r = build([rod, raised]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(a.volume).toBeGreaterThan(solidVolume + 5);
    // The letters stand about 1 mm proud, facing the front (−Y).
    expect(a.bounds!.min[1]).toBeLessThan(-10.5);
    expect(a.bounds!.min[1]).toBeGreaterThan(-11.5);
    expect(a.bounds!.max[1]).toBeLessThan(10.2);
    const engraved: Feature = { ...raised, operation: "remove", text: { ...raised.text!, flip: true } };
    const e = build([rod, engraved]);
    expect(e.featureErrors).toEqual({});
    const v = analyzeMesh(e.parts[0].vertices, e.parts[0].triangles).volume;
    expect(v).toBeLessThan(solidVolume - 5);
    expect(v).toBeGreaterThan(solidVolume - 300);
  });

  it("wraps a sketch's shapes round a round face (Wrap)", () => {
    const rod = feature("cylinder", { diameter: 20, height: 30, x: 0, y: 0, z: 0 });
    const first = build([rod]);
    const side = first.parts[0].faceRefs.find((f) => f.kind === "face" && f.surface === "CYLINDRE")!;
    const solidVolume = analyzeMesh(first.parts[0].vertices, first.parts[0].triangles).volume;
    // An 8 × 4 rectangle, and a small square beside it, drawn anywhere.
    let data = addRectangle(emptySketch(), { x: 100, y: 50 }, { x: 108, y: 54 }).sketch;
    data = addRectangle(data, { x: 110, y: 50 }, { x: 112, y: 52 }).sketch;
    const sk = sketchFeature({ kind: "default", name: "Top" }, data);
    const wrap: Feature = { ...feature("wrap", { depth: 1 }, "add"), sketchRef: sk.id, picks: [{ partId: rod.id, ref: side }] };
    const r = build([rod, sk, wrap]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    // Each shape on a flat patch 1 mm out from the surface where it touches (≈ 41 + 4 mm³), on the side facing the front.
    expect(a.volume).toBeGreaterThan(solidVolume + 35);
    expect(a.volume).toBeLessThan(solidVolume + 55);
    expect(a.bounds!.min[1]).toBeLessThan(-10.5);
    const engraved = build([rod, sk, { ...wrap, operation: "remove" }]);
    expect(engraved.featureErrors).toEqual({});
    // Cut down to a flat 1 mm in (≈ 23 + 4 mm³).
    const cutVolume = solidVolume - analyzeMesh(engraved.parts[0].vertices, engraved.parts[0].triangles).volume;
    expect(cutVolume).toBeGreaterThan(20);
    expect(cutVolume).toBeLessThan(35);
    // A band 40 wide (229° round the 20 mm rod) and 4 tall, raised 1: laid on narrow strips, it hugs the rod —
    // about the volume of that slice of a 1 mm thick ring (½ × 4 rad × (11² − 10²) × 4 = 168 mm³).
    const wide = sketchFeature({ kind: "default", name: "Top" }, addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 40, y: 4 }).sketch);
    const band = build([rod, wide, { ...wrap, sketchRef: wide.id }]);
    expect(band.featureErrors).toEqual({});
    expect(band.parts).toHaveLength(1);
    const bandMesh = analyzeMesh(band.parts[0].vertices, band.parts[0].triangles);
    expect(bandMesh.volume - solidVolume).toBeGreaterThan(150);
    expect(bandMesh.volume - solidVolume).toBeLessThan(190);
    // It stays within 1 mm of the surface all round.
    const radii: number[] = [];
    for (let i = 0; i < band.parts[0].vertices.length; i += 3) radii.push(Math.hypot(band.parts[0].vertices[i], band.parts[0].vertices[i + 1]));
    expect(Math.max(...radii)).toBeLessThan(11.05);
    // More than once round: too wide.
    const tooWide = sketchFeature({ kind: "default", name: "Top" }, addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 70, y: 4 }).sketch);
    expect(build([rod, tooWide, { ...wrap, sketchRef: tooWide.id }]).featureErrors[wrap.id]).toMatch(/too wide/);
    expect(build([rod, sk, { ...wrap, picks: [] }]).featureErrors[wrap.id]).toMatch(/round face/);
  }, 120_000);
});

describe("splines and ellipses", () => {
  it("extrudes an ellipse, turned and tall or wide", () => {
    const turn = Math.PI / 6;
    const el = addEllipse(emptySketch(), { x: 5, y: 0 }, { x: 5 + 20 * Math.cos(turn), y: 20 * Math.sin(turn) }, [5 - 8 * Math.sin(turn), 8 * Math.cos(turn)]);
    expect(el.error).toBe(undefined);
    const sk = sketchFeature({ kind: "default", name: "Top" }, el.sketch);
    const r = build([sk, extrudeFeature(sk.id, 5)]);
    expect(r.featureErrors).toEqual({});
    const a = meshOf(r);
    expect(a.watertight).toBe(true);
    expect(engine.check("normal").parts[0].exactVolume!).toBeCloseTo(Math.PI * 20 * 8 * 5, 1);
    // Width across x: 2·√((20 cos30)² + (8 sin30)²).
    expect(a.bounds!.max[0] - a.bounds!.min[0]).toBeCloseTo(2 * Math.hypot(20 * Math.cos(turn), 8 * Math.sin(turn)), 1);
    // The short axis drawn first works too.
    const tall = addEllipse(emptySketch(), { x: 0, y: 0 }, { x: 4, y: 0 }, [0, 10]);
    const sk2 = sketchFeature({ kind: "default", name: "Front" }, tall.sketch);
    const r2 = build([sk2, extrudeFeature(sk2.id, 2)]);
    expect(r2.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].exactVolume!).toBeCloseTo(Math.PI * 4 * 10 * 2, 1);
  });

  it("extrudes a closed spline", () => {
    const sp = addSpline(emptySketch(), [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 25, y: 15 }, { x: 5, y: 20 }].map((q) => ({ ...q, snap: null })), true);
    const sk = sketchFeature({ kind: "default", name: "Top" }, sp.sketch);
    const r = build([sk, extrudeFeature(sk.id, 3)]);
    expect(r.featureErrors).toEqual({});
    expect(meshOf(r).watertight).toBe(true);
    expect(engine.check("normal").parts[0].geometryValid).toBe(true);
  });
});

describe("parts in other configurations (for assemblies)", () => {
  it("builds a Part Studio again with another configuration's sizes", async () => {
    engine = new GeometryEngine();
    const box = feature("box", { width: "w", depth: 10, height: 10 });
    const r = engine.rebuildStudios(
      [
        { id: "main", features: [box] },
        { id: "main@big", features: [box], variables: { w: 30 }, partSuffix: "@big" },
      ],
      { w: 10 },
    );
    expect(r.featureErrors).toEqual({});
    const plain = r.parts.find((p) => p.id === box.id)!;
    const big = r.parts.find((p) => p.id === `${box.id}@big`)!;
    expect(big.configuration).toBe("big");
    const width = (p: typeof plain) => {
      const a = analyzeMesh(p.vertices, p.triangles);
      return a.bounds!.max[0] - a.bounds!.min[0];
    };
    expect(width(plain)).toBeCloseTo(10, 4);
    expect(width(big)).toBeCloseTo(30, 4);
    // "All parts" (checks, exports, drawings of the Part Studio) means the ordinary ones.
    expect(engine.check("normal").parts.map((p) => p.partId)).toEqual([box.id]);
    // An assembly can place either.
    const step = await engine.exportStep([], undefined, [
      { id: "i1", partId: box.id, name: "Box <1>", position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      { id: "i2", partId: `${box.id}@big`, name: "Box <2>", position: [0, 50, 0], rotation: [0, 0, 0, 1] },
    ]);
    expect(step.partCount).toBe(2);
  });
});

describe("curve pattern", () => {
  it("repeats a feature along a sketched path", () => {
    const plate = feature("box", { width: 100, depth: 100, height: 5, x: 0, y: 0, z: 0 });
    const peg = feature("cylinder", { diameter: 4, height: 10, x: 10, y: 10, z: 5 }, "add");
    const path = addLine(emptySketch(), { x: 10, y: 10 }, { x: 90, y: 10 });
    const bend = addLine(path.sketch, { x: 90, y: 10, snap: { kind: "point", id: path.endId } }, { x: 90, y: 90 });
    const sk = sketchFeature({ kind: "default", name: "Top" }, bend.sketch);
    const pattern: Feature = { ...feature("curvePattern", { count: 5 }), operation: "add", pattern: { sources: [peg.id], axis: "x", flip: false }, pathRef: sk.id };
    const r = build([plate, peg, sk, pattern]);
    expect(r.featureErrors).toEqual({});
    const peg1 = Math.PI * 4 * 10;
    expect(engine.check("normal").parts[0].exactVolume!).toBeCloseTo(100 * 100 * 5 + 5 * peg1, 0);
    // The last peg is at the far end of the path.
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(a.bounds!.max[1]).toBeCloseTo(100, 3);
    const tops: number[] = [];
    const v = r.parts[0].vertices;
    for (let i = 0; i < v.length; i += 3) if (Math.abs(v[i + 2] - 15) < 1e-3) tops.push(v[i + 1]);
    expect(Math.max(...tops)).toBeCloseTo(92, 1);
    // Without a path it says so.
    expect(build([plate, peg, { ...pattern, pathRef: undefined }]).featureErrors[pattern.id]).toMatch(/path/);
  });

  it("follows a spline or a whole circle too", () => {
    const plate = feature("box", { width: 100, depth: 100, height: 5, x: -50, y: -50, z: 0 });
    const peg = feature("cylinder", { diameter: 4, height: 10, x: 30, y: 0, z: 5 }, "add");
    // Around a whole circle: 6 pegs, evenly spaced, all on the circle.
    const ring = sketchFeature({ kind: "default", name: "Top" }, addCircle(emptySketch(), { x: 0, y: 0 }, 30).sketch);
    const round: Feature = { ...feature("curvePattern", { count: 6 }), operation: "add", pattern: { sources: [peg.id], axis: "x", flip: false }, pathRef: ring.id };
    const r = build([plate, peg, ring, round]);
    expect(r.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].exactVolume!).toBeCloseTo(100 * 100 * 5 + 6 * Math.PI * 4 * 10, 0);
    // Along an open spline from the peg.
    const sp = addSpline(emptySketch(), [{ x: 30, y: 0 }, { x: 10, y: 20 }, { x: -20, y: 10 }, { x: -30, y: -30 }].map((q) => ({ ...q, snap: null })), false);
    const wavy = sketchFeature({ kind: "default", name: "Top" }, sp.sketch);
    const along: Feature = { ...round, pathRef: wavy.id, params: { count: "4" } };
    const r2 = build([plate, peg, wavy, along]);
    expect(r2.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].exactVolume!).toBeCloseTo(100 * 100 * 5 + 4 * Math.PI * 4 * 10, 0);
    // The last peg sits on the spline's far end, (−30, −30).
    const v = r2.parts[0].vertices;
    const tops: [number, number][] = [];
    for (let i = 0; i < v.length; i += 3) if (Math.abs(v[i + 2] - 15) < 1e-3) tops.push([v[i], v[i + 1]]);
    expect(Math.min(...tops.map((t) => t[1]))).toBeCloseTo(-32, 1);
  });
});

describe("sweep paths", () => {
  const vol = () => engine.check("normal").parts[0].exactVolume!;
  it("sweeps along a whole circle (a ring), a spline, and from whichever end the profile is at", () => {
    // A 2 mm-radius circle round a 20 mm-radius circle: a torus, 2π·20 · π·2² mm³.
    const ring = sketchFeature({ kind: "default", name: "Top" }, addCircle(emptySketch(), { x: 20, y: 0 }, 20).sketch);
    const prof = sketchFeature({ kind: "default", name: "Front" }, addCircle(emptySketch(), { x: 0, y: 0 }, 2).sketch);
    const torus = build([ring, prof, { ...feature("sweep", {}), sketchRef: prof.id, pathRef: ring.id }]);
    expect(torus.featureErrors).toEqual({});
    expect(vol()).toBeCloseTo(2 * Math.PI * 20 * Math.PI * 4, 0);
    // A line then an arc, with the profile at the line's far end (x = 60): the sweep starts there.
    let d = lineSketch(60, 0, 30, 0);
    d = addArc(d, { x: 30, y: 0 }, { x: 0, y: 30 }, { x: 21.21, y: 21.21 }).sketch;
    const path = sketchFeature({ kind: "default", name: "Top" }, d);
    const end = sketchFeature(planeOnFace([1, 0, 0], [60, 0, 0], "end"), addCircle(emptySketch(), { x: 0, y: 0 }, 2).sketch);
    const fromEnd = build([path, end, { ...feature("sweep", {}), sketchRef: end.id, pathRef: path.id }]);
    expect(fromEnd.featureErrors).toEqual({});
    expect(vol()).toBeCloseTo((30 + (Math.PI / 2) * 30) * Math.PI * 4, -1);
    // Along a spline.
    const sp = addSpline(emptySketch(), [{ x: 0, y: 0 }, { x: 20, y: 10 }, { x: 40, y: 0 }].map((q) => ({ ...q, snap: null })), false);
    const curvy = sketchFeature({ kind: "default", name: "Top" }, sp.sketch);
    const start = sketchFeature({ kind: "default", name: "Right" }, addCircle(emptySketch(), { x: 0, y: 0 }, 2).sketch);
    const r = build([curvy, start, { ...feature("sweep", {}), sketchRef: start.id, pathRef: curvy.id }]);
    expect(r.featureErrors).toEqual({});
    const check = engine.check("normal").parts[0];
    expect(check.geometryValid).toBe(true);
    expect(check.exactVolume!).toBeGreaterThan(40 * Math.PI * 4);
  });
});

describe("sheet metal", () => {
  const vol = () => engine.check("normal").parts[0].exactVolume!;
  const sheet = (sketchRef: string, flipSide = false): Feature => ({
    id: "sm",
    name: "Sheet metal 1",
    type: "sheetMetal",
    operation: "new",
    suppressed: false,
    params: { thickness: "2", radius: "2", kFactor: "0.45" },
    sketchRef,
    ...(flipSide ? { flipSide: true } : {}),
  });

  it("explains what to do when the sketch has overlapping shapes", () => {
    let data = rectSketch(0, 0, 100, 50);
    data = addCircle(data, { x: 100, y: 25 }, 10).sketch;
    const sk = sketchFeature({ kind: "default", name: "Top" }, data);
    const r = build([sk, sheet(sk.id)]);
    expect(r.featureErrors.sm).toMatch(/overlap each other count separately: use Trim/);
  });

  it("still takes flanges after the part is moved or turned, and copies keep their flat pattern", () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, rectSketch(0, 0, 100, 50));
    const plain = build([sk, sheet(sk.id)]);
    const edge = (r: ReturnType<typeof build>, x: number) => r.parts[0].edgeRefs.find((e) => e.kind === "edge" && e.curve === "LINE" && Math.abs(e.a[0] - x) < 1e-6 && Math.abs(e.b[0] - x) < 1e-6 && Math.abs(e.a[2] - 2) < 1e-6)!;
    const flange = (r: ReturnType<typeof build>, x: number): Feature => ({ id: "fl", name: "Flange 1", type: "flange", operation: "add", suppressed: false, params: { length: "30", angle: "90" }, picks: [{ partId: "sm", ref: edge(r, x) }] });
    build([sk, sheet(sk.id), flange(plain, 100)]);
    const expected = vol();
    // Moved 20 along X: its right edge is now at x = 120.
    const mv: Feature = { ...feature("transform", { dx: 20 }, "add"), transform: { partId: "sm", axis: "z", about: "centre", copy: false } };
    const moved = build([sk, sheet(sk.id), mv]);
    const r = build([sk, sheet(sk.id), mv, flange(moved, 120)]);
    expect(r.featureErrors).toEqual({});
    expect(vol()).toBeCloseTo(expected, 1);
    expect(r.parts[0].flat).toBeTruthy();
    // The move doesn't count as something the flat pattern leaves out.
    expect(r.parts[0].flat!.notShown ?? []).toEqual([]);
    // Turned 90° about its centre (50, 25): the old right edge now runs along X at y = 75.
    const turn: Feature = { ...feature("transform", { rz: 90 }, "add"), transform: { partId: "sm", axis: "z", about: "centre", copy: false } };
    const turned = build([sk, sheet(sk.id), turn]);
    const side = turned.parts[0].edgeRefs.find((e) => e.kind === "edge" && e.curve === "LINE" && Math.abs(e.a[1] - 75) < 1e-6 && Math.abs(e.b[1] - 75) < 1e-6 && Math.abs(e.a[2] - 2) < 1e-6)!;
    const r2 = build([sk, sheet(sk.id), turn, { ...flange(turned, 100), picks: [{ partId: "sm", ref: side }] }]);
    expect(r2.featureErrors).toEqual({});
    expect(vol()).toBeCloseTo(expected, 1);
    // A moved copy is sheet metal too.
    const copy = build([sk, sheet(sk.id), { ...mv, transform: { ...mv.transform!, copy: true } }]);
    expect(copy.parts.map((p) => !!p.flat)).toEqual([true, true]);
  });

  it("makes a flat sheet from a sketch, then bends a flange up off a picked edge", () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, rectSketch(0, 0, 100, 50));
    const r1 = build([sk, sheet(sk.id)]);
    expect(r1.featureErrors).toEqual({});
    expect(vol()).toBeCloseTo(100 * 50 * 2, 3);
    // The right-hand edge (x = 100) along the sheet's top face.
    const p = r1.parts[0];
    const ref = p.edgeRefs.find((e) => e.kind === "edge" && e.curve === "LINE" && Math.abs(e.a[0] - 100) < 1e-6 && Math.abs(e.b[0] - 100) < 1e-6 && Math.abs(e.a[2] - 2) < 1e-6)!;
    expect(ref).toBeTruthy();
    const flange: Feature = { id: "fl", name: "Flange 1", type: "flange", operation: "add", suppressed: false, params: { length: "30", angle: "90" }, picks: [{ partId: p.id, ref }] };
    const r2 = build([sk, sheet(sk.id), flange]);
    expect(r2.featureErrors).toEqual({});
    // The plate, a quarter-round bend (radii 2 and 4) and a 26 mm straight wall, all 50 mm long and 2 mm thick.
    expect(vol()).toBeCloseTo(10000 + (Math.PI / 4) * (16 - 4) * 50 + 26 * 50 * 2, 1);
    expect(r2.parts).toHaveLength(1);
    // Its flat pattern: 100 wide plus the bend allowance (π/2 × (2 + 0.45 × 2)) and the 26 mm wall.
    const flat = r2.parts[0].flat!;
    expect(flat.bendLines).toHaveLength(1);
    const xs = flat.outline.map((q) => q[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(100 + (Math.PI / 2) * (2 + 0.45 * 2) + 26, 4);
    expect(flat.notShown).toEqual([]);
    // Laid out flat for the 3D view: as wide as the flat pattern, and still 2 mm thick.
    const flatMesh = engine.unfold(p.id)!;
    expect(flatMesh).toBeTruthy();
    const fx = Array.from(flatMesh.vertices).filter((_, i) => i % 3 === 0);
    const fz = Array.from(flatMesh.vertices).filter((_, i) => i % 3 === 2);
    expect(Math.max(...fx) - Math.min(...fx)).toBeCloseTo(100 + (Math.PI / 2) * (2 + 0.45 * 2) + 26, 3);
    expect(Math.max(...fz) - Math.min(...fz)).toBeCloseTo(2, 6);
    expect(engine.unfold("nowhere")).toBe(null);
    // Shortened by 10 at each end: 30 wide, with a 2 × 2 relief notch (through the 2 mm sheet) beside each end.
    build([sk, sheet(sk.id), { ...flange, params: { length: "30", angle: "90", inset: "10" } }]);
    expect(vol()).toBeCloseTo(10000 - 2 * 8 + (Math.PI / 4) * (16 - 4) * 30 + 26 * 30 * 2, 1);
    // Flanges on the right and top edges with closed corners: the right one laps the top one's end, the top one butts against it.
    const topRef = p.edgeRefs.find((e) => e.kind === "edge" && e.curve === "LINE" && Math.abs(e.a[1] - 50) < 1e-6 && Math.abs(e.b[1] - 50) < 1e-6 && Math.abs(e.a[2] - 2) < 1e-6)!;
    const both: Feature = { ...flange, picks: [{ partId: p.id, ref }, { partId: p.id, ref: topRef }], closeCorners: true };
    const r7 = build([sk, sheet(sk.id), both]);
    expect(r7.featureErrors).toEqual({});
    expect(r7.parts).toHaveLength(1);
    expect(vol()).toBeCloseTo(10000 + (Math.PI / 4) * 12 * (50 + 100) + 26 * 2 * (54 + 102), 1);
    expect(r7.parts[0].flat!.bendLines).toHaveLength(2);
    // The same two flanges with a round corner relief instead: a little less metal, and the flat pattern outlined round it.
    const relieved = build([sk, sheet(sk.id), { ...both, closeCorners: undefined, cornerRelief: "round" }]);
    expect(relieved.featureErrors).toEqual({});
    const withRelief = vol();
    build([sk, sheet(sk.id), { ...both, closeCorners: undefined }]);
    const without = vol();
    expect(withRelief).toBeLessThan(without - 10);
    expect(relieved.parts[0].flat!.boundary?.length).toBeGreaterThan(0);
    // A closed hem on the same edge: a half-turn bend (inside radius 0.05) and an 8 mm lip folded back over the sheet.
    const hem: Feature = { id: "hm", name: "Hem 1", type: "hem", operation: "add", suppressed: false, params: { length: "8", gap: "0", inset: "0" }, picks: [{ partId: p.id, ref }] };
    const r6 = build([sk, sheet(sk.id), hem]);
    expect(r6.featureErrors).toEqual({});
    expect(vol()).toBeCloseTo(10000 + (Math.PI / 2) * (2.05 * 2.05 - 0.05 * 0.05) * 50 + 8 * 50 * 2, 1);
    expect(r6.parts).toHaveLength(1);
    expect(r6.parts[0].flat!.bendLines).toHaveLength(1);
    // A hole drilled through the plate afterwards (a 10 mm cylinder taken away) shows in the flat pattern, round its centre.
    const drill = feature("cylinder", { diameter: 10, height: 20, x: 50, y: 25, z: -5 }, "remove");
    const r4 = build([sk, sheet(sk.id), flange, drill]);
    expect(r4.featureErrors).toEqual({});
    const cut = r4.parts[0].flat!;
    expect(cut.notShown).toEqual([]);
    expect(cut.cuts!.length).toBeGreaterThan(8);
    for (const [a, b] of cut.cuts!) for (const q of [a, b]) expect(Math.hypot(q[0] - 50, q[1] - 25)).toBeCloseTo(5, 1);
    // From an open outline: an L (50 along, then 30 up), 20 deep. Two flats (46 and 26) and a quarter bend.
    let L = addLine(emptySketch(), { x: 0, y: 0, snap: null }, { x: 50, y: 0, snap: null }).sketch;
    L = addLine(L, { x: 50, y: 0, snap: null }, { x: 50, y: 30, snap: null }).sketch;
    const lsk = sketchFeature({ kind: "default", name: "Top" }, L);
    const r5 = build([lsk, { ...sheet(lsk.id), params: { thickness: "2", radius: "2", kFactor: "0.45", depth: "20" } }]);
    expect(r5.featureErrors).toEqual({});
    expect(vol()).toBeCloseTo(20 * 2 * (46 + 26) + (Math.PI / 4) * (16 - 4) * 20, 1);
    expect(r5.parts[0].flat!.bendLines).toHaveLength(1);
    // A tab sketched on the sheet's top face, reaching 20 mm past its right edge: 20 × 30 more sheet, in the flat pattern too.
    const onTop = { kind: "face" as const, origin: [0, 0, 2] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number], label: "Top face" };
    const tsk = sketchFeature(onTop, rectSketch(90, 10, 30, 30));
    const tab: Feature = { id: "tb", name: "Tab 1", type: "tab", operation: "add", suppressed: false, params: {}, sketchRef: tsk.id };
    const r8 = build([sk, sheet(sk.id), tsk, tab]);
    expect(r8.featureErrors).toEqual({});
    expect(r8.parts).toHaveLength(1);
    expect(vol()).toBeCloseTo(10000 + 20 * 30 * 2, 1);
    const tabFlat = r8.parts[0].flat!;
    const tx = tabFlat.boundary!.flat().map((q) => q[0]);
    expect(Math.max(...tx)).toBeCloseTo(120, 2);
    // The line where the tab joins the sheet isn't one to cut.
    expect(tabFlat.boundary!.some(([a, b]) => Math.abs(a[0] - 100) < 1e-3 && Math.abs(b[0] - 100) < 1e-3 && Math.min(a[1], b[1]) >= 10 - 1e-3 && Math.max(a[1], b[1]) <= 40 + 1e-3)).toBe(false);
    // A tab off in mid-air.
    const away = sketchFeature(onTop, rectSketch(200, 10, 10, 10));
    expect(build([sk, sheet(sk.id), away, { ...tab, sketchRef: away.id }]).featureErrors.tb).toMatch(/doesn't touch/);
    // Not a sheet metal part: a clear message.
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const r3 = build([box]);
    const boxEdge = r3.parts[0].edgeRefs.find((e) => e.kind === "edge" && e.curve === "LINE")!;
    expect(build([box, { ...flange, picks: [{ partId: r3.parts[0].id, ref: boxEdge }] }]).featureErrors.fl).toMatch(/isn't a sheet metal part/);
  });
});

describe("surfaces", () => {
  const area = (m: { vertices: Float32Array; triangles: Uint32Array }) => {
    let a = 0;
    const v = m.vertices;
    const t = m.triangles;
    for (let i = 0; i + 2 < t.length; i += 3) {
      const [p, q, r] = [t[i], t[i + 1], t[i + 2]].map((k) => [v[3 * k], v[3 * k + 1], v[3 * k + 2]]);
      const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const w = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
      a += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
    }
    return a;
  };
  /** An open L: along X 20, then up Y 10. */
  const openL = () => {
    let d = addLine(emptySketch(), { x: 0, y: 0 }, { x: 20, y: 0 }).sketch;
    d = addLine(d, { x: 20, y: 0 }, { x: 20, y: 10 }).sketch;
    return d;
  };

  it("extrudes an open outline into a surface, and a closed one into a skin with no ends", () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, openL());
    const ex: Feature = { ...extrudeFeature(sk.id, 5), surface: true };
    const r = build([sk, ex]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0].surface).toBe(true);
    expect(r.parts[0].name).toBe("Surface 1");
    // Two walls: 20 × 5 and 10 × 5, no top or bottom.
    expect(area(r.parts[0])).toBeCloseTo(150, 2);
    expect(r.parts[0].faceRefs).toHaveLength(2);
    const box = sketchFeature({ kind: "default", name: "Top" }, rectSketch(0, 0, 10, 10));
    const skin = build([box, { ...extrudeFeature(box.id, 10), surface: true }]);
    expect(skin.featureErrors).toEqual({});
    expect(area(skin.parts[0])).toBeCloseTo(400, 2);
    // The check says what it is, and it has no volume.
    const c = engine.check("coarse");
    expect(c.parts[0].surface).toBe(true);
    expect(c.parts[0].exactVolume).toBe(0);
    // A solid made afterwards doesn't add to the surface: there's no solid yet.
    const onto = feature("box", { width: 5, depth: 5, height: 5, x: 30 }, "add");
    const later = build([box, { ...extrudeFeature(box.id, 10), surface: true }, onto]);
    expect(later.featureErrors[onto.id]).toMatch(/no part to add to/);
    const fresh = build([box, { ...extrudeFeature(box.id, 10), surface: true }, { ...onto, operation: "new" }]);
    expect(fresh.featureErrors).toEqual({});
    expect(fresh.parts.map((p) => !!p.surface)).toEqual([true, false]);
  });

  it("revolves, sweeps and lofts outlines into surfaces", () => {
    // A line 10 from the axis, spun right round: a tube of radius 10, 20 long (no ends).
    const d = addLine(emptySketch(), { x: 10, y: 0 }, { x: 10, y: 20 }).sketch;
    const sk = sketchFeature({ kind: "default", name: "Front" }, d);
    const rev: Feature = { ...feature("revolve", { angle: 360 }), sketchRef: sk.id, revolve: { axis: "vertical", flip: false }, surface: true };
    const r = build([sk, rev]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts[0].surface).toBe(true);
    expect(area(r.parts[0])).toBeCloseTo(2 * Math.PI * 10 * 20, -1);
    // Loft: two open arcs of different sizes on parallel planes.
    const arcA = sketchFeature({ kind: "default", name: "Top" }, addArc(emptySketch(), { x: -10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 6 }).sketch);
    const arcB = sketchFeature(planeOnFace([0, 0, 1], [0, 0, 20], "up"), addArc(emptySketch(), { x: -20, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 12 }).sketch);
    const lo: Feature = { ...feature("loft", {}), sections: [arcA.id, arcB.id], surface: true };
    const l = build([arcA, arcB, lo]);
    expect(l.featureErrors).toEqual({});
    expect(l.parts[0].surface).toBe(true);
    expect(area(l.parts[0])).toBeGreaterThan(400);
    // Sweep: a line (up Z, on the Right plane at the start of the path) swept along a straight path: a flat strip 40 × 8.
    const prof = sketchFeature({ kind: "default", name: "Right" }, addLine(emptySketch(), { x: 0, y: 0 }, { x: 0, y: 8 }).sketch);
    const path = sketchFeature({ kind: "default", name: "Top" }, addLine(emptySketch(), { x: 0, y: 0 }, { x: 40, y: 0 }).sketch);
    const sw: Feature = { ...feature("sweep", {}), sketchRef: prof.id, pathRef: path.id, surface: true };
    const s = build([prof, path, sw]);
    expect(s.featureErrors).toEqual({});
    expect(s.parts[0].surface).toBe(true);
    expect(area(s.parts[0])).toBeCloseTo(320, 1);
  });

  it("extends a surface past its edges, and splits (trims) one with a plane", () => {
    // A flat wall 20 wide, 5 tall, from a line along X extruded up.
    const sk = sketchFeature({ kind: "default", name: "Top" }, addLine(emptySketch(), { x: 0, y: 0 }, { x: 20, y: 0 }).sketch);
    const wall: Feature = { ...extrudeFeature(sk.id, 5), surface: true };
    const first = build([sk, wall]);
    const p = first.parts[0];
    const topEdge = p.edgeRefs.find((e) => e.curve === "LINE" && Math.abs(e.a[2] - 5) < 1e-6 && Math.abs(e.b[2] - 5) < 1e-6)!;
    expect(topEdge).toBeTruthy();
    const ext: Feature = { ...feature("extendSurface", { distance: 3 }), picks: [{ partId: p.id, ref: topEdge }] };
    const r = build([sk, wall, ext]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0].surface).toBe(true);
    // 20 × 8 now, in one piece (two faces sewn together).
    expect(area(r.parts[0])).toBeCloseTo(160, 2);
    const zs = Array.from(r.parts[0].vertices).filter((_, i) => i % 3 === 2);
    expect(Math.max(...zs)).toBeCloseTo(8, 4);
    expect(analyzeMesh(r.parts[0].vertices, r.parts[0].triangles).pieces).toBe(1);
    // Split the wall at z = 2 with a plane, keeping the top: 20 × 3.
    const split: Feature = { ...feature("split", {}), splitDef: { partId: p.id, plane: planeOnFace([0, 0, 1], [0, 0, 2], "cut"), keep: "front", picking: "plane" } };
    const cut = build([sk, wall, split]);
    expect(cut.featureErrors).toEqual({});
    expect(cut.parts).toHaveLength(1);
    expect(area(cut.parts[0])).toBeCloseTo(60, 2);
    const both = build([sk, wall, { ...split, splitDef: { ...split.splitDef!, keep: "both" } }]);
    expect(both.featureErrors).toEqual({});
    expect(both.parts.map((x) => [!!x.surface, Math.round(area(x))])).toEqual([
      [true, 40],
      [true, 60],
    ]);
    expect(both.parts[1].name).toBe("Surface 1 (cut)");
  });

  it("fills openings, encloses surfaces into a solid, and thickens or offsets a surface", () => {
    const box = sketchFeature({ kind: "default", name: "Top" }, rectSketch(0, 0, 10, 10));
    const skin: Feature = { ...extrudeFeature(box.id, 10), surface: true };
    const first = build([box, skin]);
    const p = first.parts[0];
    // The four edges round the top opening (at z = 10) and the bottom (z = 0).
    const ring = (z: number) => p.edgeRefs.filter((e) => e.curve === "LINE" && Math.abs(e.a[2] - z) < 1e-6 && Math.abs(e.b[2] - z) < 1e-6).map((ref) => ({ partId: p.id, ref }));
    expect(ring(10), JSON.stringify(p.edgeRefs)).toHaveLength(4);
    const top: Feature = { ...feature("fill", {}), picks: ring(10) };
    const bottom: Feature = { ...feature("fill", {}), picks: ring(0) };
    const filled = build([box, skin, top, bottom]);
    expect(filled.featureErrors).toEqual({});
    expect(filled.parts.map((x) => x.name)).toEqual(["Surface 1", "Surface 2", "Surface 3"]);
    expect(area(filled.parts[1])).toBeCloseTo(100, 3);
    // Enclose the three into a 10 mm cube.
    const faceOf = (part: (typeof filled.parts)[number]) => ({ partId: part.id, ref: part.faceRefs[0] });
    const enc: Feature = { ...feature("enclose", {}), picks: filled.parts.map(faceOf) };
    const closed = build([box, skin, top, bottom, enc]);
    expect(closed.featureErrors).toEqual({});
    expect(closed.parts).toHaveLength(1);
    expect(closed.parts[0].surface).toBeUndefined();
    expect(closed.parts[0].name).toBe("Part 1");
    expect(analyzeMesh(closed.parts[0].vertices, closed.parts[0].triangles).volume).toBeCloseTo(1000, 1);
    expect(engine.check("coarse").parts[0].exactVolume).toBeCloseTo(1000, 3);
    // A missing side: can't be enclosed.
    const gap: Feature = { ...enc, picks: [faceOf(filled.parts[0]), faceOf(filled.parts[1])] };
    expect(build([box, skin, top, bottom, gap]).featureErrors[gap.id]).toMatch(/gap/);
    // Thicken the open skin 1 mm outwards: a 12 × 12 × 10 box less the 10 × 10 × 10 inside.
    const thick: Feature = { ...feature("thicken", { thickness: 1 }, "new"), picks: [faceOf(p)] };
    const t = build([box, skin, thick]);
    expect(t.featureErrors).toEqual({});
    expect(t.parts).toHaveLength(1);
    expect(t.parts[0].surface).toBeUndefined();
    // The skin's faces point inwards here, so 1 mm in: 10 × 10 × 10 less the 8 × 8 × 10 inside. Flipped, outwards: 12 × 12 × 10 less 10 × 10 × 10.
    const thickCheck = engine.check("coarse").parts[0];
    expect(thickCheck.geometryValid).toBe(true);
    expect(thickCheck.exactVolume!).toBeCloseTo(360, 3);
    expect(thickCheck.mesh.watertight).toBe(true);
    build([box, skin, { ...thick, flipSide: true }]);
    expect(engine.check("coarse").parts[0].exactVolume!).toBeCloseTo(440, 3);
    // Offset the skin 2 mm: a 14 × 14 (or, the other way, 6 × 6) skin, 10 tall, as another surface; minus goes the other way.
    const off: Feature = { ...feature("offsetSurface", { distance: 2 }), picks: [faceOf(p)] };
    const o = build([box, skin, off]);
    expect(o.featureErrors).toEqual({});
    expect(o.parts).toHaveLength(2);
    expect(o.parts[1].surface).toBe(true);
    const a1 = area(o.parts[1]);
    const back = area(build([box, skin, { ...off, params: { distance: "-2" } }]).parts[1]);
    const [small, big] = [a1, back].sort((x, y) => x - y);
    expect(small).toBeCloseTo(240, 0);
    // Outwards the corners are rounded off, so a little under 4 × 14 × 10.
    expect(big).toBeGreaterThan(500);
    expect(big).toBeLessThan(561);
  });

  it("thickens open and curved surfaces into real solids, either side", () => {
    // A flat wall 20 × 5 → a 20 × 5 × 1 slab.
    const sk = sketchFeature({ kind: "default", name: "Top" }, lineSketch(0, 0, 20, 0));
    const wall: Feature = { ...extrudeFeature(sk.id, 5), surface: true };
    const w = build([sk, wall]).parts[0];
    const pick = { partId: w.id, ref: w.faceRefs[0] };
    const slab = build([sk, wall, { ...feature("thicken", { thickness: 1 }, "new"), picks: [pick] }]);
    expect(slab.featureErrors).toEqual({});
    expect(slab.parts.map((p) => [p.name, !!p.surface, p.faceRefs.length])).toEqual([["Part 1", false, 6]]);
    expect(engine.check("coarse").parts[0].exactVolume).toBeCloseTo(100, 3);
    expect(engine.check("coarse").parts[0].mesh.watertight).toBe(true);
    // A round skin (radius 10, 20 tall) → a tube 1 mm thick, one way or the other.
    const c = sketchFeature({ kind: "default", name: "Top" }, addCircle(emptySketch(), { x: 0, y: 0 }, 10).sketch);
    const skin: Feature = { ...extrudeFeature(c.id, 20), surface: true };
    const cp = { partId: skin.id, ref: build([c, skin]).parts[0].faceRefs[0] };
    const tube = build([c, skin, { ...feature("thicken", { thickness: 1 }, "new"), picks: [cp] }]);
    expect(tube.featureErrors).toEqual({});
    expect(tube.parts[0].faceRefs).toHaveLength(4);
    const v1 = engine.check("coarse").parts[0].exactVolume!;
    build([c, skin, { ...feature("thicken", { thickness: 1 }, "new"), picks: [cp], flipSide: true }]);
    const v2 = engine.check("coarse").parts[0].exactVolume!;
    expect([v1, v2].sort((a, b) => a - b).map((v) => Math.round(v))).toEqual([Math.round(Math.PI * (100 - 81) * 20), Math.round(Math.PI * (121 - 100) * 20)]);
    // Added onto a solid: the tube fuses with a block under it.
    const block = feature("box", { width: 10, depth: 10, height: 10, x: -5, y: -5, z: -10 });
    const onto = build([block, c, skin, { ...feature("thicken", { thickness: 1 }, "add"), picks: [cp] }]);
    expect(onto.featureErrors).toEqual({});
    expect(onto.parts.map((p) => [p.name, !!p.surface])).toEqual([["Part 1", false], ["Surface 1", true]]);
    expect(engine.check("coarse").parts[0].exactVolume).toBeCloseTo(1000 + v1, 1);
    // A closed skin (a ball): plus is outwards whichever way its faces point.
    const arc = sketchFeature({ kind: "default", name: "Front" }, addArc(emptySketch(), { x: 0, y: -10 }, { x: 0, y: 10 }, { x: 10, y: 0 }).sketch);
    const ball: Feature = { ...feature("revolve", { angle: 360 }), sketchRef: arc.id, revolve: { axis: "vertical", flip: false }, surface: true };
    const bp = { partId: ball.id, ref: build([arc, ball]).parts[0].faceRefs[0] };
    build([arc, ball, { ...feature("thicken", { thickness: 1 }, "new"), picks: [bp] }]);
    expect(engine.check("coarse").parts[0].exactVolume).toBeCloseTo((4 / 3) * Math.PI * (1331 - 1000), 1);
    build([arc, ball, { ...feature("thicken", { thickness: 1 }, "new"), picks: [bp], flipSide: true }]);
    expect(engine.check("coarse").parts[0].exactVolume).toBeCloseTo((4 / 3) * Math.PI * (1000 - 729), 1);
    // Two separate walls in one surface: both thickened.
    let two = lineSketch(0, 0, 20, 0);
    two = addLine(two, { x: 0, y: 30 }, { x: 20, y: 30 }).sketch;
    const tw = sketchFeature({ kind: "default", name: "Top" }, two);
    const pair: Feature = { ...extrudeFeature(tw.id, 5), surface: true };
    const pp = { partId: pair.id, ref: build([tw, pair]).parts[0].faceRefs[0] };
    expect(build([tw, pair, { ...feature("thicken", { thickness: 1 }, "new"), picks: [pp] }]).featureErrors).toEqual({});
    expect(engine.check("coarse").parts[0].exactVolume).toBeCloseTo(200, 3);
  });

  it("moves, copies, mirrors, patterns, rounds and trims surfaces like parts", () => {
    let l = lineSketch(0, 0, 20, 0);
    l = addLine(l, { x: 20, y: 0 }, { x: 20, y: 10 }).sketch;
    const sk = sketchFeature({ kind: "default", name: "Top" }, l);
    const wall: Feature = { ...extrudeFeature(sk.id, 5), surface: true };
    const first = build([sk, wall]);
    const p = first.parts[0];
    // Move it 10 along X; a copy is another surface.
    const mv: Feature = { ...feature("transform", { dx: 10 }, "add"), transform: { partId: wall.id, axis: "z", about: "centre", copy: false } };
    const moved = build([sk, wall, mv]);
    expect(moved.featureErrors).toEqual({});
    expect(Math.min(...Array.from(moved.parts[0].vertices).filter((_, i) => i % 3 === 0))).toBeCloseTo(10, 4);
    const copied = build([sk, wall, { ...mv, transform: { ...mv.transform!, copy: true } }]);
    expect(copied.featureErrors).toEqual({});
    expect(copied.parts.map((x) => [x.name, !!x.surface])).toEqual([["Surface 1", true], ["Surface 1 (copy)", true]]);
    // Mirror across the Right plane (x = 0): twice the skin, one surface.
    const mi: Feature = { ...feature("mirror", {}, "add"), mirror: { sources: [wall.id], plane: { kind: "default", name: "Right" } } };
    const mirrored = build([sk, wall, mi]);
    expect(mirrored.featureErrors).toEqual({});
    expect(mirrored.parts).toHaveLength(1);
    expect(area(mirrored.parts[0])).toBeCloseTo(300, 2);
    // Three in a row along Y.
    const lp: Feature = { ...feature("linearPattern", { count: 3, spacing: 10 }, "add"), pattern: { sources: [wall.id], axis: "y", flip: false } };
    const row = build([sk, wall, lp]);
    expect(row.featureErrors).toEqual({});
    expect(area(row.parts[0])).toBeCloseTo(450, 2);
    // Round the corner where the two walls meet (radius 2): the corner strip replaced by a quarter round.
    const corner = p.edgeRefs.find((e) => e.kind === "edge" && Math.abs(e.mid[0] - 20) < 1e-6 && Math.abs(e.mid[1]) < 1e-6)!;
    const rounded = build([sk, wall, { ...feature("fillet", { radius: 2 }, "add"), picks: [{ partId: wall.id, ref: corner }] }]);
    expect(rounded.featureErrors).toEqual({});
    expect(rounded.parts[0].surface).toBe(true);
    expect(area(rounded.parts[0])).toBeCloseTo(150 - 4 * 5 + Math.PI * 5, 1);
    const bevelled = build([sk, wall, { ...feature("chamfer", { distance: 2 }, "add"), picks: [{ partId: wall.id, ref: corner }] }]);
    expect(bevelled.featureErrors).toEqual({});
    expect(area(bevelled.parts[0])).toBeCloseTo(150 - 4 * 5 + Math.SQRT2 * 2 * 5, 1);
    // Delete face takes a face out of a surface; booleans and Shell say surfaces have no inside.
    const side = p.faceRefs.find((f) => Math.abs(f.center[0] - 20) < 1e-6)!;
    const fewer = build([sk, wall, { ...feature("deleteFace", {}), picks: [{ partId: wall.id, ref: side }] }]);
    expect(fewer.featureErrors).toEqual({});
    expect(area(fewer.parts[0])).toBeCloseTo(100, 2);
    const box = feature("box", { width: 10, depth: 10, height: 10, y: -5 });
    const union: Feature = { ...feature("boolean", {}), booleanDef: { op: "union", targets: [wall.id, box.id], tools: [], keepTools: false } };
    expect(build([sk, wall, box, union]).featureErrors[union.id]).toMatch(/Surface 1 is a surface/);
    const shell: Feature = { ...feature("shell", { thickness: 1 }, "remove"), picks: [{ partId: wall.id, ref: side }] };
    expect(build([sk, wall, shell]).featureErrors[shell.id]).toMatch(/Use Thicken/);
    // Fill needs a closed ring.
    const topEdge = p.edgeRefs.find((e) => e.kind === "edge" && Math.abs(e.mid[2] - 5) < 1e-6)!;
    const gap: Feature = { ...feature("fill", {}), picks: [{ partId: wall.id, ref: topEdge }] };
    expect(build([sk, wall, gap]).featureErrors[gap.id]).toMatch(/gap/);
  });

  it("splits a part, or a surface, with a surface", () => {
    // A 20 × 20 × 20 block, and a curved surface (an arc bulging up to z = 14 at the middle) extruded right through it along Y.
    const block = feature("box", { width: 20, depth: 20, height: 20 });
    const arcSk = sketchFeature({ kind: "default", name: "Front" }, addArc(emptySketch(), { x: -5, y: 10 }, { x: 25, y: 10 }, { x: 10, y: 14 }).sketch);
    const curve: Feature = { ...extrudeFeature(arcSk.id, 50, { end: "symmetric" }), surface: true };
    const first = build([block, arcSk, curve]);
    expect(first.featureErrors).toEqual({});
    expect(first.parts.map((p) => [p.name, !!p.surface])).toEqual([["Part 1", false], ["Surface 1", true]]);
    const split: Feature = { ...feature("split", {}), splitDef: { partId: block.id, toolPartId: curve.id, plane: { kind: "default", name: "Top" }, keep: "both", picking: "plane" } };
    const both = build([block, arcSk, curve, split]);
    expect(both.featureErrors).toEqual({});
    expect(both.parts.map((p) => [p.name, !!p.surface])).toEqual([["Part 1", false], ["Surface 1", true], ["Part 2", false]]);
    const vols = engine.check("coarse").parts.filter((p) => !p.surface).map((p) => p.exactVolume!);
    expect(vols[0] + vols[1]).toBeCloseTo(8000, 2);
    // The top piece is the smaller: the arc sits above z = 10.
    expect(Math.min(...vols)).toBeLessThan(3200);
    expect(Math.max(...vols)).toBeGreaterThan(4800);
    // One side only: a single part, the surface left alone.
    const top = build([block, arcSk, curve, { ...split, splitDef: { ...split.splitDef!, keep: "front" } }]);
    const bottom = build([block, arcSk, curve, { ...split, splitDef: { ...split.splitDef!, keep: "back" } }]);
    expect(top.parts.map((p) => p.name)).toEqual(["Part 1", "Surface 1"]);
    expect(bottom.parts.map((p) => p.name)).toEqual(["Part 1", "Surface 1"]);
    const sideVols = [0, 0];
    build([block, arcSk, curve, { ...split, splitDef: { ...split.splitDef!, keep: "front" } }]);
    sideVols[0] = engine.check("coarse").parts[0].exactVolume!;
    build([block, arcSk, curve, { ...split, splitDef: { ...split.splitDef!, keep: "back" } }]);
    sideVols[1] = engine.check("coarse").parts[0].exactVolume!;
    expect(sideVols[0] + sideVols[1]).toBeCloseTo(8000, 2);
    expect(sideVols[0]).not.toBe(sideVols[1]);
    // A surface that stops short can't split.
    const short: Feature = { ...extrudeFeature(arcSk.id, 10, { end: "symmetric" }), surface: true };
    const stops = build([block, arcSk, short, { ...split, splitDef: { ...split.splitDef!, toolPartId: short.id } }]);
    expect(stops.featureErrors[split.id]).toMatch(/doesn't go right through/);
    // A surface split by a surface: a flat wall (x = 0..20, 20 tall) cut by the same arc into two skins.
    const wallSk = sketchFeature({ kind: "default", name: "Top" }, lineSketch(0, 10, 20, 10));
    const wall: Feature = { ...extrudeFeature(wallSk.id, 20), surface: true };
    const skins = build([wallSk, wall, arcSk, curve, { ...split, splitDef: { ...split.splitDef!, partId: wall.id } }]);
    expect(skins.featureErrors).toEqual({});
    expect(skins.parts.map((p) => [p.name, !!p.surface])).toEqual([["Surface 1", true], ["Surface 2", true], ["Surface 1 (cut)", true]]);
    expect(area(skins.parts[0]) + area(skins.parts[2])).toBeCloseTo(400, 1);
    // Can't split with a solid, or with itself.
    const solidTool = build([block, arcSk, curve, { ...split, splitDef: { ...split.splitDef!, partId: curve.id, toolPartId: block.id } }]);
    expect(solidTool.featureErrors[split.id]).toMatch(/is a solid/);
  });

  it("sweeps ruled strips from edges, straight or tilted", () => {
    // The top edges of a 10 mm cube, swept 5 up (square to Top): four walls, one surface.
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const p = build([box]).parts[0];
    const top = p.edgeRefs.filter((e) => e.kind === "edge" && Math.abs(e.mid[2] - 10) < 1e-6).map((ref) => ({ partId: box.id, ref }));
    expect(top).toHaveLength(4);
    const ruled: Feature = { ...feature("ruled", { distance: 5, angle: 0 }), picks: top, neutral: { kind: "default", name: "Top" } };
    const r = build([box, ruled]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((x) => [x.name, !!x.surface])).toEqual([["Part 1", false], ["Surface 1", true]]);
    expect(area(r.parts[1])).toBeCloseTo(200, 2);
    expect(Math.max(...Array.from(r.parts[1].vertices).filter((_, i) => i % 3 === 2))).toBeCloseTo(15, 4);
    expect(analyzeMesh(r.parts[1].vertices, r.parts[1].triangles).pieces).toBe(1);
    // Flipped: down into the cube, to z = 5.
    const down = build([box, { ...ruled, flipSide: true }]);
    expect(Math.min(...Array.from(down.parts[1].vertices).filter((_, i) => i % 3 === 2))).toBeCloseTo(5, 4);
    // Tilted 45°: each strip leans over, 5 long, so it rises 5 cos 45°.
    const tilted = build([box, { ...ruled, params: { distance: "5", angle: "45" } }]);
    expect(tilted.featureErrors).toEqual({});
    expect(Math.max(...Array.from(tilted.parts[1].vertices).filter((_, i) => i % 3 === 2))).toBeCloseTo(10 + 5 * Math.SQRT1_2, 3);
    // One edge along the direction can't be tilted.
    const upright = p.edgeRefs.find((e) => e.kind === "edge" && Math.abs(e.a[2] - e.b[2]) > 1)!;
    const bad: Feature = { ...ruled, params: { distance: "5", angle: "30" }, picks: [{ partId: box.id, ref: upright }] };
    expect(build([box, bad]).featureErrors[bad.id]).toMatch(/runs along the direction/);
    // Edges of a surface work too, and the strip is a surface that can be thickened.
    const sk = sketchFeature({ kind: "default", name: "Top" }, addArc(emptySketch(), { x: -10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }).sketch);
    const curve: Feature = { ...extrudeFeature(sk.id, 5), surface: true };
    const cp = build([sk, curve]).parts[0];
    const rim = cp.edgeRefs.find((e) => e.kind === "edge" && e.curve === "CIRCLE" && Math.abs(e.mid[2] - 5) < 1e-6)!;
    const strip: Feature = { ...feature("ruled", { distance: 4, angle: 0 }), picks: [{ partId: curve.id, ref: rim }], neutral: { kind: "default", name: "Top" } };
    const rs = build([sk, curve, strip]);
    expect(rs.featureErrors).toEqual({});
    expect(area(rs.parts[1])).toBeCloseTo(Math.PI * 10 * 4, 0);
  });

  it("thickens a revolved skin whose faces meet at an awkward angle (rounding the join)", () => {
    // An arc closed by its chord, spun round a construction line 5 mm to one side: a curved face meeting a
    // cylinder at a corner. Sharp-cornered offsetting fails on this, so the join is rounded instead.
    let d = addLine(emptySketch(), { x: -5, y: -15 }, { x: -5, y: 15 }).sketch;
    d = { ...d, curves: d.curves.map((c) => ({ ...c, construction: true })) };
    d = addArc(d, { x: 0, y: -10 }, { x: 0, y: 10 }, { x: 10, y: 0 }).sketch;
    d = addLine(d, { x: 0, y: 10 }, { x: 0, y: -10 }).sketch;
    const sk = sketchFeature({ kind: "default", name: "Front" }, d);
    const rev: Feature = { ...feature("revolve", { angle: 360 }), sketchRef: sk.id, revolve: { axis: d.curves[0].id, flip: false }, surface: true };
    const first = build([sk, rev]);
    expect(first.featureErrors).toEqual({});
    expect(first.parts[0].faceRefs).toHaveLength(2);
    const th: Feature = { ...feature("thicken", { thickness: 1 }, "new"), picks: [{ partId: rev.id, ref: first.parts[0].faceRefs[0] }] };
    const r = build([sk, rev, th]);
    expect(r.featureErrors).toEqual({});
    const check = engine.check("coarse").parts[0];
    expect(check.geometryValid).toBe(true);
    expect(check.exactVolume!).toBeGreaterThan(1000);
    expect(check.mesh.watertight).toBe(true);
  });

  it("draws a surface in drawing views, including section views", () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, addArc(emptySketch(), { x: -10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }).sketch);
    build([sk, { ...extrudeFeature(sk.id, 20), surface: true }]);
    const [front, cut] = engine.project([], undefined, ["front"], true, [{ key: "section:A", host: "front", a: [0, 0.5], b: [1, 0.5], flip: false }]);
    expect(front.visible.length).toBeGreaterThan(0);
    // Cut half way up: the arc that's left, seen from above.
    expect(cut.kind).toBe("section:A");
    expect(cut.bounds).not.toBeNull();
    expect(cut.visible.length + cut.circles.length).toBeGreaterThan(0);
  });

  it("exports surfaces to STEP and reads them back as surfaces", async () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, addArc(emptySketch(), { x: -10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }).sketch);
    const half: Feature = { ...extrudeFeature(sk.id, 20), surface: true };
    const box = feature("box", { width: 5, depth: 5, height: 5, x: 30 });
    build([sk, half, box]);
    const { step, partCount } = await engine.exportStep([]);
    expect(partCount).toBe(2);
    const imp: Feature = { ...feature("import", {}), import: { fileName: "s.step", format: "step", data: new TextDecoder().decode(step), units: "mm" } };
    const r = build([imp]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((p) => [p.name, !!p.surface])).toEqual([["Part 1", false], ["Surface 1", true]]);
    expect(area(r.parts[1])).toBeCloseTo(Math.PI * 10 * 20, 0);
    // Surfaces alone come in too, but can't be added to a part.
    build([sk, half]);
    const only = new TextDecoder().decode((await engine.exportStep([])).step);
    const alone = build([{ ...imp, import: { ...imp.import!, data: only } }]);
    expect(alone.parts.map((p) => [p.name, !!p.surface])).toEqual([["Surface 1", true]]);
    const onto: Feature = { ...feature("import", {}, "add"), import: { ...imp.import!, data: only } };
    expect(build([box, onto]).featureErrors[onto.id]).toMatch(/only surfaces/);
  });
});
