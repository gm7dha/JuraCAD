/**
 * Loft's newer choices on the real OpenCascade engine: several guide curves, guides between shapes that aren't
 * parallel, Connections (which corners join) and a sketch on a part's face carrying on from the faces round it.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeBox, measureVolume, type Shape3D } from "replicad";
import { analyzeMesh } from "../src/geometry/meshCheck";
import { GeometryEngine } from "../src/kernel/engine";
import type { Feature, LoftDef } from "../src/model/types";
import { addArc } from "../src/sketch/ops";
import { planeOnFace, type SketchPlane } from "../src/sketch/planes";
import { emptySketch } from "../src/sketch/types";
import { feature, loadOpenCascade, rectSketch, relativeError, sketchFeature } from "./support/engineHelpers";
import { polySketch } from "./support/frameSketch";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

const shapeOf = (id: string): Shape3D | undefined => (engine as unknown as { parts: { id: string; shape: Shape3D }[] }).parts.find((p) => p.id === id)?.shape;

function build(features: Feature[]) {
  engine?.dispose();
  engine = new GeometryEngine();
  return engine.rebuild(features);
}

const TOP: SketchPlane = { kind: "default", name: "Top" };
const FRONT: SketchPlane = { kind: "default", name: "Front" };
const RIGHT: SketchPlane = { kind: "default", name: "Right" };
const at = (z: number): SketchPlane => planeOnFace([0, 0, 1], [0, 0, z], `${z} up`);
const loftOf = (sections: string[], loft: LoftDef, extra: Partial<Feature> = {}): Feature => ({ ...feature("loft", {}), sections, loft, ...extra });
/** An arc in a default plane from (x, 0) up to (x, 30), through (x + bulge, 15). */
const guideArc = (plane: SketchPlane, x: number, bulge: number) => sketchFeature(plane, addArc(emptySketch(), { x, y: 0 }, { x, y: 30 }, { x: x + bulge, y: 15 }).sketch);

/** Is a point inside the solid (a tiny cube there takes some of it)? */
function inside(shape: Shape3D, p: [number, number, number]): boolean {
  const h = 0.05;
  const probe = makeBox([p[0] - h, p[1] - h, p[2] - h], [p[0] + h, p[1] + h, p[2] + h]);
  const common = shape.clone().intersect(probe);
  try {
    return measureVolume(common) > 1e-6;
  } finally {
    common.delete();
    probe.delete();
  }
}

describe("several guide curves", () => {
  it("pulls opposite sides out to two guides", () => {
    const base = sketchFeature(TOP, rectSketch(-10, -10, 20, 20));
    const top = sketchFeature(at(30), rectSketch(-10, -10, 20, 20));
    const g1 = guideArc(FRONT, 10, 5);
    const g2 = guideArc(FRONT, -10, -3);
    const lo = loftOf([base.id, top.id], { guide: { sketch: g1.id }, moreGuides: [{ sketch: g2.id }] });
    const r = build([base, top, g1, g2, lo]);
    expect(r.featureErrors).toEqual({});
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(a.watertight).toBe(true);
    // Out to x = 15 on one side and x = −13 on the other halfway up; the sides across stay at ±10.
    expect(a.bounds!.max[0]).toBeGreaterThan(14.6);
    expect(a.bounds!.max[0]).toBeLessThan(15.1);
    expect(a.bounds!.min[0]).toBeLessThan(-12.6);
    expect(a.bounds!.min[0]).toBeGreaterThan(-13.1);
    expect(a.bounds!.max[1]).toBeCloseTo(10, 2);
    expect(a.bounds!.min[1]).toBeCloseTo(-10, 2);
    const shape = shapeOf(lo.id)!;
    expect(inside(shape, [14.6, 0, 15])).toBe(true);
    expect(inside(shape, [15.4, 0, 15])).toBe(false);
    expect(inside(shape, [-12.6, 0, 15])).toBe(true);
    expect(inside(shape, [-13.4, 0, 15])).toBe(false);
    // One guide alone builds exactly as it always has (the older way).
    const one = build([base, top, g1, { ...lo, loft: { guide: { sketch: g1.id } } }]);
    const b = analyzeMesh(one.parts[0].vertices, one.parts[0].triangles);
    expect(b.bounds!.min[0]).toBeCloseTo(-10, 2);
    expect(a.volume).toBeGreaterThan(b.volume);
  });

  it("bends through three guides, and refuses guides that miss or cross", () => {
    const base = sketchFeature(TOP, rectSketch(-10, -10, 20, 20));
    const top = sketchFeature(at(30), rectSketch(-10, -10, 20, 20));
    const g1 = guideArc(FRONT, 10, 5);
    const g2 = guideArc(FRONT, -10, -3);
    // On Right (Y across, Z up): the +y side pulled out to 14.
    const g3 = guideArc(RIGHT, 10, 4);
    const lo = loftOf([base.id, top.id], { guide: { sketch: g1.id }, moreGuides: [{ sketch: g2.id }, { sketch: g3.id }] });
    const r = build([base, top, g1, g2, g3, lo]);
    expect(r.featureErrors).toEqual({});
    expect(analyzeMesh(r.parts[0].vertices, r.parts[0].triangles).watertight).toBe(true);
    const shape = shapeOf(lo.id)!;
    // Every guide's middle is on the outline there.
    for (const [p, q] of [
      [[14.6, 0, 15], [15.4, 0, 15]],
      [[-12.6, 0, 15], [-13.4, 0, 15]],
      [[0, 13.6, 15], [0, 14.4, 15]],
    ] as [[number, number, number], [number, number, number]][]) {
      expect(inside(shape, p)).toBe(true);
      expect(inside(shape, q)).toBe(false);
    }
    // A guide that misses a shape is refused, naming it.
    const far = guideArc(FRONT, 30, 5);
    expect(build([base, top, g1, far, { ...lo, loft: { guide: { sketch: g1.id }, moreGuides: [{ sketch: far.id }] } }]).featureErrors[lo.id]).toMatch(/guide curve 2 must touch/i);
    // Two guides that swap sides on the way up are refused.
    const cross1 = sketchFeature(FRONT, addArc(emptySketch(), { x: 10, y: 0 }, { x: -10, y: 30 }, { x: 0.5, y: 15 }).sketch);
    const cross2 = sketchFeature(FRONT, addArc(emptySketch(), { x: -10, y: 0 }, { x: 10, y: 30 }, { x: -0.5, y: 15 }).sketch);
    const crossed = build([base, top, cross1, cross2, { ...lo, loft: { guide: { sketch: cross1.id }, moreGuides: [{ sketch: cross2.id }] } }]);
    expect(crossed.featureErrors[lo.id]).toMatch(/cross|couldn't/i);
  });

  it("takes guides between shapes that aren't parallel", () => {
    const base = sketchFeature(TOP, rectSketch(-10, -10, 20, 20));
    // The top square tipped 30° about X, its middle 30 up: its x = ±10 sides' middles are still at (±10, 0, 30).
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    const tipped: SketchPlane = { kind: "face", origin: [0, 0, 30], u: [1, 0, 0], v: [0, c, s], label: "tipped" };
    const top = sketchFeature(tipped, rectSketch(-10, -10, 20, 20));
    const g1 = guideArc(FRONT, 10, 5);
    const g2 = guideArc(FRONT, -10, -3);
    const lo = loftOf([base.id, top.id], { guide: { sketch: g1.id }, moreGuides: [{ sketch: g2.id }] });
    const r = build([base, top, g1, g2, lo]);
    expect(r.featureErrors).toEqual({});
    expect(analyzeMesh(r.parts[0].vertices, r.parts[0].triangles).watertight).toBe(true);
    const shape = shapeOf(lo.id)!;
    expect(inside(shape, [14.4, 0, 15])).toBe(true);
    expect(inside(shape, [15.5, 0, 15])).toBe(false);
    expect(inside(shape, [-12.4, 0, 15])).toBe(true);
    expect(inside(shape, [-13.5, 0, 15])).toBe(false);
    // One guide between them goes the new way too (cuts turned from one shape's plane to the next).
    const one = build([base, top, g1, { ...lo, loft: { guide: { sketch: g1.id } } }]);
    expect(one.featureErrors).toEqual({});
    expect(inside(shapeOf(lo.id)!, [14.4, 0, 15])).toBe(true);
  });
});

describe("guides along a path", () => {
  it("bends the shapes to the guides while following the path", () => {
    const base = sketchFeature(TOP, rectSketch(-10, -10, 20, 20));
    const top = sketchFeature(at(30), rectSketch(-10, -10, 20, 20));
    const path = sketchFeature(FRONT, addArc(emptySketch(), { x: 0, y: 0 }, { x: 0, y: 30 }, { x: 0.001, y: 15 }).sketch);
    const g1 = guideArc(FRONT, 10, 5);
    const g2 = guideArc(FRONT, -10, -3);
    const lo = loftOf([base.id, top.id], { path: { sketch: path.id }, guide: { sketch: g1.id }, moreGuides: [{ sketch: g2.id }] });
    const r = build([base, top, path, g1, g2, lo]);
    expect(r.featureErrors).toEqual({});
    const shape = shapeOf(lo.id)!;
    expect(inside(shape, [14.4, 0, 15])).toBe(true);
    expect(inside(shape, [15.5, 0, 15])).toBe(false);
    expect(inside(shape, [-12.4, 0, 15])).toBe(true);
    expect(inside(shape, [0, 10.5, 15])).toBe(false);
  });
});

describe("connections", () => {
  it("joins the corners picked: straight up, or twisted a quarter turn", () => {
    const base = sketchFeature(TOP, rectSketch(-10, -10, 20, 20));
    const top = sketchFeature(at(30), rectSketch(-10, -10, 20, 20));
    const lo = (to: [number, number, number]) => loftOf([base.id, top.id], { connections: [{ points: [{ p: [10, 10, 0] }, { p: to }] }] });
    const straight = build([base, top, lo([10, 10, 30])]);
    expect(straight.featureErrors).toEqual({});
    expect(relativeError(measureVolume(shapeOf(straight.parts[0].id)!), 20 * 20 * 30)).toBeLessThan(1e-6);
    // Corner to the next corner round: a quarter-turn twist, which pinches in at the middle.
    const twisted = build([base, top, lo([-10, 10, 30])]);
    expect(twisted.featureErrors).toEqual({});
    const v = measureVolume(shapeOf(twisted.parts[0].id)!);
    expect(v).toBeLessThan(20 * 20 * 30 * 0.95);
    expect(v).toBeGreaterThan(20 * 20 * 30 * 0.5);
    // A connection with no point on a shape is refused, naming it.
    const missing = build([base, top, loftOf([base.id, top.id], { connections: [{ points: [{ p: [10, 10, 0] }, { p: [50, 50, 30] }] }] })]);
    expect(Object.values(missing.featureErrors)[0]).toMatch(/no point on/);
  });

  it("lofts a square into a hexagon, joined where asked", () => {
    const base = sketchFeature(TOP, rectSketch(-10, -10, 20, 20));
    const hex: [number, number][] = Array.from({ length: 6 }, (_, i) => [12 * Math.cos((i * Math.PI) / 3), 12 * Math.sin((i * Math.PI) / 3)]);
    const top = sketchFeature(at(30), polySketch(hex));
    const h = (i: number): [number, number, number] => [hex[i][0], hex[i][1], 30];
    // Square's corners at 45° and 225° to the hexagon's at 60° and 240°: barely turning.
    const near = build([base, top, loftOf([base.id, top.id], { connections: [{ points: [{ p: [10, 10, 0] }, { p: h(1) }] }, { points: [{ p: [-10, -10, 0] }, { p: h(4) }] }] })]);
    expect(near.featureErrors).toEqual({});
    const a = analyzeMesh(near.parts[0].vertices, near.parts[0].triangles);
    expect(a.watertight).toBe(true);
    const vNear = measureVolume(shapeOf(near.parts[0].id)!);
    // Between the square's and the hexagon's areas (400 and 374) times the height, about.
    expect(vNear).toBeGreaterThan(30 * 370 * 0.97);
    expect(vNear).toBeLessThan(30 * 400 * 1.01);
    // The same corner joined to the hexagon's corner at 180°: a big twist, so less inside.
    const far = build([base, top, loftOf([base.id, top.id], { connections: [{ points: [{ p: [10, 10, 0] }, { p: h(3) }] }] })]);
    expect(far.featureErrors).toEqual({});
    expect(measureVolume(shapeOf(far.parts[0].id)!)).toBeLessThan(vNear * 0.95);
    // Connections that go round the shapes in different orders are refused.
    const crossed = build([
      base,
      top,
      loftOf([base.id, top.id], {
        connections: [
          { points: [{ p: [10, 10, 0] }, { p: h(1) }] },
          { points: [{ p: [-10, 10, 0] }, { p: h(5) }] },
          { points: [{ p: [-10, -10, 0] }, { p: h(3) }] },
        ],
      }),
    ]);
    expect(Object.values(crossed.featureErrors)[0]).toMatch(/cross over/);
  });
});

describe("a sketch on a part's face", () => {
  it("carries on from the faces round the face it's drawn on, with no lip", () => {
    // A frustum: 20 square at the bottom, 10 square 10 up (its sides slope in).
    const b20 = sketchFeature(TOP, rectSketch(-10, -10, 20, 20));
    const t10 = sketchFeature(at(10), rectSketch(-5, -5, 10, 10));
    const frustum: Feature = { ...feature("loft", {}), sections: [b20.id, t10.id], loftRuled: true };
    const ft = build([b20, t10, frustum]).parts[0].faceRefs.find((f) => f.kind === "face" && f.surface === "PLANE" && Math.abs(f.normal[2] - 1) < 1e-9)!;
    const hi = sketchFeature(at(30), rectSketch(-2, -2, 4, 4));
    const byFace: Feature = { ...feature("loft", {}, "add"), sections: [hi.id], loft: { profiles: [{ face: { partId: frustum.id, ref: ft } }, { sketch: hi.id }], start: { kind: "matchTangent" } } };
    const rf = build([b20, t10, frustum, hi, byFace]);
    expect(rf.featureErrors).toEqual({});
    const vFace = measureVolume(shapeOf(frustum.id)!);
    // The same outline drawn in a sketch on that face.
    const onFace: SketchPlane = { kind: "face", origin: [0, 0, 10], u: [1, 0, 0], v: [0, 1, 0], label: "Top face", face: { partId: frustum.id, ref: ft } };
    const drawn = sketchFeature(onFace, rectSketch(-5, -5, 10, 10));
    const bySketch: Feature = { ...feature("loft", {}, "add"), sections: [drawn.id, hi.id], loft: { start: { kind: "matchTangent" } } };
    const rs = build([b20, t10, frustum, drawn, hi, bySketch]);
    expect(rs.featureErrors).toEqual({});
    const m = analyzeMesh(rs.parts[0].vertices, rs.parts[0].triangles);
    expect(m.watertight).toBe(true);
    // No lip: nothing wider than the frustum's own base, and the same as lofting from the face itself.
    expect(m.bounds!.max[0]).toBeLessThan(10 + 1e-3);
    expect(relativeError(measureVolume(shapeOf(frustum.id)!), vFace)).toBeLessThan(2e-3);
    // Without the face picked (a plane that just lies on it, as Claude's sketches do), the face under it is found.
    const plain = sketchFeature(at(10), rectSketch(-5, -5, 10, 10));
    const rp = build([b20, t10, frustum, plain, hi, { ...bySketch, sections: [plain.id, hi.id] }]);
    expect(rp.featureErrors).toEqual({});
    expect(relativeError(measureVolume(shapeOf(frustum.id)!), vFace)).toBeLessThan(2e-3);
    // A sketch on no face can't carry on from any.
    const air = sketchFeature(at(12), rectSketch(-5, -5, 10, 10));
    const ra = build([b20, t10, frustum, air, hi, { ...bySketch, sections: [air.id, hi.id] }]);
    expect(Object.values(ra.featureErrors)[0]).toMatch(/drawn on a flat face/);
  });
});
