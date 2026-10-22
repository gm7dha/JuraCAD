/**
 * Engine tests, part 1: basic shapes, sketches, fillets, holes and other part features.
 * Runs the real OpenCascade engine (in Node) against reference models and
 * checks volumes, positions and soundness. Shared set-up: tests/support/engineHelpers.ts.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { analyzeMesh } from "../src/geometry/meshCheck";
import type { TopoPick } from "../src/geometry/topoRef";
import { readBinaryStl } from "../src/geometry/stl";
import { GeometryEngine } from "../src/kernel/engine";
import type { Feature, Operation } from "../src/model/types";
import { defaultAxis } from "../src/sketch/axis";
import { addArc, addCircle, addLine, addPoint, addRectangle } from "../src/sketch/ops";
import { holeVolume, type HoleSize } from "../src/model/holes";
import { matchingConnectors } from "../src/assembly/connectors";
import { planeOnFace } from "../src/sketch/planes";
import { emptySketch } from "../src/sketch/types";
import { loadOpenCascade, feature, sketchFeature, extrudeFeature, nextId, relativeError, rectSketch, lineSketch, meshOf } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine = new GeometryEngine();
  return engine.rebuild(features);
}

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
    const bad = [
      feature("box", { width: -5 }),
      feature("cylinder", {}, "add"),
      feature("sphere", { diameter: "abc" }),
    ];
    const r = build(bad);
    expect(r.parts).toHaveLength(0);
    expect(Object.keys(r.featureErrors)).toHaveLength(3);
    expect(r.featureErrors[bad[0].id]).toMatch(/Width/);
    expect(r.featureErrors[bad[1].id]).toMatch(/no part to add to/);
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
    const box = feature("box", { width: 40, depth: 30, height: 20 });
    build([
      box,
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

    const firstOnly = engine.exportStl([box.id], "normal");
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
    const n = nextId();
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
