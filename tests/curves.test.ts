/**
 * Curve features, the pure parts: a bridging curve's control points (direction and bend matched at its ends), a
 * helix's sizes, a fit spline's checks, reading curves from files, Delete with dependents and the eye.
 */
import { describe, expect, it } from "vitest";
import { bezierEndDerivatives, bezierPoint, bridgePoints, curvatureVector, curveName, curveParamKeys, curveUses, fitSplineProblem, helixLength, helixSizes, newCurveDef, parseCurveDef } from "../src/model/curves";
import { findDependents, withoutGone } from "../src/model/dependents";
import { parseDocument, emptyDocument } from "../src/model/document";
import { hasEye, featureVisible } from "../src/model/visibility";
import { visibleParamKeys } from "../src/model/features";
import { parsePick } from "../src/geometry/topoRef";
import { parsePlane } from "../src/sketch/validate";
import { parseGeomPick } from "../src/model/document";
import type { Feature } from "../src/model/types";
import { emptySketch } from "../src/sketch/types";

type Vec3 = [number, number, number];
const len = (a: Vec3) => Math.hypot(...a);
const unit = (a: Vec3): Vec3 => a.map((x) => x / len(a)) as Vec3;
const close = (a: Vec3, b: Vec3, tol = 1e-9) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < tol;

describe("bridging curve", () => {
  const a = { p: [0, 0, 0] as Vec3, t: [1, 0, 0] as Vec3, match: "tangent" as const };
  const b = { p: [10, 10, 0] as Vec3, t: [0, 1, 0] as Vec3, match: "tangent" as const };

  it("matches the directions at both ends (a cubic)", () => {
    const pts = bridgePoints(a, b) as Vec3[];
    expect(pts).toHaveLength(4);
    expect(close(bezierPoint(pts, 0), a.p)).toBe(true);
    expect(close(bezierPoint(pts, 1), b.p)).toBe(true);
    expect(close(unit(bezierEndDerivatives(pts, 0).d1), [1, 0, 0])).toBe(true);
    expect(close(unit(bezierEndDerivatives(pts, 1).d1), [0, 1, 0])).toBe(true);
  });

  it("matches the bend too (a quintic), and a bigger bulge swings out further", () => {
    const k0: Vec3 = [0, 0.2, 0];
    const k1: Vec3 = [-0.05, 0, 0];
    const pts = bridgePoints({ ...a, k: k0, match: "curvature" }, { ...b, k: k1, match: "curvature" }) as Vec3[];
    expect(pts).toHaveLength(6);
    const s = bezierEndDerivatives(pts, 0);
    const e = bezierEndDerivatives(pts, 1);
    expect(close(unit(s.d1), [1, 0, 0])).toBe(true);
    expect(close(unit(e.d1), [0, 1, 0])).toBe(true);
    expect(close(curvatureVector(s.d1, s.d2), k0, 1e-9)).toBe(true);
    expect(close(curvatureVector(e.d1, e.d2), k1, 1e-9)).toBe(true);
    // Only the bend square to the direction counts (a part along it is ignored).
    const skew = bridgePoints({ ...a, k: [0.3, 0.2, 0], match: "curvature" }, { ...b, match: "tangent" }) as Vec3[];
    const sk = bezierEndDerivatives(skew, 0);
    expect(close(curvatureVector(sk.d1, sk.d2), k0, 1e-9)).toBe(true);
    // Bulge: the middle of the curve moves further from the straight line between the ends.
    const mid = (q: Vec3[]) => bezierPoint(q, 0.5);
    const plain = mid(bridgePoints(a, b, 1) as Vec3[]);
    const big = mid(bridgePoints(a, b, 2) as Vec3[]);
    const off = (p: Vec3) => Math.abs(p[0] - p[1]) / Math.SQRT2;
    expect(off(big)).toBeGreaterThan(off(plain));
  });

  it("is a straight line between two plain points, and refuses one point twice", () => {
    expect(bridgePoints({ p: [0, 0, 0], match: "tangent" }, { p: [3, 4, 0], match: "tangent" })).toEqual([
      [0, 0, 0],
      [3, 4, 0],
    ]);
    expect(bridgePoints({ p: [1, 1, 1], match: "position" }, { p: [1, 1, 1], match: "position" })).toMatch(/same place/);
  });
});

describe("helix sizes", () => {
  it("works out the third from the two given", () => {
    expect(helixSizes("heightTurns", { height: 30, turns: 5 })).toEqual({ height: 30, turns: 5, pitch: 6 });
    expect(helixSizes("heightPitch", { height: 30, pitch: 4 })).toEqual({ height: 30, turns: 7.5, pitch: 4 });
    expect(helixSizes("turnsPitch", { turns: 3, pitch: 2 })).toEqual({ height: 6, turns: 3, pitch: 2 });
    // Round a face: the face's height.
    expect(helixSizes(undefined, { height: 99, turns: 2 }, 10)).toEqual({ height: 10, turns: 2, pitch: 5 });
    expect(helixSizes("heightTurns", { height: 0, turns: 2 })).toMatch(/more than 0/);
    expect(helixSizes("heightPitch", { height: 1000, pitch: 1 })).toMatch(/500 turns/);
    expect(helixLength(10, 1, 0)).toBeCloseTo(20 * Math.PI, 9);
  });

  it("shows only the boxes its settings use", () => {
    expect(curveParamKeys({ kind: "helix", around: "axis" })).toEqual(["height", "turns", "diameter", "startAngle", "taper"]);
    expect(curveParamKeys({ kind: "helix", around: "axis", start: { p: [1, 0, 0] }, helixBy: "turnsPitch" })).toEqual(["turns", "pitch", "startAngle", "taper"]);
    expect(curveParamKeys({ kind: "helix", around: "face", helixBy: "heightPitch" })).toEqual(["pitch", "startAngle"]);
    expect(curveParamKeys({ kind: "bridge" })).toEqual(["bulge"]);
    const f: Feature = { id: "c", name: "Helix 1", type: "curve", operation: "new", suppressed: false, params: {}, curve: { kind: "fitSpline" } };
    expect([...visibleParamKeys(f)]).toEqual([]);
  });
});

describe("fit spline", () => {
  it("needs points that differ", () => {
    expect(fitSplineProblem([[0, 0, 0]], false)).toMatch(/at least two/);
    expect(fitSplineProblem([[0, 0, 0], [1, 0, 0]], true)).toMatch(/three/);
    expect(fitSplineProblem([[0, 0, 0], [0, 0, 0]], false)).toMatch(/same place/);
    expect(fitSplineProblem([[0, 0, 0], [1, 0, 0], [0, 0, 0]], true)).toMatch(/Closed/);
    expect(fitSplineProblem([[0, 0, 0], [1, 0, 0], [1, 1, 0]], true)).toBeNull();
  });
});

describe("curves in files, the list and Delete with dependents", () => {
  const read = { geom: parseGeomPick, pick: parsePick, plane: parsePlane };
  it("reads a curve's settings back, dropping odd values", () => {
    const def = { kind: "bridge", from: { p: [1, 2, 3], curve: "h1", end: "b" }, to: { p: [0, 0, 0] }, matchFrom: "curvature", matchTo: "wobbly", flipTo: true, picking: "to" };
    expect(parseCurveDef(def, read)).toEqual({ kind: "bridge", from: { p: [1, 2, 3], curve: "h1", end: "b" }, to: { p: [0, 0, 0] }, matchFrom: "curvature", flipTo: true });
    expect(parseCurveDef({ kind: "spiral" }, read)).toBeNull();
    expect(newCurveDef("helix").axis?.axis).toBe("z");
  });

  it("saves and opens a design with curves; older designs open as before", () => {
    const doc = emptyDocument();
    const helix: Feature = { id: "h1", name: "Helix 1", type: "curve", operation: "new", suppressed: false, visible: false, params: { turns: "3" }, curve: { kind: "helix", around: "axis", axis: { p: [0, 0, 0], axis: "z" }, clockwise: true } };
    const sweep: Feature = { id: "sw", name: "Sweep 1", type: "sweep", operation: "new", suppressed: false, params: {}, sketchRef: "s1", pathRef: "h1", pathEdges: [{ partId: "b", ref: { kind: "edge", curve: "LINE", a: [0, 0, 0], b: [1, 0, 0], mid: [0.5, 0, 0] } as never }] };
    const back = parseDocument(JSON.parse(JSON.stringify({ ...doc, features: [helix, sweep] })))!;
    expect(back.features[0].curve).toEqual(helix.curve);
    expect(back.features[0].visible).toBe(false);
    expect(back.features[1].pathRef).toBe("h1");
    expect(back.features[1].pathEdges).toHaveLength(1);
    const old = parseDocument(JSON.parse(JSON.stringify({ ...doc, features: [{ ...sweep, pathEdges: undefined, pathRef: "s0" }] })))!;
    expect("pathEdges" in old.features[0]).toBe(false);
  });

  it("has an eye, shown unless hidden", () => {
    const c: Feature = { id: "c", name: "Helix 1", type: "curve", operation: "new", suppressed: false, params: {}, curve: { kind: "helix" } };
    expect(hasEye(c)).toBe(true);
    expect(featureVisible(c, [c])).toBe(true);
    expect(featureVisible({ ...c, visible: false }, [c])).toBe(false);
  });

  it("goes with what it's made from, and takes its sweeps with it", () => {
    const sk = (id: string): Feature => ({ id, name: id, type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane: { kind: "default", name: "Top" }, data: emptySketch() } });
    const box: Feature = { id: "box", name: "Box", type: "box", operation: "new", suppressed: false, params: {} };
    const proj: Feature = { id: "p1", name: "Projected curve 1", type: "curve", operation: "new", suppressed: false, params: {}, sketchRef: "s1", picks: [{ partId: "box", ref: { kind: "face" } as never }], curve: { kind: "projected" } };
    const fit: Feature = { id: "f1", name: "Fit spline 1", type: "curve", operation: "new", suppressed: false, params: {}, curve: { kind: "fitSpline", points: [{ p: [0, 0, 0], curve: "p1", end: "a" }, { p: [1, 0, 0], sketchPoint: { sketch: "s2", point: "q" } }] } };
    const comp: Feature = { id: "c1", name: "Composite curve 1", type: "curve", operation: "new", suppressed: false, params: {}, curve: { kind: "composite", curves: ["p1", "h9"] } };
    const sweep: Feature = { id: "sw", name: "Sweep 1", type: "sweep", operation: "new", suppressed: false, params: {}, sketchRef: "s2", pathRef: "f1" };
    const edgeSweep: Feature = { id: "sw2", name: "Sweep 2", type: "sweep", operation: "new", suppressed: false, params: {}, sketchRef: "s2", pathEdges: [{ partId: "box", ref: { kind: "edge" } as never }] };
    const list = [sk("s1"), sk("s2"), box, proj, fit, comp, sweep, edgeSweep];
    const d = findDependents(list, ["s1"]);
    expect(d.dependents).toEqual(["p1", "f1", "sw"]);
    expect(d.partial.map((x) => x.id)).toEqual(["c1"]);
    expect(withoutGone(comp, new Set(["p1"])).curve?.curves).toEqual(["h9"]);
    const byBox = findDependents(list, ["box"]).dependents;
    expect(byBox.includes("p1") && byBox.includes("sw2")).toBe(true);
    expect(curveUses({ curve: { kind: "helix", around: "face", on: { partId: "box", ref: { kind: "face" } as never } } }).parts).toEqual(["box"]);
    expect(curveName([{ name: "Helix 1" }], "helix")).toBe("Helix 2");
  });
});
