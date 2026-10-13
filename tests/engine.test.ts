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
import { addArc, addCircle, addLine, addRectangle } from "../src/sketch/ops";
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
    expect(volumeOf(back)).toBeCloseTo(30 * 20 * 10 - Math.PI * 16 * 10, 2);
  });

  it("refuses to export an empty model", async () => {
    build([]);
    await expect(engine.exportStep([])).rejects.toThrow(/nothing to export/);
  });
});
