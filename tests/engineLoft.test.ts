/**
 * Loft with Onshape's further choices, on the real OpenCascade engine: points,
 * faces, end conditions, a guide curve, a path, lining up corners and a ring.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getOC, measureVolume, type Face, type Shape3D } from "replicad";
import { analyzeMesh } from "../src/geometry/meshCheck";
import { GeometryEngine } from "../src/kernel/engine";
import { buildLoft, type LoftContext } from "../src/kernel/loft";
import type { Feature, LoftDef } from "../src/model/types";
import { addArc, addCircle, addPoint } from "../src/sketch/ops";
import { planeFrame, planeOnFace, type SketchPlane } from "../src/sketch/planes";
import { emptySketch, type SketchData } from "../src/sketch/types";
import { feature, loadOpenCascade, rectSketch, relativeError, sketchFeature } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

/** A built part's exact shape (the engine keeps them to itself). */
const shapeOf = (id: string): Shape3D | undefined => (engine as unknown as { parts: { id: string; shape: Shape3D }[] }).parts.find((p) => p.id === id)?.shape;

function build(features: Feature[]) {
  engine = new GeometryEngine();
  return engine.rebuild(features);
}

const TOP: SketchPlane = { kind: "default", name: "Top" };
const at = (z: number): SketchPlane => planeOnFace([0, 0, 1], [0, 0, z], `${z} up`);
const loftOf = (sections: string[], loft: LoftDef, extra: Partial<Feature> = {}): Feature => ({ ...feature("loft", {}), sections, loft, ...extra });

/** A context for calling buildLoft straight from sketches (no parts). */
function sketchContext(sketches: Feature[]): LoftContext {
  return {
    sketch: (id) => {
      const f = sketches.find((s) => s.id === id);
      return f?.sketch?.plane ? { plane: f.sketch.plane, data: f.sketch.data, name: f.name } : null;
    },
    part: () => null,
    face: () => {
      throw new Error("no faces");
    },
    edges: () => [],
    name: (id) => sketches.find((s) => s.id === id)?.name,
  };
}

/** The steepest a loft's side gets right at height z (|normal z|, 0 = upright), probed on its exact faces. */
function steepnessAt(shape: Shape3D, z: number): number {
  const oc = getOC();
  let worst = 0;
  let probes = 0;
  for (const f of shape.faces as Face[]) {
    if (f.geomType === "PLANE") continue;
    const ad = new oc.BRepAdaptor_Surface(f.wrapped, false);
    const [u0, u1, v0, v1] = [ad.FirstUParameter(), ad.LastUParameter(), ad.FirstVParameter(), ad.LastVParameter()];
    for (const v of [v0, v1])
      for (const k of [0.2, 0.5, 0.8]) {
        const p = ad.Value(u0 + (u1 - u0) * k, v);
        if (Math.abs(p.Z() - z) > 1e-3) continue;
        const n = f.normalAt([p.X(), p.Y(), p.Z()]).toTuple();
        worst = Math.max(worst, Math.abs(n[2]) / Math.hypot(...n));
        probes++;
      }
    ad.delete();
  }
  expect(probes).toBeGreaterThan(0);
  return worst;
}

describe("loft to a point", () => {
  it("makes an exact pyramid and cone", () => {
    const base = sketchFeature(TOP, rectSketch(-10, -10, 20, 20));
    const lo = loftOf([base.id], { profiles: [{ sketch: base.id }, { point: { p: [0, 0, 30] } }] });
    const r = build([base, lo]);
    expect(r.featureErrors).toEqual({});
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(a.watertight).toBe(true);
    expect(relativeError(a.volume, (400 * 30) / 3)).toBeLessThan(0.003);
    expect(relativeError(measureVolume(shapeOf(r.parts[0].id)!), 4000)).toBeLessThan(1e-6);
    // A cone to a sketch point (which follows the sketch), the tip first.
    const disc = sketchFeature(TOP, addCircle(emptySketch(), { x: 0, y: 0 }, 10).sketch);
    const placed = addPoint(emptySketch(), { x: 0, y: 0 });
    const tipSketch = sketchFeature(at(24), placed.sketch);
    const cone = loftOf([disc.id], { profiles: [{ point: { p: [0, 0, 24], sketchPoint: { sketch: tipSketch.id, point: placed.pointId } } }, { sketch: disc.id }] });
    const rc = build([disc, tipSketch, cone]);
    expect(rc.featureErrors).toEqual({});
    expect(relativeError(measureVolume(shapeOf(rc.parts[0].id)!), (Math.PI * 100 * 24) / 3)).toBeLessThan(1e-6);
    // A point in the middle is refused.
    const top = sketchFeature(at(30), rectSketch(-5, -5, 10, 10));
    const bad = loftOf([base.id, top.id], { profiles: [{ sketch: base.id }, { point: { p: [0, 0, 15] } }, { sketch: top.id }] });
    expect(build([base, top, bad]).featureErrors[bad.id]).toMatch(/first or the last/);
  });

  it("rounds the tip into a dome", () => {
    const disc = sketchFeature(TOP, addCircle(emptySketch(), { x: 0, y: 0 }, 10).sketch);
    const shape = buildLoft({ sections: [disc.id], loft: { profiles: [{ sketch: disc.id }, { point: { p: [0, 0, 10] } }], end: { kind: "tangent" } } }, sketchContext([disc]));
    // A half ball of radius 10.
    expect(relativeError(measureVolume(shape), (2 / 3) * Math.PI * 1000)).toBeLessThan(0.02);
    shape.delete();
  });
});

describe("end conditions", () => {
  it("leaves a sketch square to it", () => {
    const base = sketchFeature(TOP, rectSketch(-10, -10, 20, 20));
    const top = sketchFeature(at(30), rectSketch(0, -5, 10, 10));
    const ctx = sketchContext([base, top]);
    const free = buildLoft({ sections: [base.id, top.id], loft: { profiles: [{ sketch: base.id, areas: [[0, 0]] }, { sketch: top.id }] } }, ctx);
    const square = buildLoft({ sections: [base.id, top.id], loft: { start: { kind: "normal" } } }, ctx);
    // Without: the sides lean in at the bottom. With: upright there (within a tenth of a degree).
    expect(steepnessAt(free, 0)).toBeGreaterThan(0.1);
    expect(steepnessAt(square, 0)).toBeLessThan(0.002);
    // A bigger magnitude carries the base's shape further up, so more is kept.
    const far = buildLoft({ sections: [base.id, top.id], loft: { start: { kind: "normal", magnitude: 3 } } }, ctx);
    expect(measureVolume(far)).toBeGreaterThan(measureVolume(square));
    [free, square, far].forEach((s) => s.delete());
    // A rounded tip on a shape is refused in plain words.
    expect(() => buildLoft({ sections: [base.id, top.id], loft: { start: { kind: "tangent" } } }, ctx)).toThrow(/rounded tip is for a point/);
  });

  it("carries on smoothly from the faces round a picked face", () => {
    const box = feature("box", { width: 20, depth: 20, height: 10, x: -10, y: -10, z: 0 });
    const first = build([box]);
    const topFace = first.parts[0].faceRefs.find((f) => f.kind === "face" && f.surface === "PLANE" && Math.abs(f.normal[2] - 1) < 1e-9)!;
    expect(topFace).toBeTruthy();
    const cap = sketchFeature(at(40), rectSketch(-4, -4, 8, 8));
    const pick = { partId: box.id, ref: topFace };
    const lo = loftOf([cap.id], { profiles: [{ face: pick }, { sketch: cap.id }], start: { kind: "matchTangent" } }, { operation: "add" });
    const boxShape = shapeOf(box.id)!;
    const r = build([box, cap, lo]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    const shape = shapeOf(r.parts[0].id)!;
    // The loft's sides stand upright where they meet the box's upright sides.
    const loftOnly = buildLoft(lo, {
      ...sketchContext([cap]),
      part: (id) => (id === box.id ? boxShape : null),
      face: (s, p) => s.faces.find((f) => f.geomType === "PLANE" && Math.abs(f.center.z - 10) < 1e-6 && f.normalAt().normalized().z > 0.999999 && !!p)!,
    });
    expect(steepnessAt(loftOnly, 10)).toBeLessThan(0.002);
    expect(measureVolume(shape)).toBeGreaterThan(20 * 20 * 10);
    loftOnly.delete();
    // The face's part deleted: the loft says so.
    expect(build([cap, { ...lo, operation: "new" }]).featureErrors[lo.id]).toMatch(/no longer exists/);
  });
});

describe("guide curves and paths", () => {
  it("bulges out to a guide curve", () => {
    const base = sketchFeature(TOP, rectSketch(-10, -10, 20, 20));
    const top = sketchFeature(at(30), rectSketch(-10, -10, 20, 20));
    // On Front (X across, Z up): an arc from the bottom square's side out to x = 15 halfway up, and back.
    const arc = addArc(emptySketch(), { x: 10, y: 0 }, { x: 10, y: 30 }, { x: 15, y: 15 });
    const guide = sketchFeature({ kind: "default", name: "Front" }, arc.sketch);
    const lo = loftOf([base.id, top.id], { guide: { sketch: guide.id } });
    const r = build([base, top, guide, lo]);
    expect(r.featureErrors).toEqual({});
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(a.watertight).toBe(true);
    // Pulled out to the guide in the middle, still 20 wide at the ends.
    expect(a.bounds!.max[0]).toBeGreaterThan(14.5);
    expect(a.bounds!.max[0]).toBeLessThan(17);
    expect(a.volume).toBeGreaterThan(20 * 20 * 30 * 1.2);
    // A guide that misses a shape is refused.
    const far = sketchFeature({ kind: "default", name: "Front" }, addArc(emptySketch(), { x: 30, y: 0 }, { x: 30, y: 30 }, { x: 35, y: 15 }).sketch);
    expect(build([base, top, far, { ...lo, loft: { guide: { sketch: far.id } } }]).featureErrors[lo.id]).toMatch(/must touch/);
  });

  it("follows a path", () => {
    const base = sketchFeature(TOP, addCircle(emptySketch(), { x: 0, y: 0 }, 6).sketch);
    const top = sketchFeature(at(30), addCircle(emptySketch(), { x: 0, y: 0 }, 3).sketch);
    const path = sketchFeature({ kind: "default", name: "Front" }, addArc(emptySketch(), { x: 0, y: 0 }, { x: 0, y: 30 }, { x: 0.001, y: 15 }).sketch);
    const lo = loftOf([base.id, top.id], { path: { sketch: path.id } });
    const r = build([base, top, path, lo]);
    expect(r.featureErrors).toEqual({});
    // Almost straight: about a frustum, r 6 → 3 over 30.
    const want = (Math.PI * 30 * (36 + 9 + 18)) / 3;
    expect(relativeError(analyzeMesh(r.parts[0].vertices, r.parts[0].triangles).volume, want)).toBeLessThan(0.03);
  });
});

describe("corners and rings", () => {
  it("lines up corners as turned, and loops round", () => {
    const base = sketchFeature(TOP, rectSketch(-10, -10, 20, 20));
    const top = sketchFeature(at(30), rectSketch(-10, -10, 20, 20));
    const ctx = sketchContext([base, top]);
    const plain = buildLoft({ sections: [base.id, top.id], loft: { matchCorners: true } }, ctx);
    expect(relativeError(measureVolume(plain), 12000)).toBeLessThan(1e-6);
    const twisted = buildLoft({ sections: [base.id, top.id], loft: { matchCorners: true, profiles: [{ sketch: base.id }, { sketch: top.id, turn: 1 }] } }, ctx);
    // A quarter-turn twist pinches the middle in.
    expect(measureVolume(twisted)).toBeLessThan(11000);
    [plain, twisted].forEach((s) => s.delete());
    const circle = sketchFeature(at(30), addCircle(emptySketch(), { x: 0, y: 0 }, 8).sketch);
    expect(() => buildLoft({ sections: [base.id, circle.id], loft: { matchCorners: true } }, sketchContext([base, circle]))).toThrow(/same number of sides/);

    // Eight square sections stood round the Z axis, back to the first: a closed ring.
    const ring: Feature[] = [];
    for (let k = 0; k < 8; k++) {
      const t = (k * Math.PI * 2) / 8;
      const plane = planeOnFace([-Math.sin(t), Math.cos(t), 0], [23 * Math.cos(t), 23 * Math.sin(t), 0], `ring ${k}`);
      // The plane's own across direction: the square sits 20…26 out from the Z axis, 6 tall.
      const fr = planeFrame(plane);
      const out = (r: number) => r * (Math.cos(t) * fr.u[0] + Math.sin(t) * fr.u[1]) - (fr.origin[0] * fr.u[0] + fr.origin[1] * fr.u[1] + fr.origin[2] * fr.u[2]);
      const [a, b] = [out(20), out(26)].sort((x, y) => x - y);
      const up = (z: number) => z * fr.v[2] - (fr.origin[0] * fr.v[0] + fr.origin[1] * fr.v[1] + fr.origin[2] * fr.v[2]);
      const [c, d] = [up(-3), up(3)].sort((x, y) => x - y);
      ring.push(sketchFeature(plane, rectSketch(a, c, b - a, d - c) as SketchData));
    }
    const lo = loftOf(ring.map((f) => f.id), { periodic: true });
    const r = build([...ring, lo]);
    expect(r.featureErrors).toEqual({});
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(a.watertight).toBe(true);
    expect(relativeError(a.volume, 2 * Math.PI * 23 * 36)).toBeLessThan(0.02);
  });
});
