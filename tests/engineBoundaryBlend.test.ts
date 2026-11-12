/**
 * Boundary surface and Face blend against the real OpenCascade engine: the boundary goes exactly through its curves
 * and meets a neighbouring face smoothly when asked; the face blend between two faces at 90° is the fillet of the same
 * radius, works between separate parts and surfaces (trimmed and joined), rings round a boss, and refuses plainly.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getOC, makeLine, makePolygon, makeThreePointArc, assembleWire, measureArea, measureDistanceBetween, measureVolume, type Face, type Shape3D } from "replicad";
import { GeometryEngine } from "../src/kernel/engine";
import { boundarySurface } from "../src/kernel/boundary";
import { faceBlend, nearestOnFace } from "../src/kernel/faceBlend";
import { interpolatedEdge } from "../src/kernel/curves";
import { edgesOf, facesOf, shellsOf } from "../src/kernel/topology";
import type { Feature } from "../src/model/types";
import type { TopoPick } from "../src/geometry/topoRef";
import { addArc, addCircle, addLine } from "../src/sketch/ops";
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

/**
 * How a surface leaves an edge through `at`: the direction across it there (from the end of its v range nearest `at`)
 * and how much it bends that way (1 / radius), from points a little way in.
 */
function leaving(s: Shape3D, at: Vec3): { dir: Vec3; bend: number } {
  const f = facesOf(s)[0];
  const P = (u: number, v: number): Vec3 => {
    const p = f.pointOnSurface(u, v);
    return [p.x, p.y, p.z];
  };
  const d = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  // Which parameter runs across the edge, and from which end: the end whose middle is at the edge.
  const ends: [number, number, (t: number) => [number, number]][] = [
    [0.5, 0, (t) => [0.5, t]],
    [0.5, 1, (t) => [0.5, 1 - t]],
    [0, 0.5, (t) => [t, 0.5]],
    [1, 0.5, (t) => [1 - t, 0.5]],
  ];
  const [, , walk] = ends.map((e) => ({ e, g: d(P(e[0], e[1]), at) })).sort((a, b) => a.g - b.g)[0].e;
  const at0 = P(...walk(0));
  const h = 0.003;
  const p1 = P(...walk(h));
  const p2 = P(...walk(2 * h));
  const l = d(p1, at0) || 1;
  const dir: Vec3 = [(p1[0] - at0[0]) / l, (p1[1] - at0[1]) / l, (p1[2] - at0[2]) / l];
  // Curvature of the circle through the three points.
  const a = d(at0, p1), b = d(p1, p2), c = d(at0, p2);
  const u: Vec3 = [p1[0] - at0[0], p1[1] - at0[1], p1[2] - at0[2]];
  const w: Vec3 = [p2[0] - at0[0], p2[1] - at0[1], p2[2] - at0[2]];
  const cr = Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]);
  return { dir, bend: (2 * cr) / (a * b * c) };
}

/** The farthest a curve strays from a surface, at 400 places along it. */
function gapAlong(e: { pointAt(t: number): { x: number; y: number; z: number } }, s: Shape3D): number {
  const faces = facesOf(s);
  let worst = 0;
  for (let k = 0; k <= 400; k++) {
    const v = e.pointAt(k / 400);
    const p: Vec3 = [v.x, v.y, v.z];
    let best = Infinity;
    for (const f of faces) {
      const q = nearestOnFace(f, p);
      if (q) best = Math.min(best, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

/** A curved wall: an arc of radius 20 round (0, 10) on the ground, from (−14.1…, 24.1…) over (0, 30) to (14.1…, 24.1…), 10 high. */
function boundaryWall(): Shape3D {
  const c = 20 * Math.SQRT1_2;
  const arc = makeThreePointArc([-c, 10 + c, 0], [0, 30, 0], [c, 10 + c, 0]);
  const up = arc.clone().translate([0, 0, 10]);
  const wire0 = assembleWire([arc]);
  const wire1 = assembleWire([up as typeof arc]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const loft = new oc.BRepOffsetAPI_ThruSections(false, true, 1e-6);
  loft.AddWire(wire0.wrapped);
  loft.AddWire(wire1.wrapped);
  loft.Build();
  const out = facesOf({ wrapped: loft.Shape() })[0] as unknown as Shape3D;
  loft.delete();
  return out;
}

/** Is a surface sound (OpenCascade's check) and one piece? */
function soundSurface(s: Shape3D): boolean {
  const oc = getOC() as unknown as { BRepCheck_Analyzer: new (s: unknown, a: boolean, b: boolean, c: boolean) => { IsValid(): boolean; delete(): void } };
  const a = new oc.BRepCheck_Analyzer(s.wrapped, true, false, false);
  const ok = a.IsValid();
  a.delete();
  return ok && shellsOf(s).length === 1;
}

/** How many edges of a surface are used just once by its faces (its open rim; a round face's seam is used twice). */
function freeEdgeCount(s: Shape3D): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const seen: { e: unknown; n: number }[] = [];
  const ex = new oc.TopExp_Explorer(s.wrapped, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (; ex.More(); ex.Next()) {
    const e = ex.Current();
    const hit = seen.find((x) => (x.e as { IsSame(o: unknown): boolean }).IsSame(e));
    if (hit) hit.n++;
    else seen.push({ e, n: 1 });
  }
  ex.delete();
  return seen.filter((x) => x.n === 1).length;
}

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
    expect(r.featureNotes?.[blend.id]).toMatch(/from inside the corner/);
    // A face of the other side that meets none of side 1's is left out, and said so.
    const bottom = faceAt(r0, box.id, (c) => Math.abs(c[2]) < 1e-6);
    const mixed = build([box, { ...blend, blend: { side2: [side, bottom] } }]);
    expect(mixed.featureErrors).toEqual({});
    expect(mixed.featureWarnings?.[blend.id]).toMatch(/1 of the picked faces? doesn't meet the other side along an edge, so it was left out/);
    expect(measureVolume(shapeOf(box.id))).toBeCloseTo(2000 - (4 - Math.PI) * 10, 4);
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

  it("trims a floor and a tube standing on it, on either side of the tube, into one sound surface", () => {
    const fl = sketchFeature(front, addLine(emptySketch(), { x: -30, y: 0 }, { x: 30, y: 0 }).sketch);
    const floor: Feature = { ...extrudeFeature(fl.id, 60, { end: "symmetric" }), surface: true };
    const ring = sketchFeature(top, addCircle(emptySketch(), { x: 0, y: 0 }, 10).sketch);
    const tube: Feature = { ...extrudeFeature(ring.id, 15), surface: true };
    const r0 = build([fl, floor, ring, tube]);
    const blend: Feature = {
      ...feature("faceBlend", { radius: 2 }),
      picks: [{ partId: floor.id, ref: r0.parts.find((p) => p.id === floor.id)!.faceRefs[0] }],
      blend: { side2: [{ partId: tube.id, ref: r0.parts.find((p) => p.id === tube.id)!.faceRefs[0] }] },
    };
    // Outside the tube: the floor keeps all but a disc of radius 12, the tube all above z = 2; the blend a quarter-round
    // ring 2πr((R + r)π/2 − r). Inside (flipped): the floor keeps a disc of radius 8; the ring is 2πr((R − r)π/2 + r).
    const outside = 3600 - Math.PI * 144 + 2 * Math.PI * 10 * 13 + 2 * Math.PI * 2 * (12 * (Math.PI / 2) - 2);
    const inside = Math.PI * 64 + 2 * Math.PI * 10 * 13 + 2 * Math.PI * 2 * (8 * (Math.PI / 2) + 2);
    const areas: number[] = [];
    const opens: number[] = [];
    for (const flip2 of [false, true]) {
      const r = build([fl, floor, ring, tube, { ...blend, blend: { ...blend.blend!, ...(flip2 ? { flip2 } : {}) } }]);
      expect(r.featureErrors).toEqual({});
      expect(r.featureWarnings?.[blend.id]).toBeUndefined();
      expect(r.parts).toHaveLength(1);
      const s = shapeOf(blend.id);
      expect(soundSurface(s)).toBe(true);
      // Open only round the floor's outside (4 edges; inside the tube the floor's disc is joined all round) and the
      // tube's top circle.
      const open = freeEdgeCount(s);
      expect([5, 1]).toContain(open);
      opens.push(open);
      expect(r.featureNotes?.[blend.id]).toMatch(/The ball rolls .* Tick Flip/);
      areas.push(measureArea(s));
    }
    // One of each: the bigger surface (outside) is the one open round the floor's 4 edges too.
    expect([...opens].sort()).toEqual([1, 5]);
    const big = areas[0] > areas[1] ? 0 : 1;
    expect(opens[big]).toBe(5);
    // (Within 0.3%: the round cuts and the blend are fitted through points.)
    expect(Math.abs(areas[big] / outside - 1)).toBeLessThan(3e-3);
    expect(Math.abs(areas[1 - big] / inside - 1)).toBeLessThan(3e-3);
  });

  it("won't leave a surface invalid or a sliver: a half tube on a floor gets the blend on its own, with a note", () => {
    const fl = sketchFeature(front, addLine(emptySketch(), { x: -30, y: 0 }, { x: 30, y: 0 }).sketch);
    const floor: Feature = { ...extrudeFeature(fl.id, 60, { end: "symmetric" }), surface: true };
    const half = sketchFeature(top, addArc(emptySketch(), { x: 10, y: 0 }, { x: -10, y: 0 }, { x: 0, y: 10 }).sketch);
    const strip: Feature = { ...extrudeFeature(half.id, 15), surface: true };
    const r0 = build([fl, floor, half, strip]);
    const blend: Feature = {
      ...feature("faceBlend", { radius: 2 }),
      picks: [{ partId: floor.id, ref: r0.parts.find((p) => p.id === floor.id)!.faceRefs[0] }],
      blend: { side2: [{ partId: strip.id, ref: r0.parts.find((p) => p.id === strip.id)!.faceRefs[0] }] },
    };
    for (const flip2 of [false, true]) {
      const r = build([fl, floor, half, strip, { ...blend, blend: { ...blend.blend!, ...(flip2 ? { flip2 } : {}) } }]);
      expect(r.featureErrors).toEqual({});
      expect(r.featureWarnings?.[blend.id]).toMatch(/couldn't be trimmed cleanly/);
      // The floor and the strip are left whole; the blend is a sound surface of its own.
      expect(r.parts).toHaveLength(3);
      expect(measureArea(shapeOf(floor.id))).toBeCloseTo(3600, 3);
      expect(soundSurface(shapeOf(blend.id))).toBe(true);
    }
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

  it("carries the face on past its edge (tangent), and bends with it too (curvature), on a long edge as well", () => {
    for (const L of [10, 40]) {
      // A wall (x = 0, z 0…10, L long) and a line on the ground at x = 10: from the wall's top edge down to the line.
      const wall = makePolygon([[0, 0, 0], [0, L, 0], [0, L, 10], [0, 0, 10]]) as Face;
      const topEdge = edgesOf(wall).find((e) => Math.abs(e.startPoint.z - 10) < 1e-9 && Math.abs(e.endPoint.z - 10) < 1e-9)!;
      const ground = makeLine([10, 0, 0], [10, L, 0]);
      const make = (match?: "tangent" | "curvature") =>
        boundarySurface([{ wire: assembleWire([topEdge]), ...(match ? { face: wall, match } : {}) }, { wire: assembleWire([ground]) }], 2, 0);
      const plain = make();
      const smooth = make("tangent");
      const curved = make("curvature");
      // Plain: a flat slope at 45°, leaving the edge down and out.
      expect(leaving(plain, [0, L / 2, 10]).dir[2]).toBeLessThan(-0.7);
      for (const s of [smooth, curved]) {
        // Smooth: it carries the wall on — straight up out of the edge — then over to the line; never back over the wall.
        const { dir } = leaving(s, [0, L / 2, 10]);
        expect(dir[2]).toBeGreaterThan(0.99);
        const box = s.boundingBox;
        expect(box.bounds[1][2]).toBeGreaterThan(10.5);
        expect(box.bounds[0][0]).toBeGreaterThan(-0.05);
        expect(box.bounds[0][2]).toBeGreaterThan(-1e-4);
        expect(measureDistanceBetween(topEdge, s)).toBeLessThan(1e-4);
        expect(measureDistanceBetween(ground, s)).toBeLessThan(1e-4);
      }
      // Straight V sides can't leave the wall going up as well: refused in plain words.
      const sides = [makeLine([0, 0, 10], [10, 0, 0]), makeLine([0, L, 10], [10, L, 0])].map((e) => ({ wire: assembleWire([e]) }));
      expect(() => boundarySurface([{ wire: assembleWire([topEdge]), face: wall, match: "tangent" }, { wire: assembleWire([ground]) }, ...sides], 2, 2)).toThrow(/V curves must leave/);
      // Curvature: the wall is flat, so it starts off without bending; tangent alone bends at once.
      expect(leaving(curved, [0, L / 2, 10]).bend).toBeLessThan(0.02);
      expect(leaving(smooth, [0, L / 2, 10]).bend).toBeGreaterThan(0.05);
    }
  });

  it("keeps exactly to its curves between samples too: a spline opposite, V curves; a curve with a corner is refused", () => {
    // A curved wall (an arc on Top, radius 20, pushed up 10) whose top arc is the smooth side; opposite, a wavy spline.
    const wallShape = boundaryWall();
    const topArc = edgesOf(wallShape).find((e) => e.geomType === "CIRCLE" && Math.abs(e.startPoint.z - 10) < 1e-9)!;
    const wall = facesOf(wallShape)[0];
    const wavy = interpolatedEdge([[-14, 30, 0], [-6, 34, 1.5], [0, 36, 0], [6, 33, -1], [14, 30, 0]], false);
    for (const match of ["tangent", "curvature"] as const) {
      const s = boundarySurface([{ wire: assembleWire([topArc]), face: wall, match }, { wire: assembleWire([wavy]) }], 2, 0);
      expect(gapAlong(topArc, s)).toBeLessThan(1e-4);
      expect(gapAlong(wavy, s)).toBeLessThan(1e-4);
    }
    // A flat wall's top edge with V curves leaving it upward (quarter circles) over to a line at x = 10, z = 20.
    const flat = makePolygon([[0, 0, 0], [0, 10, 0], [0, 10, 10], [0, 0, 10]]) as Face;
    const top = edgesOf(flat).find((e) => Math.abs(e.startPoint.z - 10) < 1e-9 && Math.abs(e.endPoint.z - 10) < 1e-9)!;
    const high = makeLine([10, 0, 20], [10, 10, 20]);
    const r = 10 * (1 - Math.SQRT1_2);
    const sides = [0, 10].map((y) => makeThreePointArc([0, y, 10], [r, y, 10 + 10 * Math.SQRT1_2], [10, y, 20]));
    const withSides = boundarySurface([{ wire: assembleWire([top]), face: flat, match: "tangent" }, { wire: assembleWire([high]) }, ...sides.map((e) => ({ wire: assembleWire([e]) }))], 2, 2);
    for (const e of [top, high, ...sides]) expect(gapAlong(e, withSides)).toBeLessThan(1e-4);
    expect(leaving(withSides, [0, 5, 10]).dir[2]).toBeGreaterThan(0.99);
    // Two straight lines with a corner, opposite the smooth edge: refused plainly.
    const bent = assembleWire([makeLine([10, 0, 0], [12, 5, 0]), makeLine([12, 5, 0], [10, 10, 0])]);
    expect(() => boundarySurface([{ wire: assembleWire([top]), face: flat, match: "tangent" }, { wire: bent }], 2, 0)).toThrow(/sharp corner/);
  });

  it("carries a curved face on, and its bend too with curvature", () => {
    // A quarter-round roof (an arc on Front, centre the origin, radius 10, from x = 10 up to the top at x = 0), 10 deep;
    // a boundary from its top edge (x = 0, z = 10) to a line on the ground at x = −40.
    const arc = sketchFeature(front, addArc(emptySketch(), { x: 10, y: 0 }, { x: 0, y: 10 }, { x: 10 * Math.SQRT1_2, y: 10 * Math.SQRT1_2 }).sketch);
    const roof: Feature = { ...extrudeFeature(arc.id, 10, { end: "symmetric" }), surface: true };
    const r0 = build([arc, roof]);
    const topEdge = r0.parts[0].edgeRefs.find((e) => e.kind === "edge" && e.curve === "LINE" && Math.abs(e.mid[2] - 10) < 1e-6 && Math.abs(e.mid[0]) < 1e-6)!;
    const ground = sketchFeature(top, addLine(emptySketch(), { x: -40, y: -5 }, { x: -40, y: 5 }).sketch);
    const b = (match: "tangent" | "curvature"): Feature => ({ ...feature("boundary", {}), id: `b_${match}`, boundary: { u: [{ edge: { partId: roof.id, ref: topEdge }, match }, { sketch: ground.id }], v: [] } });
    const tangent = build([arc, roof, ground, b("tangent")]);
    expect(tangent.featureErrors).toEqual({});
    const t = leaving(shapeOf("b_tangent"), [0, 0, 10]);
    // Leaving the roof's top level, going −x (on past the top, away from the roof).
    expect(t.dir[0]).toBeLessThan(-0.99);
    const curvature = build([arc, roof, ground, b("curvature")]);
    expect(curvature.featureErrors).toEqual({});
    const c = leaving(shapeOf("b_curvature"), [0, 0, 10]);
    expect(c.dir[0]).toBeLessThan(-0.99);
    // Bending down like the roof (radius 10: 0.1 per mm), unlike the tangent one.
    expect(Math.abs(c.bend - 0.1)).toBeLessThan(0.01);
    expect(Math.abs(t.bend - 0.1)).toBeGreaterThan(0.05);
    expect(curvature.featureNotes?.["b_curvature"]).toMatch(/bending with the face that's curved beside U curve 1/);
  });

  it("uses the face asked for at a solid's edge (either face beside it), and says which", () => {
    // A block's top-right edge (x = 20, z = 10, along y), and a line on the ground at x = 30.
    const box = feature("box", { width: 20, depth: 10, height: 10 });
    const r0 = build([box]);
    const edge = r0.parts[0].edgeRefs.find((e) => e.kind === "edge" && Math.abs(e.mid[0] - 20) < 1e-6 && Math.abs(e.mid[2] - 10) < 1e-6)!;
    const ground = sketchFeature(top, addLine(emptySketch(), { x: 30, y: 0 }, { x: 30, y: 10 }).sketch);
    const b = (otherFace: boolean): Feature => ({ ...feature("boundary", {}), id: "bb", boundary: { u: [{ edge: { partId: box.id, ref: edge }, match: "tangent", ...(otherFace ? { otherFace } : {}) }, { sketch: ground.id }], v: [] } });
    const first = build([box, ground, b(false)]);
    expect(first.featureErrors).toEqual({});
    const d1 = leaving(shapeOf("bb"), [20, 5, 10]).dir;
    const n1 = first.featureNotes?.bb ?? "";
    const second = build([box, ground, b(true)]);
    expect(second.featureErrors).toEqual({});
    const d2 = leaving(shapeOf("bb"), [20, 5, 10]).dir;
    const n2 = second.featureNotes?.bb ?? "";
    // One carries the top on (+x, level), the other the side on (straight up); the notes name them.
    const flat = (d: number[]) => d[0] > 0.99;
    const up = (d: number[]) => d[2] > 0.99;
    expect((flat(d1) && up(d2)) || (up(d1) && flat(d2))).toBe(true);
    expect(flat(d1) ? n1 : n2).toMatch(/face facing up/);
    expect(up(d1) ? n1 : n2).toMatch(/face facing \+X/);
    expect(n1).toMatch(/Use the other face/);
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
