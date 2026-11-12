/**
 * Boundary surface and Face blend against the real OpenCascade engine: the boundary goes exactly through its curves
 * and meets a neighbouring face smoothly when asked; the face blend between two faces at 90° is the fillet of the same
 * radius, works between separate parts and surfaces (trimmed and joined), rings round a boss, and refuses plainly.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeLine, makePolygon, makeThreePointArc, assembleWire, measureArea, measureDistanceBetween, measureVolume, type Face, type Shape3D } from "replicad";
import { GeometryEngine } from "../src/kernel/engine";
import { boundarySurface } from "../src/kernel/boundary";
import { faceBlend } from "../src/kernel/faceBlend";
import { edgesOf, facesOf } from "../src/kernel/topology";
import type { Feature } from "../src/model/types";
import type { TopoPick } from "../src/geometry/topoRef";
import { addArc, addLine } from "../src/sketch/ops";
import type { SketchPlane } from "../src/sketch/planes";
import { emptySketch } from "../src/sketch/types";
import { extrudeFeature, feature, loadOpenCascade, sketchFeature } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());
function build(features: Feature[]) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features);
}
const shapeOf = (id: string): Shape3D => (engine as unknown as { parts: { id: string; shape: Shape3D }[] }).parts.find((p) => p.id === id)!.shape;
const top: SketchPlane = { kind: "default", name: "Top" };
const front: SketchPlane = { kind: "default", name: "Front" };
type Vec3 = [number, number, number];

/** A face of a built part whose centre is at `c` (within 1e-6 on the given axes). */
function faceAt(r: ReturnType<typeof build>, partId: string, test: (c: Vec3) => boolean): TopoPick {
  const part = r.parts.find((p) => p.id === partId)!;
  const ref = part.faceRefs.find((f) => test(f.center as Vec3));
  if (!ref) throw new Error("no such face");
  return { partId, ref };
}

describe("Face blend", () => {
  it("between two faces of a block at 90° is the fillet of the same radius", () => {
    const box = feature("box", { width: 20, depth: 10, height: 10 });
    const r0 = build([box]);
    const topFace = faceAt(r0, box.id, (c) => Math.abs(c[2] - 10) < 1e-6);
    const side = faceAt(r0, box.id, (c) => Math.abs(c[0] - 20) < 1e-6);
    const blend: Feature = { ...feature("faceBlend", { radius: 2 }), picks: [topFace], blend: { side2: [side] } };
    const r = build([box, blend]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    const blended = measureVolume(shapeOf(box.id));
    // The same edge filleted.
    const edge = r0.parts[0].edgeRefs.find((e) => e.kind === "edge" && Math.abs(e.mid[0] - 20) < 1e-6 && Math.abs(e.mid[2] - 10) < 1e-6)!;
    const fillet: Feature = { ...feature("fillet", { radius: 2 }), picks: [{ partId: box.id, ref: edge }] };
    build([box, fillet]);
    expect(blended).toBeCloseTo(measureVolume(shapeOf(box.id)), 6);
    expect(blended).toBeCloseTo(2000 - (4 - Math.PI) * 10, 4);
    // Not trimmed: the blend on its own, a quarter cylinder's surface (π r / 2 × 10).
    const alone = build([box, { ...blend, blend: { side2: [side], noTrim: true } }]);
    expect(alone.featureErrors).toEqual({});
    expect(alone.parts.map((p) => !!p.surface)).toEqual([false, true]);
    expect(measureArea(shapeOf(blend.id))).toBeCloseTo(Math.PI * 10, 4);
    expect(measureVolume(shapeOf(box.id))).toBeCloseTo(2000, 6);
    // Flipping a side where the faces meet isn't offered.
    expect(build([box, { ...blend, blend: { side2: [side], flip1: true } }]).featureErrors[blend.id]).toMatch(/flipping a side doesn't apply/);
  });

  it("rolls between faces of two separate parts (a floor and a wall), and round a boss", () => {
    const floor = feature("box", { width: 30, depth: 10, height: 2, z: -2 });
    const wall = feature("box", { width: 2, depth: 10, height: 20, x: 10 });
    const r0 = build([floor, wall]);
    expect(r0.parts).toHaveLength(2);
    const floorTop = faceAt(r0, floor.id, (c) => Math.abs(c[2]) < 1e-6);
    const wallSide = faceAt(r0, wall.id, (c) => Math.abs(c[0] - 10) < 1e-6);
    const blend: Feature = { ...feature("faceBlend", { radius: 3 }), picks: [floorTop], blend: { side2: [wallSide] } };
    const r = build([floor, wall, blend]);
    expect(r.featureErrors).toEqual({});
    expect(r.featureWarnings?.[blend.id]).toMatch(/Solid parts' faces are left as they are/);
    expect(r.parts).toHaveLength(3);
    expect(measureArea(shapeOf(blend.id))).toBeCloseTo((Math.PI * 3 * 10) / 2, 4);
    // It touches both faces exactly.
    const faces = facesOf(shapeOf(blend.id));
    expect(measureDistanceBetween(faces[0], facesOf(shapeOf(floor.id)).find((f) => Math.abs(f.center.z) < 1e-6)!)).toBeLessThan(1e-5);
    // A ring round a boss standing on a plate: an inside fillet's area, 2π(π/2 r (R + r) − r²).
    const plate = feature("box", { width: 40, depth: 40, height: 2, x: -20, y: -20, z: -2 });
    const boss = feature("cylinder", { diameter: 10, height: 10 });
    const p0 = build([plate, boss]);
    const plateTop = faceAt(p0, plate.id, (c) => Math.abs(c[2]) < 1e-6);
    const round = p0.parts.find((p) => p.id === boss.id)!.faceRefs.find((f) => f.kind === "face" && f.surface === "CYLINDRE")!;
    const ring: Feature = { ...feature("faceBlend", { radius: 2 }), picks: [plateTop], blend: { side2: [{ partId: boss.id, ref: round }] } };
    const pr = build([plate, boss, ring]);
    expect(pr.featureErrors).toEqual({});
    expect(measureArea(shapeOf(ring.id))).toBeCloseTo(2 * Math.PI * ((Math.PI / 2) * 2 * 7 - 4), 2);
  });

  it("trims two surfaces back where it touches them and joins them into one", () => {
    // A floor (y −5…5, x 0…30 at z 0) and a wall at x = 10 (z 0…20).
    const fl = sketchFeature(front, addLine(emptySketch(), { x: 0, y: 0 }, { x: 30, y: 0 }).sketch);
    const floor: Feature = { ...extrudeFeature(fl.id, 10, { end: "symmetric" }), surface: true };
    const wl = sketchFeature(top, addLine(emptySketch(), { x: 10, y: -5 }, { x: 10, y: 5 }).sketch);
    const wall: Feature = { ...extrudeFeature(wl.id, 20), surface: true };
    const r0 = build([fl, floor, wl, wall]);
    expect(r0.featureErrors).toEqual({});
    const blend: Feature = {
      ...feature("faceBlend", { radius: 3 }),
      picks: [{ partId: floor.id, ref: r0.parts.find((p) => p.id === floor.id)!.faceRefs[0] }],
      blend: { side2: [{ partId: wall.id, ref: r0.parts.find((p) => p.id === wall.id)!.faceRefs[0] }] },
    };
    const r = build([fl, floor, wl, wall, blend]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0].surface).toBe(true);
    // One side of the floor (17 × 10 on the far side of the wall, or 7 × 10 on the near side), the wall above the
    // blend (17 × 10) and the blend between; flipping the wall's side puts the ball on the other side.
    const quarter = (Math.PI * 3 * 10) / 2;
    const first = measureArea(shapeOf(blend.id));
    expect(facesOf(shapeOf(blend.id))).toHaveLength(3);
    const far = Math.abs(first - (170 + 170 + quarter)) < 0.01;
    if (!far) expect(first).toBeCloseTo(70 + 170 + quarter, 2);
    const flipped = build([fl, floor, wl, wall, { ...blend, blend: { ...blend.blend!, flip2: true } }]);
    expect(flipped.featureErrors).toEqual({});
    expect(flipped.parts).toHaveLength(1);
    expect(measureArea(shapeOf(blend.id))).toBeCloseTo((far ? 70 : 170) + 170 + quarter, 2);
  });

  it("refuses plainly when a ball of that size can't touch both", () => {
    // Two plates 10 apart, facing each other: a ball of radius 2 can't touch both.
    const a = feature("box", { width: 10, depth: 10, height: 2, z: -2 });
    const b = feature("box", { width: 10, depth: 10, height: 2, z: 10 });
    const r0 = build([a, b]);
    const blend: Feature = {
      ...feature("faceBlend", { radius: 2 }),
      picks: [faceAt(r0, a.id, (c) => Math.abs(c[2]) < 1e-6)],
      blend: { side2: [faceAt(r0, b.id, (c) => Math.abs(c[2] - 10) < 1e-6)] },
    };
    expect(build([a, b, blend]).featureErrors[blend.id]).toMatch(/can't roll touching both sides/);
    expect(build([a, b, { ...blend, blend: { side2: [] } }]).featureErrors[blend.id]).toMatch(/side 2/);
  });

  it("finds the ball's side by itself, and a flip that leaves nothing to touch is refused", () => {
    const floor = makePolygon([[0, 0, 0], [30, 0, 0], [30, 10, 0], [0, 10, 0]]) as Face;
    const wall = makePolygon([[10, 0, 0], [10, 10, 0], [10, 10, 20], [10, 0, 20]]) as Face;
    const made = faceBlend([floor], [wall], 3);
    expect(made.pieces).toHaveLength(1);
    expect(measureArea(made.pieces[0].shape)).toBeCloseTo((Math.PI * 3 * 10) / 2, 4);
    // On the other side of the wall (x < 10) the ball touches too.
    const other = faceBlend([floor], [wall], 3, false, true);
    const box = other.pieces[0].shape.boundingBox;
    expect(box.bounds[1][0]).toBeLessThan(10 + 1e-6);
    expect(() => faceBlend([floor], [wall], 3, true, false)).toThrow(/flipped/);
  });
});

describe("Boundary surface", () => {
  it("goes exactly through the four edges of a curved patch", () => {
    // A curved patch's edges: two arcs (U) and two lines (V).
    const a0: Vec3 = [0, 0, 0], am: Vec3 = [5, 0, 3], a1: Vec3 = [10, 0, 0];
    const b0: Vec3 = [0, 10, 0], bm: Vec3 = [5, 10, 5], b1: Vec3 = [10, 10, 0];
    const edges = [makeThreePointArc(a0, am, a1), makeThreePointArc(b0, bm, b1), makeLine(a0, b0), makeLine(a1, b1)];
    const wires = edges.map((e) => assembleWire([e]));
    const s = boundarySurface(wires.map((wire) => ({ wire })), 2, 2);
    for (const e of edges) expect(measureDistanceBetween(e, s)).toBeLessThan(1e-4);
    // Between them it sags no lower than the patch's sides and rises no higher than its crown.
    const box = s.boundingBox;
    expect(box.bounds[0][2]).toBeGreaterThan(-1e-3);
    expect(box.bounds[1][2]).toBeLessThan(5 + 1e-2);
    expect(measureArea(s)).toBeGreaterThan(100);
    // Two opposite curves only: joined by straight lines, the same patch.
    const two = boundarySurface(wires.slice(0, 2).map((wire) => ({ wire })), 2, 0);
    expect(measureArea(two)).toBeCloseTo(measureArea(s), 1);
  });

  it("meets the face beside a part's edge smoothly when asked", () => {
    // A wall (x = 0, z 0…10) and a line at x = 10 on the ground: from the wall's top edge down to the line.
    const wall = makePolygon([[0, 0, 0], [0, 10, 0], [0, 10, 10], [0, 0, 10]]) as Face;
    const topEdge = edgesOf(wall).find((e) => Math.abs(e.startPoint.z - 10) < 1e-9 && Math.abs(e.endPoint.z - 10) < 1e-9)!;
    const ground = makeLine([10, 0, 0], [10, 10, 0]);
    const plain = boundarySurface([{ wire: assembleWire([topEdge]) }, { wire: assembleWire([ground]) }], 2, 0);
    const smooth = boundarySurface([{ wire: assembleWire([topEdge]), face: wall, match: "tangent" }, { wire: assembleWire([ground]) }], 2, 0);
    const normalNear = (s: Shape3D) => {
      const f = facesOf(s)[0];
      const n = f.normalAt([0.01, 5, 10]);
      return [n.x, n.y, n.z];
    };
    // Plain: a flat slope at 45°. Smooth: leaving the wall straight up, so square to x there, like the wall.
    expect(Math.abs(normalNear(plain)[0])).toBeCloseTo(Math.SQRT1_2, 3);
    expect(Math.abs(normalNear(smooth)[0])).toBeGreaterThan(0.99);
    expect(measureDistanceBetween(topEdge, smooth)).toBeLessThan(1e-4);
    expect(measureDistanceBetween(ground, smooth)).toBeLessThan(1e-4);
    // Matching curvature too: still through both, still leaving the wall straight up.
    const curved = boundarySurface([{ wire: assembleWire([topEdge]), face: wall, match: "curvature" }, { wire: assembleWire([ground]) }], 2, 0);
    expect(Math.abs(normalNear(curved)[0])).toBeGreaterThan(0.99);
    expect(measureDistanceBetween(topEdge, curved)).toBeLessThan(1e-4);
  });

  it("is built from part edges, curves and sketches in the engine, as a new surface part", () => {
    // A curved strip (an arc on Top pushed up 10) and a boundary through its top arc and a sketch's arc below it.
    const arc = sketchFeature(top, addArc(emptySketch(), { x: 10, y: 0 }, { x: -10, y: 0 }, { x: 0, y: 10 }).sketch);
    const strip: Feature = { ...extrudeFeature(arc.id, 10), surface: true };
    const r0 = build([arc, strip]);
    const p = r0.parts[0];
    const topArc = p.edgeRefs.find((e) => e.kind === "edge" && e.curve === "CIRCLE" && Math.abs(e.mid[2] - 10) < 1e-6)!;
    const low = sketchFeature(front, addLine(emptySketch(), { x: -10, y: 20 }, { x: 10, y: 20 }).sketch);
    const b: Feature = { ...feature("boundary", {}), boundary: { u: [{ edge: { partId: strip.id, ref: topArc }, match: "tangent" }, { sketch: low.id }], v: [] } };
    const r = build([arc, strip, low, b]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((x) => !!x.surface)).toEqual([true, true]);
    expect(r.parts[1].name).toBe("Surface 2");
    // Refusals in plain words.
    expect(build([arc, strip, low, { ...b, boundary: { u: [{ sketch: low.id, match: "tangent" }], v: [{ sketch: arc.id }] } }]).featureErrors[b.id]).toMatch(/can't close|only for part edges/);
    expect(build([arc, strip, low, { ...b, boundary: { u: [{ sketch: low.id }], v: [] } }]).featureErrors[b.id]).toMatch(/at least two/);
  });
});
