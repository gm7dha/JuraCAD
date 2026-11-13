/**
 * Engine tests: Offset curve, Isocline and Trim curve, and sketches using curve features (Use, snapping to their
 * ends, Pierce), followed on rebuild. Runs the real OpenCascade engine.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import type { CurveDef, Feature } from "../src/model/types";
import { helixLength } from "../src/model/curves";
import { linkEdge, linkPoint } from "../src/sketch/links";
import { emptySketch } from "../src/sketch/types";
import { loadOpenCascade, feature, sketchFeature, relativeError } from "./support/engineHelpers";

type Vec3 = [number, number, number];
beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

const curve = (def: CurveDef, params: Record<string, number> = {}, extra: Partial<Feature> = {}): Feature => ({ ...feature("curve", params), curve: def, ...extra });
const pointsOf = (line: number[]): Vec3[] => {
  const out: Vec3[] = [];
  for (let i = 0; i + 2 < line.length; i += 3) out.push([line[i], line[i + 1], line[i + 2]]);
  return out;
};
const lengthOf = (lines: number[][]) =>
  lines.reduce((t, l) => {
    const p = pointsOf(l);
    let s = 0;
    for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1], p[i][2] - p[i - 1][2]);
    return t + s;
  }, 0);

describe("Offset curve", () => {
  it("moves a box's top face outline 5 mm in (an exact smaller rectangle)", () => {
    engine = new GeometryEngine();
    const box = feature("box", { width: 40, depth: 30, height: 10 });
    const top = engine.rebuild([box]).parts[0].faceRefs.find((f) => f.surface === "PLANE" && f.normal[2] > 0.99)!;
    const oc = curve({ kind: "offset" }, { distance: 5 }, { picks: [{ partId: box.id, ref: top }] });
    const r = engine.rebuild([box, oc]);
    expect(r.featureErrors).toEqual({});
    const lines = r.curves![oc.id];
    expect(lines).toHaveLength(1);
    // 30 × 20 rectangle at z = 10.
    expect(Math.abs(lengthOf(lines) - 100)).toBeLessThan(1e-3);
    for (const p of pointsOf(lines[0])) {
      expect(Math.abs(p[2] - 10)).toBeLessThan(1e-6);
      expect(p[0]).toBeGreaterThan(5 - 1e-6);
      expect(p[0]).toBeLessThan(35 + 1e-6);
      expect(p[1]).toBeGreaterThan(5 - 1e-6);
      expect(p[1]).toBeLessThan(25 + 1e-6);
    }
    // Other way: out of the face, 50 × 40 with rounded corners.
    const out = { ...oc, curve: { kind: "offset", flip: true } as CurveDef };
    const r2 = engine.rebuild([box, out]);
    expect(r2.featureErrors).toEqual({});
    expect(Math.abs(lengthOf(r2.curves![oc.id]) - (2 * (40 + 30) + 2 * Math.PI * 5))).toBeLessThan(0.05);
  });

  it("walks a round edge across a cylinder's side (a circle 5 lower)", () => {
    engine = new GeometryEngine();
    const cyl = feature("cylinder", { diameter: 20, height: 30 });
    const part = engine.rebuild([cyl]).parts[0];
    const side = part.faceRefs.find((f) => f.surface.startsWith("CYLIND"))!;
    const topEdge = part.edgeRefs.find((e) => e.curve === "CIRCLE" && e.a[2] > 29)!;
    const oc = curve({ kind: "offset" }, { distance: 5 }, { picks: [{ partId: cyl.id, ref: topEdge }, { partId: cyl.id, ref: side }] });
    const r = engine.rebuild([cyl, oc]);
    expect(r.featureErrors).toEqual({});
    const pts = pointsOf(r.curves![oc.id][0]);
    for (const p of pts) {
      expect(Math.abs(p[2] - 25)).toBeLessThan(1e-3);
      expect(Math.abs(Math.hypot(p[0], p[1]) - 10)).toBeLessThan(1e-3);
    }
  });
});

describe("Isocline", () => {
  it("on a ball at 45° is the circle of radius R/√2 at height R/√2", () => {
    engine = new GeometryEngine();
    const ball = feature("sphere", { diameter: 20 });
    const face = engine.rebuild([ball]).parts[0].faceRefs[0];
    const iso = curve({ kind: "isocline", axis: { p: [0, 0, 0], dir: [0, 0, 1], axis: "z" } }, { angle: 45 }, { picks: [{ partId: ball.id, ref: face }] });
    const r = engine.rebuild([ball, iso]);
    expect(r.featureErrors).toEqual({});
    const lines = r.curves![iso.id];
    expect(lines).toHaveLength(1);
    const R = 10 / Math.SQRT2;
    const pts = pointsOf(lines[0]);
    for (const p of pts) {
      expect(Math.abs(p[2] - R)).toBeLessThan(1e-3);
      expect(Math.abs(Math.hypot(p[0], p[1]) - R)).toBeLessThan(1e-3);
    }
    expect(relativeError(lengthOf(lines), 2 * Math.PI * R)).toBeLessThan(1e-3);
    // Sloping the other way: the lower circle.
    const r2 = engine.rebuild([ball, { ...iso, curve: { ...iso.curve!, flip: true } }]);
    expect(pointsOf(r2.curves![iso.id][0])[0][2]).toBeCloseTo(-R, 3);
  });
});

describe("Trim curve", () => {
  it("cuts a helix back to a plane: half the length", () => {
    engine = new GeometryEngine();
    const h = curve({ kind: "helix", around: "axis", axis: { p: [0, 0, 0], dir: [0, 0, 1], axis: "z" } }, { diameter: 20, height: 20, turns: 4 });
    const t = curve({ kind: "trim", curves: [h.id], plane: { kind: "face", origin: [0, 0, 10], u: [1, 0, 0], v: [0, 1, 0], label: "half way" } });
    const r = engine.rebuild([h, t]);
    expect(r.featureErrors).toEqual({});
    expect(relativeError(lengthOf(r.curves![t.id]), helixLength(10, 2, 5))).toBeLessThan(1e-3);
    const pts = pointsOf(r.curves![t.id][0]);
    expect(pts[0][2]).toBeCloseTo(0, 4);
    expect(pts[pts.length - 1][2]).toBeCloseTo(10, 3);
    // The other end kept.
    const r2 = engine.rebuild([h, { ...t, curve: { ...t.curve!, flip: true } }]);
    expect(r2.featureErrors).toEqual({});
    const q = pointsOf(r2.curves![t.id][0]);
    expect(q[0][2]).toBeCloseTo(10, 3);
    expect(q[q.length - 1][2]).toBeCloseTo(20, 4);
  });

  it("cuts a helix back to a box's top face, and says so when nothing meets", () => {
    engine = new GeometryEngine();
    const box = feature("box", { width: 40, depth: 40, height: 6, x: -20, y: -20 });
    const top = engine.rebuild([box]).parts[0].faceRefs.find((f) => f.surface === "PLANE" && f.normal[2] > 0.99)!;
    const h = curve({ kind: "helix", around: "axis", axis: { p: [0, 0, 0], dir: [0, 0, 1], axis: "z" } }, { diameter: 20, height: 20, turns: 4 });
    const t = curve({ kind: "trim", curves: [h.id] }, {}, { picks: [{ partId: box.id, ref: top }] });
    const r = engine.rebuild([box, h, t]);
    expect(r.featureErrors).toEqual({});
    expect(relativeError(lengthOf(r.curves![t.id]), helixLength(10, 1.2, 5))).toBeLessThan(1e-3);
    const far = curve({ kind: "trim", curves: [h.id], plane: { kind: "face", origin: [0, 0, 50], u: [1, 0, 0], v: [0, 1, 0], label: "high" } });
    expect(engine.rebuild([h, far]).featureErrors[far.id]).toMatch(/doesn't meet/);
  });
});

describe("Sketches using curve features", () => {
  it("offers a helix's ends, the helix to Use and where it pierces the sketch; follows it when it changes", () => {
    engine = new GeometryEngine();
    const h = curve({ kind: "helix", around: "axis", axis: { p: [0, 0, 0], dir: [0, 0, 1], axis: "z" } }, { diameter: 20, height: 20, turns: 2.25 });
    // On Front (x, z): the helix passes through y = 0 where it is at x = ±10.
    const sk = sketchFeature({ kind: "default", name: "Front" }, emptySketch());
    engine.rebuild([h, sk]);
    const refs = engine.sketchCandidates("main", sk.id)!;
    const mine = refs.filter((e) => e.source?.sketch === h.id);
    const curveRef = mine.find((e) => !e.pierce && e.kind !== "point")!;
    expect(curveRef).toBeTruthy();
    expect(curveRef.shape).toBeTruthy();
    const pierces = mine.filter((e) => e.pierce);
    expect(pierces.length).toBeGreaterThanOrEqual(4);
    // Use the helix (seen square-on), and bring its end in as a point.
    const used = linkEdge(sk.sketch!.data, curveRef, false);
    expect(used.error).toBeUndefined();
    const end = linkPoint(used.sketch, curveRef, "b");
    expect(end.error).toBeUndefined();
    const pierce = linkPoint(end.sketch, pierces[0], "a");
    expect(pierce.error).toBeUndefined();
    const sk2 = { ...sk, sketch: { ...sk.sketch!, data: pierce.sketch } };
    const r = engine.rebuild([h, sk2]);
    expect(r.featureErrors).toEqual({});
    const info = r.sketchLinks![sk.id];
    expect(Object.values(info.links).every((l) => l !== null)).toBe(true);
    expect(Object.values(info.pointLinks ?? {}).every((l) => l !== null)).toBe(true);
    // The helix taller: the end point follows (2.25 turns ends at x = 0, z = height).
    const taller = { ...h, params: { ...h.params, height: "30" } };
    const r2 = engine.rebuild([taller, sk2]);
    const at = r2.sketchLinks![sk.id].pointLinks![end.pointId]!;
    expect(at[1]).toBeCloseTo(30, 3);
    // The curve deleted: the links are lost (reported), not left behind.
    const r3 = engine.rebuild([sk2]);
    expect(Object.values(r3.sketchLinks![sk.id].links).every((l) => l === null)).toBe(true);
  });
});
