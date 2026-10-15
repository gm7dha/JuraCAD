/**
 * Runs the real OpenCascade engine (in Node) against reference models and
 * checks volumes, positions and soundness. This is how we catch the
 * geometry going wrong when code changes.
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { analyzeMesh } from "../src/geometry/meshCheck";
import type { TopoPick } from "../src/geometry/topoRef";
import { readBinaryStl } from "../src/geometry/stl";
import { GeometryEngine } from "../src/kernel/engine";
import { defaultParams } from "../src/model/features";
import type { Feature, FeatureType, Operation } from "../src/model/types";
import { defaultAxis } from "../src/sketch/axis";
import { addArc, addCircle, addLine, addPoint, addRectangle } from "../src/sketch/ops";
import { holeVolume, type HoleSize } from "../src/model/holes";
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
    const none = shellFeature(2, []);
    expect(build([box, none]).featureErrors[none.id]).toMatch(/Click the face/);
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
    const r = build([box, transformFeature(box.id, {}, { angle: 90 })]);
    const b = boundsOfPart(r);
    // 10 wide × 20 deep becomes 20 wide × 10 deep, still centred on (5, 10).
    expect(b.max[0] - b.min[0]).toBeCloseTo(20, 4);
    expect(b.max[1] - b.min[1]).toBeCloseTo(10, 4);
    expect((b.max[0] + b.min[0]) / 2).toBeCloseTo(5, 4);
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
});
