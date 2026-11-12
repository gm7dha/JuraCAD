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
import { addArc, addCircle, addLine, addPoint } from "../src/sketch/ops";
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

describe("end conditions, more", () => {
  it("stays inside the end shapes, keeps a tip off-centre and refuses a holed face", () => {
    const base = sketchFeature(TOP, rectSketch(-10, -10, 20, 20));
    const top = sketchFeature(at(30), addCircle(emptySketch(), { x: 0, y: 0 }, 6).sketch);
    const ctx = sketchContext([base, top]);
    const plain = buildLoft({ sections: [base.id, top.id], loft: { matchCorners: false, periodic: false } }, ctx);
    const plainVolume = measureVolume(plain);
    plain.delete();
    for (const magnitude of [0.1, 1, 4]) {
      const s = buildLoft({ sections: [base.id, top.id], loft: { start: { kind: "normal", magnitude }, end: { kind: "normal", magnitude } } }, ctx);
      const [lo, hi] = s.boundingBox.bounds;
      // No lip past the square at any magnitude.
      expect(hi[0]).toBeLessThan(10.02);
      expect(lo[1]).toBeGreaterThan(-10.02);
      s.delete();
    }
    // The usual magnitude is about as full as a plain loft.
    const usual = buildLoft({ sections: [base.id, top.id], loft: { start: { kind: "normal" } } }, ctx);
    expect(measureVolume(usual) / plainVolume).toBeLessThan(1.15);
    usual.delete();
    // A rounded tip to a point off to one side never passes the point.
    const tip = buildLoft({ sections: [base.id], loft: { profiles: [{ sketch: base.id }, { point: { p: [15, 0, 10] } }], end: { kind: "tangent" } } }, ctx);
    expect(tip.boundingBox.bounds[1][0]).toBeLessThan(15.01);
    tip.delete();
    // A face with a hole in it.
    const holed = sketchFeature(TOP, addCircle(rectSketch(-10, -10, 20, 20), { x: 0, y: 0 }, 4).sketch);
    const plate: Feature = { ...feature("extrude", { depth: 10 }), sketchRef: holed.id, extrude: { end: "blind", flip: false } };
    const first = build([holed, plate]);
    const face = first.parts[0].faceRefs.find((f) => f.kind === "face" && f.surface === "PLANE" && Math.abs(f.normal[2] - 1) < 1e-9)!;
    const cap = sketchFeature(at(30), rectSketch(-5, -5, 10, 10));
    const lo = loftOf([cap.id], { profiles: [{ face: { partId: first.parts[0].id, ref: face } }, { sketch: cap.id }] });
    expect(build([holed, plate, cap, lo]).featureErrors[lo.id]).toMatch(/has a hole in it/);
  });

  it("carries on into a part (a pocket) and from a sloping top", () => {
    const box = feature("box", { width: 20, depth: 20, height: 10, x: -10, y: -10, z: 0 });
    const top = build([box]).parts[0].faceRefs.find((f) => f.kind === "face" && f.surface === "PLANE" && Math.abs(f.normal[2] - 1) < 1e-9)!;
    const low = sketchFeature(at(2), rectSketch(-4, -4, 8, 8));
    // Into the part from its own face, a shaped end would run along the part's sides: refused plainly, New or Remove.
    for (const kind of ["normal", "matchTangent", "matchCurvature"] as const) {
      for (const operation of ["new", "remove"] as const) {
        const f: Feature = { ...feature("loft", {}, operation), sections: [low.id], loft: { profiles: [{ face: { partId: box.id, ref: top } }, { sketch: low.id }], start: { kind } } };
        expect(build([box, low, f]).featureErrors[f.id]).toMatch(/goes from the picked face into its part/);
      }
    }
    // Left free, the pocket is cut.
    const free: Feature = { ...feature("loft", {}, "remove"), sections: [low.id], loft: { profiles: [{ face: { partId: box.id, ref: top } }, { sketch: low.id }] } };
    const rc = build([box, low, free]);
    expect(rc.featureErrors).toEqual({});
    expect(analyzeMesh(rc.parts[0].vertices, rc.parts[0].triangles).volume).toBeLessThan(4000 - 8 * 8 * 8);
    // A frustum's top (its sides slope in), carried on very smoothly as far as it goes: still a sound solid.
    const b20 = sketchFeature(TOP, rectSketch(-10, -10, 20, 20));
    const t10 = sketchFeature(at(10), rectSketch(-5, -5, 10, 10));
    const frustum: Feature = { ...feature("loft", {}), sections: [b20.id, t10.id], loftRuled: true };
    const ft = build([b20, t10, frustum]).parts[0].faceRefs.find((f) => f.kind === "face" && f.surface === "PLANE" && Math.abs(f.normal[2] - 1) < 1e-9)!;
    const hi = sketchFeature(at(30), rectSketch(-2, -2, 4, 4));
    const on: Feature = { ...feature("loft", {}, "add"), sections: [hi.id], loft: { profiles: [{ face: { partId: frustum.id, ref: ft } }, { sketch: hi.id }], start: { kind: "matchCurvature", magnitude: 4 } } };
    const rf = build([b20, t10, frustum, hi, on]);
    expect(rf.featureErrors).toEqual({});
    expect(analyzeMesh(rf.parts[0].vertices, rf.parts[0].triangles).watertight).toBe(true);
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
    expect(a.bounds!.max[0]).toBeLessThan(15.1);
    // Only the side by the guide moves: the far side and the sides across stay at ±10.
    expect(a.bounds!.min[0]).toBeCloseTo(-10, 2);
    expect(a.bounds!.max[1]).toBeCloseTo(10, 2);
    expect(a.volume).toBeGreaterThan(20 * 20 * 30 * 1.1);
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

  it("follows a quarter-circle and an L-shaped path to the end shape", () => {
    const base = sketchFeature(TOP, addCircle(emptySketch(), { x: 0, y: 0 }, 3).sketch);
    // The end plane faces +X through (20, 0, 20); its across direction is Y and up is Z, so the circle is drawn at (0, 20).
    const endPlane = planeOnFace([1, 0, 0], [20, 0, 20], "end");
    const c = Math.cos(Math.PI / 4);
    const arc = sketchFeature({ kind: "default", name: "Front" }, addArc(emptySketch(), { x: 0, y: 0 }, { x: 20, y: 20 }, { x: 20 - 20 * c, y: 20 * c }).sketch);
    const up = addLine(emptySketch(), { x: 0, y: 0 }, { x: 0, y: 20 });
    const ell = sketchFeature({ kind: "default", name: "Front" }, addLine(up.sketch, { x: 0, y: 20, snap: { kind: "point", id: up.endId } } as never, { x: 20, y: 20 }).sketch);
    for (const r of [3, 2]) {
      const top = sketchFeature(endPlane, addCircle(emptySketch(), { x: 0, y: 20 }, r).sketch);
      for (const [path, length] of [[arc, Math.PI * 10], [ell, 40]] as const) {
        const lo = loftOf([base.id, top.id], { path: { sketch: path.id } });
        const built = build([base, top, path, lo]);
        expect(built.featureErrors).toEqual({});
        const a = analyzeMesh(built.parts[0].vertices, built.parts[0].triangles);
        expect(a.watertight).toBe(true);
        // r 3 → r tapering along the path's length; it reaches the end shape and never dips below the start.
        expect(relativeError(measureVolume(shapeOf(built.parts[0].id)!), (Math.PI * length * (9 + 3 * r + r * r)) / 3)).toBeLessThan(0.01);
        expect(a.bounds!.max[0]).toBeCloseTo(20, 2);
        expect(a.bounds!.min[2]).toBeGreaterThan(-1e-3);
      }
    }
    // A shape away from the path is refused plainly (the end circle drawn at the plane's own origin, 20 below the path's end).
    const away = sketchFeature(endPlane, addCircle(emptySketch(), { x: 0, y: 0 }, 3).sketch);
    expect(build([base, away, arc, loftOf([base.id, away.id], { path: { sketch: arc.id } })]).featureErrors).toMatchObject({});
    const bad = loftOf([base.id, away.id], { path: { sketch: arc.id } });
    expect(build([base, away, arc, bad]).featureErrors[bad.id]).toMatch(/doesn't sit on the path/);
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
